import {
  ApplicationClient,
  agentIdentityToken,
  agentRoleToken,
  type ApplicationCommandMapV1,
  type ApprovalViewV1,
  type ArtifactViewV1,
  type AssignmentViewV1,
  type DirectiveViewV1,
  type ExplicitMemoryViewV1,
  type ExecutionViewV1,
  type ExtensionInstallationViewV1,
  type GovernanceAutonomyViewV1,
  type OrganizationGraphSnapshotV1,
  type RoomMessageViewV1,
  type RoomViewV1,
  type SharedContextViewV1,
  type RunViewV1,
  type TaskViewV1,
  type VerificationViewV1,
  type WorkActivityViewV1,
  type WorkDetailV1,
  type KnowledgeReferenceViewV1,
  type KnowledgeGraphLensV1,
  type WorkKnowledgeViewV1,
  type WorkRecordViewV1,
  type WorkSummaryV1,
  type WorkspaceViewV1,
} from "@massion/application/client";
import { listSubscriptionProviderManifests } from "@massion/subscriptions/catalog";

import {
  fixtureDataAdapter,
  type ActivityView,
  type AgentView,
  type ApprovalView,
  type ArtifactView,
  type DesktopSnapshot,
  type EventSemantic,
  type InboxItem,
  type RoomBudgetView,
  type RoomView,
  type RecordView,
  type RunView,
  type SpeakerView,
  type StepState,
  type TaskView,
  type VerificationCriterionStatus,
  type VerificationCriterionView,
  type VerificationView,
  type WorkStatus,
  type WorkView,
} from "./model";
import type { NativeTransport } from "./native-transport";
import { normalizeSearch, type AppLocale } from "./i18n/locale";

export type DesktopBootstrapState = "ready";
export type DesktopStreamHandler = (payload: unknown) => void;
export type DesktopStreamStop = () => Promise<void>;
export type DirectiveMode = "now" | "next-stage";
export type ApprovalVote = "approve" | "reject";
export type DesktopFilter = "active" | "complete";

export interface WorkIndexInput {
  readonly filter: DesktopFilter;
  readonly locale?: AppLocale;
  readonly search: string;
}

export interface StartWorkInput {
  readonly text: string;
  readonly outputLocale?: "en" | "ko";
  readonly workspaceId?: string;
  readonly workspacePaths?: readonly string[];
}

export type DesktopWorkspaceView = WorkspaceViewV1;

export interface StartedWork {
  readonly runId: string;
}

export interface OrganizationNodeView {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly parentHandle?: string;
  readonly status: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  /** 이전 응답과의 호환을 위해 optional이지만, 실제 조직 snapshot 투영은 항상 값을 보존합니다. */
  readonly scope?: "persistent" | "work";
  readonly workId?: string;
  /** Core Office 여덟. 도메인이 변경을 거부하므로 화면이 편성 조작을 아예 내놓지 않습니다. */
  readonly builtin: boolean;
}

export interface OrganizationView {
  readonly version?: number;
  readonly nodes: readonly OrganizationNodeView[];
}

/**
 * `GrowthAutomationMode`(packages/governance/src/contracts.ts:58). 실행 자율성과 «다른 축»입니다.
 * 실행은 「지금 이 일을 사람 없이 해도 되나」이고, 자가개선은 「조직이 자기를 고쳐도 되나」입니다.
 * 전체 권한은 둘 다 사람을 거치지 않겠다는 선언이므로 자가개선도 자동으로 물려받습니다.
 */
export type GrowthAdoptionMode = "review" | "auto";

export interface AutonomyView {
  readonly mode: "automatic" | "review" | "full-access";
  readonly revision: number;
  readonly runtimePermissionStatus: "governed" | "full-access" | "limited";
  readonly permissionLimitReason?: string;
  readonly emergencyStopActive: boolean;
  /** 없으면 아직 정해지지 않은 것이라 `review`로 단정하지 않고 화면이 «모른다»를 말합니다. */
  readonly growthMode?: GrowthAdoptionMode;
  readonly growthReflectionEnabled?: boolean;
  readonly growthConfigurationVersion?: number;
}

/** 전체 권한이면 자가개선도 자동입니다. 이 파생은 화면이 아니라 여기 한 곳이 소유합니다. */
export function effectiveGrowthMode(autonomy: AutonomyView): GrowthAdoptionMode | undefined {
  return autonomy.mode === "full-access" ? "auto" : autonomy.growthMode;
}

export interface EmergencyView {
  readonly active: boolean;
  readonly reason?: string;
  readonly revision: number;
  readonly approvalId?: string;
}

export interface ExtensionView {
  readonly id: string;
  readonly packageName: string;
  readonly status: string;
  readonly activeVersionId?: string;
  readonly activationGeneration: number;
  /** 활성 version의 manifest 선언. 활성화 전이면 비어 있습니다 — 아직 더한 것이 없기 때문입니다. */
  readonly contributions: readonly { readonly kind: string; readonly items: readonly string[] }[];
  readonly permissions: readonly { readonly kind: string; readonly items: readonly string[] }[];
}

/**
 * 확장 표면의 뷰. 헌법 6절이 *"조직에 추가된 Capability를 먼저 보여줘야 한다"*고 요구하고,
 * 8절이 *"확장 화면은 설치 레코드 목록이며 Capability를 설명하지 않는다"*를 격차로 적어 뒀습니다.
 *
 * 도메인에는 있습니다 — `ExtensionContributionDeclaration`·`ExtensionPermissionDeclaration`
 * (`packages/extension-sdk/src/contracts.ts:16,27`). 계약이 노출하는 `ExtensionInstallationViewV1`은
 * 다섯 필드뿐이고 그중 어느 것도 Capability가 아닙니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/extension-capability-handoff.md
 */
export type ContributionKind =
  | "runtimeTools"
  | "organizationTemplates"
  | "growthSignals"
  | "growthTargets"
  | "surfaceConnectors"
  | "eventConsumers"
  | "skills"
  | "modelEvaluationBundles";

export type PermissionKind = "tools" | "network" | "files" | "secrets" | "process" | "mcp" | "storage" | "events";

export interface ExtensionEntryView {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  /** official·verified·community. 설치 판단의 첫 근거입니다. */
  readonly provenance: string;
  readonly installed: boolean;
  /** 설치된 것만 가집니다. `ExtensionInstallationViewV1.state`. */
  readonly state?: string;
  readonly contributions: readonly { readonly kind: ContributionKind; readonly items: readonly string[] }[];
  readonly permissions: readonly { readonly kind: PermissionKind; readonly items: readonly string[] }[];
}

export interface ModelProfileView {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly routeKind: string;
}

export interface RouteView {
  readonly routeId: string;
  readonly name: string;
  readonly routeKind: string;
}

export interface RouterCatalogView {
  readonly endpoints?: readonly {
    readonly endpointId: string;
    readonly providerId: string;
    readonly name: string;
    readonly baseUrl: string;
  }[];
  readonly models?: readonly ModelProfileView[];
}

export interface SettingsView {
  readonly catalog: unknown;
  readonly credentials: unknown;
  readonly routes: unknown;
  readonly providers: unknown;
  readonly accounts: unknown;
  readonly quota: unknown;
  readonly policy: unknown;
}

/** `router.routes` + `router.catalog.candidates`. 요청이 어느 모델로 가는지입니다. */
/**
 * `route_attempt` 한 줄. 모델 호출 한 번이 어느 Work에서 나와 얼마를 썼는지입니다.
 * `fallbackFrom`이 있으면 앞선 시도가 막혀서 넘어온 것입니다 — 사슬이 여기서 보입니다.
 */
export interface RouteAttemptView {
  readonly attemptId: string;
  /** ISO. 화면이 날짜·시각을 각자 잘라 씁니다. */
  readonly at: string;
  readonly routeId: string;
  /** 계보 정본. Provider 등록이 제거돼도 남습니다. */
  readonly modelProfileId: string;
  /**
   * 등록이 제거된 과거 호출에는 없습니다. 이름을 지어내는 대신 화면이 「등록 제거됨」이라고 말합니다.
   * 행 자체는 빼지 않습니다 — 예산의 본체는 관측이라 지출 합계에서 조용히 사라지면 안 됩니다.
   */
  readonly modelId?: string;
  readonly providerId?: string;
  readonly executionId?: string;
  readonly optimizationRunId?: string;
  readonly optimizationBatchId?: string;
  readonly status: "succeeded" | "failed" | "interrupted" | "running";
  readonly statusCode?: number;
  readonly failureClass?: string;
  /** 어느 정도로 생각하게 했는지. 같은 모델이라도 비용이 갈립니다. */
  readonly effort?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly costMicros: number;
  readonly durationMs?: number;
  readonly fallbackFrom?: string;
  /** 실행 계보(`executionId`)가 가리키는 Work입니다. */
  readonly workId?: string;
  readonly workTitle?: string;
}

export interface ModelRouteView {
  readonly routeId: string;
  readonly name: string;
  readonly routeKind: string;
  readonly enabled: boolean;
  readonly spentMicros: number;
  readonly totalBudgetMicros: number;
  /** 호출 한 번의 상한. 한도를 바꿀 때 이 값을 함께 보내야 지워지지 않습니다. */
  readonly requestBudgetMicros: number;
  /** 이 경로가 쓸 수 있는 모델 수. 0이면 경로가 있어도 실행되지 않습니다. */
  readonly candidateCount: number;
  /** 우선순위가 가장 높은 후보의 모델 id. 이 경로가 실제로 부르는 모델입니다. */
  readonly primaryModelId?: string;
  /** 그 모델이 이 컴퓨터에서 도는지. 로컬 우선 제품이라 데이터가 나가는지가 먼저 보여야 합니다. */
  readonly primaryLocal?: boolean;
  /** 그 모델 프로필이 검증됐는지. */
  readonly primaryVerified?: boolean;
  /**
   * 우선순위 순서 그대로의 후보 사슬입니다. 첫 번째가 막히면 다음으로 넘어갑니다.
   * 「모델 하나가 죽어도 조직은 계속 돈다」가 이 목록으로만 증명됩니다 — 개수만으로는 안 됩니다.
   */
  readonly candidates: readonly ModelRouteCandidateView[];
}

export interface ModelRouteCandidateView {
  readonly modelId: string;
  readonly providerId: string;
  /** 이 모델이 이 컴퓨터에서 도는지. 로컬 우선 제품이라 데이터가 나가는지가 먼저 보여야 합니다. */
  readonly local: boolean;
  /** `model_verification_evidence`가 있는지. 카탈로그에 있는 것과 응답하는 것은 다릅니다. */
  readonly verified: boolean;
  /** 이 후보가 속한 Provider의 circuit이 열려 있으면 지금은 건너뜁니다. */
  readonly blocked?: boolean;
}

/*
 * ── 근거 그래프 ───────────────────────────────────────────────────
 *
 * 도메인은 관계를 이미 갖고 있습니다: `packages/evidence/src/extractors.ts:31`이
 * `contains | imports | calls | implements | documents`를 뽑고,
 * `CodeGraphService.neighbors()`(graph.ts:29)가 depth 1~5로 실제 순회합니다.
 *
 * 전역 graph는 Application 계약이 Work·reference·artifact 정본으로 제공합니다.
 * `WorkKnowledgeViewV1.references`의 코드 관계는 아직 평평하므로 아래 Work 상세의 관계는 fixture 표현입니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/knowledge-graph-handoff.md
 */

/** @massion/evidence의 relation kind. 한글 문구는 화면이 소유합니다. */
export type KnowledgeRelationKind = "contains" | "imports" | "calls" | "implements" | "documents";

export interface KnowledgeRelationView {
  readonly kind: KnowledgeRelationKind;
  /** outgoing = 이 심볼이 상대를 가리킴, incoming = 상대가 이 심볼을 가리킴. */
  readonly direction: "outgoing" | "incoming";
  readonly qualifiedName: string;
  readonly relativePath: string;
  /** 실제 이웃 노드. 오래된 fixture 관계는 이 필드 없이도 표시할 수 있습니다. */
  readonly node?: KnowledgeNodeView;
  readonly relationId?: string;
  readonly relationKey?: string;
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText?: string;
  readonly snapshotChecksum?: string;
  readonly sourcePath?: string;
  readonly sourceLine?: number;
  /**
   * 인덱스 밖을 가리켜 아직 이어지지 않은 관계(`CodeGraphResult.unresolved`).
   * 없는 연결을 이어진 것처럼 그리지 않기 위해 그대로 표시합니다.
   */
  readonly unresolved?: boolean;
}

export interface KnowledgeReferenceView extends KnowledgeReferenceViewV1 {
  readonly relations?: readonly KnowledgeRelationView[];
}

export interface WorkKnowledgeView extends Omit<WorkKnowledgeViewV1, "references"> {
  readonly workspaceId?: string;
  readonly references: readonly KnowledgeReferenceView[];
}

/**
 * 완성본 기준 지식. 관계 셋을 한 이웃 목록으로 합친 모습입니다 —
 * 코드 관계(evidence)뿐 아니라 이 심볼을 쓴 Work·산출물·에이전트까지 한 자리에서 봅니다.
 * 그게 ADR-002가 말한 "합쳐진 이웃 조회"의 결과 모양입니다.
 */
const fixtureKnowledgeNodes: readonly KnowledgeNodeView[] = [
  { nodeId: "work:churn-q3", kind: "work", label: "3분기 고객 이탈 원인 분석", detail: "진행 중" },
  { nodeId: "work:partner-contract", kind: "work", label: "파트너 계약서 검토", detail: "막힘" },
  { nodeId: "work:weekly-ops", kind: "work", label: "주간 운영 보고서", detail: "진행 중" },
  {
    nodeId: "document:cohort-md",
    kind: "document",
    label: "코호트 정의 규칙",
    detail: "docs/analytics/cohort.md",
    group: "analytics",
  },
  { nodeId: "document:runbook-md", kind: "document", label: "운영 런북", detail: "docs/ops/runbook.md", group: "ops" },
  {
    nodeId: "document:metrics-md",
    kind: "document",
    label: "지표 사전",
    detail: "docs/analytics/metrics.md",
    group: "analytics",
  },
  { nodeId: "file:cohort-ts", kind: "file", label: "cohort.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:window-ts", kind: "file", label: "window.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:segment-ts", kind: "file", label: "segment.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:churn-ts", kind: "file", label: "churn.ts", detail: "src/report", group: "report" },
  { nodeId: "file:ports-ts", kind: "file", label: "ports.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "symbol:resolveCohort", kind: "symbol", label: "resolveCohort", detail: "cohort.ts:42–88" },
  { nodeId: "symbol:normalizeWindow", kind: "symbol", label: "normalizeWindow", detail: "window.ts:12–39" },
  { nodeId: "symbol:loadSegments", kind: "symbol", label: "loadSegments", detail: "segment.ts:8–51" },
  { nodeId: "symbol:buildChurnReport", kind: "symbol", label: "buildChurnReport", detail: "churn.ts:20–96" },
  { nodeId: "symbol:CohortResolver", kind: "symbol", label: "CohortResolver", detail: "ports.ts:5–18" },
  { nodeId: "artifact:churn-brief", kind: "artifact", label: "라벨링 기준 브리프", detail: "evidence-brief" },
];

/**
 * 하나의 평평한 간선 목록. 관계 저장소 셋(evidence·organization·growth)을 합치면
 * 이 모양이 됩니다. 렌즈별 그래프와 노드별 연결 목록을 둘 다 여기서 파생합니다.
 */
const fixtureKnowledgeEdges: readonly KnowledgeGraphEdgeView[] = [
  { kind: "contains", sourceId: "file:cohort-ts", targetId: "symbol:resolveCohort" },
  { kind: "contains", sourceId: "file:window-ts", targetId: "symbol:normalizeWindow" },
  { kind: "contains", sourceId: "file:segment-ts", targetId: "symbol:loadSegments" },
  { kind: "contains", sourceId: "file:churn-ts", targetId: "symbol:buildChurnReport" },
  { kind: "contains", sourceId: "file:ports-ts", targetId: "symbol:CohortResolver" },
  { kind: "calls", sourceId: "symbol:resolveCohort", targetId: "symbol:normalizeWindow" },
  { kind: "calls", sourceId: "symbol:resolveCohort", targetId: "symbol:loadSegments" },
  { kind: "calls", sourceId: "symbol:buildChurnReport", targetId: "symbol:resolveCohort" },
  { kind: "implements", sourceId: "symbol:resolveCohort", targetId: "symbol:CohortResolver" },
  // 파일끼리는 import가 실재하는 동종 관계입니다.
  { kind: "imports", sourceId: "file:churn-ts", targetId: "file:cohort-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:window-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:segment-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:ports-ts" },
  // 문서끼리도 서로를 가리킵니다.
  { kind: "documents", sourceId: "document:cohort-md", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "document:runbook-md", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "document:cohort-md", targetId: "symbol:resolveCohort" },
  { kind: "documents", sourceId: "document:cohort-md", targetId: "file:cohort-ts" },
  // 코드 밖 관계. 저장소를 합쳐야만 한 그래프에 나옵니다.
  { kind: "documents", sourceId: "work:churn-q3", targetId: "file:cohort-ts" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "file:churn-ts" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "document:cohort-md" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "artifact:churn-brief" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "document:runbook-md" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "file:churn-ts" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "work:partner-contract", targetId: "document:runbook-md" },
];

/*
 * 규모 시험용 더미. 색인 상태가 말하는 수(파일 214 · 심볼 1,836)와 실제 노드 수를 맞춥니다.
 * 화면이 "관계 4,902"라고 써놓고 노드 다섯 개만 그리면 규모에서 무엇이 무너지는지 알 수 없습니다.
 *
 * 난수를 쓰지 않습니다. 시드가 인덱스인 LCG라 다시 열어도 같은 그래프가 나옵니다.
 */
function seeded(index: number): number {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

const FILE_AREAS = ["analytics", "report", "ingest", "billing", "auth", "ops", "ui", "shared"] as const;

function buildScaleNodes(): { nodes: KnowledgeNodeView[]; edges: KnowledgeGraphEdgeView[] } {
  const nodes: KnowledgeNodeView[] = [];
  const edges: KnowledgeGraphEdgeView[] = [];

  // 파일 214개. 손으로 쓴 다섯 개는 앞에 두어 이름으로 찾을 수 있게 합니다.
  const handFiles = fixtureKnowledgeNodes.filter((node) => node.kind === "file");
  for (let i = handFiles.length; i < 214; i += 1) {
    const area = FILE_AREAS[i % FILE_AREAS.length] ?? "shared";
    nodes.push({
      nodeId: `file:gen-${String(i)}`,
      kind: "file",
      label: `${area}-${String(i)}.ts`,
      detail: `src/${area}`,
      group: area,
    });
  }
  // 심볼 1,836개.
  const handSymbols = fixtureKnowledgeNodes.filter((node) => node.kind === "symbol");
  for (let i = handSymbols.length; i < 1836; i += 1) {
    const area = FILE_AREAS[i % FILE_AREAS.length] ?? "shared";
    nodes.push({
      nodeId: `symbol:gen-${String(i)}`,
      kind: "symbol",
      label: `${area}Handler${String(i)}`,
      detail: `${area}-${String(i % 214)}.ts`,
      group: area,
    });
  }
  // 문서 40개.
  const handDocs = fixtureKnowledgeNodes.filter((node) => node.kind === "document");
  for (let i = handDocs.length; i < 40; i += 1) {
    nodes.push({
      nodeId: `document:gen-${String(i)}`,
      kind: "document",
      label: `설계 노트 ${String(i)}`,
      detail: `docs/notes/${String(i)}.md`,
      group: "notes",
    });
  }

  const files = [...handFiles, ...nodes.filter((node) => node.kind === "file")];
  const symbols = [...handSymbols, ...nodes.filter((node) => node.kind === "symbol")];
  const docs = [...handDocs, ...nodes.filter((node) => node.kind === "document")];

  // 파일끼리 import. 앞쪽 파일을 더 많이 물리게 해서 허브가 생기게 합니다(실제 코드가 그렇습니다).
  for (let i = 1; i < files.length; i += 1) {
    const links = 1 + Math.floor(seeded(i) * 3);
    for (let n = 0; n < links; n += 1) {
      const targetIndex = Math.floor(seeded(i * 7 + n) ** 2 * i);
      const source = files[i];
      const target = files[targetIndex];
      if (!source || !target || source.nodeId === target.nodeId) continue;
      edges.push({ kind: "imports", sourceId: source.nodeId, targetId: target.nodeId });
    }
  }
  // 심볼끼리 call.
  for (let i = 1; i < symbols.length; i += 1) {
    const links = 1 + Math.floor(seeded(i * 3) * 2);
    for (let n = 0; n < links; n += 1) {
      const targetIndex = Math.floor(seeded(i * 11 + n) ** 2 * i);
      const source = symbols[i];
      const target = symbols[targetIndex];
      if (!source || !target || source.nodeId === target.nodeId) continue;
      edges.push({ kind: "calls", sourceId: source.nodeId, targetId: target.nodeId });
    }
  }
  // 문서끼리 참조.
  for (let i = 1; i < docs.length; i += 1) {
    const source = docs[i];
    const target = docs[Math.floor(seeded(i * 5) * i)];
    if (!source || !target || source.nodeId === target.nodeId) continue;
    edges.push({ kind: "documents", sourceId: source.nodeId, targetId: target.nodeId });
  }
  return { nodes, edges };
}

const scale = buildScaleNodes();
const allKnowledgeNodes: readonly KnowledgeNodeView[] = [...fixtureKnowledgeNodes, ...scale.nodes];
const allKnowledgeEdges: readonly KnowledgeGraphEdgeView[] = [...fixtureKnowledgeEdges, ...scale.edges];

/**
 * 렌즈 그래프. **같은 종류끼리만 잇습니다.** 업무 지도에는 업무만, 파일 지도에는 파일만 있습니다.
 * 이종 연결(업무↔문서↔파일↔심볼)은 캔버스가 아니라 노드를 눌렀을 때 시트가 보여줍니다.
 *
 * 같은 종류를 잇는 근거는 둘입니다.
 *  - 직접: 파일의 `imports`, 심볼의 `calls`·`implements`처럼 도메인에 실재하는 동종 관계
 *  - 공유: 같은 것을 쓴 사이. 업무끼리가 여기 해당합니다 — 같은 파일을 건드린 업무는 이어져 있습니다
 */
function fixtureGraph(lens: KnowledgeNodeKind): KnowledgeGraphView {
  const nodes = allKnowledgeNodes.filter((node) => node.kind === lens);
  const ids = new Set(nodes.map((node) => node.nodeId));
  const label = new Map(allKnowledgeNodes.map((node) => [node.nodeId, node.label]));

  const direct = allKnowledgeEdges.filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId));
  const seen = new Set(direct.map((edge) => [edge.sourceId, edge.targetId].sort().join("|")));

  // 이웃을 공유하는 쌍을 찾습니다. 방향이 없으므로 한 쌍당 하나만 만듭니다.
  const neighbors = new Map<string, Set<string>>();
  for (const edge of allKnowledgeEdges) {
    for (const [self, other] of [
      [edge.sourceId, edge.targetId],
      [edge.targetId, edge.sourceId],
    ] as const) {
      if (!ids.has(self) || ids.has(other)) continue;
      neighbors.set(self, (neighbors.get(self) ?? new Set()).add(other));
    }
  }
  const derived: KnowledgeGraphEdgeView[] = [];
  const list = [...neighbors];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const first = list[i];
      const second = list[j];
      if (!first || !second) continue;
      const [leftId, left] = first;
      const [rightId, right] = second;
      const key = [leftId, rightId].sort().join("|");
      if (seen.has(key)) continue;
      const shared = [...left].find((id) => right.has(id));
      if (shared === undefined) continue;
      seen.add(key);
      derived.push({
        kind: "documents",
        sourceId: leftId,
        targetId: rightId,
        derivedVia: label.get(shared) ?? shared,
      });
    }
  }
  return { lens, nodes, edges: [...direct, ...derived] };
}

/** 노드 하나의 전체 연결. 렌즈로 좁히지 않습니다. */
function fixtureLinks(nodeId: string): readonly KnowledgeLinkView[] {
  const byId = new Map(allKnowledgeNodes.map((node) => [node.nodeId, node]));
  return allKnowledgeEdges.flatMap((edge) => {
    const otherId = edge.sourceId === nodeId ? edge.targetId : edge.targetId === nodeId ? edge.sourceId : undefined;
    if (otherId === undefined) return [];
    const node = byId.get(otherId);
    if (!node) return [];
    return [
      {
        node,
        kind: edge.kind,
        direction: edge.sourceId === nodeId ? ("outgoing" as const) : ("incoming" as const),
        ...(edge.unresolved === true ? { unresolved: true } : {}),
      },
    ];
  });
}

/**
 * 완성본 기준 근거. 워크스페이스를 고른 Work만 지식을 씁니다.
 * 실 경로는 관계를 못 받으므로 `relations`가 비고, 화면은 목록만 그립니다.
 */
function fixtureKnowledge(workId: string): WorkKnowledgeView {
  if (workId !== "churn-q3") return { workId, status: "not-applicable", references: [] };
  return {
    workId,
    status: "ready",
    repositoryId: "repository-analytics",
    repositoryRevisionId: "revision-8f21c4",
    indexVersionId: "index-2f9a10",
    evidenceBriefId: "evidence-brief-churn",
    freshnessStatus: "fresh",
    query: "코호트 정의 이탈 집계",
    references: [
      {
        referenceId: "reference-cohort",
        kind: "symbol",
        relativePath: "src/analytics/cohort.ts",
        qualifiedName: "resolveCohort",
        startLine: 42,
        endLine: 88,
        contentHash: "a3f1c8",
        relations: [
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "normalizeWindow",
            relativePath: "src/analytics/window.ts",
          },
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "loadSegments",
            relativePath: "src/analytics/segment.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "buildChurnReport",
            relativePath: "src/report/churn.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "compareQuarters",
            relativePath: "src/report/compare.ts",
          },
          {
            kind: "implements",
            direction: "outgoing",
            qualifiedName: "CohortResolver",
            relativePath: "src/analytics/ports.ts",
          },
          {
            kind: "documents",
            direction: "incoming",
            qualifiedName: "코호트 정의 규칙",
            relativePath: "docs/analytics/cohort.md",
          },
        ],
      },
      {
        referenceId: "reference-window",
        kind: "symbol",
        relativePath: "src/analytics/window.ts",
        qualifiedName: "normalizeWindow",
        startLine: 12,
        endLine: 39,
        contentHash: "7c02b1",
        relations: [
          {
            kind: "imports",
            direction: "outgoing",
            qualifiedName: "startOfQuarter",
            relativePath: "src/time/quarter.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "resolveCohort",
            relativePath: "src/analytics/cohort.ts",
          },
          // 인덱스 밖을 가리키는 관계는 이어진 것처럼 그리지 않고 그대로 남깁니다.
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "dayjs",
            relativePath: "node_modules",
            unresolved: true,
          },
        ],
      },
      {
        referenceId: "reference-churn-doc",
        kind: "chunk",
        relativePath: "docs/analytics/cohort.md",
        startLine: 1,
        endLine: 34,
        contentHash: "5be914",
        relations: [
          {
            kind: "documents",
            direction: "outgoing",
            qualifiedName: "resolveCohort",
            relativePath: "src/analytics/cohort.ts",
          },
        ],
      },
    ],
  };
}

/*
 * ── 지식 표면 (ADR-002) ──────────────────────────────────────────
 *
 * 관계 저장소가 셋으로 갈려 있습니다: evidence(코드 관계), organization(OrganizationReference),
 * growth(source_reference_ids). 단일 간선 테이블이 없으므로 실제 경로는 **application 계층 조인**으로
 * 하나의 이웃 조회를 만듭니다. SurrealDB native relation은 §9.6이 성능 실패가
 * 측정될 때만 열라고 했으므로 여기서 열지 않습니다.
 *
 * 인계: docs/phases/30-surface-parity-agent-ux/knowledge-surface-handoff.md
 */

/** 마인드맵 노드가 가리킬 수 있는 것. 코드에 한정하지 않습니다. */
export type KnowledgeNodeKind = "symbol" | "file" | "document" | "work" | "artifact" | "agent";

export interface KnowledgeNodeView {
  readonly nodeId: string;
  readonly kind: KnowledgeNodeKind;
  /** 사람이 읽는 이름. 심볼이면 qualifiedName, 파일이면 파일명. */
  readonly label: string;
  /** 어디에 있는지. 파일 경로이거나 Work 제목입니다. */
  readonly detail?: string;
  /**
   * 색을 나누는 기준. 보통 폴더입니다(옵시디언이 폴더로 묶는 것과 같습니다).
   * 무작위 색이 아니라 이것으로 칠해야 뭉친 색덩이가 실제 구조를 뜻하게 됩니다.
   */
  readonly group?: string;
}

