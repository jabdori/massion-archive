import { agentIdentityToken } from "@massion/application/client";

export type WorkStatus = "active" | "complete" | "failed" | "cancelled";
export type StepState = "done" | "active" | "pending" | "failed";

export interface AgentView {
  id: string;
  role: string;
  name: string;
  initials: string;
  state: "active" | "waiting";
}

export interface TaskView {
  id: string;
  title: string;
  state: StepState;
  time?: string;
  /** 계획 카드의 시간순 정렬에 쓰는 원본 시각입니다. */
  createdAtIso?: string;
}

export interface ArtifactView {
  id: string;
  name: string;
  format: string;
  size: string;
  createdAt: string;
  /** 표시 시각으로 바꾸기 전 ISO 값. 활동 정렬에만 씁니다. */
  createdAtIso?: string;
  artifactId?: string;
  artifactVersionId?: string;
  kind?: string;
  mediaType?: string;
  checksum?: string;
  version?: number;
  createdBy?: string;
}

/** `CollaborationMessageType`(packages/work)을 그대로 옮깁니다. 화면 문법이 이 타입에서 갈라집니다. */
export type RoomMessageType =
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

/**
 * 화자 정체성. 역할이 아니라 handle에서 파생하므로 같은 역할이 병렬로 돌아도 갈립니다.
 * name·initial·accentSlot은 @massion/application의 agentIdentityToken이 소유합니다.
 */
export interface SpeakerView {
  /** 도메인 정체성. Assignment의 agent_handle입니다. */
  handle: string;
  /** 표시 이름. 고유명사이므로 번역하지 않습니다. */
  name: string;
  /** 아바타 한 글자. */
  initial: string;
  /** 0–7 색 슬롯. 사람은 -1을 씁니다. */
  accentSlot: number;
  /** 역할 배지 문구. */
  role: string;
  /** 사람 참가자. */
  human?: boolean;
  /** 이 발화를 실제 처리한 Provider. 모델과 함께 표시합니다. */
  providerId?: string;
  /** scope:"work"이거나 아직 승인되지 않은 노드. 점선으로 표기합니다. */
  provisional?: boolean;
  /**
   * 이 발화를 만든 모델. 조직이 역할과 난이도로 배치하므로 같은 화자도 발화마다 다를 수 있습니다.
   * `route_attempt.model_profile_id` 계보에서 옵니다. 사람 참가자에게는 없습니다.
   */
  modelId?: string;
}

export interface RoomQuote {
  author: string;
  time: string;
  content: string;
}

/** @massion/organization의 NodeRole. 문구는 room.tsx가 소유합니다. */
export type NodeRole = "orchestrator" | "coordinator" | "operator";

/** @massion/organization의 ComplianceFinding.code. 화면에는 통과한 검사로 나옵니다. */
export type ComplianceCode = "core-office" | "orphan" | "cycle" | "scope" | "inactive-parent";

export interface OrganizationChangeNodeView {
  handle: string;
  name: string;
  scope: "work" | "persistent";
  workId?: string;
  parentHandle: string;
  role: NodeRole;
  capabilities: string[];
}

/** `proposal` 메시지에 붙는 조직 변경. 실제 응답에 없는 판단은 optional로 둡니다. */
export interface OrganizationChangeView {
  nodes: OrganizationChangeNodeView[];
  impactNodes: number;
  impactReferences: number;
  impactHandles: string[];
  fromVersion: number;
  toVersion: number;
  revertable?: boolean;
  compliance?: ComplianceCode[];
  lifetime?: string;
}

export type EventSemantic = "stage" | "task" | "artifact" | "verification" | "record" | "directive";

