/**
 * The Development check run, told to impact.ai as it happens (`impact-check-run/v1`). Three kinds of content-free OTLP/HTTP
 * span: what will run (sent and awaited before the first model call, so a run that dies later is still known to have
 * started), each check's result as it finishes, and how the run ended. Nothing here carries a prompt, an answer, a document
 * or a key; only ids, digests, counts and codes. The customer's gate never depends on it: a failed export is counted, the
 * release goes on, and no later span claims a plan existed that impact.ai did not receive.
 */
import { createHash } from "node:crypto";
import { type CheckResult, checksDigest, type SavedCheck } from "./checks.ts";
import { JUDGES_METHOD } from "./judges.ts";
import { type ObservationConfig, observationFromEnv } from "./observe.ts";
import type { ReleasePlan } from "./release.js";

export const CHECK_RUN_PROFILE = "azure_development_checks";
/** How the checks run, as the saved-check runner defines it; the judges' own version is appended. */
export const CHECK_RUN_METHOD = `isolated_i052_sample_replay/${JUDGES_METHOD}`;
/** The Development job's `timeout-minutes`: a run that has not ended by then was interrupted. */
export const CHECK_RUN_MINUTES = 15;
export type RunEvent = "planned" | "case" | "ended";
export type RunEndState = "passed" | "finding" | "incomplete" | "stopped";
/** What an export came to: `unknown` is a request that failed or timed out, `refused` an answer that was not a plain accept. */
export type ExportState = "accepted" | "refused" | "unknown" | "invalid_configuration";
export type ReportState =
  | ExportState
  | "not_applicable"
  | "not_configured"
  | "no_run_identity"
  | "model_unreadable";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const runIdPattern = /^[1-9][0-9]{0,19}$/u;
const attemptPattern = /^[1-9][0-9]{0,3}$/u;

/** The same trace and span for the same run, attempt, event and check: a duplicate delivery lands on the one it repeats. */
export function checkRunIds(runId: string, attempt: string, event: RunEvent, checkId = "") {
  const key = `${runId}:${attempt}:${event}:${checkId}`;
  return { traceId: sha(key).slice(0, 32), spanId: sha(`${key}:span`).slice(0, 16) };
}

/** What every span of one run says about it. */
export interface RunStamp {
  releaseId: string;
  sourceDigest: string;
  bundleDigest: string;
  projectId: string;
  agentName: string;
  runId: string;
  attempt: string;
  method: string;
  checksDigest: string;
  /** `name-version` of the model deployment as read before the first check. */
  model: string;
  /** The documents digest, or null when the release has none. */
  documents: string | null;
}
export function runStamp(
  plan: ReleasePlan,
  identity: { runId: string; attempt: string },
  model: string,
): RunStamp {
  if (!plan.checks) throw new Error("check_manifest");
  return {
    releaseId: plan.releaseId,
    sourceDigest: plan.sourceDigest,
    bundleDigest: plan.bundleDigest,
    projectId: plan.selected.projectId,
    agentName: plan.agentName,
    runId: identity.runId,
    attempt: identity.attempt,
    method: CHECK_RUN_METHOD,
    checksDigest: plan.checks.digest,
    model,
    documents:
      plan.knowledge && plan.knowledge.documentCount > 0 ? plan.knowledge.documentsDigest : null,
  };
}

function build(
  stamp: RunStamp,
  event: RunEvent,
  extra: [string, string | undefined][],
  when: { startMs: number; endMs: number },
  ok: boolean,
  checkId = "",
) {
  const attributes: [string, string | undefined][] = [
    ["impact.observation.profile", CHECK_RUN_PROFILE],
    ["impact.release.id", stamp.releaseId],
    ["impact.release.source_digest", stamp.sourceDigest],
    ["impact.release.bundle_digest", stamp.bundleDigest],
    ["deployment.environment.name", "development"],
    ["azure.project.id", stamp.projectId],
    ["gen_ai.agent.id", stamp.agentName],
    ["gen_ai.agent.name", stamp.agentName],
    ["impact.check.run.id", stamp.runId],
    ["impact.check.run.attempt", stamp.attempt],
    ["impact.check.run.event", event],
    ["impact.check.method", stamp.method],
    ["impact.check.checks_digest", stamp.checksDigest],
    ["impact.release.model", stamp.model],
    ["impact.knowledge.digest", stamp.documents ?? undefined],
    ...extra,
  ];
  const startMs = when.startMs;
  const endMs = Math.max(when.endMs, startMs);
  const span = {
    ...checkRunIds(stamp.runId, stamp.attempt, event, checkId),
    name: `impact.check_run.${event}`,
    kind: 1,
    startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    attributes: attributes.flatMap(([key, value]) =>
      value === undefined ? [] : [{ key, value: { stringValue: value } }],
    ),
    status: { code: ok ? 1 : 2 },
  };
  return {
    span,
    request: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "impact-azure-development-checks" } },
            ],
          },
          scopeSpans: [{ scope: { name: "impact.azure.checks", version: "1" }, spans: [span] }],
        },
      ],
    },
  };
}

