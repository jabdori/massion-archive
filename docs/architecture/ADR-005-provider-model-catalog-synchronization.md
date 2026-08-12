# ADR-005 — Provider 모델 카탈로그 발견과 실행 검증 분리

> **상태:** 승인됨
> **승인일:** 2026-08-10
> **대상:** Provider 설정, 모델 라우터, 작업 인지 모델 배치

## 맥락

Provider 연결 화면은 Provider, Endpoint, Credential까지만 저장합니다. Router에는 OpenAI 호환
`/models`와 Ollama `/api/tags`를 읽는 `discoverModels()`가 있지만 생산 호출자는 없습니다.
`router.catalog` 조회도 원격 카탈로그가 아니라 이미 수동 등록된 `model_profile`만 반환합니다.
따라서 OpenRouter처럼 모델 목록 API를 제공하는 Provider를 정상 연결해도 화면에는 모델이 비어
있습니다.

원격 카탈로그와 `model_profile`은 같은 사실이 아닙니다. OpenAI 호환 최소 계약은 모델 ID와
선택적 소유자만 보장하지만 `model_profile`은 context, capability, 가격, 평가 점수와 검증 여부를
모두 요구합니다. 발견 결과를 곧바로 profile로 만들면 모르는 값을 `false`나 무료인 `0`으로
꾸미거나, 목록에 존재한다는 사실을 실행 가능하다는 증거로 오인하게 됩니다.

2026-08-10 공식 OpenRouter `GET /api/v1/models`를 읽기 전용으로 확인한 결과 400개 모델과
context, architecture, supported parameters, pricing 메타데이터가 반환됐습니다. 이 응답은 Provider의
현재 카탈로그를 관측하는 근거이지, 특정 Credential로 실제 호출이 성공한다는 검증은 아닙니다.

## 결정

### 1. 발견 카탈로그와 실행 가능한 ModelProfile을 분리합니다

- Provider API 응답은 별도 `provider_model_catalog_entry`에 관측값으로 저장합니다.
- API에 없는 metadata는 `unknown`으로 보존합니다. `false`, `0`, 임의 context로 채우지 않습니다.
- discovery는 `model_profile`이나 route candidate를 자동 생성하지 않습니다.
- 실제 모델 선택은 별도 활성화·검증 단계에서 evidence와 함께 ModelProfile로 승격합니다.
- upstream에서 모델이 사라져도 기존 ModelProfile, candidate, route attempt 계보는 삭제하지 않습니다.

### 2. 동기화는 짧은 두 transaction 사이에서 네트워크를 호출합니다

1. 첫 transaction이 endpoint별 단조 증가 sequence를 예약하고 `syncing` 상태를 기록합니다.
2. HTTP 요청과 전체 parse는 transaction 밖에서 수행합니다.
3. 두 번째 transaction은 예약한 sequence가 여전히 최신일 때만 snapshot을 적용합니다.

늦게 끝난 과거 요청은 최신 카탈로그를 덮지 않습니다. 실패, timeout, 빈 목록, 부분 응답은 마지막
완전 snapshot을 지우지 않습니다. 완전한 성공만 새 active snapshot을 원자적으로 적용하고, 누락된
기존 항목은 삭제하지 않고 stale로 남깁니다.

응답 digest·모델 수·snapshot이 모두 같으면 active 항목을 stale 처리하거나 전량 UPSERT하지 않습니다.
기존 항목의 `last_seen_at`만 한 번에 갱신하고 상태와 audit을 같은 짧은 transaction에서 확정합니다.
이 경량 경로는 동일한 400개 모델을 다시 확인할 때 장기 transaction을 반복하지 않으면서도 관측 시각을
정확히 전진시킵니다.

개인용 v1의 단일 서버 프로세스에서는 같은 조직·command ID의 동시 요청을 single-flight로 합칩니다.
완료 뒤에는 audit replay가 같은 결과를 반환하고, 중단 뒤에는 시작 복구가 남은 `syncing`을 degraded로
바꿉니다. 다중 서버 배포 전에는 이 claim을 DB lease로 승격해야 합니다.

### 3. 비밀과 outbound 경계를 서버가 소유합니다

- 외부 endpoint는 HTTPS만 허용하고 userinfo, query, fragment를 거절합니다.
- 로컬 HTTP는 정확한 loopback 주소만 허용합니다.
- Credential은 같은 조직·Provider·Endpoint의 활성 버전만 서버에서 복호화합니다.
- Credential 추가·회전·폐기는 해당 Endpoint의 기존 snapshot을 즉시 degraded로 표시하고 진행 중
  sequence를 무효화합니다. 다음 동기화는 같은 priority에서 가장 최근에 갱신된 활성 Credential을 씁니다.
- Application에는 익명/자격 기반 여부만 공개하고 Credential ID·version·secret version 계보는 서버 감사에만
  둡니다.
