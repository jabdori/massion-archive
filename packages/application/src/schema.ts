import { defineMigration } from "@massion/storage";

export const APPLICATION_AUTH_MIGRATION = defineMigration(
  "0065-application-auth",
  `
DEFINE TABLE application_access_token SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD token_id ON application_access_token TYPE string;
DEFINE FIELD organization_id ON application_access_token TYPE string;
DEFINE FIELD user_id ON application_access_token TYPE string;
DEFINE FIELD key_id ON application_access_token TYPE string;
DEFINE FIELD audience ON application_access_token TYPE string;
DEFINE FIELD scopes ON application_access_token TYPE array<string>;
DEFINE FIELD token_hash ON application_access_token TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON application_access_token TYPE string;
DEFINE FIELD request_hash ON application_access_token TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD issued_at ON application_access_token TYPE datetime;
DEFINE FIELD expires_at ON application_access_token TYPE datetime;
DEFINE FIELD revoked_at ON application_access_token TYPE option<datetime>;
DEFINE INDEX application_access_token_id ON application_access_token FIELDS token_id UNIQUE;
DEFINE INDEX application_access_token_command ON application_access_token FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE application_token_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_token_event TYPE string;
DEFINE FIELD organization_id ON application_token_event TYPE string;
DEFINE FIELD token_id ON application_token_event TYPE string;
DEFINE FIELD actor_user_id ON application_token_event TYPE string;
DEFINE FIELD command_id ON application_token_event TYPE string;
DEFINE FIELD event_type ON application_token_event TYPE string ASSERT $value IN ['issued', 'revoked'];
DEFINE FIELD request_hash ON application_token_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_token_event TYPE datetime;
DEFINE INDEX application_token_event_id ON application_token_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_token_event_command ON application_token_event FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT application_token_event_immutable ON TABLE application_token_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application token event는 immutable입니다'; };
`,
);

export const APPLICATION_COMMAND_MIGRATION = defineMigration(
  "0066-application-command",
  `
DEFINE TABLE application_command SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD command_record_id ON application_command TYPE string;
DEFINE FIELD organization_id ON application_command TYPE string;
DEFINE FIELD actor_user_id ON application_command TYPE string;
DEFINE FIELD command_id ON application_command TYPE string;
DEFINE FIELD correlation_id ON application_command TYPE string;
DEFINE FIELD operation ON application_command TYPE string;
DEFINE FIELD request_hash ON application_command TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD state ON application_command TYPE string ASSERT $value IN ['running', 'succeeded', 'accepted', 'awaiting-approval', 'blocked', 'failed'];
DEFINE FIELD result_json ON application_command TYPE option<string>;
DEFINE FIELD result_hash ON application_command TYPE option<string>;
DEFINE FIELD error_json ON application_command TYPE option<string>;
DEFINE FIELD error_hash ON application_command TYPE option<string>;
DEFINE FIELD lease_generation ON application_command TYPE int ASSERT $value > 0;
DEFINE FIELD lease_expires_at ON application_command TYPE option<datetime>;
DEFINE FIELD created_at ON application_command TYPE datetime;
DEFINE FIELD updated_at ON application_command TYPE datetime;
DEFINE INDEX application_command_id ON application_command FIELDS organization_id, command_record_id UNIQUE;
DEFINE INDEX application_command_request ON application_command FIELDS organization_id, operation, command_id UNIQUE;

DEFINE TABLE application_command_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_command_event TYPE string;
DEFINE FIELD organization_id ON application_command_event TYPE string;
DEFINE FIELD command_record_id ON application_command_event TYPE string;
DEFINE FIELD lease_generation ON application_command_event TYPE int ASSERT $value > 0;
DEFINE FIELD event_type ON application_command_event TYPE string ASSERT $value IN ['claimed', 'reclaimed', 'completed', 'failed'];
DEFINE FIELD detail_hash ON application_command_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_command_event TYPE datetime;
DEFINE INDEX application_command_event_id ON application_command_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_command_event_transition ON application_command_event FIELDS organization_id, command_record_id, lease_generation, event_type UNIQUE;
DEFINE EVENT application_command_event_immutable ON TABLE application_command_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application command event는 immutable입니다'; };
`,
);

