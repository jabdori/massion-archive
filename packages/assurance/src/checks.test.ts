import { describe, expect, it, vi } from "vitest";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import type { HumanAttestation, MetricObservation } from "./contracts.js";
import {
  AssuranceCheckStore,
  assertNoCallerVerdict,
  evaluateArtifactEvidenceCheck,
  evaluateHumanAttestationCheck,
  evaluateMetricObservationCheck,
  finalizeCriterionFromChecks,
  runTrustedAssuranceCheckExecutor,
  type TrustedAssuranceCheckExecutor,
} from "./checks.js";

const organizationId = "organization-1";
const workId = "work-1";
const assuranceRunId = "run-1";
const criterionId = "criterion-1";

describe("결정론적 Assurance check", () => {
  it("Artifact content·소유권·freshness에서만 evidence check 결과를 계산한다", () => {
    const contentJson = '{"ok":true}';
    const checksum = "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93";
    const result = evaluateArtifactEvidenceCheck({
      organizationId,
      workId,
      observedAt: "2026-07-10T12:00:00.000Z",
      maximumAgeMs: 60_000,
      requiredArtifactVersionIds: ["artifact-1"],
      artifacts: [
        {
          artifactVersionId: "artifact-1",
          organizationId,
          workId,
          contentJson,
          checksum,
          createdAt: "2026-07-10T11:59:30.000Z",
        },
      ],
    });

    expect(result).toMatchObject({ status: "passed", evidenceReferenceIds: ["artifact-1"] });
    expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      evaluateArtifactEvidenceCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        requiredArtifactVersionIds: ["missing"],
        artifacts: [],
      }).status,
    ).toBe("blocked");
  });

  it.each([
    [98.5, ">=" as const, 95, "passed"],
    [94.9, ">=" as const, 95, "failed"],
    [0, "=" as const, 0, "passed"],
    [11, "<" as const, 10, "failed"],
  ])("MetricObservation %s %s %s를 %s로 판정한다", (value, operator, threshold, status) => {
    const observation: MetricObservation = {
      observationId: "metric-1",
      organizationId,
      workId,
      producerKind: "system_adapter",
      producerId: "massion.metric.coverage.v1",
      sourceKind: "artifact_version",
      sourceId: "artifact-1",
      value,
      unit: "percent",
      checksum: "a".repeat(64),
      measuredAt: "2026-07-10T11:59:30.000Z",
      createdAt: "2026-07-10T11:59:31.000Z",
    };
    const result = evaluateMetricObservationCheck({
      organizationId,
      workId,
      observedAt: "2026-07-10T12:00:00.000Z",
      maximumAgeMs: 60_000,
      sourceKind: "artifact_version",
      operator,
      threshold,
      unit: "percent",
      observations: [observation],
    });
    expect(result.status).toBe(status);
    expect(result.metricObservationIds).toEqual(["metric-1"]);
  });

  it("Metric unit·source·freshness가 맞지 않거나 관측이 없으면 통과시키지 않는다", () => {
    const base: MetricObservation = {
      observationId: "metric-1",
      organizationId,
      workId,
      producerKind: "system_adapter",
      producerId: "adapter-1",
      sourceKind: "artifact_version",
      sourceId: "artifact-1",
      value: 100,
      unit: "percent",
      checksum: "a".repeat(64),
      measuredAt: "2026-07-10T10:00:00.000Z",
      createdAt: "2026-07-10T10:00:01.000Z",
    };
    expect(
      evaluateMetricObservationCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        observations: [base],
      }).status,
    ).toBe("blocked");
    expect(
      evaluateMetricObservationCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        observations: [],
      }).status,
    ).toBe("blocked");
  });

  it("현재 eligible Membership의 distinct accept만 세고 reject가 하나라도 있으면 실패한다", () => {
    const attestation = (userId: string, accepted = true): HumanAttestation => ({
      attestationId: `attestation-${userId}`,
      organizationId,
      workId,
      assuranceRunId,
      criterionId,
      attestorUserId: userId,
      statementHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      accepted,
      commandId: `command-${userId}`,
      requestHash: "c".repeat(64),
      createdAt: "2026-07-10T11:59:30.000Z",
    });
    const input = {
      organizationId,
      workId,
      assuranceRunId,
      criterionId,
      statementHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      eligibleRoles: ["owner", "admin"],
      minimumAttestations: 2,
      memberships: [
        { userId: "owner", role: "owner", status: "active" as const },
        { userId: "admin", role: "admin", status: "active" as const },
      ],
      attestations: [attestation("owner"), attestation("admin")],
    };
    expect(evaluateHumanAttestationCheck(input).status).toBe("passed");
    expect(
      evaluateHumanAttestationCheck({ ...input, attestations: [attestation("owner"), attestation("admin", false)] })
        .status,
    ).toBe("failed");
    expect(evaluateHumanAttestationCheck({ ...input, memberships: input.memberships.slice(0, 1) }).status).toBe(
      "blocked",
    );
  });

  it("criterion은 예상된 모든 check evidence의 상태에서만 최종 계산한다", () => {
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
          { bindingKey: "check:metric", status: "passed", outputHash: "b".repeat(64) },
        ],
      }).status,
    ).toBe("passed");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [{ bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) }],
      }).status,
    ).toBe("blocked");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [
          { bindingKey: "check:test", status: "failed", outputHash: "a".repeat(64) },
          { bindingKey: "check:metric", status: "blocked", outputHash: "b".repeat(64) },
        ],
      }).status,
    ).toBe("failed");
    expect(finalizeCriterionFromChecks({ expectedBindingKeys: [], checks: [] }).status).toBe("blocked");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test"],
        checks: [
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
        ],
      }).status,
    ).toBe("blocked");
  });

  it.each(["passed", "status", "verdict"])("caller의 %s 판정 주입을 거부한다", (key) => {
    expect(() => assertNoCallerVerdict({ commandId: "command-1", [key]: true })).toThrow("caller verdict");
  });

  it("server-owned trusted executor만 실행하고 누락된 adapter는 blocked로 판정한다", async () => {
    const executor: TrustedAssuranceCheckExecutor = {
      adapterId: "massion.software-command.v1",
      async execute(_context, input) {
        return {
          status: "passed",
          outputHash: "d".repeat(64),
          summary: "fresh workspace command passed",
          toolName: "node",
          toolVersion: "v24.0.0",
          durationMs: 10,
          artifactVersionIds: input.artifactVersionIds,
        };
      },
    };
    const input = {
      workId,
      assuranceRunId,
      criterionId,
      verificationId: "verification-1",
      binding: {
        bindingKey: "test:node",
        criterionKey: "task:1:0",
        kind: "test" as const,
        executor: { kind: "system_adapter" as const, adapterId: executor.adapterId },
        executable: "node",
        args: ["--test"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 10_000,
        requiredEvidenceKinds: ["command-output"],
      },
      artifactVersionIds: ["artifact-1"],
      evidenceBriefIds: [],
      metricObservationIds: [],
      humanAttestationIds: [],
    };
    const context = { organizationId, userId: "owner-1", membershipId: "membership-1", role: "owner" } as const;

    await expect(
      runTrustedAssuranceCheckExecutor(new Map([[executor.adapterId, executor]]), context, input),
    ).resolves.toMatchObject({ status: "passed", toolName: "node", artifactVersionIds: ["artifact-1"] });
    await expect(runTrustedAssuranceCheckExecutor(new Map(), context, input)).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("executor"),
    });
  });

  it("같은 run의 Check를 ID 순서로 읽고 다른 tenant에는 노출하지 않는다", async () => {
    const ownerContext: TenantContext = {
      organizationId,
      userId: "owner-1",
      membershipId: "membership-1",
      role: "owner",
    };
    const otherContext: TenantContext = {
      organizationId: "organization-2",
      userId: "owner-2",
      membershipId: "membership-2",
      role: "owner",
    };
    const records = [
      {
        check_id: "check-z",
        organization_id: organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
        criterion_id: criterionId,
        kind: "evidence" as const,
        system_adapter_id: "massion.evidence.v1",
        command_key: "evidence:z",
        input_hash: "a".repeat(64),
        status: "passed" as const,
        output_hash: "b".repeat(64),
        artifact_version_ids: [],
        evidence_brief_ids: [],
        metric_observation_ids: [],
        human_attestation_ids: [],
        created_at: "2026-07-10T12:00:00.000Z",
        completed_at: "2026-07-10T12:00:00.000Z",
      },
      {
        check_id: "check-a",
        organization_id: organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
        criterion_id: "criterion-2",
        kind: "evidence" as const,
        system_adapter_id: "massion.evidence.v1",
        command_key: "evidence:a",
        input_hash: "c".repeat(64),
        status: "passed" as const,
        output_hash: "d".repeat(64),
        artifact_version_ids: [],
        evidence_brief_ids: [],
        metric_observation_ids: [],
        human_attestation_ids: [],
        created_at: "2026-07-10T12:00:01.000Z",
        completed_at: "2026-07-10T12:00:01.000Z",
      },
    ];
    const query = vi.fn(async (statement: string, bindings?: Record<string, unknown>) => [
      records
        .filter(
          (record) =>
            record.organization_id === bindings?.organization_id &&
            record.assurance_run_id === bindings?.assurance_run_id,
        )
        .sort((left, right) =>
          statement.includes("ORDER BY check_id ASC") ? left.check_id.localeCompare(right.check_id) : 0,
        ),
    ]);
    const verifyTenantContext = vi.fn(async () => undefined);
    const checks = new AssuranceCheckStore(
      { query } as unknown as MassionDatabase,
      { verifyTenantContext } as unknown as OrganizationService,
    );

    await expect(checks.listByRun(ownerContext, ` ${assuranceRunId} `)).resolves.toMatchObject([
      { checkId: "check-a", organizationId, assuranceRunId },
      { checkId: "check-z", organizationId, assuranceRunId },
    ]);
    await expect(checks.listByRun(otherContext, assuranceRunId)).resolves.toEqual([]);
    expect(verifyTenantContext).toHaveBeenCalledWith(ownerContext);
    expect(verifyTenantContext).toHaveBeenCalledWith(otherContext);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY check_id ASC"), {
      organization_id: organizationId,
      assurance_run_id: assuranceRunId,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY check_id ASC"), {
      organization_id: otherContext.organizationId,
      assurance_run_id: assuranceRunId,
    });
  });
});