/** What will run: every kept check's id in plan order, and when the job ends at the latest. */
export function plannedSpan(stamp: RunStamp, ids: readonly string[], atMs: number) {
  return build(
    stamp,
    "planned",
    [
      ["impact.check.run.planned", String(ids.length)],
      ["impact.check.run.ids", ids.join(",")],
      ["impact.check.run.deadline", new Date(atMs + CHECK_RUN_MINUTES * 60_000).toISOString()],
    ],
    { startMs: atMs, endMs: atMs },
    true,
  );
}
/** One check's result: its id and content digest, the judges that looked, and which of them found something. */
export function caseSpan(
  stamp: RunStamp,
  result: CheckResult,
  check: SavedCheck,
  version: string,
  when: { startMs: number; endMs: number },
) {
  return build(
    stamp,
    "case",
    [
      ["gen_ai.agent.version", version],
      ["impact.check.source", result.id.startsWith("sample:") ? "scenario" : "rehearsal"],
      ["impact.check.id", result.id],
      ["impact.check.digest", checksDigest(check)],
      ["impact.check.judges", result.judges.join(",")],
      ["impact.check.failed_judges", result.failedJudges.join(",")],
      ["impact.check.outcome", result.state],
      ["impact.check.reason", result.reason ?? undefined],
      ["impact.check.answers", "sample"],
    ],
    when,
    result.state === "passed",
    result.id,
  );
}
/** How the run ended; `reason` is a content-free code, never a message. */
export function endedSpan(
  stamp: RunStamp,
  end: { state: RunEndState; reason: string | null; reported: number; version: string },
  atMs: number,
) {
  return build(
    stamp,
    "ended",
    [
      ["impact.check.run.state", end.state],
      ["impact.check.run.reason", end.reason ?? undefined],
      ["impact.check.run.reported", String(end.reported)],
      ["gen_ai.agent.version", end.version || undefined],
    ],
    { startMs: atMs, endMs: atMs },
    end.state === "passed",
  );
}

/**
 * How a failed release ends the run: the checks' own findings and incomplete judgments keep their meaning, anything else
 * (a pinned model that moved, a store that does not match, a provider error) stopped it. `code` is `safeDiagnostic`'s.
 */
export function runEndOf(code: string): { state: RunEndState; reason: string } {
  if (code === "release_check_finding") return { state: "finding", reason: code };
  if (code === "release_check_incomplete") return { state: "incomplete", reason: code };
  return { state: "stopped", reason: code };
}

/** The exporter's rules of `observe.ts`: https, `/v1/traces`, nothing in the address but the path, a one-line key. */
function endpointOf(config: ObservationConfig): URL | null {
  try {
    const endpoint = new URL(config.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.pathname !== "/v1/traces" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password ||
      !config.productKey ||
      /[\r\n]/u.test(config.productKey)
    )
      return null;
    return endpoint;
  } catch {
    return null;
  }
}

