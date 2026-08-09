import { describe, expect, it } from "vitest";

import SOURCE from "./desktop-service.ts?raw";

/*
 * ── 계약 경계 가드 ───────────────────────────────────────────────
 *
 * `desktop-service.ts`에는 서버로 나가는 길이 둘입니다.
 *
 *   client.query / client.command  — `ApplicationQueryMapV1` · `ApplicationCommandMapV1`이
 *                                    payload와 응답 타입을 잡아 줍니다. 서버가 모양을 바꾸면 빌드가 깨집니다.
 *   query / command (1491·1497)    — operation을 문자열로 던지고 결과를 `unknown`으로 받습니다.
 *                                    핸들러는 있어서 동작하지만, 계약이 바뀌면 런타임에야 압니다.
 *
 * 두 번째 길은 계약이 도메인을 아직 못 따라잡은 자리를 메우려고 생겼습니다. 문제는 그 목록이
 * 어디에도 적혀 있지 않아 조용히 자란다는 것입니다. 여기서 고정해 두면 새로 생기는 것이 실패하고,
 * 계약이 열려 하나를 타입 경로로 옮길 때도 실패해서 이 목록이 줄어든 사실이 눈에 남습니다.
 *
 * 이 목록은 debt ledger입니다. 늘리려면 이유가 필요하고, 줄이는 것이 목표입니다.
 */

function operations(kind: "query" | "command", typed: boolean): ReadonlySet<string> {
  const pattern = typed
    ? new RegExp(String.raw`\bclient\.${kind}\(\s*"([^"]+)"`, "gu")
    : new RegExp(String.raw`(?<!\.)\b${kind}\(\s*"([^"]+)"`, "gu");
  const found = new Set([...SOURCE.matchAll(pattern)].map((match) => match[1] as string));
  if (typed) return found;
  for (const name of operations(kind, true)) found.delete(name);
  return found;
}

/** 계약이 조회 타입을 주지 않아 무타입 경로로 나가는 것들. */
const UNTYPED_QUERIES = [
  // 개선(Growth): 타입 맵에 이름은 있지만 `GrowthSuggestionViewV1`에 targetDrifted·decisionReason·
  // patch 줄 구조가 없어 화면이 필요한 근거를 못 받습니다. 인계: growth-adoption-handoff.md
  "growth.configuration.get",
  "growth.effects",
  "growth.suggestion.get",
  "growth.suggestions",
  // 확장·레지스트리: 세 조회 모두 계약에 반환 타입 자체가 없어 `Promise<unknown>`입니다.
  // 인계: extension-capability-handoff.md
  "registry.info",
  "registry.inventory",
  "registry.search",
  // 프로바이더: router·subscription 조회 일곱. 인계: settings-contract-handoff.md
  "router.catalog",
  "router.credentials",
  "router.routes",
  "subscription.accounts",
  "subscription.policy",
  "subscription.providers",
  "subscription.quota",
] as const;

/** 계약이 명령 타입을 주지 않아 무타입 경로로 나가는 것들. */
const UNTYPED_COMMANDS = [
  "registry.install",
  "router.candidate.add",
  "router.credential.add",
  "router.credential.disable",
  "router.endpoint.register",
  "router.model.register",
  "router.provider.register",
  "router.provider.remove",
  "router.route.configure",
  "subscription.account.disconnect",
  "subscription.policy.configure",
  "subscription.server.connect-model",
] as const;

describe("Application 계약 경계", () => {
  it("계약 밖 무타입 조회는 기록된 목록에서만 나간다", () => {
    expect([...operations("query", false)].sort()).toEqual([...UNTYPED_QUERIES].sort());
  });

  it("계약 밖 무타입 명령은 기록된 목록에서만 나간다", () => {
    expect([...operations("command", false)].sort()).toEqual([...UNTYPED_COMMANDS].sort());
  });

  it("타입 경로가 계약 밖 무타입 경로보다 많다", () => {
    // 이 비율이 뒤집히면 계약이 아니라 우회로가 제품 표면이 됩니다.
    const typed = operations("query", true).size + operations("command", true).size;
    expect(typed).toBeGreaterThan(UNTYPED_QUERIES.length + UNTYPED_COMMANDS.length);
  });
});
