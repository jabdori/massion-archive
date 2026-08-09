# 핸드오프 — 설정 조회를 계약에 등록하기

> **상태:** **부분 구현됨**. 아래 본문은 작성 시점(2026-07-24) 진단이며 그대로 읽으면 안 됩니다
> **정정:** 2026-08-09 코드 대조. §10이 「`route_attempt` 조회가 계약에 없다」고 적은 것은 낡았습니다 — `router.attempts`는 계약·레지스트리·데스크톱 호출까지 완결됐고 예산 표면이 실제 호출 기록을 읽습니다. 여전히 유효한 부분은 `router.*`·`subscription.*` 조회 일곱이 타입 없이 무타입 경로로 나간다는 것이며, 그 목록은 `apps/desktop/src/contract-boundary.test.ts`가 고정하고 있습니다.
> **작성일:** 2026-07-24
> **관련 갭:** [제품 헌법 6절·9.1](../../product/constitution.md)

## 1. 무엇이 없는가

설정 화면이 쓰는 조회 일곱은 **전부 등록돼 있고 실제 데이터를 돌려줍니다.** 없는 것은 `ApplicationQueryMapV1`의 항목입니다. 그래서 데스크톱이 `unknown`으로 받아 런타임 파싱을 합니다.

| 조회 | 등록 | 계약 타입 |
|---|---|---|
| `router.catalog` | `query-registry.ts:1339` | **없음** |
| `router.routes` | `:1319` | **없음** |
| `router.credentials` | `:1292` | **없음** |
| `subscription.providers` | `:1389` | **없음** |
| `subscription.accounts` | `:1397` | **없음** |
| `subscription.quota` | `:1439` | **없음** |
| `subscription.policy` | `:1455` | **없음** |

`SettingsView`(`apps/desktop/src/desktop-service.ts`)의 일곱 필드가 전부 `unknown`인 것이 이 사실의 그림자입니다.

## 2. 필요한 것

각 조회의 `handle`이 **이미 뷰 모양으로 매핑해서** 돌려줍니다(snake_case → camelCase까지). 그 모양을 그대로 인터페이스로 옮겨 `ApplicationQueryMapV1`에 등록하면 됩니다. 새 계산은 없습니다.

```ts
// contracts.ts — handle의 반환문을 그대로 타입으로 옮깁니다
export interface RouterCatalogViewV1 {
  readonly providers: readonly { providerId; displayName; adapterKind; enabled }[];
  readonly endpoints: readonly { endpointId; providerId; name; baseUrl; local; gatewayKind; enabled }[];
  readonly models: readonly { modelProfileId; providerId; endpointId; modelId; routeKind; equivalenceGroup; verified; enabled }[];
  readonly candidates: readonly { candidateId; routeId; modelProfileId; priority; enabled }[];
}
export interface ModelRouteViewV1 { routeId; name; routeKind; credentialPolicy; dataPolicy; equivalenceGroup; spentMicros; totalBudgetMicros; enabled }
export interface SubscriptionAccountViewV1 { accountId; providerId; alias; scope; canManage; status; billingKind; version; connectorId; cooldownUntil?; windows?; minimumRemainingRatio?; earliestResetAt?; quotaExhausted?; quotaObservedAt? }
```

`router.credentials`는 **자격 증명 값을 절대 싣지 않아야** 합니다. 지금도 싣지 않으며, 화면은 label과 종류만 씁니다. 계약에 올릴 때 이 경계를 타입으로 고정하십시오.

## 3. 로컬 운영 환경 — 조회 자체가 없음

헌법 6절은 설정이 *"로컬 운영 환경"*을 소유한다고 씁니다. **daemon 상태·데이터 위치·백업을 볼 조회가 없습니다.** 화면의 `로컬 환경` 구역은 지금 이 사실을 그대로 말합니다.

필요한 것(제품 결정이 먼저): daemon 실행 상태·버전, SurrealDB 데이터 경로와 크기, 마지막 백업 시각.

## 4. 프론트엔드 상태

**연결만 되면 파싱이 사라집니다.**

