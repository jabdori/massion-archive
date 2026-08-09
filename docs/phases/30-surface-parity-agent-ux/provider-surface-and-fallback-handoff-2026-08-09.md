# Provider 표면·Fallback 세션 인계서

> 기준 시각: 2026-08-09 (Asia/Seoul)
> 저장소: `/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled`
> 브랜치: `feat/phase-30-reconciled`
> 세션 시작 HEAD: `92ed55d5d` / 세션 종료 HEAD: `d5219bbe5` (커밋 22개)
> 상위 정본: [`aaa-v1-continuation-handoff-2026-08-05.md`](aaa-v1-continuation-handoff-2026-08-05.md)
> 제품 상태: **완료 아님.** 이 문서는 그 정본의 §7.4·§7.5·단계 1~2 구간을 실제로 실행한 기록이며, 나머지 단계는 그대로 남아 있습니다.

---

## 0. 이 문서를 읽는 법

상위 인계서(`aaa-v1-continuation-handoff-2026-08-05.md`)가 여전히 정본입니다. 배경·제품 의도·전체 로드맵은 거기에 있고, 이 문서는 **그 중 어디를 실제로 손댔고, 무엇이 드러났고, 무엇이 남았는지**만 다룹니다.

두 문서가 충돌하면 이 문서가 이깁니다(더 최근 실행 기록). 다만 이 문서에 없는 항목은 상위 인계서가 그대로 유효합니다.

**이 세션의 성격**: 사용자가 Codex 구독을 소진해 작업이 막힌 상태에서 시작했고, "대체 Provider로 넘어가게 해달라"는 요청이 **fallback 배선 → provider 표면 전반 → 트랜잭션 인프라**로 번졌습니다. 실제 앱 화면을 사용자가 직접 보며 지적한 결함이 조사의 주 동력이었습니다.

---

## 1. 시작 상태와 요청

사용자 요청은 셋이었습니다.

1. DeepSeek이 provider로 등록돼 있는지 확인하고, 없으면 등록
2. "모델 fallback/콤보" 기능이 구현돼 있는지 확인하고, 없으면 구현
3. **소진된 Codex를 대체해 동작**하게 만들고, 그걸 바탕으로 나머지 구현을 진행

### 1.1 확인 결과 (조사만으로 드러난 사실)

| 항목 | 사실 |
|---|---|
| DeepSeek 등록 | **이미 등록돼 있었습니다.** 코드(`deepseek-community-provider.ts`), DB(`model_provider`·`model_profile`·`model_route_candidate` 5개 route × priority 100) 전부 |
| DeepSeek endpoint | **사망.** `https://q5dh1rfszfym23hj.us-east-2.aws.endpoints.huggingface.cloud/v1` → HTTP 404 + "free public endpoint … has been retired". `/v1/models`·`/v1/chat/completions` 둘 다 직접 확인 |
| HF Space 페이지 | HTTP 200이지만 그 안 `index.html`이 가리키는 endpoint가 위와 **동일한 죽은 URL** |
| 대안 발견 | `https://router.huggingface.co/v1/models`에 `deepseek-ai/DeepSeek-V4-Flash-0731`이 **살아 있음**. 단 HF 토큰 필요(이 Mac에 없음) + 유료 |
| fallback 인프라 | **구현돼 있었습니다.** `route_attempt.fallback_allowed`·`fallback_from_attempt_id`·`failure_class`, `model_route_candidate.priority`, `classifyFailure`가 429를 `quota`+`fallbackEligible: true`로 정확히 분류 |

**즉 fallback은 만들 것이 아니라 고칠 것이었습니다.**

### 1.2 사용자 결정

- DeepSeek 무료 endpoint는 죽었으므로 **GLM 우선 + 다른 무료 provider 탐색**
- Z.AI GLM Coding Plan은 **사용 가능** (사용자 확인)
- OpenRouter 무료 모델 중 `nvidia/nemotron-3-ultra-550b-a55b:free` 추가 (도구 지원, 1M 컨텍스트, 과금 0)

---

