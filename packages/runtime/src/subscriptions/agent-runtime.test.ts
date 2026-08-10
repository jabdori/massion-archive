import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { normalizeConfirmedAgentUsage, SubscriptionAgentRuntimeCoordinator } from "./agent-runtime.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("구독 Agent runtime 중단·재개 bridge", () => {
  it.each([
    ["camelCase", { inputTokens: 8, outputTokens: 2 }, { inputTokens: 8, outputTokens: 2 }],
    ["snake_case", { input_tokens: 8, output_tokens: 2 }, { inputTokens: 8, outputTokens: 2 }],
    ["누락", { inputTokens: 8 }, undefined],
    ["음수", { inputTokens: 8, outputTokens: -1 }, undefined],
    ["소수", { inputTokens: 8, outputTokens: 1.5 }, undefined],
    ["비객체", "8/2", undefined],
  ])("Provider confirmed usage %s 경계를 정규화한다", (_case, raw, expected) => {
    expect(normalizeConfirmedAgentUsage(raw)).toEqual(expected);
  });

  it("승인된 session만 같은 adapter와 execution ID로 재개한다", async () => {
    const execute = vi.fn().mockResolvedValue({
      outcome: "suspended",
      executionId: "execution-1",
      sessionId: "session-1",
      approvalId: "approval-1",
    });
    const resume = vi.fn().mockResolvedValue({
      outcome: "completed",
      executionId: "execution-1",
      sessionId: "session-1",
      value: "완료",
    });
    const coordinator = new SubscriptionAgentRuntimeCoordinator({ claude: { execute, resume, cancel: vi.fn() } });
    const input = {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "representative",
      prompt: "진행하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/profile-1",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    };

    await coordinator.execute("claude", context, input);
    await expect(
      coordinator.resume(context, "execution-1", { approvalId: "approval-other", approved: true }),
    ).rejects.toThrow("승인 ID");
    await expect(
      coordinator.resume(context, "execution-1", { approvalId: "approval-1", approved: true }),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(resume).toHaveBeenCalledWith(context, input, {
      sessionId: "session-1",
      approvalId: "approval-1",
      approved: true,
    });
  });
});
