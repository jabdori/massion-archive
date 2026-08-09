# 변경 기록

## Unreleased — 개인용 데스크톱 1.0 후보

- 첫 메인 릴리스 표면을 macOS arm64 데스크톱 앱(`apps/desktop`)으로 확정했습니다.
- 홈·업무·지식·조직·개선·확장·프로바이더·예산·설정 아홉 표면과 전역 수신함을 실제 Core와 Application 계약에 연결하는 Phase 30 통합을 진행 중입니다. `지식`은 2026-07-27([ADR-002](docs/architecture/ADR-002-knowledge-axis-restoration.md)), `프로바이더`·`예산`은 2026-07-30에 추가·분리했습니다.
- 원격 SurrealDB 3.2.1, 개인 로컬 sidecar와 배포 코드의 버전 경계를 유지합니다.
- 릴리스 전 필수 조건은 실제 앱 핵심 시나리오 12개 이상, Developer ID 서명·Apple 공증, 깨끗한 설치·후보 교체 업데이트·제거, 데이터 지속성, daemon·SurrealDB 장애 복구, 키보드·VoiceOver 실측, 개인 BYOK 자격 증명 격리 확인입니다.
- 레거시 TUI·Web 제품 표면은 제거됐습니다. Headless CLI 설치 묶음과 팀 배포는 개인용 1.0 메인 릴리스 범위가 아닙니다.

## 1.0.0 — 철회됨 (2026-07-24)

2026-07-15 게시된 GitHub Release `v1.0.0`은 2026-07-24 삭제했습니다. 당시 릴리스 workflow가 전체 품질 검증에서 실패했고, 현재 메인 표면인 개인용 데스크톱의 실제 UAT·서명·공증·설치·데이터 지속성·장애·접근성 게이트가 완료되지 않았기 때문입니다. 원격 `v1.0.0` 태그도 함께 삭제했습니다(`--cleanup-tag`). local·remote 모두 태그 0건이며, 새 태그는 전체 릴리스 게이트를 통과한 뒤에만 만듭니다([철회 기록](docs/evidence/phase-30/withdrawn-v1.0.0-release-2026-07-24.md)). 소스 커밋과 아래 역사적 구현 범위는 보존하지만 공개 1.0 완료 근거로 사용하지 않습니다. 공개 Release 재게시 계획은 없으며, 검증 후보는 수동 승인된 비공개 Actions artifact로만 보관합니다.

- Core Office와 Software Engineering 기본 조직을 포함한 AgentOS 핵심 조직 모델
- 작업, 직접 대화, 다자 대화방, 작업 할당, 중단·재개와 전체 계보
- 선택형 승인 정책, 모델 라우터, VoltAgent 실행 어댑터
- 근거·품질 보증·기록·성장 파이프라인과 Extension 기반 코드
- 레거시 CLI·TUI·Web Console, Compose·Kubernetes, 설치 묶음
- 원격 SurrealDB 3.2.1과 백업·복구·배포 검증 코드

철회 당시의 GitHub 메타데이터와 실패 실행은 [철회 증거](docs/evidence/phase-30/withdrawn-v1.0.0-release-2026-07-24.md)에 남깁니다. 보존된 감사 태그는 이동·재사용하지 않으며, Unreleased 후보는 개인용 데스크톱 게이트를 같은 후보 SHA에서 모두 통과하기 전까지 공개하지 않습니다.
