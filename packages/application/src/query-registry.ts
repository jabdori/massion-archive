import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { ExtensionGateway } from "@massion/extension-host";
import type { AssuranceBindingStore } from "@massion/assurance";
import {
  normalizeRepositoryPath,
  type EvidenceRepository,
  type IndexConfiguration,
  type IndexSnapshot,
  type IndexVersion,
} from "@massion/evidence";
import type { GrowthGateway, GrowthSuggestionDetails } from "@massion/growth";
import type { EmergencyControl } from "@massion/governance";
import type { MembershipRole, OrganizationService, TenantContext } from "@massion/identity";
import type { ModelRouter, ProviderService } from "@massion/router";
import {
  isOptimizationRoleKey,
  type ModelOptimizationStore,
  type OptimizationBatchService,
} from "@massion/model-optimization";
import type { RuntimeExecutionStore } from "@massion/runtime";
import type { WorkspaceService, WorkspaceView } from "@massion/workspace";

import { projectWorkTimeline, type WorkTimelineSources } from "./timeline.js";

import { ApplicationError } from "./errors.js";
import { ApplicationEventCursorExpiredError, type ApplicationEventStore } from "./event-store.js";
import type {
  ApplicationApprovalSource,
  ApplicationArtifactSource,
  ApplicationDirectiveSource,
  ApplicationExecutionSource,
  ApplicationReadModel,
  ApplicationVerificationSource,
} from "./read-model.js";
import type { ApplicationRunStore, ApplicationRunView } from "./run-store.js";
import type { CollaborationGraphSnapshot, CollaborationGraphSnapshotProjector } from "./snapshot.js";
import { ASSURANCE_VERIFIER_REJECTED, blockedDetailFromResult } from "./blocked-detail.js";
import type {
  SubscriptionAccountQueries,
  SubscriptionConnectorQueries,
  SubscriptionPolicyStore,
  SubscriptionPolicyView,
  SubscriptionProviderDirectory,
  SubscriptionProviderView,
  SubscriptionQuotaQueries,
} from "./subscription-operations.js";
import { BuiltinSubscriptionProviderDirectory } from "./subscription-operations.js";
import {
  runtimeSubscriptionLineage,
  runtimeSubscriptionLineagesByCorrelation,
} from "./runtime-subscription-lineage.js";
import type {
  KnowledgeGraphEdgeViewV1,
  KnowledgeGraphLensV1,
  KnowledgeGraphViewV1,
  KnowledgeIndexViewV1,
  KnowledgeLinkViewV1,
  KnowledgeNodeKindV1,
  KnowledgeNodeViewV1,
  KnowledgeRelationKindV1,
  WorkKnowledgeViewV1,
  ExtensionCapabilityViewV1,
  ExtensionInstallationViewV1,
} from "./contracts.js";

export interface ApplicationQueryResultV1 {
  readonly schemaVersion: "massion.application.v1";
  readonly operation: string;
  readonly data: unknown;
}

export interface ApplicationQueryDescriptor<Payload = unknown> {
  readonly operation: string;
  readonly requiredScopes: readonly string[];
  readonly allowedRoles: readonly MembershipRole[];
  validate(payload: unknown): Payload;
  handle(context: TenantContext, payload: Payload): Promise<unknown>;
}

export interface ApplicationQueryDependencies {
  readonly readModel: ApplicationReadModel;
  readonly runs?: Pick<ApplicationRunStore, "get"> & {
    listByWork?(context: TenantContext, workId: string): Promise<readonly ApplicationRunView[]>;
    listBlocked?(context: TenantContext): Promise<readonly ApplicationRunView[]>;
  };
  readonly snapshot?: CollaborationGraphSnapshotProjector;
  readonly runtime?: Pick<RuntimeExecutionStore, "listEvents" | "getRecovery" | "listByCorrelation">;
  readonly assuranceBindings?: Pick<AssuranceBindingStore, "get" | "getActive">;
  readonly extension?: Pick<ExtensionGateway, "list">;
  readonly growth?: Pick<
    GrowthGateway,
    | "resolveConfiguration"
    | "getActiveEvaluationStrategy"
    | "getActiveExplicitMemory"
    | "listSuggestions"
    | "getSuggestionDetails"
    | "listEffectEvaluations"
  > & { readonly listSuggestionDetails?: GrowthGateway["listSuggestionDetails"] };
  readonly memberships?: Pick<OrganizationService, "listMembers">;
  readonly workspaces?: Pick<WorkspaceService, "list" | "get">;
  readonly workTimeline?: WorkTimelineSources;
  readonly workKnowledge?: {
    get(context: TenantContext, workId: string): Promise<WorkKnowledgeViewV1>;
    getWorkspaceSnapshot?(
      context: TenantContext,
      workspaceId: string,
      selector?: { readonly indexVersionId: string; readonly snapshotChecksum: string },
    ): Promise<
      | {
          readonly repository: EvidenceRepository;
          readonly index: IndexVersion;
          readonly configuration: IndexConfiguration;
          readonly snapshot: IndexSnapshot;
        }
      | undefined
    >;
  };
  readonly autonomy?: { get(context: TenantContext): Promise<{ readonly mode: string; readonly revision: number }> };
  readonly emergency?: Pick<EmergencyControl, "get">;
  readonly provenance?: {
    listByWork(
      context: TenantContext,
      workId: string,
    ): Promise<
      readonly {
        readonly deliveryId: string;
        readonly taskId: string;
        readonly agentHandle: string;
        readonly status: string;
        readonly branchRef?: string;
        readonly commitSha?: string;
        readonly createdAt: unknown;
      }[]
    >;
  };
  readonly audit?: Pick<ApplicationEventStore, "read">;
  readonly providers?: Pick<ProviderService, "listProviders" | "listEndpoints" | "listCredentials">;
  readonly router?: Pick<ModelRouter, "listModels" | "listRoutes" | "listCandidates" | "listAttempts" | "readAttempt">;
  readonly status?: (context: TenantContext) => Promise<unknown>;
  readonly subscriptionAccounts?: SubscriptionAccountQueries;
  readonly subscriptionConnectors?: SubscriptionConnectorQueries;
  readonly subscriptionProviders?: SubscriptionProviderDirectory;
  readonly subscriptionQuota?: SubscriptionQuotaQueries;
  readonly subscriptionPolicy?: SubscriptionPolicyStore;
  readonly optimization?: {
    readonly evaluations: Pick<
      ModelOptimizationStore,
      "getActivePolicy" | "listReceipts" | "listRecommendations" | "hasEvaluationRun"
    >;
    readonly batches: Pick<OptimizationBatchService, "getActiveBatch" | "listObservations" | "hasBatch">;
  };
}

function publicRun(run: ApplicationRunView): Record<string, unknown> {
  const blockedDetail =
    run.status === "blocked" && run.blockedReason === ASSURANCE_VERIFIER_REJECTED
      ? blockedDetailFromResult(run.result)
      : undefined;
  return {
    runId: run.runId,
    ...(run.workId === undefined ? {} : { workId: run.workId }),
    stage: run.stage,
    status: run.status,
    ...(run.approvalId === undefined ? {} : { approvalId: run.approvalId }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
    ...(blockedDetail === undefined ? {} : { blockedDetail }),
    leaseGeneration: run.leaseGeneration,
    ...(run.createdAt === undefined ? {} : { createdAt: run.createdAt }),
    ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }),
  };
}

function publicWorkKnowledge(view: WorkKnowledgeViewV1): WorkKnowledgeViewV1 {
  return {
    workId: view.workId,
    status: view.status,
    ...(view.repositoryId === undefined ? {} : { repositoryId: view.repositoryId }),
    ...(view.repositoryRevisionId === undefined ? {} : { repositoryRevisionId: view.repositoryRevisionId }),
    ...(view.indexVersionId === undefined ? {} : { indexVersionId: view.indexVersionId }),
    ...(view.evidenceBriefId === undefined ? {} : { evidenceBriefId: view.evidenceBriefId }),
    ...(view.snapshotChecksum === undefined ? {} : { snapshotChecksum: view.snapshotChecksum }),
    ...(view.evidenceBriefChecksum === undefined ? {} : { evidenceBriefChecksum: view.evidenceBriefChecksum }),
    ...(view.freshnessStatus === undefined ? {} : { freshnessStatus: view.freshnessStatus }),
    ...(view.query === undefined ? {} : { query: view.query }),
    references: view.references.map((reference) => ({
      referenceId: reference.referenceId,
      kind: reference.kind,
      ...(reference.nodeId === undefined ? {} : { nodeId: reference.nodeId }),
      relativePath: reference.relativePath,
      ...(reference.qualifiedName === undefined ? {} : { qualifiedName: reference.qualifiedName }),
      startLine: reference.startLine,
      endLine: reference.endLine,
      contentHash: reference.contentHash,
      ...(reference.provenance === undefined
        ? {}
        : {
            provenance: {
              selection: reference.provenance.selection,
              snapshotChecksum: reference.provenance.snapshotChecksum,
              paths: reference.provenance.paths.map((path) => ({
                seed: {
                  referenceId: path.seed.referenceId,
                  kind: path.seed.kind,
                  ...(path.seed.symbolKey === undefined ? {} : { symbolKey: path.seed.symbolKey }),
                },
                ...(path.relation === undefined
                  ? {}
                  : {
                      relation: {
                        relationId: path.relation.relationId,
                        relationKey: path.relation.relationKey,
                        kind: path.relation.kind,
                        ...(path.relation.sourceSymbolKey === undefined
                          ? {}
                          : { sourceSymbolKey: path.relation.sourceSymbolKey }),
                        ...(path.relation.targetSymbolKey === undefined
                          ? {}
                          : { targetSymbolKey: path.relation.targetSymbolKey }),
                        targetText: path.relation.targetText,
                        resolved: path.relation.resolved,
                        relativePath: path.relation.relativePath,
                        startLine: path.relation.startLine,
                      },
                    }),
              })),
            },
          }),
    })),
    ...(view.failureReason === undefined ? {} : { failureReason: view.failureReason }),
  };
}

const KNOWLEDGE_RELATION_KINDS = new Set<KnowledgeRelationKindV1>([
  "contains",
  "imports",
  "calls",
  "implements",
  "documents",
]);
const KNOWLEDGE_GRAPH_LENSES = new Set<KnowledgeGraphLensV1>([
  "work",
  "document",
  "file",
  "symbol",
  "artifact",
  "agent",
]);
const KNOWLEDGE_DOCUMENT_EXTENSIONS = new Set([".adoc", ".md", ".mdx", ".rst", ".txt"]);
const KNOWLEDGE_INSTANT =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

type WorkspaceKnowledgeSnapshotReader = NonNullable<
  NonNullable<ApplicationQueryDependencies["workKnowledge"]>["getWorkspaceSnapshot"]
>;
type WorkspaceKnowledgeSnapshot = NonNullable<Awaited<ReturnType<WorkspaceKnowledgeSnapshotReader>>>;

interface KnowledgeProjection {
  readonly index: KnowledgeIndexViewV1;
  readonly nodes: ReadonlyMap<string, KnowledgeNodeViewV1>;
  readonly edges: readonly KnowledgeGraphEdgeViewV1[];
  readonly nonCanonicalNodeIds: ReadonlySet<string>;
}

type KnowledgeProjectionRequest =
  | { readonly kind: "graph"; readonly lens: KnowledgeGraphLensV1; readonly limit: number }
  | {
      readonly kind: "links";
      readonly nodeId: string;
      readonly limit: number;
      readonly indexVersionId?: string;
      readonly snapshotChecksum?: string;
      readonly relationIds?: readonly string[];
    };

const MAX_KNOWLEDGE_WORKS = 200;

function knowledgeSourceId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`Knowledge ${label} 계보가 유효하지 않습니다`);
  return value;
}

function knowledgeNodeId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new Error("Knowledge node ID가 유효하지 않습니다");
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator) as KnowledgeNodeKindV1;
  const sourceId = value.slice(separator + 1);
  if (!new Set<KnowledgeNodeKindV1>(["symbol", "file", "document", "work", "artifact", "agent"]).has(kind))
    throw new Error("Knowledge node ID가 유효하지 않습니다");
  knowledgeSourceId(sourceId, "node source ID");
  return value;
}

function knowledgeDisplayText(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  )
    throw new Error(`Knowledge ${label}이(가) 유효하지 않습니다`);
  return value;
}

function knowledgeShortLabel(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Knowledge Work label이 유효하지 않습니다");
  const firstLine = value.trim().split(/\r?\n/u, 1)[0]?.trim();
  return firstLine ? Array.from(firstLine).slice(0, 128).join("") : fallback;
}

function knowledgeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024)
    throw new Error("Knowledge 상대 경로 계보가 유효하지 않습니다");
  if (normalizeRepositoryPath(value) !== value) throw new Error("Knowledge 상대 경로 계보가 유효하지 않습니다");
  return value;
}

function knowledgeHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`Knowledge ${label} 계보가 유효하지 않습니다`);
  return value;
}

function knowledgeLine(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`Knowledge ${label} 계보가 유효하지 않습니다`);
  return value as number;
}

function knowledgeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Knowledge ${label} 계보가 유효하지 않습니다`);
  return value as number;
}

function knowledgeInstant(value: unknown): string {
  let serialized: unknown;
  try {
    serialized =
      typeof value === "string"
        ? value
        : value instanceof Date
          ? value.toISOString()
          : value !== null &&
              typeof value === "object" &&
              "toISOString" in value &&
              typeof value.toISOString === "function"
            ? (value as { toISOString: () => unknown }).toISOString()
            : undefined;
  } catch {
    throw new Error("Knowledge 색인 시각 계보가 유효하지 않습니다");
  }
  if (typeof serialized !== "string" || !KNOWLEDGE_INSTANT.test(serialized))
    throw new Error("Knowledge 색인 시각 계보가 유효하지 않습니다");
  const parsed = new Date(serialized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== serialized)
    throw new Error("Knowledge 색인 시각 계보가 유효하지 않습니다");
  return serialized;
}

function knowledgeExcluded(configuration: IndexConfiguration): readonly string[] {
  if (!configuration.settings || typeof configuration.settings !== "object" || Array.isArray(configuration.settings))
    throw new Error("Knowledge 색인 설정 계보가 유효하지 않습니다");
  const exclude = (configuration.settings as { readonly exclude?: unknown }).exclude;
  if (exclude === undefined) return [];
  if (!Array.isArray(exclude) || exclude.length > 100) throw new Error("Knowledge 제외 규칙 계보가 유효하지 않습니다");
  const values = exclude.map((item) => {
    if (
      typeof item !== "string" ||
      item.trim() !== item ||
      item.length === 0 ||
      item.length > 256 ||
      item.startsWith("/") ||
      /^[A-Za-z]:|\\|(?:^|\/)\.\.(?:\/|$)|[\0\r\n]/u.test(item)
    )
      throw new Error("Knowledge 제외 규칙 계보가 유효하지 않습니다");
    return item;
  });
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function knowledgeIndexView(
  context: TenantContext,
  workspaceId: string,
  source: WorkspaceKnowledgeSnapshot | undefined,
  selector?: { readonly indexVersionId: string; readonly snapshotChecksum: string },
): KnowledgeIndexViewV1 {
  if (!source) {
    return { workspaceId, status: "none", fileCount: 0, symbolCount: 0, relationCount: 0, excluded: [] };
  }
  const { repository, index, configuration, snapshot } = source;
  const fileCount = knowledgeCount(index.fileCount, "file count");
  const symbolCount = knowledgeCount(index.symbolCount, "symbol count");
  const relationCount = knowledgeCount(index.relationCount, "relation count");
  const chunkCount = knowledgeCount(index.chunkCount, "chunk count");
  if (
    repository.organizationId !== context.organizationId ||
    repository.workspaceId !== workspaceId ||
    repository.status !== "active" ||
    index.organizationId !== context.organizationId ||
    index.repositoryId !== repository.repositoryId ||
    configuration.organizationId !== context.organizationId ||
    configuration.repositoryId !== repository.repositoryId ||
    configuration.configurationId !== index.configurationId ||
    configuration.checksum !== index.configurationChecksum ||
    snapshot.indexVersionId !== index.indexVersionId ||
    snapshot.checksum !== index.snapshotChecksum ||
    snapshot.files.length !== fileCount ||
    snapshot.symbols.length !== symbolCount ||
    snapshot.relations.length !== relationCount ||
    snapshot.chunks.length !== chunkCount
  ) {
    throw new Error("Knowledge workspace·repository·index 계보가 일치하지 않습니다");
  }
  if (
    selector === undefined
      ? repository.currentIndexVersionId !== index.indexVersionId || index.status !== "complete" || !index.current
      : selector.indexVersionId !== index.indexVersionId ||
        selector.snapshotChecksum !== snapshot.checksum ||
        !["complete", "superseded"].includes(index.status)
  ) {
    throw new Error("Knowledge workspace의 선택한 frozen index 계보가 일치하지 않습니다");
  }
  knowledgeSourceId(repository.repositoryId, "repository ID");
  knowledgeSourceId(index.indexVersionId, "index ID");
  knowledgeHash(index.configurationChecksum, "configuration checksum");
  knowledgeHash(index.snapshotChecksum, "snapshot checksum");
  return {
    workspaceId,
    status: "ready",
    indexVersionId: index.indexVersionId,
    fileCount,
    symbolCount,
    relationCount,
    ...(index.completedAt === undefined ? {} : { indexedAt: knowledgeInstant(index.completedAt) }),
    excluded: knowledgeExcluded(configuration),
  };
}

function knowledgeNodeKindForPath(relativePath: string): Extract<KnowledgeNodeKindV1, "file" | "document"> {
  return KNOWLEDGE_DOCUMENT_EXTENSIONS.has(posix.extname(relativePath).toLocaleLowerCase()) ? "document" : "file";
}

function knowledgeNode(
  kind: KnowledgeNodeKindV1,
  sourceId: string,
  label: string,
  detail?: string,
  group?: string,
): KnowledgeNodeViewV1 {
  const nodeId = `${kind}:${knowledgeSourceId(sourceId, `${kind} ID`)}`;
  return {
    nodeId,
    kind,
    label: knowledgeDisplayText(label, `${kind} label`),
    ...(detail === undefined ? {} : { detail: knowledgeDisplayText(detail, `${kind} detail`, 1_024) }),
    ...(group === undefined ? {} : { group: knowledgeDisplayText(group, `${kind} group`, 1_024) }),
  };
}

function addKnowledgeNode(nodes: Map<string, KnowledgeNodeViewV1>, node: KnowledgeNodeViewV1): void {
  const existing = nodes.get(node.nodeId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(node))
    throw new Error(`Knowledge node 계보가 모호합니다: ${node.nodeId}`);
  nodes.set(node.nodeId, node);
}

function addKnowledgeEdge(edges: Map<string, KnowledgeGraphEdgeViewV1>, edge: KnowledgeGraphEdgeViewV1): void {
  if (edge.sourceId === edge.targetId) return;
  const key = [
    edge.kind,
    edge.sourceId,
    edge.targetId,
    edge.unresolved ? "1" : "0",
    edge.derivedVia ?? "",
    edge.relationId ?? "",
  ].join("\0");
  edges.set(key, edge);
}

function compareKnowledgeNode(left: KnowledgeNodeViewV1, right: KnowledgeNodeViewV1): number {
  return left.nodeId.localeCompare(right.nodeId);
}

function compareKnowledgeEdge(left: KnowledgeGraphEdgeViewV1, right: KnowledgeGraphEdgeViewV1): number {
  return (
    left.sourceId.localeCompare(right.sourceId) ||
    left.targetId.localeCompare(right.targetId) ||
    left.kind.localeCompare(right.kind) ||
    (left.derivedVia ?? "").localeCompare(right.derivedVia ?? "") ||
    (left.relationId ?? "").localeCompare(right.relationId ?? "")
  );
}

async function projectKnowledge(
  dependencies: ApplicationQueryDependencies,
  context: TenantContext,
  workspaceId: string,
  source: WorkspaceKnowledgeSnapshot | undefined,
  request: KnowledgeProjectionRequest,
): Promise<KnowledgeProjection> {
  const selector =
    request.kind === "links" && request.indexVersionId !== undefined && request.snapshotChecksum !== undefined
      ? { indexVersionId: request.indexVersionId, snapshotChecksum: request.snapshotChecksum }
      : undefined;
  const index = knowledgeIndexView(context, workspaceId, source, selector);
  if (!source) return { index, nodes: new Map(), edges: [], nonCanonicalNodeIds: new Set() };
  const nodes = new Map<string, KnowledgeNodeViewV1>();
  const edges = new Map<string, KnowledgeGraphEdgeViewV1>();
  const nonCanonicalNodeIds = new Set<string>();
  const filesById = new Map<string, IndexSnapshot["files"][number]>();
  const fileIdsByPath = new Map<string, string>();
  const fileNodesById = new Map<string, KnowledgeNodeViewV1>();
  const symbolsById = new Map<string, IndexSnapshot["symbols"][number]>();
  const symbolsByKey = new Map<string, IndexSnapshot["symbols"][number]>();
  const chunksById = new Map<string, IndexSnapshot["chunks"][number]>();
  const relationIds = new Set<string>();
  const relationKeys = new Set<string>();

  for (const file of source.snapshot.files) {
    const sourceFileId = knowledgeSourceId(file.sourceFileId, "source file ID");
    const relativePath = knowledgeRelativePath(file.relativePath);
    knowledgeHash(file.contentHash, "file content hash");
    if (filesById.has(sourceFileId) || fileIdsByPath.has(relativePath))
      throw new Error(`Knowledge file 계보가 모호합니다: ${sourceFileId}`);
    filesById.set(sourceFileId, file);
    fileIdsByPath.set(relativePath, sourceFileId);
    const kind = knowledgeNodeKindForPath(relativePath);
    const directory = posix.dirname(relativePath);
    const node = knowledgeNode(
      kind,
      sourceFileId,
      posix.basename(relativePath),
      relativePath,
      directory === "." ? undefined : directory,
    );
    fileNodesById.set(sourceFileId, node);
    addKnowledgeNode(nodes, node);
  }

  for (const symbol of source.snapshot.symbols) {
    const symbolId = knowledgeSourceId(symbol.symbolId, "symbol ID");
    const symbolKey = knowledgeSourceId(symbol.symbolKey, "symbol key");
    const file = filesById.get(knowledgeSourceId(symbol.sourceFileId, "symbol source file ID"));
    const relativePath = knowledgeRelativePath(symbol.relativePath);
    if (!file || file.relativePath !== relativePath)
      throw new Error(`Knowledge symbol→file 계보가 끊겼습니다: ${symbolId}`);
    if (symbolsById.has(symbolId) || symbolsByKey.has(symbolKey))
      throw new Error(`Knowledge symbol 계보가 모호합니다: ${symbolId}`);
    knowledgeHash(symbol.contentHash, "symbol content hash");
    const startLine = knowledgeLine(symbol.startLine, "symbol start line");
    const endLine = knowledgeLine(symbol.endLine, "symbol end line");
    if (endLine < startLine) throw new Error(`Knowledge symbol line 계보가 유효하지 않습니다: ${symbolId}`);
    symbolsById.set(symbolId, symbol);
    symbolsByKey.set(symbolKey, symbol);
    const node = knowledgeNode(
      "symbol",
      symbolId,
      knowledgeShortLabel(symbol.qualifiedName, symbolId),
      `${relativePath}:${String(startLine)}`,
    );
    addKnowledgeNode(nodes, node);
    addKnowledgeEdge(edges, {
      kind: "contains",
      sourceId: fileNodesById.get(symbol.sourceFileId)?.nodeId ?? "",
      targetId: node.nodeId,
    });
  }

  for (const chunk of source.snapshot.chunks) {
    const chunkId = knowledgeSourceId(chunk.chunkId, "chunk ID");
    const file = filesById.get(knowledgeSourceId(chunk.sourceFileId, "chunk source file ID"));
    const relativePath = knowledgeRelativePath(chunk.relativePath);
    if (!file || file.relativePath !== relativePath)
      throw new Error(`Knowledge chunk→file 계보가 끊겼습니다: ${chunkId}`);
    if (chunksById.has(chunkId) || symbolsById.has(chunkId))
      throw new Error(`Knowledge reference 계보가 모호합니다: ${chunkId}`);
    if (chunk.symbolKey !== undefined) {
      const symbol = symbolsByKey.get(knowledgeSourceId(chunk.symbolKey, "chunk symbol key"));
      if (!symbol || symbol.sourceFileId !== chunk.sourceFileId)
        throw new Error(`Knowledge chunk→symbol 계보가 끊겼습니다: ${chunkId}`);
    }
    knowledgeHash(chunk.contentHash, "chunk content hash");
    const startLine = knowledgeLine(chunk.startLine, "chunk start line");
    const endLine = knowledgeLine(chunk.endLine, "chunk end line");
    if (endLine < startLine) throw new Error(`Knowledge chunk line 계보가 유효하지 않습니다: ${chunkId}`);
    chunksById.set(chunkId, chunk);
  }

  for (const relation of source.snapshot.relations) {
    const relationId = knowledgeSourceId(relation.relationId, "relation ID");
    const relationKey = knowledgeSourceId(relation.relationKey, "relation key");
    if (relationIds.has(relationId) || relationKeys.has(relationKey))
      throw new Error(`Knowledge relation 계보가 모호합니다: ${relationId}`);
    relationIds.add(relationId);
    relationKeys.add(relationKey);
    const kind = relation.kind;
    if (!KNOWLEDGE_RELATION_KINDS.has(kind))
      throw new Error(`Knowledge relation 종류가 유효하지 않습니다: ${relationId}`);
    const sourceFile = filesById.get(knowledgeSourceId(relation.sourceFileId, "relation source file ID"));
    const relationPath = knowledgeRelativePath(relation.relativePath);
    const relationLine = knowledgeLine(relation.startLine, "relation source line");
    if (!sourceFile || sourceFile.relativePath !== relationPath)
      throw new Error(`Knowledge relation→file 계보가 끊겼습니다: ${relationId}`);
    const sourceSymbol =
      relation.sourceSymbolKey === undefined
        ? undefined
        : symbolsByKey.get(knowledgeSourceId(relation.sourceSymbolKey, "relation source symbol key"));
    const targetSymbol =
      relation.targetSymbolKey === undefined
        ? undefined
        : symbolsByKey.get(knowledgeSourceId(relation.targetSymbolKey, "relation target symbol key"));
    if (
      relation.sourceSymbolKey !== undefined &&
      (!sourceSymbol || sourceSymbol.sourceFileId !== relation.sourceFileId)
    )
      throw new Error(`Knowledge relation source 계보가 끊겼습니다: ${relationId}`);
    if (relation.targetSymbolKey !== undefined && !targetSymbol)
      throw new Error(`Knowledge relation target 계보가 끊겼습니다: ${relationId}`);
    if (!relation.resolved) {
      if (targetSymbol) throw new Error(`Knowledge unresolved relation 계보가 모호합니다: ${relationId}`);
      const sourceNode = sourceSymbol
        ? nodes.get(`symbol:${sourceSymbol.symbolId}`)
        : fileNodesById.get(relation.sourceFileId);
      if (!sourceNode) throw new Error(`Knowledge unresolved relation source 계보가 끊겼습니다: ${relationId}`);
      const placeholder = knowledgeNode("symbol", `unresolved.${relationId}`, "색인 밖 대상");
      addKnowledgeNode(nodes, placeholder);
      nonCanonicalNodeIds.add(placeholder.nodeId);
      addKnowledgeEdge(edges, {
        kind,
        sourceId: sourceNode.nodeId,
        targetId: placeholder.nodeId,
        unresolved: true,
        relationId,
        relationKey,
        ...(relation.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: relation.sourceSymbolKey }),
        snapshotChecksum: source.snapshot.checksum,
        sourcePath: relationPath,
        sourceLine: relationLine,
      });
      continue;
    }
    if (!targetSymbol) throw new Error(`Knowledge resolved relation 계보가 끊겼습니다: ${relationId}`);
    const relationSourceNode = sourceSymbol
      ? nodes.get(`symbol:${sourceSymbol.symbolId}`)
      : fileNodesById.get(relation.sourceFileId);
    if (!relationSourceNode) throw new Error(`Knowledge relation source node 계보가 끊겼습니다: ${relationId}`);
    addKnowledgeEdge(edges, {
      kind,
      sourceId: relationSourceNode.nodeId,
      targetId: `symbol:${targetSymbol.symbolId}`,
      relationId,
      relationKey,
      ...(relation.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: relation.sourceSymbolKey }),
      ...(relation.targetSymbolKey === undefined ? {} : { targetSymbolKey: relation.targetSymbolKey }),
      snapshotChecksum: source.snapshot.checksum,
      sourcePath: relationPath,
      sourceLine: relationLine,
    });
    const sourceNode = fileNodesById.get(relation.sourceFileId);
    const targetNode = fileNodesById.get(targetSymbol.sourceFileId);
    if (!sourceNode || !targetNode) throw new Error(`Knowledge relation node 계보가 끊겼습니다: ${relationId}`);
    addKnowledgeEdge(edges, {
      kind,
      sourceId: sourceNode.nodeId,
      targetId: targetNode.nodeId,
      relationId,
      relationKey,
      ...(relation.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: relation.sourceSymbolKey }),
      ...(relation.targetSymbolKey === undefined ? {} : { targetSymbolKey: relation.targetSymbolKey }),
      snapshotChecksum: source.snapshot.checksum,
      sourcePath: relationPath,
      sourceLine: relationLine,
    });
  }

  if (request.kind === "graph" && ["document", "file", "symbol"].includes(request.lens)) {
    return { index, nodes, edges: [...edges.values()].sort(compareKnowledgeEdge), nonCanonicalNodeIds };
  }

  const workspaceWorks = (await dependencies.readModel.works(context))
    .filter((work) => work.organizationId === context.organizationId && work.workspaceId === workspaceId)
    .sort((left, right) => left.workId.localeCompare(right.workId));
  if (workspaceWorks.length > MAX_KNOWLEDGE_WORKS)
    throw new Error(`Knowledge Workspace는 최대 ${String(MAX_KNOWLEDGE_WORKS)}개 Work만 투영할 수 있습니다`);
  const works =
    request.kind === "graph" && request.lens === "work" ? workspaceWorks.slice(0, request.limit) : workspaceWorks;
  const worksById = new Map<string, (typeof works)[number]>();
  for (const work of works) {
    const workId = knowledgeSourceId(work.workId, "work ID");
    if (worksById.has(workId)) throw new Error(`Knowledge Work 계보가 모호합니다: ${workId}`);
    worksById.set(workId, work);
    addKnowledgeNode(nodes, knowledgeNode("work", workId, knowledgeShortLabel(work.title, workId), work.status));
  }

  const includeArtifacts =
    (request.kind === "graph" && request.lens === "artifact") ||
    (request.kind === "links" && (request.nodeId.startsWith("work:") || request.nodeId.startsWith("artifact:")));
  const includeAgents =
    (request.kind === "graph" && request.lens === "agent") ||
    (request.kind === "links" && (request.nodeId.startsWith("work:") || request.nodeId.startsWith("agent:")));
  const includeReferences =
    (request.kind === "graph" && request.lens === "work") ||
    (request.kind === "links" &&
      request.relationIds === undefined &&
      ["work:", "document:", "file:", "symbol:"].some((prefix) => request.nodeId.startsWith(prefix)));
  const artifacts = includeArtifacts
    ? ((await dependencies.readModel.artifacts?.(context)) ?? []).filter(
        (artifact) => artifact.organizationId === context.organizationId && worksById.has(artifact.workId),
      )
    : [];
  const artifactsByVersion = new Map<string, ApplicationArtifactSource>();
  for (const artifact of artifacts) {
    const versionId = knowledgeSourceId(artifact.artifactVersionId, "artifact version ID");
    knowledgeSourceId(artifact.artifactId, "artifact ID");
    if (artifactsByVersion.has(versionId)) throw new Error(`Knowledge artifact 계보가 모호합니다: ${versionId}`);
    artifactsByVersion.set(versionId, artifact);
  }

  if (includeArtifacts) {
    for (const work of works) {
      const artifactIds = new Set<string>();
      for (const rawArtifactVersionId of work.artifactIds) {
        const artifactVersionId = knowledgeSourceId(rawArtifactVersionId, "Work artifact version ID");
        if (artifactIds.has(artifactVersionId))
          throw new Error(`Knowledge Work artifact 계보가 모호합니다: ${artifactVersionId}`);
        artifactIds.add(artifactVersionId);
        const artifact = artifactsByVersion.get(artifactVersionId);
        if (!artifact || artifact.workId !== work.workId)
          throw new Error(`Knowledge Work→artifact 계보가 끊겼습니다: ${artifactVersionId}`);
        const node = knowledgeNode(
          "artifact",
          artifactVersionId,
          knowledgeShortLabel(artifact.name, artifactVersionId),
          artifact.kind,
        );
        addKnowledgeNode(nodes, node);
        addKnowledgeEdge(edges, { kind: "contains", sourceId: `work:${work.workId}`, targetId: node.nodeId });
      }
    }
  }

  if (includeAgents) {
    const organization = await dependencies.readModel.organization(context);
    if (organization.organizationId !== context.organizationId)
      throw new Error("Knowledge agent→organization 계보가 일치하지 않습니다");
    for (const agent of organization.nodes) {
      if (agent.scope !== "work") continue;
      if (agent.workId === undefined) throw new Error(`Knowledge agent→Work 계보가 끊겼습니다: ${agent.nodeId}`);
      const work = worksById.get(agent.workId);
      if (!work) continue;
      const node = knowledgeNode(
        "agent",
        agent.nodeId,
        knowledgeShortLabel(agent.name, agent.nodeId),
        agent.responsibility,
        agent.role,
      );
      addKnowledgeNode(nodes, node);
      addKnowledgeEdge(edges, { kind: "contains", sourceId: `work:${work.workId}`, targetId: node.nodeId });
    }
  }

  const knowledgeViews = includeReferences
    ? await Promise.all(
        works.map(async (work) => {
          const view = await dependencies.workKnowledge?.get(context, work.workId);
          if (!view || view.workId !== work.workId)
            throw new Error(`Knowledge Work reference 계보가 끊겼습니다: ${work.workId}`);
          return [work, view] as const;
        }),
      )
    : [];
  const referenceUsers = new Map<string, Set<string>>();
  for (const [work, view] of knowledgeViews) {
    if (!new Set<string>(["not-applicable", "ready", "no-match", "blocked"]).has(view.status))
      throw new Error(`Knowledge Work 상태가 유효하지 않습니다: ${work.workId}`);
    if (view.status === "blocked") throw new Error(`Knowledge Work 계보가 차단되었습니다: ${work.workId}`);
    if ((view.status === "ready") === (view.references.length === 0))
      throw new Error(`Knowledge Work 상태와 reference 계보가 일치하지 않습니다: ${work.workId}`);
    if (
      view.status === "ready" &&
      (view.repositoryId !== source.repository.repositoryId ||
        view.repositoryRevisionId !== source.index.repositoryRevisionId ||
        view.indexVersionId !== source.index.indexVersionId)
    )
      throw new Error(`Knowledge Work→index 계보가 일치하지 않습니다: ${work.workId}`);
    const usedTargets = new Set<string>();
    for (const reference of view.references) {
      const referenceId = knowledgeSourceId(reference.referenceId, "reference ID");
      if (!new Set<string>(["symbol", "chunk"]).has(reference.kind))
        throw new Error(`Knowledge reference 종류가 유효하지 않습니다: ${referenceId}`);
      const relativePath = knowledgeRelativePath(reference.relativePath);
      const startLine = knowledgeLine(reference.startLine, "reference start line");
      const endLine = knowledgeLine(reference.endLine, "reference end line");
      knowledgeHash(reference.contentHash, "reference content hash");
      if (endLine < startLine) throw new Error(`Knowledge reference line 계보가 유효하지 않습니다: ${referenceId}`);
      let target: KnowledgeNodeViewV1 | undefined;
      if (reference.kind === "symbol") {
        const symbol = symbolsById.get(referenceId);
        if (
          !symbol ||
          symbol.relativePath !== relativePath ||
          symbol.startLine !== startLine ||
          symbol.endLine !== endLine ||
          symbol.contentHash !== reference.contentHash ||
          (reference.qualifiedName !== undefined && symbol.qualifiedName !== reference.qualifiedName)
        )
          throw new Error(`Knowledge symbol reference 계보가 일치하지 않습니다: ${referenceId}`);
        target = nodes.get(`symbol:${referenceId}`);
      } else {
        const chunk = chunksById.get(referenceId);
        const chunkSymbol = chunk?.symbolKey === undefined ? undefined : symbolsByKey.get(chunk.symbolKey);
        if (
          !chunk ||
          chunk.relativePath !== relativePath ||
          chunk.startLine !== startLine ||
          chunk.endLine !== endLine ||
          chunk.contentHash !== reference.contentHash ||
          (reference.qualifiedName !== undefined && chunkSymbol?.qualifiedName !== reference.qualifiedName)
        )
          throw new Error(`Knowledge chunk reference 계보가 일치하지 않습니다: ${referenceId}`);
        target = fileNodesById.get(chunk.sourceFileId);
      }
      if (!target) throw new Error(`Knowledge reference node 계보가 끊겼습니다: ${referenceId}`);
      if (usedTargets.has(target.nodeId)) continue;
      usedTargets.add(target.nodeId);
      addKnowledgeEdge(edges, { kind: "documents", sourceId: `work:${work.workId}`, targetId: target.nodeId });
      const users = referenceUsers.get(target.nodeId) ?? new Set<string>();
      users.add(`work:${work.workId}`);
      referenceUsers.set(target.nodeId, users);
    }
  }

  for (const [targetId, users] of referenceUsers) {
    const sorted = [...users].sort((left, right) => left.localeCompare(right));
    const target = nodes.get(targetId);
    if (!target) throw new Error(`Knowledge shared reference 계보가 끊겼습니다: ${targetId}`);
    const [anchor, ...others] = sorted;
    if (anchor === undefined) continue;
    for (const other of others) {
      addKnowledgeEdge(edges, {
        kind: "documents",
        sourceId: anchor,
        targetId: other,
        derivedVia: target.detail ?? target.label,
      });
    }
  }

  for (const edge of edges.values()) {
    if (!nodes.has(edge.sourceId) || !nodes.has(edge.targetId))
      throw new Error(`Knowledge edge endpoint 계보가 끊겼습니다: ${edge.sourceId}→${edge.targetId}`);
  }
  return { index, nodes, edges: [...edges.values()].sort(compareKnowledgeEdge), nonCanonicalNodeIds };
}

function organizationGraphSnapshotView(snapshot: CollaborationGraphSnapshot) {
  return {
    version: { version: snapshot.organization.version },
    nodes: snapshot.nodes.map((node) => ({
      node_id: node.nodeId,
      handle: node.handle,
      name: node.name,
      responsibility: node.responsibility,
      ...(node.parentHandle === undefined ? {} : { parent_handle: node.parentHandle }),
      status: node.status,
      role: node.role,
      capabilities: node.capabilities,
      scope: node.scope,
      ...(node.workId === undefined ? {} : { work_id: node.workId }),
    })),
  };
}

const OPERATION = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

function object(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application query payload는 object여야 합니다");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Application query payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function boundedInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value as number;
}

const OPTIMIZATION_POLICY_FIELDS = [
  "policyVersionId",
  "organizationId",
  "version",
  "policy",
  "autoOptimize",
  "productionLearning",
  "shadowEnabled",
  "minimumSampleCount",
  "improvementThreshold",
  "observationBudgetMicros",
  "observationRetentionDays",
  "status",
  "checksum",
] as const;
const OPTIMIZATION_RECEIPT_FIELDS = [
  "receiptId",
  "runId",
  "organizationId",
  "roleKey",
  "modelProfileId",
  "bundleVersion",
  "sampleCount",
  "qualityScore",
  "latencyMs",
  "costMicros",
  "privacyAllowed",
  "completed",
  "inputChecksum",
  "receiptChecksum",
] as const;
const OPTIMIZATION_RECOMMENDATION_FIELDS = [
  "recommendationId",
  "organizationId",
  "roleKey",
  "policyVersionId",
  "primaryModelProfileId",
  "fallbackModelProfileIds",
  "excludedJson",
  "receiptIds",
  "status",
  "checksum",
] as const;
const OPTIMIZATION_OBSERVATION_FIELDS = [
  "observationId",
  "organizationId",
  "batchId",
  "sampleCount",
  "qualityScore",
  "latencyMs",
  "costMicros",
  "status",
  "source",
  "policyVersionId",
  "expiresAt",
  "checksum",
] as const;
const OPTIMIZATION_BATCH_FIELDS = [
  "batchId",
  "organizationId",
  "roleKey",
  "version",
  "recommendationId",
  "policyVersionId",
  "status",
  "primaryModelProfileId",
  "fallbackModelProfileIds",
  "parentBatchId",
  "checksum",
] as const;

function projectOptimizationRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

function projectOptimizationList(value: readonly unknown[] | undefined, fields: readonly string[]): readonly unknown[] {
  return (value ?? []).map((item) => projectOptimizationRecord(item, fields));
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("after가 유효하지 않습니다");
  return value as number;
}

function pageCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) throw new Error("cursor가 유효하지 않습니다");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("cursor가 유효하지 않습니다");
  return parsed;
}

function pageLimit(value: unknown, fallback: number): number {
  const limit = boundedInteger(value, "limit", fallback);
  if (limit > 100) throw new Error("limit가 유효하지 않습니다");
  return limit;
}

function page<T>(items: readonly T[], offset: number, limit: number) {
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    ...(offset + selected.length < items.length ? { nextCursor: String(offset + selected.length) } : {}),
  };
}

function searchText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) throw new Error("search가 유효하지 않습니다");
  return value.trim().toLocaleLowerCase();
}

export class ApplicationQueryRegistry {
  private readonly descriptors = new Map<string, ApplicationQueryDescriptor>();

  public register<Payload>(descriptor: ApplicationQueryDescriptor<Payload>): void {
    if (
      !OPERATION.test(descriptor.operation) ||
      descriptor.requiredScopes.length === 0 ||
      descriptor.allowedRoles.length === 0
    ) {
      throw new Error("Application query descriptor가 유효하지 않습니다");
    }
    if (this.descriptors.has(descriptor.operation)) throw new Error("Application query operation 중복입니다");
    this.descriptors.set(descriptor.operation, descriptor);
  }

  public async query(
    context: TenantContext,
    callerScopes: readonly string[],
    operation: string,
    input: unknown,
  ): Promise<ApplicationQueryResultV1> {
    const descriptor = this.descriptors.get(operation);
    if (!descriptor) {
      throw new ApplicationError({
        category: "validation",
        severity: "error",
        retryable: false,
        userMessage: "지원하지 않는 Application query operation입니다",
        operatorCode: "APP_QUERY_UNKNOWN",
      });
    }
    if (
      !callerScopes.includes("application:*") &&
      descriptor.requiredScopes.some((scope) => !callerScopes.includes(scope))
    ) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Application query scope가 부족합니다",
        operatorCode: "APP_QUERY_SCOPE_REQUIRED",
      });
    }
    if (!descriptor.allowedRoles.includes(context.role)) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "조직 역할에 이 query 권한이 없습니다",
        operatorCode: "APP_QUERY_ROLE_REQUIRED",
      });
    }
    return {
      schemaVersion: "massion.application.v1",
      operation,
      data: await descriptor.handle(context, descriptor.validate(input)),
    };
  }
}

function assuranceBindingView(binding: Awaited<ReturnType<AssuranceBindingStore["get"]>>): unknown {
  return {
    bindingVersionId: binding.bindingVersionId,
    workId: binding.workId,
    planVersionId: binding.planVersionId,
    version: binding.version,
    revision: binding.revision,
    status: binding.status,
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    bindings: binding.bindings,
    criteriaChecksum: binding.criteriaChecksum,
    checksum: binding.checksum,
    authorHandle: binding.authorHandle,
    createdAt: binding.createdAt,
    activatedAt: binding.activatedAt,
  };
}

const EVERY_ROLE: readonly MembershipRole[] = ["owner", "admin", "member"];

function publicWork(value: Awaited<ReturnType<ApplicationReadModel["works"]>>[number]) {
  return {
    workId: value.workId,
    title: value.title ?? value.workId,
    status: value.status,
    revision: value.revision,
    artifactIds: value.artifactIds,
    artifactVersionIds: value.artifactIds,
    ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId }),
    ...(value.autonomyMode === undefined ? {} : { autonomyMode: value.autonomyMode }),
    ...(value.autonomyRevision === undefined ? {} : { autonomyRevision: value.autonomyRevision }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

function publicExecution(execution: ApplicationExecutionSource) {
  return {
    executionId: execution.executionId,
    workId: execution.workId,
    ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
    agentHandle: execution.agentHandle,
    modelRoute: execution.modelRoute,
    ...(execution.providerId === undefined ? {} : { providerId: execution.providerId }),
    ...(execution.modelId === undefined ? {} : { modelId: execution.modelId }),
    status: execution.status,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    costMicros: execution.costMicros,
    ...(execution.autonomyMode === undefined ? {} : { autonomyMode: execution.autonomyMode }),
    ...(execution.autonomyRevision === undefined ? {} : { autonomyRevision: execution.autonomyRevision }),
    ...(execution.createdAt === undefined ? {} : { createdAt: execution.createdAt }),
    ...(execution.updatedAt === undefined ? {} : { updatedAt: execution.updatedAt }),
  };
}

function publicApproval(approval: ApplicationApprovalSource) {
  return {
    approvalId: approval.approvalId,
    action: approval.action,
    status: approval.status,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    ...(approval.workId === undefined ? {} : { workId: approval.workId }),
    ...(approval.executionId === undefined ? {} : { executionId: approval.executionId }),
    ...(approval.revision === undefined ? {} : { revision: approval.revision }),
    ...(approval.resourceRevision === undefined ? {} : { resourceRevision: approval.resourceRevision }),
    ...(approval.resumeTarget === undefined ? {} : { resumeTarget: approval.resumeTarget }),
    ...(approval.createdAt === undefined ? {} : { createdAt: approval.createdAt }),
    ...(approval.updatedAt === undefined ? {} : { updatedAt: approval.updatedAt }),
    ...(approval.displayPreview === undefined ? {} : { displayPreview: approval.displayPreview }),
  };
}

function publicArtifact(artifact: ApplicationArtifactSource) {
  return {
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    workId: artifact.workId,
    name: artifact.name,
    kind: artifact.kind,
    version: artifact.version,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    createdBy: artifact.createdBy,
    createdAt: artifact.createdAt,
    ...(artifact.sourceArtifactVersionId === undefined
      ? {}
      : { sourceArtifactVersionId: artifact.sourceArtifactVersionId }),
    ...(artifact.creatorAgentHandle === undefined ? {} : { creatorAgentHandle: artifact.creatorAgentHandle }),
    ...(artifact.creatorExecutionId === undefined ? {} : { creatorExecutionId: artifact.creatorExecutionId }),
  };
}

function publicVerification(verification: ApplicationVerificationSource) {
  return {
    verificationId: verification.verificationId,
    workId: verification.workId,
    verifierId: verification.verifierId,
    passed: verification.passed,
    criteria: verification.criteria,
    evidenceArtifactVersionIds: verification.evidenceArtifactVersionIds,
    ...(verification.assuranceRunId === undefined ? {} : { assuranceRunId: verification.assuranceRunId }),
    ...(verification.targetWorkRevision === undefined ? {} : { targetWorkRevision: verification.targetWorkRevision }),
    ...(verification.projectedWorkRevision === undefined
      ? {}
      : { projectedWorkRevision: verification.projectedWorkRevision }),
    ...(verification.profileId === undefined ? {} : { profileId: verification.profileId }),
    ...(verification.profileVersion === undefined ? {} : { profileVersion: verification.profileVersion }),
    ...(verification.bindingVersionId === undefined ? {} : { bindingVersionId: verification.bindingVersionId }),
    createdAt: verification.createdAt,
  };
}

function publicDirective(directive: ApplicationDirectiveSource) {
  return {
    directiveId: directive.directiveId,
    workId: directive.workId,
    runId: directive.runId,
    sequence: directive.sequence,
    content: directive.content,
    mode: directive.mode,
    submittedStage: directive.submittedStage,
    status: directive.status,
    revision: directive.revision,
    createdAt: directive.createdAt,
    updatedAt: directive.updatedAt,
    ...(directive.failureReason === undefined ? {} : { failureReason: directive.failureReason }),
  };
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (
    value !== null &&
    typeof value === "object" &&
    "toISOString" in value &&
    typeof value.toISOString === "function"
  ) {
    const serialized = (value as { toISOString: () => unknown }).toISOString();
    if (typeof serialized === "string") return serialized;
  }
  throw new Error(`${label} 시각이 유효하지 않습니다`);
}

function routeAttemptText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`Route Attempt ${label}이(가) 유효하지 않습니다`);
  return value;
}

function routeAttemptOptionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : routeAttemptText(value, label);
}

function routeAttemptCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Route Attempt ${label}이(가) 유효하지 않습니다`);
  return value as number;
}