| 계층 | 위치 |
|---|---|
| 뷰 타입 | `desktop-service.ts` `ModelRouteView`·`ProviderConnectionView`·`SubscriptionAccountView` |
| 투영 | 같은 파일 `projectModelRoutes()`·`projectProviderConnections()`·`projectSubscriptionAccounts()` |
| 문구 | `app.tsx` `routeKindLabel`·`billingKindLabel`·`quotaText` |

투영 셋은 계약이 타입을 주면 **삭제 대상**입니다. 남는 것은 문구 표뿐이고, 그건 화면이 소유하는 게 맞습니다.

## 5. 완료 판정

- [ ] 일곱 조회가 `ApplicationQueryMapV1`에 타입과 함께 등록된다
- [ ] `desktop-service.ts`의 `project*` 셋과 `rows()`/`str()`/`num()`/`bool()` 헬퍼가 삭제된다
- [ ] `SettingsView`의 `unknown` 일곱이 사라진다
- [ ] `router.credentials`가 secret을 싣지 않음이 타입으로 보장된다

## 6. 인풋(Composer)이 앞세운 세 가지

인풋은 「이 요청이 어떤 조건으로 나가는가」를 보내기 전에 말합니다. 셋 다 도메인이 아직 돌려주지 않아
화면 상태로 서 있습니다. 위치는 `app.tsx`의 `WorkActivity` — `modelOverride`·`effortOverride`·`queuedOverride`.

| 화면이 세운 것 | 뷰 타입 | 필요한 계약 |
|---|---|---|
| Work별 모델 선택 | `WorkView.modelId` | Work 단위 모델 배치를 읽고 쓰는 명령. 지금은 조직이 배치한 결과만 활동 로그에서 «읽습니다» |
| 추론 수준 | `WorkView.reasoningEffort` | 도메인에 개념 자체가 없습니다. `router` 스키마에 `reasoning_effort` 축이 서야 합니다 |
| 대기 중인 지시 | `WorkView.queuedDirectives` | `work.directives`가 미반영 지시를 돌려줘야 합니다. 지금은 제출 성공만 알고 큐를 못 봅니다 |

「현재 작업 조정」은 대기 카드의 내용을 `submitDirective(work, content, "now")`로 다시 보냅니다.
`DirectiveMode`는 실제 계약이라 그대로 씁니다 — 바뀐 것은 **고르는 시점**뿐입니다(보내기 전 → 보낸 후).

### 완료 판정 (추가)

- [ ] `work` 조회가 미반영 지시 목록을 돌려준다
- [ ] Work 단위 모델·추론 수준을 읽고 쓰는 명령이 등록된다
- [ ] `WorkActivity`의 세 `*Override` 상태가 삭제된다

## 7. 설정 표면 정리에서 드러난 것

### route_kind 어휘가 둘입니다 — 확인 필요

| 출처 | 값 |
|---|---|
| `packages/router/src/model-router.ts` `RouteKind` | `"chat" \| "embedding"` |
| 픽스처 카탈로그·`model_profile.route_kind` 데이터 | `"reasoning" \| "utility" \| "embedding"` |

화면은 어느 쪽도 박지 않고 **카탈로그에 실제로 있는 값**에서 고르게 했습니다(`routeKinds`).
어느 쪽이 정본인지 정해야 합니다. 전에는 폼이 `"chat"`을 하드코딩해서, 손으로 등록한 모델이
세 라우트 중 어디에도 붙지 않았습니다.

### 고급 라우팅 폼을 제거했습니다

모델·라우트·후보를 손으로 등록하는 폼은 「조직이 모델을 배치한다」(ADR-003)와 정면으로 어긋납니다.
사람이 배치를 손으로 짜는 화면이 있으면 그 주장이 성립하지 않습니다. 화면에서 그 폼이
`registerModel`·`configureRoute`·`addRouteCandidate`의 **유일한 호출처**였습니다. 명령 자체는 남습니다.

폼이 메우고 있던 진짜 빈자리는 **모델 발견**입니다. 손으로 추가한 openai 호환 엔드포인트에서
모델 목록을 읽어 카탈로그에 올리는 경로가 없어서, 사람이 대신 타이핑하고 있었습니다.
그 자리는 설정이 아니라 **프로바이더 표면**입니다 — 방금 추가한 프로바이더가 문맥이니까요.

