import { defineMigration } from "@massion/storage";

export const ROUTER_REGISTRY_MIGRATION = defineMigration(
  "0009-router-registry",
  `
DEFINE TABLE model_provider SCHEMAFULL;
DEFINE FIELD provider_id ON model_provider TYPE string;
DEFINE FIELD organization_id ON model_provider TYPE string;
DEFINE FIELD display_name ON model_provider TYPE string;
DEFINE FIELD adapter_kind ON model_provider TYPE string;
DEFINE FIELD enabled ON model_provider TYPE bool;
DEFINE FIELD created_at ON model_provider TYPE datetime;
DEFINE FIELD updated_at ON model_provider TYPE datetime;
DEFINE INDEX model_provider_id ON model_provider FIELDS organization_id, provider_id UNIQUE;

DEFINE TABLE provider_endpoint SCHEMAFULL;
DEFINE FIELD endpoint_id ON provider_endpoint TYPE string;
DEFINE FIELD organization_id ON provider_endpoint TYPE string;
DEFINE FIELD provider_id ON provider_endpoint TYPE string;
DEFINE FIELD name ON provider_endpoint TYPE string;
DEFINE FIELD base_url ON provider_endpoint TYPE string;
DEFINE FIELD local ON provider_endpoint TYPE bool;
DEFINE FIELD gateway_kind ON provider_endpoint TYPE option<string>;
DEFINE FIELD enabled ON provider_endpoint TYPE bool;
DEFINE FIELD created_at ON provider_endpoint TYPE datetime;
DEFINE FIELD updated_at ON provider_endpoint TYPE datetime;
DEFINE INDEX provider_endpoint_id ON provider_endpoint FIELDS endpoint_id UNIQUE;
DEFINE INDEX provider_endpoint_name ON provider_endpoint FIELDS organization_id, provider_id, name UNIQUE;

DEFINE TABLE provider_credential SCHEMAFULL;
DEFINE FIELD credential_id ON provider_credential TYPE string;
DEFINE FIELD organization_id ON provider_credential TYPE string;
DEFINE FIELD provider_id ON provider_credential TYPE string;
DEFINE FIELD endpoint_id ON provider_credential TYPE string;
DEFINE FIELD label ON provider_credential TYPE string;
DEFINE FIELD credential_type ON provider_credential TYPE string;
DEFINE FIELD status ON provider_credential TYPE string;
DEFINE FIELD version ON provider_credential TYPE int;
DEFINE FIELD secret_version ON provider_credential TYPE int;
DEFINE FIELD priority ON provider_credential TYPE int;
DEFINE FIELD weight ON provider_credential TYPE int;
DEFINE FIELD request_count ON provider_credential TYPE int;
DEFINE FIELD input_tokens ON provider_credential TYPE int;
DEFINE FIELD output_tokens ON provider_credential TYPE int;
DEFINE FIELD cost_micros ON provider_credential TYPE int;
DEFINE FIELD quota_limit ON provider_credential TYPE option<int>;
DEFINE FIELD quota_remaining ON provider_credential TYPE option<int>;
DEFINE FIELD quota_reset_at ON provider_credential TYPE option<datetime>;
DEFINE FIELD cooldown_until ON provider_credential TYPE option<datetime>;
DEFINE FIELD last_selected_sequence ON provider_credential TYPE int;
DEFINE FIELD created_at ON provider_credential TYPE datetime;
DEFINE FIELD updated_at ON provider_credential TYPE datetime;
DEFINE INDEX provider_credential_id ON provider_credential FIELDS credential_id UNIQUE;
DEFINE INDEX provider_credential_label ON provider_credential FIELDS organization_id, provider_id, endpoint_id, label UNIQUE;

DEFINE TABLE credential_secret_version SCHEMAFULL;
DEFINE FIELD secret_version_id ON credential_secret_version TYPE string;
DEFINE FIELD organization_id ON credential_secret_version TYPE string;
DEFINE FIELD credential_id ON credential_secret_version TYPE string;
DEFINE FIELD version ON credential_secret_version TYPE int;
DEFINE FIELD algorithm ON credential_secret_version TYPE string;
DEFINE FIELD ciphertext ON credential_secret_version TYPE string;
DEFINE FIELD iv ON credential_secret_version TYPE string;
DEFINE FIELD auth_tag ON credential_secret_version TYPE string;
DEFINE FIELD aad ON credential_secret_version TYPE string;
DEFINE FIELD created_by ON credential_secret_version TYPE string;
DEFINE FIELD created_at ON credential_secret_version TYPE datetime;
DEFINE INDEX credential_secret_version_id ON credential_secret_version FIELDS secret_version_id UNIQUE;
DEFINE INDEX credential_secret_version_number ON credential_secret_version FIELDS organization_id, credential_id, version UNIQUE;

DEFINE TABLE router_audit_event SCHEMAFULL;
DEFINE FIELD audit_event_id ON router_audit_event TYPE string;
DEFINE FIELD organization_id ON router_audit_event TYPE string;
DEFINE FIELD command_id ON router_audit_event TYPE string;
DEFINE FIELD event_type ON router_audit_event TYPE string;
DEFINE FIELD actor_user_id ON router_audit_event TYPE string;
DEFINE FIELD request_json ON router_audit_event TYPE string;
DEFINE FIELD result_json ON router_audit_event TYPE string;
DEFINE FIELD created_at ON router_audit_event TYPE datetime;
DEFINE INDEX router_audit_event_id ON router_audit_event FIELDS audit_event_id UNIQUE;
DEFINE INDEX router_audit_command ON router_audit_event FIELDS organization_id, command_id UNIQUE;
`,
);

