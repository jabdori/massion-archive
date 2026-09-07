# 정본 드리프트 인계서 — 문서·코드·조립의 어긋남 (2026-09-04)

> **상태**: 조사 완료, 조치 미실행
> **기준 HEAD**: `51b2f30b7` (`feat/phase-30-reconciled`)
> **조사 방법**: 저장소를 18개 영역으로 나눈 병렬 독해 → 주장 105건을 코드·문서 두 렌즈로 적대적 검증 → 빈틈 보강 독해 6건. 검증 결과 86건 확인, **19건 반박**. 반박된 것은 이 문서에서 제거하거나 정정문으로 남겼습니다.
> **이 문서가 하는 일**: 발견을 [현재 차단 / 다음 마일스톤 / 외부 게이트 / 문서 전용]으로 **분류만** 합니다. HANDOFF.md 0절 원칙 5·6에 따라 분류는 구현 지시가 아닙니다.

## 0. 읽는 법

이 문서는 "무엇을 고쳐라"가 아니라 "무엇이 어긋나 있는지"의 목록입니다. 각 항목은 다음 형식입니다.

- **주장**: 문서나 계획이 말하는 것
- **사실**: 코드·git에서 확인한 것
- **확인 방법**: 재현 가능한 명령 또는 파일:행
- **분류**: 현재 차단 / 다음 마일스톤 / 외부 게이트 / 문서 전용

`검증됨` 표시가 있는 항목은 독립 검증자가 코드 렌즈로 반박을 시도했으나 결정적 근거로 살아남은 것입니다. 없는 항목은 영역 독해자의 단일 보고이며 **아직 독립 확인을 거치지 않았습니다**. 이 구분을 지우지 마십시오.

이미 처리한 것은 여기 없습니다. `PRODUCT.md`의 세 항목(Work 종료 상태 층위 혼동, 낡은 품질 게이트 수치, Workspace 지식 생산 경로)은 2026-09-04에 정정했습니다.

### 0.1 검증에서 뒤집힌 것 — 초안에 있었으나 사실이 아니었던 주장

같은 조사의 초안이 아래를 결손으로 적었습니다. 적대적 검증이 반박했으므로 **결손이 아닙니다.** 다음 사람이 이것을 다시 "고쳐야 할 것"으로 열지 않도록 남깁니다.

| 초안의 주장 | 검증 결과 |
|---|---|
| 코드에 '제한 모드' 상태값이 없고 차단 상태로만 드러난다 | **반박.** `apps/server/src/product.ts:1468-1469`가 다섯 Core Route의 missing/blocked에서 `modelRuntime: "ready" \| "limited"`와 `modelRuntimeDetails`를 계산하고, `system.status` 조회와 `/api/v1/status`로 노출합니다. `product.test.ts:921`이 계약을 고정합니다 |
| Work의 `waiting_approval`이 테스트에서만 산다 | **반박.** 승인 게이트가 Software Delivery 경로에 있어 생산에서 동작합니다. 미조립인 것은 `WorkService`에 주입하도록 설계된 게이트 하나뿐입니다(2.2) |
| 자가개선은 창립 불변량이 아니라 나중에 추가된 축이다 | **반박.** 헌법의 그 문장은 Massion 이전 계보(`claude-agent-bootstrap` 단계)에 대한 역사 서술입니다. Massion 코드에서 Growth는 조직 그래프 최초 커밋부터 Core Office 여덟 중 하나이며 비활성화·이동이 금지된 bootstrap 불변량입니다 |
| Phase 26·27이 인용한 옛 커밋 해시는 저장소 밖 아카이브 없이는 추적 불가 | **반박.** `git filter-repo` 매핑이 `.git/filter-repo/commit-map`에 남아 있고 커밋 메시지가 보존돼 제목·경로·날짜로 1:1 복원됩니다 |
| Phase 31이 CLI에 한 일은 삭제뿐(추가 0건) | **반박.** 회귀 테스트 2건이 추가됐습니다(`+32/-7`). 삭제된 별칭이 parser와 adapter 양쪽에서 거부되는지 고정합니다 |
| `HANDOFF.md`의 "39 커밋"이 작성 시점에 이미 틀렸다 | **반박.** 문서가 기준 HEAD를 `ba5b5c846`으로 명시했고 그 시점 값은 정확히 39입니다. 현재 40인 것은 그 문서를 담은 체크포인트 커밋이 뒤에 붙었기 때문입니다 |
| 아키텍처 §8.1 평가실 `implemented` 표기가 ADR-003과 모순된다 | **반박.** ADR-003:13은 2026-07-28 시점 스냅샷이고, 그 문단이 지목한 네 결함은 현재 코드에서 닫히고 테스트가 붙었습니다 |
| 검증 스크립트가 금지어를 문자 배열로 조립한 것은 자기 검사를 피하려는 의도다 | **반박.** 기계적 사실은 맞지만 동기 주장이 근거 없습니다. 문서 금지어 검사는 `docs/` 하위 마크다운만 보고 `scripts/*.mjs`를 읽지 않습니다 |
| Studio의 Massion 고유 코드는 두 파일뿐 | **반박.** 셋입니다. 신규 두 파일에 더해 기존 Nimbalyst `packages/electron/src/main/index.ts`가 백엔드 부팅·AI 서비스 비활성화로 개조돼 있습니다 |

