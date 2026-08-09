import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { CedarAuthorizer } from "./cedar-authorizer.js";
import type {
  ApprovalRequirement,
  EvaluatePolicyInput,
  GrowthAutomationMode,
  PolicyDecision,
  PolicyRequest,
} from "./contracts.js";
import { PolicyStore } from "./policy-store.js";
import { AutonomyStore } from "./autonomy.js";
import {
  GOVERNANCE_DECISION_CONTEXT_MIGRATION,
  GOVERNANCE_DECISION_MIGRATION,
  GOVERNANCE_GROWTH_AUTONOMY_MIGRATION,
} from "./schema.js";

interface DecisionRecord {
  readonly decision_id: string;
  readonly organization_id: string;
  readonly command_id: string;
  readonly policy_version_id?: string;
  readonly request_hash: string;
  readonly outcome: PolicyDecision["outcome"];
  readonly reasons_json: string;
  readonly errors_json: string;
  readonly requirement_json?: string;
  readonly automation_mode?: GrowthAutomationMode;
  readonly request_json: string;
  readonly created_at: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPolicyRequest(request: PolicyRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function matches(requirement: ApprovalRequirement, request: PolicyRequest): boolean {
  const environment = typeof request.context.environment === "string" ? request.context.environment : "unknown";
  const riskClass = typeof request.context.riskClass === "string" ? request.context.riskClass : "unknown";
  return (
    (requirement.actions.includes("*") || requirement.actions.includes(request.action)) &&
    (requirement.environments.includes("*") || requirement.environments.includes(environment)) &&
    (requirement.riskClasses.includes("*") || requirement.riskClasses.includes(riskClass))
  );
}

function automationMode(request: PolicyRequest): GrowthAutomationMode | undefined {
  const mode = request.context.automationMode;
  return mode === "review" || mode === "auto" ? mode : undefined;
}

function isReadAction(action: string): boolean {
  return action === "work.read" || action.endsWith(".read");
}

function autonomyReviewRequirement(action: string): ApprovalRequirement {
  return {
    requirementId: "autonomy-review",
    actions: [action],
    environments: ["*"],
    riskClasses: ["*"],
    approverRoles: ["owner", "admin"],
    quorum: 1,
    separationOfDuty: false,
    expiresInSeconds: 3600,
  };
}

/** full-access도 우회하지 못하는 안전 불변식. 통제 장치 자체를 바꾸는 행동입니다. */
const NON_BYPASSABLE_ACTIONS = new Set([
  "policy.activate",
  "emergency.stop.disable",
  "declaration.apply",
  "model.optimization.approve",
]);

/**
 * `hardOnly`는 full-access 경로가 씁니다. 자가개선 채택·되돌리기는 사용자가 고른 채택 모드를 표현하는
 * 다이얼이지 통제 장치가 아니므로, 사용자가 명시적으로 전체 권한을 켰다면 그 선택이 이깁니다.
 */
function invariantRequirement(
  action: string,
  mode?: GrowthAutomationMode,
  options?: { readonly hardOnly?: boolean },
): ApprovalRequirement | undefined {
  const governed = new Set(NON_BYPASSABLE_ACTIONS);
  if (!options?.hardOnly) {
    if (action === "growth.adopt" && mode !== "auto") governed.add(action);
    if (action === "growth.revert" && mode !== "auto") governed.add(action);
  }
  if (!governed.has(action)) return undefined;
  return {
    requirementId: `invariant-${action.replaceAll(".", "-")}`,
    actions: [action],
    environments: ["*"],
    riskClasses: ["*"],
    approverRoles: ["owner", "admin"],
    quorum: 1,
    separationOfDuty: false,
    expiresInSeconds: 3600,
  };
}

export class GovernanceService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly policies: PolicyStore,
    public readonly autonomy: AutonomyStore,
    private readonly authorizer = new CedarAuthorizer(),
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    policies: PolicyStore,
  ): Promise<GovernanceService> {
    await applyMigrations(database, [
      GOVERNANCE_DECISION_MIGRATION,
      GOVERNANCE_DECISION_CONTEXT_MIGRATION,
      GOVERNANCE_GROWTH_AUTONOMY_MIGRATION,
    ]);
    const autonomy = await AutonomyStore.create(database, organizations);
    return new GovernanceService(database, organizations, policies, autonomy);
  }

