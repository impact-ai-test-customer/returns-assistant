/** Customer-owned runner. Node 26 runs this TypeScript directly; no install step or Impact credentials. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckReport, CheckResult, PrivateBundle, SavedCheck } from "./checks.js";
import type { ToolEffect } from "./judges.js";
import type { ObservationConfig } from "./observe.js";
import type { CheckRunReporter } from "./report.js";

export const DATA_API = "v1";
export const ARM_API = "2026-01-15-preview";
const ARM = "https://management.azure.com";
type ObjectValue = Record<string, unknown>;
const obj = (x: unknown): ObjectValue => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("invalid_object");
  return x as ObjectValue;
};
const str = (x: unknown, pattern = /^.{1,512}$/u) => {
  if (typeof x !== "string" || !pattern.test(x)) throw new Error("invalid_string");
  return x;
};
const list = (x: unknown): unknown[] => {
  if (!Array.isArray(x)) throw new Error("invalid_list");
  return x;
};
const sha = /^[a-f0-9]{64}$/u;
const versionPattern = /^[0-9]+$/u;
const canonical = (x: unknown): string =>
  JSON.stringify(
    Array.isArray(x)
      ? x.map((v) => JSON.parse(canonical(v)))
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x)
              .sort(([a], [b]) => a.localeCompare(b, "en"))
              .map(([k, v]) => [k, JSON.parse(canonical(v))]),
          )
        : x,
  );
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
export type ProviderCall = (url: string, method?: string, body?: unknown) => Promise<unknown>;
export interface Receipt {
  format: "impact-azure-release/v1";
  state: "deployed";
  environment: "development" | "production";
  bundleDigest: string;
  sourceDigest: string;
  sourceCommit: string;
  releaseId: string;
  projectId: string;
  agentName: string;
  agentVersion: string;
  applicationId: string;
  endpoint: string;
  previousVersion: string | null;
  limits: { tokens: number; secondsPerTurn: number };
  knowledge?: KnowledgeReceipt;
  checks?: CheckReport;
}
export interface KnowledgeReceipt {
  format: "impact-agent-knowledge-receipt/v1";
  state: "completed";
  releaseId: string;
  sourceDigest: string;
  environment: "development" | "production";
  projectId: string;
  vectorStoreId: string | null;
  documentsDigest: string;
  documentCount: number;
  replay?: { blobUrl: string; sha256: string; checksDigest: string; checkCount: number };
}

function binding(input: unknown) {
  const x = obj(input);
  const projectId = str(
    x.projectId,
    /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[a-z0-9-]{2,64}\/projects\/[A-Za-z0-9._-]{1,64}$/u,
  );
  const parts = projectId.split("/");
  const endpoint = `https://${parts[8]}.services.ai.azure.com/api/projects/${parts[10]}`;
  if (x.endpoint !== endpoint) throw new Error("project_endpoint");
  const m = obj(x.model);
  const model = {
    deployment: str(m.deployment, /^[A-Za-z0-9._-]{1,64}$/u),
    name: str(m.name),
    version: str(m.version),
  };
  const toolConnections = Object.fromEntries(
    Object.entries(obj(x.toolConnections)).map(([k, v]) => {
      const id = str(v);
      if (
        !id.startsWith(`${projectId}/connections/`) ||
        !/^[A-Za-z0-9._-]{1,64}$/u.test(id.slice(id.lastIndexOf("/") + 1))
      )
        throw new Error("tool_connection");
      return [k, id];
    }),
  );
  const vectorStores = list(x.vectorStores).map((v) => str(v, /^vs_[A-Za-z0-9_-]{1,128}$/u));
  return { projectId, endpoint, model, toolConnections, vectorStores };
}

export function prepareRelease(
  files: Record<string, string>,
  environment: "development" | "production",
  knowledgeInput?: unknown,
) {
  if (!["development", "production"].includes(environment)) throw new Error("environment_required");
  const manifest = obj(JSON.parse(files["agent/agent.json"] ?? "null"));
  if (manifest.format !== "impact-agent/v1" || manifest.modelUpgrade !== "disabled")
    throw new Error("manifest_format");
  if (manifest.instructions !== "instructions.md" || manifest.rules !== "rules.json")
    throw new Error("manifest_paths");
  const source = obj(manifest.source);
  const sourceDigest = str(source.digest, sha);
  const sourceId = str(source.agentId, /^[A-Za-z0-9_-]{1,128}$/u);
  if (!Number.isSafeInteger(source.draftNumber) || Number(source.draftNumber) < 1)
    throw new Error("draft_number");
  const target = obj(manifest.target);
  if (target.provider !== "azure") throw new Error("provider");
  const development = binding(target.development);
  const production = binding(target.production);
  if (development.projectId.toLowerCase() === production.projectId.toLowerCase())
    throw new Error("environment_isolation");
  const selected = environment === "development" ? development : production;
  const agentName = `impact-${hash(sourceId).slice(0, 32)}`;
  const instructions = files["agent/instructions.md"];
  if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 200_000)
    throw new Error("instructions");
  const guardRules = list(JSON.parse(files["agent/rules.json"] ?? "null"));
  let checks: { digest: string; count: number; ids: string[] } | undefined;
  if (manifest.checks && obj(manifest.checks).required === true) {
    const declared = obj(manifest.checks);
    const publicChecks = obj(JSON.parse(files["agent/checks.json"] ?? "null"));
    const digest = str(declared.digest, sha);
    const count = Number(declared.count);
    const ids = list(publicChecks.ids).map((x) =>
      str(x, /^(?:sample:[a-z][a-z0-9-]{1,39}|chk_[0-9a-f]{24})$/u),
    );
    if (
      publicChecks.format !== "impact-agent-checks/v1" ||
      publicChecks.sourceDigest !== sourceDigest ||
      publicChecks.digest !== digest ||
      publicChecks.count !== count ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 58 ||
      ids.length !== count ||
      new Set(ids).size !== count
    )
      throw new Error("check_manifest");
    checks = { digest, count, ids };
  } else if (guardRules.length || files["agent/checks.json"])
    throw new Error("release_checks_require_execution");
  const limitsValue = obj(manifest.limits);
  const limits = {
    tokens: Number(limitsValue.tokens),
    secondsPerTurn: Number(limitsValue.secondsPerTurn),
  };
  if (
    !Number.isSafeInteger(limits.tokens) ||
    limits.tokens < 1 ||
    !Number.isSafeInteger(limits.secondsPerTurn) ||
    limits.secondsPerTurn < 1
  )
    throw new Error("limits");
  const used = new Set(["agent/agent.json", "agent/instructions.md", "agent/rules.json"]);
  if (files["agent/checks.json"]) used.add("agent/checks.json");
  const connections: { id: string; target: string }[] = [];
  const marker = obj(JSON.parse(files["agent/release.json"] ?? "null"));
  const releaseId = str(marker.releaseId, /^rel_[a-f0-9]{24}$/u);
  if (marker.sourceDigest !== sourceDigest) throw new Error("release_source_mismatch");
  let knowledge: KnowledgeReceipt | undefined;
  used.add("agent/release.json");
  const needsDocuments = !!manifest.knowledge && obj(manifest.knowledge).required === true;
  if (needsDocuments || checks) {
    const value = obj(knowledgeInput);
    if (
      (needsDocuments && obj(manifest.knowledge).sourceDigest !== sourceDigest) ||
      selected.vectorStores.length ||
      value.format !== "impact-agent-knowledge-receipt/v1" ||
      value.state !== "completed" ||
      value.releaseId !== releaseId ||
      value.sourceDigest !== sourceDigest ||
      value.environment !== environment ||
      value.projectId !== selected.projectId
    )
      throw new Error("knowledge_receipt_mismatch");
    knowledge = {
      format: "impact-agent-knowledge-receipt/v1",
      state: "completed",
      releaseId,
      sourceDigest,
      environment,
      projectId: selected.projectId,
      vectorStoreId:
        value.vectorStoreId === null
          ? null
          : str(value.vectorStoreId, /^vs_[A-Za-z0-9_-]{1,128}$/u),
      documentsDigest: str(value.documentsDigest, sha),
      documentCount: Number(value.documentCount),
    };
    if (
      !Number.isSafeInteger(knowledge.documentCount) ||
      knowledge.documentCount < 0 ||
      knowledge.documentCount > 100 ||
      (needsDocuments
        ? knowledge.documentCount < 1 || !knowledge.vectorStoreId
        : knowledge.documentCount !== 0 || knowledge.vectorStoreId !== null)
    )
      throw new Error("knowledge_document_count");
    if (
      needsDocuments &&
      (knowledge.documentsDigest !== obj(manifest.knowledge).documentsDigest ||
        knowledge.documentCount !== obj(manifest.knowledge).documentCount)
    )
      throw new Error("knowledge_source_mismatch");
    if (needsDocuments && knowledge.vectorStoreId)
      selected.vectorStores.push(knowledge.vectorStoreId);
    if (checks) {
      const replay = obj(value.replay);
      knowledge.replay = {
        blobUrl: str(
          replay.blobUrl,
          /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/release-inputs\/rel_[0-9a-f]{24}\.json\?versionid=[^&]+$/u,
        ),
        sha256: str(replay.sha256, sha),
        checksDigest: str(replay.checksDigest, sha),
        checkCount: Number(replay.checkCount),
      };
      if (
        knowledge.replay.checksDigest !== checks.digest ||
        knowledge.replay.checkCount !== checks.count
      )
        throw new Error("check_receipt_mismatch");
    }
  } else if (knowledgeInput) throw new Error("unexpected_knowledge_receipt");
  const replayOperations: { name: string; effect: ToolEffect; summary: string }[] = [];
  const tools: ObjectValue[] = list(manifest.tools).map((raw, index) => {
    const tool = obj(raw);
    const label = `tool-${index}`;
    const name = str(tool.name);
    const connection = selected.toolConnections[name];
    if (!connection) throw new Error("tool_connection");
    const operations = list(tool.operations).map(obj);
    if (operations.length === 0) throw new Error("empty_tool_operations");
    const names = operations.map((op) => str(op.name, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u));
    for (const op of operations) {
      const effect = op.effect;
      if (checks && !["reads", "acts", "moves_money"].includes(String(effect)))
        throw new Error("check_tool_effect");
      replayOperations.push({
        name: String(op.name),
        effect: (["reads", "acts", "moves_money"].includes(String(effect))
          ? effect
          : "acts") as ToolEffect,
        summary: typeof op.summary === "string" ? op.summary : "",
      });
    }
    const always = operations
      .filter((op) => list(op.approvals).some((a) => obj(a).kind === "every_call"))
      .map((op) => String(op.name));
    for (const op of operations)
      for (const approval of list(op.approvals)) {
        if (!["every_call", "customer", "over_amount"].includes(String(obj(approval).kind)))
          throw new Error("unknown_approval");
      }
    if (tool.kind === "mcp") {
      const url = new URL(str(tool.url));
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error("mcp_url");
      connections.push({ id: connection, target: url.href });
      return {
        type: "mcp",
        server_label: label,
        server_url: url.href,
        project_connection_id: connection.split("/").at(-1),
        allowed_tools: names,
        require_approval: {
          ...(always.length ? { always: { tool_names: always } } : {}),
          ...(always.length < names.length
            ? { never: { tool_names: names.filter((n) => !always.includes(n)) } }
            : {}),
        },
      };
    }
    if (tool.kind !== "openapi" || always.length) throw new Error("openapi_approval_or_kind");
    const path = `agent/${str(tool.definition, /^tools\/tool-[0-9]+\.json$/u)}`;
    used.add(path);
    const spec = obj(JSON.parse(files[path] ?? "null"));
    const paths = obj(spec.paths);
    const servers = list(spec.servers);
    if (servers.length !== 1) throw new Error("openapi_server");
    const url = new URL(str(obj(servers[0]).url));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("openapi_server");
    const projected: ObjectValue = {};
    for (const op of operations) {
      const route = str(op.path);
      const method = str(op.method).toLowerCase();
      const item = obj(paths[route]);
      const selectedOperation = obj(item[method]);
      if (
        selectedOperation.operationId !== op.name ||
        item.$ref ||
        item.servers ||
        selectedOperation.servers ||
        selectedOperation.callbacks
      )
        throw new Error("openapi_operations");
      projected[route] ??= { ...(item.parameters ? { parameters: item.parameters } : {}) };
      obj(projected[route])[method] = selectedOperation;
    }
    if (
      canonical(projected) !== canonical(paths) ||
      spec.webhooks ||
      /"\$ref"\s*:\s*"(?!#\/)/u.test(JSON.stringify(spec))
    )
      throw new Error("openapi_operations");
    connections.push({ id: connection, target: url.href });
    return {
      type: "openapi",
      openapi: {
        name: label,
        spec,
        auth: {
          type: "project_connection",
          security_scheme: { project_connection_id: connection },
        },
      },
    };
  });
  if (Object.keys(files).some((p) => !used.has(p))) throw new Error("unexpected_file");
  if (selected.vectorStores.length)
    tools.push({ type: "file_search", vector_store_ids: selected.vectorStores });
  const bundleDigest = hash(
    JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))),
  );
  const definition = { kind: "prompt", model: selected.model.deployment, instructions, tools };
  return {
    environment,
    selected,
    development,
    production,
    sourceDigest,
    sourceId,
    agentName,
    bundleDigest,
    definition,
    connections,
    limits,
    knowledge,
    releaseId,
    checks,
    guardRuleCount: guardRules.length,
    replayOperations,
  };
}
export type ReleasePlan = ReturnType<typeof prepareRelease>;

function verifyVersion(value: unknown, plan: ReleasePlan) {
  const x = obj(value);
  const metadata = obj(x.metadata);
  if (
    x.name !== plan.agentName ||
    metadata.impact_bundle !== plan.bundleDigest ||
    metadata.impact_source !== plan.sourceDigest ||
    canonical(x.definition) !== canonical(plan.definition)
  )
    throw new Error("version_definition_mismatch");
  return str(x.version, versionPattern);
}
async function findVersion(plan: ReleasePlan, call: ProviderCall) {
  let after = "";
  let found: unknown = null;
  for (let page = 0; page < 100; page++) {
    const raw = await call(
      `${plan.selected.endpoint}/agents/${plan.agentName}/versions?api-version=${DATA_API}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    if (raw === null) return null;
    const result = obj(raw);
    const data = list(result.data);
    for (const row of data)
      if (obj(row).metadata && obj(obj(row).metadata).impact_bundle === plan.bundleDigest) {
        if (found) throw new Error("duplicate_release_versions");
        verifyVersion(row, plan);
        found = row;
      }
    if (result.has_more === false) return found;
    if (result.has_more !== true || !data.length) throw new Error("versions_incomplete");
    const cursor = str(obj(data.at(-1)).id);
    if (cursor === after) throw new Error("versions_incomplete");
    after = cursor;
  }
  throw new Error("versions_incomplete");
}
export async function runRelease(
  plan: ReleasePlan,
  call: ProviderCall,
  options: {
    sourceCommit: string;
    promotionReceipt?: Receipt;
    rollbackVersion?: string;
    verifyOnly?: boolean;
    resumeOnly?: boolean;
    wait?: (ms: number) => Promise<void>;
    privateBundle?: PrivateBundle;
    sendReplay?: (body: unknown, remainingMs: number) => Promise<unknown>;
    recordChecks?: (report: CheckReport) => Promise<void>;
    /** Called after each check settles with the version those checks ran on; see `runReportedRelease`. */
    onCheckResult?: (
      result: CheckResult,
      check: SavedCheck,
      version: string,
    ) => void | Promise<void>;
    recordPhase?: (
      phase: "prewrite" | "version_write_started" | "version_write_confirmed",
    ) => Promise<void>;
  },
): Promise<Receipt> {
  str(options.sourceCommit, /^[0-9a-f]{40}$/u);
  let checkedBundle: PrivateBundle | undefined;
  if (plan.checks) {
    const { validatePrivateBundle } = await import("./checks.ts");
    checkedBundle = validatePrivateBundle(options.privateBundle, {
      ...plan.checks,
      releaseId: plan.releaseId,
      sourceDigest: plan.sourceDigest,
    });
  }
  await options.recordPhase?.(options.resumeOnly ? "version_write_started" : "prewrite");
  if (plan.environment === "production" && !options.rollbackVersion) {
    const receipt = options.promotionReceipt;
    if (
      receipt?.format !== "impact-azure-release/v1" ||
      receipt.state !== "deployed" ||
      receipt.environment !== "development" ||
      receipt.bundleDigest !== plan.bundleDigest ||
      receipt.sourceCommit !== options.sourceCommit ||
      receipt.releaseId !== plan.releaseId ||
      receipt.projectId !== plan.development.projectId ||
      receipt.agentName !== plan.agentName
    )
      throw new Error("promotion_receipt");
  }
  const accountId = plan.selected.projectId.slice(
    0,
    plan.selected.projectId.lastIndexOf("/projects/"),
  );
  const model = obj(
    obj(
      await call(
        `${ARM}${accountId}/deployments/${plan.selected.model.deployment}?api-version=2025-06-01`,
      ),
    ).properties,
  );
  const actualModel = obj(model.model);
  if (
    actualModel.name !== plan.selected.model.name ||
    actualModel.version !== plan.selected.model.version ||
    model.versionUpgradeOption !== "NoAutoUpgrade"
  )
    throw new Error("model_pin");
  for (const connection of plan.connections) {
    const actual = obj(obj(await call(`${ARM}${connection.id}?api-version=2025-06-01`)).properties);
    if (new URL(str(actual.target)).href !== connection.target)
      throw new Error("tool_connection_target");
  }
  for (const store of plan.selected.vectorStores) {
    const actual = obj(await call(`${plan.selected.endpoint}/openai/v1/vector_stores/${store}`));
    if (actual.id !== store || actual.status !== "completed")
      throw new Error("file_search_not_ready");
    if (plan.knowledge) {
      const metadata = obj(actual.metadata);
      const counts = obj(actual.file_counts);
      if (
        metadata.impact_release !== plan.releaseId ||
        metadata.impact_source !== plan.sourceDigest ||
        metadata.impact_documents !== plan.knowledge.documentsDigest ||
        counts.completed !== plan.knowledge.documentCount ||
        counts.total !== plan.knowledge.documentCount ||
        counts.failed !== 0 ||
        counts.cancelled !== 0 ||
        counts.in_progress !== 0
      )
        throw new Error("knowledge_store_mismatch");
    }
  }
  const appId = `${plan.selected.projectId}/applications/${plan.agentName}`;
  const appUrl = `${ARM}${appId}?api-version=${ARM_API}`;
  const deploymentUrl = `${ARM}${appId}/agentdeployments/live?api-version=${ARM_API}`;
  const old = await call(deploymentUrl);
  const oldAgents = old ? list(obj(obj(old).properties).agents) : [];
  const previousVersion = oldAgents.length
    ? str(obj(oldAgents[0]).agentVersion, versionPattern)
    : null;
  let version: string;
  if (options.rollbackVersion) {
    version = str(options.rollbackVersion, versionPattern);
    const retained = await call(
      `${plan.selected.endpoint}/agents/${plan.agentName}/versions/${version}?api-version=${DATA_API}`,
    );
    if (!retained) throw new Error("rollback_version_missing");
    verifyVersion(retained, plan);
  } else {
    let existing = await findVersion(plan, call);
    if (!existing) {
      if (options.verifyOnly || options.resumeOnly)
        throw new Error(
          "release_not_found: no new write during recovery; reconcile the original run",
        );
      try {
        await options.recordPhase?.("version_write_started");
        existing = await call(
          `${plan.selected.endpoint}/agents/${plan.agentName}/versions?api-version=${DATA_API}`,
          "POST",
          {
            definition: plan.definition,
            metadata: {
              impact_bundle: plan.bundleDigest,
              impact_source: plan.sourceDigest,
              impact_commit: options.sourceCommit,
            },
          },
        );
      } catch {
        throw new Error(
          "version_write_unknown: reconcile this release before retrying; do not create a replacement release",
        );
      }
    }
    version = verifyVersion(existing, plan);
  }
  await options.recordPhase?.("version_write_confirmed");
  let checkReport: CheckReport | undefined;
  if (plan.checks && checkedBundle) {
    const { runSavedChecks } = await import("./checks.ts");
    checkReport = await runSavedChecks(
      plan,
      version,
      checkedBundle,
      options.sendReplay ??
        ((body) => call(`${plan.selected.endpoint}/openai/v1/responses`, "POST", body)),
      undefined,
      options.onCheckResult && ((result, check) => options.onCheckResult?.(result, check, version)),
    );
    await options.recordChecks?.(checkReport);
    if (checkReport.state !== "passed")
      throw new Error(
        checkReport.state === "finding" ? "release_check_finding" : "release_check_incomplete",
      );
  }
  if (plan.checks) {
    const current = obj(
      obj(
        await call(
          `${ARM}${accountId}/deployments/${plan.selected.model.deployment}?api-version=2025-06-01`,
        ),
      ).properties,
    );
    const chosen = obj(current.model);
    if (
      chosen.name !== plan.selected.model.name ||
      chosen.version !== plan.selected.model.version ||
      current.versionUpgradeOption !== "NoAutoUpgrade"
    )
      throw new Error("model_pin");
  }
  if (!options.verifyOnly && previousVersion !== version) {
    const app = await call(appUrl);
    if (!app)
      await call(appUrl, "PUT", {
        properties: { displayName: plan.agentName, agents: [{ agentName: plan.agentName }] },
      });
    else if (
      !list(obj(obj(app).properties).agents).some((a) => obj(a).agentName === plan.agentName)
    )
      throw new Error("application_agent_mismatch");
    await call(deploymentUrl, "PUT", {
      properties: {
        displayName: "Customer-controlled release",
        deploymentType: "Managed",
        protocols: [{ protocol: "Responses", version: "1.0" }],
        agents: [{ agentName: plan.agentName, agentVersion: version }],
      },
    });
  }
  let confirmed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const raw = await call(deploymentUrl);
    if (raw) {
      const deployed = obj(obj(raw).properties);
      const agents = list(deployed.agents);
      if (["Failed", "Canceled"].includes(String(deployed.provisioningState)))
        throw new Error("deployment_failed");
      if (
        agents.length === 1 &&
        obj(agents[0]).agentName === plan.agentName &&
        obj(agents[0]).agentVersion === version &&
        deployed.provisioningState === "Succeeded" &&
        deployed.state === "Running"
      ) {
        confirmed = true;
        break;
      }
    }
    await (options.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(2000);
  }
  if (!confirmed)
    throw new Error(
      "deployment_pending: inspect the existing deployment and rerun verification; no new version is needed",
    );
  return {
    format: "impact-azure-release/v1",
    state: "deployed",
    environment: plan.environment,
    bundleDigest: plan.bundleDigest,
    sourceDigest: plan.sourceDigest,
    sourceCommit: options.sourceCommit,
    releaseId: plan.releaseId,
    projectId: plan.selected.projectId,
    agentName: plan.agentName,
    agentVersion: version,
    applicationId: appId,
    endpoint: `${plan.selected.endpoint}/applications/${plan.agentName}/protocols/openai/responses?api-version=2025-11-15-preview`,
    previousVersion,
    limits: plan.limits,
    ...(plan.knowledge ? { knowledge: plan.knowledge } : {}),
    ...(checkReport ? { checks: checkReport } : {}),
  };
}

