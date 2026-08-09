import type { ApprovalDisplayPreview } from "@massion/governance";
import type { TenantContext } from "@massion/identity";

export type ApplicationSourceWatermarks = Readonly<Record<string, string | number>>;

export interface ApplicationOrganizationNodeSource {
  readonly nodeId: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: readonly string[];
  readonly parentHandle?: string;
  readonly status: string;
  readonly role: string;
  readonly scope: "persistent" | "work";
  readonly workId?: string;
  /**
   * Core Office 여덟 노드. 도메인이 변경·비활성화를 거부하므로 화면이 이 사실을 알아야
   * 편성 조작을 막을 수 있습니다. 모르면 사람이 눌러 보고 오류로만 알게 됩니다.
   */
  readonly builtin: boolean;
}

export interface ApplicationOrganizationSource {
  readonly organizationId: string;
  readonly version: number;
  readonly nodes: readonly ApplicationOrganizationNodeSource[];
}

export interface ApplicationWorkSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly status: string;
  readonly revision: number;
  readonly artifactIds: readonly string[];
  readonly workspaceId?: string;
  readonly autonomyMode?: "automatic" | "review" | "full-access";
  readonly autonomyRevision?: number;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ApplicationTaskSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly objective?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly dependencyIds?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly recommendedAgentHandles?: readonly string[];
  readonly parallelizable?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ApplicationAssignmentSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly status: string;
  readonly revision: number;
  readonly assignmentId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ApplicationExecutionSource {
  readonly organizationId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly autonomyMode?: "automatic" | "review" | "full-access";
  readonly autonomyRevision?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ApplicationRoomSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly participantIds: readonly string[];
  readonly participants?: readonly { readonly subjectId: string; readonly kind: "user" | "agent" }[];
  readonly lastMessageSequence: number;
  /** 방을 조정하는 노드 handle. */
  readonly coordinatorHandle?: string;
  /**
   * 방의 실행 예산. 사용자가 남은 여유를 알아야 조직이 멈출지 계속할지 판단할 수 있습니다.
   * 소비량은 메시지의 token_count·cost_micros 합으로 계산합니다.
   */
  readonly roundCount?: number;
  readonly maxRounds?: number;
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
}

/** 방이 참조하는 불변 스냅샷. checksum으로 같은 것을 보고 있음을 보증합니다. */
export interface ApplicationSharedContextSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly sharedContextReferenceId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly versionId: string;
  readonly checksum: string;
}

export interface ApplicationMessageSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly messageType: string;
  readonly authorKind: string;
  readonly authorId: string;
  readonly recipientAgentId?: string;
  readonly authorDisplayName?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly content: string;
  readonly createdAt: string;
  /** 이 메시지가 답한 원본. answer가 어느 question에 붙는지, challenge가 무엇을 반박하는지. */
  readonly tokenCount?: number;
  readonly costMicros?: number;
  readonly replyToMessageId?: string;
  /** 이 메시지를 유발한 원인. 인과 계보를 화면까지 잇습니다. */
  readonly causedByMessageId?: string;
  readonly taskId?: string;
  readonly contextVersionId?: string;
  readonly executionId?: string;
  readonly artifactVersionId?: string;
  readonly staffingProposal?: ApplicationAppliedStaffingProposalSource;
}

export interface ApplicationStaffingProposalNodeSource {
  readonly handle: string;
  readonly name: string;
  readonly scope: "work";
  readonly workId: string;
  readonly parentHandle: string;
  readonly role: "orchestrator" | "coordinator" | "operator";
  readonly capabilities: readonly string[];
}

export interface ApplicationAppliedStaffingProposalSource {
  readonly proposalId: string;
  readonly status: "applied";
  readonly approvalId?: string;
  readonly nodes: readonly ApplicationStaffingProposalNodeSource[];
  readonly impactNodeHandles: readonly string[];
  readonly impactReferenceCount: number;
  readonly fromOrganizationVersion: number;
  readonly toOrganizationVersion: number;
}

export interface ApplicationRecordSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly recordId: string;
  readonly version: number;
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly verificationIds: readonly string[];
  readonly finalizedAt: string;
}

export interface ApplicationApprovalSource {
  readonly organizationId: string;
  readonly approvalId: string;
  readonly action: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly expiresAt: string;
  readonly workId?: string;
  readonly executionId?: string;
  readonly revision?: number;
  readonly resourceRevision?: number;
  readonly resumeTarget?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly displayPreview?: ApprovalDisplayPreview;
}

export interface ApplicationArtifactSource {
  readonly organizationId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly workId: string;
  readonly name: string;
  readonly kind: string;
  readonly version: number;
  readonly mediaType: string;
  readonly checksum: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly sourceArtifactVersionId?: string;
  readonly creatorAgentHandle?: string;
  readonly creatorExecutionId?: string;
}

export interface ApplicationVerificationSource {
  readonly organizationId: string;
  readonly verificationId: string;
  readonly workId: string;
  readonly verifierId: string;
  readonly passed: boolean;
  readonly criteria: unknown;
  readonly evidenceArtifactVersionIds: readonly string[];
  readonly assuranceRunId?: string;
  readonly targetWorkRevision?: number;
  readonly projectedWorkRevision?: number;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly bindingVersionId?: string;
  readonly createdAt: string;
}

export interface ApplicationDirectiveSource {
  readonly organizationId: string;
  readonly directiveId: string;
  readonly workId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly content: string;
  readonly mode: "now" | "next-stage";
  readonly submittedStage: string;
  readonly status: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
}

export interface ApplicationExtensionSource {
  readonly organizationId: string;
  readonly installationId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly state: string;
  readonly contributions: readonly string[];
}

export interface ApplicationReadModel {
  watermarks(context: TenantContext): Promise<ApplicationSourceWatermarks>;
  organization(context: TenantContext): Promise<ApplicationOrganizationSource>;
  works(context: TenantContext): Promise<readonly ApplicationWorkSource[]>;
  tasks(context: TenantContext): Promise<readonly ApplicationTaskSource[]>;
  assignments(context: TenantContext): Promise<readonly ApplicationAssignmentSource[]>;
  executions(context: TenantContext): Promise<readonly ApplicationExecutionSource[]>;
  rooms(context: TenantContext): Promise<readonly ApplicationRoomSource[]>;
  messages?(context: TenantContext): Promise<readonly ApplicationMessageSource[]>;
  sharedContexts?(context: TenantContext): Promise<readonly ApplicationSharedContextSource[]>;
  records?(context: TenantContext): Promise<readonly ApplicationRecordSource[]>;
  artifacts?(context: TenantContext): Promise<readonly ApplicationArtifactSource[]>;
  verifications?(context: TenantContext): Promise<readonly ApplicationVerificationSource[]>;
  directives?(context: TenantContext): Promise<readonly ApplicationDirectiveSource[]>;
  approvals(context: TenantContext): Promise<readonly ApplicationApprovalSource[]>;
  extensions(context: TenantContext): Promise<readonly ApplicationExtensionSource[]>;
}