## 1. 문서 전용 — 코드 변경 없이 문서만 고치면 되는 것

### 1.1 §0.H 상태표의 예산 행이 낡았습니다 `검증됨`

- **주장**: [정본 인계서](aaa-v1-continuation-handoff-2026-08-05.md) §0.H.1·§0.H.2가 `예산`을 `fixture-only`로 두고 "guard command, `route_attempt` query, threshold persistence, actual hard limit block" 전부를 결손으로 적습니다.
- **사실**: 두 계약이 실재하고 라우터가 실제로 차단합니다. `router.route.budget.set`(`packages/application/src/contracts.ts:903`)과 `router.attempts`(`:814`)가 공개 계약에 있고, `packages/router/src/model-router.ts:1841-1853`이 컨텍스트·요청·총액 세 한도를 선택 단계에서 검사해 `blocked`로 돌려보냅니다. `:1522-1527`이 예약 시점에 지출을 선반영합니다. [헌법](../../product/constitution.md) §9.1이 2026-08-09에 이를 해소로 기록했는데 §0.H만 갱신되지 않았습니다.
- **남는 결손**: 알림 임계값입니다. `model_route` 스키마(`packages/router/src/schema.ts:122-125`)에 차단 한도만 있고 알림 필드가 없습니다. 헌법 §6이 말하는 "알림 임계값"은 데스크톱 로컬 상태로 보이며 이 조사에서 확정하지 못했습니다.
- **분류**: 문서 전용. §0.H 예산 행을 `partial`로 내리고 남는 결손을 알림 임계값으로 좁힙니다.

### 1.2 정본 인계서가 둘입니다 `검증됨`

- **주장**: [정본 인계서](aaa-v1-continuation-handoff-2026-08-05.md) 머리말이 "이 문서가 유일한 정본 인계서입니다. 별도 세션 문서는 두지 않습니다"라고 적습니다.
- **사실**: 루트 `HANDOFF.md`가 2026-08-24에 별도 종합 인계서로 추가됐고, 정본 인계서는 `c6197be19`(2026-08-10) 시점에 멈춰 이후 커밋 40건(OpenRouter 카탈로그, 모델 On/Off, 트랜잭션 직렬화, Phase 31)을 반영하지 않습니다.
- **확인**: `git log -1 --format=%h docs/phases/30-surface-parity-agent-ux/aaa-v1-continuation-handoff-2026-08-05.md`와 `git rev-list --count c6197be19..HEAD`
- **분류**: 문서 전용. 둘 중 하나가 정본임을 선언하거나, 정본 인계서에 "2026-08-10 이후는 HANDOFF.md가 잇는다"는 한 줄을 넣습니다.

### 1.3 커밋 메시지 규칙 전환이 기록되지 않았습니다 `검증됨`

- **주장**: 정본 인계서 §0.D 14와 §0.F.2가 "공개 커밋은 영어 Conventional Commits"를 규칙으로 적습니다.
- **사실**: `343262afc`(2026-08-09)부터 제목이 한국어 서술형으로 바뀌었습니다. `HANDOFF.md`의 9개 절대 원칙에는 이 규칙이 아예 없습니다. 전환을 결정한 기록이 어느 문서에도 없습니다.
- **확인**: `git log --format='%ad %s' --date=short -50 | head -30`
- **분류**: 문서 전용. 사용자 결정이면 규칙을 갱신하고, 드리프트면 되돌립니다. **이 조사는 어느 쪽인지 판정하지 않습니다.**

### 1.4 Phase 30 설계가 삭제된 두 표면의 동등성을 요구합니다