## 2. 근본 원인 다섯 겹

이 세션에서 발견한 결함은 서로 가려져 있었습니다. **하나를 고쳐야 다음이 보이는** 구조라, 순서대로 기록합니다.

### 2.1 Codex 실패가 fallback을 막던 이유 — `e7bb4bd2d`

`apps/server/src/codex-app-server-agent.ts`가 turn 실패를 이렇게 보고했습니다.

```ts
sideEffectsStarted: safeAuthenticationFailure ? false : true,
```

`safeAuthenticationFailure`는 **401일 때만** 참입니다. 따라서 401이 아닌 모든 실패 — **정확히 구독 소진(429/usage limit)을 포함** — 이 무조건 `sideEffectsStarted=true`로 보고됐고, 라우터 게이트

```ts
fallbackAllowed = classified.fallbackEligible && emittedTokens === 0 && !sideEffectsStarted
```

에서 차단됐습니다. **라우터는 옳았고 어댑터가 사실을 왜곡**하고 있었습니다.

어댑터는 이미 부작용을 정교하게 추적하고 있었습니다(승인 요청·non-userMessage item·agent delta·output token·알 수 없는 notification 단계). 그 관측값이 resolve 지점에서 통째로 버려진 것입니다.

**수정**: `appServerAuthenticationFailed` → `appServerFailureSignal`로 일반화해 공식 transport 실패 4종의 실제 HTTP 상태를 보존하고, `sideEffectsStarted`는 관측값을 그대로 보고. 인식하지 못한 형태는 signal 없이 fail-closed 유지. **라우터 게이트는 건드리지 않았습니다.**

### 2.2 구조화 출력 실패가 fallback을 막던 이유 — `d424c202f`

`voltagent-runner.ts`의 세 catch가 `sideEffectsStarted: lease.kind === "agent-runtime"`로, **lease 종류만 보고** 부작용을 단정했습니다. Codex가 정상 완료했는데 응답만 스키마에 안 맞는 경우도 "이미 workspace를 건드렸다"로 처리돼 동급 모델 fallback이 막혔습니다.

schema validate 실패는 `validation.error` 원문을 reject해 marker가 없었고, `failureSignal()`이 `unknown`으로 분류해 **두 번째로** fallback을 막았습니다.

**수정**: `SubscriptionStructuredOutputError`를 도입해 어댑터가 관측한 부작용·토큰 수를 실어 나르고, `failureSignal`이 이를 output 실패로 인식하며, 세 catch가 그 값을 읽도록. 값이 없는 오류는 기존 lease-kind 가정을 유지(fail-closed).

### 2.3 트랜잭션이 사라지는 문제 — `bf7e855d8`

**이것이 사용자를 실제로 막고 있던 것입니다.** 제거·등록 등 아무 command나 무작위로 500이 났고, 화면에는 "요청을 처리하지 못했습니다"만 떴습니다.

SurrealDB 로그:

```
WARN Transaction 019fd3cd-… not found in WebSocket transactions map (have 0 transactions)
```

모든 트랜잭션이 WebSocket 하나를 공유하는 구조(`bde95f8b1`이 `forkSession` 제거)라, 서버 쪽 맵이 비면 진행 중이던 트랜잭션이 통째로 사라집니다. 그 시점에 커밋된 것은 없으므로 **재시도가 안전**한데, 이 오류가 재시도 목록에 없었습니다.

**수정**: `isLostTransaction()`을 `isCompatibleRetryableConflict`에 추가. 패턴은 문장 시작에 고정(`/^transaction(?:\s+[0-9a-fA-F-]+)?\s+not found/iu`).

> **주의**: 첫 시도에서 `/\btransaction\b[^]*\bnot found\b/`로 넓게 잡았더니 **application 테스트 3건이 깨졌습니다.** 한 번만 실패해야 할 것들("Membership 없는 tenant" 등)까지 4번씩 재시도했기 때문입니다. 재시도 판정을 넓히는 것은 조용히 의미를 바꾸는 변경입니다.

