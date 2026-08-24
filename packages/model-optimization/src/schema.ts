import { defineMigration } from "@massion/storage";

export const MODEL_OPTIMIZATION_MIGRATION = defineMigration(
  "0103-model-optimization",
  `
DEFINE TABLE optimization_bundle SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD bundle_id ON optimization_bundle TYPE string;
DEFINE FIELD organization_id ON optimization_bundle TYPE string;
DEFINE FIELD role_key ON optimization_bundle TYPE string;
DEFINE FIELD version ON optimization_bundle TYPE int ASSERT $value >= 1;
DEFINE FIELD case_ids ON optimization_bundle TYPE array<string>;
DEFINE FIELD runtime_version ON optimization_bundle TYPE string;
DEFINE FIELD checksum ON optimization_bundle TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD status ON optimization_bundle TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD command_id ON optimization_bundle TYPE string;
DEFINE FIELD request_hash ON optimization_bundle TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON optimization_bundle TYPE datetime;
DEFINE INDEX optimization_bundle_id ON optimization_bundle FIELDS organization_id, bundle_id UNIQUE;
DEFINE INDEX optimization_bundle_version ON optimization_bundle FIELDS organization_id, role_key, version UNIQUE;

DEFINE TABLE optimization_case SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD case_id ON optimization_case TYPE string;
DEFINE FIELD organization_id ON optimization_case TYPE string;
DEFINE FIELD role_key ON optimization_case TYPE string;
DEFINE FIELD version ON optimization_case TYPE int ASSERT $value >= 1;
DEFINE FIELD prompt_checksum ON optimization_case TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD tools_checksum ON optimization_case TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD environment_checksum ON optimization_case TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD expected_outcome ON optimization_case TYPE string;
DEFINE FIELD created_at ON optimization_case TYPE datetime;
DEFINE INDEX optimization_case_id ON optimization_case FIELDS organization_id, case_id UNIQUE;

DEFINE TABLE optimization_policy_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD policy_version_id ON optimization_policy_version TYPE string;
DEFINE FIELD organization_id ON optimization_policy_version TYPE string;
DEFINE FIELD version ON optimization_policy_version TYPE int ASSERT $value >= 1;
DEFINE FIELD policy ON optimization_policy_version TYPE string ASSERT $value IN ['quality', 'value', 'speed', 'privacy', 'manual'];
DEFINE FIELD auto_optimize ON optimization_policy_version TYPE bool;
DEFINE FIELD production_learning ON optimization_policy_version TYPE bool;
DEFINE FIELD shadow_enabled ON optimization_policy_version TYPE bool;
DEFINE FIELD minimum_sample_count ON optimization_policy_version TYPE int ASSERT $value >= 1;
DEFINE FIELD improvement_threshold ON optimization_policy_version TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD observation_budget_micros ON optimization_policy_version TYPE option<float> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD observation_retention_days ON optimization_policy_version TYPE option<int> ASSERT $value = NONE OR ($value >= 1 AND $value <= 3650);
DEFINE FIELD status ON optimization_policy_version TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD checksum ON optimization_policy_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD governance_decision_id ON optimization_policy_version TYPE string;
DEFINE FIELD command_id ON optimization_policy_version TYPE string;
DEFINE FIELD request_hash ON optimization_policy_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON optimization_policy_version TYPE string;
DEFINE FIELD created_at ON optimization_policy_version TYPE datetime;
DEFINE FIELD superseded_at ON optimization_policy_version TYPE option<datetime>;
DEFINE INDEX optimization_policy_id ON optimization_policy_version FIELDS organization_id, policy_version_id UNIQUE;
DEFINE INDEX optimization_policy_version ON optimization_policy_version FIELDS organization_id, version UNIQUE;
DEFINE INDEX optimization_policy_active ON optimization_policy_version FIELDS organization_id, status;

DEFINE TABLE optimization_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD run_id ON optimization_run TYPE string;
DEFINE FIELD organization_id ON optimization_run TYPE string;
DEFINE FIELD role_key ON optimization_run TYPE string;
DEFINE FIELD bundle_id ON optimization_run TYPE string;
DEFINE FIELD bundle_version ON optimization_run TYPE int ASSERT $value >= 1;
DEFINE FIELD model_profile_id ON optimization_run TYPE string;
DEFINE FIELD runtime_version ON optimization_run TYPE string;
DEFINE FIELD mode ON optimization_run TYPE string ASSERT $value IN ['standard', 'shadow'];
DEFINE FIELD status ON optimization_run TYPE string ASSERT $value IN ['running', 'completed', 'failed', 'cancelled'];
DEFINE FIELD input_checksum ON optimization_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON optimization_run TYPE string;
DEFINE FIELD request_hash ON optimization_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON optimization_run TYPE string;
DEFINE FIELD created_at ON optimization_run TYPE datetime;
DEFINE FIELD updated_at ON optimization_run TYPE datetime;
DEFINE INDEX optimization_run_id ON optimization_run FIELDS organization_id, run_id UNIQUE;
DEFINE INDEX optimization_run_command ON optimization_run FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE optimization_receipt SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD receipt_id ON optimization_receipt TYPE string;
DEFINE FIELD run_id ON optimization_receipt TYPE string;
DEFINE FIELD organization_id ON optimization_receipt TYPE string;
DEFINE FIELD role_key ON optimization_receipt TYPE string;
DEFINE FIELD model_profile_id ON optimization_receipt TYPE string;
DEFINE FIELD bundle_version ON optimization_receipt TYPE int ASSERT $value >= 1;
DEFINE FIELD sample_count ON optimization_receipt TYPE int ASSERT $value >= 0;
DEFINE FIELD quality_score ON optimization_receipt TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD latency_ms ON optimization_receipt TYPE float ASSERT $value >= 0;
DEFINE FIELD cost_micros ON optimization_receipt TYPE float ASSERT $value >= 0;
DEFINE FIELD privacy_allowed ON optimization_receipt TYPE bool;
DEFINE FIELD completed ON optimization_receipt TYPE bool;
DEFINE FIELD input_checksum ON optimization_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD receipt_checksum ON optimization_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON optimization_receipt TYPE string;
DEFINE FIELD request_hash ON optimization_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON optimization_receipt TYPE datetime;
DEFINE INDEX optimization_receipt_id ON optimization_receipt FIELDS organization_id, receipt_id UNIQUE;
DEFINE INDEX optimization_receipt_command ON optimization_receipt FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT optimization_receipt_immutable ON TABLE optimization_receipt WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Optimization receipt는 immutable입니다'; };

DEFINE TABLE optimization_recommendation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD recommendation_id ON optimization_recommendation TYPE string;
DEFINE FIELD organization_id ON optimization_recommendation TYPE string;
DEFINE FIELD role_key ON optimization_recommendation TYPE string;
DEFINE FIELD policy_version_id ON optimization_recommendation TYPE string;
DEFINE FIELD primary_model_profile_id ON optimization_recommendation TYPE option<string>;
DEFINE FIELD fallback_model_profile_ids ON optimization_recommendation TYPE array<string>;
DEFINE FIELD excluded_json ON optimization_recommendation TYPE string;
DEFINE FIELD receipt_ids ON optimization_recommendation TYPE array<string>;
DEFINE FIELD status ON optimization_recommendation TYPE string ASSERT $value IN ['pending-approval', 'approved', 'rejected', 'superseded'];
DEFINE FIELD governance_decision_id ON optimization_recommendation TYPE option<string>;
DEFINE FIELD checksum ON optimization_recommendation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON optimization_recommendation TYPE string;
DEFINE FIELD request_hash ON optimization_recommendation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON optimization_recommendation TYPE string;
DEFINE FIELD created_at ON optimization_recommendation TYPE datetime;
DEFINE INDEX optimization_recommendation_id ON optimization_recommendation FIELDS organization_id, recommendation_id UNIQUE;
DEFINE INDEX optimization_recommendation_command ON optimization_recommendation FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE optimization_batch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD batch_id ON optimization_batch TYPE string;
DEFINE FIELD organization_id ON optimization_batch TYPE string;
DEFINE FIELD role_key ON optimization_batch TYPE string;
DEFINE FIELD version ON optimization_batch TYPE int ASSERT $value >= 1;
DEFINE FIELD recommendation_id ON optimization_batch TYPE string;
DEFINE FIELD policy_version_id ON optimization_batch TYPE string;
DEFINE FIELD status ON optimization_batch TYPE string ASSERT $value IN ['candidate', 'shadow', 'limited', 'active', 'reverted'];
DEFINE FIELD primary_model_profile_id ON optimization_batch TYPE option<string>;
DEFINE FIELD fallback_model_profile_ids ON optimization_batch TYPE array<string>;
DEFINE FIELD parent_batch_id ON optimization_batch TYPE option<string>;
DEFINE FIELD checksum ON optimization_batch TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON optimization_batch TYPE string;
DEFINE FIELD request_hash ON optimization_batch TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON optimization_batch TYPE string;
DEFINE FIELD created_at ON optimization_batch TYPE datetime;
DEFINE FIELD activated_at ON optimization_batch TYPE option<datetime>;
DEFINE INDEX optimization_batch_id ON optimization_batch FIELDS organization_id, batch_id UNIQUE;
DEFINE INDEX optimization_batch_version ON optimization_batch FIELDS organization_id, role_key, version UNIQUE;

DEFINE TABLE optimization_active_pointer SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD pointer_id ON optimization_active_pointer TYPE string;
DEFINE FIELD organization_id ON optimization_active_pointer TYPE string;
DEFINE FIELD role_key ON optimization_active_pointer TYPE string;
DEFINE FIELD batch_id ON optimization_active_pointer TYPE string;
DEFINE FIELD batch_version ON optimization_active_pointer TYPE int ASSERT $value >= 1;
DEFINE FIELD checksum ON optimization_active_pointer TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD updated_at ON optimization_active_pointer TYPE datetime;
DEFINE INDEX optimization_active_pointer_role ON optimization_active_pointer FIELDS organization_id, role_key UNIQUE;

DEFINE TABLE optimization_observation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD observation_id ON optimization_observation TYPE string;
DEFINE FIELD organization_id ON optimization_observation TYPE string;
DEFINE FIELD batch_id ON optimization_observation TYPE string;
DEFINE FIELD sample_count ON optimization_observation TYPE int ASSERT $value >= 0;
DEFINE FIELD quality_score ON optimization_observation TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD latency_ms ON optimization_observation TYPE float ASSERT $value >= 0;
DEFINE FIELD cost_micros ON optimization_observation TYPE float ASSERT $value >= 0;
DEFINE FIELD status ON optimization_observation TYPE string ASSERT $value IN ['healthy', 'degraded'];
DEFINE FIELD policy_version_id ON optimization_observation TYPE option<string>;
DEFINE FIELD expires_at ON optimization_observation TYPE option<datetime>;
DEFINE FIELD checksum ON optimization_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON optimization_observation TYPE string;
DEFINE FIELD request_hash ON optimization_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON optimization_observation TYPE datetime;
DEFINE INDEX optimization_observation_id ON optimization_observation FIELDS organization_id, observation_id UNIQUE;
DEFINE EVENT optimization_observation_immutable ON TABLE optimization_observation WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Optimization observation은 immutable입니다'; };

DEFINE TABLE optimization_recovery SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD recovery_id ON optimization_recovery TYPE string;
DEFINE FIELD organization_id ON optimization_recovery TYPE string;
DEFINE FIELD role_key ON optimization_recovery TYPE string;
DEFINE FIELD from_batch_id ON optimization_recovery TYPE string;
DEFINE FIELD to_batch_id ON optimization_recovery TYPE string;
DEFINE FIELD reason ON optimization_recovery TYPE string;
DEFINE FIELD observation_id ON optimization_recovery TYPE string;
DEFINE FIELD command_id ON optimization_recovery TYPE string;
DEFINE FIELD request_hash ON optimization_recovery TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON optimization_recovery TYPE datetime;
DEFINE INDEX optimization_recovery_id ON optimization_recovery FIELDS organization_id, recovery_id UNIQUE;
DEFINE EVENT optimization_recovery_immutable ON TABLE optimization_recovery WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Optimization recovery는 immutable입니다'; };
`,
);

