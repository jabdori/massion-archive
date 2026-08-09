import { describe, expect, it } from "vitest";

import { EmbeddedVoltAgentRuntime } from "./embedded-agent-runtime.js";

describe("내장 VoltAgent Agent runtime", () => {
  it("Massion이 소유한 process signal handler를 변경하지 않고 Agent topology를 제공한다", () => {
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    const runtime = new EmbeddedVoltAgentRuntime(() => {
      throw new Error("실행 전에는 동적 모델을 해석하지 않습니다");
    });
    runtime.create({
      id: "organization:representative",
      name: "organization:representative",
      handle: "representative",
      instructions: "사용자 요청을 조정합니다",
      role: "orchestrator",
    });

    expect(runtime.getAgents()).toHaveLength(1);
    expect(runtime.get("organization:representative")?.handle).toBe("representative");
    expect({
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      rejection: process.listenerCount("unhandledRejection"),
    }).toEqual(before);
  });

  it("부모·자식 연결과 제거를 runtime 내부에서 결정론적으로 관리한다", () => {
    const runtime = new EmbeddedVoltAgentRuntime(() => {
      throw new Error("실행하지 않습니다");
    });
    for (const [id, handle] of [
      ["organization:representative", "representative"],
      ["organization:assurance", "assurance"],
    ] as const) {
      runtime.create({ id, name: id, handle, instructions: handle, role: "coordinator" });
    }
    runtime.connect("organization:representative", "organization:assurance");
    expect(runtime.childIds("organization:representative")).toEqual(["organization:assurance"]);
    const representative = runtime.getAgents().find((agent) => agent.id === "organization:representative");
    expect(representative?.getSubAgents()).toEqual([]);
    expect(representative?.getTools().map((tool) => tool.name)).not.toContain("delegate_task");

    runtime.remove("organization:assurance");
    expect(runtime.childIds("organization:representative")).toEqual([]);
    expect(runtime.getAgents()).toHaveLength(1);
  });
});