- [ ] 엔드포인트에서 모델을 발견해 카탈로그에 올리는 명령이 프로바이더 표면에 선다

### 사람이 「검증됨」을 주장할 수 없게 했습니다

`router.model.register`에 `verified: false`를 고정합니다. 검증은 `model_verification_evidence`가
정하는 것이지 등록자가 체크박스로 선언할 값이 아닙니다. 전에는 체크하면 프로바이더 표면의
「미확인」 표시가 근거 없이 사라졌습니다.

### 후보 우선순위가 화면에 없었습니다

`addRouteCandidate`는 `priority`를 받는데 입력이 없어 늘 `0`으로 나갔습니다. fallback 순서가
정해지지 않는다는 뜻입니다. 입력을 세웠습니다.

### 자가개선 채택 모드를 쓰는 명령이 없습니다

읽기(`AutonomyView.growthMode`)만 있고 쓰기가 없어 화면 상태(`growthModeOverride`)로 서 있습니다.
전체 권한일 때 `auto`로 파생되는 규칙은 `effectiveGrowthMode()`가 이미 갖고 있습니다.

- [ ] `route_kind` 정본 어휘를 정한다
- [ ] 자가개선 채택 모드를 쓰는 명령이 등록된다

## 8. 설정에서 걷어낸 것

| 걷어낸 것 | 이유 |
|---|---|
| 고급 라우팅 폼 전체 | ADR-003과 모순. 위 §7 참조 |
| 「데이터」 구역 | 보여줄 값이 하나도 없고 설명문만 있었습니다. daemon 상태 조회가 생기면 그때 세웁니다 |
| 레일의 「긴급 정지」 | Work마다 중단할 수 있으면 전역 정지는 층이 하나 더 있는 것뿐입니다 |
| 권한·자가개선 설명 문단 | 세그먼트가 이미 상태를 말합니다 |

용어도 줄였습니다: 실행 자율성 기본값 → **권한**(자동·수동·바이패스), 자가개선 채택 → **자가개선**(수동·자동).
인풋의 권한 배지도 같은 세 낱말을 씁니다.

## 9. 레일 하단의 연결 상태

조직이 이 컴퓨터에 있는지(`로컬`) 원격 SurrealDB에 있는지(`원격`)를 레일 하단에 세웁니다.
**연결 대상을 읽는 조회가 없어** 지금은 `connection="local"`이 화면에 박혀 있습니다.

전에는 「로컬 연결됨」이 캡션으로 떠 있어 어디에도 속하지 않았습니다. 선으로 끊고 점을 붙여
상태 줄로 만들었지만, 값 자체는 여전히 지어낸 것이 아니라 **고정값**입니다.

- [ ] daemon이 붙은 SurrealDB가 로컬인지 원격인지 돌려주는 조회가 선다
- [ ] 연결이 끊겼을 때를 구분한다 (지금은 점 색이 늘 같습니다)

## 10. 「예산」 표면 — `route_attempt` 조회가 없습니다

예산을 설정에서 빼 프로바이더 아래 전용 표면으로 옮겼습니다. 예산은 **사람이 정한 경계**가
아니라 **관측 대상**이라, 그 경계가 실제로 어떻게 쓰였는지를 보여주는 기록 옆에 서야 합니다.

| 열 | 데이터 | 상태 |
|---|---|---|
| 왼쪽: 경로별 예산 | `router.routes` | **실제 조회** |
| 오른쪽: 호출 기록 | `route_attempt` | **조회 없음** — 픽스처만 |

`packages/router/src/schema.ts`에 `route_attempt`가 이미 있고 필요한 필드를 다 갖고 있습니다:

| 화면이 쓰는 것 | 스키마 필드 |
|---|---|
| 언제 | `created_at` |
| 어느 모델 | `model_profile_id` → `model_profile.model_id` |
| 얼마 | `actual_cost_micros` · `actual_input_tokens` · `actual_output_tokens` |
| 실패 이유 | `status` · `status_code` · `failure_class` |
| fallback 사슬 | `fallback_from_attempt_id` |
| **어느 Work** | `command_id` → **Work로 잇는 경로가 없습니다** |
| **캐시 히트·생성** | **없습니다** — 캐시 토큰이 비용의 대부분을 가르는데 기록되지 않습니다 |
| **추론 토큰** | **없습니다** |
| **소요 시간** | **없습니다** — tok/s를 낼 수 없습니다 |
| **추론 강도** | **없습니다** — 같은 모델도 강도에 따라 비용이 갈립니다 |