> **미해결**: **왜 맵이 비는지는 밝히지 못했습니다.** 연결 재수립인지, 동시 트랜잭션 경합인지, 서버 타임아웃인지 모릅니다. 이번 수정은 증상이 사용자에게 도달하지 않게 막는 것입니다. 상위 인계서 §0.I.1의 "transaction warning 누적 1,462"와 같은 뿌리로 추정합니다.

### 2.4 은퇴가 자기를 숨긴 문제 — `7cd32e448`

제거를 두 단계로 설계했습니다(실행 계보가 있으면 은퇴, 없으면 삭제). 그런데 `requireProvider`가 `enabled = true`만 조회합니다. **첫 제거가 비활성화한 대상을, 두 번째 제거가 찾지 못했습니다.** 상태를 바꾸는 연산이 자기가 바꾼 상태에서 다시 호출되는 경로를 테스트하지 않은 결과입니다.

**수정**: 제거는 활성 여부와 무관하게 조회. `retired` 판정에 `provider.enabled`를 추가해, 이미 은퇴한 것을 다시 제거하면 등록이 삭제되도록.

### 2.5 불변 증거를 지우려 한 문제 — `9fb3f017b`

완전 삭제 경로가 `model_verification_evidence`를 지우는데, 스키마가 명시적으로 금지합니다.

```sql
DEFINE EVENT model_verification_evidence_immutable ON TABLE model_verification_evidence
  WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW '…immutable입니다'; };
```

DeepSeek에 그런 기록이 3건 있어 삭제가 통째로 막혔습니다. **DB가 옳고 삭제 코드가 틀렸습니다** — 증거는 "이 모델이 실제로 응답했다"는 기록이고 등록 정보보다 오래 살아야 합니다.

**수정**: evidence 삭제 제거. model profile만 삭제하고 evidence는 남김.

---

## 3. Provider 표면에서 드러난 것

사용자가 실제 화면을 보며 지적한 것들입니다. **대부분 백엔드는 이미 있고 화면으로 오는 길만 없던 경우**입니다.

### 3.1 지원 provider 카탈로그가 버려지고 있었음 — `7c535f944`

서버 `subscription.providers`는 **15개 manifest를 반환**하는데, `projectProviderConnections`가 `openai-codex` **하나만** 골라내고 나머지를 버렸습니다. Anthropic Claude Code, Gemini CLI, Copilot, MiniMax, xAI, Nous, Z.AI 전부 등록 전에는 보이지 않았습니다.

**수정**: 연결 가능한 manifest를 전부 노출. 단 `connectionSurface`가 `server-only`/`server-and-edge`인 것만 — `edge-only`(Gemini CLI, Copilot, xAI Grok)는 이 데스크톱 앱이 연결할 수 없어 보여주는 것 자체가 거짓 약속입니다.

### 3.2 등록한 provider에 키를 붙일 수 없었음 — `980e1b0dc`, `9be0dbfb0`, `428eb0007`, `b13622de9`

**같은 형태의 결함이 네 번 반복됐습니다: 화면이 무언가를 하려면 그 식별자가 뷰까지 와야 하는데, 매번 투영에서 잘려 있었습니다.**

| 커밋 | 잘려 있던 것 | 증상 |
|---|---|---|
| `980e1b0dc` | `endpointId`(register 응답) | 등록은 되는데 `addCredential`이 서버에 도달조차 못 함 |
| `9be0dbfb0` | `credentialVersion` 판정 소스 | 키 저장 후에도 "등록된 키가 없습니다" |
| `428eb0007` | `router.credentials`가 투영에 안 넘어감 + query가 `version`/`secretVersion`을 안 냄 | 위와 같음, 더 깊은 층 |
| `b13622de9` | 키를 `find()`로 단수 취급 | Z.AI는 키 2개인데 1개만 보이고, **새 키 추가에 "키 교체"가 뜸** |

`980e1b0dc`의 원인이 특히 교훈적입니다. 서버는 base_url을 정규화해 저장하는데(`new URL().toString()` + 끝 슬래시 제거) UI가 **사용자가 타이핑한 원문**으로 endpoint를 되찾았습니다. 정작 register 응답이 `endpointId`를 이미 돌려주고 있었습니다.

