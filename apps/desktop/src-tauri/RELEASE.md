# 개인용 macOS arm64 릴리스 기준

> **상태:** 1.0 후보 계약. 현재 공개 릴리스는 없습니다.

현재 개발 후보에서 어떤 기능을 제품 차단으로 처리할지는 [현재 후보 범위 선언](../../../docs/operations/current-candidate-scope.md)이 소유합니다. 이 문서의 전체 공개 릴리스 게이트는 그 선언으로 축소되지 않습니다.

## 1. 빌드 경계

`apps/desktop`에서 릴리스 설정을 명시해 실행합니다.

```sh
pnpm --filter @massion/desktop tauri:build
```

빌드는 renderer를 만들고 Node.js bridge·server와 고정된 Node.js·SurrealDB sidecar를 앱에 배치합니다. `runtime-manifest.json`의 아카이브·실행 파일 SHA-256이 다르면 중단합니다. 최종 사용자는 Node.js나 SurrealDB를 별도로 설치하지 않습니다.

`tauri.release.conf.json`은 sidecar·resource staging과 macOS 최소 버전·hardened runtime을 고정합니다. Developer ID 서명·Apple 공증 자격 증명은 CI secret으로만 주입하며, `tauri:build` 성공만으로 공개할 수 없습니다.

## 2. 필수 배포 게이트

모든 항목은 같은 후보 commit SHA와 같은 artifact로 통과해야 합니다.

- `pnpm verify`와 데스크톱 build·typecheck·test
- 핵심 UAT-01–12, UAT-13·15·16, UAT-G01·G02, UAT-K01–K04, UAT-P01·P02의 23개 원자 시나리오를 실제 Tauri 앱에서 동일 후보 SHA로 실행
- Developer ID Application 서명과 Apple 공증·스테이플
- 앱 내부 Node.js·SurrealDB sidecar 서명 검증
- 깨끗한 macOS arm64 사용자에서 최초 설치·Gatekeeper 실행
- 이전 서명 후보에서 새 후보로 수동 교체 업데이트와 데이터 보존
- 앱 제거·재설치와 데이터 보존 정책 확인
- daemon과 SurrealDB sidecar 강제 종료 뒤 재연결·중복 방지·데이터 무결성
- 키보드만으로 핵심 흐름 완주, VoiceOver와 Accessibility Inspector 실측
- 개인 사용자가 등록한 BYOK 키가 로컬 소유자 경계 밖으로 노출·공유·중계되지 않는지 확인

잘못 게시된 `v1.0.0` 태그는 삭제됐으며 현시점에 존재해서는 안 됩니다. 공개 릴리스는 현재 만들지 않으며, 후보 검증이 필요하면 수동 승인된 비공개 Actions artifact만 보관합니다.

Tauri 공식 문서에 따라 브라우저로 배포하는 macOS 앱은 Developer ID 서명과 공증을 사용합니다: [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/).

## 3. artifact 검증

```sh
codesign --verify --deep --strict --verbose=2 Massion.app
spctl --assess --type execute --verbose=4 Massion.app
xcrun stapler validate Massion.app
```

Ad-hoc 서명은 개발 확인에만 쓸 수 있고 공개 후보로 인정하지 않습니다. CI는 인증서와 Apple credential을 secret으로만 주입하며 비밀값을 출력하거나 evidence에 남기지 않습니다.

## 4. 게시 순서

1. 후보 SHA를 고정합니다.
2. 전체 검증과 실제 Tauri UAT를 통과합니다.
3. 서명·공증한 artifact로 깨끗한 Mac 설치·업데이트·제거를 통과합니다.
4. 같은 artifact로 데이터 지속성, 비정상 종료, 접근성을 통과합니다.
5. `scripts/verify-desktop-release.mjs`로 artifact와 모든 증거의 후보 SHA가 일치하는지 확인합니다.
6. 공개 GitHub Release는 만들지 않고, 필요한 경우 수동 승인 workflow의 비공개 artifact만 보관합니다.

하나라도 실패하거나 건너뛰면 draft도 정식 릴리스로 승격하지 않습니다.