/** 그래프 간선. 방향은 source→target이고, 화면이 중심에 따라 안팎을 정합니다. */
export interface KnowledgeGraphEdgeView {
  readonly kind: KnowledgeRelationKind;
  readonly sourceId: string;
  readonly targetId: string;
  /** 인덱스 밖을 가리켜 아직 이어지지 않은 관계. 이어진 것처럼 그리지 않습니다. */
  readonly unresolved?: boolean;
  /**
   * 직접 관계가 아니라 **공유한 것**으로 이어진 경우 그 이름.
   * 업무끼리는 서로를 부르지 않습니다 — 같은 파일·문서를 썼기 때문에 이어집니다.
   * 왜 이어졌는지 말하지 못하면 사용자에게는 우연한 선으로 보입니다.
   */
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

/**
 * 렌즈 하나의 그래프. 렌즈는 "무엇의 지도를 볼 것인가"이고,
 * 그 종류의 노드와 거기 직접 걸린 것만 담습니다. 전체를 담지 않습니다.
 */
export interface KnowledgeGraphView {
  readonly lens: KnowledgeNodeKind;
  readonly nodes: readonly KnowledgeNodeView[];
  readonly edges: readonly KnowledgeGraphEdgeView[];
}

/** 시트가 보여주는 "무엇과 이어져 있나" 한 줄. */
export interface KnowledgeLinkView {
  readonly node: KnowledgeNodeView;
  readonly kind: KnowledgeRelationKind;
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

/** 워크스페이스가 무엇으로 색인됐나. */
export interface KnowledgeIndexView {
  readonly workspaceId: string;
  readonly status: "ready" | "indexing" | "stale" | "none";
  readonly indexVersionId?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationCount: number;
  readonly indexedAt?: string;
  /** 색인에서 빠진 것. 없는 것을 아는 것도 지식입니다. */
  readonly excluded: readonly string[];
}

const KNOWLEDGE_NODE_KINDS = new Set<KnowledgeNodeKind>(["symbol", "file", "document", "work", "artifact", "agent"]);
const KNOWLEDGE_RELATION_KINDS = new Set<KnowledgeRelationKind>([
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
const KNOWLEDGE_INSTANT =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

function knowledgeRecord(value: unknown, allowed: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이(가) 유효하지 않습니다`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    throw new Error(`${label}에 알 수 없는 필드가 있습니다`);
  return record;
}

function knowledgeString(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  )
    throw new Error(`${label}이(가) 유효하지 않습니다`);
  return value;
}

function knowledgeId(value: unknown, label: string): string {
  const id = knowledgeString(value, label, 256);
  const separator = id.indexOf(":");
  const kind = id.slice(0, separator) as KnowledgeNodeKind;
  if (!KNOWLEDGE_NODE_KINDS.has(kind) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id.slice(separator + 1)))
    throw new Error(`${label}이(가) 유효하지 않습니다`);
  return id;
}

function knowledgeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}이(가) 유효하지 않습니다`);
  return value as number;
}

function knowledgeInstant(value: unknown): string {
  const instant = knowledgeString(value, "Knowledge 색인 시각", 32);
  const parsed = new Date(instant);
  if (!KNOWLEDGE_INSTANT.test(instant) || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== instant)
    throw new Error("Knowledge 색인 시각이 유효하지 않습니다");
  return instant;
}

function knowledgeChecksum(value: unknown, label: string): string {
  const checksum = knowledgeString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error(`${label}이(가) 유효하지 않습니다`);
  return checksum;
}

type KnowledgeRelationMetadata = Pick<
  KnowledgeLinkView,
  | "relationId"
  | "relationKey"
  | "sourceSymbolKey"
  | "targetSymbolKey"
  | "targetText"
  | "snapshotChecksum"
  | "sourcePath"
  | "sourceLine"
>;

const KNOWLEDGE_RELATION_METADATA_FIELDS = [
  "relationId",
  "relationKey",
  "sourceSymbolKey",
  "targetSymbolKey",
  "targetText",
  "snapshotChecksum",
  "sourcePath",
  "sourceLine",
] as const;

function knowledgeRelativePath(value: unknown, label: string): string {
  const path = knowledgeString(value, label, 1_024);
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    throw new Error(`${label}이(가) 정규화된 상대 경로가 아닙니다`);
  return path;
}

function projectKnowledgeRelationMetadata(row: Readonly<Record<string, unknown>>): KnowledgeRelationMetadata {
  const hasMetadata = KNOWLEDGE_RELATION_METADATA_FIELDS.some((field) => row[field] !== undefined);
  if (!hasMetadata) return {};
  const relationId = knowledgeString(row.relationId, "Knowledge relation ID", 128);
  const relationKey = knowledgeString(row.relationKey, "Knowledge relation key", 256);
  const snapshotChecksum = knowledgeString(row.snapshotChecksum, "Knowledge relation snapshot checksum", 64);
  if (!/^[a-f0-9]{64}$/u.test(snapshotChecksum))
    throw new Error("Knowledge relation snapshot checksum이 유효하지 않습니다");
  if (!Number.isSafeInteger(row.sourceLine) || (row.sourceLine as number) < 1)
    throw new Error("Knowledge relation source line이 유효하지 않습니다");
  return {
    relationId,
    relationKey,
    ...(row.sourceSymbolKey === undefined
      ? {}
      : { sourceSymbolKey: knowledgeString(row.sourceSymbolKey, "Knowledge relation source symbol key", 256) }),
    ...(row.targetSymbolKey === undefined
      ? {}
      : { targetSymbolKey: knowledgeString(row.targetSymbolKey, "Knowledge relation target symbol key", 256) }),
    ...(row.targetText === undefined
      ? {}
      : { targetText: knowledgeString(row.targetText, "Knowledge relation target text", 1_024) }),
    snapshotChecksum,
    sourcePath: knowledgeRelativePath(row.sourcePath, "Knowledge relation source path"),
    sourceLine: row.sourceLine as number,
  };
}

interface FrozenKnowledgeRelationView {
  readonly relationId: string;
  readonly relationKey: string;
  readonly kind: KnowledgeRelationKind;
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText: string;
  readonly resolved: boolean;
  readonly relativePath: string;
  readonly startLine: number;
}

function projectFrozenKnowledgeRelations(
  value: unknown,
  selection: "scope" | "direct-search" | "graph-neighbor",
  selectedReferenceId: string,
): ReadonlyMap<string, FrozenKnowledgeRelationView> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw new Error("Work Knowledge provenance path가 유효하지 않습니다");
  const relations = new Map<string, FrozenKnowledgeRelationView>();
  for (const valuePath of value) {
    const path = knowledgeRecord(valuePath, ["seed", "relation"], "Work Knowledge provenance path");
    const seed = knowledgeRecord(path.seed, ["referenceId", "kind", "symbolKey"], "Work Knowledge provenance seed");
    const seedReferenceId = knowledgeString(seed.referenceId, "Work Knowledge provenance seed reference ID", 128);
    if (seed.kind !== "symbol" && seed.kind !== "chunk")
      throw new Error("Work Knowledge provenance seed 종류가 유효하지 않습니다");
    if (seed.symbolKey !== undefined) knowledgeString(seed.symbolKey, "Work Knowledge provenance seed symbol key", 256);
    if (selection === "scope" && seedReferenceId !== selectedReferenceId)
      throw new Error("Work Knowledge scope provenance seed가 선택 reference와 일치하지 않습니다");
    if (path.relation === undefined) {
      if (selection === "graph-neighbor") throw new Error("Work Knowledge graph provenance 관계가 없습니다");
      continue;
    }
    if (selection !== "graph-neighbor") throw new Error("Work Knowledge 직접 provenance에 graph 관계가 있습니다");
    const source = knowledgeRecord(
      path.relation,
      [
        "relationId",
        "relationKey",
        "kind",
        "sourceSymbolKey",
        "targetSymbolKey",
        "targetText",
        "resolved",
        "relativePath",
        "startLine",
      ],
      "Work Knowledge provenance relation",
    );
    if (!KNOWLEDGE_RELATION_KINDS.has(source.kind as KnowledgeRelationKind))
      throw new Error("Work Knowledge provenance relation 종류가 유효하지 않습니다");
    if (typeof source.resolved !== "boolean")
      throw new Error("Work Knowledge provenance relation resolved가 유효하지 않습니다");
    if (!Number.isSafeInteger(source.startLine) || (source.startLine as number) < 1)
      throw new Error("Work Knowledge provenance relation 시작 줄이 유효하지 않습니다");
    const relation: FrozenKnowledgeRelationView = {
      relationId: knowledgeString(source.relationId, "Work Knowledge provenance relation ID", 128),
      relationKey: knowledgeString(source.relationKey, "Work Knowledge provenance relation key", 256),
      kind: source.kind as KnowledgeRelationKind,
      ...(source.sourceSymbolKey === undefined
        ? {}
        : {
            sourceSymbolKey: knowledgeString(
              source.sourceSymbolKey,
              "Work Knowledge provenance source symbol key",
              256,
            ),
          }),
      ...(source.targetSymbolKey === undefined
        ? {}
        : {
            targetSymbolKey: knowledgeString(
              source.targetSymbolKey,
              "Work Knowledge provenance target symbol key",
              256,
            ),
          }),
      targetText: knowledgeString(source.targetText, "Work Knowledge provenance target text", 1_024),
      resolved: source.resolved,
      relativePath: knowledgeRelativePath(source.relativePath, "Work Knowledge provenance relation 경로"),
      startLine: source.startLine as number,
    };
    const previous = relations.get(relation.relationId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(relation))
      throw new Error("Work Knowledge 고정 관계 계보가 충돌합니다");
    relations.set(relation.relationId, relation);
  }
  if (selection === "graph-neighbor" && relations.size === 0)
    throw new Error("Work Knowledge graph provenance 관계가 없습니다");
  return relations;
}

function projectKnowledgeNode(value: unknown): KnowledgeNodeView {
  const row = knowledgeRecord(value, ["nodeId", "kind", "label", "detail", "group"], "Knowledge node");
  if (!KNOWLEDGE_NODE_KINDS.has(row.kind as KnowledgeNodeKind))
    throw new Error("Knowledge node 종류가 유효하지 않습니다");
  const kind = row.kind as KnowledgeNodeKind;
  const nodeId = knowledgeId(row.nodeId, "Knowledge node ID");
  if (!nodeId.startsWith(`${kind}:`)) throw new Error("Knowledge node ID와 종류가 일치하지 않습니다");
  const detail = row.detail === undefined ? undefined : knowledgeString(row.detail, "Knowledge node detail", 1_024);
  if ((kind === "file" || kind === "document") && detail?.startsWith("/"))
    throw new Error("Knowledge node에 절대 경로를 노출할 수 없습니다");
  return {
    nodeId,
    kind,
    label: knowledgeString(row.label, "Knowledge node label"),
    ...(detail === undefined ? {} : { detail }),
    ...(row.group === undefined ? {} : { group: knowledgeString(row.group, "Knowledge node group", 1_024) }),
  };
}

function projectKnowledgeIndex(value: unknown, workspaceId: string): KnowledgeIndexView {
  const row = knowledgeRecord(
    value,
    ["workspaceId", "status", "indexVersionId", "fileCount", "symbolCount", "relationCount", "indexedAt", "excluded"],
    "Knowledge index",
  );
  if (row.workspaceId !== workspaceId) throw new Error("Knowledge index Workspace 계보가 일치하지 않습니다");
  if (row.status !== "ready" && row.status !== "indexing" && row.status !== "stale" && row.status !== "none")
    throw new Error("Knowledge index 상태가 유효하지 않습니다");
  if (!Array.isArray(row.excluded) || row.excluded.length > 100)
    throw new Error("Knowledge index 제외 목록이 유효하지 않습니다");
  const excluded = row.excluded.map((item) => knowledgeString(item, "Knowledge index 제외 규칙"));
  const sortedExcluded = [...excluded].sort((left, right) => left.localeCompare(right));
  if (new Set(excluded).size !== excluded.length || excluded.some((item, index) => item !== sortedExcluded[index]))
    throw new Error("Knowledge index 제외 목록 순서가 유효하지 않습니다");
  const fileCount = knowledgeCount(row.fileCount, "Knowledge file count");
  const symbolCount = knowledgeCount(row.symbolCount, "Knowledge symbol count");
  const relationCount = knowledgeCount(row.relationCount, "Knowledge relation count");
  if (
    (row.status === "ready" && row.indexVersionId === undefined) ||
    (row.status === "none" &&
      (row.indexVersionId !== undefined ||
        row.indexedAt !== undefined ||
        fileCount !== 0 ||
        symbolCount !== 0 ||
        relationCount !== 0))
  )
    throw new Error("Knowledge index 상태 계보가 일치하지 않습니다");
  return {
    workspaceId,
    status: row.status,
    ...(row.indexVersionId === undefined
      ? {}
      : { indexVersionId: knowledgeString(row.indexVersionId, "Knowledge index version ID", 128) }),
    fileCount,
    symbolCount,
    relationCount,
    ...(row.indexedAt === undefined ? {} : { indexedAt: knowledgeInstant(row.indexedAt) }),
    excluded,
  };
}

function projectKnowledgeGraph(value: unknown, expectedLens: KnowledgeGraphLensV1): KnowledgeGraphView {
  const row = knowledgeRecord(value, ["lens", "nodes", "edges"], "Knowledge graph");
  if (row.lens !== expectedLens || !Array.isArray(row.nodes) || !Array.isArray(row.edges))
    throw new Error("Knowledge graph 렌즈 계보가 일치하지 않습니다");
  const nodes = row.nodes.map(projectKnowledgeNode);
  if (nodes.some((node) => node.kind !== expectedLens)) throw new Error("Knowledge graph에 렌즈 밖 node가 있습니다");
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const sortedNodes = [...nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (nodeIds.size !== nodes.length || nodes.some((node, index) => node.nodeId !== sortedNodes[index]?.nodeId))
    throw new Error("Knowledge graph node 순서가 유효하지 않습니다");
  const edges = row.edges.map((value): KnowledgeGraphEdgeView => {
    const edge = knowledgeRecord(
      value,
      ["kind", "sourceId", "targetId", "unresolved", "derivedVia", ...KNOWLEDGE_RELATION_METADATA_FIELDS],
      "Knowledge edge",
    );
    if (!KNOWLEDGE_RELATION_KINDS.has(edge.kind as KnowledgeRelationKind))
      throw new Error("Knowledge edge 종류가 유효하지 않습니다");
    const sourceId = knowledgeId(edge.sourceId, "Knowledge edge source ID");
    const targetId = knowledgeId(edge.targetId, "Knowledge edge target ID");
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId) || sourceId === targetId)
      throw new Error("Knowledge edge endpoint 계보가 끊겼습니다");
    if (edge.unresolved !== undefined && typeof edge.unresolved !== "boolean")
      throw new Error("Knowledge edge unresolved 상태가 유효하지 않습니다");
    return {
      kind: edge.kind as KnowledgeRelationKind,
      sourceId,
      targetId,
      ...(edge.unresolved === undefined ? {} : { unresolved: edge.unresolved }),
      ...(edge.derivedVia === undefined
        ? {}
        : { derivedVia: knowledgeString(edge.derivedVia, "Knowledge edge 공유 근거", 1_024) }),
      ...projectKnowledgeRelationMetadata(edge),
    };
  });
  const sortedEdges = [...edges].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.targetId.localeCompare(right.targetId) ||
      left.kind.localeCompare(right.kind) ||
      (left.relationId ?? "").localeCompare(right.relationId ?? "") ||
      (left.derivedVia ?? "").localeCompare(right.derivedVia ?? ""),
  );
  const edgeKeys = edges.map((edge) =>
    [
      edge.sourceId,
      edge.targetId,
      edge.kind,
      edge.relationId ?? "",
      edge.unresolved ? "1" : "0",
      edge.derivedVia ?? "",
    ].join("\0"),
  );
  if (new Set(edgeKeys).size !== edgeKeys.length || edges.some((edge, index) => edge !== sortedEdges[index]))
    throw new Error("Knowledge graph edge 순서가 유효하지 않습니다");
  return { lens: expectedLens, nodes, edges };
}

function projectKnowledgeLinks(value: unknown): readonly KnowledgeLinkView[] {
  if (!Array.isArray(value)) throw new Error("Knowledge links가 유효하지 않습니다");
  const links = value.map((item): KnowledgeLinkView => {
    const row = knowledgeRecord(
      item,
      ["node", "kind", "direction", "unresolved", ...KNOWLEDGE_RELATION_METADATA_FIELDS],
      "Knowledge link",
    );
    if (!KNOWLEDGE_RELATION_KINDS.has(row.kind as KnowledgeRelationKind))
      throw new Error("Knowledge link 종류가 유효하지 않습니다");
    if (row.direction !== "outgoing" && row.direction !== "incoming")
      throw new Error("Knowledge link 방향이 유효하지 않습니다");
    if (row.unresolved !== undefined && typeof row.unresolved !== "boolean")
      throw new Error("Knowledge link unresolved 상태가 유효하지 않습니다");
    return {
      node: projectKnowledgeNode(row.node),
      kind: row.kind as KnowledgeRelationKind,
      direction: row.direction,
      ...(row.unresolved === undefined ? {} : { unresolved: row.unresolved }),
      ...projectKnowledgeRelationMetadata(row),
    };
  });
  const keys = links.map((link) =>
    [link.node.nodeId, link.kind, link.direction, link.relationId ?? "", link.unresolved ? "1" : "0"].join("\0"),
  );
  const sortedLinks = [...links].sort(
    (left, right) =>
      left.node.nodeId.localeCompare(right.node.nodeId) ||
      left.kind.localeCompare(right.kind) ||
      left.direction.localeCompare(right.direction) ||
      (left.relationId ?? "").localeCompare(right.relationId ?? ""),
  );
  if (new Set(keys).size !== keys.length || links.some((link, index) => link !== sortedLinks[index]))
    throw new Error("Knowledge links 순서가 유효하지 않습니다");
  return links;
}

/** `router.catalog.providers` + `.endpoints`. */
/**
 * `router_circuit.state`(packages/router/src/schema.ts). 이 Provider가 «지금 성한지»입니다.
 * 설정이 구성만 보이고 상태를 안 보이면 사용자는 안 될 때 왜 안 되는지 알 수 없습니다.
 */
export type ProviderCircuitState = "closed" | "half-open" | "open";

/** `router_circuit` 투영. 켜짐/꺼짐과 다른 축입니다 — 켜져 있는데 죽어 있을 수 있습니다. */
export interface ProviderHealthView {
  readonly state: ProviderCircuitState;
  /** 연속 실패 횟수. closed여도 0이 아닐 수 있습니다. */
  readonly failureCount: number;
  /** open일 때 언제 다시 시도하는지. */
  readonly openUntil?: string;
  /** `route_attempt.failure_class`. 사용자가 할 일이 종류마다 다릅니다. */
  readonly lastFailureClass?: "authentication" | "rate-limit" | "timeout" | "network" | "server" | "unknown";
  readonly lastSucceededAt?: string;
}

export interface ProviderConnectionView {
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterKind: string;
  readonly enabled: boolean;
  /** 공식 디렉터리 항목이 실제 Router endpoint까지 연결되었는지입니다. */
  readonly connected: boolean;
  /** 이 카드가 공식 구독 로그인 진입점을 제공하는지입니다. */
  readonly subscriptionConnectable: boolean;
  /** 같은 공식 ID가 호환되지 않는 Router adapter로 등록된 업그레이드 충돌입니다. */
  readonly connectionConflict: boolean;
  /** manifest가 선언한 키 종류입니다. 없으면 구독 키로 연결하는 Provider가 아닙니다. */
  readonly keyAuthKind?: "api-key" | "subscription-key";
  readonly endpoints: readonly {
    readonly endpointId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly local: boolean;
    readonly enabled: boolean;
    /** 모델 카탈로그 동기화 상태는 Provider 전체가 아니라 이 Endpoint에 속합니다. */
    readonly catalogStatus?: ProviderCatalogStatusView;
  }[];
  /** 없으면 «아직 한 번도 부르지 않았다»입니다. 성하다고 단정하지 않습니다. */
  readonly health?: ProviderHealthView;
  /**
   * `model_verification_evidence`(immutable). 이 Provider의 모델이 실재한다는 증거입니다.
   * 카탈로그에 이름이 있는 것과 실제로 응답하는 것은 다른 사실입니다.
   */
  readonly verifiedModelCount?: number;
  readonly verifiedAt?: string;
  /**
   * 한 Provider는 키를 여러 개 가질 수 있습니다(Z.AI는 실제로 둘). 하나만 들고 있으면
   * 화면이 «추가»와 «교체»를 구분하지 못하고 나머지 키는 존재하지 않는 것이 됩니다.
   */
  readonly credentials: readonly {
    readonly credentialId: string;
    readonly endpointId: string;
    readonly label: string;
    readonly status: string;
    readonly secretVersion?: number;
    readonly revision?: number;
  }[];
  /** 이 Provider가 제공하는 모델 프로필입니다. */
  readonly models: readonly ProviderModelView[];
}

export interface ProviderModelView {
  readonly endpointId: string;
  readonly modelProfileId?: string;
  readonly catalogEntryId?: string;
  readonly modelId: string;
  /** 이 모델이 어느 종류의 요청에 배치되는지. */
  readonly routeKind: string;
  readonly enabled: boolean;
  /** `model_verification_evidence`가 있는지. 카탈로그에 이름이 있는 것과 응답하는 것은 다릅니다. */
  readonly verified: boolean;
  /** API snapshot에는 있으나 아직 검증 전인 모델을 포함합니다. */
  readonly discovered: boolean;
  readonly catalogState?: "active" | "stale";
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
  readonly supportsStructuredOutput?: boolean;
  readonly supportsVision?: boolean;
  readonly inputCostMicrosPerMillion?: number;
  readonly outputCostMicrosPerMillion?: number;
  readonly local: boolean;
}

export interface ProviderCatalogStatusView {
  readonly status: "syncing" | "available" | "empty" | "partial" | "degraded";
  readonly activeCount: number;
  readonly invalidCount: number;
  readonly duplicateCount: number;
  readonly diagnosticReason?: string;
  readonly retryAt?: string;
  readonly lastAttemptedAt: string;
  readonly lastSuccessfulAt?: string;
}

export interface ProviderModelSyncResult {
  readonly status: "available" | "empty" | "partial" | "degraded" | "superseded";
  readonly activeCount: number;
  readonly invalidCount: number;
  readonly duplicateCount: number;
  readonly diagnosticReason?: string;
  readonly retryAt?: string;
}

/** `subscription.accounts`. quota가 계정 행에 함께 실려 옵니다. */
export interface SubscriptionAccountView {
  readonly accountId: string;
  readonly providerId: string;
  readonly alias: string;
  readonly status: string;
  readonly billingKind: string;
  /** 해제는 낙관적 동시성을 쓰므로 현재 version이 필요합니다. */
  readonly accountVersion?: number;
  readonly quotaExhausted?: boolean;
  /** 0~1. 여러 창(window) 중 가장 적게 남은 비율입니다. */
  readonly minimumRemainingRatio?: number;
  readonly earliestResetAt?: string;
  readonly cooldownUntil?: string;
}

export interface ZaiCodingPlanConnectionInput {
  readonly alias: string;
  readonly secret: string;
}

export interface SubscriptionLoginInput {
  readonly providerId: "openai-codex";
  readonly alias: string;
  readonly newAccount: boolean;
}

export interface CapabilitiesView {
  readonly extensions: readonly ExtensionView[];
  readonly inventory: unknown;
}

/**
 * 아래 세 타입은 도메인(`packages/growth`)에는 있고 Application 계약에는 아직 없습니다.
 * 완성본 기준으로 화면을 먼저 고정하기 위한 뷰이며, 계약이 넓어지면 그대로 채워집니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/growth-adoption-handoff.md
 */
export interface GrowthSignalView {
  readonly signalId: string;
  /** required는 통과 필수, conflict는 반대 근거입니다. */
  readonly group: "required" | "supporting" | "conflict";
  /** model-self는 모델의 자기평가입니다. 독립 신호와 같은 무게로 그리면 안 됩니다. */
  readonly origin: "deterministic" | "independent" | "model-self";
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly score: number;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly note: string;
  readonly sourceId?: string;
  readonly sourceChecksum?: string;
  readonly fresh?: boolean;
}

export interface GrowthEvaluationView {
  readonly evaluationRunId: string;
  readonly outcome: "eligible" | "ineligible" | "blocked";
  readonly strategyVersionId: string;
  readonly inputHash?: string;
  readonly signals: readonly GrowthSignalView[];
}

export interface GrowthAdoptionView {
  readonly adoptionId: string;
  /** 도메인 `growth_adoption_run.status`. awaiting-review·observing·retained·rejected·reverted. */
  readonly status: string;
  readonly commandId: string;
  /** 있으면 사람이 승인한 것, 없으면 auto mode가 적용한 것입니다. */
  readonly approvalId?: string;
  readonly evaluationRunId: string;
  readonly evaluationInputHash: string;
  readonly beforeVersionId: string;
  readonly beforeChecksum: string;
  readonly afterVersionId?: string;
  readonly afterChecksum?: string;
  /** 도메인 `growth_adoption_run.created_at`. */
  readonly adoptedAt?: string;
  /** 도메인 `growth_revert_operation.updated_at`. */
  readonly revertedAt?: string;
}