export const APPLICATION_OUTBOX_MIGRATION = defineMigration(
  "0067-application-outbox",
  `
DEFINE TABLE application_outbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD outbox_id ON application_outbox TYPE string;
DEFINE FIELD organization_id ON application_outbox TYPE string;
DEFINE FIELD source_kind ON application_outbox TYPE string;
DEFINE FIELD source_id ON application_outbox TYPE string;
DEFINE FIELD aggregate_id ON application_outbox TYPE option<string>;
DEFINE FIELD correlation_id ON application_outbox TYPE option<string>;
DEFINE FIELD causation_id ON application_outbox TYPE option<string>;
DEFINE FIELD occurred_at ON application_outbox TYPE datetime;
DEFINE FIELD state ON application_outbox TYPE string ASSERT $value IN ['pending', 'projected'];
DEFINE FIELD public_event_id ON application_outbox TYPE option<string>;
DEFINE FIELD created_at ON application_outbox TYPE datetime;
DEFINE FIELD updated_at ON application_outbox TYPE datetime;
DEFINE INDEX application_outbox_id ON application_outbox FIELDS organization_id, outbox_id UNIQUE;
DEFINE INDEX application_outbox_source ON application_outbox FIELDS organization_id, source_kind, source_id UNIQUE;

DEFINE EVENT application_outbox_from_work ON TABLE work_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('work-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'work-event', source_id: $after.event_id, aggregate_id: $after.work_id, correlation_id: $after.command_id, causation_id: $after.caused_by_event_id, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_collaboration ON TABLE collaboration_message
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('collaboration-message:', $after.message_id), organization_id: $after.organization_id, source_kind: 'collaboration-message', source_id: $after.message_id, aggregate_id: $after.work_id, correlation_id: $after.execution_id, causation_id: $after.caused_by_message_id, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_runtime ON TABLE runtime_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('runtime-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'runtime-event', source_id: $after.event_id, aggregate_id: $after.execution_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_approval ON TABLE governance_approval_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('approval-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'approval-event', source_id: $after.event_id, aggregate_id: $after.approval_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_organization ON TABLE organization_version
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('organization-version:', $after.version_id), organization_id: $after.organization_id, source_kind: 'organization-version', source_id: $after.version_id, aggregate_id: $after.organization_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_extension ON TABLE extension_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('extension-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'extension-event', source_id: $after.event_id, aggregate_id: $after.installation_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_growth ON TABLE growth_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('growth-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'growth-event', source_id: $after.event_id, aggregate_id: $after.aggregate_id, correlation_id: NONE, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_token ON TABLE application_token_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('token-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'token-event', source_id: $after.event_id, aggregate_id: $after.token_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_command ON TABLE application_command_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('command-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'command-event', source_id: $after.event_id, aggregate_id: $after.command_record_id, correlation_id: NONE, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
`,
);

export const APPLICATION_EVENT_MIGRATION = defineMigration(
  "0068-application-event",
  `
DEFINE TABLE application_event_stream SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON application_event_stream TYPE string;
DEFINE FIELD current_sequence ON application_event_stream TYPE int ASSERT $value >= 0;
DEFINE FIELD retention_floor ON application_event_stream TYPE int ASSERT $value >= 0;
DEFINE FIELD updated_at ON application_event_stream TYPE datetime;
DEFINE INDEX application_event_stream_org ON application_event_stream FIELDS organization_id UNIQUE;

DEFINE TABLE application_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_event TYPE string;
DEFINE FIELD organization_id ON application_event TYPE string;
DEFINE FIELD sequence ON application_event TYPE int ASSERT $value > 0;
DEFINE FIELD source_kind ON application_event TYPE string;
DEFINE FIELD source_id ON application_event TYPE string;
DEFINE FIELD event_type ON application_event TYPE string;
DEFINE FIELD author_kind ON application_event TYPE string ASSERT $value IN ['user', 'agent', 'system'];
DEFINE FIELD author_id ON application_event TYPE string;
DEFINE FIELD correlation_id ON application_event TYPE option<string>;
DEFINE FIELD causation_id ON application_event TYPE option<string>;
DEFINE FIELD resource_type ON application_event TYPE option<string>;
DEFINE FIELD resource_id ON application_event TYPE option<string>;
DEFINE FIELD resource_revision ON application_event TYPE option<int>;
DEFINE FIELD occurred_at ON application_event TYPE datetime;
DEFINE FIELD payload_json ON application_event TYPE string;
DEFINE FIELD payload_hash ON application_event TYPE string ASSERT string::len($value) = 64;
DEFINE INDEX application_event_id ON application_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_event_sequence ON application_event FIELDS organization_id, sequence UNIQUE;
DEFINE INDEX application_event_source ON application_event FIELDS organization_id, source_kind, source_id UNIQUE;
DEFINE EVENT application_event_immutable ON TABLE application_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application event는 immutable입니다'; };
`,
);