- **주장**: [Phase 30 설계](design.md)가 TUI와 Web 두 표면의 기능 동등성을 목표로 하고 검증 전략으로 Playwright Web과 OpenTUI를 지정합니다. 상태는 여전히 `in-progress`입니다.
- **사실**: 두 표면은 `7a68eef6e`(2026-08-02)에서 제거됐고 `scripts/legacy-surface-boundary.test.mjs`가 부활을 막습니다. "표면 동등성"이라는 이름만 남고 동등화할 대상이 없습니다.
- **분류**: 문서 전용. 설계 문서에 범위 전환 머리말을 넣거나(`implementation-plan.md:3`이 이미 쓰는 방식), Phase 30의 실질 범위가 개인용 데스크톱임을 제목 수준에서 인정합니다.

### 1.5 Phase 31 Task 4 체크박스가 코드보다 뒤집니다

- **주장**: [Phase 31 구현 계획](../31-task-aware-model-placement/implementation-plan.md) Task 4의 "`model.route.selected`를 발행하고 redacted lineage를 보존합니다"가 미체크입니다.
- **사실**: `packages/runtime/src/voltagent-runner.ts:1446`이 이미 그 사건을 CAS 재시도로 발행하고 배치 영수증을 payload에 싣습니다. `apps/server/src/product.test.ts`가 그 사건을 기대합니다. `HANDOFF.md` 자신도 "`model.route.selected` 사건 재생을 fail-closed로 검증"했다고 적습니다.
- **분류**: 문서 전용 또는 다음 마일스톤. 남은 것이 redacted lineage 부분뿐이라면 체크박스를 둘로 쪼갭니다. **구현자 판단이 문서에 없어 이 조사가 확정하지 못했습니다.**

### 1.6 `LEDGER-SPEC.md`가 `DESIGN.md`와 정반대 규칙을 말합니다

- **사실**: 같은 폴더의 두 문서가 충돌합니다. LEDGER-SPEC은 10px 금지·반경 두 종·구분선 0개·헤더 48px를, DESIGN.md와 `styles.css`는 label 10px·반경 3/5/7px·`divide-y` 구분선·헤더 46px를 정본으로 합니다. LEDGER-SPEC이 요구하는 원장 열은 코드에 없습니다(`원장`·`Ledger` 문자열 0건).
- **맥락**: 2026-07-28 AAA 재설계가 `4a9b59ae5`로 되돌려졌을 때 함께 정리되지 않은 잔존물로 보입니다.
- **분류**: 문서 전용. 폐기하거나 "되돌려진 설계의 역사 기록" 머리말을 답니다.

### 1.7 데스크톱 열 규칙이 코드와 다릅니다

- **주장**: `DESIGN.md`가 "조직 표면은 구조와 지도를 55:45로 나눈다", "표면 일곱은 예외 없이 같은 3열 치수", "화면 제목은 16px을 넘지 않는다"를 규정합니다.
- **사실**: 조직 표면은 50:50 두 열이고, 홈은 단일 열에 24px 제목이 본문과 함께 스크롤되며, 설정도 3열이 아니고, 예산은 다른 치수를 씁니다.
- **분류**: 문서 전용 또는 다음 마일스톤. 문서를 코드에 맞추거나 코드를 문서에 맞추는 결정이 필요하고, **어느 쪽이 의도인지 이 조사가 판정하지 않습니다.**

### 1.8 기타 낡은 기준일·상태 표기

- [헌법](../../product/constitution.md) 머리말 기준일이 2026-07-22인데 본문에 2026-07-27·07-30·08-09·08-10 정정이 섞여 있습니다.
- [근거 관계 그래프 인계서](knowledge-graph-handoff.md)가 "계약 노출 없음"으로 남아 있으나 `KnowledgeReferenceViewV1.provenance.paths[].relation`과 `knowledge.links` 조회가 실재합니다. 같은 시기의 [지식 표면 인계서](knowledge-surface-handoff.md)는 정정 머리말을 받았는데 이쪽만 못 받았습니다.
- [아키텍처 정본](../../architecture/README.md) 다이어그램이 CLI를 `예정` 클래스로 그리는데 같은 문서 표는 `구현됨`으로 적습니다.
- 아키텍처 정본이 `packages/local-control`·`packages/subscriptions`·`packages/workspace`·`apps/connector`·`apps/desktop-bridge`를 한 번도 언급하지 않습니다.
- **분류**: 전부 문서 전용.

## 2. 구현했지만 조립하지 않은 것

이 저장소가 스스로 이름 붙인 지배적 결함 패턴입니다(정본 인계서 §0.C.15.2 "이 저장소의 지배적 결함(구현했지만 조립 안 함)을 제가 그대로 반복"). 아래는 패키지에 구현과 테스트가 있으나 생산 조립 루트에 없는 것들입니다.