export interface GrowthPatchLineView {
  /** 조직 노드 handle. 있으면 화면이 에이전트 이름으로 풉니다. */
  readonly targetHandle?: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface GrowthEffectMeasureView {
  readonly score: number;
  readonly observationCount: number;
  readonly minimumObservations: number;
  readonly unit: string;
  readonly direction: "higher" | "lower";
  readonly baseline: number;
}

export interface GrowthView {
  readonly configuration?: {
    readonly reflectionEnabled: boolean;
    readonly adoptionMode: "review" | "auto";
    readonly version?: number;
    readonly checksum?: string;
    readonly governanceDecisionId: string;
    readonly activatedAt: string;
  };
  readonly memories: readonly ExplicitMemoryViewV1[];
  readonly suggestions: readonly {
    readonly suggestionId: string;
    readonly workId: string;
    readonly targetKind: string;
    readonly operation: string;
    readonly summary: string;
    readonly rationale: string;
    readonly expectedEffect: string;
    readonly riskSummary: string;
    readonly status: string;
    readonly revision?: number;
    readonly createdAt?: string;
    /** 원인 Event·Evidence. 도메인 `source_reference_ids`. */
    readonly sourceReferenceIds?: readonly string[];
    readonly reflectionRunId?: string;
    /** 도메인 `patch_json`을 줄 단위로 푼 것. */
    readonly patch?: readonly GrowthPatchLineView[];
    readonly evaluation?: GrowthEvaluationView;
    readonly adoption?: GrowthAdoptionView;
    /** 거절 결정 계보. 도메인 `decision_reason`·`decided_at`이며 거절에는 필수입니다. */
    readonly decisionReason?: string;
    readonly decidedAt?: string;
    /** 제안 당시 대상 checksum과 현재가 어긋나면 채택할 수 없습니다. */
    readonly targetDrifted?: boolean;
    readonly beforeVersionId?: string;
    readonly afterVersionId?: string;
  }[];
  readonly effects: readonly {
    readonly effectEvaluationId: string;
    readonly adoptionId: string;
    readonly result: "improved" | "stable" | "degraded" | "inconclusive";
    readonly suggestionId?: string;
    readonly measure?: GrowthEffectMeasureView;
  }[];
}

export type GrowthSuggestionView = GrowthView["suggestions"][number];

export interface RegistryInstallView {
  readonly outcome: string;
  readonly installationId?: string;
  readonly approvalId?: string;
}

// 승인 대기 command는 payload 일부가 바뀌어도 같은 실행 계보를 이어야 합니다.
export interface CommandIdentity {
  readonly commandId: string;
  readonly correlationId: string;
}

export interface ApprovalDecisionResult {
  readonly approvalId: string;
  readonly status: string;
  readonly revision: number;
}

export interface DesktopService {
  readonly initialSnapshot?: DesktopSnapshot;
  bootstrap(): Promise<DesktopBootstrapState>;
  loadIndex(input: WorkIndexInput): Promise<WorkView[]>;
  loadWork(workId: string): Promise<WorkView>;
  loadWorkKnowledge(workId: string): Promise<WorkKnowledgeView>;
  /** 워크스페이스의 현재 불변 색인 상태. */
  loadKnowledgeIndex(workspaceId: string): Promise<KnowledgeIndexView>;
  /** 렌즈 종류의 노드만 담은 결정적 지식 지도. */
  loadKnowledgeGraph(workspaceId: string, lens: KnowledgeNodeKind): Promise<KnowledgeGraphView>;
  /**
   * 노드 하나가 무엇과 이어져 있나. **렌즈와 무관하게 전부** 돌려줍니다.
   * 지도는 렌즈로 좁혀 보지만, 고른 것의 연결까지 좁히면 "여러 업무·여러 문서에 걸려 있다"를
   * 볼 수 없게 됩니다.
   */
  loadKnowledgeLinks(workspaceId: string, nodeId: string): Promise<readonly KnowledgeLinkView[]>;
  /** 테넌트 전체에서 지금 사람의 판단이나 조치가 필요한 정본 목록입니다. */
  loadInbox(): Promise<InboxItem[]>;
  loadPendingApprovals(): Promise<ApprovalView[]>;
  loadWorkspaces(): Promise<readonly DesktopWorkspaceView[]>;
  registerWorkspace(path: string): Promise<DesktopWorkspaceView>;
  decideWorkspaceTrust(workspace: DesktopWorkspaceView, decision: "trusted" | "blocked"): Promise<DesktopWorkspaceView>;
  loadOrganization(): Promise<OrganizationView>;
  /**
   * 조직 편성. 헌법 §9.1이 조직 화면을 「읽기 전용」이라 적은 이유가 이 명령이 계약에 없어서였고,
   * 그 사이 유일한 실사용 경로는 CLI였습니다. `expectedVersion`은 스냅샷에서 읽은 Organization
   * Version이며 낙관적 잠금이라 어긋나면 도메인이 거부합니다.
   */
  applyOrganizationChange(input: {
    readonly expectedVersion: number;
    readonly change: ApplicationCommandMapV1["organization.command"]["payload"];
  }): Promise<void>;
  /**
   * 이 Work의 모든 협업방과 각 방의 메시지.
   * 한 Work에 방이 여럿일 수 있습니다. 에이전트끼리 직접 붙는 2인 방도 같은 방입니다.
   */
  loadRooms(workId: string): Promise<RoomView[]>;
  loadAutonomy(): Promise<AutonomyView>;
  setAutonomy(mode: AutonomyView["mode"], expectedRevision: number): Promise<AutonomyView>;
  loadEmergency(): Promise<EmergencyView>;
  /** 모델 호출 기록. 최근 것이 먼저 옵니다. */
  loadRouteAttempts(): Promise<readonly RouteAttemptView[]>;
  activateEmergency(reason: string): Promise<EmergencyView>;
  releaseEmergency(approvalId: string | undefined, reason: string): Promise<EmergencyView>;
  loadSettings(): Promise<SettingsView>;
  loginSubscription(input: SubscriptionLoginInput): Promise<void>;
  connectZaiCodingPlan(input: ZaiCodingPlanConnectionInput): Promise<void>;
  disconnectAccount(accountId: string, expectedVersion: number): Promise<void>;
  connectSubscriptionKey(input: {
    readonly providerId: string;
    readonly alias: string;
    readonly authKind: "api-key" | "subscription-key";
    readonly secret: string;
  }): Promise<void>;
  registerProvider(input: Record<string, unknown>): Promise<void>;
  removeProvider(providerId: string): Promise<{ readonly removed: boolean }>;
  registerEndpoint(input: Record<string, unknown>): Promise<{ readonly endpointId: string }>;
  addCredential(input: Record<string, unknown>): Promise<void>;
  syncProviderModels(endpointId: string): Promise<ProviderModelSyncResult>;
  disableCredential(credentialId: string, expectedVersion: number): Promise<void>;
  registerModel(input: Record<string, unknown>): Promise<void>;
  configureRoute(input: Record<string, unknown>): Promise<void>;
  /**
   * 이미 있는 경로의 예산 한도. 지출과 후보는 그대로 두고 한도만 바꿉니다.
   * `configureRoute`는 새 경로를 만들고 지출을 0으로 리셋하므로 한도 변경에 쓰면 안 됩니다.
   */
  setRouteBudget(input: {
    readonly routeId: string;
    readonly requestBudgetMicros: number;
    readonly totalBudgetMicros: number;
  }): Promise<void>;
  addRouteCandidate(input: Record<string, unknown>): Promise<void>;
  configureSubscriptionPolicy(input: Record<string, unknown>): Promise<void>;
  searchRegistry(query: string, limit?: number): Promise<unknown>;
  loadRegistryInfo(versionId: string): Promise<unknown>;
  loadCapabilities(): Promise<CapabilitiesView>;
  /** 설치된 확장과 마켓플레이스 항목을 하나의 목록으로 줍니다. Capability가 먼저입니다. */
  loadExtensions(): Promise<readonly ExtensionEntryView[]>;
  loadGrowth(): Promise<GrowthView>;
  loadGrowthSuggestion(suggestionId: string): Promise<GrowthSuggestionView>;
  configureGrowth(input: {
    readonly reflectionEnabled: boolean;
    readonly adoptionMode: "review" | "auto";
    readonly expectedVersion?: number;
  }): Promise<void>;
  approveGrowthSuggestion(input: {
    readonly suggestionId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  rejectGrowthSuggestion(input: {
    readonly suggestionId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  /**
   * 채택을 되돌립니다. 4.8이 요구하는 루프의 마지막 걸음이고, 그동안 CLI에만 있었습니다 —
   * 채택은 화면에서 하고 취소는 터미널에서 하는 상태였습니다.
   */
  revertGrowthAdoption(input: {
    readonly adoptionId: string;
    readonly suggestionRevision: number;
    readonly reason: string;
  }): Promise<void>;
  putExplicitMemory(input: {
    readonly key: string;
    readonly kind: ExplicitMemoryViewV1["entries"][number]["kind"];
    readonly value: string;
    readonly revision: number;
  }): Promise<void>;
  forgetExplicitMemory(input: { readonly key: string; readonly revision: number }): Promise<void>;
  installRegistry(input: Record<string, unknown>, identity?: CommandIdentity): Promise<RegistryInstallView>;
  submitDirective(work: WorkView, content: string, mode: DirectiveMode): Promise<void>;
  updateDirective(
    work: WorkView,
    directive: NonNullable<WorkView["queuedDirectives"]>[number],
    content: string,
    mode: DirectiveMode,
  ): Promise<void>;
  cancelDirective(work: WorkView, directive: NonNullable<WorkView["queuedDirectives"]>[number]): Promise<void>;
  decideApproval(approval: ApprovalView, vote: ApprovalVote, reason: string): Promise<ApprovalDecisionResult>;
  cancelRun(work: WorkView): Promise<void>;
  resumeRun(work: WorkView): Promise<void>;
  startWork(input: StartWorkInput): Promise<StartedWork>;
  subscribeDurable(handler: DesktopStreamHandler, after?: number): Promise<DesktopStreamStop>;
  subscribeExecution(executionId: string, handler: DesktopStreamHandler): Promise<DesktopStreamStop>;
}

export interface ApplicationDesktopServiceOptions {
  readonly createId?: () => string;
}

const ACTIVE_RUN_STATUSES = new Set(["ready", "running", "awaiting-approval", "blocked"]);

const ACTIVE_EXECUTION_STATUSES = new Set(["active", "running"]);
const ACTIVE_AGENT_STATUSES = new Set(["active", "assigned", "running"]);

export function createApplicationDesktopService(
  native: NativeTransport,
  options: ApplicationDesktopServiceOptions = {},
): DesktopService {
  const client =
    options.createId === undefined ? new ApplicationClient(native) : new ApplicationClient(native, options.createId);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const query = async (operation: string, payload: unknown): Promise<unknown> => {
    const response = object(await native.query(operation, payload));
    if (response?.operation !== operation || !("data" in response))
      throw new Error("Application query 응답이 유효하지 않습니다");
    return response.data;
  };
  const command = async (operation: string, payload: Record<string, unknown>, requestedIdentity?: CommandIdentity) => {
    const commandId = requestedIdentity?.commandId ?? createId();
    const correlationId = requestedIdentity?.correlationId ?? createId();
    const response = object(
      await native.command({ schemaVersion: "massion.application.v1", commandId, correlationId, operation, payload }),
    );
    if (
      response?.operation !== operation ||
      response.commandId !== commandId ||
      response.correlationId !== correlationId
    )
      throw new Error("Application command 응답 계보가 일치하지 않습니다");
    return response;
  };
  const bootstrap = async (): Promise<DesktopBootstrapState> => {
    const response = object(await native.bootstrap());
    const status = object(response?.connection)?.status;
    if (status === "connected") return "ready";
    throw new Error("Desktop bootstrap 연결 상태가 유효하지 않습니다");
  };

  return {
    bootstrap,

    async loadIndex(input) {
      const search = normalizeSearch(input.search, input.locale ?? "en");
      const page = await client.query("work.index", {
        search,
        limit: 50,
      });
      return page.items.map(projectWorkSummary).filter((work) => workStatusFilter(work.status) === input.filter);
    },

    async loadWork(workId) {
      const [
        detail,
        runs,
        activityPage,
        tasks,
        assignments,
        executions,
        artifacts,
        verifications,
        records,
        approvals,
        directives,
        organizationSnapshot,
      ] = await Promise.all([
        client.query("work.detail", { workId }),
        client.query("run.list", { workId }),
        client.query("work.activity.list", { workId }),
        client.query("work.tasks", { workId }),
        client.query("work.assignments", { workId }),
        client.query("work.executions", { workId }),
        client.query("work.artifacts", { workId }),
        client.query("work.verifications", { workId }),
        client.query("work.records", { workId }),
        client.query("governance.approval.list", { workId }),
        client.query("work.directive.list", { workId }),
        client.query("organization.graph.snapshot", {}),
      ]);

      return projectWorkDetail({
        detail,
        runs,
        activities: activityPage.items,
        tasks,
        assignments,
        executions,
        artifacts,
        verifications,
        records,
        approvals,
        directives,
        organizationNodes: projectOrganization(organizationSnapshot).nodes,
      });
    },

    async loadWorkKnowledge(workId) {
      const [detail, knowledge] = await Promise.all([
        client.query("work.detail", { workId }),
        client.query("work.knowledge", { workId }),
      ]);
      const workspaceId = detail.workspaceId;
      if (knowledge.status !== "ready" || workspaceId === undefined) return knowledge;

      const indexVersionId = knowledgeString(knowledge.indexVersionId, "Work Knowledge index version ID", 128);
      const snapshotChecksum = knowledgeChecksum(knowledge.snapshotChecksum, "Work Knowledge snapshot checksum");
      knowledgeChecksum(knowledge.evidenceBriefChecksum, "Work Knowledge Evidence Brief checksum");
      const references = await Promise.all(
        knowledge.references.map(async (reference): Promise<KnowledgeReferenceView> => {
          const nodeId = knowledgeId(reference.nodeId, "Work Knowledge reference node ID");
          const provenance = reference.provenance;
          if (
            !provenance ||
            !["scope", "direct-search", "graph-neighbor"].includes(provenance.selection) ||
            provenance.snapshotChecksum !== snapshotChecksum ||
            !Array.isArray(provenance.paths)
          )
            throw new Error("Work Knowledge reference provenance가 유효하지 않습니다");

          const frozenRelations = projectFrozenKnowledgeRelations(
            provenance.paths,
            provenance.selection,
            reference.referenceId,
          );
          if (frozenRelations.size === 0) return { ...reference, relations: [] };

          const links = projectKnowledgeLinks(
            await client.query("knowledge.links", {
              workspaceId,
              nodeId,
              indexVersionId,
              snapshotChecksum,
              relationIds: [...frozenRelations.keys()],
            }),
          );
          const relations = [...frozenRelations.values()].map((frozen): KnowledgeRelationView => {
            const matches = links.filter((link) => link.relationId === frozen.relationId);
            if (matches.length !== 1)
              throw new Error("Work Knowledge 고정 관계를 현재 색인에서 유일하게 확인하지 못했습니다");
            const link = matches[0];
            if (
              !link ||
              link.relationId !== frozen.relationId ||
              link.relationKey !== frozen.relationKey ||
              link.kind !== frozen.kind ||
              link.sourceSymbolKey !== frozen.sourceSymbolKey ||
              link.targetSymbolKey !== frozen.targetSymbolKey ||
              link.snapshotChecksum !== snapshotChecksum ||
              link.sourcePath !== frozen.relativePath ||
              link.sourceLine !== frozen.startLine ||
              Boolean(link.unresolved) === frozen.resolved
            )
              throw new Error("Work Knowledge 고정 관계가 Evidence Brief provenance와 일치하지 않습니다");
            return {
              node: link.node,
              kind: link.kind,
              direction: link.direction,
              qualifiedName: link.node.label,
              relativePath: link.node.detail ?? "",
              ...(link.unresolved === undefined ? {} : { unresolved: link.unresolved }),
              relationId: link.relationId,
              relationKey: link.relationKey,
              ...(link.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: link.sourceSymbolKey }),
              ...(link.targetSymbolKey === undefined ? {} : { targetSymbolKey: link.targetSymbolKey }),
              ...(link.targetText === undefined ? {} : { targetText: link.targetText }),
              snapshotChecksum: link.snapshotChecksum,
              sourcePath: link.sourcePath,
              sourceLine: link.sourceLine,
            };
          });
          return { ...reference, relations };
        }),
      );
      return { ...knowledge, workspaceId, references };
    },

    async loadKnowledgeIndex(workspaceId) {
      return projectKnowledgeIndex(await client.query("knowledge.index", { workspaceId }), workspaceId);
    },

    async loadKnowledgeGraph(workspaceId, lens) {
      if (!KNOWLEDGE_GRAPH_LENSES.has(lens)) throw new Error("Knowledge graph lens가 유효하지 않습니다");
      return projectKnowledgeGraph(await client.query("knowledge.graph", { workspaceId, lens }), lens);
    },

    async loadKnowledgeLinks(workspaceId, nodeId) {
      knowledgeId(nodeId, "Knowledge node ID");
      return projectKnowledgeLinks(await client.query("knowledge.links", { workspaceId, nodeId }));
    },

    async loadInbox() {
      return projectInbox(await client.query("inbox.list", {}));
    },

    async loadPendingApprovals() {
      return (await client.query("governance.approval.list", { status: "pending" })).map(projectApproval);
    },

    async loadWorkspaces() {
      return (await client.query("workspace.list", {})).map(workspaceView);
    },

    async registerWorkspace(path) {
      const result = await client.command("workspace.register", { path });
      return workspaceView(result.data);
    },

    async decideWorkspaceTrust(workspace, decision) {
      const result = await client.command(
        "workspace.trust",
        { workspaceId: workspace.workspaceId, decision },
        { expectedRevision: workspace.revision },
      );
      return workspaceView(result.data);
    },

    async loadOrganization() {
      return projectOrganization(await client.query("organization.graph.snapshot", {}));
    },
    async applyOrganizationChange(input) {
      await client.command("organization.command", input.change, { expectedRevision: input.expectedVersion });
    },

    async loadRooms(workId) {
      const [rooms, snapshot, sharedContexts, work] = await Promise.all([
        client.query("work.rooms", { workId }),
        client.query("organization.graph.snapshot", {}),
        client.query("work.shared-contexts", { workId }),
        client.query("work.detail", { workId }),
      ]);
      if (rooms.length === 0) return [];
      const nodes = projectOrganization(snapshot).nodes;
      const messageSets = await Promise.all(
        rooms.map(async (room) => client.query("work.messages", { workId, roomId: room.roomId })),
      );
      return withRoomReferences(
        rooms.map((room, index) => projectRoom(room, messageSets[index] ?? [], nodes, sharedContexts, work.status)),
      );
    },

    async loadAutonomy() {
      const [autonomy, growthConfiguration] = await Promise.all([
        client.query("governance.autonomy", {}),
        query("growth.configuration.get", {}),
      ]);
      return projectAutonomy(autonomy, projectGrowthConfiguration(growthConfiguration));
    },

    async setAutonomy(mode, expectedRevision) {
      const result = await client.command("governance.autonomy.set", { mode }, { expectedRevision });
      return projectAutonomy(
        object(result.data),
        projectGrowthConfiguration(await query("growth.configuration.get", {})),
      );
    },

    async loadEmergency() {
      return projectEmergency(await client.query("governance.emergency", {}));
    },

    async loadRouteAttempts() {
      return projectRouteAttempts(await client.query("router.attempts", { limit: 50 }));
    },

    async activateEmergency(reason) {
      const result = await client.command("governance.emergency.activate", { reason });
      return projectEmergency(result.data);
    },

    async releaseEmergency(approvalId, reason) {
      const result = await client.command(
        "governance.emergency.release",
        approvalId === undefined ? { reason } : { approvalId, reason },
      );
      return projectEmergency(result.data);
    },

    async loadSettings() {
      const [catalog, credentials, routes, providers, accounts, quota, policy] = await Promise.all([
        client.query("router.catalog", {}),
        query("router.credentials", {}),
        query("router.routes", {}),
        query("subscription.providers", {}),
        query("subscription.accounts", {}),
        query("subscription.quota", {}),
        query("subscription.policy", {}),
      ]);
      return {
        catalog: safeView(catalog),
        credentials: safeView(credentials),
        routes: safeView(routes),
        providers: safeView(providers),
        accounts: safeView(accounts),
        quota: safeView(quota),
        policy: safeView(policy),
      };
    },

    async loginSubscription(input) {
      const result = object(await native.loginCodex({ alias: input.alias, newAccount: input.newAccount }));
      if (result?.status !== "ready") throw new Error("Codex 로그인 결과가 유효하지 않습니다");
      await bootstrap();
    },

    async connectZaiCodingPlan(input) {
      await command("subscription.server.connect-model", {
        providerId: "zai-coding-plan",
        alias: input.alias,
        authKind: "api-key",
        billingKind: "coding-plan",
        secret: input.secret,
      });
    },
    async disconnectAccount(accountId, expectedVersion) {
      await command("subscription.account.disconnect", { accountId, expectedVersion });
    },
    async connectSubscriptionKey(input) {
      await command("subscription.server.connect-model", {
        providerId: input.providerId,
        alias: input.alias,
        authKind: input.authKind,
        billingKind: "coding-plan",
        secret: input.secret,
      });
    },
    async registerProvider(input) {
      await command("router.provider.register", input);
    },
    async removeProvider(providerId) {
      const response = await command("router.provider.remove", { providerId });
      return { removed: object(response.data)?.removed !== false };
    },
    async registerEndpoint(input) {
      // 서버가 base_url을 정규화해 저장하므로 입력 원문으로 endpoint를 되찾으면 안 됩니다.
      const response = await command("router.endpoint.register", input);
      const endpointId = object(response.data)?.endpointId;
      if (typeof endpointId !== "string" || !endpointId) throw new Error("주소를 등록하지 못했습니다.");
      return { endpointId };
    },
    async addCredential(input) {
      await command("router.credential.add", input);
    },
    async syncProviderModels(endpointId) {
      const response = await client.command("router.models.sync", { endpointId });
      const data = object(response.data);
      const status = data?.status;
      if (
        !["available", "empty", "partial", "degraded", "superseded"].includes(String(status)) ||
        !Number.isSafeInteger(data?.activeCount) ||
        Number(data?.activeCount) < 0 ||
        !Number.isSafeInteger(data?.invalidCount) ||
        Number(data?.invalidCount) < 0 ||
        !Number.isSafeInteger(data?.duplicateCount) ||
        Number(data?.duplicateCount) < 0
      ) {
        throw new Error("Provider 모델 동기화 응답이 유효하지 않습니다");
      }
      return {
        status: status as ProviderModelSyncResult["status"],
        activeCount: Number(data?.activeCount),
        invalidCount: Number(data?.invalidCount),
        duplicateCount: Number(data?.duplicateCount),
        ...(typeof data?.diagnosticReason === "string" ? { diagnosticReason: data.diagnosticReason } : {}),
        ...(typeof data?.retryAt === "string" ? { retryAt: data.retryAt } : {}),
      };
    },
    async disableCredential(credentialId, expectedVersion) {
      await command("router.credential.disable", { credentialId, expectedVersion });
    },
    async registerModel(input) {
      await command("router.model.register", input);
    },
    async configureRoute(input) {
      await command("router.route.configure", input);
    },
    async setRouteBudget(input) {
      await client.command("router.route.budget.set", input);
    },
    async addRouteCandidate(input) {
      await command("router.candidate.add", input);
    },
    async configureSubscriptionPolicy(input) {
      await command("subscription.policy.configure", input);
    },

    async searchRegistry(queryText, limit = 20) {
      return safeView(await query("registry.search", { query: queryText, limit }));
    },
    async loadRegistryInfo(versionId) {
      return safeView(await query("registry.info", { versionId }));
    },
    async loadCapabilities() {
      const [extensions, inventory] = await Promise.all([
        client.query("extension.list", {}),
        query("registry.inventory", {}),
      ]);
      return { extensions: extensions.map(projectExtension), inventory: safeView(inventory) };
    },
    async loadExtensions() {
      const [extensions, inventory] = await Promise.all([
        client.query("extension.list", {}),
        query("registry.inventory", {}),
      ]);
      // 설치된 확장의 Capability는 `extension.list`가 활성 version manifest에서 실어 줍니다.
      // 마켓플레이스 항목은 여전히 `registry.info`를 눌렀을 때 채워집니다.
      return projectExtensionEntries(extensions.map(projectExtension), safeView(inventory));
    },
    async loadGrowth() {
      const [configuration, memories, suggestions, effects] = await Promise.all([
        query("growth.configuration.get", {}),
        client.query("growth.memories", {}),
        query("growth.suggestions", { limit: 50 }),
        query("growth.effects", { limit: 50 }),
      ]);
      return {
        ...(configuration === undefined
          ? {}
          : { configuration: safeView(configuration) as NonNullable<GrowthView["configuration"]> }),
        memories,
        suggestions: safeView(suggestions) as GrowthView["suggestions"],
        effects: safeView(effects) as GrowthView["effects"],
      };
    },
    async loadGrowthSuggestion(suggestionId) {
      return safeView(await query("growth.suggestion.get", { suggestionId })) as GrowthSuggestionView;
    },
    async configureGrowth(input) {
      await client.command("growth.configure", {
        subject: { type: "organization" },
        reflectionEnabled: input.reflectionEnabled,
        adoptionMode: input.adoptionMode,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    },
    async rejectGrowthSuggestion(input) {
      await client.command("growth.suggestion.reject", {
        suggestionId: input.suggestionId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
    },
    async approveGrowthSuggestion(input) {
      await client.command("growth.suggestion.approve", {
        suggestionId: input.suggestionId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
    },
    async revertGrowthAdoption(input) {
      await client.command("growth.revert", {
        adoptionId: input.adoptionId,
        suggestionRevision: input.suggestionRevision,
        reason: input.reason,
      });
    },
    async putExplicitMemory(input) {
      await client.command(
        "growth.memory.put",
        { key: input.key, kind: input.kind, value: input.value },
        { expectedRevision: input.revision },
      );
    },
    async forgetExplicitMemory(input) {
      await client.command("growth.memory.forget", { key: input.key }, { expectedRevision: input.revision });
    },
    async installRegistry(input, identity) {
      const result = await command("registry.install", input, identity);
      const data = object(result.data);
      const approvalId = typeof data?.approvalId === "string" ? data.approvalId : undefined;
      const installationId = typeof data?.installationId === "string" ? data.installationId : undefined;
      return {
        outcome: typeof result.outcome === "string" ? result.outcome : "unknown",
        ...(installationId === undefined ? {} : { installationId }),
        ...(approvalId === undefined ? {} : { approvalId }),
      };
    },

    async submitDirective(work, content, mode) {
      const run = requireRun(work);
      await client.command(
        "work.directive.submit",
        { workId: work.id, runId: run.runId, content, mode },
        { expectedRevision: work.revision },
      );
    },

    async updateDirective(work, directive, content, mode) {
      await client.command(
        "work.directive.update",
        {
          workId: work.id,
          directiveId: directive.id,
          expectedDirectiveRevision: directive.revision,
          content,
          mode,
        },
        { expectedRevision: work.revision },
      );
    },

    async cancelDirective(work, directive) {
      await client.command(
        "work.directive.cancel",
        {
          workId: work.id,
          directiveId: directive.id,
          expectedDirectiveRevision: directive.revision,
        },
        { expectedRevision: work.revision },
      );
    },

    async decideApproval(approval, vote, reason) {
      if (approval.revision === undefined) throw new Error("승인 revision이 없어 결정을 제출할 수 없습니다");
      const result = await client.command("approval.decide", {
        approvalId: approval.id,
        expectedApprovalRevision: approval.revision,
        vote,
        reason,
      });
      const data = object(result.data);
      if (
        data?.approvalId !== approval.id ||
        typeof data.status !== "string" ||
        !Number.isSafeInteger(data.revision) ||
        (data.revision as number) < 1
      )
        throw new Error("승인 결정 결과의 status·revision이 유효하지 않습니다");
      const decision = {
        approvalId: approval.id,
        status: data.status,
        revision: data.revision as number,
      };
      if (vote === "approve" && approval.action === "emergency.stop.disable" && decision.status === "approved") {
        await client.command("governance.emergency.release", {
          approvalId: approval.id,
          reason: "수신함 승인으로 긴급 정지 해제",
        });
      }
      return decision;
    },

    async cancelRun(work) {
      await client.command("run.cancel", { runId: requireRun(work).runId });
    },

    async resumeRun(work) {
      const run = requireRun(work);
      await client.command("run.resume", {
        runId: run.runId,
        retryBlocked: true,
      });
    },

    async startWork(input) {
      const result = await client.command("run.start", {
        request: {
          text: input.text,
          surface: "desktop",
          outputLocale: input.outputLocale ?? "en",
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.workspacePaths === undefined ? {} : { workspacePaths: input.workspacePaths }),
        },
      });
      const runId = object(result.data)?.runId;
      if (typeof runId !== "string" || runId.length === 0) throw new Error("run.start 응답에 runId가 없습니다");
      return { runId };
    },

    async subscribeDurable(handler, after) {
      return await native.startStream("events", after === undefined ? {} : { after }, handler);
    },

    async subscribeExecution(executionId, handler) {
      return await native.startStream("executions", { executionId }, handler);
    },
  };
}

/**
 * 완성본 기준 설정. 조회가 실제로 돌려주는 모양 그대로 두고, 투영이 화면 뷰로 옮깁니다.
 * 계약이 타입을 주지 않으므로 여기서도 형태로만 고정합니다.
 */
/* 등록을 반영하려면 사본이 필요합니다. 원본을 그대로 쓰면 모듈 상수를 변형하게 됩니다. */
const fixtureAttempts: readonly RouteAttemptView[] = [
  {
    attemptId: "a-18",
    at: "2026-07-29T10:24:11",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "running",
    effort: "high",
    inputTokens: 18400,
    outputTokens: 0,
    cacheReadTokens: 12100,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-17",
    at: "2026-07-29T10:23:52",
    routeId: "route-reasoning",
    modelProfileId: "mp-glm-5.2",
    modelId: "glm-5.2",
    providerId: "zai",
    status: "succeeded",
    statusCode: 200,
    effort: "medium",
    inputTokens: 32100,
    outputTokens: 4820,
    cacheReadTokens: 28900,
    cacheWriteTokens: 1200,
    reasoningTokens: 2140,
    costMicros: 96400,
    durationMs: 8363,
    fallbackFrom: "a-16",
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-16",
    at: "2026-07-29T10:23:40",
    routeId: "route-reasoning",
    modelProfileId: "mp-gpt-5.6-luna",
    modelId: "gpt-5.6-luna",
    providerId: "openai-codex",
    status: "failed",
    statusCode: 429,
    failureClass: "quota_exhausted",
    effort: "xhigh",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 11920,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-15",
    at: "2026-07-29T10:23:04",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "high",
    inputTokens: 21700,
    outputTokens: 3140,
    cacheReadTokens: 19800,
    cacheWriteTokens: 880,
    reasoningTokens: 1410,
    costMicros: 214000,
    durationMs: 6204,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-14",
    at: "2026-07-29T10:22:31",
    routeId: "route-utility",
    modelProfileId: "mp-claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 6400,
    outputTokens: 910,
    cacheReadTokens: 5100,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 8200,
    durationMs: 1180,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-13",
    at: "2026-07-29T10:21:58",
    routeId: "route-embedding",
    modelProfileId: "mp-nomic-embed-text",
    modelId: "nomic-embed-text",
    providerId: "ollama",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 42800,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 2340,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-12",
    at: "2026-07-29T10:20:12",
    routeId: "route-utility",
    modelProfileId: "mp-qwen3:8b",
    modelId: "qwen3:8b",
    providerId: "ollama",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 9200,
    outputTokens: 1640,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 4910,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
  {
    attemptId: "a-11",
    at: "2026-07-28T17:02:44",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "high",
    inputTokens: 12050,
    outputTokens: 2610,
    cacheReadTokens: 9800,
    cacheWriteTokens: 640,
    reasoningTokens: 1020,
    costMicros: 172000,
    durationMs: 5402,
    workId: "partner-contract",
    workTitle: "파트너 계약서 검토",
  },
  {
    attemptId: "a-10",
    at: "2026-07-28T16:48:19",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "failed",
    statusCode: 502,
    failureClass: "upstream_error",
    effort: "high",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 9870,
    workId: "partner-contract",
    workTitle: "파트너 계약서 검토",
  },
  {
    attemptId: "a-09",
    at: "2026-07-28T16:31:05",
    routeId: "route-utility",
    modelProfileId: "mp-claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 4180,
    outputTokens: 520,
    cacheReadTokens: 3200,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 5100,
    durationMs: 940,
    workId: "partner-contract",
    workTitle: "파트너 계약서 검토",
  },
  {
    attemptId: "a-08",
    at: "2026-07-28T11:12:37",
    routeId: "route-reasoning",
    modelProfileId: "mp-glm-5.2",
    modelId: "glm-5.2",
    providerId: "zai",
    status: "succeeded",
    statusCode: 200,
    effort: "medium",
    inputTokens: 28400,
    outputTokens: 3980,
    cacheReadTokens: 24100,
    cacheWriteTokens: 1050,
    reasoningTokens: 1870,
    costMicros: 84200,
    durationMs: 7610,
    workId: "partner-contract",
    workTitle: "파트너 계약서 검토",
  },
  {
    attemptId: "a-07",
    at: "2026-07-27T14:55:20",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "high",
    inputTokens: 16900,
    outputTokens: 2240,
    cacheReadTokens: 14200,
    cacheWriteTokens: 720,
    reasoningTokens: 980,
    costMicros: 141000,
    durationMs: 4880,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-06",
    at: "2026-07-27T14:41:03",
    routeId: "route-utility",
    modelProfileId: "mp-qwen3:8b",
    modelId: "qwen3:8b",
    providerId: "ollama",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 7300,
    outputTokens: 1120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 3720,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-05",
    at: "2026-07-27T14:22:58",
    routeId: "route-reasoning",
    modelProfileId: "mp-glm-5.2",
    modelId: "glm-5.2",
    providerId: "zai",
    status: "succeeded",
    statusCode: 200,
    effort: "medium",
    inputTokens: 19600,
    outputTokens: 2870,
    cacheReadTokens: 16400,
    cacheWriteTokens: 810,
    reasoningTokens: 1240,
    costMicros: 61800,
    durationMs: 6140,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-04",
    at: "2026-07-24T09:38:41",
    routeId: "route-reasoning",
    modelProfileId: "mp-claude-sonnet-5",
    modelId: "claude-sonnet-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "high",
    inputTokens: 11200,
    outputTokens: 1830,
    cacheReadTokens: 8900,
    cacheWriteTokens: 520,
    reasoningTokens: 740,
    costMicros: 118000,
    durationMs: 4210,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-03",
    at: "2026-07-24T09:20:16",
    routeId: "route-utility",
    modelProfileId: "mp-claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    providerId: "anthropic-claude-code",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 3940,
    outputTokens: 610,
    cacheReadTokens: 2800,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 4700,
    durationMs: 880,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-02",
    at: "2026-07-24T09:04:52",
    routeId: "route-embedding",
    modelProfileId: "mp-nomic-embed-text",
    modelId: "nomic-embed-text",
    providerId: "ollama",
    status: "succeeded",
    statusCode: 200,
    effort: "low",
    inputTokens: 38100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    durationMs: 2010,
    workId: "weekly-ops",
    workTitle: "주간 운영 보고서",
  },
  {
    attemptId: "a-01",
    at: "2026-07-22T15:17:29",
    routeId: "route-reasoning",
    modelProfileId: "mp-gpt-5.6-luna",
    modelId: "gpt-5.6-luna",
    providerId: "openai-codex",
    status: "succeeded",
    statusCode: 200,
    effort: "xhigh",
    inputTokens: 24300,
    outputTokens: 3410,
    cacheReadTokens: 20100,
    cacheWriteTokens: 1400,
    reasoningTokens: 2980,
    costMicros: 196000,
    durationMs: 10240,
    workId: "churn-q3",
    workTitle: "3분기 고객 이탈 원인 분석",
  },
];

/** 경로가 쓴 돈은 호출 기록의 합입니다. 따로 적어 두면 둘이 갈라지고, 갈라지면 게이지를 못 믿습니다. */
function fixtureSpent(routeId: string): number {
  return fixtureAttempts
    .filter((attempt) => attempt.routeId === routeId)
    .reduce((total, attempt) => total + attempt.costMicros, 0);
}

/**
 * Work마다 다른 편성·한도·근거입니다. 하나를 돌려 쓰면 완료된 Work 끝에 다른 Work의
 * 오늘자 미해결 질문이 붙고, 우측 열 숫자가 Work를 옮겨도 그대로입니다.
 */
interface FixtureRoomShape {
  participants: readonly string[];
  rounds: number;
  tokens: number;
  cost: number;
  sharedContexts: { id: string; label: string; checksum: string }[];
}

const fixtureDefaultRoom: FixtureRoomShape = {
  participants: ["representative", "context-strategy", "delivery-coordination"],
  rounds: 2,
  tokens: 11_400,
  cost: 42_000,
  sharedContexts: [],
};

const fixtureRoomShapes: Record<string, FixtureRoomShape> = {
  "churn-q3": {
    participants: ["representative", "context-strategy", "evidence-research", "delivery-coordination", "assurance"],
    rounds: 6,
    tokens: 48_200,
    cost: 310_000,
    sharedContexts: [
      { id: "ref-brief", label: "evidence-brief · 라벨링 기준 브리프", checksum: "a3f1c8" },
      { id: "ref-log", label: "evidence-brief · 해지 로그 90일", checksum: "7c02b1" },
    ],
  },
  "partner-contract": {
    participants: ["representative", "evidence-research", "assurance"],
    rounds: 3,
    tokens: 19_800,
    cost: 172_000,
    sharedContexts: [{ id: "ref-terms", label: "evidence-brief · 기존 계약 책임 범위", checksum: "d41e90" }],
  },
  "refund-delay": {
    participants: ["representative", "context-strategy", "evidence-research", "delivery-coordination", "assurance"],
    rounds: 9,
    tokens: 34_100,
    cost: 187_000,
    sharedContexts: [{ id: "ref-delay", label: "구간별 지연.csv", checksum: "d40f7a" }],
  },
  "weekly-ops": {
    participants: ["representative", "delivery-coordination"],
    rounds: 4,
    tokens: 27_600,
    cost: 118_000,
    sharedContexts: [{ id: "ref-ops", label: "evidence-brief · 주간 운영 지표", checksum: "b18c47" }],
  },
};

const fixtureSettings: SettingsView = {
  catalog: {
    /*
     * 구독 커넥터 6종(codex·claude·gemini·copilot·grok·antigravity)과 API 어댑터를 지원합니다.
     * 실제 지원 목록은 packages/subscriptions와 apps/connector의 provider id가 정본입니다.
     */
    providers: [
      {
        providerId: "anthropic-claude-code",
        displayName: "Claude Code",
        adapterKind: "subscription-connector",
        enabled: true,
      },
      { providerId: "openai-codex", displayName: "OpenAI Codex", adapterKind: "subscription-connector", enabled: true },
      { providerId: "zai", displayName: "Z.ai", adapterKind: "openai-compatible", enabled: true },
      {
        providerId: "google-gemini-cli-enterprise",
        displayName: "Gemini CLI",
        adapterKind: "subscription-connector",
        enabled: true,
      },
      {
        providerId: "github-copilot",
        displayName: "GitHub Copilot",
        adapterKind: "subscription-connector",
        enabled: true,
      },
      { providerId: "ollama", displayName: "Ollama", adapterKind: "ollama", enabled: true },
      { providerId: "xai-grok-build", displayName: "xAI Grok", adapterKind: "subscription-connector", enabled: false },
      {
        providerId: "google-antigravity-cli",
        displayName: "Antigravity",
        adapterKind: "subscription-connector",
        enabled: false,
      },
    ],
    /*
     * `router_circuit`. 켜짐/꺼짐과 다른 축이라 셋을 다 세워 둡니다 — 성한 것, 흔들리는 것,
     * 막힌 것. 화면이 이 셋을 구분하지 못하면 사용자는 안 될 때 원인을 못 찾습니다.
     */
    circuits: [
      {
        providerId: "anthropic-claude-code",
        state: "closed",
        failureCount: 0,
        lastSucceededAt: "2026-07-28T02:31:04.000Z",
      },
      { providerId: "openai-codex", state: "closed", failureCount: 0, lastSucceededAt: "2026-07-28T02:18:40.000Z" },
      { providerId: "zai", state: "closed", failureCount: 0, lastSucceededAt: "2026-07-28T02:24:11.000Z" },
      {
        providerId: "google-gemini-cli-enterprise",
        state: "half-open",
        failureCount: 3,
        lastFailureClass: "rate-limit",
        lastSucceededAt: "2026-07-28T01:58:02.000Z",
      },
      {
        providerId: "github-copilot",
        state: "open",
        failureCount: 5,
        openUntil: "2026-07-28T02:47:00.000Z",
        lastFailureClass: "authentication",
        lastSucceededAt: "2026-07-27T18:22:10.000Z",
      },
      {
        providerId: "ollama",
        state: "open",
        failureCount: 7,
        openUntil: "2026-07-28T02:41:00.000Z",
        lastFailureClass: "network",
        lastSucceededAt: "2026-07-27T22:03:40.000Z",
      },
    ],
    /* `model_verification_evidence`(immutable). 카탈로그에 이름이 있는 것과 응답하는 것은 다릅니다. */
    verificationEvidence: [
      { providerId: "anthropic-claude-code", modelId: "claude-sonnet-5", verifiedAt: "2026-07-28T02:31:04.000Z" },
      { providerId: "anthropic-claude-code", modelId: "claude-haiku-4-5", verifiedAt: "2026-07-28T02:31:09.000Z" },
      { providerId: "openai-codex", modelId: "gpt-5.6-luna", verifiedAt: "2026-07-28T02:18:40.000Z" },
      { providerId: "zai", modelId: "glm-5.2", verifiedAt: "2026-07-27T09:41:00.000Z" },
      { providerId: "zai", modelId: "glm-5.2-air", verifiedAt: "2026-07-27T09:41:12.000Z" },
      { providerId: "google-gemini-cli-enterprise", modelId: "gemini-3-pro", verifiedAt: "2026-07-28T01:58:02.000Z" },
    ],
    credentials: [
      { providerId: "anthropic-claude-code", secretVersion: 2 },
      { providerId: "openai-codex", secretVersion: 1 },
      { providerId: "zai", secretVersion: 3 },
      { providerId: "google-gemini-cli-enterprise", secretVersion: 1 },
      { providerId: "github-copilot", secretVersion: 1 },
    ],
    endpoints: [
      {
        endpointId: "ep-claude",
        providerId: "anthropic-claude-code",
        name: "claude-code",
        baseUrl: "cli://claude",
        local: true,
      },
      { endpointId: "ep-codex", providerId: "openai-codex", name: "codex", baseUrl: "cli://codex", local: true },
      { endpointId: "ep-zai", providerId: "zai", name: "coding-plan", baseUrl: "https://api.z.ai/v1", local: false },
      {
        endpointId: "ep-gemini",
        providerId: "google-gemini-cli-enterprise",
        name: "gemini-cli",
        baseUrl: "cli://gemini",
        local: true,
      },
      {
        endpointId: "ep-copilot",
        providerId: "github-copilot",
        name: "copilot-acp",
        baseUrl: "acp://copilot",
        local: true,
      },
      { endpointId: "ep-ollama", providerId: "ollama", name: "local", baseUrl: "http://127.0.0.1:11434", local: true },
      { endpointId: "ep-grok", providerId: "xai-grok-build", name: "grok-acp", baseUrl: "acp://grok", local: true },
      {
        endpointId: "ep-antigravity",
        providerId: "google-antigravity-cli",
        name: "antigravity",
        baseUrl: "cli://antigravity",
        local: true,
      },
    ],
    models: [
      {
        modelProfileId: "mp-sonnet",
        providerId: "anthropic-claude-code",
        endpointId: "ep-claude",
        modelId: "claude-sonnet-5",
        routeKind: "reasoning",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-haiku",
        providerId: "anthropic-claude-code",
        endpointId: "ep-claude",
        modelId: "claude-haiku-4-5",
        routeKind: "utility",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-luna",
        providerId: "openai-codex",
        endpointId: "ep-codex",
        modelId: "gpt-5.6-luna",
        routeKind: "reasoning",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-glm",
        providerId: "zai",
        endpointId: "ep-zai",
        modelId: "glm-5.2",
        routeKind: "reasoning",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-glm-air",
        providerId: "zai",
        endpointId: "ep-zai",
        modelId: "glm-5.2-air",
        routeKind: "utility",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-gemini",
        providerId: "google-gemini-cli-enterprise",
        endpointId: "ep-gemini",
        modelId: "gemini-3-pro",
        routeKind: "reasoning",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "mp-copilot",
        providerId: "github-copilot",
        endpointId: "ep-copilot",
        modelId: "gpt-5.6-copilot",
        routeKind: "utility",
        verified: false,
        enabled: true,
      },
      {
        modelProfileId: "mp-qwen",
        providerId: "ollama",
        endpointId: "ep-ollama",
        modelId: "qwen3:8b",
        routeKind: "utility",
        verified: false,
        enabled: true,
      },
      {
        modelProfileId: "mp-embed",
        providerId: "ollama",
        endpointId: "ep-ollama",
        modelId: "nomic-embed-text",
        routeKind: "embedding",
        verified: false,
        enabled: true,
      },
    ],
    discoveredModels: [
      {
        catalogEntryId: "catalog-zai-glm",
        providerId: "zai",
        endpointId: "ep-zai",
        modelId: "glm-5.2",
        state: "active",
        displayName: "GLM-5.2",
        contextWindow: 131_072,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        inputCostMicrosPerMillion: 1_000_000,
        outputCostMicrosPerMillion: 3_200_000,
        firstSeenAt: "2026-07-27T09:40:00.000Z",
        lastSeenAt: "2026-08-10T03:40:00.000Z",
      },
      {
        catalogEntryId: "catalog-zai-glm-air",
        providerId: "zai",
        endpointId: "ep-zai",
        modelId: "glm-5.2-air",
        state: "active",
        displayName: "GLM-5.2 Air",
        contextWindow: 131_072,
        supportsTools: true,
        supportsStructuredOutput: true,
        firstSeenAt: "2026-07-27T09:40:00.000Z",
        lastSeenAt: "2026-08-10T03:40:00.000Z",
      },
      {
        catalogEntryId: "catalog-zai-retired",
        providerId: "zai",
        endpointId: "ep-zai",
        modelId: "glm-4.7-flash",
        state: "stale",
        displayName: "GLM-4.7 Flash",
        firstSeenAt: "2026-07-02T09:40:00.000Z",
        lastSeenAt: "2026-07-26T18:10:00.000Z",
      },
      {
        catalogEntryId: "catalog-ollama-qwen",
        providerId: "ollama",
        endpointId: "ep-ollama",
        modelId: "qwen3:8b",
        state: "active",
        firstSeenAt: "2026-07-20T02:00:00.000Z",
        lastSeenAt: "2026-08-10T03:31:00.000Z",
      },
      {
        catalogEntryId: "catalog-ollama-embed",
        providerId: "ollama",
        endpointId: "ep-ollama",
        modelId: "nomic-embed-text",
        state: "active",
        firstSeenAt: "2026-07-20T02:00:00.000Z",
        lastSeenAt: "2026-08-10T03:31:00.000Z",
      },
    ],
    catalogStatuses: [
      {
        providerId: "zai",
        endpointId: "ep-zai",
        status: "available",
        activeCount: 2,
        invalidCount: 0,
        duplicateCount: 0,
        catalogDigest: "a".repeat(64),
        lastAttemptedAt: "2026-08-10T03:40:00.000Z",
        lastSuccessfulAt: "2026-08-10T03:40:00.000Z",
      },
      {
        providerId: "ollama",
        endpointId: "ep-ollama",
        status: "degraded",
        activeCount: 2,
        invalidCount: 0,
        duplicateCount: 0,
        diagnosticReason: "network-failed",
        retryAt: "2026-08-10T03:45:00.000Z",
        lastAttemptedAt: "2026-08-10T03:38:00.000Z",
        lastSuccessfulAt: "2026-08-10T03:31:00.000Z",
      },
      {
        providerId: "xai-grok-build",
        endpointId: "ep-grok",
        status: "degraded",
        activeCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        diagnosticReason: "network-failed",
        retryAt: "2026-08-10T03:45:00.000Z",
        lastAttemptedAt: "2026-08-10T03:38:00.000Z",
      },
    ],
    candidates: [
      { candidateId: "c-r1", routeId: "route-reasoning", modelProfileId: "mp-sonnet", priority: 0, enabled: true },
      { candidateId: "c-r2", routeId: "route-reasoning", modelProfileId: "mp-glm", priority: 1, enabled: true },
      { candidateId: "c-r3", routeId: "route-reasoning", modelProfileId: "mp-gemini", priority: 2, enabled: true },
      { candidateId: "c-u1", routeId: "route-utility", modelProfileId: "mp-haiku", priority: 0, enabled: true },
      { candidateId: "c-u2", routeId: "route-utility", modelProfileId: "mp-qwen", priority: 1, enabled: true },
      { candidateId: "c-e1", routeId: "route-embedding", modelProfileId: "mp-embed", priority: 0, enabled: true },
    ],
  },
  credentials: [
    {
      credentialId: "credential-zai",
      providerId: "zai",
      endpointId: "ep-zai",
      label: "coding-plan",
      status: "active",
      priority: 1,
      weight: 1,
    },
  ],
  routes: [
    {
      routeId: "route-reasoning",
      name: "추론",
      routeKind: "reasoning",
      credentialPolicy: "required",
      dataPolicy: "cloud",
      equivalenceGroup: "reasoning",
      spentMicros: fixtureSpent("route-reasoning"),
      totalBudgetMicros: 2_000_000,
      requestBudgetMicros: 0,
      enabled: true,
    },
    {
      routeId: "route-utility",
      name: "보조 작업",
      routeKind: "utility",
      credentialPolicy: "optional",
      dataPolicy: "local",
      equivalenceGroup: "utility",
      spentMicros: fixtureSpent("route-utility"),
      totalBudgetMicros: 500_000,
      requestBudgetMicros: 0,
      enabled: true,
    },
    {
      routeId: "route-embedding",
      name: "임베딩",
      routeKind: "embedding",
      credentialPolicy: "optional",
      dataPolicy: "local",
      equivalenceGroup: "embedding",
      spentMicros: fixtureSpent("route-embedding"),
      totalBudgetMicros: 0,
      requestBudgetMicros: 0,
      enabled: false,
    },
  ],
  providers: [{ providerId: "zai-coding-plan", displayName: "Z.ai Coding Plan", billingKind: "coding-plan" }],
  accounts: [
    {
      accountId: "account-zai",
      providerId: "zai-coding-plan",
      alias: "Z.ai GLM-5.2",
      scope: "organization",
      status: "active",
      billingKind: "coding-plan",
      version: 3,
      minimumRemainingRatio: 0.62,
      quotaExhausted: false,
      earliestResetAt: "2026-07-24T00:00:00.000Z",
    },
  ],
  quota: [],
  policy: [],
};

/**
 * 완성본 기준 확장 목록. 설치된 것 하나가 조직에 실제로 무엇을 더했는지 보여줍니다.
 * 실 daemon 경로는 계약이 manifest를 주지 않아 contributions·permissions가 비어서 옵니다.
 */
const fixtureExtensionEntries: readonly ExtensionEntryView[] = [
  {
    id: "installation-github",
    packageName: "@massion-ext/github",
    version: "1.2.0",
    description: "GitHub Issue·Pull Request·Check를 업무와 산출물에 연결합니다.",
    provenance: "official",
    installed: true,
    state: "healthy",
    contributions: [
      { kind: "runtimeTools", items: ["github.issue.read", "github.pull-request.open", "github.check.read"] },
      { kind: "organizationTemplates", items: ["release-engineering"] },
      { kind: "skills", items: ["pull-request-review", "release-notes"] },
      { kind: "surfaceConnectors", items: ["github"] },
      { kind: "eventConsumers", items: ["github-webhook"] },
    ],
    permissions: [
      { kind: "network", items: ["api.github.com"] },
      { kind: "secrets", items: ["github-token"] },
      { kind: "events", items: ["work.completed", "artifact.published"] },
      { kind: "storage", items: [""] },
    ],
  },
];

const fixtureRegistryInventory = [
  {
    versionId: "registry-slack-1.0.0",
    packageName: "@massion-ext/slack",
    packageVersion: "1.0.0",
    description: "Slack 요청, 진행 알림, 제한된 승인과 결과 Surface",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
  {
    versionId: "registry-github-1.0.0",
    packageName: "@massion-ext/github",
    packageVersion: "1.0.0",
    description: "GitHub Issue, Pull Request, Check, Review, Records와 Release 통합",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
  {
    versionId: "registry-discord-1.0.0",
    packageName: "@massion-ext/discord",
    packageVersion: "1.0.0",
    description: "Discord 요청, 진행 알림, 제한된 승인과 결과 Surface",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
] as const;

function fixtureRegistryDetail(versionId: string): unknown {
  const item = fixtureRegistryInventory.find((candidate) => candidate.versionId === versionId);
  if (!item) return {};
  const connector = item.packageName.endsWith("github")
    ? "github"
    : item.packageName.endsWith("discord")
      ? "discord"
      : "slack";
  return {
    version: {
      packageVersion: item.packageVersion,
      visibility: item.visibility,
      ownerOrganizationId: item.ownerOrganizationId,
      assessment: { provenance: item.provenance },
      manifest: {
        name: item.packageName,
        description: item.description,
        permissions: { network: [connector], secrets: [connector] },
        contributions: {
          surfaceConnectors: [{ id: connector }],
          eventConsumers: [{ id: `${connector}-notification` }],
        },
      },
    },
  };
}

const fixturePromise = <T>(run: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(run());
  });

type FixtureGrowthConfiguration = Omit<NonNullable<GrowthView["configuration"]>, "version" | "checksum"> & {
  readonly version: number;
  readonly checksum: string;
};

const fixtureGrowthConfiguration: FixtureGrowthConfiguration = Object.freeze({
  reflectionEnabled: true,
  adoptionMode: "review" as const,
  version: 1,
  checksum: "fixture-growth-configuration-1-enabled-review",
  governanceDecisionId: "decision-growth-0007",
  activatedAt: "2026-07-21T09:12:00.000Z",
});

const fixtureGrowthSuggestionLineages: Readonly<
  Record<
    string,
    {
      readonly status: string;
      readonly revision: number;
      readonly targetDrifted: boolean;
      readonly evaluation?: Pick<GrowthEvaluationView, "evaluationRunId" | "outcome" | "inputHash">;
      readonly adoption?: GrowthAdoptionView;
    }
  >
> = Object.freeze({
  "suggestion-cohort-guard": {
    status: "awaiting-review",
    revision: 3,
    targetDrifted: false,
    evaluation: { evaluationRunId: "evaluation-0031", outcome: "eligible", inputHash: "fixture-evaluation-cohort" },
    adoption: {
      adoptionId: "adoption-fixture-cohort",
      status: "awaiting-review",
      commandId: "command-growth-fixture-cohort",
      approvalId: "approval-growth-fixture-cohort",
      evaluationRunId: "evaluation-0031",
      evaluationInputHash: "fixture-evaluation-cohort",
      beforeVersionId: "prompt-context-strategy-v1",
      beforeChecksum: "fixture-growth-before-cohort",
    },
  },
  "suggestion-quant-persist": {
    status: "evaluated",
    revision: 1,
    targetDrifted: true,
    evaluation: { evaluationRunId: "evaluation-0032", outcome: "ineligible", inputHash: "fixture-evaluation-quant" },
  },
  "suggestion-target-drift-fixture": {
    status: "awaiting-review",
    revision: 1,
    targetDrifted: true,
    evaluation: {
      evaluationRunId: "evaluation-target-drift",
      outcome: "eligible",
      inputHash: "fixture-evaluation-drift",
    },
    adoption: {
      adoptionId: "adoption-fixture-target-drift",
      status: "awaiting-review",
      commandId: "command-growth-fixture-target-drift",
      approvalId: "approval-growth-fixture-target-drift",
      evaluationRunId: "evaluation-target-drift",
      evaluationInputHash: "fixture-evaluation-drift",
      beforeVersionId: "prompt-context-strategy-v1",
      beforeChecksum: "fixture-growth-before-target-drift",
    },
  },
  "suggestion-proposed-fixture": { status: "proposed", revision: 1, targetDrifted: false },
  "suggestion-evaluated-fixture": { status: "evaluated", revision: 1, targetDrifted: false },
  "suggestion-handoff-note": { status: "adopted", revision: 2, targetDrifted: false },
  "suggestion-verify-depth": { status: "adopted", revision: 1, targetDrifted: false },
  "suggestion-tone-brief": { status: "rejected", revision: 1, targetDrifted: false },
});

const fixtureGrowthChecksum = (version: number, reflectionEnabled: boolean, adoptionMode: GrowthAdoptionMode): string =>
  `fixture-growth-configuration-${String(version)}-${reflectionEnabled ? "enabled" : "disabled"}-${adoptionMode}`;

/** `APPLICATION_RUN_STAGES`(packages/application/src/core-work-coordinator.ts)와 같은 순서입니다. */
const FIXTURE_RUN_STAGES = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"];

const fixtureTime = (): string => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
};

export function createFixtureDesktopService(): DesktopService {
  /* 픽스처가 상태를 바꾸므로 모듈 상수가 아니라 사본을 소유합니다. */
  const initialSnapshot: DesktopSnapshot = structuredClone(fixtureDataAdapter());
  const settingsState: SettingsView = structuredClone(fixtureSettings);
  let growthConfiguration = { ...fixtureGrowthConfiguration };
  const growthSuggestionLineages = structuredClone(fixtureGrowthSuggestionLineages);
  const credentialVersions = new Map<string, number>([["credential-zai", 1]]);
  let explicitMemorySequence = 4;
  let explicitMemory: ExplicitMemoryViewV1 = {
    memoryVersionId: "memory-0004",
    revision: 4,
    entries: [
      {
        key: "answer-style",
        kind: "preference",
        value: "분석 결과는 결론부터 설명한다",
        authority: "explicit",
      },
    ],
  };
  const growthSuggestionOverrides = new Map<
    string,
    Pick<GrowthView["suggestions"][number], "status" | "revision" | "adoption" | "decisionReason" | "decidedAt">
  >();
  let directiveSequence = 0;
  let runSequence = 0;
  let eventSequence = 0;
  const durableHandlers = new Set<DesktopStreamHandler>();
  const executionHandlers = new Map<string, Map<DesktopStreamHandler, number>>();
  const executionSequences = new Map<string, number>();
  const executionHistory = new Map<
    string,
    {
      readonly workId: string;
      readonly runId: string;
      readonly deltas: { readonly sequence: number }[];
      completed: boolean;
    }
  >();
  const completionPending = new Set<string>();

  const publishDurable = (
    type: string,
    resource: { readonly type: string; readonly id: string; readonly revision: number },
    payload: unknown,
  ): void => {
    const event = {
      schemaVersion: "massion.application.event.v1",
      eventId: `event-fixture-${String(++eventSequence).padStart(4, "0")}`,
      organizationId: "fixture-organization",
      sequence: eventSequence,
      type,
      author: { kind: "system" as const, id: "fixture" },
      resource,
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload,
    };
    queueMicrotask(() => {
      for (const handler of durableHandlers) {
        try {
          handler(event);
        } catch {
          // 실제 스트림처럼 한 화면의 처리 오류가 다른 구독을 끊지 않습니다.
        }
      }
    });
  };

  const publishExecution = (executionId: string, summary: string): void => {
    const sequence = (executionSequences.get(executionId) ?? 0) + 1;
    executionSequences.set(executionId, sequence);
    const delta = {
      executionId,
      agentHandle: "representative",
      sequence,
      kind: "lifecycle" as const,
      summary,
      occurredAt: "2026-07-30T00:00:00.000Z",
    };
    executionHistory.get(executionId)?.deltas.push(delta);
    queueMicrotask(() => {
      const handlers = executionHandlers.get(executionId);
      if (handlers) for (const handler of handlers.keys()) deliverExecution(handlers, handler, delta);
    });
  };

  const deliverExecution = (
    handlers: Map<DesktopStreamHandler, number>,
    handler: DesktopStreamHandler,
    delta: { readonly sequence: number },
  ): void => {
    const lastDelivered = handlers.get(handler);
    if (lastDelivered === undefined || delta.sequence <= lastDelivered) return;
    handlers.set(handler, delta.sequence);
    try {
      handler(delta);
    } catch {
      // 실제 실행 스트림처럼 구독자 오류는 실행 흐름에 전파하지 않습니다.
    }
  };

  const scheduleCompletion = (executionId: string): void => {
    const execution = executionHistory.get(executionId);
    const work = execution && initialSnapshot.works.find((candidate) => candidate.id === execution.workId);
    if (
      !execution ||
      !work ||
      execution.completed ||
      completionPending.has(executionId) ||
      work.run?.runId !== execution.runId ||
      work.run.status !== "ready"
    )
      return;
    completionPending.add(executionId);
    queueMicrotask(() => {
      if (!completionPending.delete(executionId)) return;
      const current = initialSnapshot.works.find((candidate) => candidate.id === execution.workId);
      if (!current || current.run?.runId !== execution.runId || current.run.status !== "ready") return;
      const completed = { ...current };
      delete completed.activeExecutionId;
      mutateWork(execution.workId, () => ({
        ...completed,
        status: "complete",
        revision: current.revision + 1,
        sourceStatus: "completed",
        progress: 100,
        run: { runId: execution.runId, status: "completed", stage: "terminal", leaseGeneration: 0 },
        tasks: current.tasks.map((task) => ({ ...task, state: "done" })),
        agents: current.agents.map((agent) => ({ ...agent, state: "waiting" })),
      }));
      execution.completed = true;
      publishDurable(
        "run.completed",
        { type: "ApplicationRun", id: execution.runId, revision: 0 },
        { stage: "terminal" },
      );
      publishExecution(executionId, "finish");
    });
  };

  const stop =
    (handlers: Set<DesktopStreamHandler>, handler: DesktopStreamHandler): DesktopStreamStop =>
    () => {
      handlers.delete(handler);
      return Promise.resolve();
    };

  /** 조회가 다시 읽는 자리를 바꿉니다. 화면은 loadWork로 따라옵니다. */
  const mutateWork = (workId: string, change: (current: WorkView) => WorkView): void => {
    const index = initialSnapshot.works.findIndex((candidate) => candidate.id === workId);
    const current = initialSnapshot.works[index];
    if (!current) throw new Error("Fixture Work를 찾을 수 없습니다");
    initialSnapshot.works[index] = change(current);
  };

  return {
    initialSnapshot,
    bootstrap: () => fixturePromise(() => "ready"),
    loadIndex: (input) =>
      fixturePromise(() => {
        const { filter, search } = input;
        const locale = input.locale ?? "en";
        const normalizedSearch = normalizeSearch(search, locale);
        return initialSnapshot.works.filter(
          (work) =>
            workStatusFilter(work.status) === filter &&
            (normalizedSearch.length === 0 || normalizeSearch(work.title, locale).includes(normalizedSearch)),
        );
      }),
    loadWork: (workId) =>
      fixturePromise(() => {
        const work = initialSnapshot.works.find((candidate) => candidate.id === workId);
        if (!work) throw new Error("Fixture Work를 찾을 수 없습니다");
        return work;
      }),
    loadWorkKnowledge: (workId) => fixturePromise(() => fixtureKnowledge(workId)),
    loadInbox: () =>
      fixturePromise(() => {
        const blocked: InboxItem[] = initialSnapshot.works.flatMap((work) =>
          work.run?.status === "blocked"
            ? [
                {
                  kind: "blocked" as const,
                  id: `blocked:${work.run.runId}`,
                  runId: work.run.runId,
                  workId: work.id,
                  title: work.title,
                  reason: inboxBlockedReason(work.run.blockedReason, work.run.blockedDetail),
                },
              ]
            : [],
        );
        const approvals: InboxItem[] = initialSnapshot.works.flatMap((work) =>
          work.approvals
            .filter((approval) => approval.status === "pending")
            .map((approval) => ({ kind: "approval" as const, id: approval.id, approval, workTitle: work.title })),
        );
        const growthDefinitions = [
          {
            suggestionId: "suggestion-cohort-guard",
            workId: "churn-q3",
            title: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다.",
            reason:
              "3분기 이탈 분석에서 검증이 코호트 정의 불일치를 반론으로 제기했고, 같은 원인으로 이전 두 Work에서도 재작업이 있었습니다.",
          },
          {
            suggestionId: "suggestion-target-drift-fixture",
            workId: "churn-q3",
            title: "변경된 대상의 개선 제안",
            reason: "검토 전에 대상 checksum이 달라졌습니다.",
          },
        ];
        const growth: InboxItem[] = growthDefinitions.flatMap((definition) => {
          const base = growthSuggestionLineages[definition.suggestionId];
          const current = base && { ...base, ...growthSuggestionOverrides.get(definition.suggestionId) };
          if (!current || current.status !== "awaiting-review") return [];
          const workTitle = initialSnapshot.works.find((work) => work.id === definition.workId)?.title;
          return [
            {
              kind: "growth" as const,
              id: `growth:${definition.suggestionId}`,
              suggestionId: definition.suggestionId,
              workId: definition.workId,
              ...(workTitle === undefined ? {} : { workTitle }),
              title: definition.title,
              reason: definition.reason,
            },
          ];
        });
        return [...blocked, ...approvals, ...growth];
      }),
    loadPendingApprovals: () =>
      fixturePromise(() =>
        initialSnapshot.works.flatMap((work) => work.approvals.filter((approval) => approval.status === "pending")),
      ),
    loadWorkspaces: () =>
      fixturePromise(() => [
        {
          workspaceId: "workspace-analytics",
          name: "analytics",
          path: "/Users/me/code/analytics",
          kind: "local-directory" as const,
          trust: "trusted" as const,
          status: "active" as const,
          revision: 3,
          createdAt: "2026-07-01T09:00:00.000Z",
          lastUsedAt: "2026-07-27T10:24:00.000Z",
        },
        {
          workspaceId: "workspace-ops",
          name: "ops-runbook",
          path: "/Users/me/code/ops-runbook",
          kind: "local-directory" as const,
          trust: "pending" as const,
          status: "active" as const,
          revision: 1,
          createdAt: "2026-07-20T09:00:00.000Z",
          lastUsedAt: "2026-07-20T09:00:00.000Z",
        },
      ]),
    loadKnowledgeIndex: (workspaceId) =>
      fixturePromise(() =>
        workspaceId === "workspace-analytics"
          ? {
              workspaceId,
              status: "ready" as const,
              indexVersionId: "index-2f9a10",
              fileCount: 214,
              symbolCount: 1_836,
              relationCount: 4_902,
              indexedAt: "2026-07-27T09:41:00.000Z",
              // 없는 것을 아는 것도 지식입니다. 왜 안 보이는지 여기서 답합니다.
              excluded: ["node_modules", "dist", ".git", "*.lock"],
            }
          : {
              workspaceId,
              status: "none" as const,
              fileCount: 0,
              symbolCount: 0,
              relationCount: 0,
              excluded: [],
            },
      ),
    loadKnowledgeGraph: (workspaceId, lens) =>
      fixturePromise(() =>
        workspaceId === "workspace-analytics" ? fixtureGraph(lens) : { lens, nodes: [], edges: [] },
      ),
    loadKnowledgeLinks: (workspaceId, nodeId) =>
      fixturePromise(() => (workspaceId === "workspace-analytics" ? fixtureLinks(nodeId) : [])),
    registerWorkspace: (path) =>
      fixturePromise(() => ({
        workspaceId: `workspace-${path}`,
        name: path.split("/").filter(Boolean).at(-1) ?? path,
        path,
        kind: "local-directory",
        trust: "pending",
        status: "active",
        revision: 0,
        createdAt: new Date(0).toISOString(),
        lastUsedAt: new Date(0).toISOString(),
      })),
    decideWorkspaceTrust: (workspace, decision) =>
      fixturePromise(() => ({ ...workspace, trust: decision, revision: workspace.revision + 1 })),
    // fixture 방은 이 서비스가 들고 있는 활동을 그대로 씁니다. 실 daemon에서는 loadRoom이 대체합니다.
    loadRooms: (workId: string) =>
      fixturePromise(() => {
        const work = initialSnapshot.works.find((candidate) => candidate.id === workId);
        if (!work) return [];
        const speak = (handle: string) =>
          speakerFor({ authorKind: "agent", authorId: handle }, fixtureOrganizationNodes);
        const quill = speak("evidence-research");
        const vega = speak("delivery-coordination");
        const budget = (
          roomId: string,
          name: string,
          rounds: number,
          maxRounds: number,
          tokens: number,
          maxTokens: number,
          cost: number,
          maxCost: number,
        ) =>
          projectRoomBudgets({
            workId,
            roomId,
            name,
            kind: "work",
            status: "active",
            participantIds: [],
            lastMessageSequence: 0,
            roundCount: rounds,
            maxRounds,
            usedTokens: tokens,
            maxTokens,
            usedCostMicros: cost,
            maxCostMicros: maxCost,
          });

        // 아직 아무도 말하지 않은 Work. 빈 방도 정상 상태입니다.
        if (work.activities.length === 0) {
          return [
            {
              roomId: `${workId}-core-office`,
              name: "Core Office",
              status: "active",
              participants: [speak("representative")],
              lastMessageSequence: 0,
              budgets: budget(`${workId}-core-office`, "Core Office", 0, 100, 0, 200_000, 0, 1_000_000),
              sharedContexts: [],
              activities: [],
            },
          ];
        }

        const room = fixtureRoomShapes[workId] ?? fixtureDefaultRoom;
        const core = {
          roomId: `${workId}-core-office`,
          name: "Core Office",
          status: "active",
          participants: room.participants.map(speak),
          lastMessageSequence: work.activities.length,
          budgets: budget(
            `${workId}-core-office`,
            "Core Office",
            room.rounds,
            100,
            room.tokens,
            200_000,
            room.cost,
            1_000_000,
          ),
          sharedContexts: [...room.sharedContexts],
          activities: work.activities,
        };
        // 갈라진 방은 그 대화를 실제로 나눈 Work에만 붙습니다.
        if (workId !== "churn-q3") return withRoomReferences([core]);

        return withRoomReferences([
          core,
          // 에이전트 둘이 대표를 거치지 않고 직접 붙은 방. 도메인은 참가자 수만 다른 같은 협업방입니다.
          {
            roomId: `${workId}-cohort`,
            name: "코호트 정의 정리",
            status: "active",
            participants: [quill, vega],
            lastMessageSequence: 3,
            budgets: budget(`${workId}-cohort`, "코호트 정의 정리", 2, 6, 9_400, 60_000, 61_000, 500_000),
            sharedContexts: [{ id: "ref-cohort", label: "evidence-brief · 2분기 코호트 정의", checksum: "5be07d" }],
            activities: [
              {
                id: "cohort-q",
                kind: "room",
                messageType: "question",
                time: "10:26",
                speaker: vega,
                recipient: quill.name,
                content: "2분기 코호트 정의를 3분기에 맞추려면 어떤 필드를 다시 계산해야 하나요?",
              },
              {
                id: "cohort-a",
                kind: "room",
                messageType: "answer",
                time: "10:27",
                speaker: quill,
                indented: true,
                content: "가입 기준일과 해지 판정 유예 기간 둘입니다. 나머지는 그대로 씁니다.",
                evidence: { label: "2분기 코호트 정의", checksum: "5be07d" },
              },
              {
                id: "cohort-c",
                kind: "room",
                messageType: "change_request",
                time: "10:28",
                speaker: vega,
                target: "코호트 데이터.csv",
                content: "유예 기간을 14일로 통일해서 다시 뽑아 주세요.",
              },
            ],
          },
        ]);
      }),

    loadOrganization: () => fixturePromise(() => ({ version: 1, nodes: fixtureOrganizationNodes })),
    applyOrganizationChange: (input) =>
      fixturePromise(() => {
        // 브라우저 개발 화면에는 조직 원장이 없습니다. 편성 결과를 지어내면 화면이 실제로는
        // 일어나지 않은 조직 변경을 사실처럼 보여 줍니다.
        throw new Error(`Fixture는 조직 편성을 구성하지 않았습니다: ${input.change.kind}`);
      }),
    loadAutonomy: () =>
      fixturePromise(() => ({
        mode: "automatic",
        revision: 0,
        runtimePermissionStatus: "governed",
        growthMode: growthConfiguration.adoptionMode,
        growthReflectionEnabled: growthConfiguration.reflectionEnabled,
        growthConfigurationVersion: growthConfiguration.version,
        emergencyStopActive: false,
      })),
    setAutonomy: (mode, expectedRevision) =>
      fixturePromise(() => ({
        mode,
        revision: expectedRevision + 1,
        runtimePermissionStatus: mode === "full-access" ? "full-access" : "governed",
        growthMode: growthConfiguration.adoptionMode,
        growthReflectionEnabled: growthConfiguration.reflectionEnabled,
        growthConfigurationVersion: growthConfiguration.version,
        emergencyStopActive: false,
      })),
    loadEmergency: () => fixturePromise(() => ({ active: false, revision: 0 })),
    loadRouteAttempts: () => fixturePromise(() => fixtureAttempts),
    activateEmergency: (reason) => fixturePromise(() => ({ active: true, reason, revision: 1 })),
    releaseEmergency: (_approvalId, reason) => fixturePromise(() => ({ active: false, reason, revision: 2 })),
    loadExtensions: () =>
      fixturePromise(() => [
        ...fixtureExtensionEntries,
        ...marketplaceEntries(
          fixtureRegistryInventory,
          fixtureExtensionEntries.map((item) => item.packageName),
        ),
      ]),
    loadSettings: () => fixturePromise(() => structuredClone(settingsState)),
    loginSubscription: (input) =>
      fixturePromise(() => {
        const accounts = settingsState.accounts as Array<Record<string, unknown>>;
        const existing = accounts.find((row) => row.providerId === input.providerId);
        if (existing && !input.newAccount) {
          existing.alias = input.alias;
          existing.status = "active";
          return;
        }
        accounts.push({
          accountId: `account-codex-fixture-${String(accounts.length + 1)}`,
          providerId: input.providerId,
          alias: input.alias,
          scope: "organization",
          status: "active",
          billingKind: "consumer-subscription",
          version: 1,
        });
      }),
    connectZaiCodingPlan: (input) =>
      fixturePromise(() => {
        if (!input.secret.trim()) throw new Error("구독 Credential secret은 비어 있을 수 없습니다");
        const accounts = settingsState.accounts as Array<Record<string, unknown>>;
        const account = accounts.find((row) => row.providerId === "zai-coding-plan");
        const accountId = account ? String(account.accountId) : "account-zai-fixture-0001";
        if (account) {
          account.alias = input.alias;
          account.status = "active";
          account.version = Number(account.version ?? 0) + 1;
        } else {
          accounts.push({
            accountId,
            providerId: "zai-coding-plan",
            alias: input.alias,
            scope: "organization",
            status: "active",
            billingKind: "coding-plan",
            version: 1,
          });
        }
        const catalog = settingsState.catalog as {
          providers: Array<Record<string, unknown>>;
          endpoints: Array<Record<string, unknown>>;
        };
        const endpointId = "ep-zai-coding-plan";
        if (!catalog.providers.some((row) => row.providerId === "zai-coding-plan")) {
          catalog.providers.push({
            providerId: "zai-coding-plan",
            displayName: "Z.ai Coding Plan",
            adapterKind: "openai-compatible",
            enabled: true,
          });
        }
        if (!catalog.endpoints.some((row) => row.endpointId === endpointId)) {
          catalog.endpoints.push({
            endpointId,
            providerId: "zai-coding-plan",
            name: "coding-plan",
            baseUrl: "https://api.z.ai/api/coding/paas/v4",
            local: false,
          });
        }
        const credentialId = `credential-${accountId}`;
        const credentials = settingsState.credentials as Array<Record<string, unknown>>;
        const credential = credentials.find((row) => row.credentialId === credentialId);
        if (credential) {
          credential.endpointId = endpointId;
          credential.label = input.alias;
          credential.status = "active";
        } else {
          credentials.push({
            credentialId,
            providerId: "zai-coding-plan",
            endpointId,
            label: input.alias,
            status: "active",
            priority: 1,
            weight: 1,
          });
          credentialVersions.set(credentialId, 1);
        }
      }),
    connectSubscriptionKey: () => fixturePromise(() => undefined),
    disconnectAccount: () => fixturePromise(() => undefined),
    registerProvider: (input) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as { providers: Record<string, unknown>[] };
        if (!catalog.providers.some((row) => row.providerId === input.providerId)) {
          catalog.providers.push({
            providerId: input.providerId,
            displayName: input.displayName,
            adapterKind: input.adapterKind,
            enabled: true,
          });
        }
      }),
    removeProvider: (providerId) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          providers: Record<string, unknown>[];
          endpoints: Record<string, unknown>[];
        };
        catalog.providers = catalog.providers.filter((row) => row.providerId !== providerId);
        catalog.endpoints = catalog.endpoints.filter((row) => row.providerId !== providerId);
        const credentials = settingsState.credentials as Record<string, unknown>[];
        for (let index = credentials.length - 1; index >= 0; index -= 1) {
          if (credentials[index]?.providerId === providerId) credentials.splice(index, 1);
        }
        return { removed: true };
      }),
    registerEndpoint: (input) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          providers: Record<string, unknown>[];
          endpoints: Record<string, unknown>[];
        };
        if (!catalog.providers.some((row) => row.providerId === input.providerId))
          throw new Error("Fixture Provider를 찾을 수 없습니다");
        const endpointId = `ep-${String(input.providerId)}${input.name === "api" ? "" : `-${String(input.name)}`}`;
        const existing = catalog.endpoints.find(
          (row) => row.providerId === input.providerId && row.baseUrl === input.baseUrl,
        );
        if (!existing) {
          catalog.endpoints.push({
            endpointId,
            providerId: input.providerId,
            name: input.name,
            baseUrl: input.baseUrl,
            local: input.local,
          });
        }
        const existingId = existing?.endpointId;
        return { endpointId: typeof existingId === "string" ? existingId : endpointId };
      }),
    addCredential: (input) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          providers: Record<string, unknown>[];
          endpoints: Record<string, unknown>[];
          credentials: Record<string, unknown>[];
        };
        if (!catalog.providers.some((row) => row.providerId === input.providerId))
          throw new Error("Fixture Provider를 찾을 수 없습니다");
        const endpoint = catalog.endpoints.find((row) => row.endpointId === input.endpointId);
        if (!endpoint || endpoint.providerId !== input.providerId)
          throw new Error("Fixture Endpoint를 찾을 수 없습니다");
        const existing = catalog.credentials.find(
          (row) =>
            row.providerId === input.providerId && row.endpointId === input.endpointId && row.label === input.label,
        );
        if (existing) existing.secretVersion = Number(existing.secretVersion ?? 0) + 1;
        else
          catalog.credentials.push({
            providerId: input.providerId,
            endpointId: input.endpointId,
            label: input.label,
            secretVersion: 1,
          });
        const credentials = settingsState.credentials as Array<Record<string, unknown>>;
        const credential = credentials.find(
          (row) =>
            row.providerId === input.providerId && row.endpointId === input.endpointId && row.label === input.label,
        );
        if (credential) {
          credential.status = "active";
          const credentialId = String(credential.credentialId);
          credentialVersions.set(credentialId, (credentialVersions.get(credentialId) ?? 0) + 1);
        } else {
          credentials.push({
            credentialId: `credential-${String(input.providerId)}-${String(input.endpointId)}-${String(input.label)}`,
            providerId: input.providerId,
            endpointId: input.endpointId,
            label: input.label,
            status: "active",
            priority: input.priority,
            weight: input.weight,
          });
          credentialVersions.set(
            `credential-${String(input.providerId)}-${String(input.endpointId)}-${String(input.label)}`,
            1,
          );
        }
      }),
    syncProviderModels: (endpointId) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          endpoints: Array<Record<string, unknown>>;
          discoveredModels: Array<Record<string, unknown>>;
          catalogStatuses: Array<Record<string, unknown>>;
        };
        const endpoint = catalog.endpoints.find((row) => row.endpointId === endpointId);
        if (!endpoint) throw new Error("Fixture Endpoint를 찾을 수 없습니다");
        const activeCount = catalog.discoveredModels.filter(
          (row) => row.endpointId === endpointId && row.state === "active",
        ).length;
        const status = activeCount > 0 ? "available" : "empty";
        const now = new Date().toISOString();
        const existingIndex = catalog.catalogStatuses.findIndex((row) => row.endpointId === endpointId);
        const existing = existingIndex < 0 ? undefined : catalog.catalogStatuses[existingIndex];
        for (const model of catalog.discoveredModels) {
          if (model.endpointId === endpointId && model.state === "active") model.lastSeenAt = now;
        }
        const next = {
          providerId: endpoint.providerId,
          endpointId,
          status,
          activeCount,
          invalidCount: 0,
          duplicateCount: 0,
          lastAttemptedAt: now,
          ...(activeCount > 0
            ? { lastSuccessfulAt: now }
            : {
                diagnosticReason: "empty-catalog",
                ...(typeof existing?.lastSuccessfulAt === "string"
                  ? { lastSuccessfulAt: existing.lastSuccessfulAt }
                  : {}),
              }),
        };
        if (existingIndex < 0) catalog.catalogStatuses.push(next);
        else catalog.catalogStatuses[existingIndex] = next;
        return {
          status,
          activeCount,
          invalidCount: 0,
          duplicateCount: 0,
          ...(activeCount > 0 ? {} : { diagnosticReason: "empty-catalog" }),
        };
      }),
    disableCredential: (credentialId, expectedVersion) =>
      fixturePromise(() => {
        const credentials = settingsState.credentials as Array<Record<string, unknown>>;
        const credential = credentials.find((row) => row.credentialId === credentialId);
        if (!credential) throw new Error("Fixture Credential을 찾을 수 없습니다");
        if (credentialVersions.get(credentialId) !== expectedVersion)
          throw new Error("Credential version precondition이 일치하지 않습니다");
        credential.status = "revoked";
        credentialVersions.set(credentialId, expectedVersion + 1);
      }),
    registerModel: (input) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          providers: Array<Record<string, unknown>>;
          endpoints: Array<Record<string, unknown>>;
          models: Array<Record<string, unknown>>;
        };
        if (!catalog.providers.some((row) => row.providerId === input.providerId))
          throw new Error("Fixture Provider를 찾을 수 없습니다");
        const endpoint = catalog.endpoints.find((row) => row.endpointId === input.endpointId);
        if (!endpoint) throw new Error("Fixture Endpoint를 찾을 수 없습니다");
        if (endpoint.providerId !== input.providerId) throw new Error("Model Profile의 Provider와 Endpoint가 다릅니다");
        if (
          catalog.models.some(
            (row) =>
              row.providerId === input.providerId &&
              row.endpointId === input.endpointId &&
              row.modelId === input.modelId,
          )
        )
          throw new Error("중복 Model Profile입니다");
        catalog.models.push({
          modelProfileId: `mp-${String(input.modelId)}`,
          providerId: input.providerId,
          endpointId: input.endpointId,
          modelId: input.modelId,
          routeKind: input.routeKind,
          contextWindow: input.contextWindow,
          supportsTools: input.supportsTools,
          supportsStructuredOutput: input.supportsStructuredOutput,
          supportsVision: input.supportsVision,
          supportsStreaming: input.supportsStreaming,
          equivalenceGroup: input.equivalenceGroup,
          evalScore: input.evalScore,
          inputCostMicrosPerMillion: input.inputCostMicrosPerMillion,
          outputCostMicrosPerMillion: input.outputCostMicrosPerMillion,
          verified: input.verified,
          enabled: true,
        });
      }),
    setRouteBudget: (input) =>
      fixturePromise(() => {
        // 브라우저 개발 화면에는 라우터 원장이 없습니다. 한도를 바꾼 척하면 게이지가 거짓말을 합니다.
        throw new Error(`Fixture는 경로 예산 변경을 구성하지 않았습니다: ${input.routeId}`);
      }),
    configureRoute: (input) =>
      fixturePromise(() => {
        const routes = settingsState.routes as Array<Record<string, unknown>>;
        const existing = routes.find((row) => row.name === input.name);
        const routeId = `route-${String(input.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")}`;
        if (existing) throw new Error("중복 Model Route 이름입니다");
        routes.push({
          routeId,
          name: input.name,
          routeKind: input.routeKind,
          credentialPolicy: input.credentialPolicy,
          dataPolicy: input.dataPolicy,
          equivalenceGroup: input.equivalenceGroup,
          minEvalScore: input.minEvalScore,
          requireTools: input.requireTools,
          requireStructuredOutput: input.requireStructuredOutput,
          requireVision: input.requireVision,
          requireStreaming: input.requireStreaming,
          maxContextTokens: input.maxContextTokens,
          requestBudgetMicros: input.requestBudgetMicros,
          totalBudgetMicros: input.totalBudgetMicros,
          enabled: true,
          spentMicros: 0,
        });
      }),
    addRouteCandidate: (input) =>
      fixturePromise(() => {
        const catalog = settingsState.catalog as {
          models: Array<Record<string, unknown>>;
          candidates: Array<Record<string, unknown>>;
        };
        const routes = settingsState.routes as Array<Record<string, unknown>>;
        const route = routes.find((row) => row.routeId === input.routeId);
        if (!route) throw new Error("Fixture Model Route를 찾을 수 없습니다");
        const model = catalog.models.find((row) => row.modelProfileId === input.modelProfileId);
        if (!model) throw new Error("Fixture Model Profile을 찾을 수 없습니다");
        if (
          catalog.candidates.some((row) => row.routeId === input.routeId && row.modelProfileId === input.modelProfileId)
        )
          throw new Error("중복 Route Candidate입니다");
        const endpoint = (settingsState.catalog as { endpoints: Array<Record<string, unknown>> }).endpoints.find(
          (row) => row.endpointId === model.endpointId,
        );
        if (
          !endpoint ||
          model.enabled !== true ||
          model.verified !== true ||
          model.routeKind !== route.routeKind ||
          model.equivalenceGroup !== route.equivalenceGroup ||
          Number(model.evalScore) < Number(route.minEvalScore) ||
          Number(model.contextWindow) < Number(route.maxContextTokens) ||
          (route.requireTools === true && model.supportsTools !== true) ||
          (route.requireStructuredOutput === true && model.supportsStructuredOutput !== true) ||
          (route.requireVision === true && model.supportsVision !== true) ||
          (route.requireStreaming === true && model.supportsStreaming !== true) ||
          (route.dataPolicy === "local-private" && endpoint.local !== true)
        ) {
          throw new Error("Route Candidate가 요구사항을 충족하지 않습니다");
        }
        catalog.candidates.push({
          candidateId: `candidate-${String(input.routeId)}-${String(input.modelProfileId)}`,
          routeId: input.routeId,
          modelProfileId: input.modelProfileId,
          priority: input.priority,
          enabled: true,
        });
      }),
    configureSubscriptionPolicy: (input) =>
      fixturePromise(() => {
        const credentialPolicies = new Set([
          "adaptive",
          "priority",
          "fill-first",
          "round-robin",
          "weighted",
          "least-used",
          "quota-headroom",
          "reset-aware",
          "sticky",
        ]);
        const approvalModes = new Set(["automatic", "review", "deny"]);
        if (!credentialPolicies.has(String(input.credentialPolicy)))
          throw new Error("지원하지 않는 구독 계정 선택 정책입니다");
        const requestedApprovalMode = input.approvalMode;
        if (
          requestedApprovalMode !== undefined &&
          (typeof requestedApprovalMode !== "string" || !approvalModes.has(requestedApprovalMode))
        )
          throw new Error("지원하지 않는 구독 승인 방식입니다");
        const policies = settingsState.policy as Array<Record<string, unknown>>;
        const existing = policies.find((row) => row.providerId === input.providerId);
        const provider = (settingsState.catalog as { providers: Array<Record<string, unknown>> }).providers.find(
          (row) => row.providerId === input.providerId,
        );
        const commonSurfaceProviders = new Set([
          "anthropic-claude-code",
          "openai-codex",
          "google-gemini-cli-enterprise",
          "github-copilot",
          "google-antigravity-cli",
          "xai-grok-build",
        ]);
        const defaultApprovalMode =
          input.providerId === "zai-coding-plan"
            ? "deny"
            : provider?.enabled === true && commonSurfaceProviders.has(String(input.providerId))
              ? "automatic"
              : "deny";
        const approvalMode = requestedApprovalMode ?? (existing ? String(existing.approvalMode) : defaultApprovalMode);
        if (existing)
          Object.assign(existing, {
            providerId: input.providerId,
            credentialPolicy: input.credentialPolicy,
            approvalMode,
            version: Number(existing.version ?? 0) + 1,
            source: "configured",
            updatedAt: new Date().toISOString(),
          });
        else
          policies.push({
            providerId: input.providerId,
            credentialPolicy: input.credentialPolicy,
            approvalMode,
            version: 1,
            source: "configured",
            updatedAt: new Date().toISOString(),
          });
      }),
    searchRegistry: (query, limit = 20) =>
      fixturePromise(() =>
        fixtureRegistryInventory
          .filter((item) =>
            `${item.packageName} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()),
          )
          .slice(0, limit),
      ),
    loadRegistryInfo: (versionId) => fixturePromise(() => fixtureRegistryDetail(versionId)),
    loadCapabilities: () => fixturePromise(() => ({ extensions: [], inventory: fixtureRegistryInventory })),
    configureGrowth: (input) =>
      fixturePromise(() => {
        if (typeof input.reflectionEnabled !== "boolean")
          throw new Error("Growth reflectionEnabled는 boolean이어야 합니다");
        const adoptionMode: unknown = input.adoptionMode;
        if (adoptionMode !== "review" && adoptionMode !== "auto") {
          throw new Error("Growth adoptionMode는 review 또는 auto여야 합니다");
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== growthConfiguration.version) {
          throw new Error("Growth configuration version precondition이 일치하지 않습니다");
        }
        const version = growthConfiguration.version + 1;
        growthConfiguration = {
          ...growthConfiguration,
          reflectionEnabled: input.reflectionEnabled,
          adoptionMode: input.adoptionMode,
          version,
          checksum: fixtureGrowthChecksum(version, input.reflectionEnabled, input.adoptionMode),
          governanceDecisionId: `decision-growth-fixture-${String(version)}`,
          activatedAt: new Date().toISOString(),
        };
      }),
    putExplicitMemory: (input) =>
      fixturePromise(() => {
        if (explicitMemory.revision !== input.revision)
          throw new Error("개인 Memory version precondition이 일치하지 않습니다");
        explicitMemory = {
          ...explicitMemory,
          memoryVersionId: `memory-fixture-${String(++explicitMemorySequence).padStart(4, "0")}`,
          revision: explicitMemory.revision + 1,
          entries: [
            ...explicitMemory.entries.filter((entry) => entry.key !== input.key),
            { key: input.key, kind: input.kind, value: input.value, authority: "explicit" },
          ],
        };
      }),
    forgetExplicitMemory: (input) =>
      fixturePromise(() => {
        if (explicitMemory.revision !== input.revision)
          throw new Error("개인 Memory version precondition이 일치하지 않습니다");
        const entries = explicitMemory.entries.filter((entry) => entry.key !== input.key);
        if (entries.length === explicitMemory.entries.length) throw new Error("개인 Memory key를 찾을 수 없습니다");
        explicitMemory = {
          ...explicitMemory,
          memoryVersionId: `memory-fixture-${String(++explicitMemorySequence).padStart(4, "0")}`,
          revision: explicitMemory.revision + 1,
          entries,
        };
      }),
    loadGrowth: () =>
      fixturePromise(() => {
        const cohortAdoption = growthSuggestionLineages["suggestion-cohort-guard"]?.adoption;
        const targetDriftAdoption = growthSuggestionLineages["suggestion-target-drift-fixture"]?.adoption;
        const view = {
          configuration: { ...growthConfiguration },
          suggestions: [
            {
              suggestionId: "suggestion-cohort-guard",
              workId: "churn-q3",
              targetKind: "prompt",
              operation: "replace-instruction",
              summary: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다.",
              revision: 3,
              createdAt: "2026-07-23T10:31:00.000Z",
              reflectionRunId: "reflection-0011",
              sourceReferenceIds: ["work:churn-q3", "message:cohort-challenge", "verification:significance"],
              patch: [
                {
                  targetHandle: "context-strategy",
                  path: "완료 기준",
                  before: "분석 대상 기간과 지표를 명시한다",
                  after: "분석 대상 기간과 지표를 명시하고, 기간 간 비교가 포함되면 코호트 정의 일치를 먼저 확인한다",
                },
              ],
              evaluation: {
                evaluationRunId: "evaluation-0031",
                outcome: "eligible" as const,
                inputHash: "fixture-evaluation-cohort",
                strategyVersionId: "strategy-v4",
                signals: [
                  {
                    signalId: "signal-rework",
                    group: "required" as const,
                    origin: "deterministic" as const,
                    outcome: "passed" as const,
                    score: 0.75,
                    adapterId: "rework-counter",
                    adapterVersion: "1.2.0",
                    note: "최근 12개 Work 중 3건이 같은 원인으로 재작업",
                  },
                  {
                    signalId: "signal-assurance",
                    group: "required" as const,
                    origin: "independent" as const,
                    outcome: "passed" as const,
                    score: 0.68,
                    adapterId: "assurance-verdict",
                    adapterVersion: "2.0.1",
                    note: "독립 검증이 같은 원인을 2회 반론으로 제기",
                  },
                  {
                    signalId: "signal-latency",
                    group: "conflict" as const,
                    origin: "deterministic" as const,
                    outcome: "failed" as const,
                    score: 0.31,
                    adapterId: "stage-duration",
                    adapterVersion: "1.0.4",
                    note: "맥락 단계 소요가 중앙값 기준 18% 늘어남",
                  },
                  {
                    signalId: "signal-selfcheck",
                    group: "supporting" as const,
                    origin: "model-self" as const,
                    outcome: "passed" as const,
                    score: 0.82,
                    adapterId: "reflection-selfcheck",
                    adapterVersion: "0.9.0",
                    note: "모델 자기평가. 독립 신호로 계산하지 않음",
                  },
                ],
              },
              targetDrifted: false,
              rationale:
                "3분기 이탈 분석에서 검증이 코호트 정의 불일치를 반론으로 제기했고, 같은 원인으로 이전 두 Work에서도 재작업이 있었습니다.",
              expectedEffect: "분기 비교가 포함된 Work의 재작업이 줄어듭니다.",
              riskSummary: "완료 기준이 하나 늘어 단순 요청의 맥락 단계가 길어질 수 있습니다.",
              status: "awaiting-review",
              ...(cohortAdoption === undefined ? {} : { adoption: cohortAdoption }),
            },
            {
              suggestionId: "suggestion-quant-persist",
              workId: "churn-q3",
              targetKind: "organization",
              operation: "promote-node",
              summary: "임시로 만든 계량분석 팀을 조직에 남깁니다.",
              revision: 1,
              createdAt: "2026-07-23T10:44:00.000Z",
              reflectionRunId: "reflection-0011",
              sourceReferenceIds: ["work:churn-q3", "organization:version-13"],
              patch: [
                {
                  path: "계량분석 팀",
                  before: 'scope: "work" · 이 Work가 끝나면 사라짐',
                  after: 'scope: "persistent" · 조직에 남음',
                },
              ],
              evaluation: {
                evaluationRunId: "evaluation-0032",
                outcome: "ineligible" as const,
                inputHash: "fixture-evaluation-quant",
                strategyVersionId: "strategy-v4",
                signals: [
                  {
                    signalId: "signal-demand",
                    group: "required" as const,
                    origin: "deterministic" as const,
                    outcome: "passed" as const,
                    score: 0.71,
                    adapterId: "capability-demand",
                    adapterVersion: "1.1.0",
                    note: "최근 4개 Work 중 3개가 통계 검정을 요구",
                  },
                  {
                    signalId: "signal-sample",
                    group: "required" as const,
                    origin: "deterministic" as const,
                    outcome: "failed" as const,
                    score: 0.22,
                    adapterId: "observation-window",
                    adapterVersion: "1.0.0",
                    note: "관측 표본 4건. 최소 표본 10건에 못 미침",
                  },
                ],
              },
              targetDrifted: true,
              rationale: "최근 4개 Work 중 3개가 통계 검정을 요구했고 매번 scope work 노드를 새로 만들었습니다.",
              expectedEffect: "같은 팀을 반복 생성하지 않고 조직 버전이 안정됩니다.",
              riskSummary: "쓰이지 않는 분기에도 노드가 남아 조직이 커집니다.",
              status: "evaluated",
            },
            {
              suggestionId: "suggestion-target-drift-fixture",
              workId: "churn-q3",
              targetKind: "prompt",
              operation: "replace-instruction",
              summary: "대상 checksum이 바뀐 제안은 승인하지 않습니다.",
              revision: 1,
              rationale: "제안한 뒤 대상 지시문이 갱신됐습니다.",
              expectedEffect: "오래된 대상을 덮어쓰지 않습니다.",
              riskSummary: "다시 평가해야 합니다.",
              status: "awaiting-review",
              targetDrifted: true,
              evaluation: {
                evaluationRunId: "evaluation-target-drift",
                outcome: "eligible" as const,
                inputHash: "fixture-evaluation-drift",
                strategyVersionId: "strategy-v4",
                signals: [],
              },
              ...(targetDriftAdoption === undefined ? {} : { adoption: targetDriftAdoption }),
            },
            {
              suggestionId: "suggestion-proposed-fixture",
              workId: "churn-q3",
              targetKind: "prompt",
              operation: "append-instruction",
              summary: "검증 전 제안의 거절 경로를 보여줍니다.",
              revision: 1,
              rationale: "같은 실패를 재현했지만 아직 평가가 끝나지 않았습니다.",
              expectedEffect: "검증 기준을 빠뜨리지 않습니다.",
              riskSummary: "평가 전에는 근거가 부족할 수 있습니다.",
              status: "proposed",
            },
            {
              suggestionId: "suggestion-evaluated-fixture",
              workId: "churn-q3",
              targetKind: "memory",
              operation: "add-entry",
              summary: "평가 완료 제안의 거절 경로를 보여줍니다.",
              revision: 1,
              rationale: "평가는 끝났지만 사람이 채택을 결정하지 않았습니다.",
              expectedEffect: "검토 근거를 기억에 남깁니다.",
              riskSummary: "현재 업무에는 적용 범위가 넓습니다.",
              status: "evaluated",
            },
            {
              // 자동 반영(approvalId 없음) → 효과 개선 확인 → retained.
              suggestionId: "suggestion-handoff-note",
              workId: "contract-review",
              targetKind: "prompt",
              operation: "append-instruction",
              summary: "인계할 때 해소하지 못한 질문을 함께 넘깁니다.",
              revision: 2,
              createdAt: "2026-07-16T14:05:00.000Z",
              reflectionRunId: "reflection-0008",
              sourceReferenceIds: ["work:contract-review", "message:handoff-gap", "verification:handoff-completeness"],
              patch: [
                {
                  targetHandle: "delivery",
                  path: "인계 규칙",
                  before: "완료한 것을 요약해 넘긴다",
                  after: "완료한 것과 함께 해소하지 못한 질문을 목록으로 넘긴다",
                },
              ],
              evaluation: {
                evaluationRunId: "evaluation-0024",
                outcome: "eligible" as const,
                strategyVersionId: "strategy-v4",
                signals: [
                  {
                    signalId: "signal-handoff-rework",
                    group: "required" as const,
                    origin: "deterministic" as const,
                    outcome: "passed" as const,
                    score: 0.79,
                    adapterId: "rework-counter",
                    adapterVersion: "1.2.0",
                    note: "인계 직후 재질문이 최근 9개 Work 중 5건",
                  },
                  {
                    signalId: "signal-handoff-verdict",
                    group: "required" as const,
                    origin: "independent" as const,
                    outcome: "passed" as const,
                    score: 0.74,
                    adapterId: "assurance-verdict",
                    adapterVersion: "2.0.1",
                    note: "독립 검증이 인계 누락을 3회 지적",
                  },
                ],
              },
              targetDrifted: false,
              rationale: "인계 직후 같은 질문이 다시 올라오는 일이 최근 9개 Work 중 5건이었습니다.",
              expectedEffect: "인계 후 재작업이 줄어듭니다.",
              riskSummary: "인계 문서가 길어져 읽는 시간이 늘어납니다.",
              status: "adopted",
              adoption: {
                adoptionId: "adoption-0002",
                status: "retained",
                commandId: "command-growth-0041",
                evaluationRunId: "evaluation-0024",
                evaluationInputHash: "6b1f0d4a92c7e35810ba4fd6c208e9713f5a4c8e2d0b7691a3f4c5e8d2b0179a",
                beforeVersionId: "prompt-delivery-v7",
                beforeChecksum: "a41c7e0932b58d16fe4a09c3d7b25801e6f39a4c8b0d2517e93f6a4c1b8d05e2",
                afterVersionId: "prompt-delivery-v8",
                afterChecksum: "d80b5f2a6c19e473a05d8b3f61c94207e5a83d1f0b62c748e91a3f5d0c26b481",
                adoptedAt: "2026-07-16T14:22:00.000Z",
              },
            },
            {
              // 사람이 승인 → 효과 저하 관찰 → 되돌림.
              suggestionId: "suggestion-verify-depth",
              workId: "pricing-model",
              targetKind: "policy",
              operation: "raise-threshold",
              summary: "수치 결론에는 독립 검증을 두 번 거칩니다.",
              revision: 1,
              createdAt: "2026-07-19T09:40:00.000Z",
              reflectionRunId: "reflection-0009",
              sourceReferenceIds: ["work:pricing-model", "verification:number-check"],
              patch: [
                {
                  path: "검증 횟수",
                  before: "수치 결론은 독립 검증 1회",
                  after: "수치 결론은 독립 검증 2회",
                },
              ],
              evaluation: {
                evaluationRunId: "evaluation-0027",
                outcome: "eligible" as const,
                strategyVersionId: "strategy-v4",
                signals: [
                  {
                    signalId: "signal-number-defect",
                    group: "required" as const,
                    origin: "independent" as const,
                    outcome: "passed" as const,
                    score: 0.7,
                    adapterId: "assurance-verdict",
                    adapterVersion: "2.0.1",
                    note: "수치 오류가 검증 이후 단계에서 2회 발견",
                  },
                  {
                    signalId: "signal-verify-cost",
                    group: "conflict" as const,
                    origin: "deterministic" as const,
                    outcome: "failed" as const,
                    score: 0.38,
                    adapterId: "stage-duration",
                    adapterVersion: "1.0.4",
                    note: "검증 단계 소요가 중앙값 기준 2배",
                  },
                ],
              },
              targetDrifted: false,
              rationale: "가격 모델 Work에서 수치 오류가 검증을 통과한 뒤 두 번 발견됐습니다.",
              expectedEffect: "수치 결론의 오류가 줄어듭니다.",
              riskSummary: "모든 수치 Work의 검증 단계가 길어집니다.",
              status: "adopted",
              adoption: {
                adoptionId: "adoption-0003",
                status: "reverted",
                commandId: "command-growth-0052",
                approvalId: "approval-growth-0018",
                evaluationRunId: "evaluation-0027",
                evaluationInputHash: "3c9a7e15d0b846f2917c5a0e3d8b6412f7095c2a8e4d1b63095f7a2c4e8d61b0",
                beforeVersionId: "policy-assurance-v3",
                beforeChecksum: "5e2d90a7c13b846f095a2d7e4c1b830956f7a2e4d0c8b1739e5a2f6c04d8b319",
                afterVersionId: "policy-assurance-v4",
                afterChecksum: "91f4c7a205e8d3b607a4f9c2e50d8b3617f2a9c4e0d5b8317a6f2c9e40d5b8371",
                adoptedAt: "2026-07-19T10:02:00.000Z",
                revertedAt: "2026-07-24T08:15:00.000Z",
              },
            },
            {
              // 사람이 거부. 도메인이 거절에 결정 계보를 강제합니다.
              suggestionId: "suggestion-tone-brief",
              workId: "churn-q3",
              targetKind: "memory",
              operation: "add-entry",
              summary: "모든 보고를 5줄 이내로 고정합니다.",
              revision: 1,
              createdAt: "2026-07-22T16:10:00.000Z",
              reflectionRunId: "reflection-0010",
              sourceReferenceIds: ["work:churn-q3", "message:length-complaint"],
              patch: [
                {
                  path: "answer-style",
                  before: "분석 결과는 결론부터 설명한다",
                  after: "분석 결과는 결론부터 설명하고 본문을 5줄 이내로 쓴다",
                },
              ],
              evaluation: {
                evaluationRunId: "evaluation-0029",
                outcome: "eligible" as const,
                strategyVersionId: "strategy-v4",
                signals: [
                  {
                    signalId: "signal-length-complaint",
                    group: "required" as const,
                    origin: "deterministic" as const,
                    outcome: "passed" as const,
                    score: 0.66,
                    adapterId: "message-sentiment",
                    adapterVersion: "1.0.2",
                    note: "보고가 길다는 발언이 최근 6개 Work 중 4건",
                  },
                  {
                    signalId: "signal-length-selfcheck",
                    group: "supporting" as const,
                    origin: "model-self" as const,
                    outcome: "passed" as const,
                    score: 0.88,
                    adapterId: "reflection-selfcheck",
                    adapterVersion: "0.9.0",
                    note: "모델 자기평가. 독립 신호로 계산하지 않음",
                  },
                ],
              },
              targetDrifted: false,
              rationale: "보고가 길다는 발언이 최근 6개 Work 중 4건이었습니다.",
              expectedEffect: "보고를 읽는 시간이 줄어듭니다.",
              riskSummary: "근거를 함께 읽어야 하는 보고에서 판단에 필요한 값이 잘립니다.",
              status: "rejected",
              decisionReason: "규제 검토 보고는 근거를 줄이면 다시 물어야 해서 길이를 고정하지 않는다",
              decidedAt: "2026-07-22T16:38:00.000Z",
            },
          ],
          memories: [
            {
              memoryVersionId: "memory-0004",
              revision: 4,
              entries: [
                {
                  key: "answer-style",
                  kind: "preference" as const,
                  value: "분석 결과는 결론부터 설명한다",
                  authority: "explicit" as const,
                },
              ],
            },
          ],
          effects: [
            {
              effectEvaluationId: "effect-0002",
              adoptionId: "adoption-0002",
              result: "improved" as const,
              suggestionId: "suggestion-handoff-note",
              measure: {
                score: 0.34,
                observationCount: 14,
                minimumObservations: 10,
                unit: "재작업 비율",
                direction: "lower" as const,
                baseline: 0.51,
              },
            },
            {
              // 저하가 확인돼 adoption-0003이 되돌아갔습니다.
              effectEvaluationId: "effect-0003",
              adoptionId: "adoption-0003",
              result: "degraded" as const,
              suggestionId: "suggestion-verify-depth",
              measure: {
                score: 0.44,
                observationCount: 12,
                minimumObservations: 10,
                unit: "재작업 비율",
                direction: "lower" as const,
                baseline: 0.28,
              },
            },
          ],
        };
        return structuredClone({
          ...view,
          configuration: { ...growthConfiguration },
          memories: [explicitMemory],
          suggestions: view.suggestions.map((suggestion) => {
            const override = growthSuggestionOverrides.get(suggestion.suggestionId);
            if (!override) return suggestion;
            return {
              ...suggestion,
              status: override.status,
              ...(override.revision === undefined ? {} : { revision: override.revision }),
              ...(override.adoption === undefined ? {} : { adoption: override.adoption }),
              ...(override.decisionReason === undefined ? {} : { decisionReason: override.decisionReason }),
              ...(override.decidedAt === undefined ? {} : { decidedAt: override.decidedAt }),
            };
          }),
        });
      }),
    loadGrowthSuggestion: (suggestionId) =>
      fixturePromise(() => {
        throw new Error(`Fixture Growth Suggestion exact 조회를 구성하지 않았습니다: ${suggestionId}`);
      }),
    revertGrowthAdoption: (input) =>
      fixturePromise(() => {
        // 브라우저 개발 화면에는 채택 원장이 없습니다. 되돌리기 결과를 지어내는 대신,
        // 실계약에서만 답할 수 있다는 사실을 그대로 말합니다.
        if (!input.reason.trim()) throw new Error("되돌리기 사유가 필요합니다");
        throw new Error(`Fixture는 채택 되돌리기를 구성하지 않았습니다: ${input.adoptionId}`);
      }),
    approveGrowthSuggestion: (input) =>
      fixturePromise(() => {
        const base = growthSuggestionLineages[input.suggestionId];
        if (!base) throw new Error("Growth Suggestion을 찾을 수 없습니다");
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
          throw new Error("Growth Suggestion revision이 유효하지 않습니다");
        }
        if (!input.reason.trim()) throw new Error("Growth Suggestion 승인 사유가 필요합니다");
        const current = { ...base, ...growthSuggestionOverrides.get(input.suggestionId) };
        if (current.revision !== input.expectedRevision) throw new Error("Growth Suggestion revision 충돌입니다");
        if (current.status !== "awaiting-review") throw new Error("승인 대기 중인 Growth Suggestion이 아닙니다");
        if (!current.evaluation || current.evaluation.outcome !== "eligible") {
          throw new Error("eligible Growth Suggestion만 승인할 수 있습니다");
        }
        if (!current.adoption || current.adoption.status !== "awaiting-review" || !current.adoption.approvalId) {
          throw new Error("승인 대기 중인 Growth Adoption을 찾을 수 없습니다");
        }
        if (
          current.evaluation.evaluationRunId !== current.adoption.evaluationRunId ||
          current.evaluation.inputHash !== current.adoption.evaluationInputHash
        ) {
          throw new Error("Growth Suggestion의 eligible 평가 계보가 일치하지 않습니다");
        }
        if (current.targetDrifted) throw new Error("대상 checksum이 바뀐 Growth Suggestion은 승인할 수 없습니다");
        growthSuggestionOverrides.set(input.suggestionId, {
          status: "adopted",
          revision: current.revision,
          adoption: {
            ...current.adoption,
            status: "observing",
            afterVersionId: `${current.adoption.beforeVersionId}:adopted`,
            afterChecksum: `${current.adoption.beforeChecksum}:adopted`,
            adoptedAt: new Date().toISOString(),
          },
        });
      }),
    rejectGrowthSuggestion: (input) =>
      fixturePromise(() => {
        const base = growthSuggestionLineages[input.suggestionId];
        if (!base) throw new Error("Growth Suggestion을 찾을 수 없습니다");
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
          throw new Error("Growth Suggestion revision이 유효하지 않습니다");
        }
        if (!input.reason.trim()) throw new Error("Growth Suggestion 거절 사유가 필요합니다");
        const current = { ...base, ...growthSuggestionOverrides.get(input.suggestionId) };
        if (current.revision !== input.expectedRevision) throw new Error("Growth Suggestion revision 충돌입니다");
        if (!["proposed", "evaluated", "awaiting-review"].includes(current.status)) {
          throw new Error("현재 상태의 Growth Suggestion은 거절할 수 없습니다");
        }
        growthSuggestionOverrides.set(input.suggestionId, {
          status: "rejected",
          revision: current.revision,
          ...(current.adoption === undefined ? {} : { adoption: { ...current.adoption, status: "rejected" } }),
          decisionReason: input.reason,
          decidedAt: new Date().toISOString(),
        });
      }),
    installRegistry: () =>
      fixturePromise(() => {
        // 브라우저 개발 화면에는 확장 원장이 없습니다. 설치됐다고 알리면 목록은 그대로인데
        // 화면만 «설치를 요청했습니다»라고 말합니다 — 일어나지 않은 일을 사실로 그립니다.
        throw new Error("Fixture는 확장 설치를 구성하지 않았습니다.");
      }),
    /* 도메인은 지시를 status 'queued'로 남기고, 투영이 활동 흐름의 message 한 줄로 옮깁니다. */
    submitDirective: (work, content, mode) =>
      fixturePromise(() => {
        directiveSequence += 1;
        const directiveId = `directive:fixture-${String(directiveSequence)}`;
        mutateWork(work.id, (current) => ({
          ...current,
          revision: current.revision + 1,
          queuedDirectives: [
            ...(current.queuedDirectives ?? []),
            {
              id: directiveId,
              content,
              status: "queued",
              mode,
              submittedStage: current.run?.stage ?? "intake",
              applyAt: mode === "now" ? "current-stage" : "next-stage",
              revision: 1,
            },
          ],
          activities: [
            ...current.activities,
            {
              id: directiveId,
              kind: "message",
              /* 픽스처의 시각은 실제 시계가 아닙니다. 방이 시각으로 정렬하므로 마지막 발언과 같은 자리에 둡니다. */
              time: current.activities.at(-1)?.time ?? fixtureTime(),
              author: "사용자",
              initials: "U",
              human: true,
              content,
            },
          ],
        }));
      }),
    updateDirective: (work, directive, content, mode) =>
      fixturePromise(() => {
        mutateWork(work.id, (current) => {
          const queued = current.queuedDirectives ?? [];
          const target = queued.find((candidate) => candidate.id === directive.id);
          if (!target || target.revision !== directive.revision) throw new Error("Fixture 지시 revision 충돌입니다");
          return {
            ...current,
            revision: current.revision + 1,
            queuedDirectives: queued.map((candidate) =>
              candidate.id === directive.id
                ? {
                    ...candidate,
                    content,
                    mode,
                    applyAt: mode === "now" ? "current-stage" : "next-stage",
                    revision: candidate.revision + 1,
                  }
                : candidate,
            ),
          };
        });
      }),
    cancelDirective: (work, directive) =>
      fixturePromise(() => {
        mutateWork(work.id, (current) => {
          const queued = current.queuedDirectives ?? [];
          const target = queued.find((candidate) => candidate.id === directive.id);
          if (!target || target.revision !== directive.revision) throw new Error("Fixture 지시 revision 충돌입니다");
          return {
            ...current,
            revision: current.revision + 1,
            queuedDirectives: queued.filter((candidate) => candidate.id !== directive.id),
            activities: [
              ...current.activities,
              {
                id: `directive-cancelled:${directive.id}`,
                kind: "event",
                semantic: "directive",
                time: current.activities.at(-1)?.time ?? fixtureTime(),
                title: "지시 상태",
                detail: target.content,
                status: "취소됨",
              },
            ],
          };
        });
      }),
    decideApproval: (approval, vote) =>
      fixturePromise(() => {
        if (approval.revision === undefined) throw new Error("Fixture 승인 revision이 없습니다");
        const approvalRevision = approval.revision;
        let found = false;
        for (const work of initialSnapshot.works) {
          const current = work.approvals.find((candidate) => candidate.id === approval.id);
          if (!current) continue;
          if (current.revision !== approvalRevision) throw new Error("Fixture 승인 revision 충돌입니다");
          found = true;
          mutateWork(work.id, (candidate) => ({
            ...candidate,
            revision: candidate.revision + 1,
            approvals: candidate.approvals.map((item) =>
              item.id === approval.id
                ? { ...item, status: vote === "approve" ? "approved" : "rejected", revision: approvalRevision + 1 }
                : item,
            ),
          }));
          break;
        }
        if (!found) throw new Error("Fixture 승인 요청을 찾을 수 없습니다");
        return {
          approvalId: approval.id,
          status: vote === "approve" ? "approved" : "rejected",
          revision: approvalRevision + 1,
        };
      }),
    /* ApplicationRunStore.cancel: status 'cancelled', stage 'terminal', approvalId 해제. */
    cancelRun: (work) =>
      fixturePromise(() => {
        let executionId: string | undefined;
        mutateWork(work.id, (current) => {
          const run = requireRun(current);
          executionId = current.activeExecutionId;
          const cancelled = { ...current };
          delete cancelled.activeExecutionId;
          return {
            ...cancelled,
            status: "cancelled",
            sourceStatus: "cancelled",
            run: {
              runId: run.runId,
              status: "cancelled",
              stage: "terminal",
              leaseGeneration: run.leaseGeneration,
              ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
            },
          };
        });
        if (executionId !== undefined) completionPending.delete(executionId);
      }),
    /* CoreWorkCoordinator.retryBlocked: claim(blocked 해제·lease +1) 뒤 advance(다음 단계·status 'ready'). */
    resumeRun: (work) =>
      fixturePromise(() => {
        mutateWork(work.id, (current) => {
          const run = requireRun(current);
          if (run.status !== "blocked") throw new Error("차단된 실행만 다시 시도할 수 있습니다");
          const following = FIXTURE_RUN_STAGES[FIXTURE_RUN_STAGES.indexOf(run.stage) + 1] ?? "terminal";
          return {
            ...current,
            run: {
              runId: run.runId,
              status: following === "terminal" ? "completed" : "ready",
              stage: following,
              leaseGeneration: run.leaseGeneration + 1,
            },
          };
        });
      }),
    startWork: (input) =>
      fixturePromise(() => {
        const sequence = ++runSequence;
        const suffix = String(sequence).padStart(4, "0");
        const workId = `work-fixture-${suffix}`;
        const runId = `run-fixture-${suffix}`;
        const executionId = `execution-fixture-${suffix}`;
        initialSnapshot.works.push({
          id: workId,
          ...(input.workspaceId === undefined ? {} : { workspace: { name: input.workspaceId, trusted: true } }),
          title: input.text,
          status: "active",
          revision: 1,
          sourceStatus: "running",
          team: input.workspaceId === undefined ? "Massion" : "워크스페이스",
          updatedAt: "방금",
          summary: input.text,
          progress: 0,
          run: { runId, status: "ready", stage: "intake", leaseGeneration: 0 },
          activeExecutionId: executionId,
          approvals: [],
          tasks: [{ id: `task-fixture-${suffix}`, title: "요청 분석", state: "active" }],
          agents: [{ id: "representative", role: "대표", name: "Atlas", initials: "A", state: "active" }],
          artifacts: [],
          verifications: [],
          records: [],
          activities: [
            {
              id: `request-fixture-${suffix}`,
              kind: "message",
              time: "방금",
              author: "사용자",
              initials: "U",
              human: true,
              content: input.text,
            },
          ],
        });
        executionHistory.set(executionId, { workId, runId, deltas: [], completed: false });
        publishDurable("run.started", { type: "ApplicationRun", id: runId, revision: 0 }, { stage: "intake" });
        publishDurable("work.created", { type: "Work", id: workId, revision: 1 }, { domainSequence: 1 });
        publishExecution(executionId, "started");
        if ((executionHandlers.get(executionId)?.size ?? 0) > 0) scheduleCompletion(executionId);
        return { runId };
      }),
    subscribeDurable: (handler) =>
      fixturePromise(() => {
        durableHandlers.add(handler);
        return stop(durableHandlers, handler);
      }),
    subscribeExecution: (executionId, handler) =>
      fixturePromise(() => {
        const handlers = executionHandlers.get(executionId) ?? new Map<DesktopStreamHandler, number>();
        handlers.set(handler, 0);
        executionHandlers.set(executionId, handlers);
        const history = executionHistory.get(executionId);
        if (history) {
          queueMicrotask(() => {
            if (!handlers.has(handler)) return;
            for (const delta of history.deltas) deliverExecution(handlers, handler, delta);
            scheduleCompletion(executionId);
          });
        }
        return () => {
          handlers.delete(handler);
          if (handlers.size === 0 && executionHandlers.get(executionId) === handlers)
            executionHandlers.delete(executionId);
          return Promise.resolve();
        };
      }),
  };
}

function safeView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeView);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      /(?:secret|token|password|api[-_]?key)/i.test(key) ? [] : [[key, safeView(child)]],
    ),
  );
}

function workspaceView(value: unknown): DesktopWorkspaceView {
  const workspace = object(value);
  if (
    typeof workspace?.workspaceId !== "string" ||
    typeof workspace.name !== "string" ||
    typeof workspace.path !== "string" ||
    workspace.kind !== "local-directory" ||
    (workspace.trust !== "pending" && workspace.trust !== "trusted" && workspace.trust !== "blocked") ||
    (workspace.status !== "active" && workspace.status !== "archived") ||
    typeof workspace.revision !== "number" ||
    typeof workspace.createdAt !== "string" ||
    typeof workspace.lastUsedAt !== "string"
  )
    throw new Error("Workspace 응답이 유효하지 않습니다");
  return workspace as unknown as DesktopWorkspaceView;
}

function projectOrganization(snapshot: Partial<OrganizationGraphSnapshotV1>): OrganizationView {
  return {
    ...(snapshot.version === undefined ? {} : { version: snapshot.version.version }),
    nodes: (snapshot.nodes ?? []).map((node) => ({
      id: node.node_id,
      handle: node.handle,
      name: node.name,
      responsibility: node.responsibility,
      ...(node.parent_handle === undefined ? {} : { parentHandle: node.parent_handle }),
      status: node.status,
      role: node.role,
      capabilities: node.capabilities,
      scope: node.scope,
      builtin: node.builtin,
      ...(node.work_id === undefined ? {} : { workId: node.work_id }),
    })),
  };
}

// ── 협업방 투영 ────────────────────────────────────────────────────
//
// 도메인이 실제로 가진 것만 옮깁니다. 없는 것은 지어내지 않습니다.
//   있음: messageType · authorId(handle) · content · createdAt · replyTo · causedBy · sequence
//   없음: question의 수신자. handoff 수신자는 새 메시지부터 recipientAgentId로 구조화합니다.

/** 조직 노드에서 역할 배지 문구를 찾습니다. snapshot 경합 중인 노드는 일반 역할로 가립니다. */
function roleLabelFor(handle: string, nodes: readonly OrganizationNodeView[]): string {
  const node = nodes.find((candidate) => candidate.handle === handle);
  if (!node) return "작업 담당";
  const label = node.responsibility.split(",")[0]?.trim() || node.name;
  if (node.scope === "work" && /^Work task .+ 실행$/u.test(label)) return "전문 작업 실행";
  return OPAQUE_UUID.test(label) ? "작업 담당" : label;
}

const OPAQUE_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

type SpeakerSource = Pick<RoomMessageViewV1, "authorKind" | "authorId"> & {
  readonly providerId?: string;
  readonly modelId?: string;
};

function speakerFor(message: SpeakerSource, nodes: readonly OrganizationNodeView[]): SpeakerView {
  if (message.authorKind !== "agent") {
    return { handle: message.authorId, name: "나", initial: "나", accentSlot: -1, role: "사람", human: true };
  }
  const role = roleLabelFor(message.authorId, nodes);
  const identity = agentIdentityToken(message.authorId, role);
  const node = nodes.find((candidate) => candidate.handle === message.authorId);
  return {
    handle: identity.handle,
    name: identity.name,
    initial: identity.initial,
    accentSlot: identity.accentSlot,
    role,
    // 조직 그래프에 없는 handle이 말하고 있으면 아직 승인되지 않았거나 scope:"work" 노드입니다.
    ...(node ? {} : { provisional: true }),
    ...(typeof message.providerId === "string" && message.providerId ? { providerId: message.providerId } : {}),
    ...(typeof message.modelId === "string" && message.modelId ? { modelId: message.modelId } : {}),
  };
}

function clockOf(createdAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(createdAt)) return createdAt;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toTimeString().slice(0, 5);
}

function handoffDisplay(
  content: string,
  nodes: readonly OrganizationNodeView[],
): { readonly content?: string; readonly recipientAgentId?: string } {
  try {
    const parsed = object(JSON.parse(content));
    if (!parsed) return {};
    // 구조화 handoff는 다음 Agent의 실행 입력입니다. 사람용 대화 본문으로 투영하지 않습니다.
    return typeof parsed.handoffTo === "string" &&
      parsed.handoffTo.length > 0 &&
      nodes.some((node) => node.handle === parsed.handoffTo)
      ? { recipientAgentId: parsed.handoffTo }
      : {};
  } catch {
    return { content };
  }
}

/** fixture 조직. Core Office 일부만 둡니다. 실 daemon에서는 organization.graph.snapshot이 대체합니다. */
/**
 * Core Office 8팀. `packages/organization/src/organization.ts`의 내장 노드와 같은 집합이며
 * `parentHandle`이 있어야 화면이 계층으로 그립니다. 이전에는 다섯 개였고 부모가 없어
 * 조직도가 평평했습니다 — 조직 화면인데 누가 누구 아래인지 보이지 않았습니다.
 *
 * name은 도메인 노드 이름 그대로 둡니다. 화면에 나오는 이름은 agentIdentityToken이 소유합니다.
 */
const fixtureOrganizationNodes: OrganizationNodeView[] = [
  {
    id: "representative",
    handle: "representative",
    builtin: true,
    name: "Representative",
    responsibility: "사용자 요청 접수, 조정, 최종 응답",
    status: "active",
    role: "orchestrator",
    capabilities: ["request-coordination"],
    scope: "persistent",
  },
  {
    id: "context-strategy",
    handle: "context-strategy",
    builtin: true,
    name: "Context & Strategy",
    parentHandle: "representative",
    responsibility: "맥락 구성, 계획, 위험 분석",
    status: "active",
    role: "operator",
    capabilities: ["context-strategy"],
    scope: "persistent",
  },
  {
    id: "evidence-research",
    handle: "evidence-research",
    builtin: true,
    name: "Evidence & Research",
    parentHandle: "representative",
    responsibility: "근거 조사, 출처 검증",
    status: "active",
    role: "operator",
    capabilities: ["evidence-research"],
    scope: "persistent",
  },
  {
    id: "governance",
    handle: "governance",
    builtin: true,
    name: "Governance",
    parentHandle: "representative",
    responsibility: "실행·조직·Extension·자기수정 정책과 승인",
    status: "active",
    role: "operator",
    capabilities: ["governance"],
    scope: "persistent",
  },
  {
    id: "delivery-coordination",
    handle: "delivery-coordination",
    builtin: true,
    name: "Delivery Coordination",
    parentHandle: "representative",
    responsibility: "Task 배정, 전문 팀 실행 조정, 결과 통합",
    status: "active",
    role: "coordinator",
    capabilities: ["delivery-coordination"],
    scope: "persistent",
  },
  {
    id: "assurance",
    handle: "assurance",
    builtin: true,
    name: "Assurance",
    parentHandle: "representative",
    responsibility: "독립 리뷰, 테스트·보안·운영 검증",
    status: "active",
    role: "operator",
    capabilities: ["assurance"],
    scope: "persistent",
  },
  {
    id: "records-documentation",
    handle: "records-documentation",
    builtin: true,
    name: "Records & Documentation",
    parentHandle: "representative",
    responsibility: "handoff·결정·계보 기록, 문서 영향 반영",
    status: "active",
    role: "operator",
    capabilities: ["records-documentation"],
    scope: "persistent",
  },
  {
    id: "growth",
    handle: "growth",
    builtin: true,
    name: "Growth",
    parentHandle: "representative",
    responsibility: "Reflection, 개선안 평가·채택·효과 비교·되돌리기",
    status: "active",
    role: "operator",
    capabilities: ["growth"],
    scope: "persistent",
  },
  // scope:"work"로 편성된 임시 팀. 승인되면 조직에 잠시 존재하고 업무가 끝나면 사라집니다.
  {
    id: "quant-analysis",
    handle: "quant-analysis",
    builtin: false,
    name: "계량분석 팀",
    parentHandle: "delivery-coordination",
    responsibility: "코호트 정규화, 유의성 검정, 시계열 분해",
    status: "active",
    role: "operator",
    capabilities: ["quant-analysis"],
    scope: "work",
  },
  // Software Engineering 프로필(persistent). 설치 함수는 있으나 생산 Bootstrap 호출이 없어(헌법 9.2)
  // 실 조직은 Core Office 8로 평평합니다. 완성본 기준으로 편성된 조직의 실제 깊이를 보이려 넣습니다.
  {
    id: "software-engineering",
    handle: "software-engineering",
    builtin: false,
    name: "Software Engineering",
    parentHandle: "delivery-coordination",
    responsibility: "개발 Task 분해, 전문 역할 조정과 변경 통합",
    status: "active",
    role: "coordinator",
    capabilities: ["software-delivery"],
    scope: "persistent",
  },
  {
    id: "se-lead",
    handle: "software-engineering.engineering-lead",
    builtin: false,
    name: "Engineering Lead",
    parentHandle: "software-engineering",
    responsibility: "개발 Task 분해, 경로 충돌 조정과 기술 통합 판정",
    status: "active",
    role: "coordinator",
    capabilities: ["engineering-lead"],
    scope: "persistent",
  },
  {
    id: "se-fe",
    handle: "software-engineering.frontend-specialist",
    builtin: false,
    name: "Frontend Specialist",
    parentHandle: "software-engineering",
    responsibility: "Web 인터페이스와 클라이언트 동작 구현",
    status: "active",
    role: "operator",
    capabilities: ["frontend-engineering"],
    scope: "persistent",
  },
  {
    id: "se-be",
    handle: "software-engineering.backend-specialist",
    builtin: false,
    name: "Backend Specialist",
    parentHandle: "software-engineering",
    responsibility: "서비스, API와 서버 애플리케이션 구현",
    status: "active",
    role: "operator",
    capabilities: ["backend-engineering"],
    scope: "persistent",
  },
  {
    id: "se-db",
    handle: "software-engineering.database-specialist",
    builtin: false,
    name: "Database Specialist",
    parentHandle: "software-engineering",
    responsibility: "데이터 모델, 질의와 마이그레이션 구현",
    status: "active",
    role: "operator",
    capabilities: ["database-engineering"],
    scope: "persistent",
  },
  {
    id: "se-test",
    handle: "software-engineering.test-engineer",
    builtin: false,
    name: "Test Engineer",
    parentHandle: "software-engineering",
    responsibility: "실패 재현 테스트와 검증 시나리오 구현",
    status: "active",
    role: "operator",
    capabilities: ["test-engineering"],
    scope: "persistent",
  },
  {
    id: "se-sec",
    handle: "software-engineering.security-reviewer",
    builtin: false,
    name: "Security Reviewer",
    parentHandle: "software-engineering",
    responsibility: "코드 변경의 위협·권한·비밀정보 노출 검토",
    status: "active",
    role: "operator",
    capabilities: ["secure-coding-review"],
    scope: "persistent",
  },
];

export function projectRoomActivities(
  messages: readonly RoomMessageViewV1[],
  nodes: readonly OrganizationNodeView[],
  roomStatus?: string,
  finalResponse = roomStatus === "closed",
): ActivityView[] {
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence);
  const byId = new Map(ordered.map((message) => [message.messageId, message]));
  const lastMessageId = ordered.filter((message) => message.messageType !== "status").at(-1)?.messageId;

  return ordered.map((message): ActivityView => {
    const speaker = speakerFor(message, nodes);
    const time = clockOf(message.createdAt);

    if (message.messageType === "status") {
      return {
        id: message.messageId,
        kind: "roomStatus",
        time,
        occurredAt: message.createdAt,
        content: message.content,
      };
    }

    if (message.messageType === "handoff") {
      const display = handoffDisplay(message.content, nodes);
      const recipientAgentId =
        message.recipientAgentId === undefined ? display.recipientAgentId : message.recipientAgentId;
      return {
        id: message.messageId,
        kind: "handoff",
        time,
        occurredAt: message.createdAt,
        from: speaker,
        ...(display.content === undefined ? {} : { content: display.content }),
        ...(recipientAgentId === undefined
          ? {}
          : { to: speakerFor({ authorKind: "agent", authorId: recipientAgentId }, nodes) }),
      };
    }

    const proposal = message.messageType === "proposal" ? message.staffingProposal : undefined;
    if (proposal !== undefined) {
      return {
        id: message.messageId,
        kind: "proposal",
        time,
        occurredAt: message.createdAt,
        speaker,
        content: `Work에 필요한 전문 Agent ${String(proposal.nodes.length)}명을 구성하고 배치를 완료했습니다.`,
        decided: true,
        ...(proposal.approvalId === undefined ? {} : { approvalId: proposal.approvalId }),
        change: {
          nodes: proposal.nodes.map((node) => ({
            handle: node.handle,
            name: agentIdentityToken(node.handle).name,
            scope: node.scope,
            workId: node.workId,
            parentHandle: node.parentHandle,
            role: node.role,
            capabilities: [...node.capabilities],
          })),
          impactNodes: proposal.impactNodeHandles.length,
          impactReferences: proposal.impactReferenceCount,
          impactHandles: [...proposal.impactNodeHandles],
          fromVersion: proposal.fromOrganizationVersion,
          toVersion: proposal.toOrganizationVersion,
        },
      };
    }

    const origin = message.replyToMessageId === undefined ? undefined : byId.get(message.replyToMessageId);

    return {
      id: message.messageId,
      kind: "room",
      time,
      occurredAt: message.createdAt,
      messageType: message.messageType === "proposal" ? "decision" : (message.messageType as "question"),
      speaker,
      content: message.content,
      ...(finalResponse &&
      message.messageId === lastMessageId &&
      message.messageType === "answer" &&
      message.authorKind === "agent" &&
      message.authorId === "representative"
        ? { final: true }
        : {}),
      // 답변은 질문 아래 들여써서 짝을 눈에 보이게 합니다.
      ...(message.messageType === "answer" && origin ? { indented: true } : {}),
      // 반론은 무엇에 대한 반론인지 없이 존재할 수 없습니다.
      ...(message.messageType === "challenge" && origin
        ? {
            quoted: {
              author: speakerFor(origin, nodes).name,
              time: clockOf(origin.createdAt),
              content: origin.content,
            },
          }
        : {}),
    };
  });
}

/** 한도가 없는 항목은 목록에 넣지 않습니다. 0/0 막대는 정보가 아니라 소음입니다. */
export function projectRoomBudgets(room: RoomViewV1): RoomBudgetView[] {
  const budgets: RoomBudgetView[] = [];
  if (room.maxRounds !== undefined) {
    const used = room.roundCount ?? 0;
    budgets.push({
      label: "라운드",
      used,
      limit: room.maxRounds,
      display: `${String(used)} / ${String(room.maxRounds)}`,
    });
  }
  if (room.maxTokens !== undefined) {
    const used = room.usedTokens ?? 0;
    budgets.push({
      label: "토큰",
      used,
      limit: room.maxTokens,
      display: `${compactCount(used)} / ${compactCount(room.maxTokens)}`,
    });
  }
  if (room.maxCostMicros !== undefined) {
    const used = room.usedCostMicros ?? 0;
    budgets.push({
      label: "비용",
      used,
      limit: room.maxCostMicros,
      display: `$${(used / 1_000_000).toFixed(2)} / $${(room.maxCostMicros / 1_000_000).toFixed(2)}`,
    });
  }
  return budgets;
}

function compactCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * 하위 방을 대표 방 타임라인에 인라인 참조로 끼워 넣습니다.
 * 위치는 그 방의 첫 발언 시각에서 파생합니다. 도메인에 부모-자식 관계가 없으므로 만들어내지 않습니다.
 */
export function withRoomReferences(rooms: readonly RoomView[]): RoomView[] {
  const [main, ...others] = rooms;
  if (!main || others.length === 0) return [...rooms];

  const references: ActivityView[] = others.map((room) => {
    const occurredAt = room.activities[0]?.occurredAt;
    const last = room.activities.at(-1);
    return {
      id: `roomref:${room.roomId}`,
      kind: "roomRef",
      time: room.activities[0]?.time ?? "",
      roomId: room.roomId,
      name: room.name,
      participants: room.participants,
      messageCount: room.activities.length,
      lastLine: last && "content" in last ? last.content : `${String(room.activities.length)}개의 발언`,
      waiting: room.activities.some((activity) => activity.kind === "proposal" || activity.kind === "approval"),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  });

  const merged = [...main.activities, ...references].sort((left, right) => {
    if (left.occurredAt !== undefined && right.occurredAt !== undefined)
      return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
    if (left.occurredAt !== undefined) return -1;
    if (right.occurredAt !== undefined) return 1;
    return left.time.localeCompare(right.time) || left.id.localeCompare(right.id);
  });
  return [{ ...main, activities: merged }, ...others];
}

export function projectRoom(
  room: RoomViewV1,
  messages: readonly RoomMessageViewV1[],
  nodes: readonly OrganizationNodeView[],
  sharedContexts: readonly SharedContextViewV1[] = [],
  workStatus?: string,
): RoomView {
  const finalResponseRoom =
    workStatus === "completed" && room.name === "Core Office" && room.coordinatorHandle === "representative";
  return {
    roomId: room.roomId,
    name: room.name,
    status: room.status,
    participants: (
      room.participants ?? room.participantIds.map((subjectId) => ({ subjectId, kind: "agent" as const }))
    ).map((participant) => speakerFor({ authorKind: participant.kind, authorId: participant.subjectId }, nodes)),
    lastMessageSequence: room.lastMessageSequence,
    budgets: projectRoomBudgets(room),
    sharedContexts: sharedContexts
      .filter((reference) => reference.roomId === room.roomId)
      .map((reference) => ({
        id: reference.sharedContextReferenceId,
        label: `${reference.sourceKind} · ${reference.sourceId}`,
        checksum: reference.checksum.slice(0, 6),
      })),
    activities: projectRoomActivities(messages, nodes, room.status, finalResponseRoom),
  };
}

function projectGrowthConfiguration(value: unknown):
  | {
      readonly reflectionEnabled: boolean;
      readonly adoptionMode: GrowthAdoptionMode;
      readonly version?: number;
    }
  | undefined {
  if (value === undefined) return undefined;
  const source = object(value);
  if (
    typeof source?.reflectionEnabled !== "boolean" ||
    (source.adoptionMode !== "review" && source.adoptionMode !== "auto") ||
    (source.version !== undefined &&
      (typeof source.version !== "number" || !Number.isSafeInteger(source.version) || source.version < 1))
  )
    throw new Error("자가개선 설정 응답이 유효하지 않습니다");
  return {
    reflectionEnabled: source.reflectionEnabled,
    adoptionMode: source.adoptionMode,
    ...(source.version === undefined ? {} : { version: source.version }),
  };
}

function projectAutonomy(
  value: GovernanceAutonomyViewV1 | Record<string, unknown> | undefined,
  growthConfiguration?: ReturnType<typeof projectGrowthConfiguration>,
): AutonomyView {
  if (
    !value ||
    (value.mode !== "automatic" && value.mode !== "review" && value.mode !== "full-access") ||
    typeof value.revision !== "number"
  )
    throw new Error("자율성 설정 응답이 유효하지 않습니다");
  const source = value as Record<string, unknown>;
  const runtimePermissionStatus =
    source.runtimePermissionStatus === "limited" || source.runtimePermissionStatus === "full-access"
      ? source.runtimePermissionStatus
      : value.mode === "full-access"
        ? "full-access"
        : "governed";
  return {
    mode: value.mode,
    revision: value.revision,
    runtimePermissionStatus,
    ...(typeof source.permissionLimitReason === "string"
      ? { permissionLimitReason: source.permissionLimitReason }
      : {}),
    ...(growthConfiguration === undefined
      ? source.growthMode === "review" || source.growthMode === "auto"
        ? { growthMode: source.growthMode }
        : {}
      : {
          growthMode: growthConfiguration.adoptionMode,
          growthReflectionEnabled: growthConfiguration.reflectionEnabled,
          ...(growthConfiguration.version === undefined
            ? {}
            : { growthConfigurationVersion: growthConfiguration.version }),
        }),
    emergencyStopActive: source.emergencyStopActive === true,
  };
}

function projectEmergency(value: unknown): EmergencyView {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!source || typeof source.active !== "boolean" || !Number.isSafeInteger(source.revision)) {
    return { active: false, revision: 0 };
  }
  return {
    active: source.active,
    revision: source.revision as number,
    ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
    ...(typeof source.approvalId === "string" ? { approvalId: source.approvalId } : {}),
  };
}

function projectExtension(extension: ExtensionInstallationViewV1): ExtensionView {
  return {
    id: extension.installationId,
    packageName: extension.packageName,
    status: extension.state,
    ...(extension.activeVersionId === undefined ? {} : { activeVersionId: extension.activeVersionId }),
    activationGeneration: extension.activationGeneration,
    contributions: extension.contributions,
    permissions: extension.permissions,
  };
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return source.flatMap((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : [],
  );
}

const str = (row: Record<string, unknown>, key: string): string => (typeof row[key] === "string" ? row[key] : "");
const num = (row: Record<string, unknown>, key: string): number => (typeof row[key] === "number" ? row[key] : 0);
const bool = (row: Record<string, unknown>, key: string): boolean => row[key] === true;

function routeAttemptRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Route Attempt 응답은 배열이어야 합니다");
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Route Attempt 응답 행이 유효하지 않습니다");
    return row as Record<string, unknown>;
  });
}

function routeAttemptString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`Route Attempt ${key}가 유효하지 않습니다`);
  return value;
}

function routeAttemptOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === undefined ? undefined : routeAttemptString(row, key);
}

function routeAttemptNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Route Attempt ${key}가 유효하지 않습니다`);
  return value as number;
}

function routeAttemptOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  return row[key] === undefined ? undefined : routeAttemptNumber(row, key);
}

const ROUTE_ATTEMPT_INSTANT =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

function routeAttemptInstant(row: Record<string, unknown>): string {
  const value = routeAttemptString(row, "at");
  const parsed = new Date(value);
  if (!ROUTE_ATTEMPT_INSTANT.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    throw new Error("Route Attempt at이 유효하지 않습니다");
  return value;
}

/*
 * 최근 것이 먼저입니다. `attempt-cohort-2`는 `attempt-cohort-1`이 quota로 막혀 넘어온 시도라
 * 사슬로 붙습니다 — 「막혔다」가 아니라 「막혀서 어디로 갔다」가 보여야 합니다.
 */

export function projectRouteAttempts(value: unknown): readonly RouteAttemptView[] {
  return routeAttemptRows(value).map((row) => {
    const at = routeAttemptInstant(row);
    const status = routeAttemptString(row, "status");
    if (status !== "succeeded" && status !== "failed" && status !== "interrupted" && status !== "running")
      throw new Error("Route Attempt status가 유효하지 않습니다");
    const executionId = routeAttemptOptionalString(row, "executionId");
    const optimizationRunId = routeAttemptOptionalString(row, "optimizationRunId");
    const optimizationBatchId = routeAttemptOptionalString(row, "optimizationBatchId");
    const statusCode = routeAttemptOptionalNumber(row, "statusCode");
    const durationMs = routeAttemptOptionalNumber(row, "durationMs");
    const failureClass = routeAttemptOptionalString(row, "failureClass");
    const effort = routeAttemptOptionalString(row, "effort");
    const fallbackFrom = routeAttemptOptionalString(row, "fallbackFrom");
    const workId = routeAttemptOptionalString(row, "workId");
    const workTitle = routeAttemptOptionalString(row, "workTitle");
    // 등록이 제거된 Provider의 과거 호출에는 모델·프로바이더 이름이 없습니다. 계보 정본인
    // modelProfileId만 남으므로 여기서 던지지 않고 그대로 옮깁니다 — 화면이 등록 제거를 말합니다.
    const modelId = routeAttemptOptionalString(row, "modelId");
    const providerId = routeAttemptOptionalString(row, "providerId");
    return {
      attemptId: routeAttemptString(row, "attemptId"),
      at,
      routeId: routeAttemptString(row, "routeId"),
      modelProfileId: routeAttemptString(row, "modelProfileId"),
      ...(modelId === undefined ? {} : { modelId }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(executionId === undefined ? {} : { executionId }),
      ...(optimizationRunId === undefined ? {} : { optimizationRunId }),
      ...(optimizationBatchId === undefined ? {} : { optimizationBatchId }),
      status,
      inputTokens: routeAttemptNumber(row, "inputTokens"),
      outputTokens: routeAttemptNumber(row, "outputTokens"),
      cacheReadTokens: routeAttemptNumber(row, "cacheReadTokens"),
      cacheWriteTokens: routeAttemptNumber(row, "cacheWriteTokens"),
      reasoningTokens: routeAttemptNumber(row, "reasoningTokens"),
      costMicros: routeAttemptNumber(row, "costMicros"),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(failureClass === undefined ? {} : { failureClass }),
      ...(effort === undefined ? {} : { effort }),
      ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
      ...(workId === undefined ? {} : { workId }),
      ...(workTitle === undefined ? {} : { workTitle }),
    };
  });
}

export function projectModelRoutes(routes: unknown, catalog: unknown): readonly ModelRouteView[] {
  const source = catalog && typeof catalog === "object" ? (catalog as Record<string, unknown>) : {};
  const candidates = rows(source.candidates);
  const models = rows(source.models);
  const endpoints = rows(source.endpoints);
  // circuit이 열린 Provider의 후보는 지금 건너뛰어집니다. 목록에서 지우지 않고 «건너뜀»으로 보입니다.
  const openCircuits = new Set(
    rows(source.circuits)
      .filter((row) => str(row, "state") === "open")
      .map((row) => str(row, "providerId")),
  );
  return rows(routes)
    .filter((row) => typeof row.routeId === "string")
    .map((row) => {
      const mine = candidates
        .filter((candidate) => str(candidate, "routeId") === str(row, "routeId") && bool(candidate, "enabled"))
        .sort((left, right) => num(left, "priority") - num(right, "priority"));
      // 후보가 여럿이어도 실제로 먼저 불리는 것은 우선순위 0입니다. 화면은 그 하나를 말합니다.
      const primary = models.find((model) => str(model, "modelProfileId") === str(mine[0] ?? {}, "modelProfileId"));
      const endpoint = primary
        ? endpoints.find((item) => str(item, "endpointId") === str(primary, "endpointId"))
        : undefined;
      return {
        routeId: str(row, "routeId"),
        name: str(row, "name"),
        routeKind: str(row, "routeKind"),
        enabled: bool(row, "enabled"),
        spentMicros: num(row, "spentMicros"),
        totalBudgetMicros: num(row, "totalBudgetMicros"),
        requestBudgetMicros: num(row, "requestBudgetMicros"),
        candidateCount: mine.length,
        ...(primary === undefined ? {} : { primaryModelId: str(primary, "modelId") }),
        ...(primary === undefined ? {} : { primaryVerified: bool(primary, "verified") }),
        ...(endpoint === undefined ? {} : { primaryLocal: bool(endpoint, "local") }),
        candidates: mine.flatMap((candidate): ModelRouteCandidateView[] => {
          const model = models.find((item) => str(item, "modelProfileId") === str(candidate, "modelProfileId"));
          if (!model) return [];
          const modelEndpoint = endpoints.find((item) => str(item, "endpointId") === str(model, "endpointId"));
          const providerId = modelEndpoint ? str(modelEndpoint, "providerId") : "";
          const circuit = openCircuits.has(providerId);
          return [
            {
              modelId: str(model, "modelId"),
              providerId,
              local: modelEndpoint ? bool(modelEndpoint, "local") : false,
              verified: bool(model, "verified"),
              ...(circuit ? { blocked: true } : {}),
            },
          ];
        }),
      };
    });
}

const CIRCUIT_STATES = new Set<ProviderCircuitState>(["closed", "half-open", "open"]);
const FAILURE_CLASSES = new Set(["authentication", "rate-limit", "timeout", "network", "server", "unknown"]);

/**
 * `router.circuit` 행을 상태로 좁힙니다. 상태를 모르는 것과 성한 것은 다른 사실이므로
 * 알아볼 수 없는 행은 `closed`로 채우지 않고 통째로 버립니다.
 */
function projectProviderHealth(row: Record<string, unknown> | undefined): ProviderHealthView | undefined {
  if (!row) return undefined;
  const state = row.state;
  if (typeof state !== "string" || !CIRCUIT_STATES.has(state as ProviderCircuitState)) return undefined;
  const failureClass = typeof row.lastFailureClass === "string" ? row.lastFailureClass : undefined;
  return {
    state: state as ProviderCircuitState,
    failureCount: typeof row.failureCount === "number" && Number.isSafeInteger(row.failureCount) ? row.failureCount : 0,
    ...(typeof row.openUntil === "string" ? { openUntil: row.openUntil } : {}),
    ...(failureClass !== undefined && FAILURE_CLASSES.has(failureClass)
      ? { lastFailureClass: failureClass as NonNullable<ProviderHealthView["lastFailureClass"]> }
      : {}),
    ...(typeof row.lastSucceededAt === "string" ? { lastSucceededAt: row.lastSucceededAt } : {}),
  };
}

/**
 * 키 한 줄로 연결되는 Provider만 화면이 입력을 요청합니다. 어떤 키인지까지 실어야
 * 호출부가 providerId로 다시 분기하지 않습니다.
 */
function keyAuthKind(row: Record<string, unknown>): "api-key" | "subscription-key" | undefined {
  const kinds = Array.isArray(row.authKinds) ? row.authKinds : [];
  if (kinds.includes("api-key")) return "api-key";
  if (kinds.includes("subscription-key")) return "subscription-key";
  return undefined;
}

function projectProviderCatalogStatus(row: Record<string, unknown> | undefined): ProviderCatalogStatusView | undefined {
  if (!row) return undefined;
  const status = row.status;
  if (!["syncing", "available", "empty", "partial", "degraded"].includes(String(status))) return undefined;
  const activeCount = row.activeCount;
  const invalidCount = row.invalidCount;
  const duplicateCount = row.duplicateCount;
  const lastAttemptedAt = row.lastAttemptedAt;
  if (
    !Number.isSafeInteger(activeCount) ||
    Number(activeCount) < 0 ||
    !Number.isSafeInteger(invalidCount) ||
    Number(invalidCount) < 0 ||
    !Number.isSafeInteger(duplicateCount) ||
    Number(duplicateCount) < 0 ||
    typeof lastAttemptedAt !== "string"
  ) {
    return undefined;
  }
  return {
    status: status as ProviderCatalogStatusView["status"],
    activeCount: Number(activeCount),
    invalidCount: Number(invalidCount),
    duplicateCount: Number(duplicateCount),
    lastAttemptedAt,
    ...(typeof row.diagnosticReason === "string" ? { diagnosticReason: row.diagnosticReason } : {}),
    ...(typeof row.retryAt === "string" ? { retryAt: row.retryAt } : {}),
    ...(typeof row.lastSuccessfulAt === "string" ? { lastSuccessfulAt: row.lastSuccessfulAt } : {}),
  };
}

export function projectProviderConnections(
  catalog: unknown,
  providers?: unknown,
  registeredCredentials?: unknown,
): readonly ProviderConnectionView[] {
  const source = catalog && typeof catalog === "object" ? (catalog as Record<string, unknown>) : {};
  const endpoints = rows(source.endpoints);
  const circuits = rows(source.circuits);
  const evidence = rows(source.verificationEvidence);
  // router.catalog는 자격을 담지 않습니다. router.credentials가 정본이고, 없을 때만 catalog를 봅니다.
  const credentials = registeredCredentials === undefined ? rows(source.credentials) : rows(registeredCredentials);
  const models = rows(source.models);
  const discoveredModels = rows(source.discoveredModels);
  const catalogStatuses = rows(source.catalogStatuses);
  const connections = rows(source.providers)
    .filter((row) => typeof row.providerId === "string")
    .map((row) => {
      const providerId = str(row, "providerId");
      const providerEndpoints = endpoints.filter(
        (endpoint) => str(endpoint, "providerId") === providerId && str(endpoint, "endpointId") !== "",
      );
      const providerModels = models.filter((item) => str(item, "providerId") === providerId);
      const providerDiscoveredModels = discoveredModels.filter((item) => str(item, "providerId") === providerId);
      const health = projectProviderHealth(circuits.find((item) => str(item, "providerId") === providerId));
      const verified = evidence.filter((item) => str(item, "providerId") === providerId);
      const providerCredentials = credentials.filter((item) => str(item, "providerId") === providerId);
      const verifiedAt = verified
        .map((item) => str(item, "verifiedAt"))
        .filter(Boolean)
        .sort()
        .at(-1);
      const projectedModels = new Map<string, ProviderModelView>();
      for (const item of providerDiscoveredModels) {
        const endpointId = str(item, "endpointId");
        const modelId = str(item, "modelId");
        if (modelId === "" || (item.state !== "active" && item.state !== "stale")) continue;
        const modelEndpoint = providerEndpoints.find((endpoint) => str(endpoint, "endpointId") === endpointId);
        if (!modelEndpoint) continue;
        const optionalNumber = (key: string): number | undefined =>
          typeof item[key] === "number" && Number.isSafeInteger(item[key]) && item[key] >= 0 ? item[key] : undefined;
        projectedModels.set(`${endpointId}\0${modelId}`, {
          ...(typeof item.catalogEntryId === "string" ? { catalogEntryId: item.catalogEntryId } : {}),
          endpointId,
          modelId,
          routeKind: "",
          enabled: false,
          verified: false,
          discovered: true,
          catalogState: item.state,
          ...(optionalNumber("contextWindow") === undefined
            ? {}
            : { contextWindow: optionalNumber("contextWindow") as number }),
          ...(typeof item.supportsTools === "boolean" ? { supportsTools: item.supportsTools } : {}),
          ...(typeof item.supportsStructuredOutput === "boolean"
            ? { supportsStructuredOutput: item.supportsStructuredOutput }
            : {}),
          ...(typeof item.supportsVision === "boolean" ? { supportsVision: item.supportsVision } : {}),
          ...(optionalNumber("inputCostMicrosPerMillion") === undefined
            ? {}
            : { inputCostMicrosPerMillion: optionalNumber("inputCostMicrosPerMillion") as number }),
          ...(optionalNumber("outputCostMicrosPerMillion") === undefined
            ? {}
            : { outputCostMicrosPerMillion: optionalNumber("outputCostMicrosPerMillion") as number }),
          local: bool(modelEndpoint, "local"),
        });
      }
      for (const item of providerModels) {
        const endpointId = str(item, "endpointId");
        const modelId = str(item, "modelId");
        const modelProfileId = str(item, "modelProfileId");
        const modelEndpoint = providerEndpoints.find((endpoint) => str(endpoint, "endpointId") === endpointId);
        if (modelId === "" || modelProfileId === "" || !modelEndpoint) continue;
        const key = `${endpointId}\0${modelId}`;
        const discovered = projectedModels.get(key);
        projectedModels.set(key, {
          ...discovered,
          endpointId,
          modelProfileId,
          modelId,
          routeKind: str(item, "routeKind"),
          enabled: bool(item, "enabled"),
          verified: bool(item, "verified"),
          discovered: discovered !== undefined,
          local: bool(modelEndpoint, "local"),
        });
      }
      return {
        providerId,
        displayName: str(row, "displayName"),
        adapterKind: str(row, "adapterKind"),
        enabled: bool(row, "enabled"),
        connected: providerEndpoints.some((endpoint) => endpoint.enabled !== false),
        subscriptionConnectable: false,
        connectionConflict: false,
        endpoints: providerEndpoints.map((endpoint) => {
          const endpointId = str(endpoint, "endpointId");
          const catalogStatus = projectProviderCatalogStatus(
            catalogStatuses
              .filter((item) => str(item, "providerId") === providerId && str(item, "endpointId") === endpointId)
              .sort((left, right) => str(right, "lastAttemptedAt").localeCompare(str(left, "lastAttemptedAt")))[0],
          );
          return {
            endpointId,
            name: str(endpoint, "name"),
            baseUrl: str(endpoint, "baseUrl"),
            local: bool(endpoint, "local"),
            enabled: endpoint.enabled !== false,
            ...(catalogStatus ? { catalogStatus } : {}),
          };
        }),
        models: [...projectedModels.values()].sort(
          (left, right) =>
            Number(left.catalogState === "stale") - Number(right.catalogState === "stale") ||
            left.modelId.localeCompare(right.modelId),
        ),
        ...(health ? { health } : {}),
        ...(verified.length ? { verifiedModelCount: verified.length } : {}),
        ...(verifiedAt ? { verifiedAt } : {}),
        credentials: providerCredentials
          .filter((item) => typeof item.credentialId === "string")
          .map((item) => ({
            credentialId: str(item, "credentialId"),
            endpointId: str(item, "endpointId"),
            label: str(item, "label"),
            status: str(item, "status"),
            ...(typeof item.secretVersion === "number" ? { secretVersion: item.secretVersion } : {}),
            ...(typeof item.version === "number" ? { revision: item.version } : {}),
          })),
      };
    });
  // 지원 목록은 앱에 고정된 상수라 서버를 기다릴 이유가 없습니다. 연결 상태만 나중에 채웁니다.
  // 연결 경로가 없는 manifest는 고를 수 없으므로 제외합니다.
  // providers가 아직 오지 않은 첫 렌더에서만 상수를 씁니다. 빈 배열은 서버가 없다고 답한 것이므로 존중합니다.
  const connectable = (
    providers === undefined
      ? listSubscriptionProviderManifests().map((manifest) => ({
          providerId: manifest.id,
          displayName: manifest.displayName,
          connectionSurface: manifest.connectionSurface,
          authKinds: manifest.authKinds,
        }))
      : rows(providers).filter((row) => typeof row.providerId === "string")
  ).filter((row) => ["server-only", "server-and-edge"].includes(str(row, "connectionSurface")));
  const merged = connections.map((connection) => {
    const manifest = connectable.find((row) => str(row, "providerId") === connection.providerId);
    if (!manifest) return connection;
    return {
      ...connection,
      subscriptionConnectable: true,
      connectionConflict: connection.adapterKind !== "subscription-connector",
      ...(keyAuthKind(manifest) ? { keyAuthKind: keyAuthKind(manifest) as "api-key" | "subscription-key" } : {}),
    };
  });
  const offered = connectable
    .filter((row) => !merged.some((connection) => connection.providerId === str(row, "providerId")))
    .map((row) => ({
      providerId: str(row, "providerId"),
      displayName: str(row, "displayName") || str(row, "providerId"),
      adapterKind: "subscription-connector",
      enabled: true,
      connected: false,
      subscriptionConnectable: true,
      connectionConflict: false,
      endpoints: [],
      models: [],
      credentials: [],
      ...(keyAuthKind(row) ? { keyAuthKind: keyAuthKind(row) as "api-key" | "subscription-key" } : {}),
    }));
  return [...merged, ...offered].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function projectSubscriptionAccounts(accounts: unknown): readonly SubscriptionAccountView[] {
  // 식별자 없는 행은 계정이 아닙니다. 빈 값으로 채워 넣으면 없는 계정이 목록에 생깁니다.
  return rows(accounts)
    .filter((row) => typeof row.accountId === "string")
    .map((row) => ({
      accountId: str(row, "accountId"),
      providerId: str(row, "providerId"),
      alias: str(row, "alias"),
      status: str(row, "status"),
      billingKind: str(row, "billingKind"),
      ...(typeof row.version === "number" ? { accountVersion: row.version } : {}),
      ...(typeof row.quotaExhausted === "boolean" ? { quotaExhausted: row.quotaExhausted } : {}),
      ...(typeof row.minimumRemainingRatio === "number" ? { minimumRemainingRatio: row.minimumRemainingRatio } : {}),
      ...(typeof row.earliestResetAt === "string" ? { earliestResetAt: row.earliestResetAt } : {}),
      ...(typeof row.cooldownUntil === "string" ? { cooldownUntil: row.cooldownUntil } : {}),
    }));
}

const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "runtimeTools",
  "organizationTemplates",
  "skills",
  "surfaceConnectors",
  "growthSignals",
  "growthTargets",
  "eventConsumers",
  "modelEvaluationBundles",
];

const PERMISSION_KINDS: readonly PermissionKind[] = [
  "tools",
  "network",
  "files",
  "secrets",
  "process",
  "mcp",
  "storage",
  "events",
];

/** manifest의 선언을 뷰로 옮깁니다. 선언되지 않은 종류는 줄 자체를 만들지 않습니다. */
export function projectManifestDeclarations(
  manifest: unknown,
): Pick<ExtensionEntryView, "contributions" | "permissions"> {
  const source =
    manifest && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as Record<string, unknown>) : {};
  const read = (group: unknown, key: string): readonly string[] => {
    const value =
      group && typeof group === "object" && !Array.isArray(group) ? (group as Record<string, unknown>)[key] : undefined;
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : JSON.stringify(item),
      );
    }
    // storage처럼 배열이 아닌 선언은 존재 사실만 남깁니다. 원문을 그대로 흘리지 않습니다.
    return value && typeof value === "object" ? [""] : [];
  };
  return {
    contributions: CONTRIBUTION_KINDS.flatMap((kind) => {
      const items = read(source.contributions, kind);
      return items.length > 0 ? [{ kind, items }] : [];
    }),
    permissions: PERMISSION_KINDS.flatMap((kind) => {
      const items = read(source.permissions, kind);
      return items.length > 0 ? [{ kind, items }] : [];
    }),
  };
}

