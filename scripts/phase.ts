/** Content-free durable attempt phase. Unknown version writes remain unknown across reruns. */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export interface Phase {
  format: "impact-agent-release-phase/v1";
  runId: string;
  runAttempt: number;
  workflowCommit: string;
  phase: "prewrite" | "version_write_started" | "version_write_confirmed";
}
export function reconcileOnly(
  attempt: number,
  previous: unknown,
  identity: { runId: string; workflowCommit: string },
) {
  if (attempt === 1) return false;
  const prior = previous as Phase | undefined;
  return !(
    prior?.format === "impact-agent-release-phase/v1" &&
    prior.phase === "prewrite" &&
    prior.runId === identity.runId &&
    prior.workflowCommit === identity.workflowCommit &&
    prior.runAttempt === attempt - 1
  );
}
export function phaseRecord(
  phase: Phase["phase"],
  env: Record<string, string | undefined> = process.env,
): Phase {
  const runId = env.GITHUB_RUN_ID ?? "local";
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT ?? "1");
  const workflowCommit = env.GITHUB_SHA ?? "local";
  return { format: "impact-agent-release-phase/v1", runId, runAttempt, workflowCommit, phase };
}
async function main() {
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt");
  if (process.argv[2] === "previous") {
    await appendFile(process.env.GITHUB_OUTPUT ?? "phase-output.txt", `previous=${attempt - 1}\n`);
    return;
  }
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile("previous-phase/phase.json", "utf8"));
  } catch {
    /* Missing state is uncertain. */
  }
  const only = reconcileOnly(attempt, previous, {
    runId: process.env.GITHUB_RUN_ID ?? "local",
    workflowCommit: process.env.GITHUB_SHA ?? "local",
  });
  await mkdir("out", { recursive: true });
  await writeFile(
    "out/phase.json",
    `${JSON.stringify(phaseRecord(only ? "version_write_started" : "prewrite"))}\n`,
    { mode: 0o600 },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("attempt_phase_unavailable\n");
    process.exitCode = 1;
  });