export const MODEL_OPTIMIZATION_HARDENING_MIGRATION = defineMigration(
  "0104-model-optimization-hardening",
  `
DEFINE FIELD source ON optimization_observation TYPE string ASSERT $value IN ['evaluation', 'production'];
DEFINE FIELD prompt ON optimization_case TYPE option<string>;
DEFINE FIELD OVERWRITE observation_budget_micros ON optimization_policy_version TYPE option<float> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD OVERWRITE observation_retention_days ON optimization_policy_version TYPE option<int> ASSERT $value = NONE OR ($value >= 1 AND $value <= 3650);
DEFINE FIELD OVERWRITE policy_version_id ON optimization_observation TYPE option<string>;
DEFINE FIELD OVERWRITE expires_at ON optimization_observation TYPE option<datetime>;
DEFINE INDEX optimization_observation_command ON optimization_observation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX optimization_batch_command ON optimization_batch FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX optimization_recovery_command ON optimization_recovery FIELDS organization_id, command_id UNIQUE;
`,
);

/**
 * 기존 receipt는 생성 당시의 run만 가리켜, 서로 다른 평가 묶음의 점수를 한 추천에서 섞을 수 있었습니다.
 * run의 tenant·역할·profile·version 계보가 완전한 경우에만 bundle ID를 한 번 보강하고 다시 immutable로 잠급니다.
 */