- Authorization, secret, 원문 오류 body는 Application 응답, audit, Desktop에 노출하지 않습니다.
- redirect, timeout, 응답 byte 수, 모델 수, 모델 ID 형식을 제한합니다.
- 외부 hostname의 모든 DNS 결과가 public IP인지 확인하고, 검증한 주소에 socket을 고정한 채 원래
  hostname으로 TLS SNI와 인증서를 검증합니다. 허용된 첫 주소 연결이 실패하면 같은 검증을 통과한
  다음 주소만 시도합니다.
- discovery와 실제 모델 실행 SDK가 같은 보안 fetch를 사용합니다. 카탈로그 조회만 안전하고 실제
  completion 요청은 DNS rebinding에 노출되는 분리된 경로를 두지 않습니다.

### 4. Provider 응답이 말한 것만 정규화합니다

- 일반 OpenAI 호환 응답은 `id`, 선택적 `owned_by`만 필수 계약으로 사용합니다.
- OpenRouter 확장 필드가 실제로 있으면 canonical ID, 표시 이름, context, tools, structured output,
  vision, 가격, 만료 시각을 선택적으로 기록합니다.
- streaming은 모델 목록에 근거가 없으면 unknown입니다.
- OpenRouter 가격 문자열은 `USD/token × 10^12`로 정수 micro-USD/백만 token에 정확히 변환합니다.
- 실제 비용이 하위 모델에 따라 정해지는 OpenRouter router의 `-1` 가격 sentinel은 무료가 아니라
  unknown으로 보존합니다.
- Ollama 목록은 모델 ID만 발견합니다. capability는 후속 `/api/show` 검증 없이는 추정하지 않습니다.

### 5. 지원하지 않는 adapter를 성공처럼 저장하지 않습니다

Desktop과 Router는 하나의 adapter 정본을 사용합니다. 현재 Runtime transport가 없는 `anthropic`
문자열은 직접 연결 선택지에서 제거하고 Router가 알 수 없는 adapter를 저장 단계에서 거절합니다.
Anthropic을 다시 노출하려면 공식 model discovery뿐 아니라 실제 요청 header, 오류 분류, streaming과
runtime 실행 검증을 한 묶음으로 구현해야 합니다.

`ai-sdk`는 OpenAI 호환 `/models`를 시도할 수 있지만, Provider가 다른 계약을 쓰면 마지막 정상
snapshot을 보존한 `degraded`가 됩니다. adapter 이름만 보고 Anthropic 응답을 OpenAI로 꾸미지 않습니다.

### 6. 모델 목록의 주 상태는 발견 여부가 아니라 실행 활성 여부입니다

원격 API에서 왔다는 구현 사실을 행마다 `발견됨`으로 반복하지 않습니다. Endpoint의 마지막 동기화 상태와
새로고침이 카탈로그 출처를 설명하고, 모델 행은 서버 `model_profile.enabled`를 기준으로 On/Off를 먼저
보입니다. 카탈로그에만 있고 ModelProfile이 없는 모델은 Off이며, 이것을 실행 가능·검증 완료로 꾸미지
않습니다. stale과 미확인은 필요한 행에만 보조 상태로 남깁니다.

과거 화면 메모리의 `disabledModels`로 동작한 스위치는 재시작하면 설정이 되살아나는 가짜 제어였으므로
복원하지 않습니다. 등록 모델은 감사되는 `router.model.enabled.set` 명령으로 `model_profile.enabled` flag만
원자적으로 갱신합니다. candidate와 과거 route attempt 계보는 삭제하거나 다시 쓰지 않고 보존합니다.
카탈로그에만 있는 행은 실행 Profile이 없어 계속 읽기 전용 Off입니다.

## 결과

- OpenRouter 같은 Provider는 하드코딩 모델 목록 없이 API 카탈로그를 표시할 수 있습니다.
- 카탈로그 출처, stale, 검증, 실행 활성 상태를 화면과 allocator가 혼동하지 않습니다.
- 동기화 실패나 앱 재시작이 마지막 정상 목록과 실행 계보를 지우지 않습니다.
- 모델 활성화와 동적 할당은 관측 카탈로그를 입력으로 쓰되 실제 실행 evidence를 계속 요구합니다.

## 기각한 대안

- **모델 ID 하드코딩:** upstream 변화와 사용자별 가용성을 반영하지 못합니다.
- **발견 모델을 즉시 ModelProfile로 등록:** unknown을 거짓 기본값으로 바꾸고 검증 계약을 흐립니다.
- **화면을 열 때마다 원격 API 직접 호출:** 오프라인, 재시작, 감사, stale 계보를 잃습니다.
- **네트워크 호출을 Router command transaction 안에서 실행:** 외부 지연 동안 DB transaction을 잡고
  동시 요청의 완료 순서가 snapshot 순서를 뒤집습니다.
- **현재 `anthropic` 문자열을 OpenAI transport로 통과:** 화면의 성공과 실제 실행이 일치하지 않습니다.
