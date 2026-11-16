# Customer Azure agent starter

Copy this directory, including its hidden `.github` directory, into the root of the customer's new repository. The customer owns that repository, its protected branches, GitHub environments, Azure subscription and deployment identities. Impact proposes agent-definition and release-pin changes; these workflows perform the provider writes only after customer review. They contain no Impact Azure credential or automatic merge operation.

This implementation has local contract and failure-path tests. The complete template compiled locally without warnings using the official Bicep v0.49.2 Linux x64 compiler, whose SHA-256 was verified against the release asset. **Azure deployment, ARM validation, GitHub environment protections and real traces have not been qualified in this environment.** Run the preflight below on the customer's authorized runner before using the template. A green local test is not a live release or customer outcome. The customer-runtime replay now executes the same bounded I-052 sample/kept-check judges against the exact source and pinned model before deployment. A finding or incomplete result blocks the deployment pin. Rules that have no existing executable judge are not represented as passed; this is bounded sample evidence, not universal rule proof. Missing or incompatible check contracts still fail closed with `release_checks_require_execution`.

## Owner setup

The standard setup creates **two resource groups, accounts, projects, model deployments and customer-owned Storage/Search/Cosmos stores**. It uses public networking with Entra authentication; private networking requires a separately reviewed template. Application Insights/Log Analytics stay in each customer's environment. Review model region/quota, data residency, retention and actual Azure cost before deployment. The budget alert is a notification, not a spending cap.

Search and Cosmos bill whether or not the agent has knowledge: the agent service requires all three stores, a dedicated Search service bills for as long as it exists, and reserved Cosmos throughput bills around the clock. So each environment's Search is **Basic** and its Cosmos thread store **serverless** by default (`searchSku`, `cosmosServerless` in the parameters). Microsoft's own standard-setup template uses Standard S1 Search; choose `standard` when the knowledge outgrows Basic. A Cosmos account cannot change between serverless and reserved throughput after it is created. Neither default has yet been qualified in a real deployment of this template.

1. Create `development` and `production` branches. Protect both against force/direct pushes and require reviewed pull requests. Protect `.github/workflows/**`, `scripts/**` and `infra/**` with a customer code owner. Install the separate Changes App only on this repository; it needs no workflow-write permission.
2. Create GitHub environments named **Development** and **Production**. Permit only the corresponding `development` / `production` branch in each environment's deployment branch rules. Require a customer reviewer for Production, prevent self-review, and restrict bypass. An environment name alone does not restrict the source branch; these settings are necessary because the OIDC subject names the repository and environment.
3. Copy `infra/owner.parameters.example.json` to ignored `infra/owner.parameters.json`. Replace every `CHOOSE_*` / `CUSTOMER_*` / contact placeholder, including an actually available model name, version, deployment SKU/capacity and budget dates. On the customer's authorized machine, sign in/select the intended subscription through the existing Azure CLI setup. The preflight itself never signs in or changes that selection. Run it with the explicitly selected subscription ID, Node 26, Azure CLI 2.76 or later and an installed Bicep compiler:

   ```sh
   node scripts/preflight.ts --subscription YOUR_SUBSCRIPTION_ID --parameters infra/owner.parameters.json --report /PRIVATE_PATH/owner-preflight.json
   ```

   The private report is created with mode `0600` and refuses to overwrite an existing report. It records `checkedAt`, selected account/identity IDs, active subscription-level role permissions (including inherited/group assignments), possible deny assignments, PIM eligibility, template/API prerequisites and a source digest. It omits identity names, email contacts, condition text, tokens and provider error bodies. It is **customer-local CLI evidence, not a server-verified role report**, and has no upload API. `allowed_by_active_roles` is the bounded RBAC assessment; `conditional`, `possible_deny`, `not_granted_by_active_roles` and `unknown` need Owner action. Eligibility never counts as an active role. Role names alone never grant setup.

   If setup rights are absent, activate the required eligible role in the customer's PIM flow, or hand setup to an existing subscription Owner with active rights. Conditional role-assignment grants must permit all required template roles; this script does not guess that a condition permits them. It does not activate PIM, register a provider, install Bicep or assign any role. A `ready_for_arm_validation` report still leaves Azure policy/locks, resource scopes, Lighthouse delegation, selected model availability/quota and GitHub protections unverified. Access can change after the check. `owner_action_required` exits 2; a malformed invocation/report write exits 1 with a safe diagnostic. Read the private report, resolve the named setup capability and rerun with a fresh report path.

   The subscription Owner then runs provider-level validation and what-if. These checks must use `Provider`, not `Template` or `ProviderNoRbac`, to assess deployment permissions. Inspect diagnostics for skipped/unevaluated resources before treating the result as complete:

   ```sh
   az account show --query '{subscription:id,tenant:tenantId}' -o json
   az bicep build --file infra/main.bicep
   az deployment sub validate --subscription YOUR_SUBSCRIPTION_ID --location YOUR_DEPLOYMENT_REGION --template-file infra/main.bicep --parameters @infra/owner.parameters.json --validation-level Provider
   az deployment sub what-if --subscription YOUR_SUBSCRIPTION_ID --location YOUR_DEPLOYMENT_REGION --template-file infra/main.bicep --parameters @infra/owner.parameters.json --validation-level Provider
   az deployment sub create --subscription YOUR_SUBSCRIPTION_ID --name customer-agent-setup --location YOUR_DEPLOYMENT_REGION --template-file infra/main.bicep --parameters @infra/owner.parameters.json
   ```

   Review the subscription shown and the what-if before `create`. Check that the subscription supports the pinned Cognitive Services API versions and the selected regional model quota. A failed validation or denied Owner role is setup waiting for customer action, not a product acceptance failure. Reconcile an unknown ARM deployment using that same deployment name before resubmitting.