export const APPLICATION_RUN_MIGRATION = defineMigration(
  "0069-application-run",
  `
DEFINE TABLE application_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD run_id ON application_run TYPE string;
DEFINE FIELD organization_id ON application_run TYPE string;
DEFINE FIELD actor_user_id ON application_run TYPE string;
DEFINE FIELD command_id ON application_run TYPE string;
DEFINE FIELD correlation_id ON application_run TYPE string;
DEFINE FIELD request_json ON application_run TYPE string;
DEFINE FIELD request_hash ON application_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD work_id ON application_run TYPE option<string>;
DEFINE FIELD stage ON application_run TYPE string ASSERT $value IN ['intake', 'context-strategy', 'evidence', 'delivery', 'assurance', 'records', 'terminal'];
DEFINE FIELD status ON application_run TYPE string ASSERT $value IN ['ready', 'running', 'awaiting-approval', 'blocked', 'completed', 'failed', 'cancelled'];
DEFINE FIELD approval_id ON application_run TYPE option<string>;
DEFINE FIELD blocked_reason ON application_run TYPE option<string>;
DEFINE FIELD result_json ON application_run TYPE option<string>;
DEFINE FIELD result_hash ON application_run TYPE option<string>;
DEFINE FIELD lease_generation ON application_run TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_expires_at ON application_run TYPE option<datetime>;
DEFINE FIELD created_at ON application_run TYPE datetime;
DEFINE FIELD updated_at ON application_run TYPE datetime;
DEFINE INDEX application_run_id ON application_run FIELDS organization_id, run_id UNIQUE;
DEFINE INDEX application_run_command ON application_run FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE application_run_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_run_event TYPE string;
DEFINE FIELD organization_id ON application_run_event TYPE string;
DEFINE FIELD run_id ON application_run_event TYPE string;
DEFINE FIELD correlation_id ON application_run_event TYPE string;
DEFINE FIELD lease_generation ON application_run_event TYPE int ASSERT $value >= 0;
DEFINE FIELD stage ON application_run_event TYPE string ASSERT $value IN ['intake', 'context-strategy', 'evidence', 'delivery', 'assurance', 'records', 'terminal'];
DEFINE FIELD event_type ON application_run_event TYPE string ASSERT $value IN ['started', 'claimed', 'reclaimed', 'advanced', 'suspended', 'blocked', 'completed', 'failed', 'cancelled'];
DEFINE FIELD detail_hash ON application_run_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_run_event TYPE datetime;
DEFINE INDEX application_run_event_id ON application_run_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT application_run_event_immutable ON TABLE application_run_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application run event는 immutable입니다'; };

DEFINE EVENT application_outbox_from_run ON TABLE application_run_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('run-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'run-event', source_id: $after.event_id, aggregate_id: $after.run_id, correlation_id: $after.correlation_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
`,
);

export const APPLICATION_METRIC_MIGRATION = defineMigration(
  "0070-application-metric",
  `
DEFINE TABLE application_metric SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD metric_id ON application_metric TYPE string;
DEFINE FIELD organization_id ON application_metric TYPE string;
DEFINE FIELD idempotency_key ON application_metric TYPE string;
DEFINE FIELD name ON application_metric TYPE string ASSERT $value IN ['application_request_total', 'application_request_duration_ms', 'application_command_total', 'application_event_projection_total', 'application_event_lag_ms', 'application_stream_total', 'application_stream_backpressure_total', 'application_run_total', 'cli_command_total'];
DEFINE FIELD value ON application_metric TYPE number ASSERT $value >= 0;
DEFINE FIELD dimensions_json ON application_metric TYPE string;
DEFINE FIELD created_at ON application_metric TYPE datetime;
DEFINE INDEX application_metric_id ON application_metric FIELDS organization_id, metric_id UNIQUE;
DEFINE INDEX application_metric_once ON application_metric FIELDS organization_id, idempotency_key UNIQUE;
`,
);

