import { describe, expect, it } from "vitest";

import { parseCliArguments } from "./parser.js";

describe("massion CLI parser", () => {
  it("local daemon lifecycle과 version command를 파싱한다", () => {
    expect(parseCliArguments(["local", "start"])).toMatchObject({ command: "local", subcommand: "start" });
    expect(parseCliArguments(["local", "ensure", "--json"])).toMatchObject({
      command: "local",
      subcommand: "ensure",
      output: "json",
    });
    expect(parseCliArguments(["local", "backup", "/tmp/backup.json"])).toMatchObject({
      command: "local",
      subcommand: "backup",
      arguments: ["/tmp/backup.json"],
    });
    expect(parseCliArguments(["version"])).toMatchObject({ command: "version" });
  });

  it("제거된 Web Console option을 거부한다", () => {
    expect(() => parseCliArguments(["--web"])).toThrow("지원하지 않는 option");
  });

  it.each([
    [["init"], "init", undefined],
    [["update"], "update", undefined],
    [["upgrade"], "upgrade", undefined],
    [["status", "--json"], "status", undefined],
    [["run", "제품화", "--wait"], "run", undefined],
    [["resume", "run-12345678", "--retry-blocked"], "resume", undefined],
    [["watch", "--events", "jsonl", "--after", "12"], "watch", undefined],
    [["org", "graph"], "org", "graph"],
    [["work", "follow-up", "work-1", "추가 작업"], "work", "follow-up"],
    [["chat", "send", "room-1", "안녕하세요"], "chat", "send"],
    [["task", "assign", "task-1", "agent-1"], "task", "assign"],
    [["approval", "approve", "approval-1"], "approval", "approve"],
    [["assurance", "binding-propose"], "assurance", "binding-propose"],
    [["runtime", "suspend", "execution-1"], "runtime", "suspend"],
    [["runtime", "lineage", "execution-1"], "runtime", "lineage"],
    [["provider", "route-set"], "provider", "route-set"],
    [["provider", "model-add"], "provider", "model-add"],
    [["ext", "install", "extension.tgz"], "ext", "install"],
    [["ext", "search", "slack"], "ext", "search"],
    [["ext", "inventory"], "ext", "inventory"],
    [["growth", "suggestions"], "growth", "suggestions"],
    [["subscription", "providers"], "subscription", "providers"],
    [["subscription", "enroll", "edge", "agent-runtime"], "subscription", "enroll"],
    [["auth", "login", "openai-codex"], "auth", "login"],
    [["subscription", "connect-model", "minimax-token-plan"], "subscription", "connect-model"],
    [["subscription", "connect-advanced", "verified-provider"], "subscription", "connect-advanced"],
    [["subscription", "accounts"], "subscription", "accounts"],
    [["subscription", "share", "account-1"], "subscription", "share"],
    [["subscription", "unshare", "account-1"], "subscription", "unshare"],
    [["subscription", "quota", "account-1"], "subscription", "quota"],
    [["subscription", "policy", "verified-provider"], "subscription", "policy"],
    [["subscription", "doctor", "account-1"], "subscription", "doctor"],
    [["subscription", "disconnect", "account-1"], "subscription", "disconnect"],
    [["doctor"], "doctor", undefined],
  ])("%j를 해석한다", (argv, command, subcommand) => {
    expect(parseCliArguments(argv)).toMatchObject({ command, ...(subcommand === undefined ? {} : { subcommand }) });
  });

  it("출력·대기 상호 배타 flag와 typo·불완전 option을 거부한다", () => {
    expect(() => parseCliArguments(["run", "요청", "--detach", "--wait"])).toThrow("동시에");
    expect(() => parseCliArguments(["status", "--json", "--jsonl"])).toThrow("동시에");
    expect(() => parseCliArguments(["statsu"])).toThrow("지원하지 않는");
    expect(() => parseCliArguments(["watch", "--after"])).toThrow("값");
  });

  it("token 원문 command-line flag를 제공하지 않는다", () => {
    expect(() => parseCliArguments(["status", "--token", "secret"])).toThrow("지원하지 않는 option");
    expect(() => parseCliArguments(["auth", "login", "openai-codex", "--token", "secret"])).toThrow(
      "지원하지 않는 option",
    );
  });

  it("Codex 구독 연결의 선택 model을 secret이 아닌 명시적 option으로 파싱한다", () => {
    expect(parseCliArguments(["auth", "login", "openai-codex", "--model", "gpt-5.6-terra"])).toMatchObject({
      model: "gpt-5.6-terra",
      arguments: ["openai-codex"],
    });
    expect(() => parseCliArguments(["status", "--model", "gpt-5.6-sol"])).toThrow("auth login");
    expect(parseCliArguments(["auth", "login", "openai-codex", "--model", "gpt-5.6-terra"])).toMatchObject({
      model: "gpt-5.6-terra",
      arguments: ["openai-codex"],
    });
  });

  it("새 Codex 구독 계정 추가를 명시적으로 파싱한다", () => {
    expect(parseCliArguments(["auth", "login", "openai-codex", "--new-account"])).toMatchObject({
      newAccount: true,
      arguments: ["openai-codex"],
    });
    expect(() => parseCliArguments(["status", "--new-account"])).toThrow("auth login");
  });

  it("제거된 subscription connect 호환 명령을 거부한다", () => {
    expect(() => parseCliArguments(["subscription", "connect", "openai-codex"])).toThrow(
      "subscription subcommand가 유효하지 않습니다",
    );
  });

  it("제거된 최적화 관찰 명령을 거부한다", () => {
    expect(() => parseCliArguments(["optimization", "observe"])).toThrow("optimization subcommand가 유효하지 않습니다");
  });

  it("run의 재현 가능한 상관관계 ID를 명시적으로 파싱하고 다른 command에서는 거부한다", () => {
    expect(
      parseCliArguments(["run", "구독 실행", "--correlation", "8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6"]),
    ).toMatchObject({ correlationId: "8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6", arguments: ["구독 실행"] });
    expect(() => parseCliArguments(["status", "--correlation", "8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6"])).toThrow(
      "run command",
    );
    expect(() => parseCliArguments(["run", "구독 실행", "--correlation", "not-a-uuid"])).toThrow("상관관계 ID");
  });
});
