# Massion AgentOS AAA v1 Master Handoff

> 기준 시각: 2026-08-10 (Asia/Seoul)  
> 저장소: `/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled`  
> 브랜치: `feat/phase-30-reconciled` (origin보다 앞서 있음 — push 미실행)  
> 현재 HEAD: `c6197be19` (2026-08-05 기준선 `92ed55d5d`에서 커밋 31건)
> 제품 상태: **완료 아님 — 아래 임계 경로부터 재개 필요**
>
> 이 문서가 유일한 정본 인계서입니다. 2026-08-05 master 인계서에 2026-08-09 세션(§10 단계 1~2 실행,
> Provider 표면 전반, SurrealDB 트랜잭션 유실)과 2026-08-09~10 세션(§21 — 표면 계약 개방,
> 화면 문구 정리, 아홉 표면 UAT)을 병합했습니다. 별도 세션 문서는 두지 않습니다.
>
> **최근 세션부터 읽으려면 §21로 가십시오.** §19.4는 §21에서 해소됐습니다.

이 문서는 다음 구현 에이전트가 이전 채팅 전체를 읽지 않고도 프로젝트의 배경·의도·의사결정·구현 과정·실패·검증·현재 상태를 복원하고 작업을 안전하게 이어가기 위한 master handoff입니다. 오래된 계획 문서나 fixture와 충돌할 때는 현재 소스 코드, Git 상태, 실제 데이터베이스와 런타임 증거를 우선합니다.

## 0. 문서의 역할과 근거 우선순위

### 0.1 이 문서가 답해야 하는 질문

다음 에이전트는 이 문서만으로 다음을 설명하고 실행할 수 있어야 합니다.

1. Massion이 무엇이며 왜 단순한 multi-agent chat이 아닌가?
2. 어떤 시스템 경계와 도메인이 이미 만들어졌는가?
3. 왜 완성된 것처럼 보이는 fixture와 실제 Work가 다르게 동작하는가?
4. 어떤 사용자 피드백이 범위와 운영 방식을 바꿨는가?
5. 무엇을 구현·검증·커밋했고 무엇은 아직 증거가 없는가?
6. 어떤 접근이 실패했으며 왜 반복하면 안 되는가?
7. 현재 Git·DB·프로세스·Work·Provider 상태는 무엇인가?
8. 다음 한 묶음을 어디서 시작하고 어떤 증거로 닫아야 하는가?
9. 첫 실제 Work 이정표와 전체 AAA v1 완료는 어떻게 다른가?

### 0.2 정본과 증거의 우선순위

제품 요구와 현재 구현 사실은 서로 다른 우선순위를 사용합니다.

제품 요구·출시 계약:

1. 현재 사용자의 명시적 결정
2. `PRODUCT.md`
3. `docs/product/constitution.md`와 승인된 ADR
4. 현재 architecture·phase delivery 문서

현재 구현 사실과 검증 상태:

1. 현재 실행 결과와 저장된 DB 상태
2. 현재 source code와 executable test
3. 현재 Git commit과 diff
4. `docs/evidence/phase-30/`의 동일 SHA 실제 증거
5. 현재 architecture·phase delivery의 구현 진단
6. 개별 handoff·design·plan 문서
7. fixture와 mock data

fixture는 제품 기대 상태와 visual contract를 고정하는 자료입니다. 실제 Runtime·DB·UI가 그 상태를 만들었다는 증거는 아닙니다. 오래된 evidence도 당시 SHA의 사실일 뿐 현재 HEAD의 출시 증거로 자동 승격되지 않습니다.

### 0.3 독자와 사용 방법

주 독자는 현재 저장소를 처음 넘겨받은 senior implementation agent와 독립 verifier입니다.

- 배경과 결정 이유가 필요하면 0.A–0.F를 읽습니다.
- 현재 제품 상태는 1–9를 읽습니다.
- 바로 실행하려면 10의 순서를 따릅니다.
- 완료 선언 전에는 11의 Definition of Done을 전부 확인합니다.
- 전체 active development commit은 16의 ledger와 Git 명령으로 재현합니다.

## 0.A 제품의 출발점과 최종 의도

### 0.A.1 출발점

저장소의 최초 commit은 `e9504a0f7 build(massion): establish the phase 1 monorepo quality foundation`입니다. 이어서 SurrealDB 단일 정본, tenant 격리, Core Office 조직 그래프, Work·협업·Records, 모델 Router, Runtime, Governance, Context Strategy, Evidence, Software Engineering delivery, Assurance, Growth, Extension, Application API가 순서대로 구축됐습니다.

초기 구현은 domain/package별 계약이 매우 넓었습니다. 이 때문에 package test는 통과하지만 실제 개인용 데스크톱 Work가 끝까지 연결되지 않는 문제가 뒤늦게 드러났습니다. Phase 30의 핵심은 새 도메인을 더 만드는 것이 아니라 이미 있는 계약과 실제 Tauri 사용자 경로를 연결하고, fixture가 약속한 풍부함을 제품 데이터로 증명하는 것입니다.

### 0.A.2 제품이 만들려는 것

Massion은 사용자가 하나의 Mission을 맡기면 영속 Work를 만들고, 조직이 맥락을 읽어 Task와 책임을 나누고, Provider·모델을 동적으로 선택하며, 사람이 선택한 권한 경계 안에서 실제 산출물을 만들고 독립 Assurance와 Records까지 완료하는 개인용 macOS AgentOS입니다.

핵심 차별점은 다음과 같습니다.

- 모델 transcript가 아니라 Work와 불변 event가 정본입니다.
- 모델이 “완료”라고 말해도 독립 Assurance가 통과하지 않으면 완료가 아닙니다.
- Provider가 없어도 조회·승인·취소·진단은 제한 모드로 동작합니다.
- 동적 Agent와 모델 할당은 사용자가 매번 지정하지 않고 OS가 업무·capability·policy·budget을 보고 결정합니다.
- 자가개선은 모델의 즉시 자기수정이 아니라 Reflection → evidence → evaluation → review/auto adoption → measured effect → revert의 보수적 경로입니다.
- 로컬 workspace, SurrealDB, daemon과 macOS desktop이 개인용 v1의 정본 실행 환경입니다.

### 0.A.3 현재 목표가 AAA v1로 확장된 이유

초기에는 package 구현과 fixture 화면이 빠르게 넓어졌지만 실제 사용자 경로에서 다음 문제가 나타났습니다.

- 실제 협업방은 사용자 질문과 Representative handoff만 기록했습니다.
- fixture는 Work activity 전체를 방 대화처럼 보여 실제 연결보다 풍부했습니다.
- 동적 Agent proposal·승인·조직 변경이 화면에는 있으나 실제 Work 경로와 부분적으로만 연결됐습니다.
- 예산·Growth·Provider·Knowledge의 화면과 도메인 사이에 command/query wiring GAP이 남았습니다.
- 실제 run은 모델 실패, startup recovery, transaction teardown, projection backlog에서 멈췄습니다.
- UI에는 UUID, raw timestamp, 내부 activity 이름, 과도한 divider, 스크롤·Markdown 문제와 잘못된 Provider 오류 문구가 나타났습니다.
- 40.99GB 메모리 사용이 실제 Activity Monitor에서 제보됐습니다.

따라서 성공 기준은 “화면이 존재한다”에서 “실제 데이터·실제 Provider·실제 파일을 사용하는 다양한 Work가 데이터 손실 없이 완료되고 재시작 뒤 보존된다”로 강화됐습니다.

## 0.B 시스템 구조와 실행 경계

### 0.B.1 런타임 구성

```text
React/Vite renderer
  → Tauri host
    → Node desktop bridge sidecar
      → Massion server/Application API
        → domain packages
          → SurrealDB 3.2.1 single source of truth
        → model router/runtime
          → Codex app-server / Z.AI / configured providers
```

- renderer는 daemon URL·access token·범용 filesystem/shell capability를 소유하지 않습니다.
- Tauri가 native picker와 Codex login wrapper를 소유합니다.
- bridge가 renderer와 authenticated daemon 사이 capability boundary입니다.
- Application은 typed command/query/event stream을 제공합니다.
- domain commit과 outbox projection은 분리됐으며 command 응답은 historical projection backlog를 기다리지 않아야 합니다.
- SurrealDB는 모든 영속 상태의 정본입니다. 장수 daemon 재사용이 구현돼 있으므로 PPID 1만으로 shutdown bug라고 단정하지 않습니다.

### 0.B.2 Work의 의도된 세로 흐름

```text
사용자 자연어 요청
  → Intake / workspace trust / knowledge materialization
  → Representative 분석과 실제 협업방 handoff
  → Context & Strategy 계획
  → capability gap 판단
  → 필요 시 dynamic staffing proposal·approval·organization version
  → Task / Assignment / RuntimeExecution
  → Provider·model route attempt와 safe fallback
  → Delivery / 실제 workspace side effect
  → ArtifactVersion
  → 독립 Assurance
  → Records / final response
  → Reflection / Growth suggestion / adoption / effect / revert
```

각 화살표는 같은 Work·organization·correlation·causation lineage를 보존해야 합니다. UI에서 보이는 단계만 존재하고 실제 command나 stored event가 없으면 미구현입니다.

### 0.B.3 주요 저장소 영역

| 영역 | 책임 |
|---|---|
| `apps/desktop` | 실제 React UI와 Tauri macOS 앱 |
| `apps/desktop-bridge` | renderer와 daemon 사이 local bridge |
| `apps/server` | production composition, Provider adapter, startup/recovery |
| `packages/application` | public product command/query/event, Work orchestration |
| `packages/work` | Work·Task·room·message·Artifact lineage |
| `packages/runtime` | execution·lease·model attempt·VoltAgent topology |
| `packages/router` | capability·policy·budget·credential-aware model routing |
| `packages/organization` | versioned organization과 dynamic staffing |
| `packages/evidence` | workspace index·search·graph·EvidenceBrief |
| `packages/assurance` | 독립 verification과 verdict |
| `packages/records` | 완료 기록과 문서 ledger |
| `packages/growth` | memory·prompt·policy·organization 개선 loop |
| `packages/governance` | policy·approval·permit·fail-closed boundary |
| `packages/local-control` | daemon·Surreal runtime·access token lifecycle |

`apps/web`과 `apps/tui`는 `7a68eef6e`에서 제거됐습니다. `apps/studio`는 Nimbalyst 기반의 독립 npm workspace가 디렉터리로 남아 있지만 `pnpm-workspace.yaml`에서 명시적으로 제외돼 있으며 Massion v1 제품 표면이 아닙니다. 현재 임계 경로에서 실행·빌드·수정하지 마세요. 이를 저장소에서 완전히 제거할지는 별도 정책 결정이며, 실제 Tauri Work 완주를 방해하지 않는 한 지금 범위를 열지 않습니다.

## 0.C 전체 작업 연혁

### 0.C.1 2026-07-10~07-12 — AgentOS 도메인 기반 구축

- SurrealDB 단일 정본과 tenant 격리를 세웠습니다.
- Core Office 조직 그래프, Work·Delivery·협업 lineage·Records를 만들었습니다.
- credential-aware Router, quota·health, RuntimeExecution·memory·topology·fallback 기반을 만들었습니다.
- Cedar Governance, 승인 inbox, single-use permit, policy versioning을 연결했습니다.
- Context Strategy, Evidence index/search/brief, Software Engineering TDD delivery를 만들었습니다.
- 독립 Assurance와 Records completion, Growth, Extension SDK/host, Application API를 연결했습니다.
- TUI·Web·self-hosting·registry·subscription·optimization까지 넓은 제품 축을 만들었습니다.

이 단계의 성과는 domain depth입니다. 한계는 package별 GREEN이 실제 desktop vertical completion을 보장하지 않았다는 점입니다.

### 0.C.2 2026-07-13~07-15 — 공개 이력 정리와 잘못된 v1 출시 시도

- clean repository·CI·subscription connector·model optimization·release pipeline을 정리했습니다.
- 2026-07-15 `v1.0.0` release가 게시됐지만 개인용 desktop 완료·실제 UAT·설치 게이트를 충족하지 못했습니다.
- 이후 release와 원격 tag를 삭제했습니다. 현재 tag는 없어야 합니다.
- 이 사건 이후 “빌드 가능”과 “출시 가능”을 분리하고 실제 evidence 없는 완료 주장을 금지했습니다.

### 0.C.3 2026-07-16~07-19 — Phase 30 기준선과 로컬 SurrealDB

- baseline/query session safety와 clean-base full verification을 기록했습니다.
- remote SurrealDB와 local SurrealDB 3.2.1 runtime boundary를 조사·구현했습니다.
- 로컬 daemon·database·access capability 기반을 만들었습니다.
- 이 시점에는 Tauri 개인용 v1 주 표면이 아직 확정되지 않았습니다.

### 0.C.4 2026-07-20~07-24 — 실제 Provider dogfooding과 UI 완성본 기준

- 개인 소유 Z.AI GLM Coding Plan으로 실제 Work·Core Office·Assurance를 검증했습니다.
- local access refresh, 협업방 9명 참가, Representative handoff의 실제 증거를 남겼습니다.
- 2026-07-21 `9740b16a3`에서 Tauri shell이 처음 추가됐고, 2026-07-24 `1932fb700`에서 개인용 macOS Desktop을 1.0 목표로 명시했습니다.
- 프론트엔드는 현재 Runtime 데이터에 맞춰 축소하지 않고 완성본 fixture를 먼저 만들기로 결정했습니다.
- 홈·업무·지식·조직·개선·확장·설정과 수신함의 역할을 재정리했습니다.
- fixture가 Runtime보다 앞선 곳은 handoff로 명시하고, fixture를 실제 제품 증거로 사용하지 않기로 했습니다.
- 잘못된 `v1.0.0` release와 tag 제거를 문서화했습니다.

### 0.C.5 2026-07-25~07-27 — Tauri 증분 UAT와 지식·Growth·릴리스 증거

- Playwright UI, Tauri release build, native folder/file picker, workspace trust를 검증했습니다.
- 실제 Provider Work에서 workspace file knowledge와 Evidence reference, restart persistence를 증분 확인했습니다.
- Growth approve/effect loop를 증분 검증했습니다.
- artifact signing probe도 존재하지만 개인용 v1 임계 경로보다 앞세우지 않기로 했습니다.
- 전체 K01–K04, VoiceOver, clean Mac install/update/remove, 모든 surface의 실제 product UAT는 여전히 남았습니다.

### 0.C.6 2026-07-28~07-29 — 설계·fixture·정본 reconciliation

- 완성본 desktop fixture와 실제 계약 사이 GAP을 문서로 분리했습니다.
- knowledge surface/graph, agent collaboration runtime, Growth adoption, Extension capability, settings/provider/budget handoff가 작성됐습니다.
- 디자인은 무채색 기반, Agent별 identity color, 노랑은 사람의 결정, 점선은 work-scoped/미승인으로 고정했습니다.
- 이 시기의 중요한 결과는 화면 추가가 아니라 “도메인은 있으나 제품 경로가 버리는 것”을 명시적으로 드러낸 것입니다.

### 0.C.7 2026-07-30 — AAA 기반 결함과 공식 Codex 연결

- strict type/lint와 bootstrap 경계를 복구했습니다.
- delivery lease ownership, local Surreal runtime 교체, Codex schema turn stall과 retry/recovery를 수정했습니다.
- Work detail·Records·증거 표기를 사람이 읽을 수 있게 바꿨습니다.
- self-improvement setting persistence와 공식 Codex account login을 연결했습니다.
- 이 날부터 검증된 원자 변경마다 즉시 commit·push하고 영어 Conventional Commit을 공개 이력 규칙으로 고정했습니다.

### 0.C.8 2026-07-31 — dynamic staffing과 fixture 수준 Work UX 연결

- Work-scoped Agent 격리·승격, dynamic task assignment, atomic staffing, governed organization continuation을 연결했습니다.
- live Work conversation과 participant identity, Work lineage를 복구했습니다.
- 실제 화면을 fixture 수준에 가깝게 만들기 위해 이름·handoff·Markdown·Records·activity projection을 수정했습니다.
- 과도한 divider, Provider 내부 용어, Markdown emphasis/table/math 등 대화 가독성 결함을 줄였습니다.
- 그러나 Runtime Agent의 실제 delegate/answer를 collaboration room에 저장하는 생산 경로는 여전히 없습니다.

### 0.C.9 2026-08-01 — 완료 주장·retry·Assurance 정합성

- timeout lineage, blocked retry, approval continuation을 복구했습니다.
- 검증 불가능한 Task completion claim을 막고 Assurance rejection detail을 제한적으로 노출했습니다.
- live Work projection과 terminal work-scoped Agent retirement를 맞췄습니다.
- 이 과정에서 “검증에서 보완 필요”가 정상적인 change request인지, 근거 없이 무한 반복되는 verifier 결함인지 분리해야 한다는 요구가 생겼습니다.

### 0.C.10 2026-08-02 — 제품 범위 정리와 실제 workspace delivery

- `apps/web`과 `apps/tui`를 제거하고 Tauri를 개인용 v1 표면으로 고정했습니다.
- Work controls, queued directives, durable event lineage를 연결했습니다.
- trusted workspace를 Runtime task에 묶고 actual path resolution, external Codex workspace authorization, change evidence, Delivery crash recovery를 보강했습니다.
- 공식 Codex onboarding과 spawn failure containment을 추가했습니다.
- Assurance가 실제 code/file change evidence를 요구하도록 연결했습니다.
- Hugging Face DeepSeek community endpoint를 route에 추가했지만, 2026-08-05 현재 무료 endpoint는 폐기됐습니다.

### 0.C.11 2026-08-03 — Assurance·Provider·i18n 기반

- community model cold start, optimization approval, managed default policy를 보강했습니다.
- workspace knowledge execution과 Assurance evidence chronology·persisted stream·recovery snapshot을 수정했습니다.
- failed transaction rollback을 bounded하게 만들었습니다.
- 영어(en)·한국어(ko) locale 기반을 추가했습니다.

### 0.C.12 2026-08-04 — 메모리·보안·startup·command 응답 임계 묶음

- dynamic desktop content i18n, local SurrealDB memory bound, lint, graph accessibility, vulnerable transitive dependency를 수정했습니다.
- quota polling과 Work recovery가 HTTP readiness를 막지 않게 분리했습니다.
- transaction session teardown stall과 synchronous historical projection backlog를 command 응답에서 제거했습니다.
- 최신 bundle artifact는 생성됐지만 shell exit code가 보존되지 않았고, 새 bundle의 실제 command HTTP/UI 재검증 전에 작업이 중단됐습니다.
- 40.99GB 제보는 fresh 15분에서 재현되지 않았지만 raw sample evidence와 장시간 soak가 없어 해결 완료가 아닙니다.

### 0.C.13 2026-08-05 — 목표 상태 복구와 인계

- 전체 목표가 완료되지 않았는데 완료 처리됐던 판단을 철회했습니다.
- root task의 goal objective는 다시 저장됐지만 현재 도구 상태는 `paused`입니다. goal은 task/thread별이므로 새 task에서는 `null`일 수 있습니다.
- 첫 인계서는 실행 runbook 중심으로 작성됐고, 전체 배경·결정·연혁이 부족하다는 사용자 지적을 받았습니다.
- 본 master handoff는 그 누락을 보완한 것입니다.

### 0.C.14 2026-08-09 — Codex fallback 실행, Provider 표면 재건, 트랜잭션 유실

사용자의 Codex 구독이 소진돼 모든 Work가 막힌 상태에서 재개했습니다. 요청은 "대체 Provider로 넘어가게 하라"였고, 조사가 fallback 배선 → Provider 표면 전반 → 트랜잭션 인프라로 번졌습니다.

- §7.4 truth table의 Codex 어댑터·runner 몫을 실제로 닫았습니다(0.C.14.1).
- Provider 표면에서 **백엔드에 이미 있는 것을 화면이 버리는** 결함을 다섯 건 찾아 연결했습니다(0.C.14.2).
- 아무 command나 무작위로 500을 내던 원인이 SurrealDB 트랜잭션 유실임을 로그로 규명했습니다(0.C.14.3).
- 사용자 요청으로 독립 시각 검수를 8라운드 돌려 BLOCK 18건을 전부 닫았습니다(0.C.14.4).
- 커밋 23건, 전부 push. 테스트는 desktop 278 · router 94 · application 554 · server 344 · storage 22 · runtime 257.