`ApplicationQueryMapV1`에 `router.attempts`가 없어 `loadRouteAttempts()`의 실제 구현은
빈 배열이 아니라 **거부**합니다. 「모르는 것」과 「없는 것」은 다르고, 빈 배열은 「호출이 없었다」로
읽힙니다. Tauri에서 이 표면은 지금 그 사실을 그대로 말합니다.

### 예산 알림 — 클라우드 콘솔 문법으로 다시 세웠습니다

「차단 한도」와 「알림 임계값」을 다른 기능으로 두던 것을 **알림 하나**로 합쳤습니다. 알림은
`{범위, 금액, 동작}` 셋이고 동작이 `알림`이냐 `차단`이냐만 다릅니다 — AWS Budgets·GCP 예산
알림과 같은 모양입니다. 범위는 조직 전체(`*`) 또는 경로 하나입니다.

| 화면이 세운 것 | 필요한 계약 |
|---|---|
| 알림 목록(범위·금액·동작) | 도메인에 테이블이 없습니다. `budget_alert`가 서야 합니다 |
| 조직 전체 범위 | `model_route`는 경로 단위뿐이라 조직 합계에 거는 자리가 없습니다 |
| 차단 동작 | `total_budget_micros` 초과 검사(`model-router.ts:967`)가 경로에만 있습니다 |

`total_budget_micros`는 그대로 둡니다 — 경로가 자기 한도를 갖는 것과, 사람이 그 위에 알림을
거는 것은 다른 축입니다.

- [ ] `budget_alert` 테이블과 CRUD 명령이 선다 (범위·금액·동작)
- [ ] 조직 합계에 거는 차단이 라우터 검사에 들어간다
- [ ] 넘긴 알림이 수신함으로 간다

### (이전) 가드 — 하드는 있고 소프트는 없습니다

| 가드 | 뜻 | 도메인 |
|---|---|---|
| 하드 | 도달하면 **차단** | **있습니다.** `model_route.total_budget_micros`, 검사는 `model-router.ts:967` |
| 소프트 | 도달하면 **알림**, 여러 개 | **없습니다.** 개념 자체가 스키마에 없습니다 |

화면은 둘 다 세웠습니다(`RouteGuardBar`). 하드는 기존 필드에 대응하지만 **쓰는 명령이 없어**
지금은 둘 다 화면 상태(`guards`)입니다.

- [ ] `total_budget_micros`를 바꾸는 명령이 선다 (지금은 라우트 생성 때만 정해집니다)
- [ ] 소프트 가드 테이블이 선다 — 라우트당 여러 임계값, 넘으면 수신함으로
- [ ] `router.attempts` 조회를 등록한다 (`router:read`, 최근순, 페이징)
- [ ] `command_id`에서 Work를 잇는다 — 이게 없으면 「어느 Work가 얼마를 썼나」에 답할 수 없다
- [ ] `route_attempt`에 `duration_ms` · `cache_read_tokens` · `cache_write_tokens` · `reasoning_tokens` · `effort`를 더한다
- [ ] `explanation_json`을 상세로 펼친다 (왜 이 모델이 골렸는지 = 인과 사슬의 「모델」 마디)

## 11. 픽스처 실행 제어 — 도메인 전이를 그대로 씁니다

`createFixtureDesktopService()`의 `cancelRun`·`resumeRun`·`submitDirective`가 픽스처 상태를 실제로 바꿉니다.
**앞세운 전이는 없습니다.** 넷 다 도메인에 있는 것입니다.