export type ActivityView = (
  | {
      id: string;
      kind: "message";
      messageType?: string;
      time: string;
      author: string;
      initials: string;
      human: boolean;
      content: string;
    }
  | { id: string; kind: "plan"; time: string; title: string; steps: TaskView[] }
  | { id: string; kind: "agents"; time: string; title: string; agents: AgentView[] }
  | { id: string; kind: "approval"; time: string; approvalId: string; title: string; description: string }
  | { id: string; kind: "artifacts"; time: string; title: string; artifacts: ArtifactView[] }
  | {
      id: string;
      kind: "event";
      semantic: EventSemantic;
      time: string;
      title: string;
      detail: string;
      status: string;
    }
  // 6단계 전환 지점에만 놓는 챕터 구분선. 대화를 접거나 담지 않습니다.
  | { id: string; kind: "chapter"; time: string; stage: string; label: string; until?: string }
  // 발언이 아니므로 아바타를 주지 않고 가운데 한 줄로 둡니다.
  | { id: string; kind: "roomStatus"; time: string; content: string }
  // 다른 방으로 갈라진 지점. 대표 방 안에 인라인으로 나타나고 누를 때만 탭이 열립니다.
  // 방이 늘어나도 탭 바가 감당해야 할 개수는 사용자가 연 것뿐입니다.
  | {
      id: string;
      kind: "roomRef";
      time: string;
      roomId: string;
      name: string;
      participants: SpeakerView[];
      messageCount: number;
      lastLine: string;
      waiting: boolean;
    }
  // 조직이 일을 넘겼다는 사실은 한 줄 텍스트보다 크게 보여야 합니다.
  // 새 handoff는 받는 Agent를 구조화합니다. 과거 메시지처럼 값이 없으면 넘긴 쪽만 그립니다.
  | { id: string; kind: "handoff"; time: string; from: SpeakerView; to?: SpeakerView; content?: string }
  | {
      id: string;
      kind: "room";
      time: string;
      messageType: Exclude<RoomMessageType, "handoff" | "status" | "proposal">;
      speaker: SpeakerView;
      content: string;
      /** `question`·`review_request`의 수신자 */
      recipient?: string;
      /** `answer`는 질문 아래 들여써서 짝을 눈에 보이게 합니다. */
      indented?: boolean;
      /** `challenge`는 원본 인용 없이 존재할 수 없습니다. */
      quoted?: RoomQuote;
      /** `evidence`의 첨부와 checksum */
      evidence?: { label: string; checksum: string };
      /** `change_request`의 대상 */
      target?: string;
      /** `decision`의 서명자와 개정 */
      signature?: { by: string; revision: number };
      /**
       * 대표 에이전트가 사용자에게 돌려준 답. 헌법 §5의 「Records와 최종 응답」이 끝나는 지점입니다.
       * 새 도메인 개념이 아니라 Representative(요청 접수·조정·최종 응답)의 `answer`를 표시로 가립니다.
       */
      final?: boolean;
    }
  | {
      id: string;
      kind: "proposal";
      time: string;
      speaker: SpeakerView;
      content: string;
      change: OrganizationChangeView;
      approvalId?: string;
      decided?: boolean;
    }
) & { occurredAt?: string };

export interface RunView {
  runId: string;
  status: string;
  stage: string;
  leaseGeneration: number;
  approvalId?: string;
  blockedReason?: string;
  blockedDetail?: string;
}

export interface ApprovalView {
  id: string;
  action?: string;
  title: string;
  description: string;
  workId?: string;
  revision: number | undefined;
  status: string;
}

/**
 * 수신함 항목. "사람이 필요한 것"을 한 덩어리로 뭉치지 않고, 해결 방식이 다른 것을 타입으로 가릅니다.
 *  - approval: 실행이 승인을 기다리며 멈춤. gate(노랑). 소유 화면으로 이동해 승인·거절.
 *  - blocked:  실행이 막힘(모델 부재·폴더 신뢰 등). halt(빨강). 원인을 풀러 업무로 이동.
 *  - growth:   개선 제안이 검토를 기다림. 근거를 읽을 수 있는 개선 상세로 이동.
 * 배지·수신함·홈이 모두 이 한 타입의 목록을 봅니다. 숫자가 갈리지 않게.
 */
export type InboxItem =
  | { readonly kind: "approval"; readonly id: string; readonly approval: ApprovalView; readonly workTitle?: string }
  | {
      readonly kind: "blocked";
      readonly id: string;
      readonly runId: string;
      readonly workId?: string;
      readonly title: string;
      readonly reason: string;
    }
  | {
      readonly kind: "growth";
      readonly id: string;
      readonly suggestionId: string;
      readonly workId: string;
      readonly workTitle?: string;
      readonly title: string;
      readonly reason: string;
    };

