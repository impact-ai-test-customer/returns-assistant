/** Publish only content-free deployment evidence using the customer's workflow installation token. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Receipt, ReleasePlan } from "./release.js";

export function releaseConfirmation(input: unknown, plan: ReleasePlan) {
  const receipt = input as Receipt;
  const checks = receipt?.checks;
  if (
    receipt?.format !== "impact-azure-release/v1" ||
    receipt.state !== "deployed" ||
    receipt.environment !== plan.environment ||
    receipt.releaseId !== plan.releaseId ||
    receipt.sourceDigest !== plan.sourceDigest ||
    receipt.bundleDigest !== plan.bundleDigest ||
    receipt.projectId !== plan.selected.projectId ||
    receipt.agentName !== plan.agentName ||
    !/^[0-9]+$/u.test(receipt.agentVersion) ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceCommit) ||
    !plan.checks ||
    checks?.format !== "impact-agent-check-results/v1" ||
    checks.profile !== "isolated_i052_sample_replay" ||
    checks.state !== "passed" ||
    checks.nativeToolsVerified !== false ||
    checks.sourceDigest !== plan.sourceDigest ||
    checks.bundleDigest !== plan.bundleDigest ||
    checks.releaseId !== plan.releaseId ||
    checks.candidateVersion !== receipt.agentVersion ||
    checks.checksDigest !== plan.checks.digest ||
    !Array.isArray(checks.results) ||
    checks.results.length !== plan.checks.count ||
    checks.results.some(
      (result, i) => result.id !== plan.checks!.ids[i] || result.state !== "passed",
    )
  )
    throw new Error("release_confirmation_invalid");
  return {
    format: "impact-agent-release-confirmation/v1",
    releaseId: plan.releaseId,
    sourceDigest: plan.sourceDigest,
    bundleDigest: plan.bundleDigest,
    environment: plan.environment,
    projectId: plan.selected.projectId,
    agentName: plan.agentName,
    agentVersion: receipt.agentVersion,
    documentsDigest: plan.knowledge?.documentCount ? plan.knowledge.documentsDigest : null,
    documentCount: plan.knowledge?.documentCount ?? 0,
    checksDigest: plan.checks.digest,
  };
}

export async function publishConfirmation(
  input: unknown,
  plan: ReleasePlan,
  context: { repository: string; sha: string; runId: string; attempt: string; token: string },
  fetcher: typeof fetch = fetch,
) {
  const confirmation = releaseConfirmation(input, plan);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(context.repository) ||
    !/^[0-9a-f]{40}$/u.test(context.sha) ||
    !/^[1-9][0-9]*$/u.test(context.runId) ||
    !/^[1-9][0-9]*$/u.test(context.attempt) ||
    !context.token ||
    (plan.environment === "development" && (input as Receipt).sourceCommit !== context.sha)
  )
    throw new Error("release_confirmation_context");
  const response = await fetcher(`https://api.github.com/repos/${context.repository}/check-runs`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${context.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({
      name: "impact.ai / release confirmed",
      head_sha: context.sha,
      status: "completed",
      conclusion: "success",
      external_id: `impact-release:${context.runId}:${context.attempt}`,
      details_url: `https://github.com/${context.repository}/actions/runs/${context.runId}/attempts/${context.attempt}`,
      output: {
        title: "Exact Azure deployment confirmed; trace observation remains separate",
        summary: `\`\`\`json\n${JSON.stringify(confirmation)}\n\`\`\``,
      },
    }),
  });
  if (response.status !== 201) throw new Error("release_confirmation_unavailable");
  const result = (await response.json()) as { app?: { slug?: string }; head_sha?: string };
  if (result.app?.slug !== "github-actions" || result.head_sha !== context.sha)
    throw new Error("release_confirmation_identity");
}

async function main() {
  const { prepareRelease, readBundle } = await import("./release.ts");
  const receipt = JSON.parse(await readFile("out/receipt.json", "utf8")) as Receipt;
  const plan = prepareRelease(await readBundle("out"), receipt.environment, receipt.knowledge);
  await publishConfirmation(receipt, plan, {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    token: process.env.GH_TOKEN ?? "",
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    // Malformed receipts, provider responses and credentials must never reach public diagnostics.
    process.stderr.write("release_confirmation_failed\n");
    process.exitCode = 1;
  });
