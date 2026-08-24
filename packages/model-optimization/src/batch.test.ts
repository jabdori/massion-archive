import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OptimizationBatchService } from "./batch.js";

describe("모델 최적화 batch lifecycle", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let batches: OptimizationBatchService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "batch@example.com", displayName: "Batch" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    batches = await OptimizationBatchService.create(database, organizations);
  });

  afterEach(async () => database.close());

  /**
   * candidate 밖으로 batch를 승격하려면 활성 정책이 필요합니다. 정책이 없으면 주 모델·완료·privacy
   * receipt·최소 표본·개선 폭 검사가 통째로 건너뛰어지던 시절에는 이 seed 없이도 통과했습니다.
   * 승격을 검증하지 않는 테스트가 게이트를 우회하지 않도록, 통과 가능한 최소 정책을 명시적으로 심습니다.
   */
  async function seedPromotionGate(
    policyVersionId: string,
    receipts: readonly { readonly receiptId: string; readonly profileId: string; readonly roleKey: string }[],
  ): Promise<void> {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: $policy_version_id, organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: false, minimum_sample_count: 1, improvement_threshold: 0, status: 'active', checksum: $checksum, governance_decision_id: $decision_id, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        policy_version_id: policyVersionId,
        organization_id: context.organizationId,
        checksum: "9".repeat(64),
        decision_id: `decision-${policyVersionId}`,
        command_id: `${policyVersionId}-command`,
        request_hash: "8".repeat(64),
        user_id: context.userId,
      },
    );
    for (const receipt of receipts) {
      await database.query(
        "CREATE optimization_receipt CONTENT { receipt_id: $receipt_id, run_id: $run_id, organization_id: $organization_id, role_key: $role_key, model_profile_id: $model_profile_id, bundle_id: 'bundle-test', bundle_version: 1, sample_count: 1, quality_score: 0.9, latency_ms: 10, cost_micros: 1, privacy_allowed: true, completed: true, input_checksum: $input_checksum, receipt_checksum: $receipt_checksum, command_id: $command_id, request_hash: $request_hash, created_at: time::now() };",
        {
          receipt_id: receipt.receiptId,
          run_id: `run-${receipt.receiptId}`,
          organization_id: context.organizationId,
          role_key: receipt.roleKey,
          model_profile_id: receipt.profileId,
          input_checksum: "7".repeat(64),
          receipt_checksum: "6".repeat(64),
          command_id: `${receipt.receiptId}-command`,
          request_hash: "5".repeat(64),
        },
      );
    }
  }

  it("활성 정책이 없으면 candidate 밖으로 batch를 승격하지 않는다", async () => {
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-ungated', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'implicit-default', primary_model_profile_id: 'profile-ungated', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum, command_id: 'recommendation-ungated-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        user_id: context.userId,
      },
    );

    // recommend()는 정책이 없을 때 policy_version_id에 실재하지 않는 "implicit-default"를 넣습니다.
    // 예전에는 그 값으로 정책 조회가 비고 `if (policy)`가 게이트 전체를 건너뛰어, 표본도 개선 폭도
    // 확인하지 않은 batch가 limited·active로 바로 만들어졌습니다.
    for (const status of ["limited", "active"] as const) {
      await expect(
        batches.createBatch(context, {
          commandId: `batch-ungated-${status}`,
          recommendationId: "recommendation-ungated",
          status,
        }),
      ).rejects.toThrow("활성 정책");
    }
    // candidate는 승격이 아니므로 정책 없이도 만들 수 있어야 합니다.
    await expect(
      batches.createBatch(context, {
        commandId: "batch-ungated-candidate",
        recommendationId: "recommendation-ungated",
        status: "candidate",
      }),
    ).resolves.toMatchObject({ status: "candidate" });
  });

  it("승인된 추천만 immutable version batch로 원자 활성화한다", async () => {
    await seedPromotionGate("policy-1", [{ receiptId: "receipt-1", profileId: "profile-1", roleKey: "assurance" }]);
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-1', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-1', fallback_model_profile_ids: ['profile-2'], excluded_json: '[]', receipt_ids: ['receipt-1'], status: 'pending-approval', checksum: $checksum, command_id: 'recommendation-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        user_id: context.userId,
      },
    );
    const approved = await batches.approveRecommendation(context, {
      commandId: "approve-1",
      recommendationId: "recommendation-1",
      recommendationChecksum: "a".repeat(64),
      governanceDecisionId: "decision-1",
    });
    expect(approved.status).toBe("approved");
    const candidate = await batches.createBatch(context, {
      commandId: "batch-1",
      recommendationId: approved.recommendationId,
      status: "limited",
    });
    await expect(
      batches.createBatch(context, {
        commandId: "batch-1",
        recommendationId: approved.recommendationId,
        status: "limited",
      }),
    ).resolves.toEqual(candidate);
    await expect(
      batches.createBatch(context, {
        commandId: "batch-1",
        recommendationId: approved.recommendationId,
        status: "shadow",
      }),
    ).rejects.toThrow("같은 commandId");
    expect(candidate.status).toBe("limited");
    const active = await batches.activateBatch(context, { commandId: "activate-1", batchId: candidate.batchId });
    await expect(
      batches.activateBatch(context, { commandId: "activate-1", batchId: candidate.batchId }),
    ).resolves.toEqual(active);
    expect(active.status).toBe("active");
    expect(await batches.getActiveBatch(context, "assurance")).toMatchObject({
      batchId: candidate.batchId,
      status: "active",
    });
  });

  it("이미 승인된 추천은 동일 Governance decision 계보만 재시도한다", async () => {
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-lineage', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-1', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'pending-approval', checksum: $checksum, command_id: 'recommendation-lineage-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        user_id: context.userId,
      },
    );

    await expect(
      batches.approveRecommendation(context, {
        commandId: "approve-lineage-stale",
        recommendationId: "recommendation-lineage",
        recommendationChecksum: "c".repeat(64),
        governanceDecisionId: "decision-lineage",
      }),
    ).rejects.toThrow("checksum precondition");
    const approved = await batches.approveRecommendation(context, {
      commandId: "approve-lineage-first",
      recommendationId: "recommendation-lineage",
      recommendationChecksum: "a".repeat(64),
      governanceDecisionId: "decision-lineage",
    });
    await expect(
      batches.approveRecommendation(context, {
        commandId: "approve-lineage-replay",
        recommendationId: "recommendation-lineage",
        recommendationChecksum: "a".repeat(64),
        governanceDecisionId: "decision-lineage",
      }),
    ).resolves.toEqual(approved);
    await expect(
      batches.approveRecommendation(context, {
        commandId: "approve-lineage-forged",
        recommendationId: "recommendation-lineage",
        recommendationChecksum: "a".repeat(64),
        governanceDecisionId: "decision-forged",
      }),
    ).rejects.toThrow("Governance decision 계보");
  });

  it("같은 role의 세 번째 batch도 transaction 안에서 가장 큰 version 다음에 생성한다", async () => {
    await seedPromotionGate(
      "policy-versioning",
      [1, 2, 3].map((index) => ({
        receiptId: `receipt-versioning-${String(index)}`,
        profileId: `profile-versioning-${String(index)}`,
        roleKey: "assurance",
      })),
    );
    const batchIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      await database.query(
        "CREATE optimization_recommendation CONTENT { recommendation_id: $recommendation_id, organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-versioning', primary_model_profile_id: $profile_id, fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [$receipt_id], status: 'approved', checksum: $checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
        {
          recommendation_id: `recommendation-versioning-${String(index)}`,
          organization_id: context.organizationId,
          profile_id: `profile-versioning-${String(index)}`,
          receipt_id: `receipt-versioning-${String(index)}`,
          checksum: `${String(index).repeat(64)}`,
          command_id: `recommendation-versioning-command-${String(index)}`,
          request_hash: `${String(index).repeat(64)}`,
          user_id: context.userId,
        },
      );
      const batch = await batches.createBatch(context, {
        commandId: `batch-versioning-${String(index)}`,
        recommendationId: `recommendation-versioning-${String(index)}`,
        status: "active",
      });
      batchIds.push(batch.batchId);
      await batches.activateBatch(context, {
        commandId: `activate-versioning-${String(index)}`,
        batchId: batch.batchId,
      });
      expect(batch.version).toBe(index);
    }
    expect(new Set(batchIds).size).toBe(3);
  });

  it("표본·개선폭 게이트를 거치지 않은 candidate batch는 활성화하지 않는다", async () => {
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-candidate', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-candidate', primary_model_profile_id: 'profile-candidate', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum, command_id: 'recommendation-candidate-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        user_id: context.userId,
      },
    );
    const candidate = await batches.createBatch(context, {
      commandId: "batch-candidate",
      recommendationId: "recommendation-candidate",
      status: "candidate",
    });

    await expect(
      batches.activateBatch(context, { commandId: "activate-candidate", batchId: candidate.batchId }),
    ).rejects.toThrow("candidate");
  });

  it("shadow 동의가 없는 정책에서는 shadow batch를 만들지 않는다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-shadow-off', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: false, minimum_sample_count: 1, improvement_threshold: 0, status: 'active', checksum: $checksum, governance_decision_id: 'decision-shadow-off', command_id: 'policy-shadow-off-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-shadow-off', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-shadow-off', primary_model_profile_id: 'profile-shadow-off', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-shadow-off'], status: 'approved', checksum: $checksum2, command_id: 'recommendation-shadow-off-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_receipt CONTENT { receipt_id: 'receipt-shadow-off', run_id: 'run-shadow-off', organization_id: $organization_id, role_key: 'assurance', model_profile_id: 'profile-shadow-off', bundle_id: 'bundle-test', bundle_version: 1, sample_count: 1, quality_score: 0.9, latency_ms: 10, cost_micros: 1, privacy_allowed: true, completed: true, input_checksum: $checksum3, receipt_checksum: $checksum4, command_id: 'receipt-shadow-off-command', request_hash: $request_hash3, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        checksum3: "e".repeat(64),
        checksum4: "f".repeat(64),
        request_hash3: "1".repeat(64),
        user_id: context.userId,
      },
    );

    await expect(
      batches.createBatch(context, {
        commandId: "batch-shadow-off",
        recommendationId: "recommendation-shadow-off",
        status: "shadow",
      }),
    ).rejects.toThrow("shadow");
  });

  it("degraded 관측은 실행 중 batch를 자동으로 이전 healthy batch로 복구한다", async () => {
    await seedPromotionGate("policy-1", [
      { receiptId: "receipt-old", profileId: "profile-old", roleKey: "growth" },
      { receiptId: "receipt-new", profileId: "profile-new", roleKey: "growth" },
    ]);
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-old', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-old', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-old'], status: 'approved', checksum: $checksum, command_id: 'recommendation-old-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-new', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-new', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-new'], status: 'approved', checksum: $checksum2, command_id: 'recommendation-new-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        user_id: context.userId,
      },
    );
    const oldBatch = await batches.createBatch(context, {
      commandId: "batch-old",
      recommendationId: "recommendation-old",
      status: "active",
    });
    await batches.activateBatch(context, { commandId: "activate-old", batchId: oldBatch.batchId });
    const newBatch = await batches.createBatch(context, {
      commandId: "batch-new",
      recommendationId: "recommendation-new",
      status: "limited",
    });
    await batches.activateBatch(context, { commandId: "activate-new", batchId: newBatch.batchId });
    const observation = await batches.recordObservation(context, {
      commandId: "observation-1",
      batchId: newBatch.batchId,
      sampleCount: 10,
      qualityScore: 0.2,
      latencyMs: 1000,
      costMicros: 100,
      status: "degraded",
    });
    await expect(
      batches.recordObservation(context, {
        commandId: "observation-1",
        batchId: newBatch.batchId,
        sampleCount: 10,
        qualityScore: 0.2,
        latencyMs: 1000,
        costMicros: 100,
        status: "degraded",
      }),
    ).resolves.toEqual(observation);
    await expect(
      batches.recordObservation(context, {
        commandId: "observation-1",
        batchId: newBatch.batchId,
        sampleCount: 11,
        qualityScore: 0.2,
        latencyMs: 1000,
        costMicros: 100,
        status: "degraded",
      }),
    ).rejects.toThrow("같은 commandId");
    await database.query("REMOVE EVENT optimization_observation_immutable ON TABLE optimization_observation;");
    await database.query(
      "UPDATE optimization_observation SET expires_at = $expires_at WHERE organization_id = $organization_id AND observation_id = $observation_id;",
      {
        organization_id: context.organizationId,
        observation_id: observation.observationId,
        expires_at: new Date(Date.now() - 1_000),
      },
    );
    await expect(
      batches.recover(context, {
        commandId: "recovery-expired",
        observationId: observation.observationId,
      }),
    ).rejects.toThrow("만료된 observation으로 복구할 수 없습니다");
    expect(await batches.getActiveBatch(context, "growth")).toMatchObject({
      batchId: newBatch.batchId,
      status: "active",
    });
    await database.query(
      "UPDATE optimization_observation SET expires_at = $expires_at WHERE organization_id = $organization_id AND observation_id = $observation_id;",
      {
        organization_id: context.organizationId,
        observation_id: observation.observationId,
        expires_at: new Date(Date.now() + 60_000),
      },
    );
    const recovery = await batches.recover(context, {
      commandId: "recovery-1",
      observationId: observation.observationId,
    });
    await expect(
      batches.recover(context, {
        commandId: "recovery-1",
        observationId: observation.observationId,
      }),
    ).resolves.toEqual(recovery);
    await expect(
      batches.recover(context, {
        commandId: "recovery-1",
        observationId: "other-observation",
      }),
    ).rejects.toThrow("같은 commandId");
    expect(recovery.toBatchId).toBe(oldBatch.batchId);
    expect(await batches.getActiveBatch(context, "growth")).toMatchObject({
      batchId: oldBatch.batchId,
      status: "active",
    });
  });

  it("현재 활성 batch가 아닌 observation으로 최신 pointer를 되돌리지 않는다", async () => {
    await seedPromotionGate("policy-current", [
      { receiptId: "receipt-current-old", profileId: "profile-current-old", roleKey: "growth" },
      { receiptId: "receipt-current-middle", profileId: "profile-current-middle", roleKey: "growth" },
      { receiptId: "receipt-current-new", profileId: "profile-current-new", roleKey: "growth" },
    ]);
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-current-old', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-current', primary_model_profile_id: 'profile-current-old', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-current-old'], status: 'approved', checksum: $checksum1, command_id: 'recommendation-current-old-command', request_hash: $request_hash1, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-current-middle', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-current', primary_model_profile_id: 'profile-current-middle', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-current-middle'], status: 'approved', checksum: $checksum2, command_id: 'recommendation-current-middle-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-current-new', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-current', primary_model_profile_id: 'profile-current-new', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-current-new'], status: 'approved', checksum: $checksum3, command_id: 'recommendation-current-new-command', request_hash: $request_hash3, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum1: "a".repeat(64),
        request_hash1: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        checksum3: "e".repeat(64),
        request_hash3: "f".repeat(64),
        user_id: context.userId,
      },
    );
    const oldBatch = await batches.createBatch(context, {
      commandId: "batch-current-old",
      recommendationId: "recommendation-current-old",
      status: "active",
    });
    await batches.activateBatch(context, { commandId: "activate-current-old", batchId: oldBatch.batchId });
    const middleBatch = await batches.createBatch(context, {
      commandId: "batch-current-middle",
      recommendationId: "recommendation-current-middle",
      status: "limited",
    });
    await batches.activateBatch(context, { commandId: "activate-current-middle", batchId: middleBatch.batchId });
    const observation = await batches.recordObservation(context, {
      commandId: "observation-current-middle",
      batchId: middleBatch.batchId,
      sampleCount: 10,
      qualityScore: 0.2,
      latencyMs: 1_000,
      costMicros: 100,
      status: "degraded",
    });
    const newBatch = await batches.createBatch(context, {
      commandId: "batch-current-new",
      recommendationId: "recommendation-current-new",
      status: "limited",
    });
    await batches.activateBatch(context, { commandId: "activate-current-new", batchId: newBatch.batchId });

    await expect(
      batches.recover(context, {
        commandId: "recovery-current-mismatch",
        observationId: observation.observationId,
      }),
    ).rejects.toThrow("현재 활성 batch");
    expect(await batches.getActiveBatch(context, "growth")).toMatchObject({
      batchId: newBatch.batchId,
      status: "active",
    });
  });

  it("정책이 요구한 최소 표본을 채우지 못한 추천은 제한 batch로 승격하지 않는다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-gated', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: true, minimum_sample_count: 3, improvement_threshold: 0.1, status: 'active', checksum: $checksum, governance_decision_id: 'decision-gated', command_id: 'policy-gated-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-gated', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-gated', primary_model_profile_id: 'profile-gated', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-gated'], status: 'approved', checksum: $checksum2, command_id: 'recommendation-gated-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_receipt CONTENT { receipt_id: 'receipt-gated', run_id: 'run-gated', organization_id: $organization_id, role_key: 'growth', model_profile_id: 'profile-gated', bundle_id: 'bundle-test', bundle_version: 1, sample_count: 1, quality_score: 0.9, latency_ms: 100, cost_micros: 10, privacy_allowed: true, completed: true, input_checksum: $checksum3, receipt_checksum: $checksum4, command_id: 'receipt-gated-command', request_hash: $request_hash3, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        checksum3: "e".repeat(64),
        checksum4: "f".repeat(64),
        request_hash3: "1".repeat(64),
        user_id: context.userId,
      },
    );

    await expect(
      batches.createBatch(context, {
        commandId: "batch-gated",
        recommendationId: "recommendation-gated",
        status: "limited",
      }),
    ).rejects.toThrow("최소 표본");
  });

  it("production learning 동의가 없으면 실사용 observation을 기록하지 않는다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-production-off', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: true, minimum_sample_count: 1, improvement_threshold: 0, status: 'active', checksum: $checksum, governance_decision_id: 'decision-production-off', command_id: 'policy-production-off-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-production-off', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-production-off', primary_model_profile_id: 'profile-production-off', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum2, command_id: 'recommendation-production-off-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        user_id: context.userId,
      },
    );
    const batch = await batches.createBatch(context, {
      commandId: "batch-production-off",
      recommendationId: "recommendation-production-off",
      status: "candidate",
    });
    await expect(
      batches.recordObservation(context, {
        commandId: "observation-production-off",
        batchId: batch.batchId,
        sampleCount: 1,
        qualityScore: 0.9,
        latencyMs: 100,
        costMicros: 10,
        status: "healthy",
        source: "production",
      }),
    ).rejects.toThrow("production learning");
  });

  it("실사용 observation은 정책별 예산을 넘지 않고 보존 만료 시각을 기록한다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-budget', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: true, shadow_enabled: false, minimum_sample_count: 1, improvement_threshold: 0, observation_budget_micros: 100, observation_retention_days: 7, status: 'active', checksum: $checksum, governance_decision_id: 'decision-budget', command_id: 'policy-budget-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-budget', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-budget', primary_model_profile_id: 'profile-budget', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum2, command_id: 'recommendation-budget-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        user_id: context.userId,
      },
    );
    const batch = await batches.createBatch(context, {
      commandId: "batch-budget",
      recommendationId: "recommendation-budget",
      status: "candidate",
    });
    const first = await batches.recordObservation(context, {
      commandId: "observation-budget-first",
      batchId: batch.batchId,
      sampleCount: 1,
      qualityScore: 0.9,
      latencyMs: 100,
      costMicros: 60,
      status: "healthy",
      source: "production",
    });
    expect(first).toMatchObject({ source: "production", policyVersionId: "policy-budget" });
    expect(typeof (first as unknown as { expiresAt?: unknown }).expiresAt).toBe("string");
    await expect(
      batches.recordObservation(context, {
        commandId: "observation-budget-over",
        batchId: batch.batchId,
        sampleCount: 1,
        qualityScore: 0.9,
        latencyMs: 100,
        costMicros: 41,
        status: "healthy",
        source: "production",
      }),
    ).rejects.toThrow("예산");
  });
});