/**
 * The model the deployment serves right now, `name-version`, read the way `runRelease` reads it. The check run reports
 * this: what the starter saw before its first check, so a model that moved is named, not assumed to be the pinned one.
 */
export async function readDeployedModel(plan: ReleasePlan, call: ProviderCall) {
  const accountId = plan.selected.projectId.slice(
    0,
    plan.selected.projectId.lastIndexOf("/projects/"),
  );
  const properties = obj(
    obj(
      await call(
        `${ARM}${accountId}/deployments/${plan.selected.model.deployment}?api-version=2025-06-01`,
      ),
    ).properties,
  );
  const served = obj(properties.model);
  return `${str(served.name)}-${str(served.version)}`;
}

/**
 * `runRelease` with the Development check run reported (I-054): the plan reaches impact.ai, awaited, before `runRelease`
 * makes its first provider call and so before any model call; each check's result follows as it finishes; the run's end
 * is told once, from what the release came to. Without a reporter this is `runRelease`. Nothing it says to impact.ai can
 * stop or change the release; it prints codes only.
 */
export async function runReportedRelease(
  plan: ReleasePlan,
  call: ProviderCall,
  options: Parameters<typeof runRelease>[2],
  reporter?: CheckRunReporter,
  write: (line: string) => unknown = (line) => process.stdout.write(line),
): Promise<Receipt> {
  if (!reporter) return runRelease(plan, call, options);
  const { runEndOf, watchCancellation } = await import("./report.ts");
  // The signals are taken over before the plan goes out: a cancel at any point from here says so and stops the release at
  // its next request, instead of Node's default kill that would leave the run reading as running until its deadline.
  let cancelled = false;
  const stopWatching =
    reporter.setup === "reporting"
      ? watchCancellation(reporter, {
          onCancel: () => {
            cancelled = true;
          },
        })
      : () => {};
  try {
    const planned = await reporter.planned();
    if (!["not_applicable", "not_configured", "no_run_identity"].includes(planned))
      write(`Check run report: ${planned}.\n`);
    if (planned !== "accepted") {
      // Nothing was reported, so there is nothing to say on a cancel: the release is exactly what it was without a reporter.
      stopWatching();
      return await runRelease(plan, call, options);
    }
    // After a cancel nothing more is asked of the model, the deployment or the version store, whatever step is next.
    const stopped = () => {
      if (cancelled) throw new Error("run_cancelled");
    };
    const guarded: ProviderCall = (url, method, body) => {
      stopped();
      return call(url, method, body);
    };
    const { sendReplay } = options;
    try {
      const receipt = await runRelease(plan, guarded, {
        ...options,
        ...(sendReplay
          ? {
              sendReplay: (body: unknown, remainingMs: number) => {
                stopped();
                return sendReplay(body, remainingMs);
              },
            }
          : {}),
        onCheckResult: async (result, check, version) => {
          await reporter.case(result, check, version);
          await options.onCheckResult?.(result, check, version);
        },
      });
      await reporter.ended("passed", null, receipt.agentVersion);
      return receipt;
    } catch (error) {
      const { state, reason } = runEndOf(safeDiagnostic(error));
      await reporter.ended(state, reason);
      throw error;
    }
  } finally {
    stopWatching();
  }
}