export const MODEL_ROUTE_MIGRATION = defineMigration(
  "0010-model-route",
  `
DEFINE TABLE model_profile SCHEMAFULL;
DEFINE FIELD model_profile_id ON model_profile TYPE string;
DEFINE FIELD organization_id ON model_profile TYPE string;
DEFINE FIELD provider_id ON model_profile TYPE string;
DEFINE FIELD endpoint_id ON model_profile TYPE string;
DEFINE FIELD model_id ON model_profile TYPE string;
DEFINE FIELD route_kind ON model_profile TYPE string;
DEFINE FIELD context_window ON model_profile TYPE int;
DEFINE FIELD supports_tools ON model_profile TYPE bool;
DEFINE FIELD supports_structured_output ON model_profile TYPE bool;
DEFINE FIELD supports_vision ON model_profile TYPE bool;
DEFINE FIELD supports_streaming ON model_profile TYPE bool;
DEFINE FIELD equivalence_group ON model_profile TYPE string;
DEFINE FIELD eval_score ON model_profile TYPE float;
DEFINE FIELD verified ON model_profile TYPE bool;
DEFINE FIELD enabled ON model_profile TYPE bool;
DEFINE FIELD created_at ON model_profile TYPE datetime;
DEFINE FIELD updated_at ON model_profile TYPE datetime;
DEFINE INDEX model_profile_id ON model_profile FIELDS model_profile_id UNIQUE;
DEFINE INDEX model_profile_model ON model_profile FIELDS organization_id, endpoint_id, model_id UNIQUE;

DEFINE TABLE model_route SCHEMAFULL;
DEFINE FIELD route_id ON model_route TYPE string;
DEFINE FIELD organization_id ON model_route TYPE string;
DEFINE FIELD name ON model_route TYPE string;
DEFINE FIELD route_kind ON model_route TYPE string;
DEFINE FIELD credential_policy ON model_route TYPE string;
DEFINE FIELD data_policy ON model_route TYPE string;
DEFINE FIELD equivalence_group ON model_route TYPE string;
DEFINE FIELD min_eval_score ON model_route TYPE float;
DEFINE FIELD require_tools ON model_route TYPE bool;
DEFINE FIELD require_structured_output ON model_route TYPE bool;
DEFINE FIELD require_vision ON model_route TYPE bool;
DEFINE FIELD require_streaming ON model_route TYPE bool;
DEFINE FIELD max_context_tokens ON model_route TYPE int;
DEFINE FIELD request_budget_micros ON model_route TYPE int;
DEFINE FIELD total_budget_micros ON model_route TYPE int;
DEFINE FIELD spent_micros ON model_route TYPE int;
DEFINE FIELD selection_sequence ON model_route TYPE int;
DEFINE FIELD enabled ON model_route TYPE bool;
DEFINE FIELD created_at ON model_route TYPE datetime;
DEFINE FIELD updated_at ON model_route TYPE datetime;
DEFINE INDEX model_route_id ON model_route FIELDS route_id UNIQUE;
DEFINE INDEX model_route_name ON model_route FIELDS organization_id, name UNIQUE;

DEFINE TABLE model_route_candidate SCHEMAFULL;
DEFINE FIELD candidate_id ON model_route_candidate TYPE string;
DEFINE FIELD organization_id ON model_route_candidate TYPE string;
DEFINE FIELD route_id ON model_route_candidate TYPE string;
DEFINE FIELD model_profile_id ON model_route_candidate TYPE string;
DEFINE FIELD priority ON model_route_candidate TYPE int;
DEFINE FIELD enabled ON model_route_candidate TYPE bool;
DEFINE FIELD created_at ON model_route_candidate TYPE datetime;
DEFINE INDEX model_route_candidate_id ON model_route_candidate FIELDS candidate_id UNIQUE;
DEFINE INDEX model_route_candidate_profile ON model_route_candidate FIELDS organization_id, route_id, model_profile_id UNIQUE;

DEFINE TABLE route_attempt SCHEMAFULL;
DEFINE FIELD attempt_id ON route_attempt TYPE string;
DEFINE FIELD organization_id ON route_attempt TYPE string;
DEFINE FIELD route_id ON route_attempt TYPE string;
DEFINE FIELD candidate_id ON route_attempt TYPE string;
DEFINE FIELD model_profile_id ON route_attempt TYPE string;
DEFINE FIELD credential_id ON route_attempt TYPE string;
DEFINE FIELD credential_secret_version ON route_attempt TYPE int;
DEFINE FIELD command_id ON route_attempt TYPE string;
DEFINE FIELD status ON route_attempt TYPE string;
DEFINE FIELD selection_sequence ON route_attempt TYPE int;
DEFINE FIELD estimated_tokens ON route_attempt TYPE int;
DEFINE FIELD reserved_cost_micros ON route_attempt TYPE int;
DEFINE FIELD sticky_key_hash ON route_attempt TYPE option<string>;
DEFINE FIELD fallback_from_attempt_id ON route_attempt TYPE option<string>;
DEFINE FIELD explanation_json ON route_attempt TYPE string;
DEFINE FIELD created_at ON route_attempt TYPE datetime;
DEFINE FIELD updated_at ON route_attempt TYPE datetime;
DEFINE INDEX route_attempt_id ON route_attempt FIELDS attempt_id UNIQUE;
DEFINE INDEX route_attempt_command ON route_attempt FIELDS organization_id, command_id UNIQUE;
`,
);

