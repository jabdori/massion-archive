# Phase 31 — 작업 인지 모델 배치 구현 계획

> **상태**: in-progress
> **상세 설계**: `docs/phases/31-task-aware-model-placement/design.md`
> **선행 조건**: Phase 30 `docs/phases/30-surface-parity-agent-ux/design.md`는 현재 `in-progress`이며 공통 표면·Agent runtime 계보 계약을 먼저 닫아야 합니다.
> **방법**: 각 Task에서 실패하는 회귀 테스트 확인→최소 구현→인접 경로 검증→근거 기록 순서를 지킵니다.

## Task 1. 실행 계보 연결

- [x] `route_attempt`에 `execution_id`를 추가하고 `runtime_execution.execution_id`와 `model_profile_id`를 같은 시도 정본으로 연결합니다.
- [x] `assurance_check.executor_execution_id`에서 route attempt와 선택된 모델까지 조회하는 계보를 고정합니다. system adapter check는 실행 모델 계보가 없으므로 빈 선택 목록으로 명시합니다.
- [x] 성공·fallback·실패·재시작 경로에서 하나의 Work 실행이 올바른 route attempt와 모델을 가리키는 회귀 검증을 추가합니다.

## Task 2. 전략 신호와 baseline 회귀

- [x] `strategyTaskSchema`에 전략 생성기가 과제별 난이도를 선택·저장하는 필드를 추가합니다.
- [x] 다섯 작업 성격(코드 생성, 코드 이해·설명, 계획·설계, 검토·비판, 요약·기록)을 역할과 독립된 작업 축으로 기록합니다.
- [x] 축별 표본이 부족하거나 신호가 없을 때 역할 baseline으로 되돌리는 결정론적 경로와 Governance 위험 분리 검증을 추가합니다.

## Task 3. 벤치·receipt·관찰 정본

- [ ] T0 동봉 bench의 만료와 T1 로컬 bench의 실행 전 호출 수·최대 비용·Provider·데이터 고지를 receipt에 고정합니다.
- [ ] T2 Work 관찰은 Assurance 신호를 강등·복구에만 사용하고, 명시적 shadow 동의와 별도 예산을 확인합니다.
- [ ] 후보를 같은 bundle·receipt 집합 안에서 비교하고, capability hard gate와 reference model의 `model-self` 보조 신호를 기존 independent Assurance gate와 분리합니다.
- [ ] 서버가 품질·지연·비용을 계산하게 하고 policy 레코드가 없어도 표본·개선폭 gate와 `expires_at` 보존을 집행합니다.
- [ ] 모델 batch를 Growth 제안 대상으로 연결하되 기존 terminal Assurance 3건 효과 측정과 자동 revert를 재사용합니다.

## Task 4. 실행 시점 배치와 사건

- [x] 역할별 활성 batch를 후보 집합으로 Router에 전달하고 작업 신호에 따른 모델 선택과 역할 baseline fallback을 연결합니다.
- [x] 선택 결과에 `model.route.selected`를 발행하고 Work·execution·route attempt·model profile의 redacted lineage를 보존합니다.
- [ ] 요청별 모델 선택 UI를 추가하지 않고, 기준 모델 신고·배치 후보·선택 근거만 공통 Application surface로 노출합니다.

## Task 5. 비용 고지·표면·검증

- [ ] T1 실행 전에 예상 호출 수·예상 최대 비용·전송 대상 Provider·데이터 종류를 CLI·Desktop 표면에 표시합니다.
- [ ] Phase 30 공통 capability 계약을 통해 후보·근거·fallback·강등 상태를 확인할 수 있도록 연결합니다.
- [ ] route lineage, 다섯 축, T0/T1/T2 권한, baseline 회귀, 보존 gate, `model.route.selected` 사건을 포함한 문서·통합·실사용 검증 증거를 남깁니다.
