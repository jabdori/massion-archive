# Massion AgentOS

> **현재 상태:** 개인용 macOS 데스크톱 1.0의 코드와 자동화 검증을 진행 중입니다. Playwright·백엔드 테스트·ad-hoc 패키징은 자동화 근거일 뿐 실제 Tauri UAT나 공개 릴리스 완료를 뜻하지 않습니다. 잘못 게시된 GitHub Release와 `v1.0.0` 태그는 모두 삭제됐습니다. 현재 공개 설치 가능한 릴리스는 없습니다.

Massion은 개인이 자기 기계에서 여러 AI 에이전트를 조직처럼 운영하고, 업무(Work)의 요청·실행·승인·독립 검증·기록·개선을 한 계보로 관리하는 AgentOS입니다.

## 메인 릴리스 목표

첫 메인 릴리스는 **개인용 macOS arm64 데스크톱 앱**입니다.

- 사용자는 내부 식별자 없이 사명을 만들고 필요하면 로컬 워크스페이스와 파일을 문맥으로 추가합니다.
- 홈·업무·지식·조직·개선·확장·프로바이더·예산·설정 아홉 표면과 전역 수신함이 같은 Application 상태를 봅니다.
- 완료는 모델의 선언이 아니라 독립 품질 보증(Assurance)과 기록(Records) 뒤에만 확정됩니다.
- 앱을 닫아도 로컬 daemon과 SurrealDB 데이터는 남고 다음 실행에서 복원됩니다.
- Provider가 없어도 조회·승인·취소·진단은 제한 모드로 동작해야 합니다.
- 사용자가 자율성을 **automatic**(자동 승인, 기본값), **review**(수동 검토), **full-access**(전체 권한) 중에서 선택합니다. 전체 권한은 Claude·Codex의 dangerous bypass와 같이 모든 승인을 사용자 책임 하에 자동 통과합니다.

## 코드·자동화 검증 범위 (Phase 30)

아래는 **자동화 테스트가 통과한 범위**이며, 그 자체로 제품 완주를 뜻하지 않습니다. 실제 제품 상태
판정은 [정본 인계서 §0.H](docs/phases/30-surface-parity-agent-ux/aaa-v1-continuation-handoff-2026-08-05.md)가
소유합니다 — 거기서 Work lifecycle과 협업방은 `blocked`입니다. 도메인 테스트가 GREEN인 것과
Application·Server·Desktop이 연결됐다는 것은 다른 주장입니다(같은 문서 §0.E.1).

| 영역                              | 코드·테스트 | 제품 상태(§0.H) | 스위트                      |
| --------------------------------- | ----------- | --------------- | --------------------------- |
| 홈·워크스페이스 문맥·수신함       | 통과        | `partial`       | desktop 282                 |
| 네이티브 폴더·파일 선택           | 통과        | `partial`       | desktop 282                 |
| 코드 지식(Evidence)·검색·그래프   | 통과        | `partial`       | evidence 78                 |
| Core 파이프라인·Application 계약  | 통과        | `blocked`       | application 534             |
| 명시적 개인 기억(memory)·자가개선 | 통과        | `partial`       | growth 145                  |
| 전체 권한 실행 모드·정책·승인     | 통과        | `partial`       | governance 77               |
| Work 도메인·협업방 계약           | 통과        | `blocked`       | work 80                     |
| 모델 라우팅·fallback·credential   | 통과        | `partial`       | router 97                   |
| 모델 평가실·역할별 배치           | 통과        | `partial`       | model-optimization 53       |
| Extension 설치·격리·레지스트리    | 통과        | `partial`       | extension-host 154 · sdk 35 |
| Core 전체 경로·독립 검증·기록     | 통과        | `blocked`       | server 346                  |

개수는 2026-08-09 실측입니다. 문서가 아니라 실행이 정본이므로 다음 명령으로 다시 확인합니다.

```sh
pnpm -r --workspace-concurrency=1 test
```

## 릴리스 게이트 상태

1. **실제 Tauri UAT** — 진행 중. fixture UI와 백엔드 테스트는 대체 증거가 아닙니다.
2. **`pnpm verify`·패키지별 자동화** — 코드 회귀 근거로 사용하며, 릴리스 완료와 분리합니다.
3. **Tauri 릴리스 후보** — 제품 후보 `573297642`에서 bundle 빌드와 실제 native 폴더·파일 패널 호출, 실제 Provider Work·재시작 보존을 증분 확인했지만, 파일 선택 완료·전체 원자 UAT와 설치·서명 검증은 남아 있습니다. [native 증거](docs/evidence/phase-30/desktop-live-native-file-panel-uat-2026-07-26-573297642.md) · [Provider·재시작 증거](docs/evidence/phase-30/desktop-live-provider-restart-uat-2026-07-27-573297642.md)
4. **Apple Developer ID 서명·공증·설치/업데이트/제거·복구·접근성** — 미완료입니다.

## 개발 실행

저장소 기준 도구는 Node.js 24 이상, pnpm 11.13.0, Rust와 Tauri 2입니다.

```sh
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @massion/desktop tauri:dev
```

변경 영역만 빠르게 확인한 뒤 단계 종료 때 넓은 검증을 실행합니다.

```sh
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop test
pnpm verify
```

`pnpm verify:release`는 기존 headless CLI·서버·연결 장치 설치 묶음을 검사합니다. 개인용 데스크톱 릴리스 완료 근거로 사용하지 않습니다.

## 현재 문서 정본

- [제품 목적과 현재 구현 상태](PRODUCT.md)
- [제품 헌법](docs/product/constitution.md)
- [현재 아키텍처 정본](docs/architecture/README.md)
- [Phase 30 v1 전달 계획과 기록](docs/phases/30-surface-parity-agent-ux/v1-delivery/README.md)
- [실제 데스크톱 UAT 실행 체크리스트](docs/evidence/phase-30/uat-execution-checklist-2026-07-25.md)
- [UAT 시나리오 자동화 커버리지](docs/evidence/phase-30/uat-coverage-mapping-2026-07-25.md)
- [개인용 데스크톱 릴리스 기준](apps/desktop/src-tauri/RELEASE.md)
- [철회된 v1.0.0 기록](docs/evidence/phase-30/withdrawn-v1.0.0-release-2026-07-24.md)

## 릴리스 경계

- `apps/desktop`만 첫 개인용 메인 릴리스 표면입니다.
- 레거시 Web·TUI 표면과 Web session API, 정적 자산 배포, 공개 실행 진입점은 저장소와 제품에서 제거됐습니다.
- 기존 CLI 설치 스크립트, Compose·Kubernetes 배포는 코드와 역사적 검증 경로로 남아 있지만 개인용 1.0의 설치 경로가 아닙니다.
- 개발·테스트 작성·실패 분석·패치는 Z.AI GLM Coding Plan `glm-5.2`를 사용합니다. Massion도 개인 사용자가 자기 계정의 키를 자기 로컬 앱에 직접 등록하는 BYOK 방식이며, Massion이 키·계정·할당량을 판매·공유·대여·중계하지 않습니다.
