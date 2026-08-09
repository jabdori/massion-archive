import type { ApprovalDisplayPreview } from "@massion/governance";

export const APPLICATION_SCHEMA_VERSION = "massion.application.v1" as const;
export const APPLICATION_EVENT_SCHEMA_VERSION = "massion.application.event.v1" as const;
export const APPLICATION_ERROR_SCHEMA_VERSION = "massion.error.v1" as const;

export type ApplicationCommandOutcome = "succeeded" | "accepted" | "awaiting-approval" | "blocked";
export type ApplicationAuthorKind = "user" | "agent" | "system";

export interface ApplicationResourceV1 {
  readonly type: string;
  readonly id: string;
  readonly revision?: number;
}

export interface ApplicationCommandV1 {
  readonly schemaVersion: typeof APPLICATION_SCHEMA_VERSION;
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly expectedRevision?: number;
  readonly payload: unknown;
}

export interface ApplicationCommandResultV1 {
  readonly schemaVersion: typeof APPLICATION_SCHEMA_VERSION;
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly outcome: ApplicationCommandOutcome;
  readonly resource?: ApplicationResourceV1;
  readonly data?: unknown;
}

export interface CursorPageV1<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface StartRunRequestV1 {
  readonly text: string;
  readonly surface?: string;
  readonly outputLocale?: "en" | "ko";
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly workspacePaths?: readonly string[];
  readonly tokenBudget?: number;
  readonly softwareDelivery?: {
    readonly repositoryRoot: string;
    readonly repositoryId: string;
    readonly repositoryRevisionId: string;
    readonly baseRevision: string;
    readonly profileVersion: string;
    readonly allowedPaths: readonly string[];
    readonly testPaths: readonly string[];
    readonly environment?: string;
    readonly leaseTtlMs?: number;
  };
  readonly scopeIn?: readonly string[];
  readonly scopeOut?: readonly string[];
  readonly constraints?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly decisions?: readonly string[];
}

