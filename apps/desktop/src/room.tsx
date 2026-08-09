import { agentIdentityToken } from "@massion/application/client";
import { fromMarkdown } from "mdast-util-from-markdown";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import type {
  ComplianceCode,
  NodeRole,
  OrganizationChangeNodeView,
  OrganizationChangeView,
  RoomMessageType,
  RoomQuote,
  SpeakerView,
} from "@/model";
import { translate } from "@/i18n/context";

/**
 * 협업방 문법. 메시지 타입 10종은 색이 아니라 배치와 표기로 구분합니다.
 * 색은 화자 식별에만 쓰고, 노랑은 사람이 필요한 곳에만 씁니다.
 */

/**
 * 도메인 열거값은 화면에 그대로 나오면 안 됩니다. `role operator`는 사람의 말이 아니고,
 * `orphan 없음`은 규칙 코드를 읽으라는 요구입니다. 값은 도메인 것을 그대로 들고 있되
 * 문구는 이 표가 소유합니다. 새 값이 생기면 여기서 타입이 깨져 번역을 강제합니다.
 */
const nodeRoleLabel: Record<NodeRole, string> = {
  orchestrator: "총괄",
  coordinator: "조율",
  operator: "실행",
};

/** ComplianceFinding.code 5종. 화면에 나오는 건 "통과한 검사"이므로 긍정문으로 씁니다. */
const complianceLabel: Record<ComplianceCode, string> = {
  "core-office": "코어 오피스 8팀 보존",
  orphan: "부모 없는 노드 없음",
  cycle: "순환 없음",
  scope: "범위 위반 없음",
  "inactive-parent": "중단된 부모 없음",
};

const scopeLabel: Record<OrganizationChangeNodeView["scope"], string> = {
  work: "이 업무에서만",
  persistent: "조직에 남습니다",
};

/**
 * 승인·거절 한 쌍. 같은 결정을 네 위치(업무 타임라인·수신함·조직 변경 제안·개선)가
 * 각자 다른 버튼으로 그리고 있었습니다. 같은 것은 같게 보여야 하므로 여기서만 만듭니다.
 * 거절은 항상 왼쪽·중성이고, 승인만 gate를 씁니다. 노랑은 "지금 사람이 필요함"이라
 * 결정 버튼 둘 다에 칠하면 어느 쪽이 진행인지 읽히지 않습니다.
 */
export function DecisionActions({
  approveName,
  approveDisabled = false,
  busy = false,
  disabled = false,
  onApprove,
  onReject,
  rejectDisabled = false,
}: {
  approveName: string;
  approveDisabled?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  rejectDisabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        aria-label={`${approveName} ${translate("거절")}`}
        className="rounded-[5px] border border-control px-3 py-1 text-[12px] text-secondary hover:border-fg-3 hover:text-primary disabled:opacity-50"
        disabled={disabled || rejectDisabled}
        onClick={onReject}
        type="button"
      >
        {translate(busy ? "처리 중" : "거절")}
      </button>
      <button
        aria-label={`${approveName} ${translate("승인")}`}
        className="rounded-[5px] bg-gate px-3 py-1 text-[12px] font-medium text-gate-ink hover:brightness-110 disabled:opacity-50"
        disabled={disabled || approveDisabled}
        onClick={onApprove}
        type="button"
      >
        {translate(busy ? "처리 중" : "승인")}
      </button>
    </div>
  );
}

/**
 * 다른 화면·다른 방으로 실제로 이동시키는 버튼. 카드 전체를 버튼으로 두지 않기로 했으므로
 * 이 버튼이 유일한 진입점이고, 그래서 배경을 가진 면으로 서 있어야 눈에 걸립니다.
 * 테두리만 있는 이전 형태는 카드 테두리와 구분되지 않아 있는 줄도 몰랐습니다.
 */
export function OpenButton({ label, onOpen, small = false }: { label: string; onOpen: () => void; small?: boolean }) {
  return (
    <button
      aria-label={label}
      className={`shrink-0 rounded-[5px] border border-control bg-raised font-medium text-primary hover:border-fg-3 hover:bg-surface ${
        small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]"
      }`}
      onClick={onOpen}
      type="button"
    >
      {translate("열기 ›")}
    </button>
  );
}