export const APPLICATION_WEB_SESSION_MIGRATION = defineMigration(
  "0071-application-web-session",
  `
DEFINE TABLE application_web_login_ticket SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD ticket_id ON application_web_login_ticket TYPE string;
DEFINE FIELD organization_id ON application_web_login_ticket TYPE string;
DEFINE FIELD user_id ON application_web_login_ticket TYPE string;
DEFINE FIELD source_token_id ON application_web_login_ticket TYPE string;
DEFINE FIELD audience ON application_web_login_ticket TYPE string;
DEFINE FIELD scopes ON application_web_login_ticket TYPE array<string>;
DEFINE FIELD key_id ON application_web_login_ticket TYPE string;
DEFINE FIELD code_hash ON application_web_login_ticket TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON application_web_login_ticket TYPE string;
DEFINE FIELD request_hash ON application_web_login_ticket TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD issued_at ON application_web_login_ticket TYPE datetime;
DEFINE FIELD expires_at ON application_web_login_ticket TYPE datetime;
DEFINE FIELD used_at ON application_web_login_ticket TYPE option<datetime>;
DEFINE INDEX application_web_login_ticket_id ON application_web_login_ticket FIELDS ticket_id UNIQUE;
DEFINE INDEX application_web_login_ticket_command ON application_web_login_ticket FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE application_web_session SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD session_id ON application_web_session TYPE string;
DEFINE FIELD organization_id ON application_web_session TYPE string;
DEFINE FIELD user_id ON application_web_session TYPE string;
DEFINE FIELD source_token_id ON application_web_session TYPE string;
DEFINE FIELD audience ON application_web_session TYPE string;
DEFINE FIELD scopes ON application_web_session TYPE array<string>;
DEFINE FIELD key_id ON application_web_session TYPE string;
DEFINE FIELD session_hash ON application_web_session TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD csrf_hash ON application_web_session TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD issued_at ON application_web_session TYPE datetime;
DEFINE FIELD expires_at ON application_web_session TYPE datetime;
DEFINE FIELD idle_ttl_seconds ON application_web_session TYPE int ASSERT $value >= 60;
DEFINE FIELD idle_expires_at ON application_web_session TYPE datetime;
DEFINE FIELD last_seen_at ON application_web_session TYPE datetime;
DEFINE FIELD revoked_at ON application_web_session TYPE option<datetime>;
DEFINE FIELD revoked_reason ON application_web_session TYPE option<string>;
DEFINE INDEX application_web_session_id ON application_web_session FIELDS session_id UNIQUE;
DEFINE INDEX application_web_session_hash ON application_web_session FIELDS session_hash UNIQUE;

DEFINE TABLE application_web_session_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_web_session_event TYPE string;
DEFINE FIELD organization_id ON application_web_session_event TYPE string;
DEFINE FIELD user_id ON application_web_session_event TYPE string;
DEFINE FIELD session_id ON application_web_session_event TYPE option<string>;
DEFINE FIELD ticket_id ON application_web_session_event TYPE option<string>;
DEFINE FIELD event_type ON application_web_session_event TYPE string ASSERT $value IN ['ticket-issued', 'ticket-consumed', 'session-issued', 'csrf-rotated', 'session-revoked'];
DEFINE FIELD detail_hash ON application_web_session_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_web_session_event TYPE datetime;
DEFINE INDEX application_web_session_event_id ON application_web_session_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT application_web_session_event_immutable ON TABLE application_web_session_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application web session event는 immutable입니다'; };
`,
);

export const APPLICATION_WEB_SESSION_REVISION_MIGRATION = defineMigration(
  "0073-application-web-session-revision",
  `
DEFINE FIELD revision ON application_web_session TYPE int DEFAULT 0 ASSERT $value >= 0;
UPDATE application_web_session SET revision = 0 WHERE revision = NONE;
`,
);

export const APPLICATION_RUN_RETRY_MIGRATION = defineMigration(
  "0105-application-run-retry",
  `
DEFINE FIELD retry_attempt_id ON application_run TYPE option<string>;
DEFINE FIELD retry_replay_id ON application_run TYPE option<string>;
`,
);

