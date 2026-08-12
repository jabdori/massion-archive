import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  StrategyRecovery,
  type ContextVersion,
  type StrategyPlan,
} from "./index.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

const PLAN: StrategyPlan = {
  objective: "원격 계약을 검증한다",
  summary: "실제 SurrealDB에서 계획을 투영한다",
  scopeIn: ["remote-contract"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-remote",
      statement: "원격 계약 테스트가 통과한다",
      method: "test",
      evidenceKinds: ["test-report"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "remote-verify",
      title: "원격 검증",
      objective: "원격 데이터베이스 계약을 검증한다",
      criterionKeys: ["criterion-remote"],
      dependencyKeys: [],
      requiredCapabilities: ["database-testing"],
      recommendedAgentHandles: [],
      parallelizable: false,
      reasoningDifficulty: "medium",
      taskAxis: "review-critique",
    },
  ],
  evidenceRequests: [],
};

describe("remote Context & Strategy contract", () => {
  remoteTest("SurrealDB 3에서 동시 Context, projection 복구, tenant와 follow-up 계보를 보존한다", async () => {
    const databaseName = `context_${crypto.randomUUID().replaceAll("-", "")}`;
    await using admin = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "main",
      database: "main",
      authentication: { username: "root", password: "root" },
    });
    await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "remote-owner@example.com", displayName: "Owner" });
    const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const outsider = await identity.registerPersonalUser({ email: "remote-other@example.com", displayName: "Other" });
    const otherTenant = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    const works = await WorkService.create(database, organizations);
    const work = (
      await works.createWork(tenant, {
        commandId: crypto.randomUUID(),
        text: "원격 전략을 생성한다",
        surface: "remote-contract",
        organizationVersionId: "organization-remote-v1",
      })
    ).work;
    const contexts = await ContextStore.create(database, organizations, works);
    const requestContent = "원격 전략을 생성한다";
    const base = await contexts.create(tenant, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      tokenBudget: 2_000,
      objective: "원격 전략",
      scopeIn: ["remote-contract"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "remote-request",
          revision: "1",
          contentHash: hashContextContent(requestContent),
          observedAt: "2026-07-10T00:00:00.000Z",
          classification: "internal",
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content: requestContent,
        },
      ],
    });
    const concurrent = await Promise.allSettled(
      ["first", "second"].map((label) => {
        const content = `동시 변경 ${label}`;
        return contexts.create(tenant, {
          commandId: crypto.randomUUID(),
          workId: work.work_id,
          expectedParentContextVersionId: base.contextVersionId,
          tokenBudget: 2_000,
          objective: "원격 전략",
          scopeIn: ["remote-contract", label],
          scopeOut: [],
          constraints: [],
          assumptions: [],
          unknowns: [],
          decisions: [],
          sources: [
            ...base.sources,
            {
              kind: "follow_up" as const,
              sourceId: `remote-${label}`,
              revision: "1",
              contentHash: hashContextContent(content),
              observedAt: "2026-07-10T00:01:00.000Z",
              classification: "internal" as const,
              priority: 100,
              estimatedTokens: 20,
              mandatory: true,
              content,
            },
          ],
        });
      }),
    );
    const committed = concurrent
      .filter((entry): entry is PromiseFulfilledResult<ContextVersion> => entry.status === "fulfilled")
      .map((entry) => entry.value);
    expect(committed).toHaveLength(1);
    expect(concurrent.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(committed[0]?.version).toBe(2);
    const committedContext = committed[0];
    if (!committedContext) throw new Error("동시 ContextVersion commit 결과가 없습니다");

    const generator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "remote-execution",
          status: "succeeded",
          output: PLAN,
        }),
      },
      contexts,
      works,
    );
    const rootCommandId = crypto.randomUUID();
    const generation = await generator.generate(tenant, {
      commandId: `${rootCommandId}:generate`,
      workId: work.work_id,
      expectedWorkRevision: 1,
      contextVersionId: committedContext.contextVersionId,
    });
    if (!generation.checksum || !generation.plan) throw new Error("원격 Strategy generation이 불완전합니다");
    const projection = await works.applyStrategyProjection(tenant, {
      commandId: `${rootCommandId}:project`,
      workId: work.work_id,
      expectedRevision: 1,
      contextVersionId: generation.contextVersionId,
      strategyGenerationId: generation.strategyGenerationId,
      strategyChecksum: generation.checksum,
      plan: generation.plan,
    });
    const recovered = await StrategyRecovery.create(generator, works).recover(tenant);
    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: generation.strategyGenerationId, status: "applied" }),
    ]);
    expect(projection.work).toMatchObject({ status: "planned", revision: 2 });
    expect(projection.tasks.map((task) => task.task_key)).toEqual(["remote-verify"]);

    await expect(contexts.get(otherTenant, committedContext.contextVersionId)).rejects.toThrow(
      "ContextVersion을 찾을 수 없습니다",
    );
    await expect(generator.get(otherTenant, generation.strategyGenerationId)).rejects.toThrow(
      "Strategy generation을 찾을 수 없습니다",
    );
    await expect(works.getWork(otherTenant, work.work_id)).rejects.toThrow("Work를 찾을 수 없습니다");

    const followUp = await works.createFollowUpWork(tenant, {
      commandId: crypto.randomUUID(),
      parentWorkId: work.work_id,
      text: "원격 배포까지 이어서 진행한다",
      surface: "remote-contract",
    });
    expect(followUp.work).toMatchObject({
      parent_work_id: work.work_id,
      organization_version_id: projection.work.organization_version_id,
      context_version_id: projection.work.context_version_id,
      status: "draft",
    });
    expect((await works.getWork(tenant, work.work_id)).revision).toBe(2);
  });
});