이 회차의 가장 큰 손실은 코드가 아니라 **검증 순서**였습니다. 8라운드 동안 코드만 고치고 번들을 다시 만들지 않아, 사용자는 그 전 번들을 계속 보며 이미 고친 것을 결함으로 지적했습니다. 검수 에이전트는 소스를 읽고, 구현자는 테스트를 돌리고, 사용자는 실행 화면을 봤습니다 — 셋이 서로 다른 것을 보고 있었습니다.

#### 0.C.14.1 fallback을 막던 두 겹

`apps/server/src/codex-app-server-agent.ts`가 turn 실패를 `sideEffectsStarted: safeAuthenticationFailure ? false : true`로 보고했습니다. 그 조건은 **401일 때만** 참이라, 401이 아닌 모든 실패 — 정확히 구독 소진(429) 포함 — 이 "이미 부작용이 시작됐다"로 보고돼 router gate가 fallback을 막았습니다. **router는 옳았고 어댑터가 사실을 왜곡**하고 있었습니다. 어댑터는 승인 요청·non-userMessage item·agent delta·output token·알 수 없는 notification 단계까지 부작용을 정교하게 추적하고 있었는데, 그 관측값이 resolve 지점에서 통째로 버려졌습니다.

`packages/runtime/src/voltagent-runner.ts`의 세 catch는 `sideEffectsStarted: lease.kind === "agent-runtime"`로 **lease 종류만 보고** 부작용을 단정했습니다. Codex가 정상 완료했는데 응답만 스키마에 안 맞는 경우도 fallback이 막혔고, schema validate 실패는 marker 없는 원문을 reject해 `failureSignal`이 `unknown`으로 분류하며 두 번째로 막았습니다.

#### 0.C.14.2 화면이 버리고 있던 것 다섯

| 무엇 | 증상 |
|---|---|
| 지원 provider manifest 15개 중 14개 | 투영이 `openai-codex` 하나만 골라내 나머지는 등록 전까지 보이지 않음 |
| `endpointId`(register 응답) | 서버가 base_url을 정규화해 저장하는데 UI가 입력 원문으로 되찾아 `addCredential`이 서버에 도달조차 못 함 |
| `router.credentials` 자체 | 투영이 `catalog.credentials`(존재하지 않는 필드)를 읽어 키가 항상 0건 |
| credential `version`/`secretVersion` | query 투영에서 빠져 있어 제거도 표시도 불가 |
| `credential.disable`·`account.disconnect` | command는 서버에 있는데 화면 경로가 없어 넣을 수는 있고 뺄 수는 없었음 |

여기에 키를 `find()`로 **단수 취급**한 결함이 겹쳤습니다. Z.AI는 실제로 키가 2개인데 화면은 1개만 알았고, 그래서 새 키를 넣으려는 사람에게 "키 교체"가 뜨고 계정은 목록·키는 단수라는 **한 화면 두 문법**이 생겼습니다.

#### 0.C.14.3 트랜잭션이 사라지는 문제

제거·등록 등 아무 command나 무작위로 500이 나고 화면에는 "요청을 처리하지 못했습니다"만 떴습니다. SurrealDB 로그가 원인을 그대로 말했습니다.

```
WARN Transaction 019fd3cd-… not found in WebSocket transactions map (have 0 transactions)
```

`bde95f8b1`이 `forkSession`을 제거한 뒤 모든 트랜잭션이 WebSocket 하나를 공유하므로, 서버 쪽 맵이 비면 진행 중이던 트랜잭션이 통째로 사라집니다. 그 시점에 커밋된 것은 없어 재시도가 안전한데 재시도 목록에 없었습니다. **왜 맵이 비는지는 미해결**이며, §0.I.1의 "transaction warning 누적 1,462"와 같은 뿌리로 추정합니다.

#### 0.C.14.4 시각 검수 8라운드

독립 에이전트("AAA 아니면 FAIL")로 BLOCK 8 → 3 → 3 → 1 → 1 → 1 → 1 → 0. 렌더 결함이 다수였습니다 — 존재하지 않는 `warning` 토큰을 참조해 경고 배너가 아예 안 그려짐, `--color-muted`가 `--color-fg-3`와 같은 값이라 활성/비활성 삼항이 no-op, 좌우 카운트가 다른 소스라 같은 화면이 `7/7`과 `6/7`을 동시 표시, `cn()`이 tailwind-merge가 아니라 모든 `className` override가 무효.

검수의 한계도 기록합니다. 8라운드 내내 **코드만 읽고 실행 화면을 보지 않았습니다.** 그래서 "키가 있을 때 지울 수 있는가"와 "키가 여럿일 때"를 놓쳤고, 사용자가 실제 앱에서 즉시 발견했습니다.

### 0.C.15 2026-08-09(2회차) — 릴리스 게이트 복구와 협업방 배선

전수 분석에서 출발해 **닫을 수 있는 결함을 전부 닫은** 회차입니다. 커밋 16건, 전부 push 전 상태.

**먼저 알아야 할 사실: `verify:security`가 이 회차 전부터 빨간 상태였습니다.** `runtime → @voltagent/core → gray-matter → js-yaml@3.15.0`의 high 등급 CVE(GHSA-5p4m-2wfm-xmqj)이고, 이 스크립트는 릴리스 조건이므로 저장소는 **어떤 경로로도 출시할 수 없었습니다.** `gray-matter>js-yaml` override가 `^3.14.1`에 고정돼 있었고 백포트가 3.15.1에 들어와 그 위였습니다. 하한을 올려 통과시켰고, `nanoid`(dev 전이)도 함께 정산했습니다.

#### 0.C.15.1 데이터 무결성·크래시 결함 셋

- **Work revision 불변량 파손.** `transitionTask`의 `ready→failed` 수렴이 WorkEvent를 2건 만들면서 `work.revision`은 1만 올렸습니다. `auditWork`가 `revision == events.length`를 강제하고 `recoverWork`가 그것을 fail-closed로 쓰므로, **이 전이를 지난 Work는 이후 Records·Assurance 단계가 통째로 실패**했습니다. 생산 경로(`CoreDeliveryStage.convergeFailure`)가 실재합니다. revision을 호출자 산술이 아니라 원장에서 파생하도록 고쳤습니다.
- **Provider 재제거가 라우터·예산 패널을 영구히 죽임.** `retired = hasAttempts && provider.enabled`가 「계보를 지켜야 하나」와 「첫 제거인가」를 한 변수로 묶어, 두 번째 제거 때 호출 기록이 있어도 `model_profile`을 지웠습니다. `listAttempts`가 고아 행에서 던져 목록 전체가 죽습니다. 쓰는 쪽(고아를 만들지 않음)과 읽는 쪽(이미 생긴 고아를 견디되 이름을 지어내지 않음) 둘 다 고쳤습니다.
- **optimization batch 승격 게이트 우회.** `if (policy)` 하나가 정책 부재 시 주 모델·완료·privacy receipt·최소 표본·개선 폭 검사를 전부 건너뛰고 `limited`·`active` batch를 만들었습니다. `recommend()`가 정책 미설정 시 실재하지 않는 `"implicit-default"`를 넣어 **정상 사용에서도 열려** 있었습니다. shadow는 이미 fail-closed였고 승격만 fail-open이었습니다.

#### 0.C.15.2 출시 차단 GAP 해소 — Runtime 협업방 배선

`REQ-AGENT-HARNESS-001`. `CollaborationRuntimeRecorder`가 `delegate_task` 델타를 관찰해 인계·답변을 협업방에 남기고 composition root가 주입합니다. 내구성 경계는 [ADR-004](../../architecture/ADR-004-runtime-collaboration-durability.md)가 소유합니다.

**이 작업에서 배운 것 둘.**

1. **스텁 테스트 7개가 통과한 뒤 실제 도메인 통합 테스트가 거부했습니다.** `recipient_agent_id`는 `handoff`에만 허용됩니다. 스텁만 봤으면 생산에서만 조용히 실패했을 겁니다. 이후 모든 기록기 테스트에 실제 `WorkService` 통합본을 붙였습니다.
2. **Codex 적대적 리뷰가 제가 틀린 것 셋을 잡았습니다.**
   - 직렬화 키를 `executionId`로 잡았는데 **실제 경합 자원은 방**입니다. 같은 Work 32개 동시 실행에서 27건이 write conflict로 사라지는 것을 리뷰가 재현했습니다. 조직 단위 큐로 바꾸고 그 재현을 테스트로 고정했습니다.
   - `drain()`을 만들어 놓고 **종료 경로에 조립하지 않았습니다.** 이 저장소의 지배적 결함(구현했지만 조립 안 함)을 제가 그대로 반복했습니다.
   - **ADR-004가 사실과 달랐습니다.** "crash 뒤 복구가 같은 실행을 다시 돌려 메시지가 재생성된다"고 썼는데 `RuntimeRecovery`는 재실행하지 않고 terminal로 전이시킵니다. ADR을 정정하고 「정상 종료는 닫고 비정상 종료는 알려진 상한」으로 다시 적었습니다.
   - 결과 배열이 대상보다 짧으면 `JSON.stringify(null)`이 걸려 문자열 `"null"`이 실제 답변처럼 기록됐습니다 — 같은 파일 주석이 금지한 그것입니다.

#### 0.C.15.3 계약 결손 셋

- **확장 Capability.** `ExtensionInstallationViewV1`이 다섯 필드뿐이라 헌법 6절의 「조직에 추가된 Capability를 먼저」가 설치된 확장에 대해 성립하지 않았습니다. 선언은 `extension_version.manifest_json`에 처음부터 있었고 설치 view만 안 읽었습니다. 같은 변경으로 도메인 view를 그대로 흘려 `organizationId`가 클라이언트로 새던 것도 막았습니다.
- **`growth.revert`.** 명령 레지스트리와 CLI에는 있는데 타입 계약과 데스크톱에 없어 **채택은 화면에서 하고 취소는 터미널에서 하는** 상태였습니다.
- **계약 드리프트 가드 신설.** 데스크톱이 계약 밖 무타입 경로로 던지는 26개 operation을 `apps/desktop/src/contract-boundary.test.ts`가 debt ledger로 고정합니다. 새로 생기면 실패하고, 계약으로 옮겨도 실패해서 줄어든 사실이 남습니다.

#### 0.C.15.4 그 밖

- Extension credential 스캔이 **1MiB 초과·NUL 포함 파일을 통째로 건너뛰던** 두 우회로를 닫았습니다. 보안 검사를 크기로 끄면 그 크기가 곧 우회 방법입니다.
- idle에서 outbox가 수렴하지 않던 것(§19.1, pending 27,032)을 고쳤습니다. 루프는 있었는데 상한까지 채워도 다시 무장하지 않았습니다.
- `/health/ready`를 즉시 단언하던 flaky 테스트를 고쳤습니다. **`pnpm verify` 안에 있어서 게이트 자체가 간헐적으로 거짓말을 했습니다.**
- 설정 표면이 렌더에 쓰지도 않는 조회 7개를 매번 발사하던 것을 제거했습니다.
- 문서 정정: README 테스트 개수 6개가 전부 과소(desktop 89→282 등), README·CHANGELOG의 표면 6개→9개, PRODUCT.md가 제거된 전역 긴급 정지를 약속, 헌법 §9.1·9.3·9.4·9.5·9.6의 낡은 진단, 아키텍처 문서가 ADR 3건을 참조하지 않던 것, `@massion/foundation`을 살아 있는 의존으로 그리던 것(import 0건).

#### 0.C.15.4a 표면 계약 셋 추가 — 조직·예산

- **조직 편성**(`organization.command`)을 타입 계약에 열었습니다. 레지스트리와 CLI에는 있었지만 타입 맵에 없어 데스크톱이 부를 수 없었고, 그것이 헌법 §9.1이 조직 화면을 「읽기 전용」이라 적은 이유였습니다. `expectedVersion`이 Organization Version 낙관적 잠금입니다. **남은 것은 화면의 편성 입력 UI**입니다.
- **예산 한도**를 실제로 걸 수 있게 했습니다. 여기서 한 번 멈춰 판단한 것이 있습니다 — 뻔한 배선은 CLI가 이미 노출한 `router.route.configure`였는데, **그 명령은 이름과 달리 새 route_id를 만들고 `spent_micros`를 0으로 리셋합니다.** 「한도 설정」 버튼에 연결하면 경로가 중복되고 누적 지출이 사라져 한도를 못 거는 것보다 나쁜 상태가 됩니다. 진짜 결손은 계약 노출이 아니라 **도메인에 update 명령이 없던 것**이었고, `ModelRouter.setRouteBudget`을 새로 만들어 지출·후보를 보존한 채 한도만 바꿉니다. 라우터가 예약 시점에 이미 차단하므로 이 숫자는 화면 상태가 아니라 실행 경계입니다.
  - **알림 임계값은 여전히 표면 로컬 상태**이고 저장소가 없습니다. 실제로 막는 한도와 한 목록에 섞지 않았습니다 — 어느 것이 실행을 멈추는지 알 수 없게 되기 때문입니다.
- **Tauri 번들을 다시 만들었습니다**(exit 0). `apps/desktop/dist/assets/*.js`에 이 회차의 문구(`등록 제거됨`, 예산 한도 안내)가 실제로 들어간 것을 확인했습니다. §0.E.9가 겪은 「고쳐 놓고 번들을 안 만든」 상태가 아닙니다.

#### 0.C.15.4b 이 회차가 스스로 밟은 함정

기록해 둡니다. 같은 실수가 반복되고 있습니다.

- **§0.E.4(동시 build)를 두 번 밟았습니다.** 게이트를 돌리면서 별도로 eslint를 돌려 「type cannot be resolved」 연쇄를 실제 결함으로 착각했고, Codex 리뷰와 게이트를 동시에 돌려 같은 일을 반복했습니다. 빌드·타입체크·린트는 **루트 단일 직렬 큐**에서만 돌려야 합니다.
- **개별 tsconfig로만 확인해 게이트를 깼습니다.** `tsc --noEmit -p tsconfig.app.json`은 통과하는데 `typecheck` 스크립트가 쓰는 `tsc -b`는 중복 객체 키를 거부합니다. **게이트가 실제로 쓰는 명령으로 확인해야 합니다.**

#### 0.C.15.5 남은 것 — 이 회차가 닫지 못한 것

| 항목 | 왜 |
|---|---|
| Apple Developer ID 서명·공증·Gatekeeper | 사용자의 인증서가 필요 |
| 실제 Tauri UAT(환불 Work 완주) | 사람이 앱을 켜고 자연어로 요청해야 함 |
| 장시간 메모리 soak(40GB 제보) | 몇 시간짜리 관측 |
| 시각 검수 | 번들은 만들었으나 브라우저 도구가 이 환경에서 열리지 않아 실행 화면을 보지 못함. §0.D 23이 요구하는 확인이 남음 |
| 예산 알림 임계값 | 새 저장소가 필요한 기능 작업. **경로 한도 자체는 2026-08-09에 닫혔습니다**(`router.route.budget.set`) |
| 조직 편성 **UI** | 계약과 서비스 메서드는 2026-08-09에 열렸고, 조직 화면이 아직 편성 입력을 그리지 않음 |
| ExtensionCapabilityBroker 조립 | worker→host capability 요청 채널이 프로토콜에 없음. 시그니처 불일치와 컴파일 타임 가드는 이번에 닫음 |
| 협업방 crash 손실 창 | ADR-004가 알려진 상한으로 기록. 정상 종료는 닫힘 |

**데스크톱 소스 변경은 `.app` 번들에 아직 없습니다.** `tauri:build`를 돌리고 exit code를 읽은 뒤 앱을 교체해야 화면에 반영됩니다(§0.E.9·§0.D 22).

## 0.D 사용자 결정 로그와 범위 변화

다음 결정은 채팅 과정에서 반복적으로 확정됐습니다. 다음 에이전트는 오래된 plan보다 이를 우선합니다.

| 순서 | 사용자 결정 | 실행 의미 |
|---:|---|---|
| 1 | `design.md`에 억눌리지 말고 필요하면 페이지·계약을 변경 | 기존 문서는 제약이 아니라 출발점; 실제 제품 판단과 일관성 우선 |
| 2 | 아름다움과 일관된 경험을 함께 요구 | visual polish만으로 완료 금지; 같은 정보·행동·언어가 모든 surface에서 일치해야 함 |
| 3 | 질문하지 말고 승인된 범위에서 진행 | 발견 가능한 사실을 사용자에게 되묻지 말고 source/runtime에서 확인 |
| 4 | 검증된 원자 변경마다 commit | 추적·복구 가능한 작은 commit과 즉시 push |
| 5 | 하위 에이전트 과잉 확장과 반복 대기를 중단 | 축당 구현자 1·검수자 1, 재귀 금지, 첫 검수에서 동일 계열 전체 조사 |
| 6 | build는 root 단일 직렬 큐 | 공유 `dist` 경쟁으로 생기는 거짓 실패 방지 |
| 7 | RED → 최소 구현 → 표적 테스트·포맷 → 통합 검수 → 일괄 수정 → 재검수 → commit | package 단위 조사보다 실제 product vertical 우선 |
| 8 | 첫 전체 검증과 실제 Codex Work 완주가 다음 이정표 | 내부 함수 수나 fixture 완성도를 진척으로 대체하지 않음 |
| 9 | TUI·레거시 Web을 v1 임계 경로에서 제외하고 결국 제거 | `apps/web`, `apps/tui` 삭제; Tauri 집중 |
| 10 | fixture의 풍부함을 범위에서 버리지 말 것 | fixture는 기대 기능 계약, 실제 증거는 별도 |
| 11 | 실제 협업방·handoff·graph·Task·dynamic Agent/model을 모두 검증 | 두 메시지짜리 room이나 단일 representative 응답으로 성공 금지 |
| 12 | 내부 UAT 절차를 시작 프롬프트에 직접 쓰지 말 것 | 자연어 업무만 주고 OS의 자율 계획·배치·검증을 관찰 |
| 13 | 근거 없는 가상 출시 판단·워크숍 문서 UAT 폐기 | 실제 파일이 있는 synthetic project 또는 새 실제 project 사용 |
| 14 | 공개 commit은 영어 Conventional Commits | 이전 혼합 언어 이력은 재작성됐고 이후 subject 규칙 유지 |
| 15 | 잘못된 `v1.0.0` tag는 존재하면 안 됨 | local/remote tag 0 확인; 새 tag는 전체 release gate 뒤에만 |
| 16 | UUID·raw timestamp·내부 activity·과도한 divider를 사용자 경험으로 인정하지 않음 | 사람 이름, locale time, model name, Markdown, scroll, 자연스러운 handoff 필요 |
| 17 | OpenCodex 등 fixture에 없는 Provider를 UI에 임의 노출하지 않음 | Provider는 실제 route/계보에서만 표시; Work prompt에 Provider를 지시하지 않음 |
| 18 | 시스템 기본 + 설정 가능한 en/ko를 v1 계약으로 복원 | static/dynamic copy, 날짜·숫자·검색·오류·Agent output language까지 적용 |
| 19 | 40.99GB 실행 중 메모리 문제를 실제 결함 후보로 취급 | 단기 sample로 완료 금지; 장시간 component별 evidence 필요 |
| 20 | 전체 목표가 완료되지 않았으므로 되살릴 것 | 두 Work 이정표 뒤 9개 surface·negative matrix·release gate까지 완료해야 함 |
| 21 | 오래된 `Massion.app`으로 현재 작업을 검증하지 말 것 | bundle에 source 수정이 포함됐는지 hash/content와 build exit를 확인하고 같은 candidate만 UAT |
| 22 | 화면을 고쳤으면 **번들을 다시 만들고 exit code를 읽은 뒤** 앱을 교체할 것 | 2026-08-09에 8라운드 수정이 미빌드 상태로 남아 사용자가 옛 화면을 보고 이미 고친 것을 결함으로 지적함. `BUILD_EXIT`를 캡처만 하고 읽지 않아 잘못된 앱을 두 번 전달 |
| 23 | 시각 판단은 **실행 화면**으로 할 것 | 코드 검수만으로는 "뭔가 있을 때 지울 수 있는가" 같은 질문이 나오지 않음. 8라운드 검수가 놓친 결함을 사용자가 앱에서 즉시 발견 |
| 24 | 무료 endpoint가 죽으면 **후보에서 정산**하고 대체를 찾을 것 | HF DeepSeek 무료 endpoint는 retired. GLM 우선, OpenRouter 무료 모델을 대체 후보로 |

