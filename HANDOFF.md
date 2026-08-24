# 종합 핸드오프 — Massion Phase 30 후보·Phase 31 진행 상황 (2026-08-24)

이 문서는 지금까지의 전체 배경, 확정된 원칙, 완료된 작업, 시행착오, 현재 상태, 남은 작업을 정리해서 **다른 에이전트가 바로 이어서 작업할 수 있게** 하는 것이 목적입니다. 추측 없이 직접 확인된 사실과, 대화에서 사용자가 명시한 지시만 적었습니다.

## 0. 먼저 읽어야 할 절대 원칙 (사용자가 직접 정한 것)

이 규칙들은 이전 에이전트가 여러 번 위반해서 사용자가 명확히 다시 고정한 것입니다. 어떤 새로운 발견이 있어도 이 순서를 깨지 마세요.

1. **출시 게이트는 마지막에 한 번만.** 서명·공증·현재 SHA 전체 UAT 증거는 "원하는 제품 흐름이 실제로 동작한다"가 확인된 뒤, 배포해도 되는지 판단하는 마지막 단계입니다. 중간에 반복하지 않습니다.
2. **세로 흐름을 먼저 고정.** Provider 등록 → 공식 카탈로그 동기화 → 모델 On/Off → 실제 Work 실행 → Artifact → Assurance → 사용자 화면 반영. 이 흐름이 다 통과하고 범위를 동결한 뒤에만 게이트를 합니다.
3. **백엔드 먼저, 프런트 UAT는 그 다음.** FRONT와 BACK이 명확히 분리되어 있으므로 BACK이 완벽하게 돌아간 이후에 FRONT UAT를 합니다.
4. **중간에는 개발 검증만.** 타입 검사, 단위/통합 회귀, 보안 경계 검증. 출시 게이트(서명·공증·배포 산출물 검사)를 중간에 섞지 않습니다.
5. **범위 동결 준수.** 작업 인지 모델 배치(Phase 31), 계보·관찰 기능 같은 별도 마일스톤을 후보 작업에 끼워 넣지 않습니다. 새로 발견된 결함은 "현재 차단 / 다음 마일스톤 / 외부 게이트"로 분류만 하고, 현재 차단만 고칩니다.
6. **"계속"의 의미.** "계속"은 합의한 다음 한 단계 진행이지, "새로 발견되는 관련 문제까지 자율적으로 구현"이 아닙니다. 감사 결과(P0/P1 표기 등)는 분류 근거이지 구현 지시가 아닙니다.
7. **승인 요청으로 멈추지 않기.** 사용자가 명시적으로 중단하기 전까지 스스로 판단해 진행합니다. 단, 운영체제 권한 변경처럼 명시 승인이 필요한 것은 예외입니다.
8. **커밋하면서 진행.** 검증 가능한 단위가 끝나면 커밋으로 남깁니다.
9. **완료 표현은 근거에 맞게.** "출시 게이트만 남았다" 같은 과장 금지. 증거가 없는 것은 없다고 말합니다.

과거 위반 사례(재발 방지용): 범위 동결 위반(Phase 31 계보·관찰을 후보 작업에 섞음), 순서 위반(백엔드 완전 확인 전 Desktop UAT), 완료선 과장("외부 게이트만 남았다" 발언). 이 세 가지 패턴이 반복되지 않게 각 단계 전에 위 원칙 1~5를 자체 점검하세요.

## 1. 프로젝트 개요

- **제품**: Massion — Agent OS. 데스크톱 앱(Tauri, `Massion.app`), 서버(`apps/server`), CLI(`apps/cli`), 공유 패키지(`packages/*`)로 구성된 pnpm 모놀리포.
- **작업 디렉터리**: 외장 디스크의 Git worktree 두 개가 핵심 (아래 3절).
- **테스트/빌드**: `pnpm verify`(format→build→lint→typecheck→test→docs 검증). 서버 테스트는 워크스페이스 패키지의 **dist 산출물**을 참조하므로, 소스를 고치면 관련 패키지 빌드가 함께 갱신돼야 결과가 믿을 수 있습니다(6절 시행착오 4 참고).
- **런타임**: 후보 번들은 Node.js 24.18.0 실행 파일(`apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin`)과 SurrealDB 3.2.1 sidecar를 번들에 포함.

