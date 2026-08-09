# ADR-006 — Agent 위임은 제품 실행 계보가 소유한다

> **상태:** 승인됨
> **승인일:** 2026-08-10
> **대상:** Runtime, Work·Task·Assignment, 협업방, 모델 라우팅

## 맥락

실제 환불 지연 Work에서 Representative가 VoltAgent의 암시적 `delegate_task`를 호출했습니다. 이 호출은
대상 Agent를 직접 실행했지만 Massion의 자식 RuntimeExecution, Task·Assignment, Workspace capability,
대상 Agent별 모델 Route Attempt와 비용 계보를 만들지 않았습니다. 도구는 실패를 예외가 아닌
`{ status: "error" }` 결과로 돌려줬고, 상위 모델이 빈 문자열로 끝나도 Runner와 Work 파이프라인이 성공으로
기록했습니다. 화면에는 다음 단계가 진행된 것처럼 보였지만 실제 위임과 산출물은 없었습니다.

조직 그래프의 상하 관계는 실행 권한이 아닙니다. Agent가 다른 Agent를 안다는 사실만으로 제품의 Work 경계를
우회해 호출할 수 있으면 승인, 취소, 재시작 복구, 비용, 파일 권한과 협업 기록이 서로 다른 원장을 갖게 됩니다.

## 결정

### 1. 생산 Embedded Runtime은 VoltAgent의 암시적 위임 도구를 노출하지 않습니다

`EmbeddedVoltAgentRuntime`은 부모·자식 인접 관계를 자체 Map으로 보존하지만 `Agent.addSubAgent()`로
연결하지 않습니다. 따라서 조직 구조 조회와 materialization은 유지하면서도 모델에게 제품 계보 밖
`delegate_task` 도구를 제공하지 않습니다.

`VoltAgentTopologyRuntime`은 명시적 topology adapter와 기존 계약 테스트를 위해 유지합니다. 이것이 생산
Embedded Runtime의 위임 허용 근거는 아닙니다.

### 2. 현재 위임은 Core Work 파이프라인이 명시적으로 실행합니다

Representative → Context Strategy → Delivery Task Agent → Assurance → Records 순서는 제품 파이프라인이
소유합니다. 모델을 호출하는 각 단계는 RuntimeExecution과 Route Attempt를 Work에 연결하고, Delivery의 자식
실행은 Task·Assignment·Workspace capability까지 연결합니다. 동적 Agent도 승인된 조직 변경과 방 참여를
먼저 확정한 뒤 같은 경로로 실행합니다.

새로운 Agent 간 위임 도구가 필요해지면 최소한 다음을 한 원자 경계에서 만들어야 합니다.

- 자식 Task 또는 명시적 Work 단계
- 자식 RuntimeExecution과 부모 실행 인과관계
- Assignment와 Workspace capability
- 대상 Agent의 모델 Route Attempt·사용량·비용
- 협업방 handoff와 terminal answer 또는 실패
- 취소·재시작 복구 상태

이 계보를 만들지 않는 직접 Agent 호출은 생산 경로에 추가하지 않습니다.

### 3. 빈 모델 출력은 성공이 아닙니다

일반 text 결과가 공백뿐이면 출력 실패로 정산하고, 이미 Provider가 보고한 input/output token 사용량은 실패
Route Attempt와 비용 계보에 그대로 남깁니다. 부작용이 없다는 Router 판정이 있을 때만 다음 후보로 fallback
합니다. 외부 Runtime이 `succeeded`를 반환하더라도 Representative 출력이 비어 있으면 Core 파이프라인은
handoff를 만들지 않고 `representative-invalid-output`으로 차단합니다.

### 4. 협업 기록기는 발생하지 않은 위임의 증거가 아닙니다

ADR-004의 `CollaborationRuntimeRecorder`와 drain 계약은 실제 `delegate_task` delta가 들어올 때의 내구성
결정으로 남습니다. 생산 Embedded Runtime이 암시적 도구를 노출하지 않는 동안 기록기가 조용한 것은 정상이며,
그 존재만으로 Agent 간 직접 협업이 완료됐다고 판정하지 않습니다. 실제 완료 증거는 제품 소유 위임 경로가 만든
Task·Runtime·Route Attempt·메시지·Artifact의 연결입니다.

## 결과

- 모델이 조직 구조를 보고 제품 보안·비용·복구 경계를 우회해 Agent를 직접 호출할 수 없습니다.
- 빈 응답과 숨은 도구 실패가 성공 handoff로 승격되지 않습니다.
- 실제 동적 Agent 협업은 더 많은 내부 호출 수가 아니라 하나의 Work 계보가 끝까지 연결됐는지로 검증합니다.
- Fixture는 완성 목표의 시각·행동 계약으로 유지합니다. 다만 출시 완료 증거는 실제 Task·Runtime 사건과 연결된
  협업 메시지에서만 얻습니다.

## 기각한 대안

- **암시적 위임을 유지하고 recorder만 보강:** 기록은 남지만 Task, Workspace, Router, 비용과 복구 우회는 그대로입니다.
- **도구의 `{ status: "error" }`만 예외로 변환:** 다른 숨은 직접 호출이 같은 계보 우회를 계속합니다.
- **빈 출력을 성공으로 두고 다음 단계가 보완:** 일어나지 않은 handoff를 실제 실행처럼 저장합니다.
- **VoltAgent topology 전체 제거:** 명시적 adapter 계약과 조직 topology 검증까지 불필요하게 지웁니다.