/**
 * 색 슬롯은 역할이 아니라 handle에서 옵니다. Tailwind가 정적 클래스만 뽑으므로 배열로 둡니다.
 * 배정은 @massion/application의 agentIdentityToken이 소유합니다.
 */
const SLOT_TEXT = [
  "text-agent-0",
  "text-agent-1",
  "text-agent-2",
  "text-agent-3",
  "text-agent-4",
  "text-agent-5",
  "text-agent-6",
  "text-agent-7",
] as const;

const SLOT_FILL = [
  "bg-agent-0 text-bg-0",
  "bg-agent-1 text-bg-0",
  "bg-agent-2 text-bg-0",
  "bg-agent-3 text-bg-0",
  "bg-agent-4 text-bg-0",
  "bg-agent-5 text-bg-0",
  "bg-agent-6 text-bg-0",
  "bg-agent-7 text-bg-0",
] as const;

export function speakerText(speaker: Pick<SpeakerView, "accentSlot" | "human">): string {
  if (speaker.human === true || speaker.accentSlot < 0) return "text-primary";
  return SLOT_TEXT[speaker.accentSlot % SLOT_TEXT.length] ?? "text-primary";
}

export function speakerFill(speaker: Pick<SpeakerView, "accentSlot" | "human" | "provisional">): string {
  // scope:"work"이거나 아직 승인되지 않은 노드는 채우지 않고 점선으로만 표기합니다.
  if (speaker.provisional === true) return "border border-dashed border-agent-provisional text-agent-provisional";
  if (speaker.human === true || speaker.accentSlot < 0) return "bg-user text-primary";
  return SLOT_FILL[speaker.accentSlot % SLOT_FILL.length] ?? "bg-user text-primary";
}

const typeLabel: Record<RoomMessageType, string> = {
  question: "질문",
  answer: "답변",
  proposal: "제안",
  challenge: "반론",
  review_request: "검토 요청",
  change_request: "수정 요구",
  evidence: "근거",
  decision: "결정",
  handoff: "인계",
  status: "상태",
};