export interface WorkspaceViewV1 {
  readonly workspaceId: string;
  readonly name: string;
  readonly path: string;
  readonly kind: "local-directory";
  readonly trust: "pending" | "trusted" | "blocked";
  readonly status: "active" | "archived";
  readonly revision: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface WorkSummaryV1 {
  readonly workId: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly workspaceId?: string;
  readonly autonomyMode?: "automatic" | "review" | "full-access";
  readonly autonomyRevision?: number;
  readonly updatedAt?: string;
}

export interface WorkDetailV1 extends WorkSummaryV1 {
  readonly artifactVersionIds: readonly string[];
  /** 이전 공개 계약 호환용입니다. 새 클라이언트는 artifactVersionIds를 사용합니다. */
  readonly artifactIds: readonly string[];
  readonly createdAt?: string;
}

export type WorkActivityKindV1 =
  | "work"
  | "message"
  | "run"
  | "task"
  | "assignment"
  | "execution"
  | "approval"
  | "artifact"
  | "verification"
  | "record";

export interface WorkActivityViewV1 {
  readonly activityId: string;
  readonly workId: string;
  readonly kind: WorkActivityKindV1;
  readonly title: string;
  readonly createdAt: string;
  readonly detail?: string;
  readonly status?: string;
  readonly authorKind?: string;
  readonly authorId?: string;
  readonly messageType?: string;
  readonly resourceId?: string;
}

export interface TaskViewV1 {
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

export interface AssignmentViewV1 {
  readonly workId: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly status: string;
  readonly revision: number;
  readonly assignmentId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RunViewV1 {
  readonly runId: string;
  readonly workId?: string;
  readonly stage: string;
  readonly status: string;
  readonly approvalId?: string;
  readonly blockedReason?: string;
  readonly blockedDetail?: string;
  readonly leaseGeneration: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ExecutionViewV1 {
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

export interface RouteAttemptViewV1 {
  readonly attemptId: string;
  readonly at: string;
  readonly routeId: string;
  /** 계보 정본. Provider 등록이 제거돼도 남으므로 감사는 언제나 가능합니다. */
  readonly modelProfileId: string;
  /** 등록이 제거된 과거 호출에는 없습니다. 화면은 이름을 지어내는 대신 제거됐다고 말합니다. */
  readonly modelId?: string;
  readonly providerId?: string;
  readonly executionId?: string;
  readonly optimizationRunId?: string;
  readonly optimizationBatchId?: string;
  readonly status: "succeeded" | "failed" | "interrupted" | "running";
  readonly statusCode?: number;
  readonly failureClass?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly costMicros: number;
  readonly fallbackFrom?: string;
  readonly workId?: string;
  readonly workTitle?: string;
}

export interface ApprovalViewV1 {
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

export type InboxItemViewV1 =
  | {
      readonly kind: "blocked";
      readonly id: string;
      readonly runId: string;
      readonly workId?: string;
      readonly title: string;
      readonly blockedReason?: string;
      readonly blockedDetail?: string;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly workTitle?: string;
      readonly approval: ApprovalViewV1;
    }
  | {
      readonly kind: "growth";
      readonly id: string;
      readonly suggestionId: string;
      readonly workId: string;
      readonly workTitle: string;
      readonly title: string;
      readonly reason: string;
    };

export interface EmergencyStateViewV1 {
  readonly active: boolean;
  readonly reason?: string;
  readonly revision: number;
  readonly changedByUserId?: string;
  readonly changedAt?: string;
}

export interface RoomViewV1 {
  readonly workId: string;
  readonly roomId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly participantIds: readonly string[];
  readonly participants?: readonly { readonly subjectId: string; readonly kind: "user" | "agent" }[];
  readonly lastMessageSequence: number;
  readonly coordinatorHandle?: string;
  /** 방의 실행 예산과 소비량. 남은 여유를 알아야 계속할지 멈출지 판단할 수 있습니다. */
  readonly roundCount?: number;
  readonly maxRounds?: number;
  readonly usedTokens?: number;
  readonly maxTokens?: number;
  readonly usedCostMicros?: number;
  readonly maxCostMicros?: number;
}

/** 방이 참조하는 불변 스냅샷. 같은 것을 보고 있음을 checksum이 보증합니다. */
export interface SharedContextViewV1 {
  readonly sharedContextReferenceId: string;
  readonly roomId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly versionId: string;
  readonly checksum: string;
}

/** `CollaborationMessageType` 10종. 화면 문법이 이 값에서 갈라집니다. */
export type RoomMessageTypeV1 =
  | "question"
  | "answer"
  | "proposal"
  | "challenge"
  | "review_request"
  | "change_request"
  | "evidence"
  | "decision"
  | "handoff"
  | "status";

export interface AppliedStaffingProposalNodeViewV1 {
  readonly handle: string;
  readonly name: string;
  readonly scope: "work";
  readonly workId: string;
  readonly parentHandle: string;
  readonly role: "orchestrator" | "coordinator" | "operator";
  readonly capabilities: readonly string[];
}

export interface AppliedStaffingProposalViewV1 {
  readonly proposalId: string;
  readonly status: "applied";
  readonly approvalId?: string;
  readonly nodes: readonly AppliedStaffingProposalNodeViewV1[];
  readonly impactNodeHandles: readonly string[];
  readonly impactReferenceCount: number;
  readonly fromOrganizationVersion: number;
  readonly toOrganizationVersion: number;
}

export interface RoomMessageViewV1 {
  readonly messageId: string;
  readonly sequence: number;
  // 문자열 리터럴 타입(RoomMessageTypeV1)은 string에 포함되므로 중복을 제거합니다.
  readonly messageType: string;
  readonly authorKind: string;
  /** 에이전트면 조직 handle, 사람이면 사용자 식별자. 화자 정체성의 정본입니다. */
  readonly authorId: string;
  /** handoff를 실제로 받는 같은 방의 Agent handle입니다. */
  readonly recipientAgentId?: string;
  readonly authorDisplayName?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly content: string;
  readonly createdAt: string;
  readonly replyToMessageId?: string;
  readonly causedByMessageId?: string;
  readonly taskId?: string;
  readonly contextVersionId?: string;
  readonly executionId?: string;
  readonly artifactVersionId?: string;
  readonly staffingProposal?: AppliedStaffingProposalViewV1;
}

export interface OrganizationNodeViewV1 {
  readonly node_id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly parent_handle?: string;
  readonly status: "active" | "inactive" | "retired";
  readonly role: "orchestrator" | "coordinator" | "operator";
  readonly capabilities: readonly string[];
  readonly scope: "persistent" | "work";
  readonly work_id?: string;
  /** Core Office 여덟 노드. 도메인이 변경을 거부하므로 화면이 편성 조작을 미리 막습니다. */
  readonly builtin: boolean;
}

export interface OrganizationGraphSnapshotV1 {
  readonly nodes: readonly OrganizationNodeViewV1[];
  readonly version: { readonly version: number };
}

export interface GovernanceAutonomyViewV1 {
  readonly mode: "automatic" | "review" | "full-access";
  readonly revision: number;
  readonly runtimePermissionStatus?: "governed" | "full-access" | "limited";
  readonly permissionLimitReason?: string;
  readonly emergencyStopActive?: boolean;
}

/** 확장이 조직에 더한 능력. `kind`는 SDK의 contribution·permission 선언 그룹 이름입니다. */
/** 조직 편성이 옮기거나 남기는 참조. `split`·`merge`가 기존 참조를 어디로 보낼지 정합니다. */
export interface OrganizationReferenceDispositionV1 {
  readonly referenceId: string;
  readonly action: "retain" | "move";
  readonly targetHandle?: string;
}

export interface ExtensionCapabilityViewV1 {
  readonly kind: string;
  readonly items: readonly string[];
}

export interface ExtensionInstallationViewV1 {
  readonly installationId: string;
  readonly packageName: string;
  readonly state: string;
  readonly activeVersionId?: string;
  readonly activationGeneration: number;
  /**
   * 헌법 6절은 확장 화면이 「조직에 추가된 Capability를 먼저」 보이라고 정합니다. 이 둘이 없던 동안
   * 설치된 확장은 화면에서 언제나 빈 목록이었습니다. 활성 version이 없으면 여전히 비어 있습니다 —
   * 설치만 되고 활성화 전이라 실제로 더한 것이 없기 때문입니다.
   */
  readonly contributions: readonly ExtensionCapabilityViewV1[];
  readonly permissions: readonly ExtensionCapabilityViewV1[];
}

export interface ArtifactViewV1 {
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

export interface VerificationViewV1 {
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

export interface WorkRecordViewV1 {
  readonly recordId: string;
  readonly version: number;
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly verificationIds: readonly string[];
  readonly finalizedAt: string;
}

export interface DirectiveViewV1 {
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

export interface KnowledgeReferenceViewV1 {
  readonly referenceId: string;
  readonly kind: "symbol" | "chunk";
  readonly nodeId?: string;
  readonly relativePath: string;
  readonly qualifiedName?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly provenance?: KnowledgeReferenceProvenanceViewV1;
}

export interface KnowledgeReferenceProvenanceViewV1 {
  readonly selection: "scope" | "direct-search" | "graph-neighbor";
  readonly snapshotChecksum: string;
  readonly paths: readonly {
    readonly seed: {
      readonly referenceId: string;
      readonly kind: "symbol" | "chunk";
      readonly symbolKey?: string;
    };
    readonly relation?: {
      readonly relationId: string;
      readonly relationKey: string;
      readonly kind: KnowledgeRelationKindV1;
      readonly sourceSymbolKey?: string;
      readonly targetSymbolKey?: string;
      readonly targetText: string;
      readonly resolved: boolean;
      readonly relativePath: string;
      readonly startLine: number;
    };
  }[];
}

export interface WorkKnowledgeViewV1 {
  readonly workId: string;
  readonly status: "not-applicable" | "ready" | "no-match" | "blocked";
  readonly repositoryId?: string;
  readonly repositoryRevisionId?: string;
  readonly indexVersionId?: string;
  readonly evidenceBriefId?: string;
  readonly snapshotChecksum?: string;
  readonly evidenceBriefChecksum?: string;
  readonly freshnessStatus?: "fresh" | "stale_warning";
  readonly query?: string;
  readonly references: readonly KnowledgeReferenceViewV1[];
  readonly failureReason?: string;
}

export type KnowledgeRelationKindV1 = "contains" | "imports" | "calls" | "implements" | "documents";
export type KnowledgeNodeKindV1 = "symbol" | "file" | "document" | "work" | "artifact" | "agent";
export type KnowledgeGraphLensV1 = KnowledgeNodeKindV1;

export interface KnowledgeNodeViewV1 {
  readonly nodeId: string;
  readonly kind: KnowledgeNodeKindV1;
  readonly label: string;
  readonly detail?: string;
  readonly group?: string;
}

export interface KnowledgeGraphEdgeViewV1 {
  readonly kind: KnowledgeRelationKindV1;
  readonly sourceId: string;
  readonly targetId: string;
  readonly unresolved?: boolean;
  readonly derivedVia?: string;
  readonly relationId?: string;
  readonly relationKey?: string;
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText?: string;
  readonly snapshotChecksum?: string;
  readonly sourcePath?: string;
  readonly sourceLine?: number;
}

export interface KnowledgeGraphViewV1 {
  readonly lens: KnowledgeGraphLensV1;
  readonly nodes: readonly KnowledgeNodeViewV1[];
  readonly edges: readonly KnowledgeGraphEdgeViewV1[];
}

export interface KnowledgeLinkViewV1 {
  readonly node: KnowledgeNodeViewV1;
  readonly kind: KnowledgeRelationKindV1;
  readonly direction: "outgoing" | "incoming";
  readonly unresolved?: boolean;
  readonly relationId?: string;
  readonly relationKey?: string;
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText?: string;
  readonly snapshotChecksum?: string;
  readonly sourcePath?: string;
  readonly sourceLine?: number;
}

export interface KnowledgeIndexViewV1 {
  readonly workspaceId: string;
  readonly status: "ready" | "indexing" | "stale" | "none";
  readonly indexVersionId?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationCount: number;
  readonly indexedAt?: string;
  readonly excluded: readonly string[];
}

export interface ExplicitMemoryEntryViewV1 {
  readonly key: string;
  readonly kind: "fact" | "preference" | "procedure";
  readonly value: string;
  readonly authority: "explicit";
}

export interface ExplicitMemoryViewV1 {
  readonly memoryVersionId: string;
  readonly revision: number;
  readonly entries: readonly ExplicitMemoryEntryViewV1[];
}

export interface GrowthSuggestionViewV1 {
  readonly suggestionId: string;
  readonly workId: string;
  readonly targetKind: string;
  readonly operation: string;
  readonly summary: string;
  readonly rationale: string;
  readonly expectedEffect: string;
  readonly riskSummary: string;
  readonly status: string;
  readonly revision: number;
  readonly createdAt?: string;
  readonly reflectionRunId: string;
  readonly sourceReferenceIds: readonly string[];
  readonly patch?: Readonly<Record<string, unknown>>;
  readonly evaluation?: {
    readonly evaluationRunId: string;
    readonly outcome: "eligible" | "ineligible" | "blocked";
    readonly strategyVersionId: string;
    readonly inputHash: string;
    readonly signals: readonly {
      readonly signalId: string;
      readonly group: "required" | "supporting" | "conflict";
      readonly origin: "deterministic" | "independent" | "model-self";
      readonly outcome: "passed" | "failed" | "unavailable";
      readonly score: number;
      readonly adapterId: string;
      readonly adapterVersion: string;
      readonly note: string;
      readonly sourceId: string;
      readonly sourceChecksum: string;
      readonly fresh: boolean;
    }[];
  };
  readonly adoption?: {
    readonly adoptionId: string;
    readonly status: string;
    readonly commandId: string;
    readonly approvalId?: string;
    readonly evaluationRunId: string;
    readonly evaluationInputHash: string;
    readonly beforeVersionId: string;
    readonly beforeChecksum: string;
    readonly afterVersionId?: string;
    readonly afterChecksum?: string;
  };
}

export interface ApplicationQueryMapV1 {
  readonly "workspace.list": { readonly payload: Record<string, never>; readonly data: readonly WorkspaceViewV1[] };
  readonly "workspace.get": { readonly payload: { readonly workspaceId: string }; readonly data: WorkspaceViewV1 };
  readonly "work.index": {
    readonly payload: {
      readonly workspaceId?: string;
      readonly status?: string;
      readonly search?: string;
      readonly cursor?: string;
      readonly limit?: number;
    };
    readonly data: CursorPageV1<WorkSummaryV1>;
  };
  readonly "work.detail": { readonly payload: { readonly workId: string }; readonly data: WorkDetailV1 };
  readonly "inbox.list": { readonly payload: Record<string, never>; readonly data: readonly InboxItemViewV1[] };
  readonly "run.list": { readonly payload: { readonly workId: string }; readonly data: readonly RunViewV1[] };
  readonly "work.activity.list": {
    readonly payload: { readonly workId: string; readonly cursor?: string; readonly limit?: number };
    readonly data: CursorPageV1<WorkActivityViewV1>;
  };
  readonly "work.tasks": { readonly payload: { readonly workId: string }; readonly data: readonly TaskViewV1[] };
  readonly "work.assignments": {
    readonly payload: { readonly workId: string };
    readonly data: readonly AssignmentViewV1[];
  };
  readonly "work.executions": {
    readonly payload: { readonly workId: string };
    readonly data: readonly ExecutionViewV1[];
  };
  readonly "work.artifacts": {
    readonly payload: { readonly workId: string };
    readonly data: readonly ArtifactViewV1[];
  };
  readonly "work.artifact.get": {
    readonly payload: { readonly workId: string; readonly artifactVersionId: string };
    readonly data: ArtifactViewV1;
  };
  readonly "work.verifications": {
    readonly payload: { readonly workId: string };
    readonly data: readonly VerificationViewV1[];
  };
  readonly "work.records": {
    readonly payload: { readonly workId: string };
    readonly data: readonly WorkRecordViewV1[];
  };
  readonly "work.directive.list": {
    readonly payload: { readonly workId: string; readonly runId?: string };
    readonly data: readonly DirectiveViewV1[];
  };
  readonly "governance.approval.list": {
    readonly payload: { readonly workId?: string; readonly status?: string };
    readonly data: readonly ApprovalViewV1[];
  };
  readonly "governance.approval.get": {
    readonly payload: { readonly approvalId: string };
    readonly data: ApprovalViewV1;
  };
  readonly "work.rooms": { readonly payload: { readonly workId: string }; readonly data: readonly RoomViewV1[] };
  readonly "work.messages": {
    readonly payload: { readonly workId: string; readonly roomId: string };
    readonly data: readonly RoomMessageViewV1[];
  };
  readonly "work.shared-contexts": {
    readonly payload: { readonly workId: string };
    readonly data: readonly SharedContextViewV1[];
  };
  readonly "work.knowledge": {
    readonly payload: { readonly workId: string };
    readonly data: WorkKnowledgeViewV1;
  };
  readonly "knowledge.index": {
    readonly payload: { readonly workspaceId: string };
    readonly data: KnowledgeIndexViewV1;
  };
  readonly "knowledge.graph": {
    readonly payload: {
      readonly workspaceId: string;
      readonly lens: KnowledgeGraphLensV1;
      readonly limit?: number;
    };
    readonly data: KnowledgeGraphViewV1;
  };
  readonly "knowledge.links": {
    readonly payload: {
      readonly workspaceId: string;
      readonly nodeId: string;
      readonly limit?: number;
      readonly indexVersionId?: string;
      readonly snapshotChecksum?: string;
      readonly relationIds?: readonly string[];
    };
    readonly data: readonly KnowledgeLinkViewV1[];
  };
  readonly "growth.memories": {
    readonly payload: Record<string, never>;
    readonly data: readonly ExplicitMemoryViewV1[];
  };
  readonly "growth.suggestions": {
    readonly payload: { readonly workId?: string; readonly status?: string; readonly limit?: number };
    readonly data: readonly GrowthSuggestionViewV1[];
  };
  readonly "growth.suggestion.get": {
    readonly payload: { readonly suggestionId: string };
    readonly data: GrowthSuggestionViewV1;
  };
  readonly "organization.graph.snapshot": {
    readonly payload: Record<string, never>;
    readonly data: OrganizationGraphSnapshotV1;
  };
  readonly "governance.autonomy": { readonly payload: Record<string, never>; readonly data: GovernanceAutonomyViewV1 };
  readonly "governance.emergency": {
    readonly payload: Record<string, never>;
    readonly data: EmergencyStateViewV1 | undefined;
  };
  readonly "router.attempts": {
    readonly payload: { readonly limit?: number };
    readonly data: readonly RouteAttemptViewV1[];
  };
  readonly "extension.list": {
    readonly payload: Record<string, never>;
    readonly data: readonly ExtensionInstallationViewV1[];
  };
}

export interface ApplicationCommandMapV1 {
  readonly "workspace.register": { readonly payload: { readonly path: string; readonly name?: string } };
  readonly "workspace.trust": {
    readonly payload: { readonly workspaceId: string; readonly decision: "trusted" | "blocked" };
  };
  readonly "workspace.archive": { readonly payload: { readonly workspaceId: string } };
  readonly "run.start": { readonly payload: { readonly request: StartRunRequestV1 } };
  readonly "run.cancel": { readonly payload: { readonly runId: string } };
  readonly "run.resume": { readonly payload: { readonly runId: string; readonly retryBlocked: true } };
  readonly "work.directive.submit": {
    readonly payload: {
      readonly workId: string;
      readonly runId: string;
      readonly content: string;
      readonly mode: "now" | "next-stage";
    };
  };
  readonly "work.directive.update": {
    readonly payload: {
      readonly workId: string;
      readonly directiveId: string;
      readonly expectedDirectiveRevision: number;
      readonly content: string;
      readonly mode: "now" | "next-stage";
    };
  };
  readonly "work.directive.cancel": {
    readonly payload: {
      readonly workId: string;
      readonly directiveId: string;
      readonly expectedDirectiveRevision: number;
    };
  };
  readonly "approval.decide": {
    readonly payload: {
      readonly approvalId: string;
      readonly expectedApprovalRevision: number;
      readonly vote: "approve" | "reject";
      readonly reason: string;
    };
  };
  readonly "governance.autonomy.set": { readonly payload: { readonly mode: "automatic" | "review" | "full-access" } };
  readonly "governance.emergency.activate": { readonly payload: { readonly reason: string } };
  readonly "governance.emergency.release": {
    readonly payload: { readonly approvalId?: string; readonly reason: string };
  };
  readonly "growth.configure": {
    readonly payload: {
      readonly subject: { readonly type: "organization" };
      readonly reflectionEnabled: boolean;
      readonly adoptionMode: "review" | "auto";
      readonly expectedVersion?: number;
    };
  };
  readonly "growth.memory.put": {
    readonly payload: {
      readonly key: string;
      readonly kind: "fact" | "preference" | "procedure";
      readonly value: string;
    };
  };
  readonly "growth.memory.forget": { readonly payload: { readonly key: string } };
  readonly "growth.suggestion.reject": {
    readonly payload: { readonly suggestionId: string; readonly expectedRevision: number; readonly reason: string };
  };
  readonly "growth.suggestion.approve": {
    readonly payload: { readonly suggestionId: string; readonly expectedRevision: number; readonly reason: string };
  };
  /**
   * 이미 있는 경로의 예산 한도. 지출과 후보는 그대로 두고 한도만 바꿉니다.
   *
   * `router.route.configure`를 여기 쓰지 않습니다 — 그것은 이름과 달리 새 경로를 만들고
   * `spent_micros`를 0으로 리셋하므로, 화면의 「한도 설정」에 연결하면 경로가 중복되고 누적
   * 지출이 사라집니다. 라우터는 예약 시점에 `spent + estimated > total`로 이미 차단합니다.
   */
  readonly "router.route.budget.set": {
    readonly payload: {
      readonly routeId: string;
      readonly requestBudgetMicros: number;
      readonly totalBudgetMicros: number;
    };
  };
  /**
   * 조직 편성. `kind`가 결정하는 판별 합집합이며 도메인의 `OrganizationCommand`를 그대로 투영합니다.
   *
   * 헌법 §9.1은 조직 화면이 「읽기 전용」인 이유로 이 명령이 계약에 없다는 것을 들었습니다.
   * 레지스트리에는 owner + `organization:write`로 살아 있었지만 타입 맵에 없어, 타입이 걸린
   * 클라이언트만 쓰는 데스크톱에서는 부를 수 없었습니다. 유일한 실사용 경로가 CLI였습니다.
   *
   * `expectedRevision`은 현재 Organization Version입니다. 낙관적 잠금이라 화면이 스냅샷에서
   * 읽은 값을 그대로 실어야 하고, 어긋나면 도메인이 거부합니다.
   */
  readonly "organization.command": {
    readonly payload:
      | {
          readonly kind: "create";
          readonly handle: string;
          readonly name: string;
          readonly responsibility: string;
          readonly parentHandle: string;
          readonly scope: "persistent" | "work";
          readonly workId?: string;
          readonly role?: "orchestrator" | "coordinator" | "operator";
          readonly outputs?: readonly string[];
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "activate" | "deactivate" | "retire" | "restore";
          readonly handle: string;
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "move";
          readonly handle: string;
          readonly parentHandle: string;
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "change-role" | "promote";
          readonly handle: string;
          readonly role: "orchestrator" | "coordinator" | "operator";
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "promote-scope";
          readonly handle: string;
          readonly workId: string;
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "split";
          readonly sourceHandle: string;
          readonly newHandle: string;
          readonly name: string;
          readonly responsibility: string;
          readonly childHandles: readonly string[];
          readonly referencePlan: readonly OrganizationReferenceDispositionV1[];
          readonly governanceApprovalId?: string;
        }
      | {
          readonly kind: "merge";
          readonly survivorHandle: string;
          readonly sourceHandle: string;
          readonly referencePlan: readonly OrganizationReferenceDispositionV1[];
          readonly governanceApprovalId?: string;
        }
      | { readonly kind: "revert"; readonly targetVersion: number; readonly governanceApprovalId?: string };
  };
  /**
   * 채택을 되돌립니다. 헌법 4.8은 자가개선 루프의 마지막 걸음으로 «악화되거나 현재 유효 권한
   * 모드에서 적용할 수 없으면 중단하고 되돌린다»를 요구하는데, 이 명령이 타입 계약에 없던 동안
   * 되돌리기는 CLI에만 있었습니다. 채택은 화면에서 하고 취소는 터미널에서 하는 상태였습니다.
   */
  readonly "growth.revert": {
    readonly payload: {
      readonly adoptionId: string;
      readonly suggestionRevision: number;
      readonly reason: string;
      readonly approvalId?: string;
    };
  };
}

export interface ApplicationEventV1 {
  readonly schemaVersion: typeof APPLICATION_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly organizationId: string;
  readonly sequence: number;
  readonly type: string;
  readonly author: { readonly kind: ApplicationAuthorKind; readonly id: string };
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly resource?: ApplicationResourceV1;
  readonly occurredAt: string;
  readonly payload: unknown;
}

const COMMAND_FIELDS = new Set([
  "schemaVersion",
  "commandId",
  "correlationId",
  "operation",
  "expectedRevision",
  "payload",
]);
const RESULT_FIELDS = new Set([
  "schemaVersion",
  "commandId",
  "correlationId",
  "operation",
  "outcome",
  "resource",
  "data",
]);
const EVENT_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "organizationId",
  "sequence",
  "type",
  "author",
  "correlationId",
  "causationId",
  "resource",
  "occurredAt",
  "payload",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const EVENT_CORRELATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u;
const OPERATION = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const MAX_WIRE_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: ReadonlySet<string>, label: string): Record<string, unknown> {
  const candidate = record(value, label);
  const unknown = Object.keys(candidate).find((key) => !fields.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  return candidate;
}

function text(value: unknown, label: string, maximum = 64 * 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} 문자열 길이가 유효하지 않습니다`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const candidate = text(value, label, 128);
  if (!IDENTIFIER.test(candidate)) throw new Error(`${label}가 유효하지 않습니다`);
  return candidate;
}

function opaqueIdentifier(value: unknown, label: string): string {
  const candidate = text(value, label, 128);
  if (!OPAQUE_IDENTIFIER.test(candidate)) throw new Error(`${label}가 유효하지 않습니다`);
  return candidate;
}

function eventCorrelationIdentifier(value: unknown): string {
  const candidate = text(value, "correlationId", 256);
  if (!EVENT_CORRELATION_IDENTIFIER.test(candidate)) throw new Error("correlationId가 유효하지 않습니다");
  return candidate;
}

function operation(value: unknown): string {
  const candidate = text(value, "operation", 128);
  if (!OPERATION.test(candidate)) throw new Error("operation이 유효하지 않습니다");
  return candidate;
}

function revision(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label}이 유효하지 않습니다`);
  return value as number;
}

function validateJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Application wire 값의 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 64 * 1024) {
      throw new Error("Application wire 문자열 상한을 초과했습니다");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Application wire number는 finite여야 합니다");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Application wire 배열 상한을 초과했습니다");
    for (const child of value) validateJson(child, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new Error("Application wire 값은 JSON이어야 합니다");
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Application wire 값에 prototype key를 사용할 수 없습니다");
    }
    validateJson(child, depth + 1);
  }
}

function validateWire(value: unknown): void {
  if (value === undefined) throw new Error("Application wire 값은 JSON이어야 합니다");
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Application wire 값은 JSON으로 직렬화할 수 있어야 합니다");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_WIRE_BYTES) {
    throw new Error("Application wire byte 상한을 초과했습니다");
  }
  validateJson(value);
}

function resource(value: unknown): ApplicationResourceV1 {
  const candidate = exact(value, new Set(["type", "id", "revision"]), "resource");
  const result: ApplicationResourceV1 = {
    type: identifier(candidate.type, "resource.type"),
    id: identifier(candidate.id, "resource.id"),
    ...(candidate.revision === undefined ? {} : { revision: revision(candidate.revision, "resource.revision", 0) }),
  };
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateApplicationCommand(value: unknown): ApplicationCommandV1 {
  validateWire(value);
  const candidate = exact(value, COMMAND_FIELDS, "Application command");
  if (candidate.schemaVersion !== APPLICATION_SCHEMA_VERSION)
    throw new Error("Application schemaVersion이 유효하지 않습니다");
  const result: ApplicationCommandV1 = {
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    commandId: opaqueIdentifier(candidate.commandId, "commandId"),
    correlationId: opaqueIdentifier(candidate.correlationId, "correlationId"),
    operation: operation(candidate.operation),
    ...(candidate.expectedRevision === undefined
      ? {}
      : { expectedRevision: revision(candidate.expectedRevision, "expectedRevision", 0) }),
    payload: candidate.payload,
  };
  validateJson(result.payload);
  return deepFreeze(result);
}

export function validateApplicationResult(value: unknown): ApplicationCommandResultV1 {
  validateWire(value);
  const candidate = exact(value, RESULT_FIELDS, "Application result");
  if (candidate.schemaVersion !== APPLICATION_SCHEMA_VERSION)
    throw new Error("Application schemaVersion이 유효하지 않습니다");
  if (!(["succeeded", "accepted", "awaiting-approval", "blocked"] as const).includes(candidate.outcome as never)) {
    throw new Error("Application result outcome이 유효하지 않습니다");
  }
  const result: ApplicationCommandResultV1 = {
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    commandId: opaqueIdentifier(candidate.commandId, "commandId"),
    correlationId: opaqueIdentifier(candidate.correlationId, "correlationId"),
    operation: operation(candidate.operation),
    outcome: candidate.outcome as ApplicationCommandOutcome,
    ...(candidate.resource === undefined ? {} : { resource: resource(candidate.resource) }),
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
  };
  if (result.data !== undefined) validateJson(result.data);
  return deepFreeze(result);
}

export function validateApplicationEvent(value: unknown): ApplicationEventV1 {
  validateWire(value);
  const candidate = exact(value, EVENT_FIELDS, "Application event");
  if (candidate.schemaVersion !== APPLICATION_EVENT_SCHEMA_VERSION) {
    throw new Error("Application event schemaVersion이 유효하지 않습니다");
  }
  const author = exact(candidate.author, new Set(["kind", "id"]), "event.author");
  if (!(["user", "agent", "system"] as const).includes(author.kind as never)) {
    throw new Error("event.author.kind가 유효하지 않습니다");
  }
  const occurredAt = text(candidate.occurredAt, "occurredAt", 64);
  if (new Date(occurredAt).toISOString() !== occurredAt) throw new Error("occurredAt이 ISO datetime이 아닙니다");
  const result: ApplicationEventV1 = {
    schemaVersion: APPLICATION_EVENT_SCHEMA_VERSION,
    eventId: opaqueIdentifier(candidate.eventId, "eventId"),
    organizationId: identifier(candidate.organizationId, "organizationId"),
    sequence: revision(candidate.sequence, "sequence", 1),
    type: operation(candidate.type),
    author: { kind: author.kind as ApplicationAuthorKind, id: identifier(author.id, "event.author.id") },
    ...(candidate.correlationId === undefined
      ? {}
      : { correlationId: eventCorrelationIdentifier(candidate.correlationId) }),
    ...(candidate.causationId === undefined
      ? {}
      : { causationId: opaqueIdentifier(candidate.causationId, "causationId") }),
    ...(candidate.resource === undefined ? {} : { resource: resource(candidate.resource) }),
    occurredAt,
    payload: candidate.payload,
  };
  validateJson(result.payload);
  return deepFreeze(result);
}
