import { describe, expect, it } from "vitest";

import APP_SOURCE from "../../app.tsx?raw";
import INPUT_SOURCE from "./input.tsx?raw";
import TEXTAREA_SOURCE from "./textarea.tsx?raw";

/**
 * `cn`은 tailwind-merge가 아니라 이어붙이기입니다. 충돌하는 유틸리티는 해소되지 않고 스타일시트
 * 방출 순서가 승자를 정하므로, 컴포넌트 base에 있는 클래스는 className으로 덮이지 않습니다.
 *
 * 조용히 사라지는 것이 문제입니다. 「업무 요청」 칸에는 `border border-control bg-surface-1`이
 * 붙어 있었지만 base의 `border-0 bg-transparent`가 이겨, 제품의 주 입력칸이 화면에서 보이지
 * 않았습니다. 상자가 필요하면 감싸십시오 — 방 입력창이 이미 그렇게 합니다.
 */
const CONFLICTING = /\b(?:border-\d|border(?:-[a-z]+)?$|bg-[a-z])/u;

function baseClassesOf(source: string): string {
  const [, classes = ""] = /cn\(\s*"([^"]+)"/u.exec(source) ?? [];
  return classes;
}

function overridesOf(component: string): string[] {
  const found: string[] = [];
  const opening = new RegExp(`<${component}\\b[^>]*?className=\\{?"([^"]*)"`, "gsu");
  for (const match of APP_SOURCE.matchAll(opening)) found.push(match[1] as string);
  return found;
}

describe("컴포넌트 base 클래스", () => {
  it.each([
    ["Input", INPUT_SOURCE],
    ["Textarea", TEXTAREA_SOURCE],
  ])("%s에 테두리·배경을 className으로 덮으려 하지 않는다", (component, source) => {
    const base = baseClassesOf(source);
    const owned = new Set(
      base
        .split(/\s+/u)
        .filter(Boolean)
        .filter((token) => CONFLICTING.test(token))
        .map((token) => token.replace(/-\d+$/u, "").replace(/-(?:transparent|\[.*\])$/u, "")),
    );

    const dead = overridesOf(component).flatMap((className) =>
      className
        .split(/\s+/u)
        .filter(Boolean)
        .filter((token) => [...owned].some((prefix) => token === prefix || token.startsWith(`${prefix}-`)))
        .map((token) => `<${component} className="… ${token} …">`),
    );

    expect(dead).toEqual([]);
  });
});