### 0.D.1 현재 동결된 임계 순서

1. 새 bundle에서 command 응답 수정 검증
2. Codex failure classification·safe fallback·queued orphan·model lineage
3. Runtime Agent collaboration room durability wiring
4. 직렬 Tauri rebuild
5. 실제 환불 Work 완주
6. 별도 capability-gap Work에서 자연스러운 dynamic Agent 완주
7. restart·memory lifecycle
8. 이후에만 9개 surface 잔여 계약과 negative matrix

예산·Growth·Knowledge·추가 UI는 v1에서 제거된 것이 아닙니다. 첫 실제 Work 임계 이정표 전에는 새 축으로 열지 말라는 순서 제약입니다.

## 0.E 실패했던 접근과 반복 금지 이유

### 0.E.1 package GREEN을 제품 완료로 간주

동적 배치 package test 38개가 통과한 뒤 실제 product wiring과 6개 경계 결함이 발견됐습니다. package 단위 GREEN은 필요하지만 Application·Work·Organization·Server·Desktop이 연결됐다는 증거가 아닙니다.

### 0.E.2 fixture activity를 실제 협업처럼 투영

fixture는 풍부한 Work activity를 room timeline에 넣어 완성된 협업처럼 보였습니다. 실제 pipeline은 사용자 질문과 Representative handoff만 저장합니다. fixture를 줄이는 것이 아니라 Runtime이 실제 메시지를 만들도록 연결해야 합니다.

### 0.E.3 한두 문제씩 순차 검수

ownership, ownerless lease, TOCTOU가 여러 차례 순차 발견돼 같은 bundle이 반복됐습니다. 첫 RED/review에서 같은 실패 family의 truth table을 전부 조사해야 합니다.

### 0.E.4 여러 agent의 동시 build/typecheck

공유 `dist`가 삭제·재생성돼 실제 source와 무관한 거짓 실패가 발생했습니다. source 수정과 target test만 병렬화하고 build는 root 직렬 큐에서만 수행합니다.

### 0.E.5 가짜 UAT 프롬프트

실제 데이터가 없는 beta 출시 판단·워크숍 운영안은 모델이 문장을 잘 만드는지만 측정했습니다. `CODEX WORK UAT PASS`, “단계를 완료하세요”, “사실을 만들지 마세요”도 내부 동작을 직접 지시하므로 AgentOS 자율성을 증명하지 못합니다.

### 0.E.6 첫 실제 Work 전에 범위를 다시 넓힘

TUI·Web·광범위 미관·서명·모든 UAT를 동시에 열면 사용자에게 완주가 보이지 않았습니다. 현재는 command/fallback/collaboration/첫 Work vertical을 먼저 닫고 그 뒤 전체 surface를 순차 폐쇄합니다.

### 0.E.7 검증 실패를 모두 “구조화 응답 실패”로 표시

실제 Codex transport·quota·schema·side-effect 실패를 하나의 UI 문구로 뭉개 모델 lineage와 해결 조건이 사라졌습니다. 내부 secret은 숨기되 failure category와 retry/fallback 가능성은 사실대로 보여야 합니다.

### 0.E.8 단기 메모리 sample로 40GB 문제 완료 선언

15분 fresh run에서 재현하지 못한 것은 좋은 표적 신호일 뿐 장시간 누수 부재의 증거가 아닙니다. raw sample, slope, peak, 반복 Work와 component별 RSS가 필요합니다.

### 0.E.9 코드를 고치고 번들을 다시 만들지 않음

2026-08-09에 8라운드에 걸쳐 표면을 고쳤으나 `tauri:build`를 돌리지 않아, 사용자는 그 전 번들을 계속 봤습니다. "제거 확인이 다이얼로그로 안 뜬다", "키 추가가 없다"는 지적은 **이미 고쳤지만 화면에 없던 것**들이었습니다. 검수는 소스를, 구현자는 테스트를, 사용자는 실행 화면을 봤습니다.

### 0.E.10 build exit code를 캡처하고 읽지 않음

`BUILD_EXIT=1`이 출력에 그대로 있었는데 다음 단계로 넘어가 잘못된 앱을 두 번 전달했습니다. §5.1이 같은 함정을 이미 경고하고 있었습니다.

### 0.E.11 «고쳤다»는 보고가 코드와 다름

시각 전용 변경은 타입도 lint도 문자열을 보지 않습니다. 2026-08-09에 세 번 어긋났습니다 — `bg-muted` 미반영, `dialog.tsx` 미반영, `ProviderField` 대신 `GrowthField` 수정. **`git diff --stat`으로 의도한 파일이 목록에 있는지** 확인하는 절차를 중간에 도입해 prettier 재포맷으로 깨진 치환을 즉시 잡았습니다.

### 0.E.12 재시도 판정을 넓게 잡음

`Transaction not found`를 재시도 대상에 넣을 때 `/\btransaction\b[^]*\bnot found\b/`로 넓게 매칭했더니 한 번만 실패해야 할 것들까지 4번씩 재시도해 application 테스트 3건이 깨졌습니다. **재시도 판정을 넓히는 것은 조용히 의미를 바꾸는 변경**입니다. 문장 시작에 고정해 서버 고유 표현만 매칭하도록 좁혔습니다.

### 0.E.13 파일을 잘라먹음

`open(p,'w')` 후 write에서 예외가 나 `desktop-service.ts`(242KB)가 0바이트가 됐습니다. `git checkout`으로 복구했습니다. 스크립트로 파일을 다시 쓸 때는 **읽기·변환·검증을 모두 마친 뒤에만** 열어야 합니다.

### 0.E.14 눈에 먼저 띈 경고를 원인으로 지목

빌드 실패 때 `Tarball download 15 KiB/s` 경고를 원인으로 결론지었으나, 진짜 오류는 스택 위쪽의 `ENOTDIR`이었습니다(§18.1).

### 0.E.15 소스를 읽어 화면을 안다고 가정

2026-08-09~10 세션이 찾은 화면 결함의 절반 이상이 소스 grep으로 안 나왔습니다. 라벨을 데이터 배열에 담아 그리는 `translate()` 누락, 클래스가 조용히 버려져 보이지 않는 입력칸, hover와 선택이 같은 색인 레일 — 전부 앱을 띄우고 눈으로 봐야 나왔습니다. **화면을 바꿨으면 프로덕션 빌드로 띄워 보십시오**(§18.2). §21.2·§21.3.

### 0.E.16 `className`으로 컴포넌트 base를 덮으려 함

`cn`은 tailwind-merge가 아닙니다(§21.5). 덮으려 한 클래스는 오류 없이 사라지고, 그래서 두 번이나 입력칸이 화면에서 보이지 않았습니다. 상자가 필요하면 감싸십시오. `class-override.test.ts`가 이제 막습니다.

### 0.E.17 재현 안 되는 게이트 실패를 flaky로 처리

두 번 그렇게 판단할 뻔했고 두 번 다 진짜 원인이 있었습니다 — fixture에 넣은 `run: running`이 배경 조정 폴러를 무장시켜 부하에서만 드러났습니다(§21.6). **부하를 걸어 재현을 시도한 뒤에 판단하십시오.** 부정 단언(`not.toHaveBeenCalled`)은 시점이 정의돼야 뜻이 있습니다.

## 0.F Git 이력·rebase·브랜치·tag 사실

### 0.F.1 현재 관계

2026-08-05 기준:

```text
source baseline HEAD: 92ed55d5d06145947b1598c4f7a112311692b7bc
source baseline origin feat: same
main HEAD:   cb909f3431e5adfacbd68c8c76dfc05ff6a5313d
merge-base:  4ae8650deec7f1668b09997d257b6f6f26ec7f79
main-only:   3 commits
feature-only before this master update: 147 commits
tags:        none
```

즉 현재 feature branch는 원격과 일치하지만 `main`에 병합된 상태가 아닙니다. 사용자가 전체 이력의 영어 Conventional Commit 통일을 요청한 뒤 2026-08-02 rebase와 force update가 있었고, 한글 subject였던 commit도 영어로 amend/rebase됐습니다. 그러나 현재 `main`은 feature의 147개 commit을 포함하지 않습니다. 다음 에이전트는 이 차이를 숨기거나 main 통합이 끝났다고 주장하면 안 됩니다.

### 0.F.2 commit 규칙

- subject: English Conventional Commits
- body: 변경 이유·계약·검증을 상세히 기록
- 원자 변경 target test와 format/review 뒤 commit
- commit 즉시 `origin/feat/phase-30-reconciled` push
- 전체 성공 전 tag 생성 금지
- main rewrite/force push는 사용자의 별도 명시적 승인 없이는 수행하지 않음

### 0.F.3 이력 재현 명령

```bash
git log --reverse --date=iso-strict --format='%h|%ad|%s' HEAD
git log --reverse --date=short --format='%h|%ad|%s' "$(git merge-base HEAD main)"..HEAD
git rev-list --left-right --count main...HEAD
git reflog --date=iso --all
```

source baseline HEAD에는 874개 commit이 있으며 active branch delta는 147개입니다. 이 master handoff commit은 그 뒤 하나 더 추가됩니다. 0.C는 전체 제품 이력을 domain·사용자 결과 기준으로 요약하고, 16에는 master 보강 직전 active delta 전체를 순서대로 보존합니다.

## 0.G 자격 증명과 데이터 안전 경계

- 현재 Mac의 Codex 인증은 제품의 공식 Tauri login/app-server 경로로 사용합니다.
- access token은 `~/.config/massion-v1/access.token`에서 참조하되 값을 terminal·문서·채팅에 출력하지 않습니다.
- Provider key·account·quota는 개인 소유이며 공유·대여·proxy·재판매하지 않습니다.
- renderer에 daemon token이나 raw credential을 전달하지 않습니다.
- `/tmp/massion-refund-project-20260804`는 synthetic actual-file UAT project이며 production/customer data가 아닙니다.
- 현재 SurrealDB data directory를 삭제·초기화하지 않습니다. migration과 recovery는 보존 상태에서 검증합니다.
- workspace 밖 write, symlink escape, untrusted workspace execution은 fail-closed여야 합니다.
- 로그·evidence에는 secret, raw authorization header, 사용자 절대 경로를 불필요하게 남기지 않습니다.

## 0.H 전체 요구사항 상태표

상태 의미:

- `implemented`: 실제 command/query/runtime 배선과 영속 증거가 모두 있음
- `partial`: 일부 생산 배선·과거 실제 증거가 있으나 계약이나 최신 UAT가 남음
- `fixture-only`: 목표 UI는 있으나 핵심 제품 command/query가 없음
- `unverified`: 수정은 있으나 재현 가능한 최신 증거가 없음
- `blocked`: 알려진 결함이 핵심 사용자 흐름을 막음

현재 9개 surface의 shell은 존재하지만 제품 단위로 완전히 `implemented`라고 판정할 surface는 없습니다.

### 0.H.1 아홉 surface와 전역 utility

| Surface | 상태 | 구현된 것 | 남은 출시 증거·GAP |
|---|---|---|---|
| 홈 | `partial` | Dashboard와 단일 `InboxItem` projection | 승인·차단·Growth 대기가 홈·badge·수신함·소유 화면에서 같은 상태로 생성·해소되는 실제 UAT |
| 업무 | `blocked` | Work detail, room, Task, Artifact, Assurance, Records shell과 과거 실제 증거 | 최신 bundle 자연어 Work 완주 0건; fallback·orphan·Runtime 협업 기록 차단 |
| 지식 | `partial` | workspace index, EvidenceBrief, prompt citation, memory lineage, 일부 Tauri 증거 | 관계 graph projection, K01–K04 전체 UAT, memory 적용·해제 전체 시나리오 |
| 조직 | `partial` | hierarchy·scope·work ID·staffing proposal의 contract→Desktop wiring | fixture 없는 proposal 승인·거절, Organization Version, revert, restart UAT |
| 개선(Growth) | `partial` | domain, 상세 evidence·signal·effect query, typed configure/approve/reject, Desktop 실제 버튼, 일부 adoption/effect cohort | 최신 candidate의 review/auto 실제 UAT, follow-up effect, revert 제품 경로와 restart 보존 |
| 확장 | `partial` | install·inspect·approval·worker·health·rollback | 설치 Capability를 Agent Runtime이 소비해 실제 Work에 기여하는 경로 |
| 프로바이더 | `partial` | connection·account·key·Router·Codex login, 지원 manifest 목록 노출, 키·계정 추가/제거, 2단계 provider 제거, Codex 오류 분류·fallback 배선(2026-08-09) | model on/off contract, **fallback 체인 실검증**, OpenRouter를 route 후보로 등록 |
| 예산 | `fixture-only` | Router 내부 reservation/cost object와 목표 UI | guard command, `route_attempt` query, threshold persistence, actual hard limit block |
| 설정 | `partial` | execution policy, Growth mode UI 일부, en/ko 기반 | policy 실제 행동 변화, system locale, restart, Agent output language 전체 UAT |
| 전역 수신함 | `partial` | approval·blocked·Growth review를 하나의 view로 투영하는 shell | 실제 single-state-source 생성·해소·badge 일치 UAT |

### 0.H.2 핵심 제품 축

| 요구사항 | 상태 | 엄격한 판단 |
|---|---|---|
| Work lifecycle | `blocked` | Request→Context→Task→Artifact→Assurance→Records domain은 있으나 최신 candidate 완주·restart가 없음 |
| 동적 Agent·model 배치 | `partial` | staffing·route 구성요소와 과거 data는 있으나 자연스러운 capability-gap Work가 없음 |
| 협업방·handoff | `blocked` | room·participant·user request·Representative handoff는 있으나 Runtime delegate/answer 영속 0 |
| Knowledge·RAG·Memory | `partial` | production knowledge·citation·memory lineage 일부 동작; 관계 graph와 전체 K UAT 미완 |
| Growth 자가개선 | `partial` | 상세 조회와 review command·Desktop 연결 및 일부 effect 증거; 최신 review/auto·follow-up effect·revert·restart UAT 미완 |
| Provider·fallback | `partial` | adapter·runner 분류를 2026-08-09에 고쳐 429/5xx·output 실패가 fallback 가능으로 분류됨. **실제 route attempt로 이어지는 실행 증거는 아직 없음**. queued orphan 보상은 미착수 |
| Budget | `fixture-only` | 실제 limit command/query가 없음 |
| Settings·i18n | `partial` | locale foundation과 일부 persistence; 전체 UX/runtime language contract 미검증 |
| Extension | `partial` | 안전한 install lifecycle은 있으나 Capability→Runtime Work 연결 없음 |
| Security | `partial` | tenant·scope·replay·outbox·credential·extension isolation 기반과 dependency patch; 최신 전체 gate 미실행 |
| Memory·process lifecycle | `unverified` | 40.99GB 실제 제보와 bound commit은 있으나 raw long soak·lifecycle evidence 없음 |
| Personal release | `blocked` | `.app` artifact는 있으나 build exit와 최신 live UAT·clean install·accessibility·security gate 없음 |

### 0.H.3 fixture와 실제 제품의 차이

| 기대 기능 | fixture | 실제 제품 | 판정 |
|---|---|---|---|
| 풍부한 협업 대화 | Work activity를 다수 대화처럼 표현 | user question + Representative handoff 중심 | Runtime wiring 차단 |
| Agent 이름·색 | Atlas·Lyra 등 완성 | identity token과 participant projection 일부 연결 | 최신 blind visual UAT 필요 |
| 모델 이름·계보 | 완성된 label | representative model과 실제 strategy model이 다르게 보일 수 있음 | route attempt chain 필요 |
| 동적 staffing proposal | scope·impact·compliance·revert card | 주요 contract wiring은 있으나 실제 승인/거절 UAT 없음 | partial |
| Task | 계획·실행 card 존재 | 환불 run context-strategy에서 0/0 | Work 완주 필요 |
| Artifact·Assurance·Records | 완료 상태 풍부 | 과거 증분은 있으나 최신 run 미완 | 최신 actual evidence 필요 |
| Budget | 한도·alert·calls UI | local screen state/계약 부재 | fixture-only |
| Knowledge graph | 3-column graph·relation | index/evidence 일부, relation projection GAP | partial |
| Growth | review→adopt→effect→revert | domain·상세 query·review button과 일부 cohort 연결, 최신 auto/effect/revert/restart UAT 미완 | partial |
| Extension capability | installed capability 표시 | declaration이 contract/runtime에서 버려짐 | partial |

fixture의 항목을 삭제해 parity를 맞추지 않습니다. 실제 제품 계약을 연결하고, 업무상 필요하지 않은 dynamic staffing을 특정 Work에 억지로 발생시키지도 않습니다.

## 0.I 증거 색인과 신뢰 수준

### 0.I.1 현재 HEAD에서 직접 확인된 사실

| 근거 | 상태 | 해석 |
|---|---|---|
| Git HEAD/upstream | 이 문서 보강 전 `92ed55d5d`, 동일 SHA, clean | 현재 commit 뒤 새 문서 commit으로 갱신해야 함 |
| tag | local·remote 모두 없음 | PASS, 유지 |
| 최신 `.app` | mtime 2026-08-04 12:24:23 +0900 | artifact emitted, build exit 미보존 |
| bundle source | storage direct transaction과 async projection 수정 포함 | 두 최신 수정 포함 |
| app/bridge/server | 실행 프로세스 없음 | launch 전 기준선 |
| SurrealDB | PID 68252, PPID 1, RSS 85,312 KiB, 1일 4시간 이상 장수 daemon | 수명주기 계약 미확정, attested reuse 가능 |
| DB | 약 402 MiB, 보존 대상 | 삭제·초기화 금지 |
| runtime orphan | queued 2건, running 0건 | Growth 1건·환불 context-strategy 1건을 audit-preserving terminal convergence 필요 |
| application outbox | pending 6,076, projected 20,954 | 새 async projector의 bounded drain·freshness 재검증 필요 |
| transaction warning | 누적 1,462, 마지막 2026-08-04T03:13:47Z | 새 bundle 실행 전 baseline |
| `server.shutdown.failed` | 누적 10 | 재검증 필요 |
| 무료 DeepSeek endpoint | HTTP 404 retired | unavailable, 성공 후보 아님 |

프로세스 RSS는 조회 시점에 변합니다. 본문 5.2의 값은 그 시점 snapshot이며 새 에이전트는 시작 즉시 다시 기록해야 합니다.

### 0.I.2 역사적 실제 제품 증거 — 유효하지만 현재 HEAD 회귀 증거는 아님

| 문서 | 실제로 증명한 것 | 한계 |
|---|---|---|
| `docs/evidence/phase-30/desktop-live-workspace-file-knowledge-uat-2026-07-27.md` | native picker, 실제 OpenRouter Work, 선택 파일 색인, EvidenceBrief, ArtifactVersion, Assurance passed, Records | 이전 candidate, 현재 fallback/dynamic staffing 미증명 |
| `docs/evidence/phase-30/desktop-live-provider-restart-uat-2026-07-27-573297642.md` | 실제 Z.AI Work, execution 5건, artifact 2개, app/server/DB restart 보존 | 현재 Codex·최신 bundle 미증명 |
| `docs/evidence/phase-30/desktop-core-uat-2026-07-26.md` | 실제 GLM Work, Core 참가자 9명, representative handoff, Task·Assurance·Records·restart | Runtime delegate/answer room 영속화 미증명 |
| `docs/evidence/phase-30/emergency-release-flow-2026-07-27.md` | 실제 OpenRouter timeout/output fallback, Growth review/adoption, 3 Assurance sample, stable/retained | 현재 Codex app-server truth table과 다른 경계; 문서의 `f233800...`은 executable SHA-256 |
| `docs/evidence/phase-30/glm-dogfooding-uat-2026-07-20.md`·`2026-07-21.md` | 개인 Z.AI 모델의 실제 개발·Work 사용 | 단일 account, 복수 Provider fallback 미증명 |

### 0.I.3 현재 HEAD의 중간 강도 증거

