/**
 * The production invocation path for an agent built from this starter. Route your real traffic through
 * `createAzureInvoker().invoke(message)`: it makes the same controlled call as qualification and emits exactly one
 * content-free span per attempted call, stamped with the release. Calls that bypass it emit nothing.
 */

import { createEmitter, type ObservationConfig, observationFromEnv } from "./observe.js";
import { callAgent, type Receipt, type ReleasePlan } from "./release.js";

export interface AzureInvokerDeps {
  plan: ReleasePlan;
  /** The confirmation receipt of the release this runtime serves. */
  receipt: Receipt;
  getToken: (audience: string) => string;
  fetcher?: typeof fetch;
  /** Defaults to IMPACT_OTLP_TRACES_ENDPOINT and IMPACT_PRODUCT_KEY from `env`; none: no span, no failure. */
  observation?: ObservationConfig;
  env?: Record<string, string | undefined>;
  /** Export deadline in ms; the export is never awaited by the call. */
  exportTimeoutMs?: number;
}

export function createAzureInvoker(deps: AzureInvokerDeps) {
  const fetcher = deps.fetcher ?? fetch;
  const emitter = createEmitter(
    deps.observation ?? observationFromEnv(deps.env ?? process.env),
    fetcher,
    deps.exportTimeoutMs,
  );
  const { plan, receipt } = deps;
  return {
    /** Export counters (`emitted`, `accepted`, `failed`); errors are swallowed and counted, never thrown. */
    counts: emitter.counts,
    /** Await pending exports, for a serverless handler that would otherwise freeze them. */
    flush: emitter.flush,
    async invoke(message: string) {
      let startedAtMs: number | undefined;
      const stamp = (responseId: string, completed: boolean, endedAtMs: number) =>
        emitter.emit({
          agentName: plan.agentName,
          agentVersion: receipt.agentVersion,
          releaseId: plan.releaseId,
          sourceDigest: plan.sourceDigest,
          bundleDigest: plan.bundleDigest,
          environment: plan.environment,
          projectId: plan.selected.projectId,
          responseId,
          completed,
          startedAtMs: startedAtMs ?? endedAtMs,
          endedAtMs,
        });
      let result: Awaited<ReturnType<typeof callAgent>>;
      try {
        result = await callAgent(plan, receipt, message, deps.getToken, fetcher, (at) => {
          startedAtMs = at;
        });
      } catch (error) {
        // A refusal before the call (receipt, input, version moved) made no agent call and emits nothing.
        if (startedAtMs !== undefined) stamp("none", false, Date.now());
        throw error;
      }
      const id = typeof result.response.id === "string" ? result.response.id : "";
      stamp(
        /^[A-Za-z0-9_-]+$/u.test(id) ? id : "none",
        result.response.status === "completed",
        result.endedAtMs,
      );
      return {
        responseId: id,
        status: String(result.response.status),
        output: result.response.output,
      };
    },
  };
}