### 2.1 Growth 독립 신호가 상수라 §4.8 게이트가 항상 통과합니다 `검증됨`

- **주장**: 헌법 §4.8이 "독립된 신호, 반대 근거와 적용 위험을 평가합니다", "LLM 자기평가 하나만으로 자동 채택할 수 없습니다".
- **사실**: 도메인 게이트(`packages/growth/src/evaluation.ts:194-207`)는 독립 출처 신호를 최소 1건 요구하고 `model-self`는 그 요건을 못 채웁니다. 그러나 생산 워커가 만드는 신호가 상수입니다. `apps/server/src/growth-worker.ts:100`이 `const value = run.status === "passed" ? 1 : 0`이고, `assurance` 독립 신호는 Assurance source가 snapshot에 존재한다는 사실만 증명합니다. 반대 근거로 작동하는 유일한 것은 개인 기억 key 충돌뿐입니다.
- **결과**: 기억 key 충돌이 없는 모든 후보가 `eligible`이 됩니다. 게이트는 구조적으로 존재하나 실질은 존재 확인에 가깝습니다. 헌법 §9.3 ③이 이미 이를 적어 두었습니다.
- **분류**: 다음 마일스톤. 제품 우선순위 3번("Massion이 스스로를 고치는 부트스트랩")의 선행 조건입니다.

### 2.2 Work Governance 게이트만 미주입이고 승인 자체는 다른 경로로 삽니다 `검증됨·정정`

- **사실**: `apps/server/src/product.ts:385`가 `WorkService.create`의 4번째 인자에 `undefined`를 넘깁니다. 따라서 `packages/work/src/work.ts:2909-2979`의 `authorizeRunningAction`·`reconcileRunningActionApproval`은 호출 즉시 던지고, `packages/work/src/governance.integration.test.ts` 외에 호출자가 없습니다.
- **정정 (적대적 검증 2026-09-04)**: 이 항목은 초안에서 "Work의 `waiting_approval`이 생산에서 살아 있지 않다"는 뜻으로 읽힐 수 있게 적었습니다. **틀렸습니다.** `waiting_approval` 전이는 생산에서 동작하며, 승인 게이트가 `WorkService`가 아니라 Software Delivery 경로에 있습니다. 즉 결손은 "Work 승인이 없다"가 아니라 **"WorkService에 주입하도록 설계된 게이트 하나가 조립되지 않았다"**로 좁혀집니다.
- **분류**: 판정 필요. 승인 책임이 Delivery 쪽으로 옮겨간 것이 결정이면 `WorkService`의 governance 인자와 두 메서드를 제거 후보로 분류하고, 남길 것이면 주입 지점을 만듭니다. **어느 쪽인지 이 조사가 판정하지 않습니다.**

### 2.3 Extension Capability Broker와 다섯 서비스 `검증됨`

- **사실**: `apps/server/src`에서 `CapabilityBroker` 참조가 0건입니다. 같은 이유로 `ExtensionBootstrap`·`ExtensionComplianceAuditor`·`ExtensionRecoveryService`·`ExtensionStorageService`·`ExtensionMetrics`도 조립되지 않았습니다. `packages/extension-host/src/capability-broker.ts:122-124` 주석이 "broker와 storage service가 한 번도 함께 컴파일된 적 없었다"고 자백합니다.
- **결과**: worker가 코어에 무언가를 요청하는 역방향 채널이 없습니다. 설치된 Extension의 역량을 Agent 실행이 소비하는 경로가 없다는 §0.H 판정의 실체입니다.
- **막는 것**: SDK 프로토콜이 단일 요청-응답이고 Host가 requestId를 발급하므로, 역방향 프레임을 넣으려면 프로토콜 확장이 필요합니다.
- **분류**: 다음 마일스톤. 헌법 §10 목표 4가 이미 소유합니다.

### 2.4 Registry 게시 경로 전체

- **사실**: `registryPublisher`가 `apps/server/src` 어디서도 주입되지 않습니다. `RegistryHttpHandler`는 `stagePublisher` 없이 생성돼 PUT이 503이고, 읽기 서버는 GET/HEAD 외 405입니다. OIDC 게시자 인증, 단일 사용 업로드 승인, Sigstore provenance, OSV 취약점 조회, publication policy는 전부 패키지 테스트에서만 살아 있습니다.
- **생산의 유일한 게시 경로**: `apps/server/src/bundled-official-extensions.ts`가 공식 3개를 `PASSED_ASSESSMENT` 상수로 통과 처리하는 시드뿐입니다.
- **분류**: 판정 필요. 개인용 1.0 범위 축소의 의도적 결정이면 아키텍처 정본 §10 "Registry·Marketplace 구현됨" 표기를 좁히고, 아니면 다음 마일스톤입니다.