const ROUTE_ATTEMPT_INSTANT =
  /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,9}))?Z$/u;

function routeAttemptInstant(value: unknown): string {
  let serialized: unknown;
  try {
    serialized =
      typeof value === "string"
        ? value
        : value instanceof Date
          ? value.toISOString()
          : value !== null &&
              typeof value === "object" &&
              "toISOString" in value &&
              typeof value.toISOString === "function"
            ? (value as { toISOString: () => unknown }).toISOString()
            : undefined;
  } catch {
    throw new Error("Route Attempt 시각이 유효하지 않습니다");
  }
  if (typeof serialized !== "string") throw new Error("Route Attempt 시각이 유효하지 않습니다");
  const matched = ROUTE_ATTEMPT_INSTANT.exec(serialized);
  const seconds = matched?.[1];
  if (!seconds) throw new Error("Route Attempt 시각이 유효하지 않습니다");
  const parsed = new Date(serialized);
  const normalized = `${seconds}.${(matched[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized)
    throw new Error("Route Attempt 시각이 유효하지 않습니다");
  return normalized;
}

interface RouteAttemptPublicLineage {
  readonly execution?: ApplicationExecutionSource;
  readonly work?: Awaited<ReturnType<ApplicationReadModel["works"]>>[number];
  readonly optimizationRunId?: string;
}

function publicRouteAttempt(value: unknown, lineage: RouteAttemptPublicLineage = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Route Attempt가 유효하지 않습니다");
  const attempt = value as Record<string, unknown>;
  const rawStatus = attempt.status;
  if (rawStatus !== "reserved" && rawStatus !== "succeeded" && rawStatus !== "failed" && rawStatus !== "interrupted")
    throw new Error("Route Attempt 상태가 유효하지 않습니다");
  const rawExecutionId = routeAttemptOptionalText(attempt.execution_id, "실행 ID");
  const rawOptimizationRunId = routeAttemptOptionalText(attempt.optimization_run_id, "최적화 평가 run ID");
  if (
    lineage.execution !== undefined &&
    (rawExecutionId !== lineage.execution.executionId || lineage.optimizationRunId !== undefined)
  )
    throw new Error("Route Attempt 실행 계보가 유효하지 않습니다");
  if (lineage.execution === undefined && rawExecutionId !== undefined && rawExecutionId !== lineage.optimizationRunId)
    throw new Error("Route Attempt 실행 계보가 유효하지 않습니다");
  if (rawOptimizationRunId !== undefined && rawOptimizationRunId !== lineage.optimizationRunId)
    throw new Error("Route Attempt 최적화 계보가 유효하지 않습니다");
  const optimizationBatchId = routeAttemptOptionalText(attempt.optimization_batch_id, "최적화 배치 ID");
  const statusCode =
    attempt.status_code === undefined ? undefined : routeAttemptCount(attempt.status_code, "상태 코드");
  const failureClass = routeAttemptOptionalText(attempt.failure_class, "실패 분류");
  const fallbackFrom = routeAttemptOptionalText(attempt.fallback_from_attempt_id, "fallback 원본 ID");
  return {
    attemptId: routeAttemptText(attempt.attempt_id, "시도 ID"),
    at: routeAttemptInstant(attempt.created_at),
    routeId: routeAttemptText(attempt.route_id, "경로 ID"),
    modelProfileId: routeAttemptText(attempt.model_profile_id, "모델 profile ID"),
    // Provider 등록이 제거된 과거 호출에는 이름이 없습니다. 지어내지 않고 비워 보냅니다 —
    // 화면이 「등록이 제거된 모델」이라고 말하고, 지출 합계에서는 빠지지 않습니다.
    ...(attempt.model_id === undefined ? {} : { modelId: routeAttemptText(attempt.model_id, "모델 ID") }),
    ...(attempt.provider_id === undefined ? {} : { providerId: routeAttemptText(attempt.provider_id, "Provider ID") }),
    ...(lineage.execution === undefined ? {} : { executionId: lineage.execution.executionId }),
    ...(lineage.optimizationRunId === undefined ? {} : { optimizationRunId: lineage.optimizationRunId }),
    ...(optimizationBatchId === undefined ? {} : { optimizationBatchId }),
    status: rawStatus === "reserved" ? ("running" as const) : rawStatus,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(failureClass === undefined ? {} : { failureClass }),
    inputTokens: routeAttemptCount(attempt.actual_input_tokens, "입력 토큰"),
    outputTokens: routeAttemptCount(attempt.actual_output_tokens, "출력 토큰"),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: routeAttemptCount(attempt.actual_cost_micros, "비용"),
    ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
    ...(lineage.execution === undefined ? {} : { workId: lineage.execution.workId }),
    ...(lineage.work?.title === undefined ? {} : { workTitle: lineage.work.title }),
  };
}

function publicSubscriptionProvider(provider: SubscriptionProviderView) {
  const runtimeCapabilities = provider.runtimeCapabilities;
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    authKinds: provider.authKinds,
    executionKind: provider.executionKind,
    connectionSurface: provider.connectionSurface,
    billingKinds: provider.billingKinds,
    modelDiscovery: provider.modelDiscovery,
    quotaDiscovery: provider.quotaDiscovery,
    protocols: provider.protocols,
    ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
    availability: provider.availability,
    officialDocumentation: provider.officialDocumentation,
    credentialPolicies: provider.credentialPolicies,
    verified: provider.verified,
    ...(runtimeCapabilities
      ? {
          runtimeCapabilities: {
            ...(runtimeCapabilities.minimumVersion === undefined
              ? {}
              : { minimumVersion: runtimeCapabilities.minimumVersion }),
            accountIsolation: runtimeCapabilities.accountIsolation,
            output: runtimeCapabilities.output,
            cancellation: runtimeCapabilities.cancellation,
            session: runtimeCapabilities.session,
            permissionBridge: runtimeCapabilities.permissionBridge,
            multipleAccounts: runtimeCapabilities.multipleAccounts,
            maturity: runtimeCapabilities.maturity,
            ...(runtimeCapabilities.approvalModes === undefined
              ? {}
              : { approvalModes: runtimeCapabilities.approvalModes }),
            ...(runtimeCapabilities.approvalModesBySurface === undefined
              ? {}
              : {
                  approvalModesBySurface: {
                    ...(runtimeCapabilities.approvalModesBySurface.server === undefined
                      ? {}
                      : { server: runtimeCapabilities.approvalModesBySurface.server }),
                    ...(runtimeCapabilities.approvalModesBySurface.edge === undefined
                      ? {}
                      : { edge: runtimeCapabilities.approvalModesBySurface.edge }),
                  },
                }),
          },
        }
      : {}),
  };
}

function publicSubscriptionPolicy(policy: SubscriptionPolicyView) {
  return {
    providerId: policy.providerId,
    credentialPolicy: policy.credentialPolicy,
    approvalMode: policy.approvalMode,
    version: policy.version,
    source: policy.source,
    ...(policy.updatedAt === undefined ? {} : { updatedAt: policy.updatedAt }),
  };
}

function publicQuota(quota: Awaited<ReturnType<SubscriptionQuotaQueries["current"]>>) {
  if (!quota) return undefined;
  return {
    accountId: quota.accountId,
    windows: quota.windows.map((window) => ({
      kind: window.kind,
      ...(window.limit === undefined ? {} : { limit: window.limit }),
      ...(window.remaining === undefined ? {} : { remaining: window.remaining }),
      ...(window.remainingRatio === undefined ? {} : { remainingRatio: window.remainingRatio }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      observedAt: window.observedAt,
      confidence: window.confidence,
    })),
    ...(quota.minimumRemainingRatio === undefined ? {} : { minimumRemainingRatio: quota.minimumRemainingRatio }),
    ...(quota.earliestResetAt === undefined ? {} : { earliestResetAt: quota.earliestResetAt }),
    exhausted: quota.exhausted,
    observedAt: quota.observedAt,
  };
}

async function subscriptionAccountRows(
  context: TenantContext,
  dependencies: Pick<
    ApplicationQueryDependencies,
    "subscriptionAccounts" | "subscriptionConnectors" | "subscriptionQuota"
  >,
  accountId?: string,
) {
  const accounts = (await dependencies.subscriptionAccounts?.list(context, "organization")) ?? [];
  return await Promise.all(
    accounts
      .filter((account) => accountId === undefined || account.account_id === accountId)
      .map(async (account) => {
        const canReadQuota = account.owner_user_id === context.userId || context.role !== "member";
        const [connector, quota] = await Promise.all([
          dependencies.subscriptionConnectors?.get(context, account.connector_id),
          canReadQuota ? dependencies.subscriptionQuota?.current(context, account.account_id) : undefined,
        ]);
        return { account, connector, quota: publicQuota(quota) };
      }),
  );
}

function subscriptionProfileHandle(organizationId: string, accountId: string): string {
  const segment = (value: string): string => createHash("sha256").update(value.trim()).digest("hex");
  return `${segment(organizationId)}/${segment(accountId)}`;
}

/** SDK 선언 그룹을 화면이 읽는 이름 목록으로 접습니다. 비어 있는 그룹은 내보내지 않습니다. */
function extensionCapabilities(group: unknown): readonly ExtensionCapabilityViewV1[] {
  if (!group || typeof group !== "object" || Array.isArray(group)) return [];
  return Object.entries(group as Record<string, unknown>).flatMap(([kind, value]) => {
    if (Array.isArray(value)) {
      const items = value.map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : typeof item === "object" && item !== null && typeof (item as { origin?: unknown }).origin === "string"
              ? (item as { origin: string }).origin
              : JSON.stringify(item),
      );
      return items.length > 0 ? [{ kind, items }] : [];
    }
    // storage처럼 배열이 아닌 선언은 존재 사실만 남깁니다. 원문 값을 그대로 흘리지 않습니다.
    return value && typeof value === "object" ? [{ kind, items: [] as readonly string[] }] : [];
  });
}

/** 도메인 view를 그대로 흘리면 organizationId가 클라이언트로 샙니다. 계약이 선언한 것만 내보냅니다. */
function publicExtensionInstallation(value: unknown): ExtensionInstallationViewV1 {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  // `String(unknown)`은 객체를 "[object Object]"로 접습니다. 문자열이 아니면 지어내지 않고 비웁니다.
  const text = (candidate: unknown): string => (typeof candidate === "string" ? candidate : "");
  return {
    installationId: text(record.installationId),
    packageName: text(record.packageName),
    state: text(record.state),
    ...(typeof record.activeVersionId === "string" ? { activeVersionId: record.activeVersionId } : {}),
    activationGeneration: typeof record.activationGeneration === "number" ? record.activationGeneration : 0,
    contributions: extensionCapabilities(record.contributions),
    permissions: extensionCapabilities(record.permissions),
  };
}

export function registerApplicationQueries(
  registry: ApplicationQueryRegistry,
  dependencies: ApplicationQueryDependencies,
): void {
  registry.register({
    operation: "identity.me",
    requiredScopes: ["identity:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: (context) =>
      Promise.resolve({
        userId: context.userId,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        role: context.role,
      }),
  });
  if (dependencies.memberships) {
    registry.register({
      operation: "identity.memberships",
      requiredScopes: ["identity:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        ((await dependencies.memberships?.listMembers(context)) ?? []).map((member) => ({
          membershipId: member.membershipId,
          userId: member.userId,
          displayName: member.displayName,
          ...(context.role === "member" ? {} : { email: member.email }),
          role: member.role,
          status: member.status,
          revision: member.revision,
          createdAt: member.createdAt,
        })),
    });
  }
  if (dependencies.audit) {
    registry.register({
      operation: "application.audit",
      requiredScopes: ["audit:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["after", "limit"]),
      handle: async (context, value) => {
        try {
          return await dependencies.audit?.read(context, {
            after: cursor(value.after),
            limit: boundedInteger(value.limit, "limit", 100),
          });
        } catch (cause) {
          if (cause instanceof ApplicationEventCursorExpiredError) {
            throw new ApplicationError({
              category: "conflict",
              severity: "warning",
              retryable: true,
              userMessage: "감사 사건 보존 범위가 지나 snapshot 재동기화가 필요합니다",
              operatorCode: "APP_EVENT_CURSOR_EXPIRED",
              cause,
            });
          }
          throw cause;
        }
      },
    });
  }
  if (dependencies.runs) {
    const runs = dependencies.runs;
    registry.register({
      operation: "run.get",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["runId"]),
      handle: async (context, value) => publicRun(await runs.get(context, text(value.runId, "runId"))),
    });
    if (runs.listByWork) {
      registry.register({
        operation: "run.list",
        requiredScopes: ["work:read"],
        allowedRoles: EVERY_ROLE,
        validate: (value) => object(value, ["workId"]),
        handle: async (context, value) =>
          (await runs.listByWork?.(context, text(value.workId, "workId")))?.map(publicRun) ?? [],
      });
    }
  }
  if (dependencies.workspaces) {
    const workspaces = dependencies.workspaces;
    const publicWorkspace = (workspace: WorkspaceView) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      path: workspace.path,
      kind: workspace.kind,
      trust: workspace.trust,
      status: workspace.status,
      revision: workspace.revision,
      createdAt: workspace.createdAt,
      lastUsedAt: workspace.lastUsedAt,
    });
    registry.register({
      operation: "workspace.list",
      requiredScopes: ["workspace:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => (await workspaces.list(context)).map(publicWorkspace),
    });
    registry.register({
      operation: "workspace.get",
      requiredScopes: ["workspace:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workspaceId"]),
      handle: async (context, value) =>
        publicWorkspace(await workspaces.get(context, text(value.workspaceId, "workspaceId"))),
    });
  }
  if (dependencies.workTimeline) {
    const timelineSources = dependencies.workTimeline;
    registry.register({
      operation: "work.timeline",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "limit"]),
      handle: async (context, value) => {
        const limit =
          value.limit === undefined
            ? undefined
            : Number.isSafeInteger(value.limit) && Number(value.limit) >= 1
              ? Number(value.limit)
              : (() => {
                  throw new Error("timeline limit이 유효하지 않습니다");
                })();
        return await projectWorkTimeline(timelineSources, context, text(value.workId, "workId"), {
          ...(limit === undefined ? {} : { limit }),
        });
      },
    });
    registry.register({
      operation: "work.activity.list",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "cursor", "limit"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const cells = await projectWorkTimeline(timelineSources, context, workId, { limit: 2_000 });
        const activities = [...cells].reverse().map((cell) => ({
          activityId: cell.cellId,
          workId,
          kind:
            cell.kind === "user-message" || cell.kind === "agent-message"
              ? "message"
              : cell.kind === "task"
                ? "task"
                : cell.kind === "artifact"
                  ? "artifact"
                  : cell.kind === "verification"
                    ? "verification"
                    : cell.kind === "record"
                      ? "record"
                      : "work",
          title: cell.title,
          createdAt: cell.createdAt,
          ...(cell.detail === undefined ? {} : { detail: cell.detail }),
          ...(cell.authorKind === undefined ? {} : { authorKind: cell.authorKind }),
          ...(cell.authorId === undefined ? {} : { authorId: cell.authorId }),
          ...(cell.messageType === undefined ? {} : { messageType: cell.messageType }),
          resourceId: cell.cellId,
        }));
        return page(activities, pageCursor(value.cursor), pageLimit(value.limit, 100));
      },
    });
  }
  if (dependencies.autonomy) {
    const autonomy = dependencies.autonomy;
    registry.register({
      operation: "governance.autonomy",
      requiredScopes: ["governance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const state = await autonomy.get(context);
        const emergencyState = await dependencies.emergency?.get(context);
        return {
          mode: state.mode,
          revision: state.revision,
          runtimePermissionStatus: emergencyState?.active
            ? "limited"
            : state.mode === "full-access"
              ? "full-access"
              : "governed",
          ...(emergencyState?.active ? { permissionLimitReason: emergencyState.reason } : {}),
          emergencyStopActive: emergencyState?.active === true,
        };
      },
    });
  }
  if (dependencies.emergency) {
    const emergency = dependencies.emergency;
    registry.register({
      operation: "governance.emergency",
      requiredScopes: ["governance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const state = await emergency.get(context);
        if (!state) return undefined;
        return {
          active: state.active,
          reason: state.reason,
          revision: state.revision,
          changedByUserId: state.changed_by_user_id,
          changedAt: String(state.changed_at),
        };
      },
    });
  }
  if (dependencies.provenance) {
    const provenance = dependencies.provenance;
    registry.register({
      operation: "work.provenance",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) =>
        (await provenance.listByWork(context, text(value.workId, "workId"))).map((delivery) => ({
          deliveryId: delivery.deliveryId,
          taskId: delivery.taskId,
          agentHandle: delivery.agentHandle,
          status: delivery.status,
          ...(delivery.branchRef === undefined ? {} : { branchRef: delivery.branchRef }),
          ...(delivery.commitSha === undefined ? {} : { commitSha: delivery.commitSha }),
          createdAt: delivery.createdAt,
        })),
    });
  }
  registry.register({
    operation: "work.list",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workspaceId"]),
    handle: async (context, value) => {
      const works = (await dependencies.readModel.works(context)).map(publicWork);
      if (value.workspaceId === undefined) return works;
      const workspaceId = text(value.workspaceId, "workspaceId");
      return works.filter((work) => work.workspaceId === workspaceId);
    },
  });
  registry.register({
    operation: "work.index",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workspaceId", "status", "search", "cursor", "limit"]),
    handle: async (context, value) => {
      const workspaceId = value.workspaceId === undefined ? undefined : text(value.workspaceId, "workspaceId");
      const status = value.status === undefined ? undefined : text(value.status, "status");
      const search = searchText(value.search);
      const works = (await dependencies.readModel.works(context))
        .filter((work) => workspaceId === undefined || work.workspaceId === workspaceId)
        .filter((work) => status === undefined || work.status === status)
        .filter((work) => {
          if (!search) return true;
          return `${work.title ?? ""}\n${work.workId}`.toLocaleLowerCase().includes(search);
        })
        .sort((left, right) => {
          const leftTime = left.updatedAt ?? "";
          const rightTime = right.updatedAt ?? "";
          if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
          return left.workId.localeCompare(right.workId);
        })
        .map(publicWork);
      return page(works, pageCursor(value.cursor), pageLimit(value.limit, 50));
    },
  });
  registry.register({
    operation: "inbox.list",
    requiredScopes: ["work:read", "approval:read", "growth:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: async (context) => {
      const works = (await dependencies.readModel.works(context)).filter(
        (work) => work.organizationId === context.organizationId,
      );
      const worksById = new Map(works.map((work) => [work.workId, work]));
      const completeGrowthDetails = async (): Promise<readonly GrowthSuggestionDetails[]> => {
        if (!dependencies.growth?.listSuggestionDetails) return [];
        const details: GrowthSuggestionDetails[] = [];
        let after: { readonly createdAt: string; readonly suggestionId: string } | undefined;
        for (;;) {
          const batch = await dependencies.growth.listSuggestionDetails(context, {
            status: "awaiting-review",
            limit: 1_000,
            oldestFirst: true,
            ...(after === undefined ? {} : { after }),
          });
          details.push(...batch);
          if (batch.length < 1_000) return details;
          const last = batch.at(-1)?.suggestion;
          if (!last || last.created_at === undefined) {
            throw new Error("Growth Inbox cursor 계보가 유효하지 않습니다");
          }
          const next = {
            createdAt: timestamp(last.created_at, "Growth Inbox"),
            suggestionId: last.suggestion_id,
          };
          if (after?.createdAt === next.createdAt && after.suggestionId === next.suggestionId) {
            throw new Error("Growth Inbox cursor가 진행하지 않습니다");
          }
          after = next;
        }
      };
      const [blockedRuns, approvals, growthDetails] = await Promise.all([
        dependencies.runs?.listBlocked?.(context) ?? [],
        dependencies.readModel.approvals(context),
        completeGrowthDetails(),
      ]);
      const blockedItems = blockedRuns.map((run) => {
        const work = run.workId === undefined ? undefined : worksById.get(run.workId);
        return {
          kind: "blocked" as const,
          id: `blocked:${run.runId}`,
          runId: run.runId,
          ...(run.workId === undefined ? {} : { workId: run.workId }),
          title: work?.title ?? "차단된 실행",
          ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
          ...(publicRun(run).blockedDetail === undefined ? {} : { blockedDetail: publicRun(run).blockedDetail }),
        };
      });
      const growthApprovalIds = new Set(
        growthDetails.flatMap((detail) =>
          detail.adoption?.status === "awaiting-review" && detail.adoption.approvalId
            ? [detail.adoption.approvalId]
            : [],
        ),
      );
      const approvalItems = approvals
        .filter((approval) => approval.organizationId === context.organizationId && approval.status === "pending")
        .filter((approval) => !growthApprovalIds.has(approval.approvalId))
        .map((approval) => ({
          kind: "approval" as const,
          id: approval.approvalId,
          ...(approval.workId === undefined
            ? {}
            : { workTitle: worksById.get(approval.workId)?.title ?? approval.workId }),
          approval: publicApproval(approval),
        }));
      const growthItems = growthDetails
        .filter((detail) => detail.suggestion.status === "awaiting-review")
        .map((detail) => {
          const suggestion = detail.suggestion;
          return {
            kind: "growth" as const,
            id: `growth:${suggestion.suggestion_id}`,
            suggestionId: suggestion.suggestion_id,
            workId: suggestion.work_id,
            workTitle: worksById.get(suggestion.work_id)?.title ?? suggestion.work_id,
            title: suggestion.summary,
            reason: suggestion.rationale,
          };
        });
      return [...blockedItems, ...approvalItems, ...growthItems];
    },
  });
  registry.register({
    operation: "work.get",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const work = (await dependencies.readModel.works(context)).find((candidate) => candidate.workId === workId);
      if (!work)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Work를 찾을 수 없습니다",
          operatorCode: "APP_WORK_NOT_FOUND",
        });
      return publicWork(work);
    },
  });
  registry.register({
    operation: "work.detail",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const work = (await dependencies.readModel.works(context)).find((candidate) => candidate.workId === workId);
      if (!work)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Work를 찾을 수 없습니다",
          operatorCode: "APP_WORK_NOT_FOUND",
        });
      return publicWork(work);
    },
  });
  registry.register({
    operation: "work.tasks",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.tasks(context))
        .filter((task) => task.workId === text(value.workId, "workId"))
        .map((task) => ({
          workId: task.workId,
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          revision: task.revision,
          ...(task.objective === undefined ? {} : { objective: task.objective }),
          ...(task.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: task.acceptanceCriteria }),
          ...(task.dependencyIds === undefined ? {} : { dependencyIds: task.dependencyIds }),
          ...(task.requiredCapabilities === undefined ? {} : { requiredCapabilities: task.requiredCapabilities }),
          ...(task.recommendedAgentHandles === undefined
            ? {}
            : { recommendedAgentHandles: task.recommendedAgentHandles }),
          ...(task.parallelizable === undefined ? {} : { parallelizable: task.parallelizable }),
          ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
          ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
        })),
  });
  registry.register({
    operation: "work.assignments",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.assignments(context))
        .filter((assignment) => assignment.workId === text(value.workId, "workId"))
        .map((assignment) => ({
          workId: assignment.workId,
          taskId: assignment.taskId,
          agentHandle: assignment.agentHandle,
          status: assignment.status,
          revision: assignment.revision,
          ...(assignment.assignmentId === undefined ? {} : { assignmentId: assignment.assignmentId }),
          ...(assignment.createdAt === undefined ? {} : { createdAt: assignment.createdAt }),
          ...(assignment.updatedAt === undefined ? {} : { updatedAt: assignment.updatedAt }),
        })),
  });
  registry.register({
    operation: "work.executions",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.executions(context))
        .filter((execution) => execution.workId === text(value.workId, "workId"))
        .map(publicExecution),
  });
  registry.register({
    operation: "work.artifacts",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      ((await dependencies.readModel.artifacts?.(context)) ?? [])
        .filter((artifact) => artifact.workId === text(value.workId, "workId"))
        .map(publicArtifact),
  });
  registry.register({
    operation: "work.artifact.get",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "artifactVersionId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const artifactVersionId = text(value.artifactVersionId, "artifactVersionId");
      const artifact = ((await dependencies.readModel.artifacts?.(context)) ?? []).find(
        (candidate) => candidate.workId === workId && candidate.artifactVersionId === artifactVersionId,
      );
      if (!artifact)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Artifact를 찾을 수 없습니다",
          operatorCode: "APP_ARTIFACT_NOT_FOUND",
        });
      return publicArtifact(artifact);
    },
  });
  registry.register({
    operation: "work.verifications",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      ((await dependencies.readModel.verifications?.(context)) ?? [])
        .filter((verification) => verification.workId === text(value.workId, "workId"))
        .map(publicVerification),
  });
  registry.register({
    operation: "work.directive.list",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "runId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const runId = value.runId === undefined ? undefined : text(value.runId, "runId");
      return ((await dependencies.readModel.directives?.(context)) ?? [])
        .filter((directive) => directive.workId === workId && (runId === undefined || directive.runId === runId))
        .map(publicDirective);
    },
  });
  registry.register({
    operation: "work.rooms",
    requiredScopes: ["collaboration:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const messages = (await dependencies.readModel.messages?.(context)) ?? [];
      return (await dependencies.readModel.rooms(context))
        .filter((room) => room.workId === workId)
        .map((room) => {
          // 소비량은 방에 저장돼 있지 않고 메시지의 합입니다.
          const roomMessages = messages.filter((message) => message.roomId === room.roomId);
          const usedTokens = roomMessages.reduce((sum, message) => sum + (message.tokenCount ?? 0), 0);
          const usedCostMicros = roomMessages.reduce((sum, message) => sum + (message.costMicros ?? 0), 0);
          return {
            workId: room.workId,
            roomId: room.roomId,
            name: room.name,
            kind: room.kind,
            status: room.status,
            participantIds: room.participantIds,
            ...(room.participants === undefined ? {} : { participants: room.participants }),
            lastMessageSequence: room.lastMessageSequence,
            ...(room.coordinatorHandle === undefined ? {} : { coordinatorHandle: room.coordinatorHandle }),
            ...(room.roundCount === undefined ? {} : { roundCount: room.roundCount }),
            ...(room.maxRounds === undefined ? {} : { maxRounds: room.maxRounds }),
            ...(room.maxTokens === undefined ? {} : { usedTokens, maxTokens: room.maxTokens }),
            ...(room.maxCostMicros === undefined ? {} : { usedCostMicros, maxCostMicros: room.maxCostMicros }),
          };
        });
    },
  });
  if (dependencies.readModel.sharedContexts) {
    registry.register({
      operation: "work.shared-contexts",
      requiredScopes: ["collaboration:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        return ((await dependencies.readModel.sharedContexts?.(context)) ?? [])
          .filter((reference) => reference.workId === workId)
          .map((reference) => ({
            sharedContextReferenceId: reference.sharedContextReferenceId,
            roomId: reference.roomId,
            sourceKind: reference.sourceKind,
            sourceId: reference.sourceId,
            versionId: reference.versionId,
            checksum: reference.checksum,
          }));
      },
    });
  }
  const workKnowledge = dependencies.workKnowledge;
  if (workKnowledge) {
    registry.register({
      operation: "work.knowledge",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const view = await workKnowledge.get(context, workId);
        if (view.workId !== workId) throw new Error("Work knowledge와 요청한 Work가 일치하지 않습니다");
        return publicWorkKnowledge(view);
      },
    });
  }
  if (workKnowledge?.getWorkspaceSnapshot && dependencies.workspaces) {
    const getWorkspaceSnapshot = workKnowledge.getWorkspaceSnapshot.bind(workKnowledge);
    const verifyWorkspace = async (context: TenantContext, workspaceId: string): Promise<void> => {
      const workspace = await dependencies.workspaces?.get(context, workspaceId);
      if (
        !workspace ||
        workspace.workspaceId !== workspaceId ||
        workspace.status !== "active" ||
        workspace.trust !== "trusted"
      ) {
        throw new ApplicationError({
          category: "authorization",
          severity: "error",
          retryable: false,
          userMessage: "신뢰한 활성 Workspace의 Knowledge만 읽을 수 있습니다",
          operatorCode: "APP_KNOWLEDGE_WORKSPACE_TRUST_REQUIRED",
        });
      }
    };
    const loadProjection = async (
      context: TenantContext,
      workspaceId: string,
      request: KnowledgeProjectionRequest,
    ): Promise<KnowledgeProjection> => {
      await verifyWorkspace(context, workspaceId);
      const selector =
        request.kind === "links" && request.indexVersionId !== undefined && request.snapshotChecksum !== undefined
          ? { indexVersionId: request.indexVersionId, snapshotChecksum: request.snapshotChecksum }
          : undefined;
      const source = await getWorkspaceSnapshot(context, workspaceId, selector);
      return await projectKnowledge(dependencies, context, workspaceId, source, request);
    };
    registry.register({
      operation: "knowledge.index",
      requiredScopes: ["workspace:read", "work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, ["workspaceId"]);
        return { workspaceId: knowledgeSourceId(parsed.workspaceId, "workspace ID") };
      },
      handle: async (context, value) => {
        await verifyWorkspace(context, value.workspaceId);
        return knowledgeIndexView(context, value.workspaceId, await getWorkspaceSnapshot(context, value.workspaceId));
      },
    });
    registry.register({
      operation: "knowledge.graph",
      requiredScopes: ["workspace:read", "work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, ["workspaceId", "lens", "limit"]);
        if (!KNOWLEDGE_GRAPH_LENSES.has(parsed.lens as KnowledgeGraphLensV1))
          throw new Error("Knowledge graph lens가 유효하지 않습니다");
        const limit = boundedInteger(parsed.limit, "Knowledge graph limit", 200);
        if (limit > 200) throw new Error("Knowledge graph limit가 유효하지 않습니다");
        return {
          workspaceId: knowledgeSourceId(parsed.workspaceId, "workspace ID"),
          lens: parsed.lens as KnowledgeGraphLensV1,
          limit,
        };
      },
      handle: async (context, value) => {
        const projection = await loadProjection(context, value.workspaceId, {
          kind: "graph",
          lens: value.lens,
          limit: value.limit,
        });
        const nodes = [...projection.nodes.values()]
          .filter((node) => node.kind === value.lens && !projection.nonCanonicalNodeIds.has(node.nodeId))
          .sort(compareKnowledgeNode)
          .slice(0, value.limit);
        const selected = new Set(nodes.map((node) => node.nodeId));
        return {
          lens: value.lens,
          nodes,
          edges: projection.edges.filter((edge) => selected.has(edge.sourceId) && selected.has(edge.targetId)),
        } satisfies KnowledgeGraphViewV1;
      },
    });
    registry.register({
      operation: "knowledge.links",
      requiredScopes: ["workspace:read", "work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, [
          "workspaceId",
          "nodeId",
          "limit",
          "indexVersionId",
          "snapshotChecksum",
          "relationIds",
        ]);
        if ((parsed.indexVersionId === undefined) !== (parsed.snapshotChecksum === undefined)) {
          throw new Error("Knowledge frozen index selector는 version과 checksum이 함께 필요합니다");
        }
        const relationIds =
          parsed.relationIds === undefined
            ? undefined
            : Array.isArray(parsed.relationIds) && parsed.relationIds.length > 0 && parsed.relationIds.length <= 200
              ? parsed.relationIds.map((relationId) => knowledgeSourceId(relationId, "relation ID"))
              : (() => {
                  throw new Error("Knowledge exact relation ID 목록이 유효하지 않습니다");
                })();
        if (relationIds && new Set(relationIds).size !== relationIds.length) {
          throw new Error("Knowledge exact relation ID는 중복될 수 없습니다");
        }
        if (relationIds && parsed.indexVersionId === undefined) {
          throw new Error("Knowledge exact relation 조회에는 frozen index selector가 필요합니다");
        }
        const limit = boundedInteger(parsed.limit, "Knowledge links limit", relationIds?.length ?? 100);
        if (limit > 200) throw new Error("Knowledge links limit가 유효하지 않습니다");
        return {
          workspaceId: knowledgeSourceId(parsed.workspaceId, "workspace ID"),
          nodeId: knowledgeNodeId(parsed.nodeId),
          limit,
          ...(parsed.indexVersionId === undefined
            ? {}
            : {
                indexVersionId: knowledgeSourceId(parsed.indexVersionId, "index ID"),
                snapshotChecksum: knowledgeHash(parsed.snapshotChecksum, "snapshot checksum"),
              }),
          ...(relationIds === undefined ? {} : { relationIds }),
        };
      },
      handle: async (context, value) => {
        const projection = await loadProjection(context, value.workspaceId, {
          kind: "links",
          nodeId: value.nodeId,
          limit: value.limit,
          ...(value.indexVersionId === undefined
            ? {}
            : { indexVersionId: value.indexVersionId, snapshotChecksum: value.snapshotChecksum }),
          ...(value.relationIds === undefined ? {} : { relationIds: value.relationIds }),
        });
        if (!projection.nodes.has(value.nodeId)) {
          throw new ApplicationError({
            category: "not-found",
            severity: "error",
            retryable: false,
            userMessage: "Workspace Knowledge node를 찾을 수 없습니다",
            operatorCode: "APP_KNOWLEDGE_NODE_NOT_FOUND",
          });
        }
        const links = new Map<string, KnowledgeLinkViewV1>();
        for (const edge of projection.edges) {
          const outgoing = edge.sourceId === value.nodeId;
          const incoming = edge.targetId === value.nodeId;
          if (!outgoing && !incoming) continue;
          const node = projection.nodes.get(outgoing ? edge.targetId : edge.sourceId);
          if (!node) throw new Error("Knowledge link endpoint 계보가 끊겼습니다");
          const link: KnowledgeLinkViewV1 = {
            node,
            kind: edge.kind,
            direction: outgoing ? "outgoing" : "incoming",
            ...(edge.unresolved === undefined ? {} : { unresolved: edge.unresolved }),
            ...(edge.relationId === undefined ? {} : { relationId: edge.relationId }),
            ...(edge.relationKey === undefined ? {} : { relationKey: edge.relationKey }),
            ...(edge.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: edge.sourceSymbolKey }),
            ...(edge.targetSymbolKey === undefined ? {} : { targetSymbolKey: edge.targetSymbolKey }),
            ...(edge.targetText === undefined ? {} : { targetText: edge.targetText }),
            ...(edge.snapshotChecksum === undefined ? {} : { snapshotChecksum: edge.snapshotChecksum }),
            ...(edge.sourcePath === undefined ? {} : { sourcePath: edge.sourcePath }),
            ...(edge.sourceLine === undefined ? {} : { sourceLine: edge.sourceLine }),
          };
          links.set(
            [node.nodeId, link.kind, link.direction, link.unresolved ? "1" : "0", link.relationId ?? ""].join("\0"),
            link,
          );
        }
        const selectedLinks = [...links.values()].filter(
          (link) => value.relationIds === undefined || (link.relationId && value.relationIds.includes(link.relationId)),
        );
        if (
          value.relationIds !== undefined &&
          value.relationIds.some(
            (relationId) => selectedLinks.filter((link) => link.relationId === relationId).length !== 1,
          )
        ) {
          throw new Error("Knowledge exact relation을 선택한 frozen node에서 유일하게 찾을 수 없습니다");
        }
        return selectedLinks
          .sort(
            (left, right) =>
              left.node.nodeId.localeCompare(right.node.nodeId) ||
              left.kind.localeCompare(right.kind) ||
              left.direction.localeCompare(right.direction) ||
              (left.relationId ?? "").localeCompare(right.relationId ?? ""),
          )
          .slice(0, value.limit);
      },
    });
  }
  if (dependencies.readModel.messages) {
    registry.register({
      operation: "work.messages",
      requiredScopes: ["collaboration:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "roomId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const roomId = text(value.roomId, "roomId");
        return ((await dependencies.readModel.messages?.(context)) ?? [])
          .filter((message) => message.workId === workId && message.roomId === roomId)
          .map((message) => {
            const proposal = message.staffingProposal;
            const staffingProposal =
              proposal === undefined
                ? undefined
                : {
                    proposalId: proposal.proposalId,
                    status: proposal.status,
                    ...(proposal.approvalId === undefined ? {} : { approvalId: proposal.approvalId }),
                    nodes: proposal.nodes.map((node) => ({
                      handle: node.handle,
                      name: node.name,
                      scope: node.scope,
                      workId: node.workId,
                      parentHandle: node.parentHandle,
                      role: node.role,
                      capabilities: node.capabilities,
                    })),
                    impactNodeHandles: proposal.impactNodeHandles,
                    impactReferenceCount: proposal.impactReferenceCount,
                    fromOrganizationVersion: proposal.fromOrganizationVersion,
                    toOrganizationVersion: proposal.toOrganizationVersion,
                  };
            return {
              messageId: message.messageId,
              sequence: message.sequence,
              messageType: message.messageType,
              authorKind: message.authorKind,
              authorId: message.authorId,
              ...(message.recipientAgentId === undefined ? {} : { recipientAgentId: message.recipientAgentId }),
              ...(message.authorDisplayName === undefined ? {} : { authorDisplayName: message.authorDisplayName }),
              ...(message.providerId === undefined ? {} : { providerId: message.providerId }),
              ...(message.modelId === undefined ? {} : { modelId: message.modelId }),
              content: message.content,
              createdAt: message.createdAt,
              // 인과 계보. 반론이 무엇을 반박하는지, 답변이 어느 질문에 붙는지가 여기서 옵니다.
              ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
              ...(message.causedByMessageId === undefined ? {} : { causedByMessageId: message.causedByMessageId }),
              ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
              ...(message.contextVersionId === undefined ? {} : { contextVersionId: message.contextVersionId }),
              ...(message.executionId === undefined ? {} : { executionId: message.executionId }),
              ...(message.artifactVersionId === undefined ? {} : { artifactVersionId: message.artifactVersionId }),
              ...(staffingProposal === undefined ? {} : { staffingProposal }),
            };
          });
      },
    });
  }
  if (dependencies.readModel.records) {
    registry.register({
      operation: "work.records",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) =>
        ((await dependencies.readModel.records?.(context)) ?? [])
          .filter((record) => record.workId === text(value.workId, "workId"))
          .map((record) => ({
            recordId: record.recordId,
            version: record.version,
            summary: record.summary,
            artifactIds: record.artifactIds,
            verificationIds: record.verificationIds,
            finalizedAt: record.finalizedAt,
          })),
    });
  }
  registry.register({
    operation: "runtime.execution.get",
    requiredScopes: ["runtime:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["executionId"]),
    handle: async (context, value) => {
      const executionId = text(value.executionId, "executionId");
      const execution = (await dependencies.readModel.executions(context)).find(
        (candidate) => candidate.executionId === executionId,
      );
      if (!execution)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Runtime execution을 찾을 수 없습니다",
          operatorCode: "APP_EXECUTION_NOT_FOUND",
        });
      return publicExecution(execution);
    },
  });
  registry.register({
    operation: "governance.approval.list",
    requiredScopes: ["approval:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "status"]),
    handle: async (context, value) => {
      const workId = value.workId === undefined ? undefined : text(value.workId, "workId");
      const status = value.status === undefined ? undefined : text(value.status, "status");
      return (await dependencies.readModel.approvals(context))
        .filter((approval) => workId === undefined || approval.workId === workId)
        .filter((approval) => status === undefined || approval.status === status)
        .map(publicApproval);
    },
  });
  registry.register({
    operation: "governance.approval.get",
    requiredScopes: ["approval:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["approvalId"]),
    handle: async (context, value) => {
      const approvalId = text(value.approvalId, "approvalId");
      const approval = (await dependencies.readModel.approvals(context)).find(
        (candidate) => candidate.approvalId === approvalId,
      );
      if (!approval)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Approval을 찾을 수 없습니다",
          operatorCode: "APP_APPROVAL_NOT_FOUND",
        });
      return publicApproval(approval);
    },
  });
  registry.register({
    operation: "organization.list",
    requiredScopes: ["organization:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: (context) =>
      Promise.resolve([
        { organizationId: context.organizationId, membershipId: context.membershipId, role: context.role },
      ]),
  });
  const snapshot = dependencies.snapshot;
  if (snapshot) {
    registry.register({
      operation: "organization.graph.snapshot",
      requiredScopes: ["organization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => organizationGraphSnapshotView(await snapshot.project(context)),
    });
  }
  if (dependencies.runtime) {
    registry.register({
      operation: "runtime.execution.events",
      requiredScopes: ["runtime:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["executionId", "afterSequence"]),
      handle: async (context, value) => {
        const events = await dependencies.runtime?.listEvents(
          context,
          text(value.executionId, "executionId"),
          value.afterSequence === undefined ? 0 : Number(value.afterSequence),
        );
        return (events ?? []).map((event) => ({
          eventId: event.event_id,
          sequence: event.sequence,
          type: event.event_type,
          createdAt: event.created_at,
        }));
      },
    });
  }
  if (dependencies.runtime && dependencies.router) {
    registry.register({
      operation: "runtime.execution.subscription-lineage",
      requiredScopes: ["runtime:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, ["executionId", "correlationId"]);
        if ((parsed.executionId === undefined) === (parsed.correlationId === undefined)) {
          throw new Error("executionId와 correlationId 중 하나만 필요합니다");
        }
        return parsed;
      },
      handle: async (context, value) => {
        const runtime = dependencies.runtime as NonNullable<ApplicationQueryDependencies["runtime"]>;
        const router = dependencies.router as NonNullable<ApplicationQueryDependencies["router"]>;
        return value.executionId === undefined
          ? await runtimeSubscriptionLineagesByCorrelation(
              context,
              text(value.correlationId, "correlationId"),
              runtime,
              router,
            )
          : await runtimeSubscriptionLineage(context, text(value.executionId, "executionId"), runtime, router);
      },
    });
  }
  if (dependencies.extension) {
    registry.register({
      operation: "extension.list",
      requiredScopes: ["extension:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => ((await dependencies.extension?.list(context)) ?? []).map(publicExtensionInstallation),
    });
  }
  if (dependencies.growth) {
    const projectSuggestion = (detail: GrowthSuggestionDetails) => {
      const { suggestion } = detail;
      const evaluation = detail.evaluation;
      return {
        suggestionId: suggestion.suggestion_id,
        workId: suggestion.work_id,
        targetKind: suggestion.target_kind,
        operation: suggestion.operation,
        summary: suggestion.summary,
        rationale: suggestion.rationale,
        expectedEffect: suggestion.expected_effect,
        riskSummary: suggestion.risk_summary,
        status: suggestion.status,
        revision: suggestion.revision,
        ...(typeof suggestion.created_at === "undefined"
          ? {}
          : { createdAt: timestamp(suggestion.created_at, "Growth Suggestion") }),
        reflectionRunId: suggestion.reflection_run_id,
        sourceReferenceIds: suggestion.source_reference_ids,
        ...(detail.patch === undefined ? {} : { patch: detail.patch }),
        ...(detail.adoption === undefined ? {} : { adoption: detail.adoption }),
        ...(evaluation === undefined
          ? {}
          : {
              evaluation: {
                evaluationRunId: evaluation.evaluationRunId,
                outcome: evaluation.outcome,
                strategyVersionId: evaluation.strategyVersionId,
                inputHash: evaluation.inputHash,
                signals: evaluation.signals.map((signal) => ({
                  signalId: signal.signalId,
                  group: signal.group,
                  origin: signal.origin,
                  outcome: signal.outcome,
                  score: signal.score,
                  adapterId: signal.adapterId,
                  adapterVersion: signal.adapterVersion,
                  note: signal.unit,
                  sourceId: signal.sourceId,
                  sourceChecksum: signal.sourceChecksum,
                  fresh: signal.fresh,
                })),
              },
            }),
      };
    };
    registry.register({
      operation: "growth.memories",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const memory = await dependencies.growth?.getActiveExplicitMemory(context);
        if (memory === undefined) return [];
        return [
          {
            memoryVersionId: memory.memoryVersionId,
            scope: "user",
            subjectId: context.userId,
            version: memory.version,
            revision: memory.version,
            status: memory.status,
            entryKeys: memory.entries.map((entry) => entry.key),
            sourceReferenceIds: [...new Set(memory.entries.flatMap((entry) => entry.sourceReferenceIds))].sort(),
            checksum: memory.checksum,
            entries: memory.entries.map((entry) => ({
              key: entry.key,
              kind: entry.kind,
              value: entry.value,
              authority: "explicit" as const,
            })),
          },
        ];
      },
    });
    registry.register({
      operation: "growth.configuration.get",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["requesterUserId"]),
      handle: async (context, value) =>
        await dependencies.growth?.resolveConfiguration(
          context,
          value.requesterUserId === undefined ? undefined : text(value.requesterUserId, "requesterUserId"),
        ),
    });
    registry.register({
      operation: "growth.suggestions",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "status", "limit"]),
      handle: async (context, value) => {
        const details =
          (await dependencies.growth?.listSuggestionDetails?.(context, {
            ...(value.workId === undefined ? {} : { workId: text(value.workId, "workId") }),
            ...(value.status === undefined ? {} : { status: text(value.status, "status") as never }),
            limit: boundedInteger(value.limit, "limit", 100),
          })) ??
          (
            await dependencies.growth?.listSuggestions(context, {
              ...(value.workId === undefined ? {} : { workId: text(value.workId, "workId") }),
              ...(value.status === undefined ? {} : { status: text(value.status, "status") as never }),
              limit: boundedInteger(value.limit, "limit", 100),
            })
          )?.map((suggestion) => ({
            suggestion,
          })) ??
          [];
        return details.map((detail) => projectSuggestion(detail as GrowthSuggestionDetails));
      },
    });
    registry.register({
      operation: "growth.suggestion.get",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["suggestionId"]),
      handle: async (context, value) => {
        const detail = await dependencies.growth?.getSuggestionDetails(
          context,
          text(value.suggestionId, "suggestionId"),
        );
        if (detail === undefined) throw new Error("Growth Suggestion 상세를 찾을 수 없습니다");
        return projectSuggestion(detail);
      },
    });
    registry.register({
      operation: "growth.effects",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["adoptionId", "limit"]),
      handle: async (context, value) =>
        await dependencies.growth?.listEffectEvaluations(context, {
          ...(value.adoptionId === undefined ? {} : { adoptionId: text(value.adoptionId, "adoptionId") }),
          limit: boundedInteger(value.limit, "limit", 100),
        }),
    });
  }
  const assuranceBindings = dependencies.assuranceBindings;
  if (assuranceBindings) {
    registry.register({
      operation: "assurance.binding.get",
      requiredScopes: ["assurance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["bindingVersionId"]),
      handle: async (context, value) =>
        assuranceBindingView(await assuranceBindings.get(context, text(value.bindingVersionId, "bindingVersionId"))),
    });
    registry.register({
      operation: "assurance.binding.active",
      requiredScopes: ["assurance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "planVersionId"]),
      handle: async (context, value) => {
        const active = await assuranceBindings.getActive(
          context,
          text(value.workId, "workId"),
          text(value.planVersionId, "planVersionId"),
        );
        return active ? assuranceBindingView(active) : undefined;
      },
    });
  }
  if (dependencies.providers) {
    registry.register({
      operation: "router.credentials",
      requiredScopes: ["router:read"],
      allowedRoles: ["owner", "admin"],
      validate: (value) => object(value, ["providerId"]),
      handle: async (context, value) =>
        (
          await dependencies.providers?.listCredentials(
            context,
            value.providerId === undefined ? undefined : text(value.providerId, "providerId"),
          )
        )?.map((credential) => ({
          credentialId: credential.credential_id,
          providerId: credential.provider_id,
          endpointId: credential.endpoint_id,
          label: credential.label,
          status: credential.status,
          // 화면이 키를 지우려면 낙관적 동시성 version이 필요하고, 언제 갈았는지 보이려면 secret version이 필요합니다.
          version: credential.version,
          secretVersion: credential.secret_version,
          priority: credential.priority,
          weight: credential.weight,
          requestCount: credential.request_count,
          inputTokens: credential.input_tokens,
          outputTokens: credential.output_tokens,
          costMicros: credential.cost_micros,
        })) ?? [],
    });
  }
  if (dependencies.router) {
    registry.register({
      operation: "router.attempts",
      requiredScopes: ["router:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, ["limit"]);
        const limit = boundedInteger(parsed.limit, "limit", 50);
        if (limit > 200) throw new Error("limit가 유효하지 않습니다");
        return { limit };
      },
      handle: async (context, value) => {
        const attempts = await dependencies.router?.listAttempts(context, value.limit);
        if (!attempts) return [];
        const withLineage = attempts.map((attempt) => {
          const raw = attempt as unknown as Record<string, unknown>;
          return {
            attempt,
            executionId: routeAttemptOptionalText(raw.execution_id, "실행 ID"),
            optimizationRunId: routeAttemptOptionalText(raw.optimization_run_id, "최적화 평가 run ID"),
            optimizationBatchId: routeAttemptOptionalText(raw.optimization_batch_id, "최적화 배치 ID"),
          };
        });
        const executionIds = new Set(withLineage.flatMap((item) => (item.executionId ? [item.executionId] : [])));
        const optimizationRunIds = new Set([
          ...executionIds,
          ...withLineage.flatMap((item) => (item.optimizationRunId ? [item.optimizationRunId] : [])),
        ]);
        const optimizationBatchIds = new Set(
          withLineage.flatMap((item) => (item.optimizationBatchId ? [item.optimizationBatchId] : [])),
        );
        const [executions, works] =
          executionIds.size === 0
            ? [[], []]
            : await Promise.all([dependencies.readModel.executions(context), dependencies.readModel.works(context)]);
        const executionsById = new Map(
          executions
            .filter(
              (execution) =>
                execution.organizationId === context.organizationId && executionIds.has(execution.executionId),
            )
            .map((execution) => [execution.executionId, execution]),
        );
        const worksById = new Map(
          works.filter((work) => work.organizationId === context.organizationId).map((work) => [work.workId, work]),
        );
        const evaluationRuns = new Map(
          await Promise.all(
            [...optimizationRunIds].map(
              async (runId) =>
                [
                  runId,
                  (await dependencies.optimization?.evaluations.hasEvaluationRun(context, runId)) ?? false,
                ] as const,
            ),
          ),
        );
        const optimizationBatches = new Map(
          await Promise.all(
            [...optimizationBatchIds].map(
              async (batchId) =>
                [batchId, (await dependencies.optimization?.batches.hasBatch(context, batchId)) ?? false] as const,
            ),
          ),
        );
        return withLineage.map((item) => {
          if (item.optimizationBatchId !== undefined && !optimizationBatches.get(item.optimizationBatchId))
            throw new Error("Route Attempt 최적화 batch 계보가 유효하지 않습니다");
          if (item.optimizationRunId !== undefined) {
            if (item.executionId !== undefined || !evaluationRuns.get(item.optimizationRunId))
              throw new Error("Route Attempt 최적화 run 계보가 유효하지 않습니다");
            return publicRouteAttempt(item.attempt, { optimizationRunId: item.optimizationRunId });
          }
          if (item.executionId === undefined) return publicRouteAttempt(item.attempt);
          const execution = executionsById.get(item.executionId);
          const legacyEvaluation = evaluationRuns.get(item.executionId) === true;
          if (execution && legacyEvaluation) throw new Error("Route Attempt 실행 계보가 모호합니다");
          if (!execution) {
            if (!legacyEvaluation || item.optimizationBatchId !== undefined)
              throw new Error("Route Attempt 실행 계보가 유효하지 않습니다");
            return publicRouteAttempt(item.attempt, { optimizationRunId: item.executionId });
          }
          const work = worksById.get(execution.workId);
          if (!work) throw new Error("Route Attempt 실행의 Work 계보가 유효하지 않습니다");
          return publicRouteAttempt(item.attempt, { execution, work });
        });
      },
    });
    registry.register({
      operation: "router.routes",
      requiredScopes: ["router:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        ((await dependencies.router?.listRoutes(context)) ?? []).map((route) => ({
          routeId: route.route_id,
          name: route.name,
          routeKind: route.route_kind,
          credentialPolicy: route.credential_policy,
          dataPolicy: route.data_policy,
          equivalenceGroup: route.equivalence_group,
          spentMicros: route.spent_micros,
          totalBudgetMicros: route.total_budget_micros,
          enabled: route.enabled,
        })),
    });
  }
  if (dependencies.providers && dependencies.router) {
    registry.register({
      operation: "router.catalog",
      requiredScopes: ["router:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const [providers, endpoints, models, candidates] = await Promise.all([
          dependencies.providers?.listProviders(context),
          dependencies.providers?.listEndpoints(context),
          dependencies.router?.listModels(context),
          dependencies.router?.listCandidates(context),
        ]);
        return {
          providers: (providers ?? []).map((provider) => ({
            providerId: provider.provider_id,
            displayName: provider.display_name,
            adapterKind: provider.adapter_kind,
            enabled: provider.enabled,
          })),
          endpoints: (endpoints ?? []).map((endpoint) => ({
            endpointId: endpoint.endpoint_id,
            providerId: endpoint.provider_id,
            name: endpoint.name,
            baseUrl: endpoint.base_url,
            local: endpoint.local,
            gatewayKind: endpoint.gateway_kind,
            enabled: endpoint.enabled,
          })),
          models: (models ?? []).map((model) => ({
            modelProfileId: model.model_profile_id,
            providerId: model.provider_id,
            endpointId: model.endpoint_id,
            modelId: model.model_id,
            routeKind: model.route_kind,
            equivalenceGroup: model.equivalence_group,
            verified: model.verified,
            enabled: model.enabled,
          })),
          candidates: (candidates ?? []).map((candidate) => ({
            candidateId: candidate.candidate_id,
            routeId: candidate.route_id,
            modelProfileId: candidate.model_profile_id,
            priority: candidate.priority,
            enabled: candidate.enabled,
          })),
        };
      },
    });
  }
  const subscriptionProviders = dependencies.subscriptionProviders ?? new BuiltinSubscriptionProviderDirectory();
  registry.register({
    operation: "subscription.providers",
    requiredScopes: ["subscription:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: async (context) => (await subscriptionProviders.list(context)).map(publicSubscriptionProvider),
  });
  if (dependencies.subscriptionAccounts) {
    registry.register({
      operation: "subscription.accounts",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        (await subscriptionAccountRows(context, dependencies)).map(({ account, connector, quota }) => ({
          accountId: account.account_id,
          providerId: account.provider_id,
          alias: account.alias,
          scope: account.scope,
          canManage: account.owner_user_id === context.userId,
          connectorId: account.connector_id,
          ...(connector === undefined
            ? {}
            : {
                connectorLocation: connector.location,
                connectorExecutionKind: connector.execution_kind,
                connectorStatus: connector.status,
              }),
          billingKind: account.billing_kind,
          ...(connector?.location === "server"
            ? { profileHandle: subscriptionProfileHandle(context.organizationId, account.account_id) }
            : {}),
          status: account.status,
          version: account.version,
          ...(account.cooldown_until === undefined
            ? {}
            : { cooldownUntil: timestamp(account.cooldown_until, "구독 계정 cooldown") }),
          ...(quota === undefined
            ? {}
            : {
                windows: quota.windows,
                minimumRemainingRatio: quota.minimumRemainingRatio,
                earliestResetAt: quota.earliestResetAt,
                quotaExhausted: quota.exhausted,
                quotaObservedAt: quota.observedAt,
              }),
        })),
    });
  }
  if (dependencies.subscriptionAccounts && dependencies.subscriptionQuota) {
    registry.register({
      operation: "subscription.quota",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["accountId"]),
      handle: async (context, value) =>
        (
          await subscriptionAccountRows(
            context,
            dependencies,
            value.accountId === undefined ? undefined : text(value.accountId, "accountId"),
          )
        ).flatMap(({ quota }) => (quota === undefined ? [] : [quota])),
    });
  }
  if (dependencies.subscriptionPolicy) {
    registry.register({
      operation: "subscription.policy",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["providerId"]),
      handle: async (context, value) =>
        (
          await dependencies.subscriptionPolicy?.list(
            context,
            value.providerId === undefined ? undefined : text(value.providerId, "providerId"),
          )
        )?.map(publicSubscriptionPolicy) ?? [],
    });
  }
  if (dependencies.subscriptionAccounts && dependencies.subscriptionConnectors && dependencies.subscriptionQuota) {
    registry.register({
      operation: "subscription.doctor",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["accountId"]),
      handle: async (context, value) =>
        (
          await subscriptionAccountRows(
            context,
            dependencies,
            value.accountId === undefined ? undefined : text(value.accountId, "accountId"),
          )
        ).map(({ account, connector, quota }) => {
          const action =
            account.status === "needs-reauth"
              ? "reauth"
              : connector?.status !== "ready"
                ? "reconnect"
                : quota?.exhausted || account.status === "cooldown"
                  ? "wait-for-reset"
                  : account.status === "active"
                    ? "none"
                    : "inspect";
          return {
            accountId: account.account_id,
            providerId: account.provider_id,
            alias: account.alias,
            accountStatus: account.status,
            connectorId: account.connector_id,
            connectorLocation: connector?.location,
            connectorStatus: connector?.status ?? "unavailable",
            quotaStatus: quota === undefined ? "unknown" : quota.exhausted ? "exhausted" : "available",
            ...(quota?.earliestResetAt === undefined ? {} : { earliestResetAt: quota.earliestResetAt }),
            action,
          };
        }),
    });
  }
  if (dependencies.optimization) {
    registry.register({
      operation: "optimization.policy",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const policy = await dependencies.optimization?.evaluations.getActivePolicy(context);
        return policy === undefined ? [] : [projectOptimizationRecord(policy, OPTIMIZATION_POLICY_FIELDS)];
      },
    });
    registry.register({
      operation: "optimization.receipts",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = value.roleKey === undefined ? undefined : text(value.roleKey, "roleKey");
        if (roleKey !== undefined && !isOptimizationRoleKey(roleKey))
          throw new Error("지원하지 않는 최적화 roleKey입니다");
        return projectOptimizationList(
          await dependencies.optimization?.evaluations.listReceipts(context, roleKey),
          OPTIMIZATION_RECEIPT_FIELDS,
        );
      },
    });
    registry.register({
      operation: "optimization.recommendations",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = value.roleKey === undefined ? undefined : text(value.roleKey, "roleKey");
        if (roleKey !== undefined && !isOptimizationRoleKey(roleKey))
          throw new Error("지원하지 않는 최적화 roleKey입니다");
        return projectOptimizationList(
          await dependencies.optimization?.evaluations.listRecommendations(context, roleKey),
          OPTIMIZATION_RECOMMENDATION_FIELDS,
        );
      },
    });
    registry.register({
      operation: "optimization.observations",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["batchId"]),
      handle: async (context, value) => {
        const batchId = value.batchId === undefined ? undefined : text(value.batchId, "batchId");
        return projectOptimizationList(
          await dependencies.optimization?.batches.listObservations(context, batchId),
          OPTIMIZATION_OBSERVATION_FIELDS,
        );
      },
    });
    registry.register({
      operation: "optimization.batch.active",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = text(value.roleKey, "roleKey");
        if (!isOptimizationRoleKey(roleKey)) throw new Error("지원하지 않는 최적화 roleKey입니다");
        const active = await dependencies.optimization?.batches.getActiveBatch(context, roleKey);
        return active === undefined ? [] : [projectOptimizationRecord(active, OPTIMIZATION_BATCH_FIELDS)];
      },
    });
  }
  if (dependencies.status) {
    registry.register({
      operation: "system.status",
      requiredScopes: ["system:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await dependencies.status?.(context),
    });
  }
}