export const MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION = defineMigration(
  "0126-model-optimization-receipt-bundle-lineage",
  `
DEFINE FIELD bundle_id ON optimization_receipt TYPE option<string>;
REMOVE EVENT optimization_receipt_immutable ON TABLE optimization_receipt;
UPDATE optimization_receipt SET bundle_id = {
  LET $organization_id = organization_id;
  LET $run_id = run_id;
  LET $role_key = role_key;
  LET $model_profile_id = model_profile_id;
  LET $bundle_version = bundle_version;
  LET $runs = (
    SELECT VALUE bundle_id FROM optimization_run
    WHERE organization_id = $organization_id
      AND run_id = $run_id
      AND role_key = $role_key
      AND model_profile_id = $model_profile_id
      AND bundle_version = $bundle_version
  );
  IF array::len($runs) != 1 {
    THROW 'Optimization receipt의 evaluation run bundle 계보가 유효하지 않습니다';
  };
  RETURN array::first($runs);
} RETURN NONE;
DEFINE FIELD OVERWRITE bundle_id ON optimization_receipt TYPE string ASSERT string::len($value) > 0;
DEFINE EVENT optimization_receipt_immutable ON TABLE optimization_receipt
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Optimization receipt는 immutable입니다'; };
`,
);

/**
 * 축별 점수는 새 평가 실행에서만 생성합니다. 과거 case·receipt를 추정해 backfill하면
 * 당시 실행 결과에 없던 작업 성격을 사실처럼 만들게 되므로, 없는 근거는 역할 baseline으로 남깁니다.
 */