### 2.5 협업방에 런타임이 쓰지 않습니다 `검증됨`

- **사실**: `packages/runtime/src` 전체에 `postMessage` 호출이 0건입니다. 협업방에는 Work당 사용자 요청과 대표 인계 두 건만 쌓입니다. `CollaborationRuntimeRecorder`는 `apps/server/src/product.ts:771`에 조립돼 있으나, ADR-006이 암시적 위임을 차단한 뒤 생산 경로에서 `delegate_task` 델타가 발생하지 않습니다.
- **결과**: §0.H가 협업방·handoff를 `blocked`로 판정하는 직접 원인입니다. 데스크톱 fixture는 완성본 대화를 이미 그려 놓았습니다.
- **분류**: 현재 차단. [에이전트 협업 런타임 인계서](agent-collaboration-runtime-handoff.md)와 [ADR-006](../../architecture/ADR-006-product-owned-agent-delegation.md)이 이미 소유합니다.

### 2.6 통합 패키지 전체를 쓰는 곳이 없습니다 `검증됨`

- **사실**: `@massion/integrations`(ingress·dispatcher·outbound·tokens·oauth·github-auth·github-projection, 소스 28개)를 의존하는 앱·패키지가 저장소에 하나도 없습니다.
- **결과**: 공식 확장 셋(slack·discord·github)이 실제로 호출되는 유일한 코드 경로가 통째로 조립되지 않았습니다. 아키텍처 정본이 이 셋을 `구현됨`으로 표시하는 것과 어긋납니다.
- **확인**: `grep -rn '@massion/integrations' --include=package.json .` (자기 자신과 화해 원장만 나옵니다)
- **덧붙여**: 세 확장은 `@massion/extension-sdk`를 devDependency로만 두고 worker 코드에서 한 줄도 import하지 않습니다. RPC 프레이밍과 canonical JSON을 세 파일이 각각 손으로 다시 짰고 거의 동일한 함수가 세 벌입니다. Slack 확장이 반환하는 목적지 필드는 호스트가 body를 펼치며 덮어써서 도달 불가능합니다(`extensions/slack/src/connector.ts:27` 대 `packages/integrations/src/outbound.ts:52`).
- **분류**: 판정 필요. 개인용 1.0 범위 밖이면 아키텍처 정본의 `구현됨` 표기를 좁히고, 아니면 다음 마일스톤입니다.

### 2.7 그 밖의 미조립

- `OperationQueue`·`ExtensionCrashSupervisor`·`ConnectorProcessSupervisor`·`performUpgrade`가 `index.ts`로 export되지만 daemon에 조립되지 않습니다.
- Evidence 재색인 enqueue가 항상 `false`를 돌려주는 stub입니다(`apps/server/src/product.ts:870`). 따라서 생산에서 `reindex_required` 상태가 발생하지 않습니다.
- `packages/evidence`의 `RepositoryWatcher`·`EvidenceIndexRecovery`·`EvidenceMetrics`·`ExternalResearchStore`가 생산 코드에서 참조되지 않습니다.
- `createBypass`·`allowsBypass`가 구현·테스트됐으나 `GovernanceGate`가 호출하지 않습니다.
- `packages/foundation`이 49행이고 import 0건입니다. 다만 이는 미래 계획이 아니라 **과거**입니다. reconciliation 원장 조각 2·13이 안전 스냅샷 `9b049f72a`에 있던 capability 계약·쿼리 자원 코드를 되살리는 계획을 담고 있고, 아직 적용되지 않았습니다.
- **분류**: 전부 다음 마일스톤 또는 삭제 후보. **어느 쪽인지 소유자 판단이 필요합니다.**

## 3. 구조적 위험 — 사용자 결정이 필요한 것

### 3.1 커밋 45개가 원격에 없습니다 `검증됨`

- **사실**: `feat/phase-30-reconciled`가 `origin`보다 40 앞서고, `codex/candidate-recovery-20260813`은 원격 참조가 아예 없는 5커밋입니다. 후보 분기의 UAT 증거 문서는 그 로컬 worktree에만 존재합니다.
- **규칙과의 충돌**: 정본 인계서 §0.F.2가 "commit 즉시 push"를 규칙으로 적었으나 origin은 2026-08-09(`a7ed78993`)에 멈춰 있습니다.
- **확인**: `git rev-list --count origin/feat/phase-30-reconciled..HEAD`, `git for-each-ref refs/remotes`
- **위험**: 디스크 유실 시 복구 불가입니다. 외장 볼륨 worktree이고, 2026-08-24에 이미 macOS 정책이 이 볼륨 접근을 일시 차단한 전례가 있습니다(`HANDOFF.md` 6절 1번).
- **분류**: 현재 차단 후보. **push 여부는 사용자 결정입니다.**

