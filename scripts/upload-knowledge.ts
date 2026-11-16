/** Local customer upload only. Never copy this bundle into Git or workflow artifacts. Node 26, no dependencies. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SavedCheck } from "./checks.js";
import type { KnowledgeReceipt } from "./release.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export interface KnowledgeBundle {
  format: "impact-agent-knowledge/v1";
  sourceDigest: string;
  releaseId: string;
  documents: { name: string; text: string; sha256: string }[];
  checks?: SavedCheck[];
}
export function validateKnowledge(
  input: unknown,
  marker: { sourceDigest: string; releaseId: string },
): KnowledgeBundle {
  const bundle = input as KnowledgeBundle;
  if (
    bundle?.format !== "impact-agent-knowledge/v1" ||
    !/^[0-9a-f]{64}$/u.test(bundle.sourceDigest) ||
    !/^rel_[0-9a-f]{24}$/u.test(bundle.releaseId) ||
    bundle.sourceDigest !== marker.sourceDigest ||
    bundle.releaseId !== marker.releaseId ||
    !Array.isArray(bundle.documents) ||
    (bundle.documents.length < 1 && (!Array.isArray(bundle.checks) || bundle.checks.length < 1)) ||
    bundle.documents.length > 100
  )
    throw new Error("knowledge_identity");
  const names = new Set<string>();
  let bytes = 0;
  for (const document of bundle.documents) {
    if (
      !document ||
      typeof document.name !== "string" ||
      !document.name.trim() ||
      document.name.length > 200 ||
      names.has(document.name) ||
      typeof document.text !== "string" ||
      !document.text.trim() ||
      typeof document.sha256 !== "string" ||
      hash(document.text) !== document.sha256
    )
      throw new Error("knowledge_document");
    names.add(document.name);
    bytes += Buffer.byteLength(document.text, "utf8");
  }
  if (bytes > 10 * 1024 * 1024) throw new Error("knowledge_size");
  return bundle;
}
export async function uploadKnowledge(
  bundle: KnowledgeBundle,
  environment: "development" | "production",
  binding: { endpoint: string; projectId: string },
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
  save: (value: unknown) => Promise<void>,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  publishPrivate?: (body: string) => Promise<NonNullable<KnowledgeReceipt["replay"]>>,
): Promise<KnowledgeReceipt> {
  const documentsDigest = hash(
    JSON.stringify(bundle.documents.map(({ name, sha256 }) => ({ name, sha256 }))),
  );
  const base = {
    format: "impact-agent-knowledge-receipt/v1" as const,
    releaseId: bundle.releaseId,
    sourceDigest: bundle.sourceDigest,
    environment,
    projectId: binding.projectId,
    documentsDigest,
    documentCount: bundle.documents.length,
  };
  const progress: Record<string, unknown> = { ...base, state: "creating_store", fileIds: [] };
  await save(progress); // Persist intent BEFORE every non-idempotent write, with no private document content.
  let replay: KnowledgeReceipt["replay"];
  if (bundle.checks?.length) {
    if (!publishPrivate) throw new Error("private_bundle_publisher_missing");
    progress.state = "publishing_private_input";
    await save(progress);
    replay = await publishPrivate(JSON.stringify(bundle));
    progress.replay = replay;
    await save(progress);
  }
  if (!bundle.documents.length) {
    const receipt: KnowledgeReceipt = {
      ...base,
      state: "completed",
      vectorStoreId: null,
      ...(replay ? { replay } : {}),
    };
    await save(receipt);
    return receipt;
  }
  const store = (await request("vector_stores", "POST", {
    name: `release-${bundle.releaseId}`,
    metadata: {
      impact_release: bundle.releaseId,
      impact_source: bundle.sourceDigest,
      impact_documents: documentsDigest,
    },
  })) as { id?: string };
  if (!/^vs_[A-Za-z0-9_-]+$/u.test(store?.id ?? "")) throw new Error("knowledge_provider_response");
  progress.vectorStoreId = store.id;
  const fileIds: string[] = [];
  for (const [index, doc] of bundle.documents.entries()) {
    progress.state = "uploading_file";
    progress.documentIndex = index;
    await save(progress);
    const form = new FormData();
    form.set("purpose", "assistants");
    form.set(
      "file",
      new Blob([doc.text], { type: "text/plain;charset=utf-8" }),
      `document-${index}-${doc.sha256}.txt`,
    );
    const file = (await request("files", "POST", form)) as { id?: string };
    if (!/^file[-_][A-Za-z0-9_-]+$/u.test(file?.id ?? ""))
      throw new Error("knowledge_provider_response");
    fileIds.push(file.id!);
    progress.fileIds = [...fileIds];
    progress.state = "attaching_file";
    await save(progress);
    await request(`vector_stores/${store.id}/files`, "POST", { file_id: file.id });
  }
  progress.state = "processing";
  await save(progress);
  for (let i = 0; i < 120; i++) {
    const result = (await request(`vector_stores/${store.id}`)) as {
      status?: string;
      file_counts?: {
        completed?: number;
        failed?: number;
        cancelled?: number;
        total?: number;
        in_progress?: number;
      };
    };
    if (result.file_counts?.failed || result.file_counts?.cancelled || result.status === "expired")
      throw new Error("knowledge_processing_failed");
    if (
      result.status === "completed" &&
      result.file_counts?.completed === bundle.documents.length &&
      result.file_counts.total === bundle.documents.length &&
      result.file_counts.in_progress === 0
    ) {
      const receipt: KnowledgeReceipt = {
        ...base,
        state: "completed",
        vectorStoreId: store.id!,
        ...(replay ? { replay } : {}),
      };
      await save(receipt);
      return receipt;
    }
    await wait(2000);
  }
  throw new Error("knowledge_processing_pending");
}
export async function publishPrivateBundle(
  container: string,
  bundle: KnowledgeBundle,
  getToken: () => string,
  fetcher: typeof fetch = fetch,
): Promise<NonNullable<KnowledgeReceipt["replay"]>> {
  if (!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/release-inputs$/u.test(container))
    throw new Error("private_bundle_container");
  const { checksDigest } = await import("./checks.ts");
  if (
    !/^rel_[0-9a-f]{24}$/u.test(bundle.releaseId) ||
    !Array.isArray(bundle.checks) ||
    !bundle.checks.length
  )
    throw new Error("private_bundle_identity");
  const body = JSON.stringify(bundle);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("private_bundle_size");
  const url = `${container}/${bundle.releaseId}.json`;
  const response = await fetcher(url, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "x-ms-version": "2023-11-03",
      "x-ms-date": new Date().toUTCString(),
      "x-ms-blob-type": "BlockBlob",
      "If-None-Match": "*",
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw new Error("private_bundle_write_unknown");
  const version = response.headers.get("x-ms-version-id");
  if (!version) throw new Error("private_bundle_version_missing");
  return {
    blobUrl: `${url}?versionid=${encodeURIComponent(version)}`,
    sha256: hash(body),
    checksDigest: checksDigest(bundle.checks),
    checkCount: bundle.checks!.length,
  };
}
async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!key?.startsWith("--") || !value) throw new Error("arguments");
    args.set(key, value);
  }
  const environment = args.get("--environment");
  if (environment !== "development" && environment !== "production")
    throw new Error("environment_required");
  const root = args.get("--definition-root") ?? ".";
  const manifest = JSON.parse(await readFile(resolve(root, "agent/agent.json"), "utf8"));
  const marker = JSON.parse(await readFile(resolve(root, "agent/release.json"), "utf8"));
  if (manifest.source.digest !== marker.sourceDigest || manifest.checks?.required !== true)
    throw new Error("knowledge_identity");
  const bundle = validateKnowledge(
    JSON.parse(await readFile(args.get("--bundle") ?? "knowledge-bundle.json", "utf8")),
    marker,
  );
  const publicChecks = JSON.parse(await readFile(resolve(root, "agent/checks.json"), "utf8"));
  const { validatePrivateBundle } = await import("./checks.ts");
  validatePrivateBundle(bundle, {
    releaseId: marker.releaseId,
    sourceDigest: marker.sourceDigest,
    digest: manifest.checks.digest,
    count: manifest.checks.count,
    ids: publicChecks.ids,
  });
  const binding = manifest.target[environment];
  if (
    !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[a-z0-9-]+\/projects\/[A-Za-z0-9._-]+$/u.test(
      binding.projectId,
    )
  )
    throw new Error("project_id");
  const parts = binding.projectId.split("/");
  const endpoint = `https://${parts[8]}.services.ai.azure.com/api/projects/${parts[10]}`;
  if (binding.endpoint !== endpoint) throw new Error("project_endpoint");
  const path = args.get("--receipt") ?? `knowledge-${environment}.json`;
  // Never overwrite a previous/uncertain attempt. Keep it for customer-side reconciliation.
  await writeFile(path, "{}\n", { flag: "wx", mode: 0o600 });
  const request = async (resource: string, method = "GET", body?: unknown) => {
    const token = execFileSync(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        "https://ai.azure.com",
        "--query",
        "accessToken",
        "-o",
        "tsv",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const form = body instanceof FormData;
    const response = await fetch(`${endpoint}/openai/v1/${resource}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(form ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("knowledge_provider_failed");
    return response.json();
  };
  await uploadKnowledge(
    bundle,
    environment,
    binding,
    request,
    (value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }),
    undefined,
    () =>
      publishPrivateBundle(args.get("--private-container") ?? "", bundle, () =>
        execFileSync(
          "az",
          [
            "account",
            "get-access-token",
            "--resource",
            "https://storage.azure.com",
            "--query",
            "accessToken",
            "-o",
            "tsv",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim(),
      ),
  );
  process.stdout.write(
    "Knowledge processed. Store only the completed receipt in the matching GitHub environment variable.\n",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write(
      "knowledge_upload_incomplete: retain the local receipt and reconcile the customer Azure resources before any retry. No document content is logged.\n",
    );
    process.exitCode = 1;
  });
