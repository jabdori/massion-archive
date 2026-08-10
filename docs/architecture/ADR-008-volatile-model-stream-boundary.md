# ADR-008 — 모델 stream part는 휘발성 관찰 경계로 제한한다

> **상태:** 승인됨
> **승인일:** 2026-08-10
> **대상:** VoltAgent Runner, Runtime Event, Application outbox·공개 event, 재시작 복구

## 맥락

`VoltAgentRunner.stream()`은 AI SDK `fullStream`의 모든 part를 `model_*` Runtime Event로 저장했습니다. text
chunk뿐 아니라 reasoning·tool fragment·stream lifecycle까지 part 하나마다 interactive transaction 하나와
Application outbox 하나를 만들었습니다. 이 값은 제품 정본 소비자가 없고 `ExecutionDeltaObserver`가 지원하는
semantic 정보를 이미 화면과 협업 기록기에 전달하므로, chunk 수에 비례한 저장·projection 비용만 남겼습니다.

Runtime Event의 소비자는 실행 상태·route·구독 receipt·terminal 결과를 사용합니다. 모델의 부분 text를 읽어
실행을 복구하거나 완료를 판정하지 않습니다. `RuntimeRecovery`도 실행을 다시 이어 쓰지 않고, checkpoint가
없는 `running` 실행을 `interrupted`로 닫습니다. 따라서 중간 part를 영속해도 crash 복구가 좋아지지 않고,
오히려 확정되지 않은 출력과 reasoning·tool 인자를 장기간 남깁니다.

## 결정

### 1. `fullStream` part는 휘발성으로만 관찰합니다

Runner는 non-empty text·reasoning delta, tool call·result, error, finish만 기존 `ExecutionDeltaObserver`에
전달합니다. stream/text/reasoning start·end 같은 raw 경계 part와 빈 text는 버립니다. 어떤 raw part도
`runtime_event`에 append하거나 `AgentExecutionEvent`로 yield하지 않습니다. observer는 동기
fire-and-forget이며 오류와 배압을 실행 경로에 전파하지 않는 기존 계약을 유지합니다.

현재 lifecycle delta는 Provider `finish` part만 나타냅니다. blocked·cancel·lease terminal 상태를 observer의
lifecycle delta로 알리는 경로는 아직 구현되지 않았고, Surface는 durable terminal event와 `work.timeline`
재조회로 판정합니다. 이 상태들을 semantic lifecycle delta로 추가하는 것은 후속 목표이며 현재 완료 근거가
아닙니다.

text delta 수는 실행 중 로컬 `emittedTokens`로 계속 집계합니다. 성공 시 Provider가 확정한 usage로 lease를
정산합니다. 부분 출력 뒤 stream error 또는 usage 없는 Agent Runtime 실패에서는 `emittedTokens`만 fallback
차단·부작용 sentinel로 보존하고, Provider-confirmed usage가 없으므로 actual input·output token과 cost는 0으로
기록합니다. 실패·취소 terminal에서도 Provider가 두 token 수를 확정했다면 그 usage는 receipt와 Route Attempt에
그대로 보존합니다. chunk·fragment 수를 실제 token 사용량으로 간주하지 않습니다. 휘발성과 비용 계보는
별개의 경계입니다.

### 2. 실행 정본은 상태·route·receipt·terminal 사실입니다

일반 모델 stream 성공 한 건은 chunk 수와 무관하게 다음 Runtime Event 네 건만 만듭니다.

1. `execution_queued`
2. `execution_running`
3. `model.route.selected`
4. `execution_succeeded` 또는 다른 terminal event

구독 Agent Runtime은 session 획득·호출 시작·checkpoint·terminal 관찰·정산 완료 receipt를 계속 영속합니다.
Route Attempt, credential lease, 실제 token·비용 정산도 기존 Router·Subscription 원장에 남습니다. 이번 결정은
이 계보를 줄이지 않고 raw SDK part만 정본에서 제외합니다.

### 3. 중간 crash에서는 부분 출력을 폐기하고 기존 복구를 사용합니다

terminal 전 process가 종료되면 실행은 `running`으로 남습니다. startup recovery는 workflow checkpoint가 없으면
`execution_interrupted`를 추가하고 명시적 retry 대상으로 만듭니다. 부분 text·reasoning·tool fragment는 출력이나
Artifact가 아니므로 복원하지 않습니다. 정상 성공의 확정 text는 기존처럼 terminal `output_json`에 한 번 저장합니다.

### 4. 과거 raw event는 cursor를 보존한 tombstone으로 retire합니다

Application migration `0121-application-runtime-stream-retirement`는 하나의 transaction에서 다음만 수행합니다.

- event type이 `model_`로 시작하는 과거 raw Runtime Event의 ID·실행 ID·command ID·sequence·시각은 보존합니다.
- `request_json`·`payload_json`·`result_json`을 정확히 `{}`로 바꿉니다.
- 이미 공개 event가 있는 pending outbox는 그 공개 event ID로 `projected` 상태를 정합화합니다.
- 공개 event가 없는 pending raw outbox만 삭제합니다.
- 기존 projected outbox, immutable `application_event`, 공개 sequence·cursor, `runtime_execution`의 version과
  `event_sequence`는 변경하지 않습니다.

Runtime Event 자체를 삭제하거나 sequence를 다시 매기지 않는 이유는 recovery cursor와 감사 계보를 유지하기
위해서입니다. 이미 공개된 event를 삭제·수정하지 않는 이유도 동일합니다. Tombstone된 과거 stream command를
직접 replay하면 기존 request hash 역할을 하는 JSON과 일치하지 않아 명시적으로 fail-closed합니다. 생산 재시작은
terminal short-circuit 또는 `running → interrupted` 경로를 사용하므로 raw command replay에 의존하지 않습니다.

## 결과

- 1개와 1,600개 text chunk가 같은 네 Runtime Event와 네 Application outbox만 만듭니다.
- 지원 semantic 화면 delta, `emittedTokens`, lease 정산, route 선택, 구독 receipt, terminal 출력·오류는 유지됩니다.
- 부분 stream·Agent Runtime error는 fallback sentinel과 실제 usage를 분리해 확인되지 않은 token·cost를 만들지 않습니다.
- blocked·cancel·lease terminal의 observer lifecycle delta는 아직 없으며 durable timeline이 현재 정본입니다.
- 부분 출력 뒤 오류는 확정 출력으로 저장되지 않고 raw marker도 새로 만들지 않습니다.
- Application projector가 raw chunk backlog를 처리하느라 Work 상태 projection을 지연시키지 않습니다.
- 과거 공개 sequence와 Runtime recovery cursor에는 gap이나 재번호 매김이 생기지 않습니다.

## 기각한 대안

- **raw part를 계속 영속하고 projector에서만 무시:** transaction·outbox·저장 비용과 민감 fragment 보존이 남습니다.
- **과거 raw Runtime Event를 전부 삭제:** execution cursor와 감사 sequence를 파괴합니다.
- **projected 공개 event까지 cascade 삭제:** immutable 공개 sequence에 gap을 만들고 재연결 cursor 계약을 깹니다.
- **과거 JSON을 그대로 보존:** reasoning·tool 인자·부분 출력의 불필요한 장기 보존을 해결하지 못합니다.
- **부분 text로 crash 실행 재개:** 모델 stream은 결정적으로 이어 쓸 수 없고 현재 recovery도 재실행하지 않습니다.