export type VerificationCriterionStatus = "passed" | "failed" | "blocked" | "excluded";

export interface VerificationCriterionView {
  key: string;
  status: VerificationCriterionStatus;
}

export interface VerificationView {
  id: string;
  /** 판정한 조직 노드입니다. 실행자와 분리된 주체이므로 제목에 뭉개지 않습니다. */
  verifier: string;
  state: StepState;
  /** 무엇을 기준으로 판정했는지입니다. Assurance 판정 투영이 1개 이상 100개 이하로 보증합니다. */
  criteria: VerificationCriterionView[];
  evidence?: string;
}

/**
 * 이 Work에만 거는 실행 권한. Claude Code의 권한 모드처럼 세션 안에서 바뀝니다.
 * 조직 기본값(설정)을 따르면 `undefined`이고, 여기서 바꾸면 이 Work만 달라집니다.
 * 도메인의 AutonomyStore는 조직 단위라 Work 단위 계약이 아직 없습니다 —
 * 인계: docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md
 */
export type WorkAutonomyMode = "automatic" | "review" | "full-access";

/** 같은 모델에 얼마나 생각하게 할지. 모델 선택과는 다른 축입니다. */
export type ReasoningEffort = "low" | "medium" | "high";

/** 아직 반영되지 않은 지시. 인풋 위에 서서, 현재 작업에 끼워 넣을지 고를 수 있습니다. */
export interface QueuedDirectiveView {
  id: string;
  content: string;
  status: "queued" | "applying";
  mode: "now" | "next-stage";
  submittedStage: string;
  applyAt: "current-stage" | "next-stage";
  revision: number;
}

/** `RecordsDocument`(packages/records/src/contracts.ts)의 kind. work-record는 문서가 아니라 기록 자신입니다. */
export type RecordDocumentKind = "adr" | "changelog" | "runbook";

export interface RecordDocumentView {
  id: string;
  kind: RecordDocumentKind;
  /** `markdown_checksum`. 렌더된 문서가 바뀌지 않았다는 사실이 여기서 확인됩니다. */
  checksum: string;
}

/**
 * `WorkRecord`(packages/work/src/work.ts `:542`)를 화면 문법으로 옮깁니다.
 * Records 단계가 실제로 남기는 것만 싣습니다. 도메인이 ID로만 가진 것은 ID로 둡니다.
 */
export interface RecordView {
  /** `work_record_id` */
  id: string;
  version: number;
  summary: string;
  /** `recorded_work_revision` */
  recordedRevision?: number;
  /** `finalized_by` */
  finalizedBy?: string;
  /** `finalized_at` */
  finalizedAt: string;
  /** `records_snapshot_hash`. 이 기록이 가리키는 되돌릴 수 있는 지점입니다. */
  snapshotHash?: string;
  /** `event_start_sequence` – `event_end_sequence` */
  eventRange?: [number, number];
  /** `decision_message_ids`. activities의 decision 메시지 id를 가리킵니다. */
  decisionIds?: string[];
  /** `verification_ids` */
  verificationIds: string[];
  /** `artifact_version_ids` */
  artifactVersionIds: string[];
  documents?: RecordDocumentView[];
}

export interface WorkView {
  id: string;
  /** 없으면 조직 기본값을 따릅니다. */
  autonomyMode?: WorkAutonomyMode;
  /** 이 Work가 묶인 워크스페이스. 없으면 디렉토리 없는 업무입니다. */
  workspace?: { name: string; trusted: boolean };
  /** 이 업무가 쓰는 모델과 추론 수준. 없으면 조직이 배치한 값을 따릅니다. */
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  /** 보냈지만 아직 반영되지 않은 지시. */
  queuedDirectives?: QueuedDirectiveView[];
  title: string;
  status: WorkStatus;
  revision: number;
  sourceStatus: string;
  team: string;
  updatedAt: string;
  /** 표시 시각으로 바꾸기 전 ISO 값. 정렬이 필요할 때 씁니다. */
  updatedAtIso?: string;
  summary: string;
  progress: number;
  run?: RunView;
  activeExecutionId?: string;
  approvals: ApprovalView[];
  tasks: TaskView[];
  agents: AgentView[];
  artifacts: ArtifactView[];
  verifications: VerificationView[];
  /** Records 단계가 남긴 것. 검증이 끝나기 전에는 비어 있습니다. */
  records: RecordView[];
  activities: ActivityView[];
}