/** registry.inventory 응답을 뷰로 옮깁니다. 이미 설치된 패키지는 목록에서 뺍니다. */
export function marketplaceEntries(
  inventory: unknown,
  installedPackages: readonly string[],
): readonly ExtensionEntryView[] {
  const rows = Array.isArray(inventory)
    ? inventory
    : inventory && typeof inventory === "object" && Array.isArray((inventory as { items?: unknown }).items)
      ? (inventory as { items: unknown[] }).items
      : [];
  return rows
    .flatMap((row): ExtensionEntryView[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      if (typeof record.versionId !== "string" || typeof record.packageName !== "string") return [];
      if (installedPackages.includes(record.packageName)) return [];
      return [
        {
          id: record.versionId,
          packageName: record.packageName,
          version: typeof record.packageVersion === "string" ? record.packageVersion : "",
          description: typeof record.description === "string" ? record.description : "",
          provenance: typeof record.provenance === "string" ? record.provenance : "",
          installed: false,
          // manifest는 registry.info에만 있습니다. 선택할 때 채워집니다.
          ...projectManifestDeclarations(undefined),
        },
      ];
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

/**
 * 설치된 확장을 먼저, 마켓플레이스를 뒤에 둡니다. 헌법 6절의 "조직에 추가된 Capability를 먼저"는
 * 상세 안의 순서만이 아니라 목록의 순서이기도 합니다.
 */
export function projectExtensionEntries(
  installed: readonly ExtensionView[],
  inventory: unknown,
): readonly ExtensionEntryView[] {
  const entries = installed.map((item) => ({
    id: item.id,
    packageName: item.packageName,
    version: item.activeVersionId ?? "",
    description: "",
    provenance: "",
    installed: true,
    state: item.status,
    // 계약이 활성 version의 manifest 선언을 실어 줍니다. 예전에는 여기가 언제나 빈 배열이라
    // 헌법 6절의 「조직에 추가된 Capability를 먼저」가 설치된 확장에 대해 성립하지 않았습니다.
    contributions: item.contributions as ExtensionEntryView["contributions"],
    permissions: item.permissions as ExtensionEntryView["permissions"],
  }));
  return [
    ...entries,
    ...marketplaceEntries(
      inventory,
      entries.map((item) => item.packageName),
    ),
  ];
}

interface WorkDetailSources {
  readonly detail: WorkDetailV1;
  readonly runs: readonly RunViewV1[];
  readonly activities: readonly WorkActivityViewV1[];
  readonly tasks: readonly TaskViewV1[];
  readonly assignments: readonly AssignmentViewV1[];
  readonly executions: readonly ExecutionViewV1[];
  readonly artifacts: readonly ArtifactViewV1[];
  readonly verifications: readonly VerificationViewV1[];
  readonly records: readonly WorkRecordViewV1[];
  readonly approvals: readonly ApprovalViewV1[];
  readonly directives: readonly DirectiveViewV1[];
  readonly organizationNodes: readonly OrganizationNodeView[];
}

function projectWorkSummary(work: WorkSummaryV1): WorkView {
  const status = projectWorkStatus(work.status);
  const updatedAtIso = work.updatedAt;
  return {
    id: work.workId,
    title: work.title,
    status,
    revision: work.revision,
    sourceStatus: work.status,
    team: work.workspaceId === undefined ? "Massion" : "워크스페이스",
    updatedAt: updatedAtIso === undefined ? "" : clockOf(updatedAtIso),
    ...(updatedAtIso === undefined ? {} : { updatedAtIso }),
    summary: work.title,
    progress: status === "complete" ? 100 : 0,
    approvals: [],
    tasks: [],
    agents: [],
    artifacts: [],
    verifications: [],
    records: [],
    activities: [],
  };
}

function projectWorkDetail(sources: WorkDetailSources): WorkView {
  const tasks = sources.tasks.map(projectTask);
  const agents = projectAgents(sources.assignments, sources.executions, sources.organizationNodes);
  const actualModel = projectActualModel(sources.executions);
  const artifacts = sources.artifacts.map((artifact) => projectArtifact(artifact, tasks));
  const verifications = sources.verifications.map((verification) => projectVerification(verification, artifacts));
  const approvals = sources.approvals.map(projectApproval);
  const run = sources.runs.find((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status)) ?? sources.runs[0];
  const activeExecutionId = sources.executions.find((execution) =>
    ACTIVE_EXECUTION_STATUSES.has(execution.status),
  )?.executionId;
  const completedTasks = tasks.filter((task) => task.state === "done").length;
  const progress =
    tasks.length === 0
      ? sources.detail.status === "completed"
        ? 100
        : 0
      : Math.round((completedTasks / tasks.length) * 100);
  const updatedAtIso = sources.detail.updatedAt ?? sources.detail.createdAt;
  const queuedDirectives = sources.directives.flatMap((directive) => {
    if (directive.status !== "queued" && directive.status !== "applying") return [];
    const applyAt =
      directive.mode === "now" || directive.submittedStage !== run?.stage ? "current-stage" : "next-stage";
    return [
      {
        id: directive.directiveId,
        content: directive.content,
        status: directive.status,
        mode: directive.mode,
        submittedStage: directive.submittedStage,
        applyAt,
        revision: directive.revision,
      } as const,
    ];
  });

  return {
    id: sources.detail.workId,
    title: sources.detail.title,
    status: projectWorkStatus(sources.detail.status),
    revision: sources.detail.revision,
    sourceStatus: sources.detail.status,
    team: sources.detail.workspaceId === undefined ? "Massion" : "워크스페이스",
    updatedAt: updatedAtIso === undefined ? "" : clockOf(updatedAtIso),
    ...(updatedAtIso === undefined ? {} : { updatedAtIso }),
    ...(actualModel ?? {}),
    summary: sources.activities.find((activity) => activity.detail !== undefined)?.detail ?? sources.detail.title,
    progress,
    ...(run === undefined ? {} : { run: projectRun(run) }),
    ...(activeExecutionId === undefined ? {} : { activeExecutionId }),
    queuedDirectives,
    approvals,
    tasks,
    agents,
    artifacts,
    verifications,
    records: sources.records.map(projectRecord),
    activities: projectActivities(sources.activities, sources.approvals, sources.directives, artifacts, tasks),
  };
}

function projectWorkStatus(status: string): WorkStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "active";
}

function workStatusFilter(status: WorkStatus): DesktopFilter {
  return status === "active" ? "active" : "complete";
}

function projectRun(run: RunViewV1): RunView {
  return {
    runId: run.runId,
    status: run.status,
    stage: run.stage,
    leaseGeneration: run.leaseGeneration,
    ...(run.approvalId === undefined ? {} : { approvalId: run.approvalId }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
    ...(run.blockedDetail === undefined ? {} : { blockedDetail: run.blockedDetail }),
  };
}

function projectTask(task: TaskViewV1): TaskView {
  const time = task.updatedAt ?? task.createdAt;
  return {
    id: task.taskId,
    title: task.title,
    state: projectStepState(task.status),
    ...(time === undefined ? {} : { time: clockOf(time), createdAtIso: task.createdAt ?? time }),
  };
}

function projectStepState(status: string): StepState {
  if (new Set(["completed", "done", "passed", "succeeded"]).has(status)) return "done";
  if (new Set(["active", "running", "verifying"]).has(status)) return "active";
  if (new Set(["cancelled", "failed"]).has(status)) return "failed";
  return "pending";
}

function projectAgents(
  assignments: readonly AssignmentViewV1[],
  executions: readonly ExecutionViewV1[],
  nodes: readonly OrganizationNodeView[],
): AgentView[] {
  const agents = new Map<string, AgentView>();
  for (const assignment of assignments) {
    const execution = executions.find((candidate) => candidate.agentHandle === assignment.agentHandle);
    const role = agentRoleFor(assignment.agentHandle, nodes);
    const identity = agentIdentityToken(assignment.agentHandle, role);
    agents.set(assignment.agentHandle, {
      id: assignment.assignmentId ?? assignment.agentHandle,
      role,
      name: identity.name,
      initials: identity.initial,
      state:
        ACTIVE_AGENT_STATUSES.has(assignment.status) ||
        (execution !== undefined && ACTIVE_EXECUTION_STATUSES.has(execution.status))
          ? "active"
          : "waiting",
    });
  }
  for (const execution of executions) {
    if (agents.has(execution.agentHandle)) continue;
    const role = agentRoleFor(execution.agentHandle, nodes);
    const identity = agentIdentityToken(execution.agentHandle, role);
    agents.set(execution.agentHandle, {
      id: execution.agentHandle,
      role,
      name: identity.name,
      initials: identity.initial,
      state: ACTIVE_EXECUTION_STATUSES.has(execution.status) ? "active" : "waiting",
    });
  }
  return [...agents.values()];
}

function agentRoleFor(handle: string, nodes: readonly OrganizationNodeView[]): string {
  return nodes.some((node) => node.handle === handle)
    ? roleLabelFor(handle, nodes)
    : agentRoleToken(handle).friendlyLabel;
}

function projectActualModel(
  executions: readonly ExecutionViewV1[],
): Pick<WorkView, "providerId" | "modelId"> | undefined {
  if (executions.length === 0) return undefined;
  const actual = new Map<string, { providerId: string; modelId: string }>();
  for (const execution of executions) {
    const source = execution as ExecutionViewV1 & { readonly providerId?: string; readonly modelId?: string };
    if (!source.providerId || !source.modelId) return undefined;
    actual.set(`${source.providerId}\u0000${source.modelId}`, {
      providerId: source.providerId,
      modelId: source.modelId,
    });
  }
  return actual.size === 1 ? actual.values().next().value : undefined;
}

function projectArtifact(artifact: ArtifactViewV1, tasks: readonly TaskView[]): ArtifactView {
  const task =
    artifact.kind === "task-output" && artifact.name.startsWith("task-")
      ? tasks.find((candidate) => candidate.id === artifact.name.slice("task-".length))
      : undefined;
  const name =
    task === undefined
      ? artifact.kind === "verification-evidence"
        ? "독립 검증 근거"
        : artifact.kind === "task-output" && OPAQUE_UUID.test(artifact.name.slice("task-".length))
          ? "작업 결과"
          : artifact.name
      : `${task.title} 결과`;
  return {
    id: artifact.artifactVersionId,
    name,
    format: artifactFormat(artifact),
    size: "메타데이터",
    createdAt: clockOf(artifact.createdAt),
    createdAtIso: artifact.createdAt,
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    version: artifact.version,
    createdBy: artifact.createdBy,
  };
}

function artifactFormat(artifact: ArtifactViewV1): string {
  const mediaType = artifact.mediaType.toLocaleLowerCase();
  const kind = artifact.kind.toLocaleLowerCase();
  if (mediaType === "application/pdf" || kind === "pdf") return "PDF";
  if (mediaType.includes("csv") || kind === "csv") return "CSV";
  const extension = artifact.name.split(".").at(-1);
  return extension === undefined || extension === artifact.name
    ? artifact.kind.toLocaleUpperCase()
    : extension.toLocaleUpperCase();
}

const VERIFICATION_CRITERION_STATUSES = new Set<VerificationCriterionStatus>([
  "passed",
  "failed",
  "blocked",
  "excluded",
]);

/** 계약이 criteria를 unknown으로 싣기 때문에 화면 경계에서 좁힙니다. 알 수 없는 항목은 지어내지 않고 버립니다. */
function projectVerificationCriteria(value: unknown): VerificationCriterionView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): VerificationCriterionView[] => {
    if (!item || typeof item !== "object") return [];
    const { criterionKey, status } = item as Record<string, unknown>;
    if (typeof criterionKey !== "string" || !criterionKey) return [];
    if (typeof status !== "string" || !VERIFICATION_CRITERION_STATUSES.has(status as VerificationCriterionStatus)) {
      return [];
    }
    return [{ key: criterionKey, status: status as VerificationCriterionStatus }];
  });
}