/** One export of one request, bounded, redirects refused, nothing of the key or the answer ever returned. */
async function exportRequest(
  request: unknown,
  config: ObservationConfig,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<ExportState> {
  const endpoint = endpointOf(config);
  if (!endpoint) return "invalid_configuration";
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${config.productKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (response.status !== 200) return "refused";
    const result = (await response.json()) as {
      partialSuccess?: { rejectedSpans?: string | number };
    };
    const rejected = result.partialSuccess?.rejectedSpans;
    return rejected && String(rejected) !== "0" ? "refused" : "accepted";
  } catch {
    return "unknown";
  }
}

/** Whether, and where, this release step reports its run. */
export function checkRunSetup(
  plan: ReleasePlan,
  env: Record<string, string | undefined>,
):
  | { state: "reporting"; config: ObservationConfig; runId: string; attempt: string }
  | { state: "not_applicable" | "not_configured" | "invalid_configuration" | "no_run_identity" } {
  if (plan.environment !== "development" || !plan.checks) return { state: "not_applicable" };
  const config = observationFromEnv(env);
  if (!config) return { state: "not_configured" };
  if (!endpointOf(config)) return { state: "invalid_configuration" };
  const runId = env.GITHUB_RUN_ID ?? "";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "";
  if (!runIdPattern.test(runId) || !attemptPattern.test(attempt) || Number(attempt) > 1000)
    return { state: "no_run_identity" };
  return { state: "reporting", config, runId, attempt };
}

export interface CheckRunReporter {
  /** `reporting`, or why nothing is exported; every method is then a no-op. */
  readonly setup: ReportState | "reporting";
  /** `sent` spans exported (a re-export is not counted again), `accepted`, `failed`, and `cases` sent. */
  readonly counts: { sent: number; accepted: number; failed: number; cases: number };
  /** Reads the deployed model, then exports and awaits the plan. Call it before the first model call. */
  planned(): Promise<ReportState>;
  case(result: CheckResult, check: SavedCheck, version: string): Promise<void>;
  ended(state: RunEndState, reason: string | null, version?: string): Promise<void>;
}

export function createCheckRunReporter(input: {
  plan: ReleasePlan;
  env?: Record<string, string | undefined>;
  /** The model deployment as it is now, `name-version`: what the run reports it ran on. */
  readModel: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Request deadline in ms for every span; the plan gets a little longer by default. */
  timeoutMs?: number;
  /**
   * The most time all check spans together may cost the release. Reporting never competes with the checks for their own
   * time: once this is spent the reporter stops sending check spans for good (the run then reads as not fully reported
   * on impact.ai, never as passed) and the release carries on unaffected.
   */
  budgetMs?: number;
}): CheckRunReporter {
  const { plan, readModel } = input;
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const setup = checkRunSetup(plan, input.env ?? process.env);
  const counts = { sent: 0, accepted: 0, failed: 0, cases: 0 };
  let stamp: RunStamp | undefined;
  let accepted = false;
  let finished = false;
  let version = "";
  let mark = 0;
  let failedInARow = 0;
  let spentMs = 0;
  let planning: Promise<ReportState> | undefined;
  /** One export, and one re-export of the identical span when it did not go through. */
  async function send(request: unknown, timeoutMs: number): Promise<ExportState> {
    if (setup.state !== "reporting") return "invalid_configuration";
    counts.sent += 1;
    let state = await exportRequest(request, setup.config, fetcher, timeoutMs);
    if (state !== "accepted" && state !== "invalid_configuration")
      state = await exportRequest(request, setup.config, fetcher, timeoutMs);
    if (state === "accepted") counts.accepted += 1;
    else counts.failed += 1;
    return state;
  }
  return {
    setup: setup.state,
    counts,
    planned() {
      planning ??= (async (): Promise<ReportState> => {
        if (setup.state !== "reporting") return setup.state;
        try {
          stamp = runStamp(plan, { runId: setup.runId, attempt: setup.attempt }, await readModel());
        } catch {
          return "model_unreadable";
        }
        mark = now();
        const state = await send(
          plannedSpan(stamp, plan.checks?.ids ?? [], mark).request,
          input.timeoutMs ?? 5000,
        );
        accepted = state === "accepted";
        return state;
      })();
      return planning;
    },
    async case(result, check, candidateVersion) {
      version = candidateVersion;
      // Two spans in a row that did not go through, or the reporting time spent: stop spending the release's time on an
      // endpoint that is down or slow. The spent time never comes back, so one fast answer later does not undo it.
      if (
        !stamp ||
        !accepted ||
        finished ||
        failedInARow >= 2 ||
        spentMs >= (input.budgetMs ?? 30_000)
      )
        return;
      const startMs = mark;
      mark = Math.max(now(), startMs);
      counts.cases += 1;
      const began = Date.now();
      const state = await send(
        caseSpan(stamp, result, check, candidateVersion, { startMs, endMs: mark }).request,
        input.timeoutMs ?? 3000,
      );
      spentMs += Date.now() - began;
      failedInARow = state === "accepted" ? 0 : failedInARow + 1;
    },
    async ended(state, reason, endedVersion) {
      // A plan still going out when a cancel arrives is waited for (the caller bounds the wait), so the end follows it.
      await planning?.catch(() => undefined);
      if (!stamp || !accepted || finished) return;
      finished = true;
      await send(
        endedSpan(
          stamp,
          { state, reason, reported: counts.cases, version: endedVersion ?? version },
          now(),
        ).request,
        input.timeoutMs ?? 3000,
      );
    },
  };
}

/**
 * GitHub cancels a job with SIGINT, then SIGTERM. Say so within `graceMs`, then leave with the signal's own exit code, so
 * a cancelled run reads as stopped, not as one that merely went quiet. Returns the function that stops listening.
 */
export function watchCancellation(
  reporter: Pick<CheckRunReporter, "ended">,
  options: {
    target?: Pick<NodeJS.Process, "once" | "removeListener" | "exit">;
    graceMs?: number;
    /** Called at once, before anything is awaited, so the release can stop making requests the moment a cancel arrives. */
    onCancel?: () => void;
  } = {},
) {
  const target = options.target ?? process;
  const codes = { SIGINT: 130, SIGTERM: 143 } as const;
  const listeners = (Object.keys(codes) as (keyof typeof codes)[]).map((signal) => {
    const listener = () => {
      options.onCancel?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.graceMs ?? 2000);
      });
      const ended = reporter.ended("stopped", "cancelled").catch(() => {});
      void Promise.race([ended, grace]).then(() => {
        clearTimeout(timer);
        target.exit(codes[signal]);
      });
    };
    target.once(signal, listener);
    return [signal, listener] as const;
  });
  return () => {
    for (const [signal, listener] of listeners) target.removeListener(signal, listener);
  };
}