## 2. 진행 연표 (요약)

1. Phase 30 "표면 동등성 Agent UX" 후보(세로 흐름)를 고정하고 수차례 수정 — 전략 배정·Core Office 역량·OpenRouter 카탈로그·모델 On/Off 영속화·중복 실행 격리·renderer 캐시 분리 등.
2. 사용자가 출시 게이트 순서 원칙(0절)을 확정. 이후 후보 분기에서 백엔드 검증 완료 → Desktop 범위 UAT → 증거 문서 커밋까지 완료.
3. Phase 31 "작업 인지 모델 배치"를 별도 마일스톤으로 분리해 진행 중. Task 1·2·4 일부 완료, Task 3·5 착수 전.
4. 이번 세션: 외장 볼륨 접근 차단 해결 → 후보 UAT 증거 커밋 → Phase 31 서버 통합 회귀 3건의 근본 원인을 찾아 수습 → (이 문서 작성).

## 3. 현재 두 갈래 worktree/분기 상태

### 3.1 출시 후보 분기 — `codex/candidate-recovery-20260813`

경로: `.worktrees/candidate-backend-8092e340b` (세션 기준 worktree 아님, `git -C`로 접근)

최근 커밋(위가 최신):

| 커밋        | 내용                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| `bdb1167bf` | docs: 833fad7 후보 백엔드 완료 후 Desktop 범위 UAT 증거                                    |
| `833fad7b1` | fix(desktop): Node 24 Web Storage 충돌 회피 (Vitest 워커에 `--no-experimental-webstorage`) |
| `1bc1cf0eb` | docs(evidence): 동결 후보 UAT 재검증 기록                                                  |
| `2f529742d` | fix(application): 로컬 재시작 lease 복구를 한 번만 수행                                    |
| `e08734ce3` | fix(runtime): 시작 전 대기 실행을 안전하게 종료                                            |
| `8092e340b` | fix(strategy): 단순 대화 Work의 불필요한 Staffing 방지                                     |

**검증 상태(증거 문서에 상세 기록됨)**: `docs/evidence/phase-30/candidate-backend-8092e340b-scope-uat-2026-08-24.md`

- Node 24.18.0으로 `pnpm verify` 전체 통과(포맷·빌드·린트·타입검사·스크립트 117·Desktop 322·서버 371·CLI·bridge·문서).
- 같은 SHA에서 `tauri:build` 재실행으로 번들 생성. 앱 실행 파일 SHA-256: `9baa39e2f9dbd988557d09edfd8b0b74dfa8e18ebf265db724df388fae9cc8d8`.
- Desktop 범위 UAT 통과: Provider 새로고침·모델 Off/On 복원·실제 Work 실행(완료)·Artifact 2건·Assurance 2/2·Records·정상 종료 후 재시작 보존.
- **출시 게이트는 의도적으로 미실행.** 이 Mac에 유효 Developer ID 서명 ID가 0개(`security find-identity -v -p codesigning` 확인)라 서명·공증 불가. 번들은 ad-hoc 서명. 전체 23개 Tauri UAT·Gatekeeper·clean install 검증도 남아 있음. **이 분기는 현재 "공개 배포 가능"이 아닙니다.**

### 3.2 작업 분기 — `feat/phase-30-reconciled` (Phase 31 진행 중)

경로: `.worktrees/phase-30-reconciled` (세션 기준 worktree, 커밋 직접 가능). origin보다 39 커밋 앞서 있음(아직 push 안 함).

