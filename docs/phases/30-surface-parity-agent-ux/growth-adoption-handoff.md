# 핸드오프 — 개선(자가개선) 평가·승인·효과를 계약에 노출

> **상태:** **절반 구현됨**. 아래 본문은 작성 시점(2026-07-23) 진단이며 그대로 읽으면 안 됩니다
> **정정:** 2026-08-09 코드 대조. `growth.configure`·`growth.suggestion.approve`·`growth.suggestion.reject` 명령과 `growth.suggestion.get` 조회는 **이미 타입 계약에 있고 데스크톱이 호출합니다**. `GrowthSuggestionViewV1`도 patch·evaluation·adoption·reflectionRunId·sourceReferenceIds·revision을 내보냅니다. 남은 것은 ① `growth.revert`가 공개 제품 경로에 없음 ② 신호 `evidence_json`이 투영에서 단위 문자열로 대체됨 ③ 생산 `GrowthWorker` 신호 다섯이 전부 상수라 독립 신호 게이트가 항상 통과함 — 셋뿐입니다. 헌법 §9.3도 함께 갱신했습니다.
> **작성일:** 2026-07-23
> **관련 목표:** [제품 헌법 목표 3 — Growth를 1급 제품 표면으로 완성](../../product/constitution.md)
> **표면 이름:** `개선` (2026-07-23 확정. 구 `성장`)
> **행동 용어:** `승인` / `거부`. 도메인 메서드는 `adopt()`이지만 화면과 명령 이름은 제품 전체의 승인 문법을 따릅니다.
>
> **2026-07-25 범위 복원:** 이 문서 작성 당시 화면 조각에서 미뤘던 `adoptionMode: "auto"`는 개인용 v1 필수 설정으로 복원합니다. 기본값은 `review`이고 사용자가 `auto`를 명시적으로 선택할 수 있습니다. Growth 자동 모드 자체는 독립 평가·Policy·Governance·효과 측정·되돌리기를 우회하지 않습니다. 별도 전역 `full-access`가 켜진 동안에만 Governance 승인 대기를 만들지 않으며 정확성 계보는 유지합니다. 정본은 [지식 축 결정](../../architecture/ADR-002-knowledge-axis-restoration.md)과 [전체 권한 결정](../../architecture/ADR-001-personal-full-access.md)입니다.

## 1. 한 줄 요약

성장 도메인은 **헌법 4.8을 정확히 구현하고 있습니다.** 평가 게이트, 신호 출처 구분, 반대 근거, 측정 기반 효과 판정이 전부 있습니다. Application API는 그중 **판정 결과만 4개 조회로** 내보내고 근거는 전부 버립니다. 그래서 화면은 "무엇을 바꾸자"만 보여주고 "왜 믿어야 하는가"를 보여줄 수 없습니다.

이것은 근거 없는 승인 버튼이며, 헌법 4.8의 *"LLM 자기평가 하나만으로 자동 채택할 수 없다"*가 지키려던 바로 그것을 화면에서 무력화합니다.

## 2. 도메인이 실제로 강제하는 것

### 승인은 평가 없이 불가능합니다

```ts
// packages/growth/src/adoption.ts
interface AdoptGrowthSuggestionInput {
  suggestionId: string;
  suggestionRevision: number;
  evaluationRunId: string;              // 평가 실행이 선행돼야 함
  expectedEvaluationInputHash: string;  // 평가 입력이 그대로여야 함
  expectedTargetChecksum: string;       // 대상이 그동안 안 바뀌었어야 함
  approvalId?: string;
}

interface GrowthAdoptionResult {
  adoption: AdoptionRecord;
  beforeVersionId: string;              // 전후 diff의 양끝
  afterVersionId?: string;
  approvalId?: string;
}
```

`status` enum이 이 순서를 못 박습니다:

```
proposed → evaluated → awaiting-review → adopted | rejected | superseded
```

**`evaluated`가 별도 상태입니다.** 헌법 4.8의 3단계(*"독립된 신호, 반대 근거와 적용 위험을 평가합니다"*)가 도메인에서 승인의 전제조건입니다.

### 신호에 출처와 반대가 있습니다