export function AgentAvatar({ speaker }: { speaker: SpeakerView }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[8px] font-semibold ${speakerFill(speaker)}`}
    >
      {speaker.initial}
    </span>
  );
}

function SpeakerModel({ speaker }: { speaker: SpeakerView }) {
  return speaker.modelId ? (
    <span
      className="min-w-0 max-w-full break-words font-mono text-[10px] text-muted [overflow-wrap:anywhere]"
      title={translate("이 발화를 만든 모델")}
    >
      {speaker.modelId}
    </span>
  ) : null;
}

/**
 * 아바타 줄. 참가자가 늘어나도 폭이 무한히 자라지 않게 상한을 두되,
 * 잘린 사실을 말없이 감추지 않고 `+N`으로 표시합니다.
 */
export function SpeakerRow({ limit = 5, speakers }: { limit?: number; speakers: readonly SpeakerView[] }) {
  const shown = speakers.slice(0, limit);
  const hidden = speakers.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((speaker) => (
        <AgentAvatar key={speaker.handle} speaker={speaker} />
      ))}
      {hidden > 0 ? (
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-control text-[8px] font-semibold text-muted"
          title={speakers
            .slice(limit)
            .map((speaker) => speaker.name)
            .join(" · ")}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** 이름이 정체성이고 역할은 배지입니다. 같은 역할이 병렬로 돌아도 이름으로 구분됩니다. */
export function SpeakerName({ speaker }: { speaker: SpeakerView }) {
  return (
    <>
      <span className={`text-[12px] font-medium ${speakerText(speaker)}`}>{speaker.name}</span>
      <span className="rounded-[3px] border border-control px-1.5 text-[10px] font-medium text-muted">
        {translate(speaker.role)}
      </span>
      {/* 조직이 모델을 배치하므로 "누가 말했나"에는 "무엇으로 말했나"가 따라붙습니다. */}
      <SpeakerModel speaker={speaker} />
    </>
  );
}

function TypeTag({ speaker, type }: { speaker?: SpeakerView; type: RoomMessageType }) {
  // 반론은 화자 색을 띱니다. 무엇에 대한 반론인지가 인용으로 이미 보이므로 색이 화자를 가리킵니다.
  const toned =
    type === "challenge" && speaker ? `${speakerText(speaker)} border-current` : "text-muted border-control";
  return (
    <span className={`rounded-[3px] border px-1.5 text-[10px] font-semibold tracking-[0.06em] ${toned}`}>
      {translate(typeLabel[type])}
    </span>
  );
}

interface MarkdownNode {
  children?: MarkdownNode[];
  readonly position?: {
    readonly end: { readonly offset?: number };
    readonly start: { readonly offset?: number };
  };
  readonly type: string;
  readonly value?: string;
}

interface SourceRange {
  readonly end: number;
  readonly start: number;
}

interface MathDelimiter extends SourceRange {
  readonly bracket: "(" | ")" | "[" | "]";
  readonly slashCount: number;
}

function codeRanges(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];

  function visit(node: MarkdownNode) {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ end, start });
      return;
    }
    node.children?.forEach(visit);
  }

  visit(fromMarkdown(content) as MarkdownNode);
  return ranges.sort((left, right) => left.start - right.start);
}

function mathDelimiters(content: string): MathDelimiter[] {
  const delimiters: MathDelimiter[] = [];

  for (let index = 0; index < content.length;) {
    if (content[index] !== "\\") {
      index += 1;
      continue;
    }

    const start = index;
    while (content[index] === "\\") index += 1;
    const slashCount = index - start;
    const bracket = content[index];
    if (slashCount % 2 === 1 && (bracket === "(" || bracket === ")" || bracket === "[" || bracket === "]")) {
      delimiters.push({ bracket, end: index + 1, slashCount, start });
      index += 1;
    }
  }

  return delimiters;
}

function normalizedDelimiter(delimiter: MathDelimiter): string {
  return `${"\\".repeat(delimiter.slashCount - 1)}$$`;
}

function normalizeMathSegment(content: string): string {
  const pairs: { close: MathDelimiter; open: MathDelimiter }[] = [];
  let open: MathDelimiter | undefined;

  for (const delimiter of mathDelimiters(content)) {
    if (delimiter.bracket === "(" || delimiter.bracket === "[") {
      open = delimiter;
      continue;
    }

    const matchingOpen = delimiter.bracket === ")" ? "(" : "[";
    if (open?.bracket === matchingOpen) {
      pairs.push({ close: delimiter, open });
      open = undefined;
    }
  }

  if (pairs.length === 0) return content;

  let normalized = "";
  let offset = 0;
  for (const pair of pairs) {
    normalized += content.slice(offset, pair.open.start);
    normalized += normalizedDelimiter(pair.open);
    normalized += content.slice(pair.open.end, pair.close.start);
    normalized += normalizedDelimiter(pair.close);
    offset = pair.close.end;
  }
  return normalized + content.slice(offset);
}

function normalizeMathDelimiters(content: string): string {
  let normalized = "";
  let offset = 0;

  for (const range of codeRanges(content)) {
    normalized += normalizeMathSegment(content.slice(offset, range.start));
    normalized += content.slice(range.start, range.end);
    offset = range.end;
  }

  return normalized + normalizeMathSegment(content.slice(offset));
}

function isAsciiPunctuation(value: string | undefined): boolean {
  const code = value?.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126))
  );
}

function sourceOffsetAtValueOffset(
  node: MarkdownNode,
  source: string,
  value: string,
  valueOffset: number,
): number | undefined {
  const sourceStart = node.position?.start.offset;
  const sourceEnd = node.position?.end.offset;
  if (sourceStart === undefined || sourceEnd === undefined) return undefined;

  let renderedOffset = 0;
  let sourceOffset = sourceStart;
  while (renderedOffset < valueOffset && sourceOffset < sourceEnd) {
    const renderedCharacter = value[renderedOffset];
    const sourceCharacter = source[sourceOffset];
    const escapedCharacter = source[sourceOffset + 1];
    if (sourceCharacter === "\\" && isAsciiPunctuation(escapedCharacter) && escapedCharacter === renderedCharacter) {
      sourceOffset += 2;
      renderedOffset += 1;
      continue;
    }
    if (sourceCharacter !== renderedCharacter) return undefined;
    sourceOffset += 1;
    renderedOffset += 1;
  }

  return renderedOffset === valueOffset ? sourceOffset : undefined;
}

function hasExactSource(node: MarkdownNode, source: string, value: string, matchOffset: number, raw: string): boolean {
  const sourceOffset = sourceOffsetAtValueOffset(node, source, value, matchOffset);
  return sourceOffset !== undefined && source.slice(sourceOffset, sourceOffset + raw.length) === raw;
}

function splitStrongBeforeWordSuffix(node: MarkdownNode, source: string): MarkdownNode[] {
  const value = node.value;
  if (node.type !== "text" || value === undefined) return [node];

  const children: MarkdownNode[] = [];
  let valueOffset = 0;
  for (const match of value.matchAll(/(?<!\*)\*\*(?!\*)([^*\r\n]*\p{P})\*\*([\p{L}\p{M}\p{N}_]+)/gu)) {
    const matchOffset = match.index;
    const raw = match[0];
    const emphasized = match[1];
    const suffix = match[2];
    if (emphasized === undefined || suffix === undefined || !hasExactSource(node, source, value, matchOffset, raw)) {
      continue;
    }

    const prefix = value.slice(valueOffset, matchOffset);
    if (prefix.length > 0) children.push({ type: "text", value: prefix });
    children.push({ children: [{ type: "text", value: emphasized }], type: "strong" });
    children.push({ type: "text", value: suffix });
    valueOffset = matchOffset + raw.length;
  }

  const unclosed = /(?<!\*)\*\*(?!\*)(?![^\r\n]*\*\*)([^\r\n]+)$/u.exec(value);
  if (
    unclosed !== null &&
    unclosed.index >= valueOffset &&
    !value.slice(valueOffset, unclosed.index).includes("**") &&
    unclosed[1] !== undefined &&
    hasExactSource(node, source, value, unclosed.index, unclosed[0])
  ) {
    const prefix = value.slice(valueOffset, unclosed.index);
    if (prefix.length > 0) children.push({ type: "text", value: prefix });
    children.push({ children: [{ type: "text", value: unclosed[1] }], type: "strong" });
    valueOffset = value.length;
  }

  if (valueOffset === 0) return [node];
  const remainder = value.slice(valueOffset);
  if (remainder.length > 0) children.push({ type: "text", value: remainder });
  return children;
}

function remarkStrongBeforeWordSuffix() {
  return (tree: MarkdownNode, file: { readonly value: unknown }) => {
    const source = String(file.value);

    function transform(parent: MarkdownNode) {
      if (parent.children === undefined) return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type === "text") return splitStrongBeforeWordSuffix(node, source);
        transform(node);
        return [node];
      });
    }

    transform(tree);
  };
}

export function AgentMessageContent({
  compact = false,
  content,
  emphasized = false,
}: {
  compact?: boolean;
  content: string;
  emphasized?: boolean;
}) {
  const normalizedContent = useMemo(() => normalizeMathDelimiters(content), [content]);

  return (
    <div
      className={`min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_.katex-display]:overflow-x-auto [&_.katex]:text-inherit [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-control [&_blockquote]:pl-3 [&_blockquote]:text-secondary [&_code]:rounded-[3px] [&_code]:bg-canvas [&_code]:px-1 [&_code]:font-mono [&_h1]:my-3 [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-semibold [&_h4]:my-2 [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-[5px] [&_pre]:bg-canvas [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_td]:border [&_td]:border-control [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-control [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 ${
        compact
          ? "mt-1 break-words text-[12px] leading-5 text-secondary [overflow-wrap:anywhere] [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px]"
          : `${emphasized ? "mt-1.5 font-medium" : "mt-1"} text-[13px] leading-5 text-primary [&_h1]:text-[18px] [&_h2]:text-[16px] [&_h3]:text-[14px]`
      }`}
    >
      <ReactMarkdown
        components={{
          a: ({ children, href, title }) => (
            <a href={href || undefined} title={title}>
              {children}
            </a>
          ),
          img: ({ alt, src, title }) => <img alt={alt ?? ""} src={src || undefined} title={title} />,
          table: ({ children }) => (
            <div aria-label={translate("협업 메시지 표")} className="my-2 overflow-x-auto" role="region" tabIndex={0}>
              <table className="w-full min-w-[36rem] border-collapse text-left [&_tr>*:first-child]:min-w-16 [&_tr>*:first-child]:whitespace-nowrap">
                {children}
              </table>
            </div>
          ),
        }}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]}
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkStrongBeforeWordSuffix]}
        skipHtml
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

/** 챕터 구분선. 6단계 전환 지점에만 놓고 대화를 담지 않습니다. */
export function RoomChapter({ label, time, until }: { label: string; time: string; until?: string | undefined }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="text-[10px] font-semibold tracking-[0.08em] text-muted">{translate(label)}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {/* 범위는 두 끝이 다를 때만 범위입니다. 끝이 없으면 대시가 허공에 뜹니다. */}
      <time className="font-mono text-[11px] text-muted">
        {until !== undefined && until !== time ? `${time} – ${until}` : time}
      </time>
    </div>
  );
}

/**
 * 발언이 아니므로 아바타를 주지 않습니다.
 * 라이브 리전으로 만들지 않습니다. 화면의 알림 영역이 이미 role="status"이고,
 * 방의 상태 줄까지 읽어주면 스크린리더가 같은 사실을 두 번 말합니다.
 */
export function RoomStatus({ content }: { content: string }) {
  return <p className="py-1 text-center font-mono text-[11px] text-muted">— {content} —</p>;
}

/** 인계는 대화를 끊는 장벽이 아니라 방향이 바뀐 한 지점으로 표시합니다. */
export function RoomHandoff({
  content,
  from,
  time,
  to,
}: {
  content?: string | undefined;
  from: SpeakerView;
  time: string;
  to?: SpeakerView | undefined;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 py-1.5 pl-[27px]">
      <span aria-hidden="true" className={`font-mono text-[12px] ${speakerText(from)}`}>
        ↳
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <p className="font-mono text-[11px] text-muted">
            {translate("인계 ·")} <span className={speakerText(from)}>{from.name}</span>
            {/* 과거 메시지처럼 받는 쪽을 모르면 넘긴 쪽만 말하고 지어내지 않습니다. */}
            {to ? (
              <>
                {" → "}
                <span className={speakerText(to)}>{to.name}</span>
              </>
            ) : null}{" "}
            · {time}
          </p>
          <SpeakerModel speaker={from} />
        </div>
        {content ? <AgentMessageContent compact content={content} /> : null}
      </div>
    </div>
  );
}

export interface RoomMessageProps {
  speaker: SpeakerView;
  content: string;
  evidence?: { label: string; checksum: string } | undefined;
  /** 조직이 사용자에게 돌려준 답. 흐름의 마지막 한 줄이 다른 발언과 같은 무게로 지나가지 않게 합니다. */
  final?: boolean | undefined;
  indented?: boolean | undefined;
  quoted?: RoomQuote | undefined;
  recipient?: string | undefined;
  signature?: { by: string; revision: number } | undefined;
  target?: string | undefined;
  time: string;
  type: Exclude<RoomMessageType, "handoff" | "status" | "proposal">;
}

export function RoomMessage({
  speaker,
  content,
  evidence,
  final,
  indented,
  quoted,
  recipient,
  signature,
  target,
  time,
  type,
}: RoomMessageProps) {
  return (
    <article
      className={`grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 ${
        final ? "rounded-[7px] border border-control bg-surface-1 px-3 py-3" : ""
      } ${indented ? "pl-[27px]" : ""}`}
    >
      <AgentAvatar speaker={speaker} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* 최종 응답은 칩 하나로 줄 세우지 않습니다. 이 방에서 하나뿐인 줄이라 먼저 섭니다. */}
          {final ? (
            <span className="rounded-[3px] bg-fg px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] text-canvas">
              {translate("최종 응답")}
            </span>
          ) : null}
          <SpeakerName speaker={speaker} />
          <TypeTag speaker={speaker} type={type} />
          <time className="font-mono text-[11px] text-muted">
            {recipient ? `→ ${recipient} · ` : ""}
            {target ? `${target} · ` : ""}
            {time}
          </time>
        </div>
        {quoted ? (
          <blockquote className="my-1.5 border-l-2 border-control pl-2.5 text-[12px] text-muted">
            {quoted.author} · {quoted.time} — {quoted.content}
          </blockquote>
        ) : null}
        {speaker.human === true ? (
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-primary [overflow-wrap:anywhere]">
            {content}
          </p>
        ) : (
          <AgentMessageContent content={content} emphasized={final === true} />
        )}
        {evidence ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-[3px] border border-current px-1.5 text-[10px] font-semibold tracking-[0.06em] ${speakerText(speaker)}`}
            >
              {translate("근거")}
            </span>
            <span className="text-[12px] text-secondary">{evidence.label}</span>
            <span className="font-mono text-[11px] text-muted">checksum {evidence.checksum}</span>
          </p>
        ) : null}
        {signature ? (
          <p className="mt-1.5 font-mono text-[11px] text-muted">
            {translate("서명")} {signature.by} {translate("· 개정")} {signature.revision}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export interface ProposalActivityProps {
  speaker: SpeakerView;
  change: OrganizationChangeView;
  content: string;
  decided: boolean;
  disabled: boolean;
  disabledReason?: string;
  onApprove: () => void;
  onReject: () => void;
  time: string;
}

/**
 * 조직 변경 제안. 추가되는 역량·수명·영향·되돌리기를 버튼보다 먼저 보입니다.
 * 사람이 결정해야 하므로 gate 색을 쓰는 자리입니다.
 */
export function ProposalActivity({
  speaker,
  change,
  content,
  decided,
  disabled,
  disabledReason,
  onApprove,
  onReject,
  time,
}: ProposalActivityProps) {
  const primary = change.nodes[0];
  const proposalName = primary
    ? `${primary.name}${change.nodes.length > 1 ? ` 외 ${String(change.nodes.length - 1)}개` : ""}`
    : "조직 변경";
  return (
    <article className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5">
      <AgentAvatar speaker={speaker} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SpeakerName speaker={speaker} />
          <span className="rounded-[3px] border border-gate px-1.5 text-[10px] font-semibold tracking-[0.06em] text-gate">
            {translate("제안")}
          </span>
          <time className="font-mono text-[11px] text-muted">{time}</time>
        </div>
        <p className="text-[13px] leading-5 text-primary">{content}</p>

        <section
          aria-label={`${translate("조직 변경 제안")} ${proposalName}`}
          className={`mt-2 rounded-[7px] border ${decided ? "border-border bg-surface-1" : "border-gate-border bg-gate-wash"}`}
        >
          <header className="flex items-center border-b border-gate-border px-3.5 py-2.5">
            <h4 className="min-w-0 flex-1 text-[13px] font-medium">
              {proposalName} {translate("신설")}
            </h4>
            <span className="text-[11px] font-medium text-gate">{translate(decided ? "처리됨" : "승인 필요")}</span>
          </header>

          <div className="divide-y divide-border border-b border-gate-border px-3.5">
            {change.nodes.map((node) => (
              <div className="flex items-start gap-2.5 py-3" key={node.handle}>
                <AgentAvatar
                  speaker={{
                    handle: node.handle,
                    name: node.name,
                    initial: node.name.slice(0, 1),
                    accentSlot: agentIdentityToken(node.handle, nodeRoleLabel[node.role]).accentSlot,
                    role: node.role,
                    provisional: true,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <h5 className="text-[13px] font-medium">{node.name}</h5>
                  <p className="text-[11px] text-muted">
                    {agentIdentityToken(node.parentHandle).name} {translate("아래 ·")}{" "}
                    {translate(nodeRoleLabel[node.role])} {translate("역할 ·")} {translate(scopeLabel[node.scope])}
                  </p>
                  <p className="mt-1 text-[10px] font-semibold tracking-[0.08em] text-muted">
                    {translate("추가되는 역량")}
                  </p>
                  <p className="mt-0.5 text-[12px] text-secondary">{node.capabilities.join(" · ")}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-x-6 gap-y-3 px-3.5 py-3 min-[900px]:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">{translate("영향")}</p>
              <p className="mt-1 text-[12px] text-secondary">
                {translate("노드")} {change.impactNodes}
                {translate("개 · 참조")} {change.impactReferences}
                {translate("건")}
              </p>
              {change.impactHandles.length === 0 ? null : (
                <p className="text-[11px] text-muted">
                  {change.impactHandles.map((handle) => agentIdentityToken(handle).name).join(" · ")}
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">{translate("조직 버전")}</p>
              <p className="mt-1 font-mono text-[11px] text-muted">
                {translate("조직 버전")} {change.fromVersion} → {change.toVersion}
              </p>
            </div>
            {change.lifetime === undefined ? null : (
              <div>
                <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">
                  {translate("이 업무가 끝나면")}
                </p>
                <p className="mt-1 text-[12px] text-secondary">{change.lifetime}</p>
              </div>
            )}
            {change.revertable === undefined ? null : (
              <div>
                <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">{translate("되돌리기")}</p>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {translate(change.revertable ? "Revert 가능" : "Revert 불가")}
                </p>
              </div>
            )}
          </div>

          {change.compliance === undefined && decided ? null : (
            <footer className="flex flex-wrap items-center gap-2 border-t border-gate-border px-3.5 py-2.5">
              {change.compliance === undefined ? (
                <span className="flex-1" />
              ) : (
                <p className="flex-1 text-[11px] text-muted">
                  {translate("조직 검사 통과 ·")}{" "}
                  {change.compliance.map((code) => translate(complianceLabel[code])).join(" · ")}
                </p>
              )}
              {decided ? null : (
                <div className="flex items-center gap-3">
                  {disabled && disabledReason ? <span className="text-[11px] text-muted">{disabledReason}</span> : null}
                  {disabled ? null : (
                    <DecisionActions approveName={`${proposalName} 신설`} onApprove={onApprove} onReject={onReject} />
                  )}
                </div>
              )}
            </footer>
          )}
        </section>
      </div>
    </article>
  );
}

/**
 * 하위 협업방 참조. 대표 방 안에서 갈라진 지점에 인라인으로 나타납니다.
 * 모든 방을 탭으로 자동 추가하면 탭 바가 감당하지 못하므로, 누를 때만 엽니다.
 */
export function RoomReference({
  lastLine,
  messageCount,
  name,
  onOpen,
  participants,
  time,
  waiting,
}: {
  lastLine: string;
  messageCount: number;
  name: string;
  onOpen: () => void;
  participants: SpeakerView[];
  time: string;
  waiting: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-[7px] border px-3.5 py-2.5 ${
        waiting ? "border-gate-border bg-gate-wash" : "border-border bg-surface-1"
      }`}
    >
      <SpeakerRow limit={3} speakers={participants} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{name}</span>
          <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
            {translate("갈라진 방 ·")} {messageCount}
          </span>
          {waiting ? <span className="text-[11px] text-gate">{translate("◇ 확인 필요")}</span> : null}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-muted">{lastLine}</p>
      </div>
      <time className="shrink-0 font-mono text-[11px] text-muted">{time}</time>
      {/*
       * 카드 전체를 버튼으로 두지 않습니다. 오클릭 한 번에 읽던 대화의 맥락을 잃습니다.
       * 진입은 명시적 버튼으로만 합니다.
       */}
      <OpenButton label={`${translate("협업방")} ${name} ${translate("열기")}`} onOpen={onOpen} />
    </div>
  );
}