export const ROUTER_HEALTH_MIGRATION = defineMigration(
  "0011-router-health",
  `
DEFINE FIELD OVERWRITE status ON route_attempt TYPE string;
DEFINE FIELD failure_class ON route_attempt TYPE option<string>;
DEFINE FIELD status_code ON route_attempt TYPE option<int>;
DEFINE FIELD emitted_tokens ON route_attempt TYPE int DEFAULT 0;
DEFINE FIELD actual_input_tokens ON route_attempt TYPE int DEFAULT 0;
DEFINE FIELD actual_output_tokens ON route_attempt TYPE int DEFAULT 0;
DEFINE FIELD actual_cost_micros ON route_attempt TYPE int DEFAULT 0;
DEFINE FIELD fallback_allowed ON route_attempt TYPE bool DEFAULT false;
DEFINE FIELD retry_at ON route_attempt TYPE option<datetime>;

DEFINE TABLE router_circuit SCHEMAFULL;
DEFINE FIELD circuit_id ON router_circuit TYPE string;
DEFINE FIELD organization_id ON router_circuit TYPE string;
DEFINE FIELD scope_type ON router_circuit TYPE string;
DEFINE FIELD scope_id ON router_circuit TYPE string;
DEFINE FIELD state ON router_circuit TYPE string;
DEFINE FIELD failure_count ON router_circuit TYPE int;
DEFINE FIELD success_count ON router_circuit TYPE int;
DEFINE FIELD threshold ON router_circuit TYPE int;
DEFINE FIELD open_until ON router_circuit TYPE option<datetime>;
DEFINE FIELD last_failure_class ON router_circuit TYPE option<string>;
DEFINE FIELD version ON router_circuit TYPE int;
DEFINE FIELD created_at ON router_circuit TYPE datetime;
DEFINE FIELD updated_at ON router_circuit TYPE datetime;
DEFINE INDEX router_circuit_id ON router_circuit FIELDS circuit_id UNIQUE;
DEFINE INDEX router_circuit_scope ON router_circuit FIELDS organization_id, scope_type, scope_id UNIQUE;
`,
);