| 픽스처 | 도메인 정본 | 결과 |
|---|---|---|
| `cancelRun` | `ApplicationRunStore.cancel` | `status: cancelled` · `stage: terminal` · `approvalId` 해제 (`blockedReason`은 도메인도 남깁니다) |
| `resumeRun` | `CoreWorkCoordinator.retryBlocked` = `claim(resumeBlocked)` + `advance` | `blockedReason` 해제 · `leaseGeneration + 1` · 다음 단계 · `status: ready` |
| `submitDirective` | `WorkDirectiveStore.submit` → `projectActivities` | 활동 흐름에 `kind: "message"` · `author: "사용자"` 한 줄 |

픽스처는 실행기가 없어 **`claim` 직후 단계가 성공한 경로 하나만** 밟습니다. 도메인에서는 재개 뒤에도
다시 `blocked`·`awaiting-approval`로 갈 수 있습니다. Work 상태는 건드리지 않습니다 — `run.cancel`도
Work로 전이를 흘리지 않습니다(`run-commands.ts:159`).

### 남은 갭 — 방이 지시를 늦게 봅니다

`app.tsx`의 방 조회 effect가 `[selectedWorkId, service]`에만 겁니다(`app.tsx:300`). 지시를 보내면
Work는 다시 읽히지만 **방은 다시 읽히지 않아**, 같은 Work를 다시 고르기 전까지 흐름에 안 나타납니다.
실 daemon도 같습니다 — 방 발언이 durable event로 늘어도 화면이 안 따라갑니다.

의존성만 더하면 `setSelectedRoomId(value[0]?.roomId)`가 매번 다시 돌아 **사람이 열어 둔 갈라진 방이 닫힙니다.**
선택을 보존하는 갱신이 같이 서야 합니다.

- [ ] Work가 다시 읽힐 때 방도 다시 읽는다 — 열려 있는 방 선택을 보존하면서

---

# 부록 A. 업무 표면 — Records(기록)

Work 상세에 `기록` 탭을 세우고 완료된 Work 픽스처(`refund-delay`)를 넣으면서 확인한 경계입니다.
탭이 그리는 값은 전부 `WorkRecord`(`packages/work/src/work.ts` `:542`)와 `RecordsDocument`
(`packages/records/src/contracts.ts` `:47`)에 실재합니다. 아래는 **도메인에 없어서 화면이 앞세운 것**입니다.

| 화면이 앞세운 것 | 위치 | 도메인 현황 | 필요한 것 |
|---|---|---|---|
| `work.records` 결과를 실제로 싣기 | `desktop-service.ts` `projectWorkDetail()`·`projectWorkSummary()` — 둘 다 `records: []` | `work.records` 조회는 `query-registry.ts` `:1150`에 **있으나** client 계약(`ApplicationQueryMapV1`)에 없음 | `WorkRecordViewV1` 등록. `handle`이 이미 `recordId·version·summary·artifactIds·verificationIds·finalizedAt`로 돌려줌 |
| `recordedRevision`·`finalizedBy`·`snapshotHash`·`eventRange`·`decisionIds`·`documents` | `model.ts` `RecordView` | 테이블 `work_record`에 `recorded_work_revision`·`finalized_by`·`records_snapshot_hash`·`event_start_sequence`/`event_end_sequence`·`decision_message_ids`·`document_ids` **전부 있음** | `work.records`의 `handle` 반환에 이 여섯을 추가. 새 계산 없음 |
| 문서의 `kind`·`checksum` | `model.ts` `RecordDocumentView` | `records_document`에 `kind`·`markdown_checksum` 있음. **Work 조회 경로에는 노출되지 않음** | `work.records`가 `document_ids`를 문서 요약으로 풀거나 `records.documents` 조회 신설 |
| 결정 본문 | `app.tsx` `InspectorRecords()` — `decisionIds`를 `work.activities`의 `decision` 메시지에서 해소 | `decision_message_ids`는 **ID만** 보존. 본문은 `collaboration_message` | 지금 방식(활동 흐름에서 해소)이 맞음. 계약 변경 불필요 |
| 승인 이력 | `app.tsx` `InspectorRecords()` — `work.approvals`를 별도 구역으로 | `WorkRecord`에 **승인 참조가 없음**. 기록이 아니라 Work가 지나온 승인 | 기록이 승인을 보존해야 한다면 `work_record`에 approval 참조 필드가 먼저 필요 |
| 최종 응답 표시(`final`) | `model.ts` `ActivityView.room.final`, `room.tsx` `RoomMessage` | `collaboration_message`에 **최종 응답 표식이 없음**. 대표 에이전트의 책임으로만 존재(`packages/organization/src/organization.ts` `:23`, 헌법 §5) | Records 완료 시점의 Representative `answer`를 도메인이 표시하거나, 화면이 「Work 완료 + 마지막 `answer` + 수신자=사용자」로 계속 파생 |