`b13622de9`가 사용자가 가장 강하게 지적한 것입니다("왜 새롭게 추가하는 오픈라우터면 키 교체냐"). 계정은 목록으로 보여주면서 키는 단수로 모델링해 **같은 화면에 두 문법**이 생겼고, "추가"와 "교체"가 구분되지 않았습니다. 지금은 키도 계정과 같은 행 목록이고 버튼은 언제나 "키 추가"입니다.

### 3.3 넣을 수는 있고 뺄 수는 없었음 — `46e92b3d5`

`router.credential.disable`과 `subscription.account.disconnect`가 **둘 다 서버에 있었고** 화면 경로만 없었습니다. 8라운드 시각 검수도 이걸 못 잡았는데, 검수가 "빈 상태에서 다음 행동이 있는가"만 묻고 **"뭔가 있을 때 지울 수 있는가"**는 한 번도 묻지 않았기 때문입니다.

### 3.4 죽은 토큰 둘 — `da26f7204`

- `border-warning/40`·`bg-warning/10`이 **존재하지 않는 토큰**을 참조. `styles.css`에 `warning` 0건 → Tailwind가 규칙을 생성하지 않음 → 연결 충돌 배너가 테두리도 배경도 없이 렌더
- `--color-muted: var(--fg-3)`인데 `:root`는 `--muted: var(--fg-4)`. **`text-muted`와 `text-fg-3`이 같은 픽셀**이라 활성/비활성 점의 삼항이 no-op였고, 4단계 글자 램프 중 `fg-4`가 276곳의 `text-muted` 뒤에서 도달 불가

