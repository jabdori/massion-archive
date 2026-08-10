# Phase 30 — UX-0 선행 판정 결과

> **상태**: decided
> **판정일**: 2026-07-21
> **관계**: [에이전틱 도구 UX 벤치마크와 재설계 계획](agent-ux-benchmark-and-redesign-plan.md)의 UX-0 슬라이스

## 판정 ① `@opentui/solid` 채택 — 가결

Bun 1.3.14에서 `@opentui/solid@0.4.3`(현행 `@opentui/core@0.4.3`과 동일 버전 라인)을 검증했습니다.

| 검증 항목 | 결과 |
|---|---|
| 설치·버전 정렬 | `@opentui/solid@0.4.3` 존재, peer `solid-js@1.9.12` |
| Bun JSX 변환 | `bunfig.toml`의 `preload = ["@opentui/solid/preload"]`로 해결 (test preload 포함) |
| headless 렌더 | 패키지 자체 `testRender` API가 `@opentui/core/testing`의 `TestRendererSetup`을 반환 — 기존 `open-tui.bun.test.ts` 방식과 호환 |
| 반응형 갱신 | `createSignal` 갱신 → `renderOnce()` → `captureCharFrame()`으로 스트리밍 append 확인 |

**결정**: UX-3 TUI 재설계의 렌더 계층은 `@opentui/solid` 컴포넌트 방식으로 구현합니다. `apps/tui`에 `bunfig.toml` preload 추가가 필요하며, `state.ts`·`view-model.ts`·`presentation.ts`의 순수 로직·테스트는 보존하고 렌더 계층만 교체합니다.

주의: `render()`(비 test)는 Promise를 반환하므로 부트스트랩에서 await해야 합니다. 테스트는 `testRender`를 사용합니다.

## 판정 ② Runtime 델타 관측 지점 — 확정

> **후속 정정 2026-08-10:** 아래 관찰자 결정은 유지되지만 raw stream 영속에 관한 당시 구현 설명과
> 「이번 범위에서 변경하지 않는다」는 제한은 [ADR-008](../../architecture/ADR-008-volatile-model-stream-boundary.md)이
> 대체합니다. 현재 Runner는 지원 semantic delta만 observer로 전달하고 raw part를 Runtime Event로 저장하지
> 않습니다.

### 현재 코드 사실

| 사실 | 위치 |
|---|---|
| `AgentRunner.stream()` 계약이 이미 존재, `AgentExecutionEvent { executionId, sequence, type, payload, createdAt }`를 yield | `packages/runtime/src/contracts.ts` |
| `stream()` 구현은 AI SDK `streamText`의 `fullStream` 중 non-empty text·reasoning, tool call·result, error, finish만 휘발성 `ExecutionDelta`로 관찰하고 start·end raw part는 버림 | `packages/runtime/src/voltagent-runner.ts` |
| Runtime 정본은 queued·running·route·terminal이며 raw `model_*` part와 chunk별 outbox는 생성하지 않음 | 같은 파일, ADR-008 |
| 일반 Work 전달 경로는 비스트리밍 `execute()` → `generateWithFallback`(generateText)를 사용 — **전달 중 델타가 아예 발생하지 않음** | `packages/application/src/core-delivery-stage.ts` |
| 현재 `stream()` 소비자는 Assurance 단계와 server product 조립뿐 | `packages/application/src/core-assurance-stage.ts`, `apps/server/src/product.ts` |

### 결정 — ExecutionDeltaPort (휘발성 관찰자)

**관찰자 port를 Runner에 주입**하고 제공자 스트리밍 루프에서 영속과 무관하게 호출합니다. 당시 존재한
토큰당 DB write는 ADR-008에서 제거했습니다.

```ts
// packages/runtime — 신규 계약 (UX-2에서 구현)
export interface ExecutionDelta {
  readonly executionId: string;
  readonly agentHandle: string;
  readonly sequence: number; // 실행별 휘발성 카운터, execution store event_sequence와 무관
  readonly kind: "output-text" | "reasoning" | "tool-call" | "tool-result" | "lifecycle" | "error";
  readonly text?: string; // output-text · reasoning 델타
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly summary?: string; // tool-result 요약 (원문 아님)
  readonly occurredAt: string;
}

export interface ExecutionDeltaObserver {
  // 동기 fire-and-forget: 예외·배압을 실행 경로에 전파하지 않음
  observe(context: TenantContext, delta: ExecutionDelta): void;
}
```

적용 원칙:

1. `execute()` 내부 모델 호출을 스트리밍 기반으로 통일하되, **영속은 확정 경로**(상태·route·결과 전이)만 기록하고 델타는 observer로만 흘립니다. `stream()`의 과거 토큰당 `appendEvent` 동작은 ADR-008에서 제거했습니다.
2. Application은 `ExecutionStreamRegistry`로 observer를 구현해 tenant 검증을 통과한 SSE 구독자에게 fan-out합니다 (재연결 replay 없음 — `work.timeline` 재조회로 복구).
3. 현재 `lifecycle` delta는 Provider `finish`만 전달합니다. blocked·취소·lease terminal의 observer delta는 아직 구현되지 않았고 종료 판정은 durable event와 `work.timeline` 재조회가 소유합니다. 해당 terminal delta 추가는 후속 목표입니다.

## 다음 단계

- UX-1 `work.timeline` 계약과 UX-2 `ExecutionDeltaPort` 구현은 이 판정을 전제로 진행합니다.
- WS-1 첫 조각(`@massion/workspace` 도메인: 등록·신뢰·격리·archive, migration `0106-workspace`)은 계약 테스트 7건과 함께 구현됐습니다. 남은 조각은 Work `workspaceId` 바인딩과 capability 계약 노출입니다.