function projectVerification(verification: VerificationViewV1, artifacts: readonly ArtifactView[]): VerificationView {
  const verifier = agentRoleToken(verification.verifierId).friendlyLabel;
  const evidence = verification.evidenceArtifactVersionIds.flatMap((id) => {
    const artifact = artifacts.find((candidate) => candidate.artifactVersionId === id || candidate.id === id);
    return artifact === undefined ? [] : [artifact.name];
  });
  const missingEvidence = verification.evidenceArtifactVersionIds.length - evidence.length;
  return {
    id: verification.verificationId,
    verifier: OPAQUE_UUID.test(verifier) ? "검증 담당" : verifier,
    state: verification.passed ? "done" : "failed",
    criteria: projectVerificationCriteria(verification.criteria),
    ...(verification.evidenceArtifactVersionIds.length === 0
      ? {}
      : {
          evidence:
            evidence.length === 0
              ? `근거 ${String(missingEvidence)}개`
              : `${evidence.join(", ")}${missingEvidence === 0 ? "" : ` 외 ${String(missingEvidence)}개`}`,
        }),
  };
}

function projectRecord(record: WorkRecordViewV1): RecordView {
  const internal = /^Records run .+ finalized (\d+) document\(s\)$/u.exec(record.summary);
  const documentCount = internal?.[1];
  return {
    id: record.recordId,
    version: record.version,
    summary:
      internal === null
        ? record.summary
        : `업무 결과와 검증 기록을 확정했습니다.${documentCount === undefined || documentCount === "0" ? "" : ` 문서 ${documentCount}건을 포함합니다.`}`,
    finalizedAt: clockOf(record.finalizedAt),
    verificationIds: [...record.verificationIds],
    artifactVersionIds: [...record.artifactIds],
  };
}