4. From the deployment outputs, put `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `IMPACT_REPLAY_CONTAINER_URL` (the matching `privateBundleContainerUrl`) in each GitHub environment's variables. Use that environment's distinct client ID. Bind the exact project ID/endpoint/model tuple in the agent proposal. The runner rejects a different endpoint, model name/version, or upgrade policy.
5. Customer Owner setup gives each pipeline identity **Contributor only on its own resource group and Foundry User only on its own project**. It grants no Owner, User Access Administrator or role-assignment permission to the pipeline. All agent datastore roles are assigned during Owner setup, scoped to the dedicated environment's stores; the project identity has no access to the other environment. Additional downstream API roles and project connections are an explicit Owner task. This is a stricter implementation than allowing the pipeline to delegate an allowlisted set of roles: the pipeline delegates none.
6. Create the explicitly selected OpenAPI/MCP project connections in each project with the exact target URL. Credentials remain in those connections. Where knowledge is used, the customer uploader also needs Foundry User on the project and Storage Blob Data Contributor on its storage account. Owner by itself does not grant blob data-plane access. The release pipeline has Blob Data Reader only on its dedicated `release-inputs` container; it has no blob write data role. This container is private and its storage account has Blob versioning explicitly enabled. Verify both properties and the exact-container role assignment in Azure before qualification.

The template follows Microsoft's linked standard `capabilityHosts` setup profile at `2025-04-01-preview`; it does not mix newer `capabilitySettings` fields into those stores. Model ARM reads/deployments use `2025-06-01`; agent definitions use data-plane `v1`; explicitly pinned Agent Applications use ARM `2026-01-15-preview`. Microsoft currently supports Agent Applications as the legacy publishing model. This starter does not silently migrate an application to the newer automatic agent endpoint, whose identity and routing differ.

## Source documents and their receipt

Every proposal has a public `agent/checks.json` containing only the source/check digest, count and check IDs, plus `agent/release.json` identifying the prepared release. The manifest carries matching `checks.required/digest/count`. Knowledge proposals additionally have `knowledge.required: true` and empty environment `vectorStores`. Download the one-use private bundle from the owning Product flow to the customer's authorized machine; it contains full UTF-8 document text and the pattern/kept replay inputs and sample tool answers. Documentless bundles still carry checks. Do not put it in Git, a workflow artifact, a PR, or logs.

Upload it separately to each environment under the customer's Azure sign-in:

```sh
node scripts/upload-knowledge.ts --bundle /PRIVATE_PATH/knowledge-bundle.json --definition-root . --environment development --receipt /PRIVATE_PATH/knowledge-development.json --private-container https://DEVELOPMENT_STORAGE.blob.core.windows.net/release-inputs
node scripts/upload-knowledge.ts --bundle /PRIVATE_PATH/knowledge-bundle.json --definition-root . --environment production --receipt /PRIVATE_PATH/knowledge-production.json --private-container https://PRODUCTION_STORAGE.blob.core.windows.net/release-inputs
```

The uploader checks every full-text SHA-256 and canonical check digest before sending anything. It publishes the private bundle once to the environment's `release-inputs/<releaseId>.json` with `If-None-Match: *`, requires Azure's `x-ms-version-id`, and records that exact versioned URL and the full-byte SHA-256. For documents it also creates an isolated release vector store, uploads the original UTF-8 bytes, attaches every file and waits for all files to finish; checks-only bundles create no vector store. It saves progress before each write and refuses to overwrite an existing attempt. On an unknown result, retain its private local progress file and reconcile the resource/file IDs in Azure; do not delete the file and blindly repeat the upload. A processed receipt contains no document names or text:

```json
{
  "format": "impact-agent-knowledge-receipt/v1",
  "state": "completed",
  "releaseId": "rel_0123456789abcdef01234567",
  "sourceDigest": "<64 lowercase hex>",
  "environment": "development",
  "projectId": "<exact customer project resource ID>",
  "vectorStoreId": "vs_<provider ID>",
  "documentsDigest": "<64 lowercase hex>",
  "documentCount": 1,
  "replay": {
    "blobUrl": "https://<environment-storage>.blob.core.windows.net/release-inputs/<releaseId>.json?versionid=<exact-version>",
    "sha256": "<SHA-256 of exact private blob bytes>",
    "checksDigest": "<canonical checks digest>",
    "checkCount": 4
  }
}
```

`documentsDigest` is SHA-256 of `JSON.stringify(documents.map(({name,sha256}) => ({name,sha256})))`, preserving bundle order. Set the completed receipt JSON as `IMPACT_KNOWLEDGE_RECEIPT` in the **matching** GitHub environment variable. The runner validates release/source/environment/project, reads only the exact configured container/version using OIDC, verifies the private blob SHA and canonical check digest/public IDs, and checks document-store metadata/counts before using it. Checks-only receipts have `documentCount: 0` and `vectorStoreId: null`. Check digest canonicalization recursively sorts object keys with JavaScript `.sort()`, retains array order, serializes with `JSON.stringify`, and hashes UTF-8 bytes. It preserves the receipt with the release artifact so rollback does not accidentally use the current environment variable. Source-bundle disposal follows the customer retention policy. This helper never deletes the server-side document bytes; the owning Product flow must confirm durable release evidence before its cleanup.

## Development, promotion and rollback

Merge the reviewed `agent/**` proposal into `development`. The Development workflow reads the exact merged files, verifies model `NoAutoUpgrade`, connection targets and processed vector stores, creates an immutable version only for a new bundle, executes the source/version-bound isolated replay, and pins the stable Agent Application deployment only if all required checks pass. It waits for `Succeeded` and `Running`, then retains the source bundle and content-free receipt. This verifies deployment configuration; it does not claim an interaction or business outcome.

Promotion is a reviewed change to `releases/production.json` on the protected `production` branch:

```json
{
  "format": "impact-agent-production/v1",
  "action": "promote",
  "sourceRunId": 123,
  "bundleDigest": "<exact Development receipt digest>",
  "sourceDigest": "<exact source digest>",
  "releaseId": "rel_0123456789abcdef01234567",
  "agentName": "impact-<32 lowercase hex>",
  "agentVersion": "<exact Development version>"
}
```

The owning Product flow can propose this file using a customer-supplied receipt. The workflow independently verifies that the run belongs to this repository, is a successful protected-branch push from the expected workflow, and that every reviewed pin matches its artifact receipt. It executes scripts from the trusted Production branch and treats downloaded artifacts only as data. There is no dispatch input that can override the reviewed pin.

Production has its own project and therefore its own version numbers and tool/knowledge bindings. Promotion binds the exact reviewed Development version and source bundle; it then creates/reuses the corresponding immutable Production version and verifies that exact Production deployment. It never requests a floating version alias. To roll back, propose `action: "rollback"` and the pins from a **previous successful Production** run/receipt. The runner checks that this exact retained version still exists and matches the retained bundle, then repoints the deployment. It does not rebuild it. Keep rollback artifacts for the required retention period; these workflows retain them for 90 days. An expired artifact or deleted Azure version cannot be presented as a safe rollback target.

An uncertain version POST is not retried in the same run. Every attempt retains a content-free durable phase. A rerun after a proven pre-write failure, such as a model-read 403, may create the version once access is restored. A previous `version_write_started`, confirmed-version phase, missing artifact or mismatched run/commit is reconciliation-only and cannot create a replacement version. The uncertainty is preserved across subsequent reruns. If a provider write is still unresolved, wait and inspect that same run/resource instead of creating another release. Deployment polling is bounded; `deployment_pending` means inspect/rerun the same version, not create another. Authorization failures require the customer to restore the named identity/connection rights; no secret fallback exists.

After retaining the successful deployment receipt and source artifact, each workflow uses its own `GITHUB_TOKEN` with `checks: write` to publish **impact.ai / release confirmed** on that exact workflow commit. Its fenced JSON has format `impact-agent-release-confirmation/v1`, release/source/bundle IDs, environment/project, exact agent name/version, document digest/count and check digest. No private inputs, responses, Blob URLs or keys are included. The Changes reader must independently verify the GitHub Actions app, expected merged commit and all pins against its retained proposal. This confirmation proves the observed deployment and bounded checks; it does not claim trace ingestion. A confirmation failure leaves the Azure deployment intact; reconcile that run rather than assume the deployment failed or delete source knowledge.

## Live qualification

After deployment, download the source bundle and its receipt to an authorized customer machine, use the matching project sign-in, and supply a synthetic prompt that is safe for the selected tools:

```sh
node scripts/release.ts --environment development --bundle ./bundle --action qualify --receipt ./bundle/receipt.json --input-file /PRIVATE_PATH/qualification-input.txt --evidence /PRIVATE_PATH/qualification.json
```

This entry point first checks the exact deployed version, then performs **one real interaction**. It applies `max_output_tokens` and a client request deadline, and attaches release/source/version identifiers in response metadata. A timeout stops waiting; it does **not** prove server cancellation or undo tool effects. Reconcile the response before retrying. It does not automatically approve an MCP call. `customer` approvals remain instruction/chat behavior, `over_amount` remains enforced by the customer's API, and `every_call` is represented in MCP's per-tool native approval policy. Native OpenAPI every-call approval is refused rather than dropped.

Inspect the resulting response in the authorized customer trace store. Confirm the source/release/version identifiers, selected-tool and file-search behavior, no unintended side effect, and the rule examples in `agent/rules.json`. The helper emits only response ID/status and references; it explicitly records rules as `not_evaluated` and trace confirmation as pending. Native prompt-agent definitions do not enforce the supplied per-turn token/time limits or evaluate arbitrary rule text. Every real caller must apply the same invocation controls; direct endpoint access can bypass this client helper. The automatic release checks are a separate operation: the runner verifies the candidate's immutable definition, then uses the same pinned model and compiled instructions with local function proposals answered solely from I-052 labelled sample data. It does not invoke candidate MCP/OpenAPI tools or approve calls. It keeps the existing seven deterministic judges, maximum four model calls and twelve turns per check, and the existing document-context bound; provider errors, unexpected output, time/token bounds and missing evidence are incomplete, never pass. It rechecks the model pin before changing the deployment. The content-free `checks-evidence.json` records source/bundle/check digests, candidate version, each check's judgment and response IDs under profile `isolated_i052_sample_replay`, with `nativeToolsVerified: false`. Private prompts, documents, answers and tool payloads remain out of GitHub artifacts and logs.

To observe that real qualification invocation in Impact, opt in with **both** `IMPACT_OTLP_TRACES_ENDPOINT` (the existing Product key setup's HTTPS trace endpoint ending in `/v1/traces`) and `IMPACT_PRODUCT_KEY` (an existing key scoped to the intended Product with `telemetry:ingest`). Supply the key through the customer's local secret manager or a protected GitHub environment secret when explicitly running qualification; never put it in a variable, command argument, proposal or artifact. This setup creates no key or resource and grants no Azure authority. The reader derives Product scope from that key, not from trace attributes.

After receiving the real Azure response, qualification exports one OTLP/HTTP JSON client span with `gen_ai.agent.id`, `gen_ai.agent.version`, `impact.release.id`, `impact.release.source_digest`, `impact.release.bundle_digest`, `deployment.environment.name` and `azure.project.id`. It includes the response ID and profile `azure_qualification_invocation_boundary`, but no message, prompt, answer or tool payload. This is an invocation-boundary observation; it does not expose native internal tool spans. Application Insights has no automatic import into Impact. No invocation or export is retried by this helper. The private qualification receipt separates the Azure response from `traceExport`: `not_configured`, `invalid_configuration`, `refused`, `unknown` or `accepted_pending_readback`, with trace/span IDs when attempted. An accepted export still needs authenticated readback in the intended Product before claiming the trace was seen. Export failure never converts a completed invocation into failure and must not trigger another live interaction. A failed/uncertain Azure call produces no successful invocation evidence; reconcile the provider response before trying again.

### Development check run

The Development workflow's release step reads the same two settings (the variable and the Development environment secret) and, when both are set and the step runs as a GitHub job, reports its saved checks as content-free spans under profile `azure_development_checks`: one **planned** span (how many checks, their ids in plan order and the job's deadline, exported and awaited before the first model call), one span per check as it finishes (id, content digest, judges, which of them found something, `passed`, `finding` or `incomplete`, a reason code) and one **ended** span (passed, finding, incomplete or stopped, with a code; a cancelled job says `cancelled`). Every span names the run and attempt, the judges' method, the checks' digest and the model deployment as read before the first check. No message, answer, document or key is in them, and an export that fails is counted and never stops the release; a runner that dies sends no end, which impact.ai reads as interrupted. Without both settings nothing is sent.

### Production calls

Route real traffic through `scripts/invoke.ts`: `createAzureInvoker({ plan, receipt, getToken }).invoke(message)` makes the same controlled call as qualification (receipt check, exact live version, derived endpoint, `max_output_tokens`, deadline) and emits **exactly one** content-free span per attempted call, including a failed call (status 2). A refusal made before any call (bad receipt, empty input, version moved) emits none. The span carries the same release stamp as above under profile `azure_invocation_boundary`, and no message, answer, tool payload, user or session identifier.

The runtime reads `IMPACT_OTLP_TRACES_ENDPOINT` and `IMPACT_PRODUCT_KEY` from its environment, both or neither. Set the endpoint (variable) in your runtime's configuration and store the key (secret) in your runtime's own secret store when the key is shown, once, as well as in the GitHub `Production` environment secret: GitHub cannot show a secret again, so it cannot be copied from there later. Production has its own key, separate from Development's, and revoking one does not affect the other; the Production release workflow only warns when either is missing and never sends a span. The export is not awaited by the call, has a 3 second deadline, and its errors are swallowed and counted (`invoker.counts`); a serverless handler should `await invoker.flush()` before returning. Calls that bypass `invoke.ts`, such as a direct Foundry request, emit no span, and Application Insights is not imported. An accepted export still needs readback in the intended Product, and real traces remain unqualified.

This preserves the saved-check behavior from I-052. It does not claim native-tool conformance, universal evaluation of every natural-language rule label, or a customer business outcome. Those claims require their distinct evidence. I-054 comparisons remain separate.

Run this same qualification after Production promotion and rollback, using that environment's retained bundle/receipt. Verify that an unapproved Production change and a Development identity cannot change Production. Only these observed customer-account results can close live acceptance; local synthetic tests and ARM configuration receipts cannot.

## Primary sources

Reviewed 2026-11-11. Follow the API versions above; source changes require requalification.

- [Exact project capability-host schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.cognitiveservices/2025-04-01-preview/accounts/projects/capabilityhosts) and [Bicep v0.49.2 release](https://github.com/Azure/bicep/releases/tag/v0.49.2).
- [Standard environment setup](https://learn.microsoft.com/en-us/azure/foundry/agents/environment-setup) and [Microsoft's linked standard Bicep modules](https://github.com/microsoft-foundry/foundry-samples/tree/main/infrastructure/infrastructure-setup-bicep/43-standard-agent-setup-with-customization).
- [Foundry data-plane REST contract](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/aiproject), [OpenAPI tools](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/openapi), [MCP tools](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol), and [file search/upload](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/file-search).
- [Model version/upgrade controls](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/working-with-models), [Agent Application publishing](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/agent-applications), [ARM deployment contract](https://learn.microsoft.com/en-us/rest/api/microsoftfoundry/accountmanagement/agent-deployments/create-or-update?view=rest-microsoftfoundry-accountmanagement-2026-01-15-preview), and [supported legacy/new endpoint distinction](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-agent-applications).
- [GitHub OIDC login to Azure](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).
- [GitHub check-run publication contract](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#create-a-check-run). Trace export uses the existing Monorepo Product-key `telemetry:ingest` and OTLP/HTTP `/v1/traces` contracts.
- [Scoped and transitive role-assignment reads](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest), [conditional role grants](https://learn.microsoft.com/en-us/azure/role-based-access-control/conditions-authorization-actions-attributes), [deny-assignment reads](https://learn.microsoft.com/en-us/rest/api/authorization/deny-assignments/list-for-scope?view=rest-authorization-2022-04-01), [PIM eligibility reads](https://learn.microsoft.com/en-us/rest/api/authorization/role-eligibility-schedule-instances/list-for-scope?view=rest-authorization-2020-10-01), and [Provider-level what-if and its limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-what-if).

The private-input storage protocol uses [Put Blob version response](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob), [versioned Get Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob), and [container-scoped Blob Data Reader](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage#storage-blob-data-reader). The isolated replay deliberately avoids assuming stored-agent tool overrides; the [Foundry integration contract](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/foundry) makes stored agent tools authoritative.