export function azureClient(
  plan: ReleasePlan,
  getToken: (audience: string) => string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 60_000,
): ProviderCall {
  const allowed = [new URL(plan.selected.endpoint).origin, ARM];
  return async (url, method = "GET", body) => {
    const parsed = new URL(url);
    if (!allowed.includes(parsed.origin) || parsed.username || parsed.password || parsed.hash)
      throw new Error("provider_origin");
    const token = getToken(parsed.origin === ARM ? ARM : "https://ai.azure.com");
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(method === "GET" ? "provider_read_failed" : "provider_write_unknown");
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok)
      throw new Error(
        `provider_${response.status}${method !== "GET" && response.status >= 500 ? "_write_unknown" : ""}`,
      );
    // Never echo provider payloads, tokens, instructions or customer data to workflow logs.
    try {
      return await response.json();
    } catch {
      throw new Error("provider_response_unknown");
    }
  };
}
export async function readBundle(root: string) {
  const files: Record<string, string> = {};
  async function read(path: string) {
    const stat = await lstat(resolve(root, path));
    if (stat.isSymbolicLink()) throw new Error("bundle_symlink");
    if (stat.isDirectory()) {
      for (const name of await readdir(resolve(root, path))) await read(`${path}/${name}`);
    } else {
      if (stat.size > 2 * 1024 * 1024) throw new Error("bundle_size");
      files[path] = await readFile(resolve(root, path), "utf8");
    }
    if (Object.keys(files).length > 12) throw new Error("bundle_size");
  }
  await read("agent");
  return files;
}