- `11ec0954a`: server 359 passed, 2 skipped와 독립 검수
- `bde95f8b1`: storage 21 passed, 1 skipped와 독립 검수
- `f8ce0368d`: application 533 passed, 1 skipped와 독립 검수
- `b2ac33644`, `2b45860e5`: en/ko foundation과 dynamic localization
- `d3e38c4c7`: local Surreal memory profile `rocksdb-256m-64m-2`
- `5996ac182`: vulnerable transitive dependency patch

이 근거는 각 원자 변경에는 유효하지만 현재 release candidate 전체나 실제 Work 완주로 확대할 수 없습니다.

### 0.I.4 stale·부분·출시 증거에서 제외할 자료

| 자료 | 제외 이유 |
|---|---|
| `uat-full-verification-2026-07-25.md` | fixture Playwright와 backend automation이며 실제 Tauri 23개 UAT가 아님 |
| `clean-base-full-verification-2026-07-18.md` | 오래된 `65922bd...` 기준선 |
| `desktop-artifact-signing-2026-07-27-573297642.md` | codesign·spctl·stapler 실패의 역사 기록; 성공 증거 아님 |
| 15분 메모리 수치 | raw timestamp sample artifact 없음 |
| UI의 `Umbra`·`Brook` 관측 | 일부 staffing projection 근거일 뿐 capability-gap 완주 증거 아님 |
| Hugging Face Space 페이지 | 실제 endpoint가 retired이므로 model availability 증거 아님 |
| fixture의 room·budget·Growth·Knowledge | 기대 UI 계약일 뿐 production command/query/runtime 증거 아님 |

### 0.I.5 새 evidence 작성 규칙

- 동일 candidate SHA·bundle hash·실행 시각을 기록합니다.
- 실제 파일, Work/run/execution/attempt/task/artifact/assurance/records ID를 secret 없이 기록합니다.
- 실행 명령과 exit code, 자동 test count, UI 관측을 분리합니다.
- expected와 actual을 나란히 적습니다.
- 실패도 삭제하지 말고 최초 공통 원인과 해결 commit에 연결합니다.
- fixture·mock·direct API·actual Tauri를 명확히 구분합니다.
- memory는 raw timestamp sample artifact를 함께 저장합니다.

## 1. 한눈에 보는 현재 상황

Massion은 개인용 macOS 데스크톱 AgentOS를 만들고 있습니다. 사용자가 자연어로 실제 프로젝트 업무를 요청하면 운영체제 계층이 맥락을 읽고, 적절한 모델과 Agent를 배치하고, 협업방·인계·Task·Artifact·Assurance·Records를 연결해 업무를 끝까지 수행하는 제품입니다.

현재까지 저장소·보안·시작 복구·명령 응답 지연·i18n 기반·일부 UI 품질 결함은 수정됐습니다. 그러나 **새 빌드에서 실제 Work 한 건이 자연스럽게 완주했다는 출시 증거는 아직 없습니다.** 특히 Codex의 일시적 실패를 안전하게 분류해 다음 모델로 넘기는 경로, Runtime Agent 협업을 실제 방에 기록하는 배선, 실제 동적 배치 계보, 결과 파일 생성, 재시작 보존, 메모리·종료 수명주기 검증이 남았습니다.

다음 객관적 이정표는 코드 파일 수나 fixture 화면이 아니라 아래 한 문장입니다.

> 실제 데이터가 있는 환불 프로젝트에서 자연어 요청 하나로 모델 선택·협업·Task·Artifact·Assurance·Records가 완료되고 재시작 뒤에도 보존된다. 이어서 별도 capability-gap 프로젝트에서 명시적 배치 지시 없이 동적 Agent 제안·승인·참여가 완료된다.

## 2. 제품 의도와 품질 계약

### 2.1 사용자가 기대하는 경험

- 사용자는 내부 실행 절차를 프롬프트에 지시하지 않습니다. AgentOS가 업무 성격에 따라 계획·모델 선택·Agent 배치·검증·기록을 자연스럽게 수행해야 합니다.
- 협업방에는 실제 대화, 사람이 읽을 수 있는 Agent 이름, 사용 모델, `Atlas → Lyra` 같은 인계 흐름이 보여야 합니다.
- Task, 동적 Agent, 모델 계보, ArtifactVersion, Assurance, Records, 지식 그래프는 서로 연결되어야 합니다.
- fixture의 풍부함은 제품이 도달해야 할 기대 기능과 시각 품질입니다. 다만 fixture 데이터 자체는 실제 제품 동작의 증거가 아닙니다.
- 화면은 아름답기만 한 것이 아니라 일관되어야 합니다. 채팅 스크롤, Markdown, 정보 밀도, 구분선, 이름·시간 표현과 접근성 기본선이 실제 사용 흐름을 방해하면 안 됩니다.
- 내부용 다음 단계나 검증 지시를 사용자에게 그대로 노출하지 않습니다.

### 2.2 출시 범위

포함:

- Tauri 기반 macOS 데스크톱 앱
- 실제 Codex 인증을 사용하는 Work 실행
- Provider와 안전한 모델 fallback
- 동적 Agent·모델 할당과 승인·조직 반영
- 협업방·인계·Task·Artifact·Assurance·Records 완주
- 시스템 언어 기본값과 설정에서 전환 가능한 영어(en)·한국어(ko)
- 재시작 보존, 데이터 손실 방지, 보안 경계, 접근성 기본선
- 실제 프로세스 메모리와 종료 소유권 검증

현재 임계 경로에서 제외:

- TUI와 레거시 Web(`apps/studio` 포함)
- 비차단 문서 정리와 광범위한 미관 보정
- 모든 변경마다 전체 빌드
- 개인용 v1 단계에서의 과도한 서명·공증 작업
- 근거 없는 가상 업무나 프롬프트에 `UAT`, 내부 단계, Agent·모델을 직접 지시하는 시험

### 2.3 운영 방식

한 묶음은 다음 순서로 닫습니다.

1. 실패 테스트(RED)로 전체 실패 계열과 truth table을 먼저 고정합니다.
2. 공통 원인에 최소 구현을 적용합니다.
3. 표적 테스트와 Prettier·diff check를 실행합니다.
4. 구현자 1명과 독립 검수자 1명으로 통합 검수 1회를 수행합니다.
5. 같은 계열 지적을 일괄 수정하고 최종 재검수합니다.
6. 검증된 원자 변경을 즉시 커밋·푸시합니다.

추가 규칙:

- 하위 에이전트의 재귀 확장을 금지합니다. 독립 축마다 구현자 1명·검수자 1명만 둡니다.
- 소스 수정과 표적 테스트만 병렬화합니다. 공유 `dist`를 건드리는 build/typecheck는 루트의 단일 직렬 큐에서만 실행합니다.
- 이미 승인된 영역을 다음 검수에서 전면 재조사하지 않습니다. 수정된 경계와 인접 회귀만 봅니다.
- 새 공개 커밋 메시지는 **영어 Conventional Commits**로 작성하고 상세 본문을 포함합니다.
- 검증된 원자 변경마다 커밋하고 원격에 푸시합니다.
- 현시점에는 release tag가 존재하면 안 됩니다.

## 3. Git과 작업 트리 상태

2026-08-05 master 보강을 시작하기 직전 재확인 결과:

```text
branch: feat/phase-30-reconciled
HEAD:   92ed55d5d06145947b1598c4f7a112311692b7bc
origin: 92ed55d5d06145947b1598c4f7a112311692b7bc
status: clean (이후 master handoff 문서만 수정)
tags:   none
```

다음 에이전트는 시작 즉시 다시 확인해야 합니다.

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse '@{u}'
git tag --list
```

사용자 데이터나 현재 DB를 임의로 삭제하거나 `git reset --hard`, `git checkout --` 같은 파괴적 명령을 사용하지 마세요.

## 4. 지금까지 완료한 주요 변경

아래 항목은 커밋·푸시됐습니다. “완료”는 각 원자 변경에 대한 의미이며 전체 v1 완료를 뜻하지 않습니다.

| 커밋 | 변경 | 검증 근거 |
|---|---|---|
| `b2ac33644` | `feat(i18n): add English and Korean locale foundations` | 영어·한국어 locale 기반 추가 |
| `2b45860e5` | `fix(i18n): localize dynamic desktop content` | 동적 데스크톱 콘텐츠 현지화; 당시 desktop 273/273, ESLint 통과 |
| `d3e38c4c7` | `fix(runtime): bound local SurrealDB memory` | 로컬 SurrealDB 메모리 상한 조정 |
| `be31ca517` | `fix(quality): clear release lint blockers` | 출시 lint 차단 제거 |
| `1c0cebff0` | `test(desktop): align graph accessibility assertions` | 그래프 접근성 assertion 정렬, 독립 검수 통과 |
| `5996ac182` | `fix(security): patch vulnerable transitive dependencies` | 취약한 전이 의존성 보정 |
| `ed63a141a` | `fix(server): decouple startup from quota polling` | quota polling이 서버 시작을 막지 않도록 분리 |
| `11ec0954a` | `fix(server): keep startup available during work recovery` | 외부 모델 복구를 readiness 전경에서 분리; server 43 files 통과/2 skipped, 359 tests 통과/2 skipped |
| `bde95f8b1` | `fix(storage): avoid transaction session teardown stalls` | transaction별 session attach/detach 제거, rollback 오류 보존, storage 21 통과/1 skipped, 검수 PASS |
| `f8ce0368d` | `fix(application): return commands before event projection` | command 응답을 역사적 projection backlog에서 분리, 조직별 coalescing; application 52 files 통과/1 skipped, 533 통과/1 skipped, 검수 PASS |

### 4.0 2026-08-09 세션에서 완료·검증된 변경

| 커밋 | 변경 | 검증 근거 |
|---|---|---|
| `e7bb4bd2d` | `fix(server): classify Codex transport failures for safe fallback` | 429/5xx/stream이 상태 코드를 보존한 fallback 가능 실패로 분류. server 368 통과 |
| `d424c202f` | `fix(runtime): settle structured output failures by observed side effects` | `SubscriptionStructuredOutputError`로 관측 부작용 전달. runtime 257 통과 |
| `980e1b0dc` | `fix(desktop): use the registered endpoint ID when adding a credential` | register 응답의 `endpointId` 사용, 등록 idempotency, 내부오류 로깅, DeepSeek UI 제거 |
| `2e6e91ad3` | `feat(router): remove a directly registered provider` | provider·endpoint·credential·model profile·candidate 정리, 계보·구독 두 안전장치 |
| `73ee3e962` | `fix(application): report provider removal refusals to the user` | 거부를 conflict로 번역해 사유 노출 |
| `7c535f944` | `fix(desktop): make provider removal deliberate and reversible-safe` | 확인 단계·danger 색·notice 정리, 지원 manifest 목록 노출, 은퇴 방식 |
| `da26f7204` | `fix(desktop): repair dead tokens and dead ends on the provider surface` | `warning`·`--color-muted` 죽은 토큰 복구, 저장 안 되는 토글 제거, 카운트 단일 소스 |
| `9be0dbfb0` | `fix(desktop): make dialog overrides land and stop denying a saved key` | `cn()`이 tailwind-merge가 아님을 실측, base 직접 수정, 키 존재 판정을 자격 기준으로 |
| `f905ab9c5` | `fix(desktop): stop Korean leaking into the English locale and guard the class` | 미등록 문구 등록, 색·translate 가드 확장(접두사 필터 삭제) |
| `5c6bfc0ce` | `fix(desktop): let dialog callers set their own width` | base의 `w-full` 제거. 프로덕션 CSS 방출 순서로 근거 확인 |
| `b4ff3cacf` | `fix(desktop): render status messages through the translator` | `{error}`·`{notice}` 네 지점 + 렌더 지점 가드 |
| `550da60c6` | `fix(desktop): translate the literals the surface renders directly` | JSX 리터럴 16곳, 한글 리터럴 부류 전체 가드 |
| `ff8de2e60` | `feat(desktop): offer a retry when the provider surface fails to load` | design.md §5의 retry 상태. 회귀 테스트 포함 |
| `3613f7d9b` | `style(desktop): finish the provider surface's visual leftovers` | AccountCard 행 통일, 점 3갈래, 막대 3px |
| `46e92b3d5` | `feat(desktop): let the user take a key or an account back out` | `credential.disable`·`account.disconnect`를 화면에 연결 |
| `7cd32e448` | `fix(router): let a retired provider be removed for good` | 비활성 provider 조회, 2단계 제거 |
| `bf7e855d8` | `fix(storage): retry a transaction the server has lost` | 트랜잭션 유실을 재시도 대상으로. storage 22 · application 554 · server 344 통과 |
| `9fb3f017b` | `fix(router): keep verification evidence when removing a provider` | 불변 증거 보존. 증거가 있는 조건을 테스트로 재현 |
| `428eb0007` | `fix(desktop): read registered keys from the query that returns them` | `router.credentials`를 투영에 연결 + query에 version 두 필드 추가 |
| `b13622de9` | `fix(desktop): model provider keys as the list they are` | 키를 목록으로. "키 추가"로 통일, 행마다 제거 |
| `d5219bbe5` | `style(desktop): brace the void-returning key remove handler` | lint |
| `1bfae9fd6` | `docs(handoff): record the provider surface and fallback session` | 이 문서에 병합됨 |

실측 결과: desktop **278** · router **94** · application **554** · server **344** · storage **22** · runtime **257** 통과. typecheck·ESLint·Prettier 통과. `tauri:build` **exit 0**(2026-08-09 10:14).

### 4.1 시작 복구(startup recovery) 결함

기존에는 `ApplicationRunStartupRecoveryService.start()`가 외부 모델 복구를 기다린 뒤 HTTP listen으로 넘어가 readiness가 30초 안에 열리지 않았습니다. 복구를 background로 옮기고 close 동작과 readiness 계약을 고정했습니다.

이 변경은 테스트로 통과했지만, 최신 데스크톱 번들에서 전체 사용자 흐름으로 다시 확인해야 합니다.

### 4.2 명령 응답 지연 결함

실제 시험에서 workspace 등록·신뢰·run 시작·재개 명령은 DB에 저장됐지만 UI promise가 돌아오지 않았습니다. 직접 HTTP 요청도 12초 동안 응답 바이트가 없었고, DB 행은 약 119ms에 성공했습니다.

원인은 두 개였습니다.

1. 모든 transaction마다 `forkSession()`을 만들고 commit 뒤 `closeSession()`/detach를 기다렸습니다.
2. Application product가 command와 metric을 commit한 뒤 6천 건 이상의 과거 outbox projection까지 기다린 다음 응답했습니다.

`bde95f8b1`과 `f8ce0368d`에서 각각 공통 원인을 수정했습니다. 하지만 **수정된 새 번들을 실제로 실행해 HTTP와 UI 응답을 재검증하기 전에 이전 작업이 중단됐습니다.** 이것이 재개 후 첫 검증입니다.

## 5. 빌드와 런타임의 정확한 현재 상태

### 5.1 Tauri 번들

다음 명령을 루트 단일 직렬 큐에서 실행했습니다.

```bash
pnpm --filter @massion/desktop tauri:build
```

도중에 작업 턴이 끊겨 shell exit code를 보존하지 못했습니다. 다만 아래 번들은 2026-08-04 12:24:23 +0900 시각으로 생성됐습니다.

```text
apps/desktop/src-tauri/target/release/bundle/macos/Massion.app
```

따라서 상태는 **artifact emitted / build exit 미확인**입니다. 완전한 build PASS로 기록하면 안 됩니다. 최신 명령 응답 수정이 포함된 이 번들을 아직 실행·검증하지 않았습니다.

### 5.2 프로세스 snapshot 경과

초기 handoff 확인 당시 Massion 앱·server·bridge는 종료된 상태였습니다. SurrealDB만 부모 프로세스가 1인 장수 daemon으로 남아 있었습니다.

```text
PID 68252
PPID 1
RSS 123,456 KiB (초기 handoff snapshot)
elapsed 1일 3시간 35분 이상
command ~/.local/share/massion-v1/runtime/surrealdb/3.2.1/darwin-arm64/surreal start ... --bind 127.0.0.1:7330
```

이 프로세스는 앱이 종료된 뒤에도 장시간 남는 daemon이라는 관측 증거입니다. 다만 `packages/local-control/src/local-surreal-runtime.ts`는 state·PID·실행 파일을 검증한 기존 프로세스를 `already-running`으로 재사용하도록 구현돼 있습니다. 따라서 이것만으로 shutdown 결함이라고 단정할 수 없습니다. Cmd-Q 시 종료가 계약인지 장수 daemon 재사용이 계약인지 정본화하고, 재실행의 attestation·attach/reuse·포트 동작을 검증한 뒤 판정하세요. 영속 DB를 맹목적으로 kill하거나 삭제하지 마세요.

2026-08-05 master 검수 중 같은 PID의 RSS는 85,312–85,552 KiB로 변했습니다. timestamp 없는 두 RSS를 누수 추세로 비교하지 않습니다. 다음 agent는 시작 시각과 함께 새 raw sample을 기록합니다.

## 6. 실제 사용 시나리오와 남은 Work

### 6.1 근거 데이터 프로젝트

실제와 같은 시험용 프로젝트가 다음 경로에 있습니다.

```text
/tmp/massion-refund-project-20260804
```

재부팅·정리로 `/tmp`가 사라져도 동일 입력을 복원할 수 있도록 durable source와 checksum manifest를 저장소에 보존했습니다.

```text
docs/evidence/phase-30/fixtures/refund-delay-project/
```

Work를 다시 실행하기 전에 네 input file의 SHA-256을 `MANIFEST.md`와 비교하고, output이 없는 새 임시 디렉터리에 복사합니다. 저장소의 durable source 자체를 Work workspace로 사용해 산출물로 오염시키지 않습니다.

파일:

- `README.md`
- `batch-policy.md`
- `data-dictionary.md`
- `refunds.csv` — header 포함 25줄, 24개 record

아직 생성되지 않은 기대 산출물:

```text
refund-delay-report.md
```

데이터는 익명 synthetic record이지만 내부적으로 완결되어 있고 production/customer data는 없습니다. 정책은 검토된 환불을 다음 09:00 KST daily batch에 넣습니다. 이전 복구 가능 설정은 09:00·17:00이며, 현재 once-daily 설정은 migration 없이 되돌릴 수 있습니다. rollback은 `batch_schedule=09:00` 복원과 restart 전 active queue drain을 요구합니다.

독립 계산 기대값:

| 구간 | 평균 |
|---|---:|
| 요청 → 검토 | 2.7917시간 |
| 검토 → batch | 20.5417시간 |
| batch → 지급 | 2.0000시간 |

사용할 자연어 요청은 다음과 같습니다.

```text
이 폴더의 환불 처리 기록을 분석해 가장 큰 지연 구간과 개선안을 찾고, 근거가 되는 수치와 되돌리기 조건을 refund-delay-report.md에 정리해 주세요.
```

이 문구에 `UAT`, 내부 계획·실행·검증·기록 단계, 사용할 Agent나 모델, “사실을 만들지 말라” 같은 메타 지시를 추가하지 마세요. 제품이 프로젝트 데이터와 업무 의도를 바탕으로 스스로 동작하는지 검증해야 합니다.

### 6.2 저장된 Work와 run

마지막 DB 확인 값:

```text
Work
  id:     88aab4fe-f02b-42e4-b2d6-2327e5d43cf7
  status: draft
  title:  null

ApplicationRun
  id:               f904035a-8764-41d6-b7be-198f087fcf1a
  work_id:          88aab4fe-f02b-42e4-b2d6-2327e5d43cf7
  status:           blocked
  stage:            context-strategy
  retry_attempt_id: 7ebb440a-a4bc-41d8-8dde-f7f9ef77d17b
```

마지막 확인 당시 application outbox는 pending 6,076건, projected 20,954건이었습니다. Surreal의 `transaction not found` warning 누적은 1,462건이고 새 번들 검증 직전 기준값을 다시 기록해야 합니다.

전역 `runtime_execution`에는 환불 Work 외에도 terminalize되지 않은 실행이 하나 더 있어 queued/running이 총 2건입니다.