function projectApproval(approval: ApprovalViewV1): ApprovalView {
  return {
    id: approval.approvalId,
    action: approval.action,
    title: approval.displayPreview?.title ?? approval.action,
    description: approvalDescription(approval),
    ...(approval.workId === undefined ? {} : { workId: approval.workId }),
    revision: approval.revision,
    status: approval.status,
  };
}

function inboxBlockedReason(reason: unknown, detail: unknown): string {
  if (typeof detail === "string" && detail.trim().length > 0) return detail;
  switch (reason) {
    case "representative-failed":
      return "요청 이해 Agent가 요청 해석에 실패했습니다.";
    case "context-strategy-stage-failed":
    case "strategy-failed":
      return "Provider가 전략 계획의 구조화 응답을 완성하지 못했습니다.";
    case "model-unavailable":
      return "사용 가능한 모델을 찾지 못했습니다.";
    case "evidence-invalid":
      return "업무에 연결된 근거를 검증하지 못했습니다.";
    case "workspace-untrusted":
      return "이 폴더를 아직 신뢰하지 않았습니다.";
    case "assurance-verifier-rejected":
      return "산출물의 모순을 보완한 새 Work가 필요합니다.";
    default:
      return "실행 단계에서 오류가 발생했습니다.";
  }
}

function projectInbox(value: unknown): InboxItem[] {
  if (!Array.isArray(value)) throw new Error("Inbox 응답이 유효하지 않습니다");
  return value.map((item): InboxItem => {
    const row = object(item);
    if (!row) throw new Error("Inbox 항목이 유효하지 않습니다");
    const id = knowledgeString(row.id, "Inbox 항목 ID", 256);
    if (row.kind === "approval") {
      const approval = object(row.approval);
      if (!approval) throw new Error("Inbox 승인 항목이 유효하지 않습니다");
      return {
        kind: "approval",
        id,
        approval: projectApproval(approval as unknown as ApprovalViewV1),
        ...(row.workTitle === undefined ? {} : { workTitle: knowledgeString(row.workTitle, "Inbox Work 제목", 1_024) }),
      };
    }
    if (row.kind === "blocked") {
      return {
        kind: "blocked",
        id,
        runId: knowledgeString(row.runId, "Inbox run ID", 128),
        ...(row.workId === undefined ? {} : { workId: knowledgeString(row.workId, "Inbox Work ID", 128) }),
        title: knowledgeString(row.title, "Inbox 차단 제목", 1_024),
        reason: inboxBlockedReason(row.blockedReason, row.blockedDetail),
      };
    }
    if (row.kind === "growth") {
      return {
        kind: "growth",
        id,
        suggestionId: knowledgeString(row.suggestionId, "Inbox 개선 제안 ID", 128),
        workId: knowledgeString(row.workId, "Inbox 개선 Work ID", 128),
        workTitle: knowledgeString(row.workTitle, "Inbox 개선 Work 제목", 1_024),
        title: knowledgeString(row.title, "Inbox 개선 제목", 1_024),
        reason: knowledgeString(row.reason, "Inbox 개선 근거", 4_096),
      };
    }
    throw new Error("Inbox 항목 종류가 유효하지 않습니다");
  });
}

