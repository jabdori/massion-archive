# ADR-004 — Runtime 협업 기록의 내구성 경계

> **상태:** 승인됨
> **승인일:** 2026-08-09
> **대상:** `REQ-AGENT-HARNESS-001`, 헌법 §4.4, 아키텍처 §7

## 맥락

헌법 §4.4는 **대화가 아니라 Work와 버전된 사건이 실행·복구의 정본**이며 "모델의 transcript만으로 조직 상태나 완료를 복원하지 않는다"고 정합니다.

협업방 도메인은 그 요구를 이미 충족합니다 — 메시지 10종, `reply`·`caused-by` 인과, 동시 커밋의 고유 sequence, 라운드·token·비용 한계가 계약과 테스트로 존재합니다. VoltAgent 위임도 구현돼 있어 `voltagent-topology.ts`가 조직 그래프를 supervisor·subAgent로 배선합니다.

**그러나 둘이 연결돼 있지 않았습니다.** `packages/runtime/src`에 `postMessage` 호출이 0건이었고, 생산 경로에서 협업 메시지를 남기는 곳은 `core-pipeline.ts` 두 지점(사용자 요청, Representative handoff)과 `core-staffing.ts`의 편성 제안, 그리고 Surface가 부르는 공개 command뿐이었습니다. 에이전트끼리 묻고 답하고 인계하는 장면은 VoltAgent 메모리에서 끝나고 재시작에 사라졌습니다.

연결을 막은 것은 배관 부재가 아니라 **내구성 경계를 정하지 못한 것**입니다. 이미 있는 seam이 다음 제약을 겁니다.

```
ExecutionDelta          contracts.ts  — "휘발성 신호, 도메인 정본 아님, 저장소에 기록하지 않음"
ExecutionDeltaObserver  contracts.ts  — "동기 fire-and-forget: 예외·배압을 실행 경로에 전파하지 않음"
```

관찰자 안에서 그대로 저장하면 두 가지가 동시에 깨집니다. `await`하면 fire-and-forget 계약이 깨져 기록 지연·실패가 에이전트 실행을 물고 들어가고, `await`하지 않으면 커밋 전 crash에서 메시지가 조용히 사라집니다.

## 결정

### 1. 델타는 계속 휘발성으로 둡니다

`ExecutionDelta`의 성격을 바꾸지 않습니다. 화면이 흘려보는 실시간 신호는 `ExecutionStreamRegistry`가 계속 소유하고, 저장소에 남기지 않습니다. 재연결 복구는 지금처럼 `work.timeline` 재조회가 담당합니다.

대신 `toolInput`·`toolOutput` 두 선택 필드를 추가합니다. `delegate_task`에서 **누구에게 무엇을 시켰고 무엇이 돌아왔는지**는 기존 `toolName`·`toolCallId`만으로 알 수 없고, 기존 `summary`는 화면 미리보기용 500자라 기록 본문으로 쓸 수 없기 때문입니다. 두 필드는 8,000자를 넘으면 잘린 문자열 대신 필드 자체를 비웁니다 — 반쪽 JSON을 넘기면 읽는 쪽이 파싱에 실패하고 그 이유를 알 수 없습니다.

### 2. 기록기는 Application 계층에 둡니다

`CollaborationRuntimeRecorder`가 `ExecutionDeltaObserver`를 구현하고 `packages/application`에 삽니다. Runner(`packages/runtime`)는 works 도메인을 몰라야 하고, 반대로 works는 VoltAgent를 몰라야 합니다. 두 계약을 모두 아는 유일한 층이 Application입니다.

`voltagent-runner`는 고치지 않습니다. `apps/server`의 composition root가 기존 `executionStream`과 새 기록기를 하나의 관찰자로 합쳐 주입합니다.

### 3. 내구성 경계는 «관찰 시점 큐 + 명시적 drain»입니다