### 3.2 main과 작업 분기를 합칠 전략이 없습니다 `검증됨`

- **사실**: `main`의 마지막 3커밋이 `docs/phases`·`docs/evidence`·추적표 145개 파일을 인덱스에서 제거하고 `.gitignore`에 올렸습니다(공개 저장소 정리). 작업 분기는 그 3커밋을 포함하지 않고 같은 문서들을 계속 추적하며, 정본 인계서(1,942행)와 fixture를 새로 추가했습니다.
- **결과**: 지금 합치면 main이 지운 내부 기록이 되돌아옵니다.
- **확인**: `git log --format='%h %s' HEAD..main`, `git show main:.gitignore`와 `.gitignore` 비교
- **분류**: 판정 필요. 공개 저장소와 내부 기록의 경계를 어떻게 유지할지가 결정 대상입니다.

### 3.3 고아 히스토리 350커밋

- **사실**: `.worktrees/phase-30-baseline-evidence`가 detached HEAD `65922bd70`에 있고, 이 히스토리는 루트가 다르며(`3c9697db1`) 어떤 브랜치에도 속하지 않습니다. main 계열과 트리·타임스탬프가 같고 커밋 제목 3줄만 다릅니다. 메시지 정규화 rewrite 이전의 원본으로 보입니다.
- **위험**: 브랜치가 없으므로 gc 대상이 될 수 있습니다.
- **분류**: 판정 필요. 의도적 보존이면 태그나 브랜치를 붙이고, 잔재면 worktree를 정리합니다.

### 3.4 ADR-009 격리본이 커밋되지 않았습니다 `검증됨`

- **사실**: `.omo/worktree-isolation/adr009-transport-20260901/`에 패치와 아카이브가 SHA-256·왕복 검증과 함께 보존돼 있습니다. ADR 본문 자체가 "상태: 승인됨, 승인일 2026-08-25"라고 선언하지만 `git log --all --grep=ADR-009`가 0건입니다. 추적 변경은 삭제 3,651개인데 그중 3,628개(99.4%)가 `apps/studio`입니다.
- **주의**: 이 실험은 렌더러에 access token을 내리는 Tauri permission 4개를 포함합니다. [desktop-clean-sheet](../../architecture/desktop-clean-sheet.md)가 "렌더러는 daemon URL이나 인증 토큰을 받지 않는다"를 보안 경계로 못박은 것과 방향이 반대입니다. ADR 본문이 이 트레이드오프를 명시 수용한다고 적었으나 **본문을 이 조사가 열지 않았습니다**.
- **분류**: 외부 게이트 아님, 다음 마일스톤. MANIFEST가 "검증 없이 현재 후보 또는 Phase 31 커밋에 합치지 않습니다"를 이미 규칙으로 적었습니다.

### 3.5 `pnpm release:build`가 현재 트리에서 시작조차 못 합니다 `검증됨`

- **사실**: `scripts/build-release.mjs:295`의 `assertCleanReleaseTree`가 미추적 파일까지 없는 clean tree를 요구하는데, 현재 `.omo/`·`.pnpm-store/`·`mise.toml`이 미추적입니다.
- **분류**: 현재 차단은 아님(개인용 데스크톱 릴리스는 `tauri:build` 경로). 다만 headless 묶음 검증을 돌리려면 먼저 정리해야 합니다. `mise.toml`은 `HANDOFF.md` 3.2가 "팀 자산이라면 다음 에이전트가 판단"으로 남겼습니다.

## 3.6 검증 게이트 자체의 빈틈 `검증됨`

증거 규율이 이 저장소의 자산인데, 그 규율을 지키는 기계에도 구멍이 있습니다.