| execution | Work | Agent | route | status | created |
|---|---|---|---|---|---|
| `1232d0b0-e1ea-422c-855c-75ced5144505` | `34d46e96-6326-459b-ad10-2878085198e8` | `growth` | `planning-quality` | queued | 2026-07-26T06:43:12.272605Z |
| `e0543772-fb45-42f8-8d0b-0888cc2a839c` | `88aab4fe-f02b-42e4-b2d6-2327e5d43cf7` | `context-strategy` | `planning-quality` | queued | 2026-08-04T02:39:34.479189Z |

두 실행 모두 task ID는 없습니다. fallback/queued 보상 묶음은 환불 Work만 보지 말고 전역 queued/running을 0으로 수렴시키되, 오래된 실행을 삭제하지 않고 원인에 맞는 terminal event와 audit lineage를 남겨야 합니다.

### 6.3 실제 UI에서 확인된 것

환불 Work의 실제 협업방에는 사용자 질문, `Atlas → Lyra` 인계, `glm-5.2` 모델 표시, Core Office 참가자 9명이 나타났습니다. 그러나 context-strategy 단계에서 멈췄고 Task는 0/0이었습니다.

이전에 복구된 다른 Work에서는 사람 이름과 모델명, `Atlas → Lyra` 인계, 동적 Agent `Umbra`·`Brook`, Task 2/2, Artifact, 진행 중 Assurance가 실제 데이터로 보였습니다. 이는 일부 풍부한 배선이 존재한다는 근거이지, 환불 시나리오 완주나 전체 v1의 증거는 아닙니다.

## 7. Codex fallback과 모델 계보 — 2026-08-09에 배선 완료, 실행 증거 미확보

> **상태 갱신(2026-08-09)**: 아래 §7.2~§7.3이 진단한 어댑터·runner 결함은 `e7bb4bd2d`·`d424c202f`로 닫혔고, §7.4 truth table 중 Codex 어댑터와 runner 몫은 표적 테스트로 고정됐습니다. **router 보안 gate는 지시대로 건드리지 않았습니다.** 남은 것은 두 가지입니다 — (1) 실제 Work에서 route attempt chain이 이어지는 실행 증거, (2) queued orphan 보상(§7.4의 store 경계 행). 아래 진단은 그대로 두어 무엇을 왜 고쳤는지 추적할 수 있게 합니다.
>
> HF DeepSeek 무료 endpoint는 retired가 확정돼(HTTP 404) provider 등록을 **완전히 제거**했습니다. 현재 route 후보는 5개 route × (Codex, GLM) = 10개입니다. OpenRouter는 provider·endpoint·키까지 등록됐으나 **model profile과 route candidate가 없어 후보로 참여하지 않습니다.**

### 7.1 현재 후보

실제 planning route 설정에는 다음 세 후보가 있습니다.

1. Z.AI GLM-5.2 — priority 1
2. Codex `gpt-5.6-sol` — priority 1
3. Hugging Face `deepseek-ai/DeepSeek-V4-Flash-0731` — priority 100

Hugging Face 연동과 model ID는 이미 `apps/server/src/deepseek-community-provider.ts`에 있습니다. 그러나 2026-08-05에 등록된 endpoint의 `/v1/models`를 비밀 없이 직접 조회한 결과 HTTP 404와 `free public endpoint ... has been retired` 응답을 확인했습니다. Space 문서가 남아 있어도 이 무료 endpoint는 현재 사용 불가능합니다. 따라서 이를 성공 가능한 fallback으로 계산하거나 다른 실제 endpoint가 승인되기 전에 대체 Provider를 임의로 추가하면 안 됩니다. 현재 route에서는 unavailable 후보로 안전하게 제외·정산해야 합니다.

### 7.2 관측된 실패

- representative 단계는 Z.AI GLM-5.2로 성공했습니다.
- 실패한 context-strategy는 실제로 Codex `gpt-5.6-sol`을 선택했습니다.
- UI에는 representative 모델인 GLM만 보여 실제 모델 계보를 오인하게 했습니다.
- 실패 attempt는 `emitted_tokens=0`, `failure_class=unknown`, `side_effects_started=true`, `status=interrupted`, `fallback_allowed=false`였습니다.
- 따라서 다음 GLM/Hugging Face 후보로 넘어가지 않았습니다.
- 수동 retry는 queued execution을 만들었지만 running event나 route attempt가 없어 orphan queue가 남았습니다.

### 7.3 근본 원인 위치

- `apps/server/src/codex-app-server-agent.ts` 약 120–137, 501–516줄
  - 현재 401/auth 실패만 안전하게 분류합니다.
  - 공식 Codex app-server의 usage limit, HTTP 429/5xx, stream/network 실패가 `unknown + sideEffectsStarted=true`로 뭉개집니다.
- `packages/runtime/src/voltagent-runner.ts`
  - `failureSignal()`은 marker가 있는 structured JSON parse 오류를 이미 `output`으로 분류합니다.
  - schema validate 실패는 adapter가 `validation.error` 원문을 reject하므로 marker가 없으면 `unknown`이 됩니다. typed/normalized output failure가 필요합니다.
  - catch에서 agent-runtime lease의 모든 오류를 `sideEffectsStarted=true`로 넘겨, 실제 외부 효과가 없던 output failure도 fallback을 막습니다.
  - `createExecution` 뒤 running 전환 예외가 나면 queued 상태가 terminalize되지 않습니다.
- `packages/runtime/src/execution-store.ts` 약 322–369줄
  - queued execution을 먼저 commit한 뒤 configuration resolve·attach를 수행합니다.
  - configuration resolve가 reject하면 runner는 execution ID를 받지 못하므로 runner만으로 보상할 수 없습니다. 이 경계까지 truth table에 포함하려면 store의 보상·원자성 또는 execution ID를 보존하는 typed error 계약이 필요합니다.
- `packages/router/src/model-router.ts`
  - `retryable failure + emitted=0 + sideEffects=false`일 때만 fallback을 허용하는 보안 경계는 옳습니다.
  - **router 보안 조건을 완화하지 마세요.** adapter와 runner가 정확한 실패 정보를 넘기도록 고쳐야 합니다.
- `apps/desktop/src/desktop-service.ts` 약 5790줄 이후, `apps/desktop/src/app.tsx` 약 6255줄 이후
  - 모든 전략 실패를 “구조화 응답 실패”라고 고정 표시합니다. 최소한 `전략 계획 생성을 완료하지 못했습니다.`처럼 사실에 맞는 표현이 필요하며, 최종적으로 실제 route attempt 모델 계보를 투영해야 합니다.

### 7.4 반드시 테스트로 고정할 truth table

| 상황 | 기대 결과 |
|---|---|
| Codex 429/5xx/stream/network, 출력 0, command/file/tool 없음 | failed, fallback 허용, 다음 후보 attempt 연결 |
| structured JSON parse invalid, buffered only, 외부 효과 없음 | 기존 output failure 분류를 보존하고 실제 부작용 false로 정산, fallback 허용 |
| schema validate 실패, buffered only, 외부 효과 없음 | typed/normalized output failure, 실제 부작용 false, fallback 허용 |
| commandExecution/fileChange/MCP/approval request/알 수 없는 item 관측 | interrupted, fallback 금지 |
| 402/403/BadRequest/policy/input/cancel | fallback 금지 |
| 사용 가능한 후보 없음 | secret-free `blocked_model_unavailable`, terminal; queued/running orphan 0 |
| configuration resolve/attach 또는 running 전환 실패 | store/runner 경계에서 생성한 queued execution을 terminalize하고 execution ID·원인 category 보존 |
| 후보 전환 | route attempt chain 단조 증가, UI가 대표 모델 하나가 아닌 실제 계보 표시 |

필수 표적 테스트:

- `apps/server/src/codex-app-server-agent.test.ts`
  - 기존 “non-401 429 fallback forbidden” 기대를 안전한 429/503/stream truth table로 교체
  - tool/item 관측 variant는 fallback 금지 유지
  - schema invalid의 no-tool/after-tool 분리
- `packages/runtime/src/voltagent-runner.test.ts`
  - no-side-effect structured failure가 두 번째 모델로 이동하고 attempt/lease lineage 보존
  - sideEffects=true는 첫 attempt만 terminalize
  - pre-running transition reject가 queued orphan을 남기지 않음
- `packages/runtime/src/execution-store.test.ts`
  - configuration resolve/attach reject가 queued orphan을 남기지 않거나, 보상 가능한 execution ID를 typed error로 보존
- product integration
  - Codex transient → GLM 성공
  - Codex → GLM output failure → retired Hugging Face 후보 unavailable 정산, secret-free terminal, orphan 0
  - 실제 UI·DB에 모델 attempt chain 표시

이 묶음을 닫기 전 예산·새 UI·TUI·Web·다른 기능 축을 열지 마세요.

## 7.5 출시 차단 GAP: Runtime Agent 협업방 배선

정본 아키텍처는 `REQ-AGENT-HARNESS-001`을 `in-progress`로 명시합니다. 현재 협업방 도메인과 VoltAgent 위임은 각각 존재하지만 연결되어 있지 않습니다.

확인된 생산 경로:

- `packages/application/src/core-pipeline.ts`가 사용자 요청과 Representative handoff 두 건만 기록합니다.
- `packages/runtime/src`에는 `postMessage` 호출이 0건입니다.
- 따라서 Agent 간 `delegate_task` 위임·질문·답변은 VoltAgent 메모리에서 끝나고 실제 협업방·재시작 계보에 남지 않습니다.
- 상세 계약과 기존 seam은 `docs/phases/30-surface-parity-agent-ux/agent-collaboration-runtime-handoff.md`에 정리돼 있습니다.

fallback 묶음이 끝난 뒤, 실제 Work 검증 전에 이 GAP을 별도의 출시 차단 원자 묶음으로 닫아야 합니다. 권장 최소 경로는 기존 `ExecutionDeltaObserver` seam과 이미 있는 Work command·execution delta·idempotent command ID 계약을 재사용하는 것입니다. 다만 fire-and-forget in-memory queue만으로는 delta 직후 crash에서 메시지가 영구 유실됩니다. 실행을 기록 실패로 죽이지 않는 원칙을 유지하면서 durable outbox/event enqueue, terminal 전 drain/ack, 또는 명시적 degraded 상태와 recovery source 가운데 저장소의 기존 패턴에 맞는 최소 durability 경계를 사용해야 합니다.

> **2026-08-09 조사 메모(착수 못 함)**: seam 위치를 확인했습니다.
>
> ```
> ExecutionDelta          contracts.ts:62  — "휘발성 신호, 도메인 정본 아님, 저장소에 기록하지 않음"
> ExecutionDeltaObserver  contracts.ts:75  — "동기 fire-and-forget: 예외·배압을 실행 경로에 전파하지 않음"
> ExecutionStreamRegistry execution-stream.ts:17 — 이미 observer를 구현
> works.postMessage       core-pipeline.ts:341, 483 — commandId/workId/roomId/messageType/authorKind/authorId/content
> ```
>
> 핵심 제약은 계약 자체에 적혀 있습니다. delta는 **휘발성**이고 observer는 **fire-and-forget**이라, 그 자리에서 저장하면 아래가 경고한 유실이 그대로 발생합니다. 계층도 걸립니다 — runner(`packages/runtime`)는 works 도메인을 모르므로 application이 observer를 통해 받아야 합니다.

최소 truth table:

| Runtime 사건 | 영속 결과 |
|---|---|
| supervisor `delegate_task` tool-call | `handoff` 또는 `question`, supervisor handle, execution ID |
| subAgent tool-result | `answer`, subAgent handle, 원 메시지의 reply/caused-by |
| retry/recovery replay | 중복 메시지 0, 같은 idempotent command 결과 |
| room token/cost/round 한계 | 정의된 차단 상태, Runtime process crash 없음 |
| 메시지 기록 실패 | 실행을 죽이지 않지만 로그·event로 관측 가능 |
| delta 영속 전 process crash | durable source에서 replay하거나 terminal을 degraded로 막아 조용한 유실 0 |
| terminal 전 미확정 메시지 존재 | drain/ack 완료 또는 복구 가능한 pending 상태 보존 |
| restart | 협업 메시지·인과·execution lineage 보존 |

합격 근거는 실제 Provider Work에서 방 메시지가 사용자 요청·대표 인계 두 건을 넘어 Agent 위임과 답변까지 실제 데이터로 남는 것입니다. fixture activity를 복사하면 실패입니다.

환불 분석 Work와 동적 Agent 배치 Work는 구분합니다. 환불 업무에 현재 조직 밖의 capability가 필요하다는 근거가 없다면 동적 배치가 발생하지 않는 것이 정상일 수 있습니다. 동적 배치 검증은 실제 파일이 있는 별도 프로젝트를 만든 뒤, 현재 조직 capability snapshot에 없는 역량이 업무상 필요하다는 precondition을 코드·DB에서 먼저 증명하고 자연어 업무 요청으로 실행하세요. 프롬프트에 동적 Agent·모델·승인 절차를 직접 지시해서는 안 됩니다.

## 8. 메모리와 프로세스 수명주기

사용자가 Activity Monitor에서 살아 있는 Massion 프로세스가 40.99GB를 소비하는 화면을 제공했습니다. 이는 앱 종료 후 잔여 프로세스가 아니라 실행 중 앱의 메모리 문제 제보입니다.

`d3e38c4c7` 이후 fresh run 15분 sampling 메모에는 전체 Massion app/node/server/Surreal 합계가 약 2.17GB에서 1.6–2.1GB 사이로 변동했고 마지막은 약 1.72GB였다고 남아 있습니다. 당시 대부분은 active Surreal 약 1.45GB였습니다. 그러나 저장소나 `/tmp`에서 원시 sample artifact를 찾지 못했으므로 이 수치는 참고 관측이며 출시 증거로 사용하면 안 됩니다.

따라서 정확한 상태는 다음과 같습니다.

- 40GB 증상: 사용자가 실제 관측함
- 메모리 상한 수정: 커밋됨
- fresh 15분에서 40GB 재현: 실패
- 장시간 active Work 및 idle에서 완전 해결 증거: 없음
- 정상 Cmd-Q 뒤 app/bridge/server와 재사용 가능한 SurrealDB의 수명주기 계약: 미확정

Work 완주 뒤 새 번들에서 먼저 15분 idle+active 표적 회귀를 수행해 구성 요소별 PID/RSS를 나눠 기록하세요. 최종 DoD에는 이보다 긴 bounded soak가 필요합니다. idle·active 구간, 반복 Work 전후, component별 RSS·slope·peak와 DB 크기/heap 지표를 원시 timestamp sample artifact로 저장하세요. 정상 Cmd-Q 뒤 앱과 bridge·server가 종료되는지, SurrealDB는 정본 수명주기 계약에 따라 종료되거나 attested daemon으로 안전하게 재사용되는지 확인해야 합니다. 단순 aggregate나 같은 15분 재실행만으로 40GB 문제가 해결됐다고 결론 내리지 마세요.

## 9. i18n 상태

사용자 계약은 시스템 설정 언어를 기본값으로 따르고 설정에서 사용자가 변경할 수 있으며 초기 언어는 영어(en)와 한국어(ko)입니다.

두 i18n 커밋으로 기반과 동적 콘텐츠 일부를 구현했습니다. 그러나 전체 제품 완료로 간주하지 않습니다. 최종 실제 UAT에서 다음을 확인해야 합니다.

- 최초 실행 시 시스템 locale 선택
- 설정에서 en/ko 변경
- 선택값 재시작 보존
- 정적·동적 UI, 날짜·숫자, 검색, 오류 메시지의 locale 일관성
- Agent 출력 언어 계약
- 한 화면에서 raw 한국어·영어가 의도 없이 섞이지 않음

현재 fallback·실제 Work 완주 임계 경로를 먼저 닫고 i18n 잔여 배선을 여세요.

## 10. 재개 후 정확한 실행 순서

### 단계 0 — 기준선 보존

1. 이 문서를 읽습니다.
2. Git clean·upstream 동일·tag 없음 상태를 확인합니다.
3. 현재 DB와 `/tmp/massion-refund-project-20260804`를 보존합니다.
4. 새로운 조사 축을 열지 않습니다.

### 단계 1 — 생성된 최신 번들 실행과 command 응답 검증 ✅ 2026-08-09 완료

> `/health/ready`가 실행 26초 만에 200(§4.1 수정의 실전 확인), workspace register HTTP 응답 1.1초로 3초 이내. **단 pending outbox는 idle에서 수렴하지 않았습니다** — 40초 관측에서 27,032건 그대로. 원인은 §19.1에 적었습니다.

```bash
open -n '/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled/apps/desktop/src-tauri/target/release/bundle/macos/Massion.app'
```

`/health/ready`가 열린 뒤 다음을 확인합니다.

- 실행 전 `transaction not found` warning 기준값 기록
- workspace register 명령을 3초 이내에 응답하는지 직접 HTTP로 확인
- operation/outcome/data가 올바른지 확인
- DB command가 final인지 확인
- warning 증가량 0 확인
- UI의 register/trust/run/resume에 무한 spinner가 없는지 확인
- pending outbox 6,076 기준에서 idle 중 backlog가 bounded하게 감소하는지 확인
- replay command로 생긴 최신 outbox가 30초 안에 projected되고 UI read-model이 갱신되는지 확인

이전 idempotent replay 식별자:

```text
command_id:     0c04deb0-3014-4dea-a4c5-9aba6459592c
correlation_id: cdc7bdf4-b0f0-4d8b-9e90-50999679a763
workspace path: /private/tmp/massion-refund-project-20260804
access token:   ~/.config/massion-v1/access.token
```

token 값은 terminal이나 채팅에 출력하지 마세요. 정확한 기존 HTTP envelope는 관련 integration test와 server route에서 확인해 재사용하세요. 추측으로 payload를 만들지 않습니다.

### 단계 2 — Codex fallback·queued orphan 묶음만 수정 ⚠️ 2026-08-09 부분 완료

> 어댑터·runner 분류는 닫혔습니다(`e7bb4bd2d`, `d424c202f`). **queued orphan 보상과 실제 route attempt 계보 투영은 미착수**입니다. 아래 절차는 남은 두 항목에 그대로 적용됩니다.

1. 7.4의 truth table 전체를 RED로 만듭니다.
2. Codex adapter가 공식 error 종류와 실제 부작용 관측 여부를 정확히 반환하게 합니다.
3. runner가 기존 output failure 분류를 보존하면서 실제 부작용 여부로 정산하게 합니다.
4. execution store와 runner 경계에서 config/transition 전 실패의 queued execution을 terminalize하게 합니다.
5. router 보안 gate는 유지합니다.
6. 실제 route attempt 계보가 제품 데이터에 투영되게 합니다.
7. 표적 테스트·Prettier·diff check를 수행합니다.
8. 독립 검수자 1명이 첫 검수에서 동일 계열 전체를 조사합니다.
9. 지적을 일괄 수정하고 재검수합니다.
10. 영어 Conventional Commit으로 즉시 커밋·푸시합니다.

### 단계 3 — Runtime Agent 협업 기록 배선

1. `agent-collaboration-runtime-handoff.md`와 정본 아키텍처 7절을 읽습니다.
2. 실제 `delegate_task` 한 번을 RED로 재현해 방에 메시지가 두 건만 남는 현재 상태를 고정합니다.
3. 기존 execution delta observer와 Work message command를 연결합니다.
4. handoff·answer의 author, reply/caused-by, execution ID, token/cost, idempotency를 검증합니다.
5. 기록 실패·방 한계·retry·restart truth table을 검증합니다.
6. 표적 테스트·포맷·통합 독립 검수 후 별도 영어 Conventional Commit으로 커밋·푸시합니다.

### 단계 4 — 번들 1회 직렬 재빌드

```bash
pnpm --filter @massion/desktop tauri:build
```

이번에는 exit code, artifact path, timestamp를 기록합니다. 다른 에이전트가 동시에 build/typecheck를 실행하면 안 됩니다.

### 단계 5 — 자연스러운 환불 분석 Work 완주

새 번들에서 같은 환불 프로젝트와 6.1의 자연어 요청을 사용합니다. 기존 run을 안전하게 resume할 수 없으면 동일 프로젝트로 fresh Work를 시작해도 됩니다. 이 시나리오와 첫 임계 이정표의 증거는 fresh run 하나가 완주하는 것입니다. 전체 출시 증거는 단계 6–12까지 모두 필요합니다.