- `observe()`는 판단만 하고 즉시 돌려줍니다. 던지지도, 기다리지도 않습니다.
- 커밋은 실행별 promise chain으로 직렬화합니다. 답변이 인계보다 먼저 커밋되면 `replyToMessageId`를 채울 수 없기 때문입니다.
- 미완 커밋은 기록기가 자체 추적하고 `drain()`이 기다립니다. 정상 종료와 테스트가 이 지점을 씁니다.
- `commandId`는 `${executionId}:collab:${sequence}:${index}`로 실행에서 결정됩니다. 재시도·복구가 같은 델타를 다시 관찰해도 도메인의 command 원장이 replay로 흡수하므로 방이 부풀지 않습니다.
- 커밋 실패는 삼키지 않고 `onFailure`로 올려 `collaboration.record.failed` 이벤트가 됩니다.

**남는 손실 창은 «관찰과 커밋 사이의 process crash»입니다.** 그 순간 실행도 terminal이 아니므로 복구가 같은 실행을 다시 돌리고, 같은 `commandId`로 메시지가 재생성됩니다. 즉 조용히 사라지는 것은 **완료된 대화가 아니라 완료되지 않은 실행의 중간 상태**이며, 그것은 애초에 사실이 된 적이 없습니다.

### 4. 기록기는 방을 만들지 않습니다

협업방 생성은 `core-pipeline`이 Work revision과 함께 소유합니다. 기록기가 방을 열면 같은 Work의 revision을 두 곳이 다투게 됩니다. 방이 아직 없으면 기록기는 조용히 지나갑니다.

### 5. 없는 발화를 만들지 않습니다

`delegate_task` 한 번은 정확히 **인계 하나와 답변 하나**입니다(대상이 여럿이면 대상마다 한 쌍).

`challenge`·`change_request`·`review_request`·`decision`·`evidence`·`proposal`은 VoltAgent 기본 위임에서 자연히 나오지 않습니다. 에이전트의 프롬프트나 도구가 그런 발화를 실제로 만들게 되면 그때 매핑합니다. 지금 매핑하면 화면이 일어나지 않은 논쟁을 그립니다.

답변의 `recipientAgentId`는 채우지 않습니다 — 도메인이 수신 Agent를 `handoff`에만 허용하며, 답변의 수신자는 `replyToMessageId` 인용이 이미 말합니다. (이 제약은 스텁 테스트가 아니라 실제 도메인 통합 테스트에서 드러났습니다.)

## 결과

- `work.messages`·`work.rooms` 조회가 이미 `ApplicationQueryMapV1`에 있고 데스크톱 `room.tsx`가 인용 반론·들여쓴 답변·화자 전환선을 그리므로, **연결만으로 화면이 채워집니다.**
- 방 예산(`usedTokens`·`usedCostMicros`)은 방 레코드가 아니라 메시지 합으로 계산되므로 기록기가 메시지마다 token을 셉니다. 0을 넣으면 소비가 영원히 0으로 보입니다.
- `executionId`가 메시지에 실려 실행과 대화의 계보가 이어집니다.
- 참가자가 아닌 Agent(예: 방에 합류하지 않은 동적 편성 노드)에게 위임하면 도메인이 거부하고, 그 거부는 실행을 죽이지 않고 기록 실패로 남습니다. 동적 편성 Agent를 방에 참여시키는 것은 별도 작업입니다.

## 대안과 기각 이유

- **관찰자 안에서 동기 커밋** — fire-and-forget 계약을 깨고 기록 지연·실패가 에이전트 실행을 물고 들어갑니다.
- **런타임에 durable delta outbox 신설** — 델타를 정본으로 승격하는 것이라 "휘발성 신호" 계약을 뒤집고, 같은 사실을 두 원장에 남깁니다.
- **실행 terminal 결과에서 재구성** — `AgentExecutionResult`에 tool 호출이 없습니다. 결과만으로는 위임이 있었는지 알 수 없습니다.
- **`voltagent-runner`가 직접 기록** — runner가 works 도메인을 알게 되어 계층이 뒤집힙니다.
- **fixture의 풍부한 대화를 실제 메시지로 재포장** — 인계서 §0.E.2가 금지한 것입니다. 일어나지 않은 협업을 사실로 만듭니다.