export const APPLICATION_WORK_DIRECTIVE_MIGRATION = defineMigration(
  "0108-application-work-directive",
  `
DEFINE FIELD directive_sequence ON application_run TYPE int DEFAULT 0 ASSERT $value >= 0;
UPDATE application_run SET directive_sequence = 0 WHERE directive_sequence = NONE;

DEFINE TABLE application_work_directive SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD directive_id ON application_work_directive TYPE string;
DEFINE FIELD organization_id ON application_work_directive TYPE string;
DEFINE FIELD actor_user_id ON application_work_directive TYPE string;
DEFINE FIELD command_id ON application_work_directive TYPE string;
DEFINE FIELD correlation_id ON application_work_directive TYPE string;
DEFINE FIELD work_id ON application_work_directive TYPE string;
DEFINE FIELD run_id ON application_work_directive TYPE string;
DEFINE FIELD sequence ON application_work_directive TYPE int ASSERT $value > 0;
DEFINE FIELD content ON application_work_directive TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 65536;
DEFINE FIELD content_hash ON application_work_directive TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD request_hash ON application_work_directive TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD mode ON application_work_directive TYPE string ASSERT $value IN ['now', 'next-stage'];
DEFINE FIELD submitted_stage ON application_work_directive TYPE string ASSERT $value IN ['intake', 'context-strategy', 'evidence', 'delivery', 'assurance', 'records'];
DEFINE FIELD status ON application_work_directive TYPE string ASSERT $value IN ['queued', 'applying', 'applied', 'failed', 'unapplied'];
DEFINE FIELD lease_generation ON application_work_directive TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_expires_at ON application_work_directive TYPE option<datetime>;
DEFINE FIELD failure_reason ON application_work_directive TYPE option<string>;
DEFINE FIELD created_at ON application_work_directive TYPE datetime;
DEFINE FIELD updated_at ON application_work_directive TYPE datetime;
DEFINE INDEX application_work_directive_id ON application_work_directive FIELDS organization_id, directive_id UNIQUE;
DEFINE INDEX application_work_directive_command ON application_work_directive FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX application_work_directive_sequence ON application_work_directive FIELDS organization_id, run_id, sequence UNIQUE;
DEFINE INDEX application_work_directive_queue ON application_work_directive FIELDS organization_id, run_id, status, sequence;
DEFINE INDEX application_run_work_history ON application_run FIELDS organization_id, work_id, created_at, run_id;
`,
);

export const APPLICATION_WORK_DIRECTIVE_MUTATION_MIGRATION = defineMigration(
  "0120-application-work-directive-mutation",
  `
DEFINE FIELD OVERWRITE status ON application_work_directive TYPE string ASSERT $value IN ['queued', 'applying', 'applied', 'failed', 'unapplied', 'cancelled'];
DEFINE FIELD revision ON application_work_directive TYPE int DEFAULT 1 ASSERT $value > 0;
UPDATE application_work_directive SET revision = 1 WHERE revision = NONE;
DEFINE FIELD last_mutation_command_id ON application_work_directive TYPE option<string>;
DEFINE FIELD last_mutation_request_hash ON application_work_directive TYPE option<string>;
`,
);

export const APPLICATION_RUN_APPROVAL_RESUME_MIGRATION = defineMigration(
  "0109-application-run-approval-resume",
  `
DEFINE FIELD resume_approval_id ON application_run TYPE option<string>;
`,
);

export const APPLICATION_DYNAMIC_STAFFING_MIGRATION = defineMigration(
  "0116-application-dynamic-staffing",
  `
DEFINE TABLE dynamic_staffing_proposal SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD proposal_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD organization_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD created_by_user_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD command_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD request_hash ON dynamic_staffing_proposal TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD intent_hash ON dynamic_staffing_proposal TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD work_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD plan_version_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD context_version_id ON dynamic_staffing_proposal TYPE option<string>;
DEFINE FIELD strategy_generation_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD assessment_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD graph_command_json ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD expected_organization_version ON dynamic_staffing_proposal TYPE int ASSERT $value > 0;
DEFINE FIELD expected_work_revision ON dynamic_staffing_proposal TYPE int ASSERT $value > 0;
DEFINE FIELD nodes_json ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD assignments_json ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD core_office_room_id ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD ux_metadata_json ON dynamic_staffing_proposal TYPE string;
DEFINE FIELD status ON dynamic_staffing_proposal TYPE string ASSERT $value IN ['prepared', 'awaiting-approval', 'applied'];
DEFINE FIELD approval_id ON dynamic_staffing_proposal TYPE option<string>;
DEFINE FIELD applied_organization_version ON dynamic_staffing_proposal TYPE option<int>;
DEFINE FIELD applied_organization_version_id ON dynamic_staffing_proposal TYPE option<string>;
DEFINE FIELD impact_json ON dynamic_staffing_proposal TYPE option<string>;
DEFINE FIELD message_id ON dynamic_staffing_proposal TYPE option<string>;
DEFINE FIELD revision ON dynamic_staffing_proposal TYPE int ASSERT $value > 0;
DEFINE FIELD created_at ON dynamic_staffing_proposal TYPE datetime;
DEFINE FIELD updated_at ON dynamic_staffing_proposal TYPE datetime;
DEFINE INDEX dynamic_staffing_proposal_id ON dynamic_staffing_proposal FIELDS organization_id, proposal_id UNIQUE;
DEFINE INDEX dynamic_staffing_proposal_command ON dynamic_staffing_proposal FIELDS organization_id, command_id UNIQUE;
`,
);