/**
 * The one controlled agent call, shared by qualification and the production wrapper (`invoke.ts`): checks the receipt,
 * reads the live deployment, then makes one responses call to the endpoint derived from validated project bindings.
 * `onAttempt` runs just before the call, so a caller can tell a failed attempt from a refusal made before it.
 */
export async function callAgent(
  plan: ReleasePlan,
  receipt: Receipt,
  input: string,
  getToken: (audience: string) => string,
  fetcher: typeof fetch = fetch,
  onAttempt?: (startedAtMs: number) => void,
) {
  if (
    receipt.bundleDigest !== plan.bundleDigest ||
    receipt.projectId !== plan.selected.projectId ||
    receipt.agentName !== plan.agentName ||
    !versionPattern.test(receipt.agentVersion) ||
    receipt.state !== "deployed"
  )
    throw new Error("qualification_receipt");
  if (!input.trim() || input.length > 16_000) throw new Error("qualification_input");
  const call = azureClient(plan, getToken, fetcher, plan.limits.secondsPerTurn * 1000);
  const deployment = obj(
    obj(
      await call(
        `${ARM}${plan.selected.projectId}/applications/${plan.agentName}/agentdeployments/live?api-version=${ARM_API}`,
      ),
    ).properties,
  );
  const agents = list(deployment.agents);
  if (
    agents.length !== 1 ||
    obj(agents[0]).agentName !== plan.agentName ||
    obj(agents[0]).agentVersion !== receipt.agentVersion ||
    deployment.state !== "Running"
  )
    throw new Error("qualification_version_changed");
  // Ignore any URL from a supplied receipt: derive the endpoint from validated project bindings.
  const endpoint = `${plan.selected.endpoint}/applications/${plan.agentName}/protocols/openai/responses?api-version=2025-11-15-preview`;
  const startedAtMs = Date.now();
  onAttempt?.(startedAtMs);
  const response = obj(
    await call(endpoint, "POST", {
      input: [{ role: "user", content: input }],
      max_output_tokens: plan.limits.tokens,
      store: true,
      metadata: {
        impact_source: plan.sourceDigest,
        impact_release: plan.releaseId,
        impact_bundle: plan.bundleDigest,
        impact_agent_version: receipt.agentVersion,
        impact_environment: plan.environment,
        impact_project: plan.selected.projectId,
        impact_agent_name: plan.agentName,
      },
    }),
  );
  const endedAtMs = Date.now();
  return { response, startedAtMs, endedAtMs };
}