- **화해 원장의 엄격 검증이 한 번도 돌지 않습니다.** `scripts/verify-docs.mjs:160`이 `verify-phase30-reconciliation.mjs`를 옵션 없이 호출하므로 `--require-safety` 경로(실제 base→safety diff, hunk 행 범위, 전후 문맥 대조, `verify-phase30-reconciliation.mjs:383-456`)가 CI에서 실행되지 않습니다. 검증기는 원장 내부 정합성(경로 337·공용 파일 24·소유자 62)만 대조합니다.
- **추적표 SHA 71개가 어떤 브랜치에서도 도달 불가입니다.** 전부 `git cat-file -e`는 통과하지만, completed 21행이 인용한 24개는 `refs/massion-safety/` 전용이고 나머지 34개는 어떤 ref에서도 닿지 않는 dangling 객체입니다. 즉 `verify-docs.mjs:115-121`의 존재성 검사는 통과하되 **그 커밋들은 히스토리에서 사라진 상태**입니다. gc 정책에 따라 언젠가 검증이 깨질 수 있습니다.
- **실제 다이어그램 렌더링이 자동 경로에 없습니다.** CI가 아키텍처 검증을 도는 것은 `verify:architecture`가 CI에 있어서가 아니라 `scripts/verify-architecture-diagrams.test.mjs`가 스크립트를 `--structure-only`로 spawn하기 때문입니다. Chrome을 띄우는 실제 Mermaid 렌더링은 사람이 손으로 불러야 합니다.
- **추적표 SHA 표기 규칙이 없습니다.** 같은 커밋이 40자와 7자 두 형태로 원장에 들어 있습니다(5·11·12·13행).
- **분류**: 문서 전용 아님, 다음 마일스톤. 특히 두 번째 항목은 **시간이 위험을 키웁니다**.

## 3.7 영어 화면에서 구별되지 않는 상태 어휘 `검증됨`

i18n 키가 한국어 문장 자체라서, 서로 다른 한국어가 같은 영어로 번역되면 영어 사용자는 두 상태를 구별할 수 없습니다. 영어 값이 같은데 한국어 키가 다른 쌍이 14개 있고, 그중 둘이 의미상 위험합니다.

| 한국어 | 영어 | 문제 |
|---|---|---|
| `정리 중`(`messages-app.ts:285`) · `중단 중`(`:677`) | 둘 다 `Stopping` | 정상 종료 정리와 사용자 취소를 영어 화면에서 구별할 수 없습니다 |
| `거부됨`(`:378`) · `거절됨`(`:680`) | 둘 다 `Rejected` | 개선 제안 거부와 승인 거절이 같은 낱말이 됩니다 |

같은 파일에 도달 불가능한 사문 항목도 남아 있습니다. 역할 배지 여덟(`총괄`·`조율` 등)은 `messages.ts:4-7`이 shared를 나중에 펼쳐 덮어쓰므로 런타임에서 닿지 않고, 월·요일 15개는 형식기로 옮긴 뒤 사전에만 남았으며, `억`·`만`을 곱셈식으로 옮긴 두 항목은 호출부가 없습니다.

- **분류**: 다음 마일스톤. DESIGN.md의 "같은 동작을 두 이름으로 부르지 않는다" 규율이 영어 쪽에서 깨진 사례입니다.

## 4. 작은 결함 — 코드 한 줄 수준

이 조사에서 눈에 띈 것들입니다. 전부 **현재 차단이 아니며**, 범위 동결 원칙에 따라 지금 고치지 않습니다.

| 위치 | 내용 |
|---|---|
| `packages/runtime/src/voltagent-runner.ts:1534-1536` | `if (terminal.outcome === "completed")`의 양쪽 분기가 동일합니다. 죽은 조건입니다. |
| `packages/runtime/src/voltagent-runner.ts:572-587` | `execute` 경로는 빈 모델 출력을 던지는데(`:875`) `stream` 경로는 빈 문자열을 성공으로 보냅니다. ADR-006 §3 "빈 모델 출력은 성공이 아닙니다"와 어긋납니다. |
| `apps/cli/src/render.ts:40-50` | `renderCliOutput`이 `void options;`로 옵션을 버립니다. 테스트 제목은 "NO_COLOR를 존중한다"인데 색을 아예 쓰지 않아 "무관"입니다. |
| `apps/desktop/src/app.tsx:949` | 새 사명 버튼에 `⌘N` 힌트가 있으나 대응하는 키 핸들러나 네이티브 메뉴가 없습니다. |
| `packages/growth/src/recovery.ts:137, 155` | `applying`·`reverting` 상태를 조회하지만 스키마 ASSERT에 그 값이 없어 항상 빈 결과입니다. |
| `apps/connector/src/cli.ts:98-101` | `doctor`·`--help` 처리가 없는데 `scripts/verify-release.mjs:87-96`이 둘을 요구합니다. `release/install.sh`의 셸 wrapper가 Node 진입점 밖에서 흉내냅니다. |
| `packages/subscriptions/src/metrics.ts:43-54` | 집계 라벨 어휘가 `packages/router/src/failure.ts:1-12`의 실제 분류와 다릅니다. `rate-limit`·`provider`는 나오지 않고 `billing`·`upstream`·`output`은 `other`로 뭉개집니다. |
| `packages/workspace/src/workspace.ts:207-217` | `touch()`의 호출부가 0건입니다. `last_used_at`이 등록 시점에만 세팅되므로 "최근 사용 순"은 사실상 "최근 등록 순"입니다. |
| `apps/server/src/product.ts:697-699` | `logout`이 `openai-codex`가 아니면 던지는데, `disconnect`는 profile root가 있으면 무조건 logout을 호출합니다. Claude 서버 관리형 계정 해제가 예외로 끝나는 경로가 있어 보입니다. **실행으로 확인하지 못했습니다.** |
| `packages/application/src/adapters/domain.ts:276-395` | `domainError`가 한국어 메시지 정규식으로 오류를 분류합니다. 도메인 문구가 바뀌면 조용히 500으로 떨어집니다. |
| `packages/application/src/query-registry.ts:1553-1555` | `RouteAttemptViewV1`의 캐시·추론 토큰 세 필드를 리터럴 0으로 채웁니다. 계약 필드는 있으나 정보가 없습니다. |