function approvalDescription(approval: ApprovalViewV1): string {
  const preview = approval.displayPreview;
  if (preview?.reason !== undefined) return preview.reason;
  if (preview?.kind === "command") return [preview.executable, ...preview.arguments].join(" ");
  if (preview?.kind === "file-change") return `${preview.path} · ${preview.summary}`;
  return `승인 요청 · ${clockOf(approval.expiresAt)}까지`;
}

function projectActivities(
  activities: readonly WorkActivityViewV1[],
  sourceApprovals: readonly ApprovalViewV1[],
  directives: readonly DirectiveViewV1[],
  artifacts: readonly ArtifactView[],
  tasks: readonly TaskView[],
): ActivityView[] {
  const approvalsById = new Map(sourceApprovals.map((approval) => [approval.approvalId, approval]));
  const projected = activities.map((activity) => projectActivity(activity, approvalsById));
  const representedApprovalIds = new Set(
    projected.flatMap((activity) => (activity.kind === "approval" ? [activity.approvalId] : [])),
  );

  for (const approval of sourceApprovals) {
    if (approval.status !== "pending" || representedApprovalIds.has(approval.approvalId)) continue;
    const view = projectApproval(approval);
    const occurredAt = approval.createdAt ?? approval.expiresAt;
    projected.push({
      id: `approval:${approval.approvalId}`,
      kind: "approval",
      time: clockOf(occurredAt),
      occurredAt,
      approvalId: approval.approvalId,
      title: view.title,
      description: view.description,
    });
  }

  for (const directive of directives) {
    const status = directiveStatusText(directive.status);
    projected.push({
      id: `directive:${directive.directiveId}`,
      kind: "event",
      semantic: "directive",
      time: clockOf(directive.createdAt),
      occurredAt: directive.createdAt,
      title: "지시 상태",
      detail: directive.content,
      status,
    });
  }

  if (tasks.length > 0) {
    const occurredAt = tasks[0]?.createdAtIso;
    projected.push({
      id: "plan:current",
      kind: "plan",
      time: occurredAt === undefined ? "" : clockOf(occurredAt),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      title: "실행 계획",
      steps: [...tasks],
    });
  }

  if (artifacts.length > 0) {
    const createdAt = artifacts[0]?.createdAtIso ?? artifacts[0]?.createdAt;
    projected.push({
      id: "artifacts:current",
      kind: "artifacts",
      time: artifacts[0]?.createdAt ?? "",
      ...(createdAt === undefined ? {} : { occurredAt: createdAt }),
      title: "산출물",
      artifacts: [...artifacts],
    });
  }
  return projected.sort(
    (left, right) =>
      (left.occurredAt ?? left.time).localeCompare(right.occurredAt ?? right.time) || left.id.localeCompare(right.id),
  );
}

function directiveStatusText(status: string): string {
  switch (status) {
    case "queued":
      return "대기";
    case "applying":
      return "반영 중";
    case "applied":
      return "반영됨";
    case "cancelled":
      return "취소됨";
    case "unapplied":
      return "미반영 종료";
    case "failed":
      return "반영 실패";
    default:
      return "상태 미상";
  }
}

function projectActivity(
  activity: WorkActivityViewV1,
  approvalsById: ReadonlyMap<string, ApprovalViewV1>,
): ActivityView {
  const approval = activity.resourceId === undefined ? undefined : approvalsById.get(activity.resourceId);
  if (activity.kind === "approval" && approval !== undefined) {
    const view = projectApproval(approval);
    return {
      id: activity.activityId,
      kind: "approval",
      time: clockOf(activity.createdAt),
      occurredAt: activity.createdAt,
      approvalId: approval.approvalId,
      title: view.title,
      description: activity.detail ?? view.description,
    };
  }
  if (activity.kind !== "message") {
    return {
      id: activity.activityId,
      kind: "event",
      semantic: eventSemantic(activity.kind),
      time: clockOf(activity.createdAt),
      occurredAt: activity.createdAt,
      title: activity.title,
      detail: activity.detail ?? "",
      status: activity.status ?? "",
    };
  }
  const source = activity as WorkActivityViewV1 & { readonly authorKind?: string; readonly messageType?: string };
  const identity = source.authorKind === "agent" ? agentIdentityToken(activity.authorId ?? "agent") : undefined;
  const author = source.authorKind === "user" ? "나" : (identity?.name ?? "Massion");
  return {
    id: activity.activityId,
    kind: "message",
    time: clockOf(activity.createdAt),
    occurredAt: activity.createdAt,
    author,
    initials: identity?.initial ?? initials(author),
    human: source.authorKind === "user",
    content: activity.detail ?? activity.title,
    ...(source.messageType === undefined ? {} : { messageType: source.messageType }),
  };
}

function eventSemantic(kind: WorkActivityViewV1["kind"]): EventSemantic {
  if (kind === "task" || kind === "assignment") return "task";
  if (kind === "artifact") return "artifact";
  if (kind === "verification") return "verification";
  if (kind === "record") return "record";
  return "stage";
}

function requireRun(work: WorkView): RunView {
  if (work.run === undefined) throw new Error("Work에 제어할 run이 없습니다");
  return work.run;
}

function initials(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? "M";
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
