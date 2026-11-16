/** Customer-local, read-only setup assessment. Never signs in, activates a role or deploys resources. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type CliRead = (args: string[]) => Promise<string>;
type Permission = { actions: string[]; notActions: string[]; condition?: unknown };
type ActiveRole = { permissions: Permission[]; conditional: boolean };
type PermissionState =
  | "allowed_by_active_roles"
  | "not_granted_by_active_roles"
  | "conditional"
  | "possible_deny"
  | "unknown";
type Row = Record<string, unknown>;
const ARM = "https://management.azure.com";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("preflight_input");
  return value as Row;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("preflight_input");
  return value;
};
function permissions(value: unknown): Permission[] {
  return array(value).map((raw) => {
    const item = object(raw);
    const actions = array(item.actions);
    const notActions = array(item.notActions ?? []);
    if ([...actions, ...notActions].some((s) => typeof s !== "string" || s.length > 512))
      throw new Error("preflight_permission");
    return {
      actions: actions as string[],
      notActions: notActions as string[],
      condition: item.condition,
    };
  });
}
const matches = (pattern: string, action: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "iu",
  ).test(action);
const permits = (permission: Permission, action: string) => {
  if (!action.endsWith("/*"))
    return (
      permission.actions.some((p) => matches(p, action)) &&
      !permission.notActions.some((p) => matches(p, action))
    );
  // A request for every deployment operation is not a literal '*' action. An exception for even
  // one child operation prevents us from proving the whole required family is granted.
  const root = action.slice(0, -1).toLowerCase();
  return (
    permission.actions.some(
      (p) =>
        p === "*" ||
        (p.endsWith("*") &&
          !p.slice(0, -1).includes("*") &&
          root.startsWith(p.slice(0, -1).toLowerCase())),
    ) &&
    !permission.notActions.some((p) => {
      const excluded = p.split("*")[0].toLowerCase();
      return root.startsWith(excluded) || excluded.startsWith(root);
    })
  );
};
export function assessPermission(
  action: string,
  roles: ActiveRole[],
  denies: Permission[] | undefined,
  complete: boolean,
): PermissionState {
  if (!complete || !denies) return "unknown";
  // Deny principal/group exclusions and condition evaluation remain Azure's authority. Never guess them away.
  if (
    denies.some((p) =>
      action.endsWith("/*")
        ? p.actions.some((pattern) => {
            const root = action.slice(0, -1).toLowerCase();
            const denied = pattern.split("*")[0].toLowerCase();
            return root.startsWith(denied) || denied.startsWith(root);
          })
        : permits(p, action),
    )
  )
    return "possible_deny";
  if (
    roles.some(
      (r) => !r.conditional && r.permissions.some((p) => !p.condition && permits(p, action)),
    )
  )
    return "allowed_by_active_roles";
  if (roles.some((r) => r.permissions.some((p) => permits(p, action)))) return "conditional";
  return "not_granted_by_active_roles";
}
function templateRequirements(templates: string[]) {
  const resources = new Map<string, { namespace: string; type: string; version: string }>();
  for (const text of templates)
    for (const m of text.matchAll(/resource\s+\w+\s+'([^']+)@([^']+)'/gu)) {
      const parts = m[1].split("/");
      resources.set(`${m[1]}@${m[2]}`, {
        namespace: parts[0],
        type: parts.slice(1).join("/"),
        version: m[2],
      });
    }
  if (resources.size < 1) throw new Error("preflight_template");
  return [...resources.values()];
}
function validateParameters(input: unknown) {
  const params = object(object(input).parameters);
  const expected = [
    "prefix",
    "location",
    "githubRepository",
    "modelName",
    "modelVersion",
    "modelDeployment",
    "modelSku",
    "modelCapacity",
    "monthlyBudget",
    "budgetStart",
    "budgetEnd",
    "budgetContactEmails",
  ];
  // Optional, with the template's own defaults: basic Search and a serverless thread store.
  const optional: Record<string, (value: unknown) => boolean> = {
    searchSku: (value) =>
      typeof value === "string" && ["basic", "standard", "standard2", "standard3"].includes(value),
    cosmosServerless: (value) => typeof value === "boolean",
  };
  for (const key of Object.keys(params)) {
    if (expected.includes(key)) continue;
    if (!Object.hasOwn(optional, key) || !optional[key](object(params[key]).value))
      throw new Error("preflight_parameters");
  }
  for (const key of expected) {
    const value = object(params[key]).value;
    if (
      value === undefined ||
      /CHOOSE_|CUSTOMER_|OWNER_BUDGET|chooseprefix/u.test(JSON.stringify(value))
    )
      throw new Error("preflight_parameters");
  }
  const value = (key: string) => object(params[key]).value;
  for (const key of [
    "prefix",
    "location",
    "githubRepository",
    "modelName",
    "modelVersion",
    "modelDeployment",
    "modelSku",
    "budgetStart",
    "budgetEnd",
  ]) {
    if (
      typeof value(key) !== "string" ||
      !String(value(key)).trim() ||
      String(value(key)).length > 512
    )
      throw new Error("preflight_parameters");
  }
  if (
    !/^[a-z][a-z0-9]{2,11}$/u.test(String(value("prefix"))) ||
    !/^[a-z0-9-]{2,60}$/u.test(String(value("location"))) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(value("githubRepository")))
  )
    throw new Error("preflight_parameters");
  for (const key of ["modelCapacity", "monthlyBudget"])
    if (!Number.isSafeInteger(value(key)) || Number(value(key)) < 1)
      throw new Error("preflight_parameters");
  if (!array(value("budgetContactEmails")).length) throw new Error("preflight_parameters");
}
export interface OwnerPreflightReport {
  format: "impact-azure-owner-preflight/v1";
  authority: "customer_local_cli_observation";
  serverVerified: false;
  checkedAt: string;
  state: "owner_action_required" | "ready_for_arm_validation";
  account: {
    selectedSubscriptionId: string;
    matchesSelectedSubscription: boolean;
    state: "unknown" | "enabled" | "unavailable";
    identityKind?: "user" | "servicePrincipal";
    tenantId?: string;
    objectId?: string;
  };
  capabilities: {
    name: string;
    state: PermissionState;
    actions: { action: string; state: PermissionState }[];
  }[];
  activeRoles: { state: "read" | "unknown"; count: number; conditionalCount: number };
  denyAssignments: "read" | "unknown";
  pim: {
    state: "unknown" | "eligible_roles_present" | "no_eligible_roles_returned";
    count: number;
    eligibilityGrantsAccess: false;
  };
  prerequisites: {
    parameters: "valid" | "invalid";
    cli: "supported" | "unknown_or_old";
    bicep: "compiled" | "unavailable_or_invalid";
    providers: {
      namespace: string;
      state: "supported" | "registration_required" | "api_unavailable" | "unknown";
    }[];
  };
  sourceDigest: string;
  armValidation: "not_run";
  remaining: string[];
}
export async function ownerPreflight(
  input: { subscription: string; parameters: unknown; templates: string[]; checkedAt?: string },
  cli: CliRead,
): Promise<OwnerPreflightReport> {
  if (!uuid.test(input.subscription)) throw new Error("preflight_subscription");
  const subscription = input.subscription.toLowerCase();
  const scope = `/subscriptions/${subscription}`;
  const resources = templateRequirements(input.templates);
  const report: OwnerPreflightReport = {
    format: "impact-azure-owner-preflight/v1",
    authority: "customer_local_cli_observation",
    serverVerified: false,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    state: "owner_action_required",
    account: {
      selectedSubscriptionId: subscription,
      matchesSelectedSubscription: false,
      state: "unknown",
    },
    capabilities: [],
    activeRoles: { state: "unknown", count: 0, conditionalCount: 0 },
    denyAssignments: "unknown",
    pim: { state: "unknown", count: 0, eligibilityGrantsAccess: false },
    prerequisites: {
      parameters: "invalid",
      cli: "unknown_or_old",
      bicep: "unavailable_or_invalid",
      providers: [],
    },
    sourceDigest: createHash("sha256")
      .update(JSON.stringify([input.templates, input.parameters]))
      .digest("hex"),
    armValidation: "not_run",
    remaining: [
      "provider_level_arm_validation_and_what_if",
      "policy_locks_child_scopes_and_model_quota",
      "github_protected_branches_environments_and_oidc",
      "authorization_can_change_after_check",
      "lighthouse_delegation_not_in_role_list",
    ],
  };
  try {
    validateParameters(input.parameters);
    report.prerequisites.parameters = "valid";
  } catch {
    /* Never retain private parameter values. */
  }
  const json = async (args: string[]) =>
    JSON.parse(await cli([...args, "--only-show-errors", "--output", "json"])) as unknown;
  const read = async (url: string) => {
    const parsed = new URL(url);
    if (parsed.origin !== ARM || parsed.username || parsed.password || parsed.hash)
      throw new Error("preflight_origin");
    return json(["rest", "--method", "GET", "--url", url, "--subscription", subscription]);
  };
  const list = async (url: string): Promise<unknown[]> => {
    const path = new URL(url).pathname;
    const seen = new Set<string>();
    const rows: unknown[] = [];
    let next: string | undefined = url;
    while (next) {
      if (seen.has(next) || seen.size >= 20 || new URL(next).pathname !== path)
        throw new Error("preflight_pagination");
      seen.add(next);
      const page = object(await read(next));
      rows.push(...array(page.value));
      if (rows.length > 2000) throw new Error("preflight_pagination");
      if (
        page.nextLink !== undefined &&
        page.nextLink !== null &&
        typeof page.nextLink !== "string"
      )
        throw new Error("preflight_pagination");
      next = page.nextLink ? String(page.nextLink) : undefined;
    }
    return rows;
  };
  let user: Row;
  try {
    const account = object(await json(["account", "show"]));
    report.account.matchesSelectedSubscription =
      typeof account.id === "string" && account.id.toLowerCase() === subscription;
    report.account.state =
      account.state === "Enabled" && account.environmentName === "AzureCloud"
        ? "enabled"
        : "unavailable";
    if (!report.account.matchesSelectedSubscription || report.account.state !== "enabled")
      return report;
    if (typeof account.tenantId === "string" && uuid.test(account.tenantId))
      report.account.tenantId = account.tenantId;
    user = object(account.user);
    if (user.type !== "user" && user.type !== "servicePrincipal") return report;
    report.account.identityKind = user.type;
  } catch {
    return report;
  }
  try {
    const result =
      user.type === "user"
        ? await json(["ad", "signed-in-user", "show", "--query", "id"])
        : uuid.test(String(user.name))
          ? await json(["ad", "sp", "show", "--id", String(user.name), "--query", "id"])
          : undefined;
    if (typeof result === "string" && uuid.test(result)) report.account.objectId = result;
  } catch {
    /* Graph identity may be inaccessible; do not substitute an app ID or email. */
  }
  const roles: ActiveRole[] = [];
  let complete = false;
  if (report.account.objectId) {
    try {
      const assignments = await list(
        `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`atScope() and assignedTo('${report.account.objectId}')`)}`,
      );
      if (assignments.length > 128) throw new Error("preflight_roles");
      const definitions = new Map<string, Permission[]>();
      for (const raw of assignments) {
        const assignment = object(object(raw).properties);
        const id = String(assignment.roleDefinitionId);
        if (
          !/^\/(?:subscriptions\/[0-9a-f-]{36}\/|providers\/Microsoft.Management\/managementGroups\/[A-Za-z0-9._()-]+\/)?providers\/Microsoft.Authorization\/roleDefinitions\/[0-9a-f-]{36}$/iu.test(
            id,
          )
        )
          throw new Error("preflight_role_definition");
        // ARM's atScope() excludes child scopes; reject unexpected child assignments defensively.
        const assignedScope = String(assignment.scope).toLowerCase();
        if (
          assignedScope !== scope &&
          assignedScope !== "/" &&
          !/^\/providers\/microsoft.management\/managementgroups\/[a-z0-9._()-]+$/u.test(
            assignedScope,
          )
        )
          throw new Error("preflight_scope");
        if (!definitions.has(id))
          definitions.set(
            id,
            permissions(
              object(object(await read(`${ARM}${id}?api-version=2022-04-01`)).properties)
                .permissions,
            ),
          );
        roles.push({
          permissions: definitions.get(id)!,
          conditional: Boolean(
            assignment.condition || assignment.delegatedManagedIdentityResourceId,
          ),
        });
      }
      complete = true;
      report.activeRoles = {
        state: "read",
        count: roles.length,
        conditionalCount: roles.filter(
          (r) => r.conditional || r.permissions.some((p) => Boolean(p.condition)),
        ).length,
      };
    } catch {
      /* Partial lists and inaccessible role definitions cannot prove access. */
    }
  }
  let denies: Permission[] | undefined;
  try {
    const rows = await list(
      `${ARM}${scope}/providers/Microsoft.Authorization/denyAssignments?api-version=2022-04-01&$filter=atScope()`,
    );
    denies = rows.flatMap((raw) => permissions(object(object(raw).properties).permissions));
    report.denyAssignments = "read";
  } catch {
    /* A denied read is unknown, never absence of denies. */
  }
  try {
    const rows = await list(
      `${ARM}${scope}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()`,
    );
    report.pim = {
      state: rows.length ? "eligible_roles_present" : "no_eligible_roles_returned",
      count: rows.length,
      eligibilityGrantsAccess: false,
    };
  } catch {
    /* Eligibility is advisory and cannot confer an active grant. */
  }
  const requirements = {
    create_resource_groups: ["Microsoft.Resources/subscriptions/resourceGroups/write"],
    deploy_template: [
      "Microsoft.Resources/deployments/*",
      ...resources
        .filter((r) => !["Microsoft.Authorization", "Microsoft.Resources"].includes(r.namespace))
        .flatMap((r) => [`${r.namespace}/${r.type}/read`, `${r.namespace}/${r.type}/write`]),
    ],
    grant_required_roles: [
      "Microsoft.Authorization/roleAssignments/write",
      "Microsoft.Authorization/roleDefinitions/read",
      "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write",
    ],
  };
  report.capabilities = Object.entries(requirements).map(([name, actions]) => {
    const checks = [...new Set(actions)].map((action) => ({
      action,
      state: assessPermission(action, roles, denies, complete),
    }));
    const state =
      (["unknown", "possible_deny", "not_granted_by_active_roles", "conditional"] as const).find(
        (s) => checks.some((c) => c.state === s),
      ) ?? "allowed_by_active_roles";
    return { name, state, actions: checks };
  });
  try {
    const version = String(object(await json(["version"]))["azure-cli"])
      .split(".")
      .map(Number);
    if (version[0] > 2 || (version[0] === 2 && version[1] >= 76))
      report.prerequisites.cli = "supported";
  } catch {
    /* Require the Provider-level validation option, never silently downgrade it. */
  }
  try {
    await cli(["bicep", "version", "--only-show-errors"]);
    JSON.parse(
      await cli(["bicep", "build", "--file", "infra/main.bicep", "--stdout", "--only-show-errors"]),
    );
    report.prerequisites.bicep = "compiled";
  } catch {
    /* No compiler install or replacement is attempted. */
  }
  for (const namespace of [...new Set(resources.map((r) => r.namespace))]) {
    let state: OwnerPreflightReport["prerequisites"]["providers"][number]["state"] = "unknown";
    try {
      const provider = object(
        await json(["provider", "show", "--namespace", namespace, "--subscription", subscription]),
      );
      const types = array(provider.resourceTypes).map(object);
      state =
        provider.registrationState !== "Registered"
          ? "registration_required"
          : resources
                .filter((r) => r.namespace === namespace)
                .every((r) =>
                  types.some(
                    (type) =>
                      String(type.resourceType).toLowerCase() === r.type.toLowerCase() &&
                      array(type.apiVersions).includes(r.version),
                  ),
                )
            ? "supported"
            : "api_unavailable";
    } catch {
      /* Registration and API reads may be denied independently. */
    }
    report.prerequisites.providers.push({ namespace, state });
  }
  if (
    report.capabilities.every((c) => c.state === "allowed_by_active_roles") &&
    report.prerequisites.parameters === "valid" &&
    report.prerequisites.cli === "supported" &&
    report.prerequisites.bicep === "compiled" &&
    report.prerequisites.providers.every((p) => p.state === "supported")
  )
    report.state = "ready_for_arm_validation";
  return report;
}
async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  if ([...args.keys()].some((key) => !["--subscription", "--parameters", "--report"].includes(key)))
    throw new Error("preflight_arguments");
  const cli: CliRead = async (arguments_) =>
    execFileSync("az", arguments_, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const report = await ownerPreflight(
    {
      subscription: args.get("--subscription") ?? "",
      parameters: JSON.parse(
        await readFile(args.get("--parameters") ?? "infra/owner.parameters.json", "utf8"),
      ),
      templates: await Promise.all(
        ["main.bicep", "environment.bicep"].map((name) => readFile(`infra/${name}`, "utf8")),
      ),
    },
    cli,
  );
  await writeFile(
    args.get("--report") ?? "owner-preflight.json",
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(
    `Owner preflight: ${report.state}. Private report saved; ARM validation is still required.\n`,
  );
  if (report.state !== "ready_for_arm_validation") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("owner_preflight_failed\n");
    process.exitCode = 1;
  });