export const APPLICATION_RUN_EVENT_WORK_MIGRATION = defineMigration(
  "0118-application-run-event-work",
  `
DEFINE FIELD work_id ON application_run_event TYPE option<string>;
`,
);

export const APPLICATION_EVENT_LINEAGE_MIGRATION = defineMigration(
  "0119-application-event-lineage",
  `
DEFINE FIELD OVERWRITE correlation_id ON application_event TYPE option<string> ASSERT $value = NONE OR (string::len($value) >= 8 AND string::len($value) <= 256 AND string::matches($value, '^[A-Za-z0-9][A-Za-z0-9._:-]*$'));
`,
);

/**
 * 과거 VoltAgent fullStream part는 `model_*` Runtime Event와 Application outbox를 chunk마다 만들었습니다.
 * 이 migration은 이미 설치된 checksum 경계를 기록할 뿐 이력을 순회하지 않습니다. raw outbox 정합화와
 * 물리 JSON tombstone은 listener 뒤의 bounded worker가 함께 수행하므로 대량 이력이 local daemon
 * readiness를 막지 않습니다.
 */
const APPLICATION_RUNTIME_STREAM_RETIREMENT_SURQL = `RETURN NONE;`;

export const APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION = defineMigration(
  "0121-application-runtime-stream-retirement",
  APPLICATION_RUNTIME_STREAM_RETIREMENT_SURQL,
  {
    compatibleChecksums: [
      "07199ea58b87cc9a0a1c199dcc9f3e4d2d01b11895a9907b34bb988f4ec91866",
      "9e73a3f323a6bd86d7597355ce24f20743d82167de79f4e270b494023c453109",
      "8df5ff8b291967c01b682477304d2824c737f76173ef7f0d0b2cd32f09b06026",
      "fa4436e9fc2570e0f2c0caf3dccec52796f2353fb32ca859ba5f9736a22b81e9",
    ],
  },
);

export const APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION = defineMigration(
  "0122-application-runtime-stream-reconciliation",
  APPLICATION_RUNTIME_STREAM_RETIREMENT_SURQL,
  {
    compatibleChecksums: [
      "9e73a3f323a6bd86d7597355ce24f20743d82167de79f4e270b494023c453109",
      "8df5ff8b291967c01b682477304d2824c737f76173ef7f0d0b2cd32f09b06026",
      "fa4436e9fc2570e0f2c0caf3dccec52796f2353fb32ca859ba5f9736a22b81e9",
    ],
  },
);

export const APPLICATION_MIGRATIONS = [
  APPLICATION_AUTH_MIGRATION,
  APPLICATION_COMMAND_MIGRATION,
  APPLICATION_OUTBOX_MIGRATION,
  APPLICATION_EVENT_MIGRATION,
  APPLICATION_RUN_MIGRATION,
  APPLICATION_METRIC_MIGRATION,
  APPLICATION_WEB_SESSION_MIGRATION,
  APPLICATION_WEB_SESSION_REVISION_MIGRATION,
  APPLICATION_RUN_RETRY_MIGRATION,
  APPLICATION_WORK_DIRECTIVE_MIGRATION,
  APPLICATION_WORK_DIRECTIVE_MUTATION_MIGRATION,
  APPLICATION_RUN_APPROVAL_RESUME_MIGRATION,
  APPLICATION_DYNAMIC_STAFFING_MIGRATION,
  APPLICATION_RUN_EVENT_WORK_MIGRATION,
  APPLICATION_EVENT_LINEAGE_MIGRATION,
  APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
  APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
] as const;
