import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import type { ApplicationReadModel, ApplicationSourceWatermarks } from "./read-model.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";

const context: TenantContext = {
  userId: "user-snapshot",
  organizationId: "organization-snapshot",
  membershipId: "membership-snapshot",
  role: "owner",
};

function source(overrides: Partial<ApplicationReadModel> = {}): ApplicationReadModel {
  const watermarks: ApplicationSourceWatermarks = {
    organization: 3,
    work: 7,
    runtime: 4,
    collaboration: 9,
    governance: 2,
    extension: 1,
  };
  return {
    watermarks: async () => watermarks,
    organization: async () => ({
      organizationId: context.organizationId,
      version: 3,
      nodes: [
        {
          nodeId: "node-representative",
          handle: "representative",
          name: "Iris",
          responsibility: "사용자 요청 조정",
          capabilities: ["request-coordination"],
          status: "active",
          role: "orchestrator",
          scope: "persistent",
          builtin: false,
        },
        {
          nodeId: "node-strategy",
          handle: "strategy",
          name: "Lyra",
          responsibility: "맥락 구성",
          capabilities: ["analysis"],
          parentHandle: "representative",
          status: "active",
          role: "coordinator",
          scope: "persistent",
          builtin: false,
        },
      ],
    }),
    works: async () => [
      {
        organizationId: context.organizationId,
        workId: "work-snapshot",
        status: "running",
        revision: 7,
        artifactIds: ["artifact-1"],
      },
    ],
    tasks: async () => [
      {
        organizationId: context.organizationId,
        workId: "work-snapshot",
        taskId: "task-snapshot",
        title: "API 구현",
        status: "running",
        revision: 2,
      },
    ],
    assignments: async () => [
      {
        organizationId: context.organizationId,
        workId: "work-snapshot",
        taskId: "task-snapshot",
        agentHandle: "representative",
        status: "assigned",
        revision: 1,
      },
    ],
    executions: async () => [
      {
        organizationId: context.organizationId,
        executionId: "execution-snapshot",
        workId: "work-snapshot",
        taskId: "task-snapshot",
        agentHandle: "representative",
        modelRoute: "balanced",
        status: "running",
        inputTokens: 100,
        outputTokens: 25,
        costMicros: 500,
      },
    ],
    rooms: async () => [
      {
        organizationId: context.organizationId,
        workId: "work-snapshot",
        roomId: "room-snapshot",
        name: "전체 협업방",
        kind: "work",
        status: "active",
        participantIds: ["user-snapshot", "representative"],
        participants: [
          { subjectId: "user-snapshot", kind: "user" },
          { subjectId: "representative", kind: "agent" },
        ],
        lastMessageSequence: 9,
      },
    ],
    approvals: async () => [
      {
        organizationId: context.organizationId,
        approvalId: "approval-snapshot",
        action: "tool.call",
        status: "pending",
        requestedBy: "representative",
        expiresAt: "2026-07-11T04:00:00.000Z",
        displayPreview: {
          kind: "file-change",
          title: "파일 변경",
          path: "/workspace/src/index.ts",
          summary: "검증 로직 변경",
        },
      },
    ],
    extensions: async () => [
      {
        organizationId: context.organizationId,
        installationId: "extension-snapshot",
        packageName: "@massion-ext/example",
        packageVersion: "1.0.0",
        state: "active",
        contributions: ["runtimeTools:example"],
      },
    ],
    ...overrides,
  };
}