`--color-muted` 수정은 276곳에 영향을 주므로 대비를 계산해 확인했습니다: `fg-4`(#838993)는 가장 밝은 배경(#1b1d20)에서도 **4.76:1**로 WCAG AA를 넘습니다.

### 3.5 저장되지 않는 컨트롤 — `da26f7204`

모델 패널의 토글이 `disabledModels` 로컬 state만 바꾸고 저장되지 않았습니다. 게다가 좌측 카운트는 서버 `model.enabled`, 우측은 로컬 state를 봐서 **같은 화면이 `7/7`과 `6/7`을 동시에** 표시했습니다. `model.enable` 계약이 없으므로 컨트롤을 제거하고 읽기 전용으로 내렸습니다.

### 3.6 `cn()`이 tailwind-merge가 아니었음 — `9be0dbfb0`

`className` override가 base를 **대체하지 않고 뒤에 덧붙기만** 합니다. 승자는 class 속성 순서가 아니라 스타일시트 방출 순서가 정합니다. 컴파일러로 실측한 결과:

```
.rounded-lg(4662)  .rounded-xl(4706)  → rounded-xl 승
.bg-chrome(4818)   .bg-popover(4868)  → bg-popover 승
.ring-0(4919)      .ring-1(5201)      → ring-1 승
```

즉 **`AlertDialogContent`에 건 시각 override가 한 줄도 화면에 닿지 않았고**, 없애려던 `ring-1` 위에 `border`가 얹혀 이중 테두리가 됐습니다. 컴포넌트 base를 직접 고치는 것으로 해결하고, `lib/utils.ts`에 이 함정을 주석으로 남겼습니다.

같은 원인으로 `dialog.tsx`의 `max-w-md`가 호출부의 520px/440px을 448px로 자르고 있었습니다. **상한만 지우면 이기던 `w-full`이 남아 뷰포트 전체로 벌어지므로**, 이기던 값을 빼야 합니다(`5c6bfc0ce`).

### 3.7 i18n 배선 — `f905ab9c5`, `b4ff3cacf`, `550da60c6`

번역 누락이 **네 형태**로 나타났고, 마지막 셋은 카탈로그에 번역이 이미 있는데도 쓰이지 않은 경우입니다.

| 형태 | 커밋 | 내용 |
|---|---|---|
| 등록 안 함 | `f905ab9c5` | 배너 문구·`미사용`(sr-only 안!)이 카탈로그에 없어 영어 로캘에서 한국어 렌더 |
| 감싸지 않음 | `5c6bfc0ce` | `PROVIDER_ADAPTERS`의 라벨이 `translate()`를 안 거침 |
| 렌더 지점 미호출 | `b4ff3cacf` | `{error}`·`{notice}`가 상태값을 그대로 출력. **11개 번역이 사문**이었고 `role="alert"`/`role="status"` 안이라 영어 스크린리더가 한국어를 낭독 |
| JSX 리터럴 미호출 | `550da60c6` | 상태 칩·인증 필드·로그인 라벨 등 16곳. 왼쪽 목록 헤더는 "Available", 200px 오른쪽 상세 헤더는 "사용 가능" — **한 화면 두 언어** |

문장을 조각내 이어붙인 것도 문제였습니다. `{name}{translate("는 공식 …")}`은 한국어 조사가 하드코딩돼 받침 있는 이름에서 틀리고, 영어는 어순이 달라 **번역 자체가 불가능**합니다. 이름을 빼고 완성 문장 하나로 바꿔 세 문제를 한 번에 없앴습니다.

---

## 4. 신설한 가드 (`apps/desktop/src/styles.test.ts`)

기존 가드가 이 결함들을 **하나도 못 잡았습니다.** 이유가 둘이었습니다.

1. 스캔 대상에 `components/ui/`가 없었습니다 — `bg-muted/50`, `rounded-xl`, 무색 `border-t`가 전부 사각지대
2. 최종 단언이 접두사 화이트리스트로 걸러졌고 **`warning`이 목록에 없었습니다** — 첫 BLOCK이 이 테스트를 통과했을 것

**추가한 것** (테스트 11 → 13):

| 가드 | 무엇을 막는가 |
|---|---|
| 색 유틸리티 전수 | 정의되지 않은 토큰(`bg-warning`). 접두사 필터 삭제, 대신 색이 아닌 유틸리티를 `nonColor` 정규식으로 제외 |
| translate 키 존재 | `translate("…")` 인자가 카탈로그에 없는 경우 |
| 한글 리터럴 감쌈 | **부류 전체** — 한글이 든 리터럴이 `translate()` 밖에 있는가. 괄호 깊이를 걸어 `translate(a ? "A" : "B")`도 인정하고, 상태 경유·상수 정의 두 간접 경로를 인식 |

**셋 다 결함을 일부러 재주입해 실패하는 것까지 확인했습니다.** "테스트를 추가했다"와 "테스트가 잡는다"는 다른 주장입니다.

범위는 `ProviderField` ~ `SettingsSurface` 구간으로 한정했고 사유를 주석에 남겼습니다. `room.tsx`에 미등록 20건이 있어 전체로 켜면 첫날부터 실패하고, **첫날부터 실패하는 가드는 꺼집니다.**

---

## 5. 시각 검수 8라운드

사용자 요청으로 독립 검수 에이전트를 붙였습니다(`omd-designer-review`, "매우 혹독한 비평가, AAA 아니면 FAIL").

```
Round 1  BLOCK 8   10항목 전부 FAIL
Round 2  BLOCK 3   3항목 PASS
Round 3  BLOCK 3   5항목 PASS/부분
Round 4  BLOCK 1   7항목
Round 5  BLOCK 1   8항목
Round 6  BLOCK 1   9항목, 접근성만 FAIL
Round 7  BLOCK 1   상태 표현만 FAIL
Round 8  BLOCK 0   AAA: PASS
```

누적 BLOCK 18건 전부 해소. 최종 판정은 검수 자신의 가드와 무관한 독립 스캔으로 검증됐습니다(렌더되는 한글 리터럴 54개, 미등록 0, 미감쌈 0).

**검수가 남긴 미처리 항목**(PASS를 막지 않음으로 확인):

- `AccountCard` 카드 vs 목록 행 → `3613f7d9b`에서 처리
- 사용 가능/비활성 글리프 동일 → `3613f7d9b`에서 3갈래로
- `h-px` 사용량 막대 → `3613f7d9b`에서 3px로
- 반그리드 간격, halt 색 과부하, 임의 px 30건 → **미처리**. 값은 전부 스케일 위라 화면에는 안 보이고 유지보수성 항목

**검수의 한계도 기록합니다.** 8라운드 내내 코드만 읽었고 실행 화면을 보지 않았습니다. 그래서 "키가 있을 때 지울 수 있는가"(§3.3)와 "키가 여럿일 때"(§3.2)를 놓쳤고, 사용자가 실제 앱에서 즉시 발견했습니다.

---

## 6. 이 세션에서 반복된 실수 (다음 에이전트가 피할 것)

### 6.1 코드를 고치고 빌드하지 않음

**8라운드 동안 코드만 고치고 앱을 다시 빌드하지 않았습니다.** 사용자는 12:56에 빌드된 구 번들을 계속 보고 있었고, 그래서 "제거 확인이 다이얼로그로 안 뜬다", "키 추가가 없다"는 지적이 나왔습니다 — **이미 고쳤지만 화면에 없던 것들**입니다.

검수는 소스를 읽고, 저는 테스트를 돌리고, 사용자는 실행 화면을 봤습니다. **셋이 서로 다른 것을 보고 있었습니다.**

### 6.2 build exit code를 캡처하고 읽지 않음

`BUILD_EXIT=1`이 출력에 그대로 있었는데 다음 단계로 넘어가 잘못된 앱을 두 번 드렸습니다. 상위 인계서 §5.1이 정확히 이 함정을 경고하고 있었습니다.

### 6.3 "고쳤다"는 보고가 코드와 다름 (3회)

`bg-muted` 미반영, `dialog.tsx` 미반영, `ProviderField` 대신 `GrowthField` 수정. 시각 전용 변경은 타입도 lint도 문자열을 보지 않습니다. **`git diff --stat`으로 의도한 파일이 목록에 있는지 확인**하는 습관을 중간부터 도입했고, 실제로 prettier 재포맷으로 깨진 치환을 즉시 잡았습니다.

### 6.4 파일을 잘라먹음

`open(p,'w')` 후 write에서 예외가 나 `desktop-service.ts`(242KB)가 **0바이트가 됐습니다.** `git checkout`으로 복구했습니다. 파이썬으로 파일을 다시 쓸 때는 **읽기·변환·검증을 모두 마친 뒤에만** 열어야 합니다.

### 6.5 눈에 먼저 띈 경고를 원인으로 지목

빌드 실패 때 `Tarball download 15 KiB/s` 경고를 원인으로 결론지었으나, 진짜 오류는 스택 위쪽의 `ENOTDIR`이었습니다(§8.1).

---

## 7. 현재 상태 (실측)

### 7.1 Provider·Route

```
model_provider:  openai-codex(활성) · zai-coding-plan(활성)
                 huggingface-deepseek-community → 삭제됨
model_route_candidate: 10개 = 5 route × (Codex, GLM)
model_verification_evidence: 12건 보존
route_attempt: 68건 보존
```

DeepSeek 제거는 `removed: true`로 실제 성공을 확인했습니다(HTTP 200, 1.5초).

**OpenRouter는 provider·endpoint·키가 등록돼 있습니다**(`기본 키`, api_key, active, v1). 다만 **model profile과 route candidate는 아직 없습니다** — 즉 fallback 후보로 참여하지 않습니다.

### 7.2 테스트

| 패키지 | 결과 |
|---|---|
| apps/desktop | 11 files, **278 passed** |
| packages/router | 6 files, 1 skipped, **94 passed** |
| packages/application | 54 files, 1 skipped, **554 passed** |
| apps/server | 43 files, 2 skipped, **344 passed** |
| packages/storage | **22 passed**, 1 skipped |
| packages/runtime | 23 files, 1 skipped, **257 passed** |

typecheck·ESLint·Prettier 전부 통과.

### 7.3 빌드·실행

- `tauri:build` **exit 0** (2026-08-09 10:14)
- 앱 ready **16~24초**
- **정상 종료에 25~30초** 소요, `server.shutdown.failed`로 끝나는 경우 관측

---

## 8. 환경 함정 (코드 아님)

### 8.1 끊어진 pnpm store 심볼릭 링크

```
/Volumes/Crucial P3 PLUS/.pnpm-store → /private/tmp/massion-pnpm-store-current (없음)
```

7월 16일에 만들어진 링크의 대상이 `/tmp`에 있어 재부팅으로 사라졌습니다. pnpm이 그 자리에 디렉터리를 만들려다 `ENOTDIR`로 죽어 **빌드가 두 번 실패**했습니다. 새 의존성(`@massion/subscriptions`)을 추가하면서 처음 그 경로를 타게 돼 드러났습니다.

**조치**: 링크 삭제(사용자 승인). 이제 기본 store(`~/Library/pnpm/store/v11`)를 씁니다. **다시 나타나면 같은 곳을 보십시오.**

### 8.2 dev server의 CSS가 불완전

`vite dev`(5173)의 스타일시트에 **`.w-full` 규칙 자체가 없었습니다**(449 규칙 vs 프로덕션 1339). `app.tsx`에 36회 쓰이므로 소스에서 빠질 수 없습니다.

**결과**: dev에서 잰 다이얼로그 폭·radius·색은 전부 근거가 되지 못합니다. **시각 확인은 프로덕션 빌드(`vite build` → `vite preview`)에서만** 하십시오.

### 8.3 renderer는 바이너리에 압축 임베드

`strings massion-desktop | grep "…"`로는 renderer 문자열이 **하나도 안 잡힙니다**(기존 문구도 0건). 번들 반영 확인은 `apps/desktop/dist/assets/*.js`를 보십시오.

---

## 9. 남은 작업

### 9.1 이 세션에서 열었으나 닫지 못한 것

| # | 항목 | 상태 |
|---|---|---|
| 1 | **OpenRouter를 fallback 후보로 등록** | 키까지 등록됨. `router.model.register` + `router.candidate.add`로 `nvidia/nemotron-3-ultra-550b-a55b:free`를 5개 route에 GLM 다음 우선순위로 넣어야 함. **UI에 model/candidate 등록 경로가 없어** command로 해야 함 |
| 2 | **fallback 체인 실검증** | Codex 소진 → GLM → nemotron이 실제 route attempt로 이어지는지. §2.1·§2.2 수정의 실전 증명이 아직 없음 |
| 3 | **트랜잭션 유실 근본 원인** | 재시도로 증상만 막음. 왜 맵이 비는지 미해결 |
| 4 | **outbox 미수렴** | pending **27,032건**. `product.ts:334`의 `scheduleProjection`이 command/run에서만 호출되고 한 번에 1,000건 상한이라 idle에서 수렴하지 않음. 40초 관측에서 0건 감소 |
| 5 | **§7.5 협업방 배선** | 상위 인계서가 출시 차단 GAP으로 지정. `core-pipeline.ts`가 사용자 요청+Representative handoff 2건만 기록, `packages/runtime/src`에 `postMessage` 0건. **조사만 하고 착수 못 함** |
| 6 | `room.tsx` i18n 20건 | 별도 표면. 일부는 문장 조각 구조라 등록만으로 안 풀림 |
| 7 | 종료 25~30초 | `server.shutdown.failed`. 상위 인계서 §단계 8 항목 |

### 9.2 §7.5 착수 지점 (조사한 것까지)

```
ExecutionDelta       contracts.ts:62  — "휘발성 신호, 도메인 정본 아님, 저장소에 기록하지 않음"
ExecutionDeltaObserver contracts.ts:75 — "동기 fire-and-forget: 예외·배압을 실행 경로에 전파하지 않음"
ExecutionStreamRegistry execution-stream.ts:17 — 이미 observer를 구현
works.postMessage    core-pipeline.ts:341, 483 — commandId/workId/roomId/messageType/authorKind/authorId/content
```

**핵심 제약**: delta는 계약상 휘발성이고 observer는 fire-and-forget이라, **그 자리에서 저장하면 상위 인계서가 경고한 유실이 그대로 발생합니다.** 계층도 문제입니다 — runner(`packages/runtime`)는 works 도메인을 모르고, application이 observer를 통해 받아야 합니다.

상위 인계서 §7.5가 제시한 세 선택지 중 하나를 골라야 합니다: durable outbox / terminal 전 drain·ack / 명시적 degraded 상태.

### 9.3 상위 인계서의 남은 단계

§10 단계 5~13(실제 Work 완주, 동적 배치, 재시작 보존, 메모리 soak, 9개 surface 잔여 계약, negative matrix, 시각·접근성, 전체 build/security, 설치·서명 gate)은 **그대로 남아 있습니다.**

---

## 10. 다음 에이전트를 위한 시작 순서

1. 이 문서와 상위 인계서를 읽습니다.
2. Git clean·upstream 동일·tag 없음을 확인합니다.
3. **앱을 실행해 프로바이더 화면을 직접 봅니다.** 코드만 읽고 판단하지 마십시오 — 이 세션의 가장 큰 손실이 그것이었습니다.
4. §9.1의 1~2번(OpenRouter 등록 + fallback 실검증)으로 시작하는 것을 권합니다. §2.1·§2.2 수정이 실전에서 동작하는지가 아직 증명되지 않았고, 그게 이 세션의 원래 목적이었습니다.
5. 시각 변경을 했다면 **반드시 `tauri:build`의 exit code를 읽고**, 번들에 반영됐는지 `dist/assets/*.js`로 확인한 뒤 앱을 교체하십시오.
6. 새 UI 문구를 추가했다면 `styles.test.ts`의 세 가드가 잡습니다. 실패하면 회피하지 말고 문구를 등록하거나 `translate()`로 감싸십시오.

---

## 11. 커밋 원장 (22건, 시간순)

```
cf1edf8d1  docs(handoff): expand the complete AAA v1 history
e7bb4bd2d  fix(server): classify Codex transport failures for safe fallback
d424c202f  fix(runtime): settle structured output failures by observed side effects
980e1b0dc  fix(desktop): use the registered endpoint ID when adding a credential
2e6e91ad3  feat(router): remove a directly registered provider
73ee3e962  fix(application): report provider removal refusals to the user
7c535f944  fix(desktop): make provider removal deliberate and reversible-safe
da26f7204  fix(desktop): repair dead tokens and dead ends on the provider surface
9be0dbfb0  fix(desktop): make dialog overrides land and stop denying a saved key
f905ab9c5  fix(desktop): stop Korean leaking into the English locale and guard the class
5c6bfc0ce  fix(desktop): let dialog callers set their own width
b4ff3cacf  fix(desktop): render status messages through the translator
550da60c6  fix(desktop): translate the literals the surface renders directly
ff8de2e60  feat(desktop): offer a retry when the provider surface fails to load
3613f7d9b  style(desktop): finish the provider surface's visual leftovers
46e92b3d5  feat(desktop): let the user take a key or an account back out
7cd32e448  fix(router): let a retired provider be removed for good
bf7e855d8  fix(storage): retry a transaction the server has lost
9fb3f017b  fix(router): keep verification evidence when removing a provider
428eb0007  fix(desktop): read registered keys from the query that returns them
b13622de9  fix(desktop): model provider keys as the list they are
d5219bbe5  style(desktop): brace the void-returning key remove handler
```

재현:

```bash
git log --reverse --format='%h|%s' 92ed55d5d..d5219bbe5
```

---

## 12. 이 세션이 남기는 한 문장

**백엔드에 이미 있는 것을 화면이 버리고 있는 경우가 이 표면에서만 다섯 번 나왔습니다** — 지원 provider 15개 중 14개, endpoint ID, credential 목록, credential version, 그리고 제거·해제 command 둘. 새 기능을 만들기 전에 **서버가 이미 무엇을 주는지 먼저 확인하십시오.**