HEAD: `ba5b5c846` — "feat(placement): 작업 신호 기반 역할 baseline 계보를 보존한다"

- 자동 Strategy Task에 작업 축(taskAxis)·추론 난이도(reasoningDifficulty) 필수화(과거 plan_json 읽기 호환 유지).
- Work Task·Route Attempt에 선택 근거(placement receipt) 저장, 재시작 후 같은 baseline 복원.
- Work·Task·활성 batch·선호 모델 계보와 `model.route.selected` 사건 재생을 fail-closed로 검증.

**작업 트리에 미커밋 변경 29개 파일**(Phase 31 Task 1·2·4 진행분 + 이번 세션의 테스트 fixture 수정). 이번 세션 마지막에 체크포인트 커밋으로 남길 예정(아래 5절).

미추적 파일(커밋하지 않음, 판단 필요):

- `.omo/` — Orca/에이전트 런타임 세션 상태. 커밋 금지.
- `mise.toml` — `[tools] codex = "latest"` 한 줄. 로컬 도구 고정으로 보이므로 커밋하지 않았음. 팀 자산이라면 다음 에이전트가 판단.

## 4. Phase 31 체크리스트 현재 상태

계획 파일: `docs/phases/31-task-aware-model-placement/implementation-plan.md` (선행: Phase 30 디자인이 아직 in-progress로 표기됨)

- **Task 1 실행 계보 연결**: route_attempt↔execution↔model_profile 연결과 assurance 조회 계보는 완료. 남은 것: 성공·fallback·실패·재시작 경로가 올바른 route attempt를 가리키는 **회귀 검증 추가**(미완료).
- **Task 2 전략 신호와 baseline 회귀**: 스키마 필드·다섯 작업 축·신호 없을 때 역할 baseline 회귀·Governance 위험 분리 검증까지 완료 표시.
- **Task 3 벤치·receipt·관찰 정본**: 전체 미착수. T0 만료·T1 실행 전 고지(호출 수·최대 비용·Provider·데이터), T2 관찰의 shadow 동의·별도 예산, 동일 bundle·receipt 비교, capability hard gate와 `model-self` 보조 신호 분리, policy 레코드 없이도 표본·개선폭 gate·`expires_at` 집행, batch→Growth 제안 연결.
- **Task 4 실행 시점 배치와 사건**: 활성 batch→Router 후보 전달·baseline fallback 연결은 완료. 남은 것: `model.route.selected` 사건 발행·redacted lineage 보존(체크박스 미완료), 기준 모델 신고·배치 후보·선택 근거의 공통 Application surface 노출.
- **Task 5 비용 고지·표면·검증**: 전체 미착수. T1 실행 전 비용 고지 CLI·Desktop 표시, Phase 30 capability 계약 연결, route lineage·다섯 축·권한·회귀·사건 포함 문서·통합·실사용 검증 증거.

## 5. 이번 세션에서 실제로 한 일 (2026-08-24 밤)

1. **외장 볼륨 접근 차단 진단·해결.** 후보 worktree의 `ls`·`git`·`node`가 전부 `EPERM(Operation not permitted)`로 막히고 `apply_patch` 쓰기까지 실패. 디스크·POSIX 권한·TCC(Full Disk Access) 문제가 아니라는 것을 확인하고(Finder는 같은 디렉터리를 정상 표시, ZCode의 전체 디스크 접근 권한은 이미 켜짐) **운영체제 권한을 건드리지 않고 기다렸더니 수 분 내 자동 복구**됨. 복구 후 증거 문서 작성·커밋 정상 진행.
2. **후보 UAT 증거 커밋.** 실수로 세션 기준 worktree(phase-30-reconciled)에 생성된 증거 문서를 후보 worktree로 옮기고 `bdb1167bf`로 커밋(시행착오 2절 참고).
3. **Phase 31 서버 통합 회귀 3건 수습.** 서버 스위트에서 `product.test.ts` 3개 실패(OpenAI 호환 역량 공백 경로, MiniMax clean install, Z.AI clean install). 공통 증상: `model-unavailable []`로 Core 경로 차단.
   - 근본 원인: HEAD 커밋 `ba5b5c846`이 자동 전략 계획 스키마에 taskAxis·reasoningDifficulty를 **필수**로 추가했는데, 세 테스트의 계획 목업(fixture) plan 객체에는 이 필드가 없어 구조화 출력 검증이 실패 → 실행이 `model-unavailable`로 차단됨.
   - 수정: 세 fixture의 task에 `taskAxis: "code-generation"`, `reasoningDifficulty: "medium"` 추가(이미 수정돼 있던 다른 fixture와 동일 패턴).
   - 검증: `product.test.ts` 17/17 통과. 서버 전체 스위트 통과 확인(아래 7절).