/** One explicit qualification interaction; never runs automatically during release. */
export async function invokeQualification(
  plan: ReleasePlan,
  receipt: Receipt,
  input: string,
  getToken: (audience: string) => string,
  fetcher: typeof fetch = fetch,
  observation?: ObservationConfig,
) {
  const { response, startedAtMs, endedAtMs } = await callAgent(
    plan,
    receipt,
    input,
    getToken,
    fetcher,
  );
  const id = str(response.id, /^[A-Za-z0-9_-]+$/u);
  let traceExport: Awaited<ReturnType<typeof import("./observe.js").exportInvocation>> | undefined;
  if (observation) {
    const { exportInvocation } = await import("./observe.ts");
    traceExport = await exportInvocation(
      {
        agentName: plan.agentName,
        agentVersion: receipt.agentVersion,
        releaseId: plan.releaseId,
        sourceDigest: plan.sourceDigest,
        bundleDigest: plan.bundleDigest,
        environment: plan.environment,
        projectId: plan.selected.projectId,
        responseId: id,
        completed: response.status === "completed",
        startedAtMs,
        endedAtMs,
      },
      observation,
      fetcher,
    );
  }
  // Keep prompts, answers and tool payloads out of workflow artifacts. Review rules in the authorized trace store.
  return {
    responseId: id,
    releaseId: plan.releaseId,
    sourceDigest: plan.sourceDigest,
    environment: plan.environment,
    projectId: plan.selected.projectId,
    agentName: plan.agentName,
    status: str(response.status),
    agentVersion: receipt.agentVersion,
    bundleDigest: receipt.bundleDigest,
    rules: "not_evaluated",
    trace: "must_be_confirmed_in_customer_store",
    traceExport: traceExport ?? { state: "not_configured" },
  };
}