합격 기준:

- 실제 route attempt chain과 선택 모델이 DB·UI에서 일치
- OS가 실제 capability 필요성을 판단한 결과와 선택 이유가 계보에 남음
- 협업 메시지는 실제 pipeline event이며 fixture activity 복사가 아님
- 사람이 이해할 수 있는 이름과 모델명 표시
- `Atlas → Lyra` 형태의 인계와 답변 연결
- Task가 0개가 아니며 완료됨
- 프로젝트 폴더에 `refund-delay-report.md` 생성
- 산출물의 수치가 원본 CSV와 일치하고 rollback 조건 포함
- ArtifactVersion 저장·표시
- Assurance가 실제 파일과 데이터 근거로 통과
- Records 완료
- run이 terminal `completed`
- 사용자에게 내부 UAT·단계 지시·불필요한 운영 문구를 노출하지 않음

### 단계 6 — 자연스러운 동적 배치 Work 완주

환불 Work에 동적 배치를 억지로 요구하지 않습니다. 별도의 실제 파일 프로젝트에서 현재 조직에 없는 필수 capability를 먼저 증명한 뒤, 내부 절차를 언급하지 않는 자연어 업무 요청을 사용합니다.

합격 기준:

- capability gap이 업무 입력과 현재 organization snapshot에서 재현 가능
- OS가 명시적 배치 지시 없이 proposal을 생성
- 승인 정책에 따라 실제 승인 또는 허용된 자동 승격을 거침
- 새 Agent가 organization version에 원자적으로 반영
- 협업방에 참가하고 실제 handoff·answer를 기록
- 해당 Agent의 Task·RuntimeExecution·Artifact 기여가 같은 계보로 연결
- Work 종료·취소·재시작에서 scope와 membership이 계약대로 보존 또는 정리

### 단계 7 — 재시작 보존

정상 Cmd-Q 후 앱을 다시 실행합니다. Work, room messages, handoff, Tasks, ArtifactVersion, Assurance, Records, route attempt lineage가 유실 없이 같은 의미로 보이는지 확인합니다.

### 단계 8 — 메모리·종료 검증

- 빠른 gate로 idle과 active Work를 포함한 15분 sampling
- 최종 gate로 반복 Work를 포함한 더 긴 bounded soak; 시간은 사용자 관측을 재현할 수 있게 사전 고정
- app, bridge, server, SurrealDB별 PID·PPID·RSS·elapsed 분리
- timestamp별 원시 sample artifact, slope, peak, 반복 Work 전후 DB·heap 변화 기록
- 정상 Cmd-Q 후 앱 계층 종료와 Surreal attested reuse/termination 계약 확인
- Surreal이 계속 남으면 owner/attach/reuse/shutdown 중 어떤 동작이 정본인지 먼저 고정한 뒤 필요한 경우 최소 수정

### 단계 9 — 첫 실제 Work 이정표 뒤 v1 잔여 계약 폐쇄

단계 1–8은 범위가 동결된 **첫 실제 Work 임계 이정표**입니다. 통과했다고 전체 v1이 끝난 것이 아닙니다. 새 축을 동시에 열지 말고 아래 정본 인계서를 하나씩 같은 원자 흐름으로 닫습니다.

| 표면·축 | 현재 확인된 GAP | 정본 인계·근거 | 실제 완료 증거 |
|---|---|---|---|
| 지식 | K03·K04 화면 UAT, 관계 graph 계약 투영 미완료 | `v1-delivery/phase-03-knowledge-memory.md`, `knowledge-surface-handoff.md`, `knowledge-graph-handoff.md` | 실제 workspace 검색·1-hop 관계·Work citation·memory 적용/해제·재시작 보존 |
| 조직 | 계층·scope·work ID와 staffing proposal은 계약부터 Desktop까지 연결됨; fixture 없는 승인/거절·version·revert 실제 UAT가 미완료 | 현재 source contract/read-model/query/desktop projection, `agent-collaboration-runtime-handoff.md` | 실제 조직 snapshot·proposal·승인/거절·version/revert가 fixture 없이 일치 |
| 개선(Growth) | 상세 근거·신호·효과 query와 typed configure/approve/reject, Desktop review button은 연결됨; 최신 review/auto UAT·후속 효과·revert·restart 미완료 | `growth-adoption-handoff.md`, current application/desktop source | 완료 Work → Reflection/Suggestion → 근거·반대 증거 → review 또는 auto 채택 → 후속 효과 → revert |
| 확장 | 설치 Capability 선언을 Application 계약과 Agent Runtime이 소비하지 않음 | `extension-capability-handoff.md` | 설치된 Skill/Tool Capability가 조직과 실제 Work에 기여하고 권한·제거가 보존 |
| Provider | 연결·계정·키는 동작하지만 모델 개별 on/off 계약 미완료; 등록된 무료 HF endpoint retired | 제품 헌법 §6·§9.1, server provider tests | 실제 연결·모델 공급 목록·enable/disable·unavailable·fallback이 secret 없이 일치 |
| 예산 | guard 명령과 route_attempt 조회가 없어 한도·알림·호출 기록이 제품 경로에 미연결 | `settings-contract-handoff.md`, 제품 헌법 §9.1 | route별 한도·임계값 저장/재시작, 호출·비용·fallback 계보 관측, 실제 hard limit 차단 |
| 설정 | 실행 권한과 Growth 채택 모드, locale의 저장·재시작 계약 전체 검증 필요 | `settings-contract-handoff.md`, `growth-adoption-handoff.md` | permission mode·review/auto·en/ko가 실제 행동을 바꾸고 재시작 보존 |
| 홈·업무·수신함 | 실제 상태가 단일 원천으로 같은 의미를 보여야 함 | 제품 헌법 §6, v1 delivery 기록 | 승인·차단·개선 대기가 배지·홈·수신함·소유 화면에서 동일하고 해결 후 제거 |

정본의 아홉 표면은 홈·업무·지식·조직·개선·확장·프로바이더·예산·설정입니다. 화면이 존재하거나 fixture가 풍부하다는 이유로 해당 축을 완료 처리하지 마세요. 실제 command/query/runtime wiring과 영속 증거가 필요합니다.

### 단계 10 — bounded negative scenario matrix

happy path 두 건만으로 AAA v1을 판정하지 않습니다. 다음 경계 시나리오는 실제 파일·실제 제품 경로로 범위를 고정해 검증하고 비밀 없는 evidence를 남깁니다.

| 시나리오 | 기대 결과 |
|---|---|
| 자료가 부족하거나 서로 모순됨 | 필요한 질문 또는 근거 있는 blocked 상태; 존재하지 않는 사실·산출물 생성 금지 |
| 동적 조직 proposal 승인 거절 | organization version·membership 불변, 실행은 정의된 대체/차단 상태 |
| 실행 중 사용자 취소 | 새 stage·side effect 차단, lease/task 정리, 재시작 후 cancelled 보존 |
| stage commit 직후 process crash | idempotent recovery, 중복 Task·message·Artifact 없음 |
| 신뢰되지 않은 workspace 또는 범위 밖 쓰기 | fail-closed, 외부 파일 변경 0, 사람이 이해할 수 있는 오류 |
| Provider auth/429/5xx/retired endpoint | 보안 truth table에 따른 fallback 또는 terminal, secret 미노출, orphan 0 |
| 예산 임계값·hard limit 도달 | 알림과 실제 route 차단이 같은 저장값을 사용하고 재시작 뒤 유지 |
| Growth 근거 충돌·stale source | auto mode도 채택 금지 또는 review 승격; 조직·prompt·memory 버전 불변 |
| en/ko 각각 실제 Work | UI·오류·날짜·숫자·Agent 출력 언어 계약 일치, 재시작 보존 |
| 반복 Work와 장시간 idle/active | 메모리 bounded, 이전 Work 데이터 혼입 없음, 정상 수명주기 |

### 단계 11 — Tauri 시각·접근성 검수

실제 Work가 완주한 뒤에만 수행합니다. fixture와 blind comparison하되 fixture는 증거가 아니라 기대 기준으로 씁니다.

확인 항목:

- 채팅 스크롤 가능
- Markdown 렌더링
- 과도한 divider가 흐름을 끊지 않음
- UUID와 raw timestamp 대신 의미 있는 이름과 locale 시간
- 실제 모델명·모델 계보 표시
- Task·동적 Agent·handoff·Artifact·Assurance·Records가 누락되지 않음
- 내부적인 “다음 단계” 지시를 사용자에게 불필요하게 노출하지 않음
- 키보드 접근성과 focus 기본선
- en/ko에서 같은 정보 구조와 시각적 일관성

### 단계 12 — 출시 경계 전체 검증 1회

모든 표적 묶음이 닫힌 뒤 루트에서 build·test·lint·security를 직렬로 한 번 실행합니다. 저장소의 package script와 CI 설정을 먼저 확인해 정본 명령을 사용하세요. 과거 명령을 추측해 병렬 실행하지 마세요.

전체 결과와 실제 Tauri 증거를 기록한 뒤에만 목표 완료 여부를 판단합니다.

### 단계 13 — 설치·접근성·서명 최종 release gate

이 단계는 첫 실제 Work 임계 경로를 닫은 뒤에만 수행합니다. 개인용 v1 최종 계약에서 삭제된 것이 아닙니다.

- clean Mac 또는 동등한 격리 환경에서 설치·첫 실행·Codex login
- 기존 설치 위 update와 rollback, 제거 뒤 사용자 데이터 처리 계약
- codesign·notarization·Gatekeeper·stapling의 실제 성공 증거
- keyboard-only 전체 핵심 흐름과 VoiceOver 실측
- 앱 교체·restart 뒤 Work·DB·credential reference 보존
- 공개 artifact hash·SBOM·security 결과와 같은 candidate 일치

## 11. 완료 정의(Definition of Done)

아래 항목이 모두 실제 증거로 충족되기 전에는 “AAA v1 완료” 또는 목표 `complete`를 선언하지 않습니다.

- [ ] 최신 번들의 command HTTP/UI 응답이 3초 이내이며 transaction warning 회귀 없음
- [ ] Codex 안전 fallback truth table 전체 통과
- [ ] 공식 Tauri login으로 현재 Codex 인증을 사용한 실제 attempt가 저장되고, 성공 또는 안전한 fallback 계보가 DB·UI에서 일치
- [ ] queued/running orphan execution 없음
- [ ] 전역 pending outbox가 idle에서 0 또는 명시적 degraded/poison 상태로 bounded 수렴하고 최신 command projection이 30초 안에 UI에 반영
- [ ] 실제 환불 Work가 자연어 요청 하나로 완료
- [ ] Runtime Agent의 실제 위임·답변이 협업방에 인과·실행 계보와 함께 기록
- [ ] 별도 capability-gap Work가 명시적 배치 지시 없이 동적 Agent를 제안·승인·참여시킴
- [ ] 동적 Agent·모델 계보·협업방·인계·Task가 실제 데이터로 연결
- [ ] `refund-delay-report.md`의 계산과 rollback이 원본과 일치
- [ ] ArtifactVersion·Assurance·Records 완료
- [ ] 재시작 후 전체 상태 보존
- [ ] 지식 K01–K04와 관계 graph·citation·memory 적용/해제의 실제 workspace UAT 통과
- [ ] Growth 근거·평가·review/auto 채택·후속 효과·revert 완주
- [ ] Provider 연결·공급 모델·enable/disable·unavailable·fallback 계약 완주
- [ ] 예산 한도·임계값·route_attempt 비용 계보·실제 hard limit 차단 완주
- [ ] Extension Capability가 실제 Agent Runtime Work에 기여하고 권한·제거 보존
- [ ] 조직 proposal 승인·거절·version·revert와 홈·업무·수신함 단일 상태 원천 일치
- [ ] en/ko 시스템 기본·설정 전환·재시작 보존·동적 문구 일관성
- [ ] 15분 빠른 gate와 더 긴 bounded soak 모두에서 비정상 slope·peak 없음, 원시 sample evidence 보존
- [ ] 정상 종료 시 app/bridge/server와 Surreal 재사용·종료 수명주기 계약 통과
- [ ] bounded negative scenario matrix 전체 통과
- [ ] 실제 Tauri 화면이 fixture에 준하는 풍부함·일관성·접근성 확보
- [ ] clean install·update·rollback·remove와 데이터 보존 계약 통과
- [ ] VoiceOver와 keyboard-only 핵심 흐름 실측 통과
- [ ] codesign·notarization·Gatekeeper·stapling이 동일 release candidate에서 통과
- [ ] root 직렬 전체 build/test/lint/security 통과
- [ ] 모든 원자 변경이 영어 Conventional Commit으로 커밋·푸시됨
- [ ] tag 없음

## 12. 실패하거나 오해하기 쉬운 접근

- fixture의 풍부한 activity를 실제 room message로 재포장해 성공처럼 보이게 하지 마세요.
- 모델 이름을 representative 결과 하나로 덮어 실제 planning attempt를 숨기지 마세요.
- fallback을 만들기 위해 router의 side-effect 보안 gate를 완화하지 마세요.
- 429 하나만 고치고 5xx·stream·schema·tool side-effect 형제를 다음 검수로 미루지 마세요.
- 저장된 데이터가 없는 출시 판단·워크숍 문서를 모델에게 작성시키고 UAT 성공으로 계산하지 마세요.
- 프롬프트에 `계획·실행·검증·기록을 완료하세요`, `동적 Agent를 배치하세요` 같은 내부 동작을 직접 지시하지 마세요.
- 백엔드 변경마다 시각 검수나 전체 build를 반복하지 마세요.
- 여러 에이전트가 공유 `dist`를 동시에 빌드하지 마세요.
- 앱 종료 후 orphan DB를 원인 확인 없이 kill/delete하지 마세요.
- 전체 목표를 일부 package test 통과만으로 완료 처리하지 마세요.

## 13. 핵심 코드·문서 지도

| 영역 | 위치 |
|---|---|
| Application command/projector 경계 | `packages/application/src/product.ts` 및 인접 테스트 |
| 실제 협업 pipeline | `packages/application/src/core-pipeline.ts` |
| Agent 협업 runtime GAP 계약 | `docs/phases/30-surface-parity-agent-ux/agent-collaboration-runtime-handoff.md` |
| Surreal transaction | storage package의 Massion database 구현 및 transaction 테스트 |
| Codex adapter | `apps/server/src/codex-app-server-agent.ts` |
| Codex adapter 테스트 | `apps/server/src/codex-app-server-agent.test.ts` |
| 모델 runner | `packages/runtime/src/voltagent-runner.ts` |
| runner 테스트 | `packages/runtime/src/voltagent-runner.test.ts` |
| router 보안 gate | `packages/router/src/model-router.ts` |
| Hugging Face Provider | `apps/server/src/deepseek-community-provider.ts` |
| Desktop product projection/copy | `apps/desktop/src/desktop-service.ts` |
| Desktop UI | `apps/desktop/src/app.tsx` |
| 현재 phase 문서 | `docs/phases/30-surface-parity-agent-ux/` |
| 실제 시험 프로젝트 | `/tmp/massion-refund-project-20260804` |
| Tauri bundle | `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app` |

라인 번호는 후속 수정으로 바뀔 수 있으므로 함수·테스트 이름과 `rg`로 다시 찾으세요.

## 14. 다음 에이전트에게 전달할 시작 지시문

아래 문구를 그대로 전달해도 됩니다.

```text
이 저장소의 docs/phases/30-surface-parity-agent-ux/aaa-v1-continuation-handoff-2026-08-05.md를 정본 인계서로 읽고 Massion AgentOS AAA v1 목표를 재개하세요. root task의 goal은 완료가 아니라 paused 상태이며 새 task에서 goal이 null이면 이 문서 15절의 objective로 새 goal을 생성하세요. 질문하지 말고 먼저 Git·runtime 기준선을 검증하세요. 단계 1과 단계 2의 어댑터·runner 몫은 2026-08-09에 닫혔으므로(§4.0), 남은 것은 fallback 체인 실행 증거와 queued orphan 보상입니다. 앱을 한 번 실행해 프로바이더 화면을 직접 본 뒤 시작하세요 — 코드만 읽고 판단하면 실행 화면에만 보이는 결함을 놓칩니다. 그 결과가 통과하면 새 범위를 열지 말고 Codex fallback·queued orphan·실제 모델 계보 묶음과 Runtime Agent 협업방 배선 묶음을 각각 RED→최소 구현→표적 테스트·포맷→통합 독립 검수→일괄 수정→최종 재검수→영어 Conventional Commit·push 순으로 닫으세요. build는 root 단일 직렬 큐에서만 실행하고 TUI·레거시 Web·비차단 미관 작업은 제외하세요. 이후 /tmp/massion-refund-project-20260804의 자연스러운 요청으로 Task·Artifact·Assurance·Records 완주를 검증하고, 별도 실제 파일 프로젝트에서 조직 capability gap을 먼저 증명한 뒤 명시적 배치 지시 없이 동적 Agent의 제안·승인·협업 참여·기여 계보를 검증하세요. 이것은 첫 임계 이정표일 뿐 전체 완료가 아닙니다. 이후 단계 9의 지식·조직·Growth·확장·Provider·예산·설정 계약, 단계 10의 negative matrix, 단계 13의 설치·VoiceOver·서명 gate까지 실제 증거로 닫으세요. fixture는 기대 품질 기준이지 실제 증거가 아닙니다. 전체 완료 전 goal을 complete로 바꾸지 마세요.
```

## 15. 인계 시점의 목표 상태

현재 root task의 goal 도구에는 목표가 저장되어 있고 상태 값은 `paused`입니다. goal은 task/thread별이므로 인계받은 새 task에서는 `null`일 수 있습니다. 그 경우 아래 objective로 새 goal을 만들고 진행합니다.

```text
Massion AgentOS를 실제 사용 가능한 AAA급 개인용 macOS v1로 완성한다. i18n 전체 제품 배선, 40GB급 메모리 증가 원인과 수정, 실제 Codex 기반 Work의 동적 Agent/모델 할당·협업방·인계·Task·Artifact·Assurance·Records 완주, Knowledge·Growth·Extension·Provider·Budget·Settings의 실제 제품 계약, 재시작 보존, Tauri 시각·접근성·설치 UAT, 직렬 전체 build/security와 서명 release gate를 실제 근거로 통과시키고, 검증된 원자 변경마다 영어 Conventional Commit으로 커밋·푸시한다. TUI·레거시 Web·비차단 미관 확장은 임계 경로에서 제외하며 fixture 풍부함은 기대 기능 계약으로 사용하되 실제 제품 증거와 구분한다.
```

제품 완료 조건이 충족된 것이 아닙니다. 이 인계서는 작업을 종료하는 문서가 아니라 같은 목표를 다른 에이전트가 손실 없이 이어받기 위한 checkpoint입니다.

## 16. Active development commit ledger

2026-08-09 세션이 `92ed55d5d` 위에 23개 commit을 더했습니다. 시간순 목록은 §4.0에 있고, 재현은 다음과 같습니다.

```bash
git log --reverse --format='%h|%s' 92ed55d5d..1bfae9fd6
```

이어서 2026-08-09~10 세션이 8개를 더했습니다(§21). 전부 `apps/desktop` 범위이며 도메인 패키지는
건드리지 않았습니다.

```text
eea3b32d1|2026-08-09|feat(organization): open staffing commands on the typed contract
1acef0303|2026-08-09|feat(router): let the budget surface set a limit that actually blocks
4ec0a0159|2026-08-09|fix(desktop): remove the duplicate message catalog key
a7ed78993|2026-08-09|docs(handoff): record the surface contracts and the traps this session hit
27522ea2b|2026-08-09|fix(desktop): size the budget input and carry builtin to the surface
343262afc|2026-08-09|feat(desktop): 조직 화면에서 팀을 편성하고, 화면이 거절 사유를 그대로 세운다
3e69a6650|2026-08-09|fix(desktop): 화면 문구를 한국어답게 고치고 영어로 새던 곳을 막는다
c6197be19|2026-08-10|test(desktop): 죽은 className과 무장된 폴러를 기계로 막는다
```

```bash
git log --reverse --format='%h|%ad|%s' --date=short 1bfae9fd6..c6197be19
```

