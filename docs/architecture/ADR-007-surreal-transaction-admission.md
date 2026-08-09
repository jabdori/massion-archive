# ADR-007 — 공유 Surreal client의 interactive transaction을 직렬 승인한다

> **상태:** 승인됨
> **승인일:** 2026-08-10
> **대상:** Storage facade, Application projection, Subscription Workspace 실행

## 맥락

실제 환불 지연 Work에서 같은 Surreal JavaScript client가 여러 interactive transaction을 동시에 열었고
`Transaction … not found` 경고와 수십 초의 projection 지연이 반복됐습니다. 16개 읽기 transaction을 같은
client에 동시에 보낸 재현에서는 작업 동시성이 16까지 올라갔습니다. 개별 transaction은 성공할 수 있어도
client의 transaction 상태가 경합하면서 retry가 중첩되고 UI가 DB보다 오래 뒤처졌습니다.

Storage wrapper와 Event Projector가 각각 retry를 소유했던 기존 구조는 한 poll에서 재시도를 곱했습니다.
Projector 외부 retry와 idle poll transaction은 ADR 이전 수정에서 제거했지만, 실제 Work command가 동시에
transaction을 열 수 있는 경계는 남았습니다.

또한 Subscription Workspace 확인은 transaction 안에서 `lstat`·`realpath` 파일 I/O를 기다렸습니다. 느리거나
응답하지 않는 volume 하나가 공유 client의 모든 후속 transaction과 종료를 막을 수 있습니다.
[SurrealDB 공식 transaction 가이드](https://surrealdb.com/docs/reference/javascript/concepts/transactions)도
validation과 외부 호출을 transaction 전에 수행하고 transaction을 짧게 유지하라고 요구합니다.

## 결정

### 1. `MassionDatabase` 인스턴스마다 transaction FIFO 하나를 둡니다

승인된 호출은 `begin → operation → commit/cancel → bounded retry` 전체 수명 동안 FIFO 소유권을 유지합니다.
다음 호출은 앞 호출의 성공·실패와 무관하게 release 뒤에만 시작합니다. retry를 큐 밖으로 내보내지 않아 같은
작업의 재시도 사이에 다른 transaction이 끼어들지 않습니다.

콜백에 전달하는 transaction executor도 query 호출 순서를 보존합니다. 호출자가 `Promise.all`로 여러 query를
예약해도 같은 interactive transaction에는 한 번에 하나만 전송합니다. 정상 콜백은 executor를 봉인하고
예약된 query를 모두 기다린 뒤 commit합니다. 콜백이 실패하면 원래 오류를 보존하고 executor를 중단한 뒤,
멈춘 query를 기다리지 않는 bounded cancel로 FIFO를 해제합니다. 첫 query 실패 뒤의 후속 예약 query와 콜백
종료 뒤의 새 query는 SDK에 보내지 않습니다. 호출자별 직렬화는 누락되기 쉬우므로 Storage 경계가 이
불변량을 소유합니다.

일반 query, version, import, export는 FIFO에 넣지 않습니다. interactive transaction 경합이 실제 원인이며,
모든 읽기까지 직렬화하면 불필요한 지연을 만듭니다. 대신 종료가 이미 승인된 작업을 자르지 않도록 활성 client
operation을 추적합니다.

개인용 v1에서는 DB 인스턴스 단위 FIFO가 가장 작은 안전 경계입니다. 실제 transaction 대기 시간이 병목으로
측정되면 tenant·session별 client로 분리하지만, 동시 transaction을 같은 client에 다시 여는 방식으로
최적화하지 않습니다.

### 2. 재귀 transaction과 transaction 내부 종료는 즉시 거절합니다

`AsyncLocalStorage`로 현재 transaction scope를 표시합니다. 같은 `MassionDatabase`의 재귀 transaction은
두 번째 `begin` 전에, transaction 안의 `close()`는 자기 자신을 기다리기 전에 typed lifecycle error로
거절합니다. 종료 terminal 경로에서는
[Node `AsyncLocalStorage.disable()` 계약](https://nodejs.org/api/async_context.html#asynclocalstoragedisable)에
따라 `disable()`을 호출해 wrapper가 garbage collection될 수 있게 합니다.

### 3. Governance 승인은 원자 변경 전에 준비하고 permit은 원자 변경 안에서 소비합니다

Dynamic Staffing처럼 승인 생성과 여러 도메인 변경을 함께 조정하는 경로는 승인 요청을 이미 열린
interactive transaction 안에서 만들지 않습니다. 저장된 proposal의 replay·계보를 먼저 확인한 뒤, 승인이
없는 `prepared` proposal만 Organization 변경을 사전 승인합니다. 사람 승인이 필요하면 Policy Decision과
Approval을 transaction 밖에 보존하고 proposal을 `awaiting-approval`로 전이합니다.

정책이 즉시 허용하면 Organization service가 organization·사용자·논리 command hash에 묶인 비직렬화
authorization receipt를 발급합니다. 외부 transaction의 replay 확인이 끝난 뒤 정확히 일치하는 receipt만
새 변경에 사용할 수 있습니다. 실제 graph·협업 메시지·Task Assignment·proposal checkpoint는 여전히 하나의
상위 transaction에서 적용되므로 중간 crash와 bounded retry가 부분 적용을 남기지 않습니다.

receipt는 graph 변경 결과가 만들어지는 즉시 소비합니다. 상위 transaction이 이후 rollback하더라도 같은
receipt는 다시 쓸 수 없고 다음 시도는 정책을 다시 평가해야 합니다. 이미 commit된 command의 replay는 receipt
검사보다 먼저 원장을 확인하므로 새 권한 없이 기존 결과만 반환합니다.

승인 후 재개할 때는 Approval·Policy Decision·Emergency 상태 조회와 Permit 소비를 graph 변경과 같은
transaction executor로 수행합니다. 따라서 뒤의 메시지나 Assignment가 실패하면 Permit 소비도 함께
rollback됩니다. 새 run retry command는 기존 approval ID에 연결된 proposal을 다시 사용하며, 알 수 없거나
다른 Work의 approval ID로 새 proposal을 만들지 않습니다.

### 4. 종료는 새 작업을 막고 이미 승인한 작업만 drain합니다

첫 `close()`가 상태를 동기적으로 `closing`으로 바꾸므로 이후 query·transaction·version·import·export는
시작되지 않습니다. 이미 FIFO에 들어온 transaction과 이미 시작한 client operation을 기다린 뒤 underlying
client를 한 번만 닫습니다. 여러 `close()` 호출은 같은 promise를 공유합니다.

underlying close가 실패해도 instance는 다시 사용 가능한 상태로 돌아가지 않습니다. 비밀이 없는
`DATABASE_CLOSE_FAILED`를 호출자에게 반환하고 terminal `closed` 상태로 남겨, 반쯤 닫힌 client에 새 작업을
보내지 않습니다.

### 5. 파일시스템 I/O는 transaction 밖에서 수행하고 마지막에 계보를 다시 확인합니다

Subscription Workspace snapshot은 다음 순서를 사용합니다.

1. 짧은 transaction에서 조직·Work·Task·Assignment·Workspace 신뢰와 canonical path를 읽습니다.
2. transaction 밖에서 directory snapshot을 계산합니다.
3. 두 번째 짧은 transaction에서 같은 계보와 workspace ID·path가 여전히 유효한지 확인합니다.

중간에 Work 상태, assignment, workspace 또는 path가 바뀌면 snapshot을 실행에 넘기지 않습니다. 외부 I/O를
transaction 밖으로 옮기되 TOCTOU 경계를 fail-closed로 유지합니다.

## 결과

- 한 Surreal client에는 interactive transaction이 최대 하나만 열리고, 그 transaction 안에서도 query는 하나씩 실행됩니다.
- 시작·본문·commit 실패와 bounded retry 뒤에도 다음 FIFO 호출이 진행됩니다.
- 앱 종료가 승인된 DB 작업을 자르거나 새 작업을 받아 무기한 늘어나지 않습니다.
- 느린 workspace volume이 공유 DB transaction을 잡고 있지 않습니다.
- 동적 편성이 중첩 transaction 없이 승인을 보존하고, 승인 뒤 조직·협업방·Task 배정을 원자 적용합니다.
- 이 결정은 40GB 메모리 문제의 완료 증거가 아닙니다. 새 Tauri bundle의 실제 Work·idle·shutdown soak는 별도
  출시 게이트로 남습니다.

## 기각한 대안

- **각 호출자에 semaphore 추가:** 200개가 넘는 transaction 호출 경계를 빠뜨리고 동일 client 불변량을 분산합니다.
- **Projector retry 수만 늘리기:** 경합을 더 오래 반복하고 UI 지연을 키웁니다.
- **모든 query를 FIFO에 넣기:** 실제 결함보다 넓은 직렬화로 읽기 처리량을 불필요하게 줄입니다.
- **filesystem snapshot을 transaction 안에 유지:** 느린 외부 자원이 DB와 종료를 함께 점유합니다.
- **close 실패 뒤 open으로 복귀:** client가 실제로 어느 정도 닫혔는지 증명할 수 없어 데이터 손실 위험이 있습니다.
