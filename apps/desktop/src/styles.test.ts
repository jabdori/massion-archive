import { describe, expect, it } from "vitest";

import alertDialog from "./components/ui/alert-dialog.tsx?raw";
import app from "./app.tsx?raw";
import badge from "./components/ui/badge.tsx?raw";
import button from "./components/ui/button.tsx?raw";
import dialog from "./components/ui/dialog.tsx?raw";
import messages from "./i18n/messages-app.ts?raw";
import room from "./room.tsx?raw";
import styles from "./styles.css?raw";

function hex(css: string, token: string): string {
  const found = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!found?.[1]) throw new Error(`${token} 토큰을 찾지 못했습니다`);
  return found[1];
}

function luminance(value: string): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const n = Number.parseInt(value.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("스타일 의미 토큰", () => {
  it("캔버스를 배경 색상으로 노출합니다", () => {
    expect(styles).toContain("--color-background: var(--canvas);");
  });

  it("사이드바 색상 토큰을 노출합니다", () => {
    expect(styles).toMatch(/--color-sidebar:\s*var\(--[\w-]+\);/);
  });

  it("화자 색 슬롯 8개를 노출합니다", () => {
    // 슬롯은 역할이 아니라 handle에 배정됩니다. 역할에 붙이면 같은 역할이 병렬로 돌 때 색이 겹칩니다.
    for (let slot = 0; slot < 8; slot += 1) {
      expect(styles).toContain(`--agent-${String(slot)}: #`);
      expect(styles).toContain(`--color-agent-${String(slot)}: var(--agent-${String(slot)});`);
    }
  });

  it("화자 색에 노랑·초록 계열을 넣지 않습니다", () => {
    // 노랑은 "사람이 필요함" 예약어이고, 초록은 성공 표시로 오독됩니다.
    const slots = [...styles.matchAll(/--agent-[0-7]: (#[0-9a-f]{6});/g)].map((match) => match[1] ?? "");
    expect(slots).toHaveLength(8);
    for (const hex of slots) {
      const red = Number.parseInt(hex.slice(1, 3), 16);
      const green = Number.parseInt(hex.slice(3, 5), 16);
      const blue = Number.parseInt(hex.slice(5, 7), 16);
      const yellowish = red > blue + 40 && green > blue + 40;
      const greenish = green > red + 40 && green > blue + 40;
      expect(`${hex} yellow=${String(yellowish)} green=${String(greenish)}`).toBe(`${hex} yellow=false green=false`);
    }
  });

  it("초점 표시에 gate를 쓰지 않습니다", () => {
    // 노랑은 "사람이 필요함" 전용어입니다. 초점 링이 노랑이면 예약어가 무의미해집니다.
    const found = /--focus-ring:\s*var\((--[\w-]+)\);/.exec(styles);
    expect(found?.[1]).toBeDefined();
    expect(found?.[1]).not.toBe("--gate");
  });

  it("초점 링이 실재하는 변수를 가리킵니다", () => {
    // CSS는 미정의 var를 만나면 그 선언 전체를 무효로 돌립니다. 이전에는 --focus-ring이
    // 정의된 적 없는 --agent-strategy를 가리켜 outline·--color-ring·::selection이 함께 죽었고,
    // "gate가 아니다"만 보던 위 검사는 그 상태를 통과시켰습니다. 참조 대상의 «실재»를 검사합니다.
    const code = styles.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    const undefinedNames = [...code.matchAll(/var\((--[\w-]+)\)/g)]
      .map((found) => found[1] ?? "")
      .filter((name) => !name.startsWith("--tw-"))
      .filter((name) => !new RegExp(`^\\s*${name}:`, "m").test(code));
    expect([...new Set(undefinedNames)]).toEqual([]);
  });

  it("메타 텍스트가 WCAG AA 대비를 넘습니다", () => {
    // fg-3는 11px 시각·checksum·경로에 쓰므로 소형 텍스트 기준 4.5:1을 넘겨야 합니다.
    // bg-3는 nav 활성 배경과 진행바 트랙이라 메타 텍스트가 얹히지 않습니다.
    const bg = hex(styles, "--bg-0");
    // fg-4는 팝오버·다이얼로그 바닥(bg-3)에도 얹히므로 네 면 전부에서 넘겨야 합니다.
    for (const surface of ["--bg-0", "--bg-1", "--bg-2", "--bg-3"]) {
      expect(`${surface} ${contrast(hex(styles, "--fg-4"), hex(styles, surface)).toFixed(2)}`).toBe(
        `${surface} ${Math.max(4.5, contrast(hex(styles, "--fg-4"), hex(styles, surface))).toFixed(2)}`,
      );
    }
    expect(contrast(hex(styles, "--fg-2"), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(styles, "--fg"), bg)).toBeGreaterThanOrEqual(7);
  });

  it("그림자를 쓰지 않으므로 면과 선이 실제로 보여야 합니다", () => {
    // 깊이는 층위와 1px 선이 전부입니다. 분리가 1.05였을 때는 카드가 배경과 붙어 보였습니다.
    expect(contrast(hex(styles, "--bg-1"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.08);
    expect(contrast(hex(styles, "--bg-2"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.15);
    expect(contrast(hex(styles, "--line"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.4);
  });

  /*
   * 이 부류가 두 번 났습니다. --focus-ring이 정의 0회짜리 변수를 가리켜 outline이 통째로 죽었고,
   * text-success·bg-success가 --color-success 없이 쓰여 완료 아이콘과 상태 점이 안 보였습니다.
   * 둘 다 타입도 lint도 못 잡습니다 — 문자열이라 조용히 사라집니다.
   */
  it("화면이 쓰는 색 유틸리티는 전부 정의된 토큰이어야 합니다", () => {
    const defined = new Set([...styles.matchAll(/--color-([a-z0-9-]+):/gu)].map((match) => match[1]));
    // Tailwind 기본 팔레트가 아니라 이 제품이 정의한 이름만 검사합니다.
    const builtin = /^(?:transparent|current|inherit|black|white|popover|border|input|ring|background|foreground)/u;
    // 같은 접두사를 쓰지만 색이 아닌 유틸리티입니다 — 방향·크기·선 스타일·타이포 토큰·줄바꿈.
    const nonColor =
      /^(?:[tblrxyse](?:-\d+)?|left|right|top|bottom|center|inset|xs|sm|md|lg|xl|full|none|auto|dashed|dotted|solid|double|collapse|separate|balance|pretty|wrap|nowrap|clip|ellipsis|color|figure|title|label|body|speaker)$/u;
    const used = new Set(
      [
        ...`${app}${room}${badge}${alertDialog}${dialog}${button}`.matchAll(
          /\b(?:text|bg|border|ring|fill|stroke|divide)-([a-z][a-z0-9-]*)/gu,
        ),
      ]
        .map((match) => match[1] ?? "")
        .filter((name) => name !== "" && !builtin.test(name) && !nonColor.test(name)),
    );
    const missing = [...used].filter((name) => !defined.has(name) && !defined.has(name.replace(/-\d+$/u, "")));
    // 접두사로 거르면 새 이름이 빠져나갑니다. bg-warning은 그렇게 네 라운드를 살아남았습니다.
    expect(missing).toEqual([]);
  });

  /*
   * translate()는 미등록 키를 한국어 원문으로 폴백합니다. sr-only 안에서 이 일이 나면
   * 영어 스크린리더 사용자가 한국어를 듣습니다 — 타입도 lint도 잡지 못합니다.
   */
  /*
   * 사각 셋을 알고 쓰십시오. (1) translate(group.title)처럼 동적 인자는 리터럴이 아니라 안 보입니다.
   * (2) translate()를 아예 거치지 않는 문자열은 이 검사 밖입니다. (3) room.tsx는 미등록 20건이
   * 남아 있어 아직 대상이 아닙니다 — 첫날부터 실패하는 가드는 꺼지므로, 그 부채를 갚을 때 함께 넣습니다.
   */
  it("화면이 부르는 translate 문구는 전부 영어 카탈로그에 있어야 합니다", () => {
    const catalog = new Set(
      [...messages.matchAll(/^\s*(?:"([^"]+)"|([^\s":]+)):/gmu)].map((match) => match[1] ?? match[2] ?? ""),
    );
    const called = new Set([...app.matchAll(/\btranslate\(\s*"([^"]+)"/gu)].map((match) => match[1] ?? ""));
    expect([...called].filter((message) => !catalog.has(message))).toEqual([]);
  });

  /*
   * 이번 감사에서 가장 오래 숨은 결함은 «등록 안 함»이 아니라 «등록했는데 호출 안 함»이었습니다.
   * 오류·알림 문구 11개가 번역된 채로 6라운드 동안 사문이었고, {error}가 translate()를 거치지
   * 않아 영어 화면에서 한국어로 낭독됐습니다. 반대 방향도 함께 검사합니다.
   */
  it("프로바이더 표면의 상태 문구는 등록만 하고 방치하지 않습니다", () => {
    const catalog = new Set(
      [...messages.matchAll(/^\s*(?:"([^"]+)"|([^\s":]+)):/gmu)].map((match) => match[1] ?? match[2] ?? ""),
    );
    const surfaceMessages = [...app.matchAll(/set(?:Error|Notice)\(\s*"([^"]+)"/gu)].map((match) => match[1] ?? "");
    const unregistered = surfaceMessages.filter((message) => !catalog.has(message));
    expect(unregistered).toEqual([]);
  });

  /*
   * 좁은 가드는 방금 고친 형태만 지킵니다. 부류 전체를 봅니다 — 한글이 든 리터럴이
   * translate() 밖에 있으면 영어 화면에서 한국어로 렌더됩니다.
   * 범위는 프로바이더 표면(ProviderField ~ AccountCard)입니다. 다른 표면의 같은 결함은
   * 그 표면을 감사할 때 같은 방식으로 넣습니다.
   */
  it("프로바이더 표면의 한글 문구는 전부 translate를 거칩니다", () => {
    const start = app.indexOf("function ProviderField");
    const end = app.indexOf("function SettingsSurface");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const surface = app.slice(start, end);
    // 삼항을 통째로 감싼 translate(a ? "A" : "B")도 인정하려면 괄호 범위를 봐야 합니다.
    // 문자열 안의 괄호가 깊이를 흔들지 않도록 인덱스를 보존한 채 마스킹합니다.
    const masked = surface.replace(/"[^"\n]*"/gu, (literal) => `"${" ".repeat(literal.length - 2)}"`);
    const covered = (opener: RegExp): Set<number> => {
      const inside = new Set<number>();
      for (const call of masked.matchAll(opener)) {
        const from = (call.index ?? 0) + call[0].length - 1;
        let depth = 0;
        let cursor = from;
        for (; cursor < masked.length; cursor += 1) {
          if (masked[cursor] === "(") depth += 1;
          else if (masked[cursor] === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        for (const literal of surface.slice(from, cursor).matchAll(/"[^"\n]*"/gu))
          inside.add(from + (literal.index ?? 0));
      }
      return inside;
    };
    const wrapped = covered(/\btranslate\(/gu);
    // 상태를 거치는 문구는 렌더 지점이 translate(error)/translate(notice)로 감쌉니다.
    const routed = covered(/\b(?:setError|setNotice|surfaceErrorMessage|new Error)\(/gu);
    // 객체 속성으로 정의되고 사용 지점에서 감싸지는 상수입니다 — translate(group.title) 같은 경로.
    const deferred = new Set<number>(
      [...surface.matchAll(/(?:title|label):\s*"[^"\n]*"/gu)].map(
        (match) => (match.index ?? 0) + match[0].indexOf('"'),
      ),
    );
    const markLiterals = (source: string, offset: number) => {
      for (const literal of source.matchAll(/"[^"\n]*"/gu)) deferred.add(offset + (literal.index ?? 0));
    };
    // 이 값들은 raw 번역 key로 상태에 보존한 뒤 렌더 시점에 번역됩니다. 저장 시 번역하면 언어를
    // 바꿨을 때 이미 표시 중인 알림이 이전 언어로 남습니다. sink가 실제 번역 경로인지도 함께 고정합니다.
    for (const [name, sink] of [
      ["nextNotice", /setNotice\(nextNotice\)/u],
      ["warning", /translate\(warning\)/u],
      ["empty", /translate\(empty\)/u],
      ["details", /details\.map\(translate\)/u],
    ] as const) {
      expect(surface).toMatch(sink);
      const assignments = new RegExp(String.raw`(?:\b(?:const|let)\s+${name}\s*=|\b${name}\s*=)[\s\S]*?;`, "gu");
      for (const assignment of surface.matchAll(assignments)) markLiterals(assignment[0], assignment.index ?? 0);
    }
    expect(surface).toMatch(/setNotice\(providerModelSyncNotice\(/u);
    const syncNotice = /function providerModelSyncNotice\([^)]*\): string \{([\s\S]*?)\n\}/u.exec(surface);
    expect(syncNotice).not.toBeNull();
    if (syncNotice) markLiterals(syncNotice[0], syncNotice.index);
    const raw = [...surface.matchAll(/"([^"\n]*[가-힣][^"\n]*)"/gu)]
      .filter(
        (match) => !wrapped.has(match.index ?? 0) && !routed.has(match.index ?? 0) && !deferred.has(match.index ?? 0),
      )
      .map((match) => match[1] ?? "");
    expect(raw).toEqual([]);
    // 감싸기만 확인하면 삼항 분기를 늘리며 등록을 빠뜨려도 두 가드가 모두 통과합니다.
    const catalog = new Set(
      [...messages.matchAll(/^\s*(?:"([^"]+)"|([^\s":]+)):/gmu)].map((match) => match[1] ?? match[2] ?? ""),
    );
    const inside = [...surface.matchAll(/"([^"\n]*[가-힣][^"\n]*)"/gu)]
      .filter(
        (match) => wrapped.has(match.index ?? 0) || routed.has(match.index ?? 0) || deferred.has(match.index ?? 0),
      )
      .map((match) => match[1] ?? "");
    expect(inside.filter((message) => !catalog.has(message))).toEqual([]);
  });

  it("scope work·미승인 표기를 점선 토큰 하나로 고정합니다", () => {
    expect(styles).toMatch(/--provisional-border:\s*1px dashed var\(--agent-provisional\);/);
  });
});