  public async evaluate(context: TenantContext, input: EvaluatePolicyInput): Promise<PolicyDecision> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = hashPolicyRequest(input.request);
    const requestJson = canonicalJson({ commandId: input.commandId, requestHash });
    const repeated = await this.repeated(context.organizationId, input.commandId, requestJson);
    if (repeated) return this.view(repeated);
    let outcome: PolicyDecision["outcome"] = "deny";
    let reasons: readonly string[] = [];
    let errors: readonly string[] = [];
    let requirement: ApprovalRequirement | undefined;
    const mode = automationMode(input.request);
    const active = await this.policies.getActivePolicy(context);
    const autonomyState = await this.autonomy.get(context);
    if (
      input.request.principal.organizationId !== context.organizationId ||
      input.request.resource.organizationId !== context.organizationId
    ) {
      reasons = ["tenant-context"];
    } else if (autonomyState.mode === "full-access") {
      // full-access도 안전 불변식(non-bypassable)은 우회하지 않습니다.
      requirement = invariantRequirement(input.request.action, mode, { hardOnly: true });
      if (requirement) {
        outcome = "require_approval";
        reasons = ["full-access-non-bypassable"];
      } else {
        outcome = "allow";
        reasons = ["full-access-user-opt-in"];
      }
    } else if (!active) {
      errors = ["active_policy_missing"];
    } else {
      const authorization = this.authorizer.authorize(active.bundle, input.request);
      reasons = authorization.reasons;
      errors = authorization.errors;
      if (authorization.decision === "allow") {
        requirement =
          active.requirements.find((candidate) => matches(candidate, input.request)) ??
          invariantRequirement(input.request.action, mode);
        outcome = requirement ? "require_approval" : "allow";
        // 자율성 다이얼(조이기 전용): review 모드는 읽기 외 allow를 승인 요구로 승격합니다.
        // deny와 정책·불변식이 요구한 승인은 이 설정으로 바뀌지 않습니다.
        if (outcome === "allow" && !isReadAction(input.request.action)) {
          if (autonomyState.mode === "review") {
            requirement = autonomyReviewRequirement(input.request.action);
            outcome = "require_approval";
            reasons = [...reasons, "autonomy-review"];
          }
        }
      }
    }
    const decisionId = randomUUID();
    const summary = {
      principal: { type: input.request.principal.type, id: input.request.principal.id },
      action: input.request.action,
      resource: { type: input.request.resource.type, id: input.request.resource.id },
      environment: input.request.context.environment,
      riskClass: input.request.context.riskClass,
    };
    await this.database.query(
      "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, policy_version_id: $policy_version_id, request_hash: $request_hash, principal_type: $principal_type, principal_id: $principal_id, action: $action, resource_type: $resource_type, resource_id: $resource_id, resource_revision: $resource_revision, environment: $environment, risk_class: $risk_class, external: $external, automation_mode: $automation_mode, request_summary_json: $summary_json, outcome: $outcome, reasons_json: $reasons_json, errors_json: $errors_json, requirement_json: $requirement_json, request_json: $request_json, created_at: time::now() };",
      {
        decision_id: decisionId,
        organization_id: context.organizationId,
        command_id: input.commandId,
        policy_version_id: active?.version.policy_version_id,
        request_hash: requestHash,
        principal_type: input.request.principal.type,
        principal_id: input.request.principal.id,
        action: input.request.action,
        resource_type: input.request.resource.type,
        resource_id: input.request.resource.id,
        resource_revision: input.request.resource.revision,
        environment:
          typeof input.request.context.environment === "string" ? input.request.context.environment : "unknown",
        risk_class: typeof input.request.context.riskClass === "string" ? input.request.context.riskClass : "unknown",
        external: input.request.context.external === true,
        automation_mode: mode,
        summary_json: canonicalJson(summary),
        outcome,
        reasons_json: canonicalJson(reasons),
        errors_json: canonicalJson(errors),
        requirement_json: requirement ? canonicalJson(requirement) : undefined,
        request_json: requestJson,
      },
    );
    return this.view(await this.find(context.organizationId, decisionId));
  }

  public async getDecision(
    context: TenantContext,
    decisionId: string,
    executor: QueryExecutor = this.database,
  ): Promise<PolicyDecision> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    return this.view(await this.find(context.organizationId, decisionId, executor));
  }

  private async repeated(
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<DecisionRecord | undefined> {
    const [records] = await this.database.query<[DecisionRecord[]]>(
      "SELECT * OMIT id FROM governance_policy_decision WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (records[0] && records[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Governance 요청을 사용할 수 없습니다");
    return records[0];
  }

  private async find(
    organizationId: string,
    decisionId: string,
    executor: QueryExecutor = this.database,
  ): Promise<DecisionRecord> {
    const [records] = await executor.query<[DecisionRecord[]]>(
      "SELECT * OMIT id FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
      { organization_id: organizationId, decision_id: decisionId },
    );
    if (!records[0]) throw new Error(`Policy Decision을 찾을 수 없습니다: ${decisionId}`);
    return records[0];
  }

  private view(record: DecisionRecord): PolicyDecision {
    return {
      decisionId: record.decision_id,
      organizationId: record.organization_id,
      ...(record.policy_version_id ? { policyVersionId: record.policy_version_id } : {}),
      requestHash: record.request_hash,
      outcome: record.outcome,
      reasons: JSON.parse(record.reasons_json) as string[],
      errors: JSON.parse(record.errors_json) as string[],
      ...(record.requirement_json ? { requirement: JSON.parse(record.requirement_json) as ApprovalRequirement } : {}),
      ...(record.automation_mode ? { automationMode: record.automation_mode } : {}),
      createdAt: record.created_at,
    };
  }
}
