/** Verify the exact reviewed Production pin and the origin of its artifact before Azure login. */
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export interface ProductionPin {
  format: "impact-agent-production/v1";
  action: "promote" | "rollback";
  sourceRunId: number;
  bundleDigest: string;
  sourceDigest: string;
  releaseId: string;
  agentName: string;
  agentVersion: string;
}
export function validatePin(input: unknown): ProductionPin {
  const pin = input as ProductionPin;
  if (
    pin?.format !== "impact-agent-production/v1" ||
    !["promote", "rollback"].includes(pin.action) ||
    !Number.isSafeInteger(pin.sourceRunId) ||
    pin.sourceRunId < 1 ||
    !/^[0-9a-f]{64}$/u.test(pin.bundleDigest) ||
    !/^[0-9a-f]{64}$/u.test(pin.sourceDigest) ||
    !/^rel_[0-9a-f]{24}$/u.test(pin.releaseId) ||
    !/^impact-[0-9a-f]{32}$/u.test(pin.agentName) ||
    !/^[0-9]+$/u.test(pin.agentVersion)
  )
    throw new Error("production_pin");
  return pin;
}
export function validateRun(pin: ProductionPin, input: unknown, repository: string) {
  const run = input as Record<string, unknown>;
  const development = pin.action === "promote";
  const expected = development ? "azure-development.yml" : "azure-production.yml";
  if (
    !run ||
    run.id !== pin.sourceRunId ||
    run.conclusion !== "success" ||
    run.status !== "completed" ||
    run.path !== `.github/workflows/${expected}` ||
    run.head_branch !== (development ? "development" : "production") ||
    run.event !== "push" ||
    (run.repository as { full_name?: string })?.full_name !== repository ||
    (run.head_repository as { full_name?: string })?.full_name !== repository
  )
    throw new Error("release_run_origin");
  return run;
}
export function validateReceipt(pin: ProductionPin, input: unknown, run: Record<string, unknown>) {
  const receipt = input as Record<string, unknown>;
  if (
    receipt?.format !== "impact-azure-release/v1" ||
    receipt.state !== "deployed" ||
    receipt.environment !== (pin.action === "promote" ? "development" : "production") ||
    typeof receipt.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceCommit)
  )
    throw new Error("release_receipt");
  for (const key of [
    "bundleDigest",
    "sourceDigest",
    "releaseId",
    "agentName",
    "agentVersion",
  ] as const)
    if (receipt[key] !== pin[key]) throw new Error("release_pin_mismatch");
  if (pin.action === "promote" && receipt.sourceCommit !== run.head_sha)
    throw new Error("release_commit_mismatch");
  return receipt;
}
async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("repository");
  const pin = validatePin(JSON.parse(await readFile("releases/production.json", "utf8")));
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs/${pin.sourceRunId}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
  );
  if (!response.ok) throw new Error("release_run_unavailable");
  const run = validateRun(pin, await response.json(), repository!);
  let outputs = `action=${pin.action === "promote" ? "deploy" : "rollback"}\nrun_id=${pin.sourceRunId}\nbundle_digest=${pin.bundleDigest}\nagent_version=${pin.agentVersion}\n`;
  if (process.env.CHECK_RECEIPT === "true") {
    const receipt = validateReceipt(
      pin,
      JSON.parse(await readFile("bundle/receipt.json", "utf8")),
      run,
    );
    outputs += `source_commit=${receipt.sourceCommit}\n`;
  }
  await appendFile(process.env.GITHUB_OUTPUT ?? "pin-output.txt", outputs);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("production_pin_or_artifact_verification_failed\n");
    process.exitCode = 1;
  });