아래는 그 이전, 현재 `main`과의 merge-base `4ae8650deec7f1668b09997d257b6f6f26ec7f79` 이후 `92ed55d5d`까지 feature branch의 147개 commit 전체입니다. 날짜는 author date의 일자이며, 순서는 ancestry의 오래된 것부터입니다. amend/rebase 전 SHA가 아니라 현재 공개 feature history의 SHA를 사용합니다.

```text
5a5ade5a6|2026-07-30|fix(application): restore strict type boundaries for the full build
c9406ab61|2026-07-30|fix(server): restore bootstrap file metadata types
a084c4060|2026-07-30|fix(server): pass startup recovery and bootstrap lint gates
06cfb8553|2026-07-30|fix(application): pass lint gates for core execution paths
2877c118c|2026-07-30|fix(desktop): pass lint gates for UI execution paths
320109b85|2026-07-30|fix(recovery): enforce atomic delivery lease ownership
9440f21a9|2026-07-30|fix(recovery): satisfy strict ownership types
86f59444f|2026-07-30|fix(desktop): omit absent growth adoption data
a3294d6ec|2026-07-30|test(runtime): align connector fixtures with trust lineage
2eb67c934|2026-07-30|test(engineering): enforce explicit lease release before handoff
8e898ec58|2026-07-30|test(runtime): wait for provider start before shutdown settlement
3f91a59f6|2026-07-30|test(application): align cancellation coverage with atomic convergence
76eb63dc2|2026-07-30|fix(runtime): trust managed Codex workspaces
b924a521b|2026-07-30|fix(local): replace Surreal runtime atomically
fa5a0465c|2026-07-30|fix(strategy): emit valid Codex output schema
f72820d98|2026-07-30|fix(runtime): avoid Codex schema turn stalls
bd09f52cf|2026-07-30|fix(application): normalize Surreal attempt timestamps
a5dfa152e|2026-07-30|fix(desktop): reconcile work details with filters
51226e096|2026-07-30|fix(desktop): show finalized work records
646f17191|2026-07-30|fix(desktop): humanize live Work evidence
d748101a7|2026-07-30|fix(desktop): report subscription authentication
0bf28ee95|2026-07-30|fix(desktop): persist self-improvement settings
439bc3617|2026-07-30|fix(server): retain startup recovery telemetry
956af2af2|2026-07-30|fix(desktop): humanize Work record references
c9b5fb87f|2026-07-30|feat(desktop): connect Codex account login
0d2dda0d3|2026-07-30|test(server): align shutdown telemetry contract
d7a375406|2026-07-30|fix(server): honor repeated shutdown signals
c1f74226f|2026-07-30|fix(runtime): expose deterministic result recovery contract
3e2539704|2026-07-30|fix(core): harden runtime boundary validation
b9ef0cb9f|2026-07-30|style(code): apply pending formatting
d0c45a182|2026-07-31|fix(desktop): recover expired local access
40619ceed|2026-07-31|fix(runtime): isolate work-scoped agents
159e5c02a|2026-07-31|fix(desktop): restore live Work conversations
c49d133e9|2026-07-31|fix(application): persist Work collaboration lineage
586bb28ad|2026-07-31|feat(organization): promote Work-scoped agents
64c153729|2026-07-31|fix(application): honor dynamic task assignments
9225823de|2026-07-31|fix(strategy): enforce atomic staffing boundaries
001a73f0a|2026-07-31|fix(runtime): preserve retryable failure lineage
205bb8ee4|2026-07-31|feat(application): activate atomic dynamic staffing
d0a80e6ce|2026-07-31|test(context-strategy): restore runtime lineage fixture
85d233759|2026-07-31|test(evidence): stabilize workspace knowledge integration
e48d86dce|2026-07-31|fix(application): resume governed organization changes
71acbe255|2026-07-31|test(server): stabilize integration timing gates
8dfe7f197|2026-07-31|test(cli): bound child process integration
9aaa49795|2026-07-31|test(security): isolate filesystem access logging
d857e4c14|2026-07-31|fix(application): align agents with automatic Work projection
111271a5e|2026-07-31|fix(desktop): align actual Work collaboration with fixture
f32e36944|2026-07-31|fix(desktop): polish completed Work presentation
33547e292|2026-07-31|fix(work): restore autonomous collaboration flow
200da18b1|2026-07-31|fix(work): preserve collaboration migration upgrades
ce5f9ca7b|2026-07-31|fix(application): preserve context across Work tasks
e1ed5168e|2026-07-31|fix(assurance): enforce semantic Work verification
ef6b1db1f|2026-07-31|fix(strategy): preserve specialist staffing requirements
dd801b906|2026-07-31|test(application): compile Delivery recovery fixtures
c5ed778b7|2026-07-31|fix(strategy): enforce critical risk output contracts
25969d136|2026-07-31|fix(desktop): recover bundled frontend navigation
4b531a245|2026-07-31|fix(desktop): navigate after WebView creation
5c4eaf6f4|2026-07-31|fix(application): project governed approval semantics
ef155513b|2026-07-31|fix(application): preserve Work lineage in run events
e9b5a7924|2026-07-31|fix(desktop): restore natural Work conversation flow
3301503ed|2026-07-31|fix(application): satisfy release lint contracts
28f17a451|2026-07-31|fix(application): type recovery material safely
05dbc8d82|2026-07-31|test(strategy): align staffing fixtures with capability contracts
f1661d539|2026-07-31|feat(desktop): render agent conversations as Markdown
286fd7690|2026-07-31|fix(core): preserve software delivery provenance
600889dd4|2026-07-31|fix(application): stabilize startup recovery timestamps
482e90af1|2026-07-31|fix(desktop): preserve meaningful Work activities
5039d7820|2026-07-31|fix(desktop): pass explicit Markdown emphasis state
a36b2dd2e|2026-07-31|fix(desktop): hide provider terminology from Work errors
0fd07fcde|2026-07-31|fix(desktop): keep Markdown tables readable
e6cdfeccd|2026-07-31|fix(server): recover connectors across runtime releases
d668c6d26|2026-07-31|fix(desktop): render fallback agent messages as Markdown
2f3250336|2026-07-31|feat(desktop): typeset agent math safely
48e921cc6|2026-07-31|fix(desktop): preserve emphasis before word suffixes
6967849b7|2026-07-31|fix(work): preserve Markdown-safe final results
8b6072840|2026-07-31|fix(desktop): repair incomplete agent emphasis
2c6ea17f9|2026-08-01|fix(runtime): preserve agent timeout lineage
d03af4484|2026-08-01|fix(application): schedule blocked retries asynchronously
1c5341be1|2026-08-01|fix(application): recover approval continuations safely
e93bbe610|2026-08-01|fix(application): prevent unverifiable task completion claims
8cc9d5dc7|2026-08-01|fix(work): surface bounded assurance rejection details
4f6b03f73|2026-08-01|fix(application): validate blocked details without control regex
2da934af5|2026-08-01|fix(application): align run scheduling with async boundaries
afd60edd6|2026-08-01|fix(desktop): reconcile live work projections
05c07df14|2026-08-01|fix(organization): retire terminal work agents
043b1ba65|2026-08-01|test(application): respect package boundaries in lifecycle coverage
e0388c935|2026-08-01|test(desktop): preserve concrete run fixture typing
0a0f41158|2026-08-02|test(server): align staffing lifecycle product contract
56cf176ec|2026-08-02|fix(collaboration): preserve participant identities across projections
41fcedbee|2026-08-02|fix(desktop): reconcile newly created works
16c801469|2026-08-02|fix(desktop): bind created works from durable lineage
3da62b5db|2026-08-02|fix(application): preserve durable event lineage
7a68eef6e|2026-08-02|refactor!: remove legacy web and tui surfaces
21c8d7fb5|2026-08-02|fix(desktop): wire durable work controls
d05ab4cd8|2026-08-02|fix(desktop): satisfy strict release types
90f7caa87|2026-08-02|fix(application): deliver queued work directives
d29c2e2bd|2026-08-02|test(application): satisfy strict directive types
a363fa651|2026-08-02|docs(agent): document explicit intervention contract
bede6e87d|2026-08-02|fix(runtime): bind trusted workspaces to task execution
067bb4a7f|2026-08-02|chore(git): exclude Superpowers documents from tracking
eb91c26d4|2026-08-02|fix(evidence): resolve exact workspace paths from requests
bcb9edc08|2026-08-02|feat(runtime): preserve provider execution evidence
6bbd542e0|2026-08-02|fix(evidence): narrow path token character access
fcb506254|2026-08-02|fix(runtime): validate evidence byte count types
62efb5fed|2026-08-02|test(application): cover delivery crash recovery
699cc477b|2026-08-02|docs(release): replace removed contract references
1c6f3d22d|2026-08-02|fix(application): route directives by executor capability
7490c7231|2026-08-02|fix(desktop): clarify directive update timing
5f5227949|2026-08-02|test(server): bind fallback fixture workspace access
4498c6907|2026-08-02|fix(application): include code change assurance evidence
b8ab09889|2026-08-02|fix(server): contain Codex spawn failures
a5b5c186d|2026-08-02|fix(desktop): expose official Codex onboarding
7ddcef9ba|2026-08-02|fix(runtime): require executable workspace delivery
ac4154dbd|2026-08-02|fix(runtime): preserve bounded failure semantics
4567c0894|2026-08-02|fix(server): preserve remote workspace execution context
944565c4d|2026-08-02|fix(application): bound workspace knowledge intake
7713219bb|2026-08-02|fix(runtime): authorize external Codex workspaces
ac29f2898|2026-08-02|fix(application): require workspace change evidence
7dac42911|2026-08-02|fix(application): inherit dependency change evidence
0b9c56999|2026-08-02|fix(application): accept fenced assurance decisions
0deca9851|2026-08-02|fix(application): preserve assurance evidence across work retries
523c4857b|2026-08-02|fix(application): refresh stale automatic assurance bindings
2b9da9dfd|2026-08-02|fix(assurance): unify verifier decision parsing
30545f7cd|2026-08-02|feat(router): connect verified DeepSeek community model
787a344fc|2026-08-03|test(assurance): align work gate runtime envelope
115cfa008|2026-08-03|fix(router): tolerate DeepSeek community cold starts
43aa0fb95|2026-08-03|fix(desktop): allow long-running application commands
a71fd284a|2026-08-03|fix(optimization): bound and classify model evaluations
0ab7d1273|2026-08-03|fix(optimization): govern recommendation approval
bada3f015|2026-08-03|fix(governance): upgrade managed default policies
abb01d3cf|2026-08-03|fix(evidence): preserve workspace knowledge execution
a5fe245e1|2026-08-03|fix(assurance): preserve execution evidence chronology
4cd9da547|2026-08-03|fix(assurance): narrow validated artifact timestamps
01c0b2cba|2026-08-03|fix(assurance): finish persisted verifier streams
2bbf57839|2026-08-03|fix(assurance): reuse persisted recovery snapshots
29d5bef35|2026-08-03|fix(storage): bound failed transaction rollback
b2ac33644|2026-08-03|feat(i18n): add English and Korean locale foundations
2b45860e5|2026-08-04|fix(i18n): localize dynamic desktop content
d3e38c4c7|2026-08-04|fix(runtime): bound local SurrealDB memory
be31ca517|2026-08-04|fix(quality): clear release lint blockers
1c0cebff0|2026-08-04|test(desktop): align graph accessibility assertions
5996ac182|2026-08-04|fix(security): patch vulnerable transitive dependencies
ed63a141a|2026-08-04|fix(server): decouple startup from quota polling
11ec0954a|2026-08-04|fix(server): keep startup available during work recovery
bde95f8b1|2026-08-04|fix(storage): avoid transaction session teardown stalls
f8ce0368d|2026-08-04|fix(application): return commands before event projection
92ed55d5d|2026-08-05|docs(handoff): capture AAA v1 continuation state
```

## 18. 환경 함정 (코드 아님, 2026-08-09 관측)

### 18.1 끊어진 pnpm store 심볼릭 링크

```
/Volumes/Crucial P3 PLUS/.pnpm-store → /private/tmp/massion-pnpm-store-current (없음)
```

7월 16일에 만들어진 링크의 대상이 `/tmp`에 있어 사라졌고, pnpm이 그 자리에 디렉터리를 만들려다 `ENOTDIR`로 죽어 **`tauri:build`가 두 번 실패**했습니다. 새 의존성을 추가하면서 처음 그 경로를 타게 돼 드러났습니다. 링크를 삭제해(사용자 승인) 기본 store(`~/Library/pnpm/store/v11`)를 쓰게 했습니다. **다시 나타나면 같은 곳을 보십시오.**

### 18.2 dev server의 CSS가 불완전

`vite dev`(5173)의 스타일시트에 **`.w-full` 규칙 자체가 없었습니다**(449 규칙 vs 프로덕션 1339). `app.tsx`에 36회 쓰이므로 소스에서 빠질 수 없습니다. 그래서 dev에서 잰 다이얼로그 폭·radius·색은 근거가 되지 못합니다. **시각 확인은 프로덕션 빌드(`vite build` → `vite preview`)에서만** 하십시오.

### 18.3 renderer는 바이너리에 압축 임베드

`strings massion-desktop | grep …`로는 renderer 문자열이 하나도 안 잡힙니다(기존 문구도 0건). 번들 반영 확인은 `apps/desktop/dist/assets/*.js`를 보십시오.

### 18.4 화면 캡처

`screencapture`는 화면 기록 권한이 필요하고, `-R`은 물리 픽셀이 아니라 **논리 좌표**를 씁니다. 창 크기 조정(`System Events`)에는 별도 접근성 권한이 필요합니다.

## 19. 미해결로 남긴 결함

### 19.1 idle에서 outbox가 수렴하지 않음

pending **27,032건**(2026-08-09 관측, §0.I.1 기준 6,076건에서 증가). `packages/application/src/product.ts`의 `scheduleProjection`이 **command dispatch와 run schedule에서만** 호출되고 한 호출당 `projectPending(ctx, 1_000)` 상한이 걸려 있어, idle에는 호출자가 없습니다. 40초 관측에서 0건 감소. DoD의 "idle에서 bounded 수렴" 미충족이며, 비우려면 command를 28번 날려야 합니다.

### 19.2 트랜잭션 유실의 근본 원인

`bf7e855d8`이 재시도로 증상을 막았지만 **왜 WebSocket transactions map이 비는지는 모릅니다.** 연결 재수립인지, 동시 트랜잭션 경합인지, 서버 타임아웃인지 미규명. §0.I.1의 transaction warning 누적과 같은 뿌리로 추정합니다.

### 19.3 OpenRouter가 route 후보가 아님

provider·endpoint·키(`기본 키`, api_key, active, v1)까지 등록됐으나 **model profile과 route candidate가 없습니다.** `router.model.register` + `router.candidate.add`로 `nvidia/nemotron-3-ultra-550b-a55b:free`를 5개 route에 GLM 다음 우선순위로 넣어야 합니다. **UI에 model/candidate 등록 경로가 없어** command로 해야 합니다.

### 19.4 room.tsx의 미등록 translate 문구 20건 — 2026-08-10 해소

**해소됐습니다(`3e69a6650`). 아래는 당시 판단의 기록이며 현재 상태가 아닙니다.**

당시 기록: `styles.test.ts`의 translate 가드를 파일 전체로 켜면 즉시 걸립니다. 일부는 문장 조각을 이어붙이는 구조라 등록만으로 안 풀립니다(조사·어순). 가드 범위를 프로바이더 표면으로 한정하고 사유를 주석에 남겼습니다 — **첫날부터 실패하는 가드는 꺼지기 때문입니다.**

무엇이 틀렸었나: "20건"은 과소 추정이었습니다. 실제로는 **약 45건**이었고 `room.tsx`에만 있지도 않았습니다(§21.2). 소스 정규식으로 세었기 때문입니다 — 누수의 다수는 라벨을 데이터 배열에 담고 `{cell.label}`로 그리는 형태라 소스에는 잡히지 않습니다. 조사·어순 문제라던 것도 실제로는 이름 뒤에 조사를 붙여 문장을 잇던 소수였고, 이름을 문장에서 떼면 풀렸습니다.

### 19.5 종료가 25~30초 걸리고 실패로 끝남

`server.shutdown.started` 후 30초 뒤 `server.shutdown.failed`. 앱 교체마다 재현됐습니다. §단계 8의 종료 수명주기 계약 항목입니다.

### 19.6 검수가 남긴 미관 항목

반그리드 간격, `--danger`=`--halt` 오버로드, 임의 px 30건. 값은 전부 스케일 위라 화면에는 보이지 않고 유지보수성 항목입니다.

## 20. 신설한 가드 (`apps/desktop/src/styles.test.ts`)

기존 가드가 2026-08-09의 결함을 하나도 못 잡았습니다. 스캔 대상에 `components/ui/`가 없었고, 최종 단언이 접두사 화이트리스트로 걸러졌는데 **`warning`이 그 목록에 없었습니다.**

| 가드 | 무엇을 막는가 |
|---|---|
| 색 유틸리티 전수 | 정의되지 않은 토큰. 접두사 필터 삭제, 색이 아닌 유틸리티는 `nonColor` 정규식으로 제외 |
| translate 키 존재 | `translate("…")` 인자가 카탈로그에 없는 경우 |
| 한글 리터럴 감쌈 | 부류 전체 — 한글 리터럴이 `translate()` 밖에 있는가. 괄호 깊이를 걸어 삼항 전체 감싸기를 인정하고, 상태 경유·상수 정의 두 간접 경로를 인식 |

**셋 다 결함을 일부러 재주입해 실패하는 것까지 확인했습니다.** "테스트를 추가했다"와 "테스트가 잡는다"는 다른 주장입니다.

## 21. 2026-08-09~10 세션: 표면 계약 개방과 화면 문구 정리

### 21.0 이 세션이 무엇이었나

앞 세션까지는 "계약은 있는데 화면이 부르지 않는다"가 주된 결함이었습니다. 이 세션은 그 남은 것을 열고(§21.1), 그다음 **실제 화면을 한국어와 영어로 각각 켜고 아홉 표면을 전부 돌면서** 눈으로 결함을 찾았습니다(§21.2~21.4).

핵심 교훈 하나를 먼저 적습니다. **화면 결함은 소스를 읽어서는 안 나옵니다.** 이 세션이 찾은 것 중 소스 grep으로 잡힌 것은 절반이 안 됩니다. 나머지는 앱을 띄우고, 언어를 바꾸고, DOM을 훑어야만 드러났습니다. 코드를 다 읽었으니 화면도 안다는 가정이 이 프로젝트에서 반복적으로 틀렸습니다.

commit: `eea3b32d1` `1acef0303` `4ec0a0159` `a7ed78993` `27522ea2b` `343262afc` `3e69a6650` `c6197be19`

### 21.1 계약을 열고 화면에 연결한 것

| 무엇 | 상태 |
|---|---|
| `organization.command` | 타입 계약에 개방. 조직 상세에 편성 폼 신설 |
| `router.route.budget.set` | 신설. 예산 표면에서 경로 한도를 실제로 저장하고 막음 |
| `growth.revert` | 개방. 개선 채택 되돌리기 경로 |
| Extension capability/permission | `ExtensionCapabilityViewV1` + `contributions`/`permissions` |
| `OrganizationNodeViewV1.builtin` | Core Office 여덟을 화면이 구별 |

**편성 폼의 설계 판단(그대로 유지하십시오).** Core Office 여덟은 도메인이 변경을 거부하므로 그 노드에서는 상태 조작 버튼을 **아예 내놓지 않습니다.** 눌러 보고 오류로 아는 것과 처음부터 없는 것은 다릅니다. 분리·병합·되돌리기는 계약에 있지만 화면에 두지 않았습니다 — 참조 처리 계획(`referencePlan`)을 사람이 손으로 짜야 하는데 그 입력을 화면이 아직 그리지 못합니다. **없는 것을 있는 척하지 않습니다.**

### 21.2 화면 문구: 두 갈래의 결함

**(가) 용어가 번역투이고 흩어져 있었다.** 사용자가 직접 지적했습니다.