```ts
// packages/growth/src/evaluation.ts
type GrowthEvaluationOutcome = "eligible" | "ineligible" | "blocked";
type GrowthSignalGroup = "required" | "supporting" | "conflict";

interface GrowthSignalReceiptInput {
  signalId · group · origin: "deterministic" | "independent" | "model-self"
  adapterId · adapterVersion · outcome: "passed" | "failed" | "unavailable" · score
}

interface GrowthEvaluationRun {
  evaluationRunId · suggestionId · strategyVersionId · receiptIds · inputHash · outcome
}
```

`conflict` 그룹이 **반대 근거**이고, `origin`이 *"이 신호가 결정론적인가, 독립 검증인가, 모델의 자기평가인가"*를 구분합니다. 헌법 4.8이 요구한 그대로입니다.

### 효과는 판정이 아니라 측정입니다

```ts
// packages/growth/src/effect.ts
interface GrowthEffectContract {
  strategyVersionId · caseSetChecksum · metricSourceId · metricSourceVersion
  unit · direction: "higher" | "lower"
  stableTolerance · degradationThreshold · minimumObservations
}
interface GrowthEffectSample { score · observationCount · contract }
```

## 3. 계약이 버리는 것

조회는 넷뿐입니다. 명령 레지스트리에는 `growth.configure`·`growth.adopt`·`growth.revert`가 이미 등록돼 있지만 `ApplicationCommandMapV1`에 타입이 없고 데스크톱 서비스가 호출하지 않습니다. `evaluate`·명시적 `reject`·효과 관측은 공개 명령 자체가 없습니다.

```
growth.configuration.get · growth.effects · growth.memories · growth.suggestions
```

`growth.suggestions` 투영(`query-registry.ts:1241`)이 도메인 필드를 이렇게 버립니다.

| 도메인 필드 | 투영 | 잃는 것 |
|---|---|---|
| `reflection_run_id` | **버림** | 어느 회고에서 나왔는지 |
| `patch_json` | **버림** | 전후 diff의 실체. 헌법 목표 3 완료 조건 |
| `source_reference_ids` | **버림** | 원인 Event·Evidence. 헌법 목표 3 완료 조건 |
| `created_at` | 버림 | 언제 제안됐는지 |
| `suggestion_revision` | 버림 | 승인 command가 요구하는 값 |

`growth.effects`는 도메인 레코드를 그대로 흘려보내지만, 화면 뷰는 `result` 한 단어만 씁니다. **표본 수·임계값·측정 단위가 없으면 사용자가 "표본 3개로 개선이라고 한 건가"를 물을 수 없습니다.**

평가 실행(`GrowthEvaluationRun`)과 신호 영수증(`GrowthSignalReceipt`)은 **조회 자체가 없습니다.**

## 4. 노출해야 하는 것

### 조회