export async function loadPrivateBundle(
  plan: ReleasePlan,
  container: string,
  getToken: (audience: string) => string,
  fetcher: typeof fetch = fetch,
): Promise<PrivateBundle> {
  if (
    !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/release-inputs$/u.test(container) ||
    !plan.checks ||
    !plan.knowledge?.replay
  )
    throw new Error("private_bundle_container");
  const receipt = plan.knowledge.replay;
  const url = new URL(receipt.blobUrl);
  if (
    `${url.origin}${url.pathname}` !== `${container}/${plan.releaseId}.json` ||
    [...url.searchParams.keys()].join() !== "versionid" ||
    !url.searchParams.get("versionid") ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("private_bundle_origin");
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${getToken("https://storage.azure.com")}`,
      "x-ms-version": "2023-11-03",
      "x-ms-date": new Date().toUTCString(),
    },
  });
  if (!response.ok || Number(response.headers.get("content-length") ?? "0") > 16 * 1024 * 1024)
    throw new Error("private_bundle_unavailable");
  const body = await response.text();
  if (Buffer.byteLength(body) > 16 * 1024 * 1024 || hash(body) !== receipt.sha256)
    throw new Error("private_bundle_hash");
  const { validatePrivateBundle } = await import("./checks.ts");
  const bundle = validatePrivateBundle(JSON.parse(body), {
    ...plan.checks,
    releaseId: plan.releaseId,
    sourceDigest: plan.sourceDigest,
  });
  if (
    bundle.documents.length !== plan.knowledge.documentCount ||
    hash(JSON.stringify(bundle.documents.map(({ name, sha256 }) => ({ name, sha256 })))) !==
      plan.knowledge.documentsDigest
  )
    throw new Error("private_bundle_documents");
  return bundle;
}
async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!key?.startsWith("--") || !value || args.has(key)) throw new Error("arguments");
    args.set(key, value);
  }
  const environment = args.get("--environment");
  if (environment !== "development" && environment !== "production")
    throw new Error("environment_required");
  const action = args.get("--action") ?? "deploy";
  let knowledgeInput: unknown = process.env.IMPACT_KNOWLEDGE_RECEIPT
    ? JSON.parse(process.env.IMPACT_KNOWLEDGE_RECEIPT)
    : undefined;
  const priorReceiptPath =
    args.get("--knowledge-receipt") ??
    (action === "qualify" ? (args.get("--receipt") ?? "receipt.json") : undefined);
  if (priorReceiptPath) {
    const prior = obj(JSON.parse(await readFile(priorReceiptPath, "utf8")));
    knowledgeInput = prior.format === "impact-azure-release/v1" ? prior.knowledge : prior;
  }
  const plan = prepareRelease(
    await readBundle(args.get("--bundle") ?? "."),
    environment,
    knowledgeInput,
  );
  if (args.has("--expected-digest") && args.get("--expected-digest") !== plan.bundleDigest)
    throw new Error("bundle_digest");
  if (action === "inspect") {
    process.stdout.write(
      `${JSON.stringify({ bundleDigest: plan.bundleDigest, environment, sourceDigest: plan.sourceDigest, agentName: plan.agentName })}\n`,
    );
    return;
  }
  if (!["deploy", "verify", "rollback", "qualify"].includes(action)) throw new Error("action");
  const receiptPath = args.get("--promotion-receipt");
  const promotionReceipt = receiptPath
    ? (JSON.parse(await readFile(receiptPath, "utf8")) as Receipt)
    : undefined;
  const getToken = (audience: string) =>
    execFileSync(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        audience,
        "--query",
        "accessToken",
        "-o",
        "tsv",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  if (action === "qualify") {
    const prior = JSON.parse(
      await readFile(args.get("--receipt") ?? "receipt.json", "utf8"),
    ) as Receipt;
    const input = await readFile(args.get("--input-file") ?? "qualification-input.txt", "utf8");
    const observeEndpoint = process.env.IMPACT_OTLP_TRACES_ENDPOINT;
    const observeKey = process.env.IMPACT_PRODUCT_KEY;
    const evidence = await invokeQualification(
      plan,
      prior,
      input,
      getToken,
      fetch,
      observeEndpoint || observeKey
        ? { endpoint: observeEndpoint ?? "", productKey: observeKey ?? "" }
        : undefined,
    );
    await writeFile(
      args.get("--evidence") ?? "qualification.json",
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(
      "Qualification response recorded. Confirm its trace and rules separately.\n",
    );
    return;
  }
  const call = azureClient(plan, getToken);
  const outputPath = args.get("--receipt") ?? "receipt.json";
  const privateBundle = plan.checks
    ? await loadPrivateBundle(plan, process.env.IMPACT_REPLAY_CONTAINER_URL ?? "", getToken)
    : undefined;
  const { reconcileOnly, phaseRecord } = await import("./phase.ts");
  let previousPhase: unknown;
  try {
    previousPhase = JSON.parse(
      await readFile(process.env.IMPACT_PREVIOUS_PHASE ?? "previous-phase/phase.json", "utf8"),
    );
  } catch {
    /* Missing state is uncertain. */
  }
  const resumeOnly = reconcileOnly(Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"), previousPhase, {
    runId: process.env.GITHUB_RUN_ID ?? "local",
    workflowCommit: process.env.GITHUB_SHA ?? "local",
  });
  // The Development check run is reported only by a deploy that runs checks, and only with both of its settings.
  const reporter =
    environment === "development" && action === "deploy" && plan.checks
      ? (await import("./report.ts")).createCheckRunReporter({
          plan,
          env: process.env,
          readModel: () => readDeployedModel(plan, call),
        })
      : undefined;
  const receipt = await runReportedRelease(
    plan,
    call,
    {
      sourceCommit: args.get("--source-commit") ?? "",
      promotionReceipt,
      ...(action === "rollback" ? { rollbackVersion: args.get("--version") ?? "" } : {}),
      verifyOnly: action === "verify",
      resumeOnly,
      privateBundle,
      sendReplay: (body, remainingMs) =>
        azureClient(
          plan,
          getToken,
          fetch,
          remainingMs,
        )(`${plan.selected.endpoint}/openai/v1/responses`, "POST", body),
      recordChecks: (report) =>
        writeFile(
          resolve(dirname(outputPath), "checks-evidence.json"),
          `${JSON.stringify(report, null, 2)}\n`,
          { mode: 0o600 },
        ),
      recordPhase: (phase) =>
        writeFile(
          resolve(dirname(outputPath), "phase.json"),
          `${JSON.stringify(phaseRecord(phase))}\n`,
          { mode: 0o600 },
        ),
    },
    reporter,
  );
  await writeFile(
    args.get("--receipt") ?? "receipt.json",
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `Verified ${environment} deployment: ${receipt.agentVersion}. Receipt saved. No interaction or customer outcome is proven.\n`,
  );
}
export function safeDiagnostic(error: unknown): string {
  if (!(error instanceof Error) || error instanceof SyntaxError) return "release_failed";
  const code = error.message.split(":", 1)[0];
  const known = new Set([
    "invalid_object",
    "invalid_string",
    "invalid_list",
    "environment_required",
    "manifest_format",
    "manifest_paths",
    "draft_number",
    "provider",
    "environment_isolation",
    "project_endpoint",
    "tool_connection",
    "instructions",
    "release_checks_require_execution",
    "check_manifest",
    "check_receipt_mismatch",
    "check_tool_effect",
    "check_bundle_mismatch",
    "check_input",
    "check_ids_mismatch",
    "check_document_hash",
    "check_bundle_size",
    "release_check_finding",
    "release_check_incomplete",
    "private_bundle_container",
    "private_bundle_origin",
    "private_bundle_unavailable",
    "private_bundle_hash",
    "private_bundle_documents",
    "limits",
    "empty_tool_operations",
    "unknown_approval",
    "mcp_url",
    "openapi_approval_or_kind",
    "openapi_server",
    "openapi_operations",
    "unexpected_file",
    "release_source_mismatch",
    "knowledge_receipt_mismatch",
    "knowledge_source_mismatch",
    "knowledge_store_mismatch",
    "knowledge_document_count",
    "unexpected_knowledge_receipt",
    "version_definition_mismatch",
    "duplicate_release_versions",
    "versions_incomplete",
    "promotion_receipt",
    "model_pin",
    "tool_connection_target",
    "file_search_not_ready",
    "rollback_version_missing",
    "release_not_found",
    "version_write_unknown",
    "application_agent_mismatch",
    "deployment_pending",
    "deployment_failed",
    "provider_origin",
    "provider_read_failed",
    "provider_write_unknown",
    "provider_response_unknown",
    "bundle_symlink",
    "bundle_size",
    "arguments",
    "bundle_digest",
    "action",
    "qualification_receipt",
    "qualification_input",
    "qualification_version_changed",
  ]);
  return known.has(code) || /^provider_[1-5][0-9]{2}(_write_unknown)?$/u.test(code)
    ? code
    : "release_failed";
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${safeDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