/** 협업방 한 개. work.rooms + work.messages를 화면 문법으로 투영한 결과입니다. */
export interface RoomBudgetView {
  label: string;
  used: number;
  limit: number;
  display: string;
}

export interface SharedContextView {
  id: string;
  label: string;
  checksum: string;
}

export interface RoomView {
  roomId: string;
  name: string;
  status: string;
  participants: SpeakerView[];
  lastMessageSequence: number;
  /** 라운드·토큰·비용. 한도가 없는 항목은 목록에 넣지 않습니다. */
  budgets: RoomBudgetView[];
  sharedContexts: SharedContextView[];
  activities: ActivityView[];
}

export interface DesktopSnapshot {
  works: WorkView[];
}

export type DesktopDataAdapter = () => DesktopSnapshot;

/** 이름·이니셜·색 슬롯은 공유 계층이 정합니다. 표면마다 다르게 부르면 같은 에이전트를 알아볼 수 없습니다. */
function speaker(handle: string, role: string, options?: { provisional?: boolean; modelId?: string }): SpeakerView {
  const identity = agentIdentityToken(handle, role);
  return {
    handle: identity.handle,
    name: identity.name,
    initial: identity.initial,
    accentSlot: identity.accentSlot,
    role,
    ...(options?.provisional === true ? { provisional: true } : {}),
    ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
  };
}

const me: SpeakerView = { handle: "user", name: "나", initial: "나", accentSlot: -1, role: "사람", human: true };
const atlas = speaker("representative", "조정", { modelId: "claude-sonnet-5" });
const quill = speaker("evidence-research", "조사", { modelId: "glm-5.2" });
const vega = speaker("delivery-coordination", "실행", { modelId: "claude-sonnet-5" });
const iris = speaker("assurance", "검증", { modelId: "gpt-5.6-luna" });

const churnAgents: AgentView[] = [
  { id: atlas.handle, role: atlas.role, name: atlas.name, initials: atlas.initial, state: "active" },
  { id: quill.handle, role: quill.role, name: quill.name, initials: quill.initial, state: "active" },
  { id: vega.handle, role: vega.role, name: vega.name, initials: vega.initial, state: "active" },
  { id: iris.handle, role: iris.role, name: iris.name, initials: iris.initial, state: "waiting" },
];

const churnTasks: TaskView[] = [
  { id: "scope", title: "데이터 범위 확인", state: "done", time: "10:22" },
  { id: "drivers", title: "이탈 요인 분석", state: "active", time: "10:24" },
  { id: "draft", title: "개선안 초안 작성", state: "pending" },
  { id: "validate", title: "개선안 검증", state: "pending" },
  { id: "report", title: "최종 정리 및 보고", state: "pending" },
];

const churnArtifacts: ArtifactView[] = [
  { id: "report", name: "이탈 분석 보고서.pdf", format: "PDF", size: "2.4 MB", createdAt: "10:24" },
  { id: "cohort", name: "코호트 데이터.csv", format: "CSV", size: "1.1 MB", createdAt: "10:24" },
];

/** 완료된 Work의 산출물. `artifactVersionId`가 WorkRecord의 `artifact_version_ids`와 같은 값을 가리킵니다. */
const refundArtifacts: ArtifactView[] = [
  {
    id: "refund-report",
    name: "환불 지연 분석.pdf",
    format: "PDF",
    size: "1.8 MB",
    createdAt: "07.24",
    artifactVersionId: "artifact-version-refund-report",
    checksum: "9e13c0",
  },
  {
    id: "refund-latency",
    name: "구간별 지연.csv",
    format: "CSV",
    size: "412 KB",
    createdAt: "07.22",
    artifactVersionId: "artifact-version-refund-latency",
    checksum: "d40f7a",
  },
];