describe("CollaborationGraphSnapshotProjector", () => {
  it("역할·현재 Task·실행 모델·비용·대화·산출물·승인을 한 revision snapshot으로 조립한다", async () => {
    const snapshot = await new CollaborationGraphSnapshotProjector(source()).project(context);

    expect(snapshot.organization).toMatchObject({ organizationId: context.organizationId, version: 3 });
    expect(snapshot.nodes[0]).toMatchObject({
      nodeId: "node-representative",
      handle: "representative",
      scope: "persistent",
      builtin: false,
      currentTaskId: "task-snapshot",
      executionId: "execution-snapshot",
      modelRoute: "balanced",
      costMicros: 500,
    });
    expect(snapshot.nodes[1]).toMatchObject({
      nodeId: "node-strategy",
      handle: "strategy",
      parentHandle: "representative",
      scope: "persistent",
      builtin: false,
    });
    expect(snapshot.works[0]).toMatchObject({
      workId: "work-snapshot",
      artifactIds: ["artifact-1"],
      taskIds: ["task-snapshot"],
      roomIds: ["room-snapshot"],
    });
    expect(snapshot.rooms[0]?.participants).toEqual([
      { subjectId: "user-snapshot", kind: "user" },
      { subjectId: "representative", kind: "agent" },
    ]);
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.pendingApprovals[0]?.displayPreview).toEqual({
      kind: "file-change",
      title: "파일 변경",
      path: "/workspace/src/index.ts",
      summary: "검증 로직 변경",
    });
    expect(snapshot.extensions[0]?.contributions).toEqual(["runtimeTools:example"]);
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("source watermark가 읽는 동안 바뀌면 bounded retry하고 안정된 revision만 반환한다", async () => {
    let reads = 0;
    const model = source({
      async watermarks() {
        reads += 1;
        if (reads === 1) return { organization: 1, work: 1 };
        return { organization: 2, work: 1 };
      },
    });

    const snapshot = await new CollaborationGraphSnapshotProjector(model, { maxAttempts: 3 }).project(context);
    expect(reads).toBe(4);
    expect(snapshot.sourceWatermarks).toEqual({ organization: 2, work: 1 });
  });

  it("source에 참가자 종류가 없으면 snapshot에도 선택 필드를 만들지 않는다", async () => {
    const model = source({
      rooms: async () => [
        {
          organizationId: context.organizationId,
          workId: "work-snapshot",
          roomId: "room-snapshot",
          name: "전체 협업방",
          kind: "work",
          status: "active",
          participantIds: ["representative"],
          lastMessageSequence: 9,
        },
      ],
    });

    const snapshot = await new CollaborationGraphSnapshotProjector(model).project(context);

    expect(snapshot.rooms[0]).not.toHaveProperty("participants");
  });

  it("watermark가 계속 바뀌면 conflict를 반환한다", async () => {
    let revision = 0;
    const model = source({
      async watermarks() {
        return { organization: ++revision };
      },
    });
    await expect(
      new CollaborationGraphSnapshotProjector(model, { maxAttempts: 2 }).project(context),
    ).rejects.toMatchObject({
      category: "conflict",
    });
  });

  it("public mapper가 extra secret·credential·raw prompt·path·reasoning을 결과에 복사하지 않는다", async () => {
    const model = source({
      async executions() {
        return [
          {
            organizationId: context.organizationId,
            executionId: "execution-secret",
            workId: "work-snapshot",
            agentHandle: "representative",
            modelRoute: "balanced",
            status: "running",
            inputTokens: 0,
            outputTokens: 0,
            costMicros: 0,
            credentialCiphertext: "secret-ciphertext",
            rawPrompt: "private-prompt",
            reasoning: "private-reasoning",
            filesystemPath: "/Users/private/repository",
          } as never,
        ];
      },
    });
    const encoded = JSON.stringify(await new CollaborationGraphSnapshotProjector(model).project(context));
    expect(encoded).not.toContain("secret-ciphertext");
    expect(encoded).not.toContain("private-prompt");
    expect(encoded).not.toContain("private-reasoning");
    expect(encoded).not.toContain("/Users/private");
  });

  it("source가 다른 tenant record를 반환하면 snapshot 전체를 거부한다", async () => {
    const model = source({
      async works() {
        return [
          {
            organizationId: "organization-other",
            workId: "work-other",
            status: "running",
            revision: 1,
            artifactIds: [],
          },
        ];
      },
    });
    await expect(new CollaborationGraphSnapshotProjector(model).project(context)).rejects.toThrow("tenant");
  });
});