export const MODEL_PRICING_MIGRATION = defineMigration(
  "0014-model-pricing",
  `
DEFINE FIELD input_cost_micros_per_million ON model_profile TYPE int DEFAULT 0;
DEFINE FIELD output_cost_micros_per_million ON model_profile TYPE int DEFAULT 0;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION = defineMigration(
  "0085-router-subscription-material",
  `
DEFINE FIELD material_kind ON provider_credential TYPE option<string>;
DEFINE FIELD subscription_account_id ON provider_credential TYPE option<string>;
DEFINE FIELD subscription_connector_id ON provider_credential TYPE option<string>;
DEFINE FIELD subscription_scope ON provider_credential TYPE option<string>;
DEFINE INDEX provider_credential_subscription_account ON provider_credential FIELDS organization_id, subscription_account_id;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_LINEAGE_MIGRATION = defineMigration(
  "0086-router-attempt-lineage",
  `
DEFINE FIELD routing_policy_version ON model_route TYPE int DEFAULT 1;
DEFINE FIELD quota_snapshot_id ON route_attempt TYPE option<string> READONLY;
DEFINE FIELD routing_policy_version ON route_attempt TYPE option<int> READONLY;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_SUBSCRIPTION_POLICY_MIGRATION = defineMigration(
  "0088-router-subscription-policy-lineage",
  `
DEFINE FIELD effective_credential_policy ON route_attempt TYPE option<string> READONLY;
DEFINE FIELD subscription_policy_version_id ON route_attempt TYPE option<string> READONLY;
DEFINE FIELD subscription_policy_version ON route_attempt TYPE option<int> READONLY;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTER_SUBSCRIPTION_ENDPOINT_MIGRATION = defineMigration(
  "0090-router-subscription-endpoint",
  `
DEFINE FIELD subscription_protocol ON provider_endpoint TYPE option<string>;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_SIDE_EFFECT_MIGRATION = defineMigration(
  "0092-router-attempt-side-effect",
  `
DEFINE FIELD side_effects_started ON route_attempt TYPE bool DEFAULT false;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTER_SUBSCRIPTION_REAUTH_MIGRATION = defineMigration(
  "0097-router-subscription-reauth",
  `
DEFINE FIELD reauth_required ON provider_credential TYPE bool DEFAULT false;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const MODEL_VERIFICATION_EVIDENCE_MIGRATION = defineMigration(
  "0098-router-model-verification-evidence",
  `
DEFINE TABLE model_verification_evidence SCHEMAFULL;
DEFINE FIELD evidence_id ON model_verification_evidence TYPE string;
DEFINE FIELD organization_id ON model_verification_evidence TYPE string;
DEFINE FIELD model_profile_id ON model_verification_evidence TYPE string;
DEFINE FIELD model_id ON model_verification_evidence TYPE string;
DEFINE FIELD subscription_account_id ON model_verification_evidence TYPE option<string>;
DEFINE FIELD evidence_kind ON model_verification_evidence TYPE string ASSERT $value IN ['runtime-availability', 'provider-capability-contract', 'runtime-capability-contract'];
DEFINE FIELD source ON model_verification_evidence TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 2048;
DEFINE FIELD source_version ON model_verification_evidence TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 256;
DEFINE FIELD claim_json ON model_verification_evidence TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 65536;
DEFINE FIELD claim_digest ON model_verification_evidence TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD observed_at ON model_verification_evidence TYPE datetime;
DEFINE FIELD created_by ON model_verification_evidence TYPE string;
DEFINE FIELD created_at ON model_verification_evidence TYPE datetime;
DEFINE INDEX model_verification_evidence_id ON model_verification_evidence FIELDS evidence_id UNIQUE;
DEFINE INDEX model_verification_evidence_profile ON model_verification_evidence FIELDS organization_id, model_profile_id, evidence_kind;
DEFINE INDEX model_verification_evidence_account ON model_verification_evidence FIELDS organization_id, model_profile_id, subscription_account_id, evidence_kind;
DEFINE EVENT model_verification_evidence_immutable ON TABLE model_verification_evidence WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Model verification evidence는 immutable입니다'; };
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_EXECUTION_LINEAGE_MIGRATION = defineMigration(
  "0099-route-attempt-execution-lineage",
  `
DEFINE FIELD execution_id ON route_attempt TYPE option<string>;
DEFINE FIELD optimization_batch_id ON route_attempt TYPE option<string>;
DEFINE INDEX route_attempt_execution ON route_attempt FIELDS organization_id, execution_id;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_OPTIMIZATION_RUN_LINEAGE_MIGRATION = defineMigration(
  "0115-route-attempt-optimization-run-lineage",
  `
DEFINE FIELD optimization_run_id ON route_attempt TYPE option<string>;
DEFINE INDEX route_attempt_optimization_run ON route_attempt FIELDS organization_id, optimization_run_id;
`,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const PROVIDER_MODEL_CATALOG_MIGRATION = defineMigration(
  "0116-provider-model-catalog",
  `
DEFINE TABLE provider_model_catalog_entry SCHEMAFULL;
DEFINE FIELD catalog_entry_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD organization_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD provider_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD endpoint_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD model_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD metadata_json ON provider_model_catalog_entry TYPE string;
DEFINE FIELD metadata_digest ON provider_model_catalog_entry TYPE string;
DEFINE FIELD state ON provider_model_catalog_entry TYPE string ASSERT $value IN ['active', 'stale'];
DEFINE FIELD snapshot_id ON provider_model_catalog_entry TYPE string;
DEFINE FIELD first_seen_at ON provider_model_catalog_entry TYPE datetime;
DEFINE FIELD last_seen_at ON provider_model_catalog_entry TYPE datetime;
DEFINE FIELD created_at ON provider_model_catalog_entry TYPE datetime;
DEFINE FIELD updated_at ON provider_model_catalog_entry TYPE datetime;
DEFINE INDEX provider_model_catalog_entry_id ON provider_model_catalog_entry FIELDS catalog_entry_id UNIQUE;
DEFINE INDEX provider_model_catalog_model ON provider_model_catalog_entry FIELDS organization_id, endpoint_id, model_id UNIQUE;
DEFINE INDEX provider_model_catalog_state ON provider_model_catalog_entry FIELDS organization_id, endpoint_id, state;

DEFINE TABLE provider_model_catalog_sync SCHEMAFULL;
DEFINE FIELD organization_id ON provider_model_catalog_sync TYPE string;
DEFINE FIELD provider_id ON provider_model_catalog_sync TYPE string;
DEFINE FIELD endpoint_id ON provider_model_catalog_sync TYPE string;
DEFINE FIELD sync_sequence ON provider_model_catalog_sync TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD status ON provider_model_catalog_sync TYPE string ASSERT $value IN ['syncing', 'available', 'empty', 'partial', 'degraded'];
DEFINE FIELD authentication_scope ON provider_model_catalog_sync TYPE string ASSERT $value IN ['anonymous', 'credential'];
DEFINE FIELD credential_id ON provider_model_catalog_sync TYPE option<string>;
DEFINE FIELD credential_version ON provider_model_catalog_sync TYPE option<int> ASSERT $value = NONE OR $value >= 1;
DEFINE FIELD credential_secret_version ON provider_model_catalog_sync TYPE option<int> ASSERT $value = NONE OR $value >= 1;
DEFINE FIELD active_count ON provider_model_catalog_sync TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD invalid_count ON provider_model_catalog_sync TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD duplicate_count ON provider_model_catalog_sync TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD catalog_digest ON provider_model_catalog_sync TYPE option<string>;
DEFINE FIELD snapshot_id ON provider_model_catalog_sync TYPE option<string>;
DEFINE FIELD diagnostic_reason ON provider_model_catalog_sync TYPE option<string>;
DEFINE FIELD retry_at ON provider_model_catalog_sync TYPE option<datetime>;
DEFINE FIELD last_attempted_at ON provider_model_catalog_sync TYPE datetime;
DEFINE FIELD last_successful_at ON provider_model_catalog_sync TYPE option<datetime>;
DEFINE FIELD created_at ON provider_model_catalog_sync TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON provider_model_catalog_sync TYPE datetime;
DEFINE INDEX provider_model_catalog_sync_endpoint ON provider_model_catalog_sync FIELDS organization_id, endpoint_id UNIQUE;
  `,
);

// prettier-ignore -- migration SQL의 공백도 checksum에 포함됩니다.
export const ROUTE_ATTEMPT_EXPLANATION_SNAPSHOT_MIGRATION = defineMigration(
  "0128-route-attempt-explanation-snapshot",
  `
DEFINE FIELD OVERWRITE explanation_json ON route_attempt TYPE string READONLY;
`,
);