## 5. 이 문서가 증명하지 않는 것

- **테스트를 실행하지 않았습니다.** `HANDOFF.md` 7절의 "서버 366 passed", README 표의 스위트 개수는 검증되지 않은 문서 주장으로 남습니다.
- **앱을 띄우지 않았습니다.** 정본 인계서 §0.E.15가 경고하듯 화면 결함의 절반 이상은 소스 grep으로 나오지 않습니다. 4절의 데스크톱 항목은 소스 판독이며 실행 관측이 아닙니다. 3.7의 어휘 충돌도 카탈로그 대조이지 영어 화면을 눈으로 본 결과가 아닙니다.
- **`검증됨` 표시가 없는 항목은 독립 확인을 거치지 않았습니다.** 영역 독해자 한 명의 보고입니다.
- **검증도 읽기로만 했습니다.** 105건을 코드·문서 두 렌즈로 반박 시도했으나 어느 검증자도 빌드·테스트·앱 실행을 하지 않았습니다. §0.1의 반박 판정도 같은 한계를 가집니다.
- **분류는 구현 지시가 아닙니다.** `HANDOFF.md` 0절 원칙 6에 따라 P0 표기나 분류를 자율 구현 근거로 쓰지 않습니다.
- **ADR-009 본문을 열지 않았습니다.** 3.4의 보안 방향 판단은 아카이브 목록과 permission 파일명에 근거한 추정입니다.

## 6. 권장 처리 순서

`HANDOFF.md` 0절 원칙(범위 동결, 세로 흐름 우선, 출시 게이트는 마지막에 한 번)을 지키는 순서입니다.

1. **지금**: 3.1 원격 push와 3.6의 dangling SHA를 결정합니다. **시간이 위험을 키우는 항목은 이 둘뿐입니다.** 추적표가 인용한 커밋 71개가 어떤 브랜치에서도 도달 불가이므로, push는 미커밋 작업뿐 아니라 증거 원장의 근거도 함께 구합니다.
2. **지금**: 1절 문서 전용 항목을 정리합니다. 코드를 건드리지 않으므로 Phase 31 범위를 침범하지 않습니다.
3. **Phase 31 종료 후**: 2.2·2.4·2.6의 "의도인지 누락인지"를 판정해 아키텍처 정본에 반영합니다. 셋 다 "표기를 좁힐 것인가, 조립할 것인가"라는 같은 형태의 결정입니다.
4. **다음 마일스톤**: 2.1 Growth 신호와 2.3 Extension 역량 경로. 둘 다 헌법 §10이 이미 목표로 소유합니다. 3.6의 화해 원장 엄격 검증도 여기서 켭니다.
5. **범위 밖**: 4절 작은 결함과 3.7 어휘 충돌은 인접 작업에서 손댈 때 함께 고칩니다. 이것만을 위해 별도 작업을 열지 않습니다.

## 7. 참조

- [정본 인계서](aaa-v1-continuation-handoff-2026-08-05.md) — §0.H 상태표, §0.E 실패한 접근 17건
- [현재 후보 범위](../../operations/current-candidate-scope.md) — 분류 규칙의 출처
- [Phase 31 구현 계획](../31-task-aware-model-placement/implementation-plan.md) — 현재 마일스톤
- [ADR-006](../../architecture/ADR-006-product-owned-agent-delegation.md) — 2.5 협업방 차단의 결정 배경
- [헌법](../../product/constitution.md) — §9 확인된 갭, §10 다음 목표
