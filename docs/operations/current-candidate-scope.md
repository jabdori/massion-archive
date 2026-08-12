# 현재 후보 범위 선언

> **상태:** 활성
> **결정일:** 2026-08-12 (Asia/Seoul)
> **기능 기준 소스:** `392a425a8a78db4b0c76f88737d1c63d68538987`
> **적용 대상:** 개인용 macOS의 Provider·기본 Work 안정화 후보

실제 artifact와 UAT의 후보 SHA는 이 선언과 릴리스 문서 변경을 포함한 후속 commit으로 다시 고정합니다. 이전 SHA의 증거는 새 후보에 재사용하지 않습니다.

## 목적

이 문서는 출시 검증 중 발견되는 모든 미구현 기능을 현재 후보의 차단 항목으로 승격하지 않기 위한 범위 경계입니다. 범위 밖 기능은 숨기거나 완료로 표기하지 않습니다. 해당 기능의 설계·요구사항·추적표 상태는 그대로 유지하고, 다음 마일스톤에서 별도로 검증합니다.

이 선언은 [개인용 macOS arm64 릴리스 기준](../../apps/desktop/src-tauri/RELEASE.md)의 전체 공개 릴리스 게이트를 낮추거나 대체하지 않습니다. 전체 공개 릴리스에는 여전히 같은 후보 SHA의 23개 실제 Tauri UAT, Developer ID 서명, Apple 공증, 설치·복구·접근성 검증이 필요합니다.

## 이번 후보에 포함하는 기능

1. **Provider 모델 카탈로그와 등록 모델 제어**
   - 공식 Provider API 관측값을 모델 카탈로그로 동기화하고, 오류·빈 결과를 안전하게 표시합니다.
   - 등록된 모델만 영속 On/Off로 바꾸며, 끈 모델은 다음 Router 선택에서 제외됩니다.
   - 관측만 된 카탈로그 모델은 등록 모델처럼 실행 가능하다고 표시하거나 제어하지 않습니다.

2. **기본 Work 세로 경로**
   - 자연어 요청에서 계획된 Task 하나 이상을 실행해 Artifact, 독립 Assurance, Records까지 이어지는 기본 경로를 확인합니다.
   - 실행·모델 시도·fallback·재시작 뒤의 Work 계보가 보존되어야 합니다.
   - 이번 후보는 일반적인 기본 경로를 대상으로 합니다. capability gap을 의도적으로 만들거나, 임의 Agent 간 위임·확장 capability를 Work에 주입하는 시나리오는 포함하지 않습니다.

3. **위 두 경로의 복구·보안 필수 경계**
   - tenant, credential, Provider endpoint, Route attempt, transaction reconnect, runtime/work recovery가 포함 경로에서 fail-closed로 동작해야 합니다.
   - 데이터 손상, 조직 경계 우회, 비밀 노출, 중복 side effect, 재현 가능한 기본 Work 실패는 현재 후보의 제품 차단(P0)입니다.

## 이번 후보에서 제외하는 다음 마일스톤

다음 항목은 현재 코드에서 미구현 또는 근거가 부족하다는 사실을 유지하지만, 위 포함 경로의 결함으로 재현되지 않는 한 현재 후보의 P0로 올리지 않습니다.

- [작업 인지 모델 배치](../phases/31-task-aware-model-placement/design.md): 과제 난이도·작업 성격별 receipt와 실제 선택은 별도 마일스톤입니다. 현 활성 batch의 역할 baseline을 근거 없이 과제별로 재정렬하지 않습니다.
- Extension capability의 Worker → Runtime → Work 소비 경로: 설치·검사 lifecycle과 실제 업무 capability 실행을 같은 완료 조건으로 취급하지 않습니다.
- Growth, Knowledge, 전체 권한, 예산, 전체 협업 delegate, 모든 설정 표면의 확장 시나리오와 시각적 완성도: 기존 요구사항과 추적표의 상태를 보존하고 후속 후보에서 범위를 명시합니다.

## 분류 규칙

| 분류 | 기준 | 이번 후보에서의 처리 |
| --- | --- | --- |
| 제품 차단(P0) | 포함 기능에서 데이터 손상·보안 우회·핵심 경로 실패·복구 실패가 재현됨 | 원인 확인 뒤 최소 수정과 같은 시나리오 재검증 |
| 다음 마일스톤 | 범위 밖 기능이 미구현이거나 근거가 부족함 | 구현하지 않고 해당 Phase/ADR/추적표에 남김 |
| 외부 출시 게이트 | 인증서, 공증 권한, 사용자 Provider 계정·실제 업무 실행 권한이 필요함 | 코드 결함으로 분류하지 않고 권한 확보 뒤 같은 후보 artifact에서 실행 |
| 불명확 | 포함 여부 또는 재현 원인이 확정되지 않음 | 로그·source·테스트로 먼저 분류하고 P0로 자동 승격하지 않음 |

## 후보 승인에 필요한 증거

범위 안의 자동 회귀는 현재 source에서 통과해야 하며, 실제 개인용 후보 승인 시에는 다음을 같은 후보 SHA와 bundle에서 남깁니다.

- 모델 카탈로그 동기화와 등록 모델 On/Off 뒤 Router 선택 제외·복구 증거
- 실제 Tauri의 Provider 연결과 기본 Work 한 건의 Task → Artifact → Assurance → Records 완료 또는 안전한 차단·재개 증거
- 같은 후보에서 daemon/Runtime 재시작 뒤 Work·Route attempt·Artifact·Assurance 계보 보존 증거
- 해당 흐름에서 새 transaction warning, internal failure, tenant/credential boundary 위반이 없다는 운영 로그 확인

Developer ID Application 서명, Apple 공증·staple, Gatekeeper 평가는 별도 외부 출시 게이트입니다. 현재 로컬에 유효한 서명 identity가 없으면 통과로 대체하지 않고 `blocked-external`로 기록합니다.

## 실제 데스크톱 UAT 인스턴스 규칙

같은 사용자의 기본 로컬 경로는 daemon 상태·access token·SurrealDB 데이터를 공유합니다. 서로 다른 `.app` bundle을 동시에 실행하면 어느 renderer와 bridge가 같은 daemon을 시작하거나 종료했는지 판별할 수 없으므로, 실제 후보 UAT는 다음 규칙을 따릅니다.

1. 시작 전에 기존 Massion desktop, bridge, daemon, SurrealDB 프로세스를 확인합니다.
2. 기존 프로세스 종료는 사용자의 명시적 승인 뒤에만 수행합니다. 승인 전에는 새 GUI UAT를 시작하지 않습니다.
3. 승인 뒤에는 기존 프로세스가 모두 종료된 것을 확인하고, 후보 bundle 하나만 시작합니다.
4. UAT 종료 뒤에는 그 후보가 시작한 bridge·daemon·SurrealDB만 정상 종료했는지 확인하고, bundle path·PID·시작 시각·데이터 경로를 evidence에 기록합니다.

이 규칙은 기존 데이터의 삭제·초기화를 허용하지 않습니다. 별도 데이터 격리가 필요하면 build 전에 명시적인 UAT identifier와 XDG 경로를 준비하고, 해당 격리 경로와 cleanup 책임을 evidence에 기록합니다.

## 범위 변경 규칙

이 후보에 새 기능을 넣거나 제외 항목을 P0로 바꾸려면 사용자가 명시적으로 결정하고, 새 기준 제품 소스와 검증 목록을 이 문서에 기록합니다. 감사에서 새 기능을 발견한 사실만으로는 현재 후보 범위를 변경하지 않습니다.
