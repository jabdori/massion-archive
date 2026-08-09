import { describe, expect, it } from "vitest";

import { createRpcFrameParser, validateHandshake } from "./protocol.js";

describe("Extension RPC v1", () => {
  it("연속 sequence의 bounded request frame을 읽는다", () => {
    const parser = createRpcFrameParser({ maxFrameBytes: 1024, maxDepth: 6 });
    expect(
      parser.parse(
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "request-1",
          sequence: 1,
          operation: "health.check",
          payload: {},
        }),
      ),
    ).toMatchObject({ requestId: "request-1", sequence: 1, operation: "health.check" });
  });

  it("sequence 역행·중복과 stdout 오염을 거부한다", () => {
    const parser = createRpcFrameParser();
    parser.parse(
      JSON.stringify({
        protocol: "massion.extension.rpc.v1",
        requestId: "request-1",
        sequence: 1,
        operation: "health.check",
        payload: {},
      }),
    );
    expect(() =>
      parser.parse(
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "request-2",
          sequence: 1,
          operation: "health.check",
          payload: {},
        }),
      ),
    ).toThrow("sequence");
    expect(() => createRpcFrameParser().parse("worker started")).toThrow("JSON");
  });

  it("장수 worker에서 requestId 기억이 무한히 늘지 않는다", () => {
    // 파서는 worker 프로세스와 수명이 같습니다. 본 requestId를 전부 담으면 호출 수에 비례해
    // 메모리가 계속 늡니다. 창을 넘기면 가장 오래된 것부터 밀어냅니다.
    const parser = createRpcFrameParser();
    const frame = (sequence: number): string =>
      JSON.stringify({
        protocol: "massion.extension.rpc.v1",
        requestId: `request-${String(sequence)}`,
        sequence,
        operation: "health.check",
        payload: {},
      });
    for (let sequence = 1; sequence <= 8_500; sequence += 1) parser.parse(frame(sequence));

    // 창 안(최근)의 requestId는 여전히 중복으로 거부합니다 — 재사용 방어가 살아 있습니다.
    expect(() =>
      parser.parse(
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "request-8500",
          sequence: 9_000,
          operation: "health.check",
          payload: {},
        }),
      ),
    ).toThrow("중복");
    // 창 밖(아주 오래된) requestId는 통과합니다. 무한 메모리와 맞바꾼 알려진 상한입니다.
    expect(parser.parse(frame(1).replace('"sequence":1', '"sequence":9001'))).toMatchObject({
      requestId: "request-1",
    });
  });

  it("frame byte·깊이·prototype key를 거부한다", () => {
    expect(() => createRpcFrameParser({ maxFrameBytes: 64 }).parse("{" + " ".repeat(100) + "}")).toThrow("byte");
    const polluted =
      '{"protocol":"massion.extension.rpc.v1","requestId":"r","sequence":1,"operation":"health.check","payload":{"__proto__":{"admin":true}}}';
    expect(() => createRpcFrameParser().parse(polluted)).toThrow("prototype");
  });

  it("handshake nonce·manifest digest·contribution exact match를 요구한다", () => {
    const expected = {
      nonce: "one-time-nonce",
      manifestDigest: "a".repeat(64),
      sdkVersion: "1.0.0",
      contributions: ["runtimeTool:github.issue.read"],
    };
    expect(validateHandshake(expected, expected)).toEqual(expected);
    expect(() => validateHandshake({ ...expected, nonce: "wrong" }, expected)).toThrow("nonce");
    expect(() => validateHandshake({ ...expected, contributions: [] }, expected)).toThrow("contribution");
  });
});
