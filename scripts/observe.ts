/** Opt-in OTLP/HTTP observation of one real invocation boundary; never native internal spans. */
import { randomBytes } from "node:crypto";
export interface ObservationConfig {
  endpoint: string;
  productKey: string;
  /** Bounded request deadline in ms; production calls use a short one, qualification keeps 20s. */
  timeoutMs?: number;
  /** `impact.observation.profile`; production calls use `azure_invocation_boundary`. */
  profile?: string;
}
/** Both values or neither, as the release step hands them over; half a setup is invalid, never silently dropped. */
export function observationFromEnv(env: Record<string, string | undefined>) {
  const endpoint = env.IMPACT_OTLP_TRACES_ENDPOINT;
  const productKey = env.IMPACT_PRODUCT_KEY;
  return endpoint || productKey
    ? { endpoint: endpoint ?? "", productKey: productKey ?? "" }
    : undefined;
}
export interface InvocationObservation {
  agentName: string;
  agentVersion: string;
  releaseId: string;
  sourceDigest: string;
  bundleDigest: string;
  environment: "development" | "production";
  projectId: string;
  responseId: string;
  completed: boolean;
  startedAtMs: number;
  endedAtMs: number;
}
export function invocationSpan(
  value: InvocationObservation,
  profile = "azure_qualification_invocation_boundary",
) {
  const attributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.id": value.agentName,
    "gen_ai.agent.name": value.agentName,
    "gen_ai.agent.version": value.agentVersion,
    "gen_ai.response.id": value.responseId,
    "impact.release.id": value.releaseId,
    "impact.release.source_digest": value.sourceDigest,
    "impact.release.bundle_digest": value.bundleDigest,
    "deployment.environment.name": value.environment,
    "azure.project.id": value.projectId,
    "impact.observation.profile": profile,
  };
  const span = {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: "invoke_agent",
    kind: 3,
    startTimeUnixNano: String(BigInt(value.startedAtMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Math.max(value.endedAtMs, value.startedAtMs)) * 1_000_000n),
    attributes: Object.entries(attributes).map(([key, text]) => ({
      key,
      value: { stringValue: text },
    })),
    status: { code: value.completed ? 1 : 2 },
  };
  return {
    span,
    request: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "impact-azure-qualification" } },
            ],
          },
          scopeSpans: [
            { scope: { name: "impact.azure.qualification", version: "1" }, spans: [span] },
          ],
        },
      ],
    },
  };
}
export async function exportInvocation(
  value: InvocationObservation,
  config: ObservationConfig,
  fetcher: typeof fetch = fetch,
) {
  const { span, request } = invocationSpan(value, config.profile);
  const evidence = { traceId: span.traceId, spanId: span.spanId, nativeInternalSpans: false };
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
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
      throw new Error("invalid_configuration");
  } catch {
    return { ...evidence, state: "invalid_configuration" as const };
  }
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
      headers: {
        Authorization: `Bearer ${config.productKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (response.status !== 200) return { ...evidence, state: "refused" as const };
    const result = (await response.json()) as {
      partialSuccess?: { rejectedSpans?: string | number };
    };
    if (result.partialSuccess?.rejectedSpans && String(result.partialSuccess.rejectedSpans) !== "0")
      return { ...evidence, state: "refused" as const };
    return { ...evidence, state: "accepted_pending_readback" as const };
  } catch {
    // A failed export never retries the actual Azure invocation or prints provider errors/key material.
    return { ...evidence, state: "unknown" as const };
  }
}

/**
 * Production export: never awaited by the call, bounded by a short deadline, errors swallowed and counted. A serverless
 * runtime may freeze a pending export after the response; `flush()` lets a handler await it before returning.
 */
export function createEmitter(
  config: ObservationConfig | undefined,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
) {
  const counts = { emitted: 0, accepted: 0, failed: 0 };
  const pending = new Set<Promise<void>>();
  return {
    counts,
    emit(value: InvocationObservation): void {
      if (!config) return;
      counts.emitted += 1;
      const job = exportInvocation(
        value,
        { profile: "azure_invocation_boundary", timeoutMs, ...config },
        fetcher,
      )
        .then((result) => {
          if (result.state === "accepted_pending_readback") counts.accepted += 1;
          else counts.failed += 1;
        })
        .catch(() => {
          counts.failed += 1;
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}