export const MODEL_OPTIMIZATION_TASK_AXIS_SCORE_MIGRATION = defineMigration(
  "0127-model-optimization-task-axis-score",
  `
DEFINE FIELD task_axis ON optimization_case TYPE option<string>
  ASSERT $value = NONE OR $value IN ['code-generation', 'code-understanding', 'planning-design', 'review-critique', 'summary-records'];
DEFINE FIELD reasoning_difficulty ON optimization_case TYPE option<string>
  ASSERT $value = NONE OR $value IN ['low', 'medium', 'high'];

DEFINE TABLE optimization_receipt_axis_score SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD score_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD organization_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD receipt_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD run_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD role_key ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD model_profile_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD bundle_id ON optimization_receipt_axis_score TYPE string;
DEFINE FIELD bundle_version ON optimization_receipt_axis_score TYPE int ASSERT $value >= 1;
DEFINE FIELD task_axis ON optimization_receipt_axis_score TYPE string
  ASSERT $value IN ['code-generation', 'code-understanding', 'planning-design', 'review-critique', 'summary-records'];
DEFINE FIELD reasoning_difficulty ON optimization_receipt_axis_score TYPE string
  ASSERT $value IN ['low', 'medium', 'high'];
DEFINE FIELD sample_count ON optimization_receipt_axis_score TYPE int ASSERT $value >= 1;
DEFINE FIELD quality_score ON optimization_receipt_axis_score TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD latency_ms ON optimization_receipt_axis_score TYPE float ASSERT $value >= 0;
DEFINE FIELD cost_micros ON optimization_receipt_axis_score TYPE float ASSERT $value >= 0;
DEFINE FIELD privacy_allowed ON optimization_receipt_axis_score TYPE bool;
DEFINE FIELD completed ON optimization_receipt_axis_score TYPE bool;
DEFINE FIELD score_checksum ON optimization_receipt_axis_score TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON optimization_receipt_axis_score TYPE datetime;
DEFINE INDEX optimization_receipt_axis_score_id ON optimization_receipt_axis_score FIELDS organization_id, score_id UNIQUE;
DEFINE INDEX optimization_receipt_axis_score_receipt_axis ON optimization_receipt_axis_score FIELDS organization_id, receipt_id, task_axis, reasoning_difficulty UNIQUE;
DEFINE INDEX optimization_receipt_axis_score_lookup ON optimization_receipt_axis_score FIELDS organization_id, role_key, bundle_id, bundle_version, task_axis, reasoning_difficulty, model_profile_id;
DEFINE EVENT optimization_receipt_axis_score_immutable ON TABLE optimization_receipt_axis_score
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Optimization receipt axis score는 immutable입니다'; };
`,
);