const works: WorkView[] = [
  {
    id: "churn-q3",
    workspace: { name: "customer-ops", trusted: true },
    modelId: "claude-sonnet-5",
    reasoningEffort: "high",
    // 보냈지만 아직 반영되지 않은 지시. 인풋 위에 서서 사람이 처리 시점을 고릅니다.
    queuedDirectives: [
      {
        id: "queued-cohort",
        content: "코호트를 계약 규모별로도 나눠줘",
        status: "queued",
        mode: "next-stage",
        submittedStage: "delivery",
        applyAt: "next-stage",
        revision: 1,
      },
    ],
    title: "3분기 고객 이탈 원인 분석",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    // 계획이 돌고 Agent가 붙어 있는 Work에는 실행 기록이 있습니다. 이것을 빼 두면 홈은
    // «지금 도는 것 0»이라고 말하고 업무 목록은 같은 Work를 «진행 중»이라고 말합니다.
    run: { runId: "run-churn", status: "running", stage: "delivery", leaseGeneration: 2 },
    team: "고객 운영팀",
    updatedAt: "10:24",
    summary: "최근 90일의 이탈 신호를 분석하고 실행 가능한 개선안을 정리합니다.",
    progress: 36,
    approvals: [
      {
        id: "approval-crm-access",
        title: "CRM 고객 데이터 읽기",
        description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
        workId: "churn-q3",
        revision: 1,
        status: "pending",
      },
    ],
    tasks: churnTasks,
    agents: churnAgents,
    artifacts: churnArtifacts,
    verifications: [
      {
        id: "verification-churn",
        verifier: "Iris",
        state: "done",
        criteria: [
          { key: "data-accuracy", status: "passed" },
          { key: "statistical-significance", status: "passed" },
          { key: "improvement-feasibility", status: "blocked" },
          { key: "expected-impact", status: "excluded" },
        ],
        evidence: "CRM 표본 2,418건 일치",
      },
    ],
    records: [],
    activities: [
      {
        id: "request",
        kind: "room",
        messageType: "question",
        time: "10:21",
        speaker: me,
        content: "최근 90일 이탈 원인을 분석하고 개선안을 정리해줘.",
      },
      {
        id: "accepted",
        kind: "room",
        messageType: "answer",
        time: "10:21",
        speaker: atlas,
        content: "전략·조사·분석을 병렬로 붙이고 검증은 결과가 나온 뒤 독립으로 돌리겠습니다.",
      },
      { id: "chapter-evidence", kind: "chapter", time: "10:22", stage: "evidence", label: "근거", until: "10:24" },
      { id: "plan", kind: "plan", time: "10:22", title: "실행 계획", steps: churnTasks },
      {
        id: "labeling-question",
        kind: "room",
        messageType: "question",
        time: "10:23",
        speaker: vega,
        recipient: quill.name,
        content: "해지 사유 라벨링 기준이 뭔가요? 자유 텍스트를 어떤 축으로 나눴는지 알아야 회귀에 넣습니다.",
      },
      {
        id: "labeling-answer",
        kind: "room",
        messageType: "answer",
        time: "10:23",
        speaker: quill,
        indented: true,
        content: "가격 · 기능 부족 · 지원 불만 · 경쟁사 이동 · 기타 5축입니다.",
        evidence: { label: "라벨링 기준 브리프", checksum: "a3f1c8" },
      },
      {
        id: "cohort-challenge",
        kind: "room",
        messageType: "challenge",
        time: "10:24",
        speaker: iris,
        quoted: { author: quill.name, time: "10:23", content: "가격 · 기능 부족 · 지원 불만 · 경쟁사 이동 · 기타 5축" },
        content:
          "2분기와 3분기의 코호트 정의가 달라서 이 5축으로는 분기 간 비교가 성립하지 않습니다. 정의를 맞추거나 비교 주장을 빼야 합니다.",
      },
      {
        id: "handoff-research-delivery",
        kind: "handoff",
        time: "10:24",
        from: quill,
        to: vega,
      },
      { id: "chapter-delivery", kind: "chapter", time: "10:24", stage: "delivery", label: "실행" },
      {
        id: "quant-proposal",
        kind: "proposal",
        time: "10:25",
        speaker: atlas,
        content:
          "검증의 반론을 받으려면 코호트 정규화와 유의성 검정이 필요한데, 현재 조직에 통계 역량이 없습니다. 이 업무에만 존재하는 임시 팀을 제안합니다.",
        change: {
          nodes: [
            {
              handle: "quant-analysis",
              name: "계량분석 팀",
              scope: "work",
              parentHandle: "delivery-coordination",
              role: "operator",
              capabilities: ["코호트 정규화", "유의성 검정", "시계열 분해"],
            },
          ],
          impactNodes: 2,
          impactReferences: 3,
          impactHandles: ["delivery-coordination", "assurance"],
          fromVersion: 12,
          toVersion: 13,
          revertable: true,
          compliance: ["orphan", "cycle", "core-office"],
          lifetime: "이 업무가 끝나면 자동으로 사라집니다. 영속 조직은 바뀌지 않습니다.",
        },
      },
      {
        id: "crm-access",
        kind: "approval",
        time: "10:25",
        approvalId: "approval-crm-access",
        title: "CRM 고객 데이터 읽기",
        description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
      },
      {
        id: "cohort-evidence",
        kind: "room",
        messageType: "evidence",
        time: "10:25",
        speaker: quill,
        content: "공개 텍스트 2,116 / 3,412건 분류를 마쳤습니다. 나머지는 CRM 승인 후 진행합니다.",
        evidence: { label: "코호트 데이터.csv", checksum: "7c02b1" },
      },
      { id: "artifacts", kind: "artifacts", time: "10:25", title: "중간 산출물", artifacts: churnArtifacts },
      {
        id: "review-req",
        kind: "room",
        messageType: "review_request",
        time: "10:26",
        speaker: vega,
        recipient: iris.name,
        content: "코호트 재계산 전에 통계 가정이 성립하는지 먼저 봐 주세요.",
      },
      {
        id: "change-req",
        kind: "room",
        messageType: "change_request",
        time: "10:27",
        speaker: iris,
        target: "이탈 분석 보고서.pdf",
        content: "분기 간 비교 문단을 빼거나 코호트 정의를 맞춘 뒤 다시 쓰십시오. 현재 문장은 근거가 없습니다.",
      },
      {
        id: "decision-cohort",
        kind: "room",
        messageType: "decision",
        time: "10:28",
        speaker: atlas,
        content: "코호트 정의를 3분기 기준으로 통일하고 분기 간 비교는 개선안에서 제외합니다.",
        signature: { by: "나", revision: 8 },
      },
      { id: "waiting", kind: "roomStatus", time: "10:29", content: "계량분석 팀 승인을 기다리는 중 · 라운드 6 / 100" },
    ],
  },
  {
    id: "partner-contract",
    title: "파트너 계약서 검토",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    team: "사업 운영팀",
    updatedAt: "어제",
    summary: "갱신 계약의 책임 범위와 해지 조건을 기존 정책에 대조합니다.",
    progress: 22,
    // 차단된 업무. 승인 대기와 달리 사람이 원인을 풀어야 진행됩니다(수신함 halt 항목).
    run: {
      runId: "run-partner",
      status: "blocked",
      stage: "evidence",
      leaseGeneration: 1,
      // 도메인의 enum 슬러그입니다. 문장을 넣으면 화면의 원인 구별 분기가 통째로 죽습니다.
      blockedReason: "workspace-untrusted",
    },
    approvals: [],
    tasks: [
      { id: "terms", title: "계약 조항 검증", state: "active", time: "어제" },
      { id: "risk", title: "위험 조항 정리", state: "pending" },
      { id: "memo", title: "검토 의견 작성", state: "pending" },
    ],
    agents: [
      { id: "legal", role: "정책", name: "차유나", initials: "차", state: "active" },
      { id: "verify", role: "검증", name: "강이든", initials: "강", state: "waiting" },
    ],
    artifacts: [],
    verifications: [
      {
        id: "verification-contract",
        verifier: "Onyx",
        state: "failed",
        criteria: [
          { key: "standard-policy-match", status: "failed" },
          { key: "liability-scope", status: "blocked" },
        ],
      },
    ],
    records: [],
    activities: [
      {
        id: "request",
        kind: "message",
        time: "어제",
        author: "배정우",
        initials: "배",
        human: true,
        content: "파트너 갱신 계약에서 불리한 조항이 있는지 확인해줘.",
      },
      {
        id: "accepted",
        kind: "message",
        time: "어제",
        author: "Atlas",
        initials: "A",
        human: false,
        content: "계약 원문과 내부 표준 정책을 대조하고 있습니다.",
      },
    ],
  },
  {
    id: "weekly-ops",
    title: "주간 운영 보고서",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    run: { runId: "run-weekly", status: "running", stage: "delivery", leaseGeneration: 1 },
    team: "운영 기획팀",
    updatedAt: "09.02",
    summary: "운영 지표 변화와 이번 주 대응 항목을 한 문서로 정리합니다.",
    progress: 64,
    approvals: [],
    tasks: [
      { id: "collect", title: "지표 수집", state: "done" },
      { id: "write", title: "변동 사유 작성", state: "active" },
      { id: "review", title: "리더 검토", state: "pending" },
    ],
    agents: [{ id: "ops", role: "분석", name: "오재희", initials: "오", state: "active" }],
    artifacts: [],
    verifications: [
      {
        id: "verification-metrics",
        verifier: "Vega",
        state: "done",
        criteria: [{ key: "source-metric-match", status: "passed" }],
      },
    ],
    records: [],
    activities: [
      {
        id: "accepted",
        kind: "message",
        time: "09.02",
        author: "Atlas",
        initials: "A",
        human: false,
        content: "지난주 대비 변동 폭이 큰 운영 지표부터 확인하고 있습니다.",
      },
    ],
  },
  {
    // 검증을 통과해 닫힌 Work. 헌법 §4.7의 완료가 화면에서 어떤 모습인지 여기서만 볼 수 있습니다.
    id: "refund-delay",
    title: "환불 지연 원인 제거",
    status: "complete",
    revision: 12,
    sourceStatus: "completed",
    team: "결제 운영팀",
    updatedAt: "07.24",
    summary: "환불 요청부터 입금까지 걸린 시간을 구간별로 분해하고 지연 구간을 제거합니다.",
    progress: 100,
    run: { runId: "run-refund", status: "completed", stage: "terminal", leaseGeneration: 3 },
    approvals: [
      {
        id: "approval-refund-ledger",
        title: "결제 원장 읽기",
        description: "환불 건의 상태 전이 기록에 읽기 전용으로 접근합니다.",
        workId: "refund-delay",
        revision: 4,
        status: "approved",
      },
    ],
    tasks: [
      { id: "decompose", title: "지연 구간 분해", state: "done", time: "07.22" },
      { id: "locate", title: "정산 배치 대기 확인", state: "done", time: "07.23" },
      { id: "fix", title: "배치 주기 변경안 작성", state: "done", time: "07.23" },
      { id: "verify", title: "변경안 독립 검증", state: "done", time: "07.24" },
      { id: "record", title: "결과 기록", state: "done", time: "07.24" },
    ],
    agents: [
      { id: atlas.handle, role: atlas.role, name: atlas.name, initials: atlas.initial, state: "waiting" },
      { id: quill.handle, role: quill.role, name: quill.name, initials: quill.initial, state: "waiting" },
      { id: vega.handle, role: vega.role, name: vega.name, initials: vega.initial, state: "waiting" },
      { id: iris.handle, role: iris.role, name: iris.name, initials: iris.initial, state: "waiting" },
    ],
    artifacts: refundArtifacts,
    verifications: [
      {
        id: "verification-refund",
        verifier: "Iris",
        state: "done",
        criteria: [
          { key: "stage-latency-decomposed", status: "passed" },
          { key: "batch-window-reproduced", status: "passed" },
          { key: "rollback-path-exists", status: "passed" },
        ],
        evidence: "환불 건 9,204건 재계산 일치",
      },
    ],
    records: [
      {
        id: "work-record-refund-1",
        version: 1,
        summary: "업무 결과와 검증 기록을 확정했습니다. 문서 2건을 포함합니다.",
        recordedRevision: 12,
        finalizedBy: "나",
        finalizedAt: "07.24 16:41",
        snapshotHash: "4f9c1ab7",
        eventRange: [1, 47],
        decisionIds: ["decision-batch-window", "decision-rollback"],
        verificationIds: ["verification-refund"],
        artifactVersionIds: ["artifact-version-refund-report", "artifact-version-refund-latency"],
        documents: [
          { id: "document-refund-adr", kind: "adr", checksum: "a91c22" },
          { id: "document-refund-changelog", kind: "changelog", checksum: "5b0e14" },
        ],
      },
    ],
    activities: [
      {
        id: "request",
        kind: "room",
        messageType: "question",
        time: "07.22",
        speaker: me,
        content: "환불이 왜 이렇게 오래 걸리는지 구간을 나눠서 확인하고, 고칠 수 있는 곳은 고쳐줘.",
      },
      { id: "chapter-evidence", kind: "chapter", time: "07.22", stage: "evidence", label: "근거", until: "07.23" },
      {
        id: "latency-evidence",
        kind: "room",
        messageType: "evidence",
        time: "07.22",
        speaker: quill,
        content: "요청 접수 0.4시간 · 심사 1.1시간 · 정산 배치 대기 38.6시간 · 송금 0.9시간입니다.",
        evidence: { label: "구간별 지연.csv", checksum: "d40f7a" },
      },
      { id: "handoff-research-delivery", kind: "handoff", time: "07.23", from: quill, to: vega },
      { id: "chapter-delivery", kind: "chapter", time: "07.23", stage: "delivery", label: "실행", until: "07.24" },
      {
        id: "batch-change",
        kind: "room",
        messageType: "change_request",
        time: "07.23",
        speaker: vega,
        target: "정산 배치 주기",
        content: "1일 1회에서 4시간 주기로 바꾸면 대기가 38.6시간에서 2.3시간으로 내려갑니다.",
      },
      {
        id: "batch-challenge",
        kind: "room",
        messageType: "challenge",
        time: "07.23",
        speaker: iris,
        quoted: { author: vega.name, time: "07.23", content: "대기가 38.6시간에서 2.3시간으로 내려갑니다" },
        content: "되돌릴 경로가 없으면 이 변경은 판정하지 않습니다. 주기를 되돌리는 절차부터 쓰십시오.",
      },
      {
        id: "decision-batch-window",
        kind: "room",
        messageType: "decision",
        time: "07.23",
        speaker: atlas,
        content: "정산 배치 주기를 4시간으로 바꿉니다.",
        signature: { by: "나", revision: 10 },
      },
      {
        id: "decision-rollback",
        kind: "room",
        messageType: "decision",
        time: "07.23",
        speaker: atlas,
        content: "이전 주기로 돌아가는 절차를 변경안과 같은 문서에 넣고, 되돌린 뒤 재검증하기로 합니다.",
        signature: { by: "나", revision: 11 },
      },
      { id: "artifacts", kind: "artifacts", time: "07.24", title: "산출물", artifacts: refundArtifacts },
      { id: "chapter-assurance", kind: "chapter", time: "07.24", stage: "assurance", label: "검증", until: "07.24" },
      {
        id: "verdict",
        kind: "room",
        messageType: "answer",
        time: "07.24",
        speaker: iris,
        recipient: atlas.name,
        content: "기준 3개를 모두 통과했습니다. 환불 건 9,204건을 재계산해 구간 값이 일치하는 것을 확인했습니다.",
      },
      { id: "chapter-records", kind: "chapter", time: "07.24", stage: "records", label: "기록" },
      {
        id: "final-response",
        kind: "room",
        messageType: "answer",
        time: "07.24",
        speaker: atlas,
        recipient: me.name,
        final: true,
        content:
          "환불 지연의 94%는 정산 배치 대기였습니다. 주기를 4시간으로 바꿔 평균 40.9시간에서 4.7시간이 됐고, 검증 기준 3개를 모두 통과했습니다. 되돌리려면 기록의 스냅샷 4f9c1ab7에서 이전 주기로 복구합니다.",
      },
    ],
  },
];

export const fixtureDataAdapter: DesktopDataAdapter = () => ({ works });