4. 패키지별 회귀 확인(수정 전 기준): model-optimization 35, router 138, application 592, assurance 238, runtime 289, cli 156 — 모두 통과. 전체 `pnpm typecheck`도 통과.

## 6. 시행착오 기록 (같은 함정에 빠지지 않기 위함)

1. **macOS System Policy 일시 차단.** 외장 볼륨 worktree에서 셸·Git·Node만 `EPERM` 거부(Finder는 정상). 커널 로그에 `System Policy: deny(1) file-read-data`. 세션 분리된 자식 프로세스의 책임 귀속이 일시적으로 깨지는 알려진 패턴(openai/codex 이슈 #32853과 동일 징후). **교훈**: 권한 변경 전에 "다른 앱(Finder)으로 읽히는가", "ZCode/터미널의 FDA 상태는 어떤가"를 먼저 확인하고, 원인이 불명확하면 몇 분 기다린 뒤 재시도. 불필요한 시스템 설정 변경으로 상황을 복잡하게 만들지 않는다.
2. **패치가 엉뚱한 worktree에 생성됨.** 후보 worktree에 쓰려던 증거 문서가 세션 기준 worktree(phase-30-reconciled)에 생김. `apply_patch`는 상대 경로 기준으로 동작하므로, 다른 worktree에 넣을 때는 생성 후 `mv`하거나 커밋을 해당 worktree에서 수행할 것. 다행히 `git status`로 즉시 발겵해 이동 후 커밋.
3. **stash pop 충돌(.omo/).`git stash push -u` 후 `pop`할 때 미추적 런타임 파일(`.omo/run-continuation/*`)이 "already exists"로 충돌. 내용 비교 결과 타임스탬프 차이뿐이어서 현재 파일 유지·stash drop으로 해결. **교훈**: 런타임 상태 디렉터리가 있으면 `-u`(untracked 포함) 스태시는 피하고, 코드만 스태시할 것.
4. **빌드 산출물(dist) 오염으로 오판 직전.** "클린 HEAD에서도 실패한다"고 결론 내렸으나, 이는 이전 더티 빌드의 dist가 남아 있었기 때문. 서버 테스트는 워크스페이스 패키지 dist를 참조하므로, 판단 전에 반드시 의존성까지 재빌드(`pnpm build`)하고 테스트할 것. 재빌드 후에도 실패가 지속되어 비로소 HEAD 커밋 자체의 회귀로 올바르게 귀속됨.
5. **패키지 테스트만으로 안심함.** router·runtime 등 패키지 단위 테스트는 전부 통과했지만 서버 통합 테스트에서 스키마 하위호환 문제가 터짐. **교훈**: 스키마·계약을 건드리면 서버 `product.test.ts` 통합 스위트가 반드시 필요.
6. **(과거, 재발 방지) 감사 표기를 구현 지시로 오인.** P0/P1 표기는 분류 근거일 뿐. "현재 차단 / 다음 마일스톤 / 외부 게이트"로 분류하고 현재 차단만 고친다.

## 7. 이 문서 작성 시점의 검증 상태와 커밋 계획

- `product.test.ts` 17/17 통과 확인(빌드 후).
- 서버 전체 스위트(`vitest run src`, 44개 파일) 통과 확인: 42개 파일 통과·2개 스킵(44개), 366 테스트 통과·2개 스킵(368).
- **커밋 계획**: (a) Phase 31 진행분 29개 파일 + fixture 수정을 체크포인트 커밋, (b) 이 핸드오프 문서 커밋. `.omo/`·`mise.toml`은 미추적 유지.
- **이 분기에서 아직 안 한 검증**: 전체 `pnpm verify`(수정 후 기준). 다음 에이전트가 Phase 31을 이어 완료한 뒤 0절 원칙대로 실행할 것.

## 8. 다음 에이전트가 이어할 작업 (권장 순서)

1. **서버 전체 스위트 결과 확인**부터. 통과면 체크포인트 커밋 완료 여부 확인(`git log`·`git status`) 후 시작.
2. **Phase 31 Task 1 잔여**: 성공·fallback·실패·재시작 경로의 route attempt 계보 회귀 검증 추가(계획 파일 Task 1 세 번째 항목).
3. **Task 4 잔여**: `model.route.selected` 사건 발행·redacted lineage 보존(Work·execution·route attempt·model profile), 기준 모델 신고·배치 후보·선택 근거 surface 노출. 요청별 모델 선택 UI는 추가하지 않음(계획에 명시됨).
4. **Task 3 → Task 5** 순서로 착수(0절 원칙 안에서, 각 Task의 검증 항목을 실패 테스트로 먼저 만들고 최소 구현).
5. Phase 31 완료 후: 전체 `pnpm verify` → 새 후보 SHA에서 번들 재생성 → 백엔드 검증 완료 후 Desktop 범위 UAT → 증거 문서 커밋.
6. **그다음 단 한 번의 출시 게이트**: 전체 23개 Tauri UAT(동일 SHA), Developer ID 서명·hardened runtime·공증·staple, clean install·Gatekeeper·업데이트·접근성 검증. 단, **이 Mac에 유효 서명 ID가 없으므로(0개) 인증서 확보가 선행 조건**. 인증서 없으면 게이트를 시도하지 말고 상태만 보고할 것.
7. 사용자 응답은 한국어·근거 우선. 내부 식별자보다 의미를 먼저 쓰고 식별자는 괄호로(AGENTS.md 규칙).

## 9. 자주 쓰는 명령 치트시트

```bash
# 세션 기준 worktree (phase-30-reconciled)
pnpm typecheck
pnpm --filter @massion/server test          # build + vitest run src (통합 포함, 약 2~3분)
pnpm --filter @massion/router test
pnpm --filter @massion/application test

# 후보 worktree (별도 경로)
git -C '../candidate-backend-8092e340b' status --short

# 후보 검증용 Node 24.18.0 직접 실행 (검증 문서의 원본 명령)
apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin \
  /Users/code/.local/share/mise/installs/node/24.8.0/lib/node_modules/corepack/dist/pnpm.js verify

# 번들 빌드 (후보 worktree)
pnpm --filter @massion/desktop tauri:build

# 서명 ID 확인 (현재 0개 — 출시 게이트의 선행 조건)
security find-identity -v -p codesigning
```

## 10. 참조 문서

- 후보 UAT 증거(후보 분기): `docs/evidence/phase-30/candidate-backend-8092e340b-scope-uat-2026-08-24.md`
- 이전 전체 검증 기록: `docs/evidence/phase-30/uat-full-verification-2026-07-25.md`, `desktop-live-tauri-uat-2026-07-26-e3b5fe883.md` 등 동일 디렉터리
- Phase 31 계획: `docs/phases/31-task-aware-model-placement/implementation-plan.md` 및 `design.md`
- 철회된 릴리스 기록: `docs/evidence/phase-30/withdrawn-v1.0.0-release-2026-07-24.md`