| 지금까지 | 바꾼 것 | 왜 |
|---|---|---|
| `신뢰됨 (trusted)` · `신뢰 대기 (pending)` · `차단됨 (blocked)` | `신뢰함` · `확인 전` · `차단됨` | 괄호에 영어 슬러그를 달아 내보내면 안 됩니다(도메인 식별자는 툴팁으로) |
| `신뢰 회수` · `회수하고 차단` | `신뢰 해제` | revoke trust의 직역. 회수는 물건에 쓰는 말이고 이 앱은 이미 `연결 해제`를 씁니다 |
| `신뢰`(버튼) · `폴더 신뢰`(다른 화면) | `신뢰하기` | 같은 동작을 두 이름으로 부르고 있었습니다 |
| `{이름}` + `의 신뢰를 회수하면…` | 이름을 문장에서 분리 | 조사는 한국어에만 있어 이어 붙이면 다른 언어에서 어순이 깨집니다 |
| `작업공간` ↔ `워크스페이스` | `워크스페이스` | 같은 개념을 설정과 지식이 다르게 불렀습니다 |
| `프로바이더 표면` | `프로바이더` | `표면`은 내부 용어(surface)의 직역 |

**중요:** 긴 문장은 손대지 마십시오. "아직 이 방에서 오간 말이 없습니다", "사람이 결정하거나 풀어줄 때까지 여기에 남습니다", "위에 한 줄을 쓰면 시작합니다" — 잘 쓰인 한국어입니다. 무너져 있던 것은 **짧은 라벨**뿐이었습니다.

**(나) `translate()` 호출 누락 약 45건.** 번역문은 대부분 이미 카탈로그에 있었습니다 — **없어서가 아니라 부르지 않아서** 샜습니다. 세 형태입니다.

1. 삼항 연산자 — `{x ? "한글" : "한글"}`. 17건.
2. **데이터 구조에 담긴 라벨** — `{ label: "토큰", value }`를 `{cell.label}`로 그리는 형태. 예산 요약, 방 한도, 확장 상태, 개선 상태, 지식 지도 종류, 실행 단계. **소스 정규식으로는 안 잡힙니다.**
3. 달력 축이 `["월","수","금"]` 한글 배열로 고정. 사전이 아니라 `Intl.DateTimeFormat`이 답할 일이라 형식기로 교체(`formatLocalizedWeekday`/`formatLocalizedMonth`).

**검출 방법(다음에도 이렇게 하십시오).** `localStorage.setItem('massion.language.v1','en')` → 새로고침 → 아홉 표면을 순회하며 `TreeWalker`로 텍스트 노드와 `aria-label`/`placeholder`에서 한글을 수집. fixture 데이터(Work 제목·방 발언·파일명)는 번역 대상이 아니므로 제외 목록으로 거릅니다. **마를 때까지 반복합니다** — 한 번 훑고 끝나지 않습니다. 실제로 20건 → 8건 → 1건 → 0건으로 줄었습니다. 지식 표면은 첫 순회에서 비어 보였는데 **캔버스 첫 페인트 전이었을 뿐**이므로, 비어 보이면 다시 찍으십시오.

### 21.3 화면을 보고 찾은 결함 여섯

| # | 결함 | 원인 |
|---|---|---|
| 1 | 홈은 "지금 도는 것 0 / 진행 중인 업무가 없습니다"인데 업무 목록은 같은 Work 둘을 "진행 중"이라고 셈 | fixture의 `churn-q3`·`weekly-ops`에 `run` 레코드가 없었음. 계획이 돌고 Agent가 붙어 있는데 실행이 없다고 해 둔 자기모순이라, **실행 상태 줄이 한 번도 그려지지 않았음** |
| 2 | `검증 기준 1/1`이 거짓말 | 머리글은 기준을 말하는데 숫자는 판정을 셈. 아래 기준 넷 중 하나가 차단인데 전부 통과로 읽힘. 제외 기준을 분모에서 빼고 통과 수를 세도록 교체(`2/3`, 미충족이면 halt 색) |
| 3 | `기억 내용` 입력칸이 안 보임 | `Textarea` base가 `border-0 bg-transparent`. 상자 없이 그대로 씀 |
| 4 | **`업무 요청` 입력칸이 안 보임** | 같은 원인. 작성자가 `border border-control`을 줬지만 `cn()`이 tailwind-merge가 아니라 조용히 버림(§21.5) |
| 5 | 사이드바 hover와 선택이 픽셀 동일 | 둘 다 `--bg-3`/`--fg`. 포인터는 누르고 나면 늘 레일 위에 남으므로 레일이 "어디에 있나"(DESIGN.md §4열 셸)에 답하지 못함 |
| 6 | 확장 설치가 성공을 지어냄 | fixture가 `{outcome:"succeeded"}`를 돌려주어 화면은 "설치를 요청했습니다"라는데 목록은 그대로. 조직 편성 fixture처럼 정직하게 거절하도록 통일 |

3·4는 **입력칸이 화면에서 사라지는** 결함입니다. 제품의 주 진입점(조직에 시킬 일을 적는 칸)이 여기 포함됐습니다.

### 21.4 UAT에서 정상 확인한 것 (다시 의심하지 마십시오)

지식 그래프(1,836 노드·2,771 연결까지 실제 렌더, 헤더 수치가 색인 전체가 아니라 그려진 수와 일치), 완료 Work의 입력·보내기 비활성, 차단 Work의 halt 카드와 해결 지점 이동, 확장 권한 상세가 비밀 **이름**만 노출(값 아님), 프로바이더의 정직한 빈 상태, 예산 집계와 경로 한도의 음수 거부, 권한 승격의 사전 확인 패널("책임은 사용자에게 있습니다"), 조직 지도↔구조 교차 선택, 임시 팀의 `비활성화` 노출과 Core Office의 비노출, 개선 제안 거절이 목록·헤더·수신함 배지까지 전파, 대기 지시 취소, 검색 빈 상태.

### 21.5 반복 금지: `cn()`은 tailwind-merge가 아니다

`apps/desktop/src/lib/utils.ts`의 `cn`은 **단순 이어붙이기**입니다. 컴포넌트 base의 `border-0 bg-transparent`는 `className`으로 덮이지 않고, 덮으려 한 클래스는 **조용히 사라집니다**(명시도가 같으면 스타일시트 방출 순서가 이깁니다).

이 세션 결함 여섯 중 **둘이 여기서 나왔습니다.** 주석은 `lib/utils.ts`에 있었지만 호출부에서 멀어 아무도 못 봤습니다.

**상자가 필요하면 감싸십시오.** 방 입력창이 이미 그렇게 합니다. `className`으로 base를 이기려 하지 마십시오. `c6197be19`의 가드가 이제 기계적으로 막습니다.

### 21.6 반복 금지: "재현 안 되면 flaky"는 두 번 다 틀렸다

게이트가 두 번 RED였고 두 번 다 로컬에서 재현되지 않았습니다. 두 번 다 **진짜 원인이 있었습니다.**

원인은 하나입니다. §21.3의 결함 1을 고치며 fixture에 `run: { status: "running" }`을 넣자, `use-desktop-controller.ts:470`의 **배경 조정 폴러가 무장했습니다** — 이 폴러는 `reconcilableRunStatus(work.run.status)`가 참일 때만 돕니다. 폴러 자체는 옳습니다(실행 중인 Work는 다시 읽어야 합니다). 문제는 시드 Work를 배경 소품으로만 쓰던 테스트들이 폴러가 없다고 전제하고 있었다는 것입니다.

- durable 갱신 테스트: `expect(loadWork).not.toHaveBeenCalled()` — 부하가 걸리면 폴링 주기가 단언 전에 지나감
- 생성 대기 테스트 3건: 100ms 디바운스 × 3패스 조정과 폴러가 경합

**부정 단언은 시점이 정의돼야 뜻이 있습니다.** 로컬 통과는 빨라서 폴러가 아직 안 돈 것뿐이었습니다.

재현 방법: `for i in $(seq 10); do (node -e 'const e=Date.now()+90000; while(Date.now()<e){Math.sqrt(Math.random())}' &); done` 로 CPU를 채운 뒤 테스트를 돌리십시오. 이 세션은 이 방법으로 수정 후 2회 재검증했습니다.

고친 방법: 시드 Work에서 `delete work.run`을 **명시적으로** 씁니다(12곳 + 2곳). spread에 기대 실행이 없기를 바라면 fixture가 바뀌는 순간 조용히 뒤집힙니다.

### 21.7 이 세션이 신설한 가드 넷

§20의 `styles.test.ts` 셋에 더해:

| 파일 | 가드 | 무엇을 막는가 |
|---|---|---|
| `i18n/coverage.test.ts` | 번역 존재 | `translate()`가 부르는 한글 키 341개가 영어 카탈로그에 있는가. `app.tsx`·`room.tsx`·`knowledge-graph.tsx` |
| `i18n/coverage.test.ts` | 삼항 누출 | `{x ? "한글" : "한글"}`이 `translate()` 밖에 있는가. 예외는 둘뿐 — 원장에 남는 결정 사유, 언어 이름 |
| `i18n/coverage.test.ts` | 레일 구분 | 선택 상태 클래스가 hover와 다른가 |
| `components/ui/class-override.test.ts` | 죽은 className | `<Input>`/`<Textarea>`에 base와 충돌하는 테두리·배경 클래스를 넘기는가 |

**넷 다 결함을 일부러 재주입해 실패하는 것까지 확인했습니다.** class-override 가드는 붙이자마자 방 입력창이 base와 똑같은 `border-0 bg-transparent`를 중복으로 넘기던 것을 잡았습니다.

가드가 못 잡는 것도 적어 둡니다. **`translate()` 호출 누락 중 데이터 구조 경유(§21.2 (나) 2번)는 정적으로 못 잡습니다.** 영어로 켜서 화면을 훑는 것이 유일한 검출 수단입니다.

### 21.8 이 세션 종료 시점의 게이트 상태

| 게이트 | 결과 |
|---|---|
| `pnpm verify` | 통과 (format·build·lint·typecheck·test·docs) |
| `pnpm verify:security` | 통과 — production/full 모두 moderate·high·critical 0 |
| `pnpm verify:architecture` | 통과 — 다이어그램 11개 |
| `pnpm verify:docs` | 통과 |
| `pnpm verify:release` | 통과 — 설치→실행→백업→제거에서 data 보존 확인 |
| 데스크톱 테스트 | 290개 통과. CPU 포화 상태에서 2회 재검증 |
| `pnpm tauri:build` | 통과 — `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app` |

**여전히 §1의 출시 증거는 없습니다.** 이 세션은 fixture 화면과 계약·문구를 다뤘습니다. 실제 데이터로 Work 한 건이 완주하는 증거는 §6과 §10이 남긴 그대로입니다.

### 21.9 다음 에이전트가 먼저 할 일

1. §1의 한 문장(실제 Work 완주 + 재시작 보존)이 최우선입니다. 화면 품질은 이 세션으로 충분히 올라갔습니다.
2. §19.1(outbox 27,032건), §19.2(트랜잭션 유실 근본 원인), §19.3(OpenRouter route 후보), §19.5(종료 30초 실패)는 그대로 열려 있습니다.
3. 화면을 건드릴 때는 **반드시 프로덕션 빌드로 띄워 눈으로 보십시오**(§18.2 — dev CSS는 불완전합니다). 그리고 **한국어와 영어 양쪽**을 보십시오.
4. 테스트가 부하에서만 깨지면 §21.6을 먼저 읽으십시오.

## 17. 실행 명령·DB 조회·보존 위치 Reference

명령은 다음 에이전트가 현재 source와 package script를 다시 확인한 뒤 실행합니다. secret 파일의 값은 출력하지 않습니다.

### 17.1 시작 기준선

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse '@{u}'
git rev-list --left-right --count main...HEAD
git tag --list
git ls-remote --tags origin
ps -axo pid,ppid,rss,etime,command \
  | rg 'Massion.app|massion-desktop|desktop-bridge|/massion-v1/runtime/surrealdb|server/dist/main.js' \
  | rg -v 'rg '
```

### 17.2 최신 bundle 실행과 readiness

```bash
open -n '/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled/apps/desktop/src-tauri/target/release/bundle/macos/Massion.app'
curl --fail --silent --show-error --max-time 30 \
  http://127.0.0.1:7331/health/ready
```

### 17.3 안전한 idempotent workspace command replay

```bash
set +x
TOKEN="$(<"$HOME/.config/massion-v1/access.token")"
{
  printf 'header = "authorization: Bearer %s"\n' "$TOKEN"
  printf 'header = "accept: application/json"\n'
  printf 'header = "content-type: application/json"\n'
  printf 'url = "http://127.0.0.1:7331/api/v1/commands"\n'
  printf 'data = "{\\"schemaVersion\\":\\"massion.application.v1\\",\\"commandId\\":\\"0c04deb0-3014-4dea-a4c5-9aba6459592c\\",\\"correlationId\\":\\"cdc7bdf4-b0f0-4d8b-9e90-50999679a763\\",\\"operation\\":\\"workspace.register\\",\\"payload\\":{\\"path\\":\\"/private/tmp/massion-refund-project-20260804\\"}}"\n'
} | /usr/bin/time -p curl --config - \
  --fail --silent --show-error --max-time 3
unset TOKEN
```

Authorization 값은 curl argv에 넣지 않습니다. 위 stdin config를 사용하거나 제품의 `ApplicationHttpClient` 기반 작은 harness를 재사용합니다. shell tracing이 켜진 terminal에서는 실행하지 않습니다.

합격 기준:

- 3초 이내 JSON response
- operation·outcome·data가 기존 idempotent command와 일치
- UI spinner 종료
- DB command final
- transaction warning 증가 0

warning 기준값:

```bash
rg -c 'Transaction .* not found in WebSocket transactions map' \
  "$HOME/.local/state/massion-v1/surrealdb.log"
```

### 17.4 SurrealDB read-only 계보 확인

```bash
SURREAL_PASS="$(<"$HOME/.config/massion-v1/database-password")"
SURREAL_BIN="$HOME/.local/share/massion-v1/runtime/surrealdb/3.2.1/darwin-arm64/surreal"

SURREAL_PASS="$SURREAL_PASS" "$SURREAL_BIN" sql \
  --endpoint ws://127.0.0.1:7330 \
  --username massion \
  --auth-level root \
  --namespace massion \
  --database massion \
  --json --hide-welcome
unset SURREAL_PASS
```

REPL에서 현재 저장된 환불 Work 계보를 확인합니다.

```sql
SELECT command_id, operation, state, result_json != NONE AS has_result, updated_at
FROM application_command
WHERE command_id = '0c04deb0-3014-4dea-a4c5-9aba6459592c';

SELECT work_id, status, revision, artifact_version_ids
FROM work
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7';

SELECT run_id, work_id, status, stage, retry_attempt_id
FROM application_run
WHERE run_id = 'f904035a-8764-41d6-b7be-198f087fcf1a';

SELECT execution_id, task_id, agent_handle, model_route, status,
       created_at, started_at, ended_at
FROM runtime_execution
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7'
ORDER BY created_at ASC;

SELECT execution_id, work_id, task_id, agent_handle, model_route, status, created_at
FROM runtime_execution
WHERE status IN ['queued', 'running']
ORDER BY created_at ASC;

SELECT attempt_id, execution_id, model_profile_id, status, selection_sequence,
       fallback_from_attempt_id, failure_class, emitted_tokens,
       side_effects_started, fallback_allowed, created_at
FROM route_attempt
WHERE execution_id IN (
  SELECT VALUE execution_id FROM runtime_execution
  WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7'
)
ORDER BY created_at ASC;

SELECT message_id, sequence, message_type, author_kind, author_id,
       reply_to_message_id, caused_by_message_id, task_id,
       execution_id, artifact_version_id, created_at
FROM collaboration_message
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7'
ORDER BY sequence ASC;

SELECT state, count() AS count
FROM application_outbox
GROUP BY state;

SELECT outbox_id, source_kind, source_id, correlation_id,
       state, public_event_id, occurred_at, updated_at
FROM application_outbox
WHERE state = 'pending'
ORDER BY occurred_at ASC, outbox_id ASC
LIMIT 20;

SELECT task_id, status, recommended_agent_handles
FROM work_task
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7';

SELECT artifact_version_id, artifact_id, checksum, creator_agent_handle,
       creator_execution_id, created_at
FROM artifact_version
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7';

SELECT assurance_run_id, status, verifier_handle, verifier_execution_id, completed_at
FROM assurance_run
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7';

SELECT records_run_id, status, completed_at
FROM records_run
WHERE work_id = '88aab4fe-f02b-42e4-b2d6-2327e5d43cf7';
```

테이블·필드가 migration으로 달라졌다면 `INFO FOR DB`와 current repository query를 먼저 확인하고 read-only query를 맞춥니다. 확인 없이 write query를 실행하지 않습니다.

### 17.5 fallback 묶음 표적 검증

```bash
pnpm --filter @massion/server exec vitest run \
  src/codex-app-server-agent.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/runtime exec vitest run \
  src/voltagent-runner.test.ts src/execution-store.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/router exec vitest run \
  src/model-router.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/router build
pnpm --filter @massion/runtime build
pnpm exec vitest run \
  apps/server/src/edge-runtime-fallback.integration.test.ts \
  --no-file-parallelism --maxWorkers=1
```

마지막 integration test는 package export의 `dist/index.js`를 읽습니다. 따라서 바로 앞의 Router·Runtime build도 root 단일 직렬 큐에서 실행해야 하며, source test만 통과한 오래된 dist로 integration PASS를 만들면 안 됩니다.

### 17.6 협업·지식·i18n 표적 검증

```bash
pnpm --filter @massion/application exec vitest run \
  src/core-pipeline.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/work exec vitest run \
  src/collaboration.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/evidence exec vitest run \
  src/scanner.test.ts src/indexer.test.ts src/workspace-knowledge.test.ts \
  src/repository-store.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @massion/application build
pnpm --filter @massion/desktop exec vitest run \
  src/i18n/locale.test.ts src/i18n/context.test.tsx src/room.test.tsx \
  src/desktop-service.test.ts src/app.integration.test.tsx \
  --no-file-parallelism --maxWorkers=1
```

Desktop test가 변경된 workspace package export를 import하면 해당 package를 root 직렬 큐에서 먼저 build합니다. 어떤 test가 source alias를 쓰고 어떤 test가 package `dist`를 쓰는지는 import와 package export를 확인해 명령 인계에 적습니다.

### 17.7 단일 직렬 build와 최종 gate

다른 agent가 build/typecheck를 실행하지 않는 root queue에서만 실행합니다.

```bash
pnpm --filter @massion/desktop tauri:build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
pnpm verify
pnpm verify:security
pnpm verify:hardening
git status --short
```

실제 package scripts와 CI가 변경됐으면 `package.json`과 workflow를 먼저 읽고 canonical command를 갱신합니다.

### 17.8 보존 위치

| 대상 | 위치 |
|---|---|
| durable 환불 input 정본 | `docs/evidence/phase-30/fixtures/refund-delay-project/` |
| 실행용 환불 project | `/tmp/massion-refund-project-20260804` |
| 기대 산출물 | `/tmp/massion-refund-project-20260804/refund-delay-report.md` |
| 현재 bundle | `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app` |
| SurrealDB data | `~/.local/share/massion-v1/surrealdb/3/database` |
| server log | `~/.local/state/massion-v1/server.log` |
| Surreal log | `~/.local/state/massion-v1/surrealdb.log` |
| server state | `~/.local/state/massion-v1/server.json` |
| Surreal state | `~/.local/state/massion-v1/surrealdb.json` |
| access token reference | `~/.config/massion-v1/access.token` |
| database password reference | `~/.config/massion-v1/database-password` |

state file의 PID가 실제 process와 다를 수 있습니다. 마지막 조사에서 server PID record `68257`은 stale이었고 SurrealDB PID `68252`만 살아 있었습니다. 새 에이전트는 state file을 사실로 믿지 말고 `ps`·attestation·readiness를 함께 확인합니다.

실행용 `/tmp` project가 없거나 이전 output으로 오염됐으면 durable source의 네 input file을 새 임시 디렉터리에 복사하고 `MANIFEST.md`의 SHA-256을 확인합니다. 기존 실패 Work의 path를 재현할 때만 동일 `/tmp/massion-refund-project-20260804`를 사용하고, fresh Work 증거에는 새 path와 checksum을 기록합니다.
