import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

import type { ApprovalDisplayPreview } from "./approval-preview.js";
import { ApprovalStore, type ApprovalStatus } from "./approval-store.js";
import type { GrowthAutomationMode, PolicyDecision, PolicyRequest } from "./contracts.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceService, hashPolicyRequest } from "./governance-service.js";
import { PermitStore, type ExecutionPermit } from "./permit.js";

export interface GovernedActionInput {
  readonly commandId: string;
  readonly action: string;
  readonly resource: {
    readonly type: string;
    readonly id: string;
    readonly revision?: number;
    readonly dataClassification?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  };
  readonly environment: string;
  readonly riskClass: string;
  readonly external: boolean;
  readonly executionId: string;
  readonly workId?: string;
  readonly resumeTarget?: "runtime-subscription";
  readonly approvalPreview?: ApprovalDisplayPreview;
  readonly approvalId?: string;
}

export interface GovernedAgentIdentityReader {
  resolve(
    context: TenantContext,
    executionId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly agentHandle: string;
    readonly status:
      | "queued"
      | "running"
      | "suspended"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "interrupted"
      | "blocked_model_unavailable";
  }>;
}

export interface GovernedGrowthAgentActionInput extends GovernedActionInput {
  readonly workId: string;
  readonly automationMode: GrowthAutomationMode;
}

export interface GovernanceAuthorization {
  readonly outcome: "allow";
  readonly decision: PolicyDecision;
  readonly permit?: ExecutionPermit;
}

export class GovernanceApprovalRequiredError extends Error {
  public constructor(
    public readonly decisionId: string,
    public readonly approvalId: string,
  ) {
    super(`사람 승인이 필요합니다: ${approvalId}`);
    this.name = "GovernanceApprovalRequiredError";
  }
}

export class GovernanceDeniedError extends Error {
  public constructor(public readonly decision: PolicyDecision) {
    super(`Governance 정책이 요청을 거부했습니다: ${decision.reasons.join(",") || decision.errors.join(",")}`);
    this.name = "GovernanceDeniedError";
  }
}

export class GovernanceGate {
  public constructor(
    private readonly governance: GovernanceService,
    private readonly approvals: ApprovalStore,
    private readonly permits: PermitStore,
    private readonly emergency: EmergencyControl,
    private readonly agentIdentities?: GovernedAgentIdentityReader,
  ) {}

  public async authorize(
    context: TenantContext,
    input: GovernedActionInput,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.action !== "work.read" && input.action !== "emergency.stop" && input.action !== "emergency.stop.disable")
      await this.emergency.assertExecutionAllowed(context, executor);
    const request = this.request(context, input);
    return await this.authorizeRequest(context, input, request, executor);
  }

  public async authorizeAgent(
    context: TenantContext,
    input: GovernedGrowthAgentActionInput,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.action !== "growth.adopt" && input.action !== "growth.revert") {
      throw new Error("Growth Agent authorization은 growth.adopt와 growth.revert만 지원합니다");
    }
    await this.emergency.assertExecutionAllowed(context);
    if (!this.agentIdentities) throw new Error("검증된 Agent identity reader가 없습니다");
    const identity = await this.agentIdentities.resolve(context, input.executionId);
    if (identity.organizationId !== context.organizationId)
      throw new Error("Growth Agent Runtime Execution의 organization이 다릅니다");
    if (identity.workId !== input.workId) throw new Error("Growth Agent Runtime Execution의 Work가 다릅니다");
    if (identity.agentHandle !== "growth") throw new Error("Runtime Execution은 Growth Agent가 아닙니다");
    if (identity.status !== "succeeded") throw new Error("Growth Agent Runtime Execution은 succeeded 상태여야 합니다");
    const request = this.agentRequest(context, input);
    return await this.authorizeRequest(context, input, request, executor);
  }

  private async authorizeRequest(
    context: TenantContext,
    input: GovernedActionInput,
    request: PolicyRequest,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.approvalId) {
      const approval = await this.approvals.get(context, input.approvalId, executor);
      const decision = await this.governance.getDecision(context, approval.decision_id, executor);
      if (approval.resource_revision !== input.resource.revision)
        throw new Error("resource revision precondition이 일치하지 않습니다");
      if (decision.requestHash !== hashPolicyRequest(request))
        throw new Error("request hash precondition이 일치하지 않습니다");
      if (!decision.policyVersionId) throw new Error("Policy Decision에 version이 없습니다");
      const permit = await this.permits.consume(
        context,
        {
          commandId: `${input.commandId}:permit`,
          approvalId: input.approvalId,
          requestHash: decision.requestHash,
          policyVersionId: decision.policyVersionId,
          ...(input.resource.revision === undefined ? {} : { resourceRevision: input.resource.revision }),
          executionId: input.executionId,
          expectedAction: input.action,
          expectedResourceType: input.resource.type,
          expectedResourceId: input.resource.id,
        },
        executor,
      );
      return { outcome: "allow", decision, permit };
    }
    const decision = await this.governance.evaluate(context, {
      commandId: `${input.commandId}:policy`,
      request,
    });
    if (decision.outcome === "deny") throw new GovernanceDeniedError(decision);
    if (decision.outcome === "allow") return { outcome: "allow", decision };
    const approval = await this.approvals.request(context, {
      commandId: `${input.commandId}:approval`,
      decisionId: decision.decisionId,
      ...(input.resource.revision === undefined ? {} : { resourceRevision: input.resource.revision }),
      ...(input.workId === undefined ? {} : { workId: input.workId }),
      executionId: input.executionId,
      ...(input.resumeTarget === undefined ? {} : { resumeTarget: input.resumeTarget }),
      ...(input.approvalPreview === undefined ? {} : { displayPreview: input.approvalPreview }),
    });
    throw new GovernanceApprovalRequiredError(decision.decisionId, approval.approval_id);
  }

  public async getApprovalStatus(context: TenantContext, approvalId: string): Promise<ApprovalStatus> {
    return (await this.approvals.expire(context, approvalId)).status;
  }

  private request(context: TenantContext, input: GovernedActionInput): PolicyRequest {
    return {
      principal: {
        type: "Human",
        id: context.userId,
        organizationId: context.organizationId,
        attributes: { kind: "human", role: context.role, subjectId: context.userId },
      },
      action: input.action,
      resource: {
        type: input.resource.type,
        id: input.resource.id,
        organizationId: context.organizationId,
        ...(input.resource.revision === undefined ? {} : { revision: input.resource.revision }),
        attributes: {
          dataClassification: input.resource.dataClassification ?? "internal",
          ...input.resource.attributes,
        },
      },
      context: {
        environment: input.environment,
        riskClass: input.riskClass,
        external: input.external,
      },
    };
  }

  private agentRequest(context: TenantContext, input: GovernedGrowthAgentActionInput): PolicyRequest {
    return {
      principal: {
        type: "Agent",
        id: input.executionId,
        organizationId: context.organizationId,
        attributes: { kind: "agent", role: "growth", subjectId: input.executionId },
      },
      action: input.action,
      resource: {
        type: input.resource.type,
        id: input.resource.id,
        organizationId: context.organizationId,
        ...(input.resource.revision === undefined ? {} : { revision: input.resource.revision }),
        attributes: {
          dataClassification: input.resource.dataClassification ?? "internal",
          ...input.resource.attributes,
        },
      },
      context: {
        environment: input.environment,
        riskClass: input.riskClass,
        external: input.external,
        automationMode: input.automationMode,
      },
    };
  }
}