### 완료 판정

- [ ] `work.records`가 `ApplicationQueryMapV1`에 타입과 함께 등록된다
- [ ] `projectWorkDetail()`의 `records: []`가 실제 투영으로 바뀐다
- [ ] `RecordView`의 여섯 필드가 계약에서 온다
- [ ] 최종 응답이 화면 파생이 아니라 도메인 사실로 읽힌다

## 12. 「개선」 표면 — 채택 이후가 계약에 없습니다

픽스처가 자가개선 한 바퀴(검토 대기 → 채택 → 효과 → 되돌림 / 거부)를 그리도록 채웠습니다.
헌법 §4.8의 「보수적 채택」은 **채택 전후 효과 비교와 악화 시 되돌리기**로만 증명되는데,
그 두 가지가 정확히 계약에서 빠져 있던 부분입니다.

도메인에는 있고 `growth.*` 조회 투영에만 없는 것 — **투영을 넓히면 그대로 채워집니다.**

| 화면이 앞세운 것 | 도메인 | 조회 |
|---|---|---|
| `adoption.adoptedAt` | `growth_adoption_run.created_at` | `growth.suggestions` 투영에 없음 |
| `adoption` 전체 | `growth_adoption_run` | `growth.adoption.get` 조회 자체가 없음 |
| `suggestion.decisionReason` · `decidedAt` | `growth_suggestion.decision_reason` · `decided_at` (마이그레이션 0112, 거절에 **필수**) | 투영에 없음 |
| `effect.measure` (`score` · `observationCount` · `minimumObservations` · `unit` · `direction` · `baseline`) | `growth_effect_baseline.metrics_json` · `contract_json` · `growth_effect_observation` | `growth.effects`가 `rawDelta` · `directionalDelta` · `contractChecksum`만 돌려줌 |
| `effect.suggestionId` | `growth_effect_baseline.suggestion_id` | 투영에 없음 — 없으면 효과를 제안 옆에 세울 수 없습니다 |
| `adoption.revertedAt` | `growth_revert_operation.updated_at` | revert 조회가 없음 |

도메인에도 없어 화면이 **파생으로 대신한 것** — 값을 지어내지 않고 다른 사실에서 읽습니다.

| 화면이 보여주는 것 | 무엇으로 대신했나 | 왜 도메인에 없나 |
|---|---|---|
| 채택 주체 「사람 / 자동」 | `adoption.approvalId` 유무 | 별도 필드가 없습니다. review mode는 `approval_id`를 요구하고 auto mode는 비웁니다(`adoption.ts` `decideAdoptionTransition`). `created_by_user_id`는 auto에서도 채워져 구분이 안 됩니다 |
| 되돌린 사유 「효과 저하」 | 연결된 `effect.result === "degraded"` | **`reason`이 저장되지 않습니다.** `RevertGrowthAdoptionInput.reason`(`degraded` \| `explicit`)은 전이 검사에만 쓰이고 버려집니다. `growth_revert_operation`에 남는 건 `mode`(`auto` \| `review` \| `explicit`)뿐입니다 |

- [ ] `growth.suggestions` 투영에 `adoption` · `decision_reason` · `decided_at`을 더한다
- [ ] `growth.effects`에 `suggestion_id`와 측정 계약(`unit` · `direction` · `minimumObservations` · `baseline` · `score` · `observationCount`)을 더한다
- [ ] `growth_revert_operation`에 `reason`을 저장한다 — 지금은 되돌린 이유를 되물을 수 없습니다
- [ ] revert 조회를 등록한다 (`revertedAt` · `revertedVersionId` · `status`)
- [ ] `growth_adoption_run.exposure_status`(`active` \| `suspended` \| `reverted`)를 노출한다 — 저하로 중단된 상태와 되돌린 상태는 다릅니다
