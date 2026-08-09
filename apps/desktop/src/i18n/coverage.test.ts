import { describe, expect, it } from "vitest";

import APP_SOURCE from "../app.tsx?raw";
import GRAPH_SOURCE from "../knowledge-graph.tsx?raw";
import ROOM_SOURCE from "../room.tsx?raw";
import SIDEBAR_SOURCE from "../components/ui/sidebar.tsx?raw";
import { appEnglishMessages } from "./messages-app";
import { sharedEnglishMessages } from "./messages-shared";

const HANGUL = /[가-힣]/u;

/**
 * 화면 문구가 새는 길은 두 갈래입니다. 번역문이 없거나, `translate()`를 부르지 않거나.
 * 앞의 것은 사전을 대조하면 잡히고, 뒤의 것은 영어로 바꿔 화면을 봐야만 드러납니다.
 * 뒤의 것이 실제로 네 군데에서 샜으므로 그 모양을 여기서 막습니다.
 */
function translateKeysOf(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/translate\(\s*"((?:[^"\\]|\\.)*)"/gu)) keys.push(match[1] as string);
  // 조건식은 `x`부터 `a === "b"`까지 모양이 다양합니다. 좁게 잡으면 검사에서 조용히 빠집니다.
  for (const match of source.matchAll(/translate\([^)"]{0,80}?\?\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
    keys.push(match[1] as string, match[2] as string);
  }
  return keys.filter((key) => HANGUL.test(key));
}

describe("화면 문구", () => {
  it("translate()가 부르는 모든 한글 키에 영어 문구가 있다", () => {
    const dictionary: Record<string, string> = { ...sharedEnglishMessages, ...appEnglishMessages };
    const missing = [
      ...new Set([...translateKeysOf(APP_SOURCE), ...translateKeysOf(ROOM_SOURCE), ...translateKeysOf(GRAPH_SOURCE)]),
    ].filter((key) => dictionary[key] === undefined);

    expect(missing).toEqual([]);
  });

  // `{조건 ? "한글" : "한글"}`은 번역문이 사전에 있어도 영어 화면에 한글을 그대로 냅니다.
  it("삼항 연산자가 translate() 밖에서 한글을 내보내지 않는다", () => {
    const allowed = [
      // 원장에 남는 결정 사유입니다. 기록은 읽는 사람의 언어가 아니라 쓰인 그대로 둡니다.
      'vote === "approve" ? "승인" : "거절"',
      // 언어 이름은 그 언어로 적습니다.
      'systemLocale === "ko" ? "한국어" : "English"',
    ];
    const leaks = [
      ...`${APP_SOURCE}\n${ROOM_SOURCE}\n${GRAPH_SOURCE}`.matchAll(
        /\{([^{}]{0,80}?)\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*\}/gu,
      ),
    ]
      .filter((match) => HANGUL.test(match[2] ?? "") || HANGUL.test(match[3] ?? ""))
      .map((match) => match[0].replace(/\s+/gu, " ").trim())
      .filter((leak) => !allowed.some((exception) => leak.includes(exception)));

    expect(leaks).toEqual([]);
  });

  // hover와 선택이 같은 배경·같은 글자색이면 레일이 «어디에 있나»에 답하지 못합니다.
  it("전역 탐색의 선택 상태가 hover와 구별된다", () => {
    const [, classes = ""] = /"(flex h-\[27px\][^"]*)"/u.exec(SIDEBAR_SOURCE) ?? [];
    const hover = classes.match(/hover:[\w[\]./-]+/gu) ?? [];
    const active = classes.match(/data-\[active=true\]:[\w[\]./-]+/gu) ?? [];
    const strip = (token: string) => token.replace(/^hover:|^data-\[active=true\]:/u, "");

    expect(hover.length).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);
    expect(active.map(strip).sort()).not.toEqual(hover.map(strip).sort());
  });
});