| 조회 | 왜 |
|---|---|
| `growth.suggestion.get` | `patch_json` · `source_reference_ids` · `reflection_run_id` · `revision` · `created_at` 포함 |
| `growth.evaluation.get` | `evaluationRunId` · `outcome` · `strategyVersionId` · `inputHash` |
| `growth.evaluation.signals` | 영수증 목록. `group`(required/supporting/**conflict**) · `origin` · `outcome` · `score` · `adapterId`·`adapterVersion` |
| `growth.adoption.get` | `beforeVersionId` · `afterVersionId` · `approvalId` |
| `growth.effects` 확장 | `score` · `observationCount` · `contract`(unit·direction·minimumObservations·degradationThreshold·stableTolerance) |

### 명령

| command | 도메인 | 주의 |
|---|---|---|
| `growth.suggestion.evaluate` | `evaluation.ts` `evaluate()` | 새 공개 명령. 승인 전 필수 단계 |
| `growth.suggestion.approve` | 기존 `growth.adopt` → `adoption.ts` `adopt()` | 제품 용어에 맞춰 별칭을 추가하거나 기존 명령을 타입화합니다. `evaluationRunId` · `expectedEvaluationInputHash` · `expectedTargetChecksum`이 필요합니다. |
| `growth.suggestion.reject` | | 거부도 기록으로 남아야 함 |
| `growth.adoption.revert` | 기존 `growth.revert` → `revert.ts` | 기존 명령을 타입화하고 데스크톱에 연결합니다. |
| 내부 effect worker | `effect.ts` `observe()` · `captureBaseline()` | 공개 raw score 명령을 만들지 않고 Work·target version·Assurance·Records checksum에서 검증된 표본만 전달 |

**Governance 게이트를 반드시 통과시키십시오.** `packages/growth/src/governance-adapter.ts`와 `GrowthAdoptionAuthorizer`가 있습니다. 헌법 4.6이 *"자기수정의 버전, 평가와 되돌리기"*를 사람의 통제 대상으로 규정합니다.

## 5. 화면이 필요로 하는 형태

`개선`은 흐름을 지켜보는 화면이 아니라 **증거를 읽고 한 번 판단하는 화면**입니다. 코드 리뷰나 논문 심사에 가깝고, Work의 실시간 관제 문법과 다릅니다.

판단에 필요한 것을 순서대로:

1. **무엇을 바꾸자** — `summary` · `operation` · `targetKind`
2. **왜** — `rationale`, 그리고 `source_reference_ids`가 가리키는 원인 Work·Event·Evidence
3. **평가가 뭐라고 했나** — `outcome`, 그리고 신호를 `required` / `supporting` / **`conflict`**로 나눠서. `origin`이 `model-self`인 신호는 **그렇게 표시해야 합니다.** 모델 자기평가와 독립 검증을 같은 무게로 그리면 4.8이 무너집니다.
4. **무엇이 바뀌나** — `patch_json` 기반 전후 diff
5. **아직 유효한가** — `expectedTargetChecksum`이 현재 대상과 일치하는지. 어긋나면 승인 불가이며 그 사실이 보여야 합니다
6. **나아지는 것 / 감수할 것** — `expected_effect` · `risk_summary`
7. **승인 후** — `beforeVersionId → afterVersionId`, 효과 측정값(표본 수 포함)과 되돌리기

`gate`(노랑)는 사람의 결정이 필요한 지점에만 씁니다. 목록 전체를 노랗게 칠하지 않습니다.

## 6. 완료 판정

- [ ] 제안 상세에서 `patch_json` 기반 전후 diff를 볼 수 있다
- [ ] 제안이 원인 Work·Event·Evidence를 `source_reference_ids`로 가리킨다
- [ ] 평가 결과와 신호가 `required` / `supporting` / `conflict`로 구분돼 보인다
- [ ] `origin: "model-self"` 신호가 독립 신호와 구별돼 표시된다
- [ ] `evaluated` 상태를 거치지 않은 제안은 승인 버튼이 활성화되지 않는다
- [ ] `expectedTargetChecksum` 불일치가 승인 불가 사유로 화면에 나타난다
- [ ] 승인이 Governance 결정을 통과해야만 적용된다
- [ ] 효과가 판정만이 아니라 측정값(score·observationCount·임계값)과 함께 보인다
- [ ] `beforeVersionId → afterVersionId`와 Revert가 같은 계보에서 보인다
- [ ] 실제 Work 완주 → 제안 → 평가 → 승인 → 후속 Work 효과 확인 또는 Revert 증거를 `docs/evidence/phase-30/`에 남긴다

마지막 항목은 헌법 목표 5의 전체 시나리오 중 뒷부분과 같습니다.

## 7. 현재 데스크톱 상태

`apps/desktop/src/app.tsx` `GrowthSurface`는 위 데이터가 없어 다음만 보여줍니다: `summary` · `operation` · `targetKind` · `rationale` · `expectedEffect` · `riskSummary` · `workId` · `status`.

승인·거부 버튼은 **비활성**이고 *"승인·거절 명령이 아직 연결되지 않았습니다"*가 붙어 있습니다. `app.integration.test.tsx`가 `toBeDisabled()`로 이를 고정하므로, 기존 `growth.adopt`와 새 거절 경로를 연결하는 사람이 그 테스트를 고쳐야만 통과합니다.

화면은 fixture로 완성본 형태를 이미 그려 두었습니다: `어디서 나왔나`(source reference를 종류별로 푼 목록) · `왜` · `평가`(신호를 `필수`/`보강`/`반대` × `결정론`/`독립 검증`/`자기평가`로 표시) · `무엇이 바뀌나`(전후 diff) · `승인하면` · `적용 후 측정`. `growthBlockers()`가 평가 미실행·필수 신호 실패·대상 drift를 승인 불가 사유로 미리 계산합니다.

**조회가 붙으면 fixture를 실제 데이터로 바꾸기만 하면 됩니다.** 뷰 타입은 `apps/desktop/src/desktop-service.ts`의 `GrowthSignalView` · `GrowthEvaluationView` · `GrowthPatchLineView` · `GrowthEffectMeasureView`에 있으며, 계약에 없는 필드라는 주석이 달려 있습니다.

## 8. 화면이 지금 못 채우는 것

데스크톱은 `업무`와 같은 3열 골격·46px 헤더 밴드·열 폭을 이미 맞췄습니다. 다음 두 가지는 **계약이 넓어져야 채워집니다.**

### 실시간 갱신

`업무`는 `subscribeDurable`로 사건을 받아 화면이 스스로 갱신됩니다. **`growth.*` 공개 이벤트가 없습니다.** 새 제안이 올라오거나 상태가 바뀌어도 화면은 모르고, 사용자가 표면을 다시 열어야 합니다.

필요한 것: `growth.suggestion-created` · `growth.suggestion-evaluated` · `growth.suggestion-adopted` · `growth.suggestion-rejected` · `growth.effect-observed`를 공개 event stream에 올리고, 영향받는 조회를 무효화하게 합니다. `업무`가 `work.*` 사건으로 하는 것과 같은 방식입니다.

### 원인 작업의 이름

`source_reference_ids`는 `work:churn-q3` 형태의 **식별자만** 줍니다. 화면은 종류를 `업무 · 협업방 발언 · 검증 · 조직 변경 · 실행 · 산출물`로 풀어 보여주고 업무는 열 수 있게 했지만, **제목을 보여줄 수 없습니다.**

사용자가 근거를 추적하려면 `3분기 고객 이탈 원인 분석`이 보여야지 `churn-q3`이 보여선 안 됩니다. 조회가 참조마다 `{ kind, id, title }`을 함께 주거나, 데스크톱이 참조를 종류별로 다시 조회할 수 있는 경로가 필요합니다.

### 개선 작업의 종류

`growth_suggestion.operation`은 스키마에 `ASSERT`가 없는 **자유 문자열**입니다(`packages/growth/src/schema.ts:268`). `target_kind`는 4종 열거로 강제되는데 `operation`은 열려 있고, 실제 사용례는 `replace-instruction` 하나뿐입니다(`adoption.test.ts:45`).

열거가 아니면 화면이 문구 표를 만들 수 없습니다. 지금은 원문을 mono로 강등해 두었습니다. **어떤 값을 쓸지 정하고 `ASSERT $value IN [...]`으로 고정하십시오.** 그 뒤에 화면이 한글 문구를 붙입니다.

## 9. 복원된 v1 경계

- **검토형과 자동형을 모두 연결합니다.** 기본 `review`는 사용자 승인·거절을 기다리고, 사용자가 설정한 `auto`는 독립 평가와 Governance allow를 받은 Prompt·Memory·Policy·Organization 후보를 개별 승인 없이 적용합니다.
- **Growth 자동형은 전역 전체 권한과 다릅니다.** `auto`는 `model-self` 신호 하나, stale source·target, conflict 신호, Policy deny와 필수 승인을 우회할 수 없고 상위 승인이 필요하면 수신함의 검토 대기로 승격합니다. 사용자가 별도로 `full-access`를 켠 경우에만 이 승인 대기를 생략합니다.
- **완료 Records가 Reflection 시작점입니다.** 기존 `growth_trigger_on_records_completed`와 trigger store를 생산 worker에 연결하고, source checksum을 검증한 snapshot만 generator에 전달합니다.
- **효과와 복원까지 한 기능입니다.** 기존 Assurance MetricObservationStore에서 Work·target version·Assurance·Records reference와 checksum이 있는 표본만 만들고, 다음 Work부터 새 version을 쓰며 동일 EffectContract로 관찰합니다. 검증된 `degraded`이면 노출을 중단하고 멱등 worker가 기존 revert 경로를 호출합니다. 복원 전에는 새 Work가 suspended version을 선택할 수 없습니다. 사후 Policy 변경 충돌은 새 Work를 차단하고 사용자의 명시적 되돌리기로 처리합니다.
