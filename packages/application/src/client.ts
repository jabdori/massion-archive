import {
  APPLICATION_SCHEMA_VERSION,
  validateApplicationCommand,
  validateApplicationResult,
  type ApplicationCommandMapV1,
  type ApplicationCommandResultV1,
  type ApplicationQueryMapV1,
} from "./contracts.js";

// 에이전트 정체성은 표면끼리 같아야 하므로 client 진입점에서도 같은 모듈을 씁니다.
// design-tokens.ts는 import가 없는 순수 모듈이라 브라우저 번들에 서버 의존성을 끌어오지 않습니다.
// 이 진입점은 무엇을 노출하는지 명시합니다. wildcard re-export는 client.test.ts가 막습니다.
export { AGENT_CALL_SIGNS, agentIdentityToken, agentRoleToken, growthTargetToken } from "./design-tokens.js";
export type { AgentIdentityToken, AgentRoleToken, GrowthTargetToken } from "./design-tokens.js";

export type {
  ApplicationCommandMapV1,
  ApplicationCommandResultV1,
  ApplicationQueryMapV1,
  ApprovalViewV1,
  ArtifactViewV1,
  AssignmentViewV1,
  CursorPageV1,
  DirectiveViewV1,
  ExplicitMemoryEntryViewV1,
  ExplicitMemoryViewV1,
  ExtensionCapabilityViewV1,
  ExtensionInstallationViewV1,
  ExecutionViewV1,
  GovernanceAutonomyViewV1,
  GrowthSuggestionViewV1,
  KnowledgeGraphEdgeViewV1,
  KnowledgeGraphLensV1,
  KnowledgeGraphViewV1,
  KnowledgeIndexViewV1,
  KnowledgeLinkViewV1,
  KnowledgeNodeKindV1,
  KnowledgeNodeViewV1,
  KnowledgeReferenceViewV1,
  KnowledgeReferenceProvenanceViewV1,
  KnowledgeRelationKindV1,
  OrganizationGraphSnapshotV1,
  OrganizationReferenceDispositionV1,
  OptimizationEvaluationPreflightViewV1,
  ProviderDiscoveredModelViewV1,
  ProviderModelCatalogStatusViewV1,
  RouteAttemptViewV1,
  RouterCatalogViewV1,
  RoomMessageTypeV1,
  RoomMessageViewV1,
  RoomViewV1,
  SharedContextViewV1,
  OrganizationNodeViewV1,
  RunViewV1,
  StartRunRequestV1,
  TaskViewV1,
  VerificationViewV1,
  WorkActivityViewV1,
  WorkDetailV1,
  WorkKnowledgeViewV1,
  WorkRecordViewV1,
  WorkSummaryV1,
  WorkspaceViewV1,
} from "./contracts.js";

export interface ApplicationClientTransport {
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
}

type QueryPayload<Operation extends keyof ApplicationQueryMapV1> = ApplicationQueryMapV1[Operation]["payload"];
type QueryData<Operation extends keyof ApplicationQueryMapV1> = ApplicationQueryMapV1[Operation]["data"];
type CommandPayload<Operation extends keyof ApplicationCommandMapV1> = ApplicationCommandMapV1[Operation]["payload"];

function queryData<Operation extends keyof ApplicationQueryMapV1>(
  expectedOperation: Operation,
  value: unknown,
): QueryData<Operation> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application query 응답이 유효하지 않습니다");
  const response = value as { schemaVersion?: unknown; operation?: unknown; data?: unknown };
  if (response.schemaVersion !== APPLICATION_SCHEMA_VERSION || response.operation !== expectedOperation) {
    throw new Error("Application query 응답 schemaVersion 또는 operation이 일치하지 않습니다");
  }
  if (!("data" in response)) throw new Error("Application query 응답 data가 없습니다");
  return response.data as QueryData<Operation>;
}

export class ApplicationClient {
  public constructor(
    private readonly transport: ApplicationClientTransport,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  public async query<Operation extends keyof ApplicationQueryMapV1>(
    operation: Operation,
    payload: QueryPayload<Operation>,
  ): Promise<QueryData<Operation>> {
    return queryData(operation, await this.transport.query(operation, payload));
  }

  public async command<Operation extends keyof ApplicationCommandMapV1>(
    operation: Operation,
    payload: CommandPayload<Operation>,
    options: { readonly commandId?: string; readonly correlationId?: string; readonly expectedRevision?: number } = {},
  ): Promise<ApplicationCommandResultV1> {
    const commandId = options.commandId ?? this.createId();
    const correlationId = options.correlationId ?? this.createId();
    const command = validateApplicationCommand({
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      commandId,
      correlationId,
      operation,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      payload,
    });
    const result = validateApplicationResult(await this.transport.command(command));
    if (result.operation !== operation || result.commandId !== commandId || result.correlationId !== correlationId) {
      throw new Error("Application command 응답 계보가 일치하지 않습니다");
    }
    return result;
  }
}
