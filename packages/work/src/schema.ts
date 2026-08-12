import { defineMigration } from "@massion/storage";

export const WORK_ASSURANCE_FAIL_CLOSED_GUARD = `
DEFINE EVENT IF NOT EXISTS work_assurance_completion_guard ON TABLE work
WHEN $event = 'UPDATE' AND $before.status != 'completed' AND $after.status = 'completed'
THEN { THROW 'Assurance bootstrap 전에는 Work를 completed로 전이할 수 없습니다'; };
`;

export const WORK_CORE_MIGRATION = defineMigration(
  "0004-work-core",
  `
DEFINE TABLE work_request SCHEMAFULL;
DEFINE FIELD request_id ON work_request TYPE string;
DEFINE FIELD organization_id ON work_request TYPE string;
DEFINE FIELD requester_user_id ON work_request TYPE string;
DEFINE FIELD text ON work_request TYPE string;
DEFINE FIELD surface ON work_request TYPE string;
DEFINE FIELD created_at ON work_request TYPE datetime;
DEFINE INDEX work_request_id ON work_request FIELDS request_id UNIQUE;
DEFINE INDEX work_request_tenant ON work_request FIELDS organization_id;

DEFINE TABLE work SCHEMAFULL;
DEFINE FIELD work_id ON work TYPE string;
DEFINE FIELD organization_id ON work TYPE string;
DEFINE FIELD request_id ON work TYPE string;
DEFINE FIELD parent_work_id ON work TYPE option<string>;
DEFINE FIELD project_id ON work TYPE option<string>;
DEFINE FIELD status ON work TYPE string;
DEFINE FIELD revision ON work TYPE int;
DEFINE FIELD organization_version_id ON work TYPE string;
DEFINE FIELD context_version_id ON work TYPE option<string>;
DEFINE FIELD policy_version_id ON work TYPE option<string>;
DEFINE FIELD prompt_version_id ON work TYPE option<string>;
DEFINE FIELD artifact_version_ids ON work TYPE array<string>;
DEFINE FIELD created_at ON work TYPE datetime;
DEFINE FIELD updated_at ON work TYPE datetime;
DEFINE INDEX work_id ON work FIELDS work_id UNIQUE;
DEFINE INDEX work_tenant ON work FIELDS organization_id;
DEFINE INDEX work_request_unique ON work FIELDS organization_id, request_id UNIQUE;

DEFINE TABLE work_event SCHEMAFULL;
DEFINE FIELD event_id ON work_event TYPE string;
DEFINE FIELD organization_id ON work_event TYPE string;
DEFINE FIELD work_id ON work_event TYPE string;
DEFINE FIELD sequence ON work_event TYPE int;
DEFINE FIELD command_id ON work_event TYPE string;
DEFINE FIELD event_type ON work_event TYPE string;
DEFINE FIELD actor_user_id ON work_event TYPE string;
DEFINE FIELD caused_by_event_id ON work_event TYPE option<string>;
DEFINE FIELD request_json ON work_event TYPE string;
DEFINE FIELD payload_json ON work_event TYPE string;
DEFINE FIELD result_json ON work_event TYPE string;
DEFINE FIELD created_at ON work_event TYPE datetime;
DEFINE INDEX work_event_id ON work_event FIELDS event_id UNIQUE;
DEFINE INDEX work_event_sequence ON work_event FIELDS organization_id, work_id, sequence UNIQUE;
DEFINE INDEX work_event_command ON work_event FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE plan_version SCHEMAFULL;
DEFINE FIELD plan_version_id ON plan_version TYPE string;
DEFINE FIELD organization_id ON plan_version TYPE string;
DEFINE FIELD work_id ON plan_version TYPE string;
DEFINE FIELD version ON plan_version TYPE int;
DEFINE FIELD content_json ON plan_version TYPE string;
DEFINE FIELD valid ON plan_version TYPE bool;
DEFINE FIELD created_by ON plan_version TYPE string;
DEFINE FIELD created_at ON plan_version TYPE datetime;
DEFINE INDEX plan_version_id ON plan_version FIELDS plan_version_id UNIQUE;
DEFINE INDEX plan_version_number ON plan_version FIELDS organization_id, work_id, version UNIQUE;
`,
);

export const WORK_DELIVERY_MIGRATION = defineMigration(
  "0005-work-delivery",
  `
DEFINE TABLE work_task SCHEMAFULL;
DEFINE FIELD task_id ON work_task TYPE string;
DEFINE FIELD organization_id ON work_task TYPE string;
DEFINE FIELD work_id ON work_task TYPE string;
DEFINE FIELD title ON work_task TYPE string;
DEFINE FIELD objective ON work_task TYPE string;
DEFINE FIELD acceptance_criteria_json ON work_task TYPE string;
DEFINE FIELD dependency_ids ON work_task TYPE array<string>;
DEFINE FIELD status ON work_task TYPE string;
DEFINE FIELD revision ON work_task TYPE int;
DEFINE FIELD created_at ON work_task TYPE datetime;
DEFINE FIELD updated_at ON work_task TYPE datetime;
DEFINE INDEX work_task_id ON work_task FIELDS task_id UNIQUE;
DEFINE INDEX work_task_work ON work_task FIELDS organization_id, work_id;

DEFINE TABLE task_assignment SCHEMAFULL;
DEFINE FIELD assignment_id ON task_assignment TYPE string;
DEFINE FIELD organization_id ON task_assignment TYPE string;
DEFINE FIELD work_id ON task_assignment TYPE string;
DEFINE FIELD task_id ON task_assignment TYPE string;
DEFINE FIELD agent_handle ON task_assignment TYPE string;
DEFINE FIELD status ON task_assignment TYPE string;
DEFINE FIELD revision ON task_assignment TYPE int;
DEFINE FIELD supersedes_assignment_id ON task_assignment TYPE option<string>;
DEFINE FIELD created_by ON task_assignment TYPE string;
DEFINE FIELD created_at ON task_assignment TYPE datetime;
DEFINE FIELD updated_at ON task_assignment TYPE datetime;
DEFINE INDEX task_assignment_id ON task_assignment FIELDS assignment_id UNIQUE;
DEFINE INDEX task_assignment_task ON task_assignment FIELDS organization_id, work_id, task_id;

DEFINE TABLE work_session SCHEMAFULL;
DEFINE FIELD session_id ON work_session TYPE string;
DEFINE FIELD organization_id ON work_session TYPE string;
DEFINE FIELD work_id ON work_session TYPE string;
DEFINE FIELD agent_handle ON work_session TYPE string;
DEFINE FIELD status ON work_session TYPE string;
DEFINE FIELD revision ON work_session TYPE int;
DEFINE FIELD created_at ON work_session TYPE datetime;
DEFINE FIELD updated_at ON work_session TYPE datetime;
DEFINE INDEX work_session_id ON work_session FIELDS session_id UNIQUE;
DEFINE INDEX work_session_agent ON work_session FIELDS organization_id, work_id, agent_handle UNIQUE;

DEFINE TABLE session_checkpoint SCHEMAFULL;
DEFINE FIELD checkpoint_id ON session_checkpoint TYPE string;
DEFINE FIELD organization_id ON session_checkpoint TYPE string;
DEFINE FIELD work_id ON session_checkpoint TYPE string;
DEFINE FIELD session_id ON session_checkpoint TYPE string;
DEFINE FIELD version ON session_checkpoint TYPE int;
DEFINE FIELD data_json ON session_checkpoint TYPE string;
DEFINE FIELD checksum ON session_checkpoint TYPE string;
DEFINE FIELD created_at ON session_checkpoint TYPE datetime;
DEFINE INDEX session_checkpoint_id ON session_checkpoint FIELDS checkpoint_id UNIQUE;
DEFINE INDEX session_checkpoint_version ON session_checkpoint FIELDS organization_id, session_id, version UNIQUE;
`,
);

export const WORK_COLLABORATION_MIGRATION = defineMigration(
  "0006-work-collaboration",
  `
DEFINE TABLE collaboration_room SCHEMAFULL;
DEFINE FIELD room_id ON collaboration_room TYPE string;
DEFINE FIELD organization_id ON collaboration_room TYPE string;
DEFINE FIELD work_id ON collaboration_room TYPE string;
DEFINE FIELD title ON collaboration_room TYPE string;
DEFINE FIELD coordinator_handle ON collaboration_room TYPE string;
DEFINE FIELD status ON collaboration_room TYPE string;
DEFINE FIELD revision ON collaboration_room TYPE int;
DEFINE FIELD next_sequence ON collaboration_room TYPE int;
DEFINE FIELD max_parallel ON collaboration_room TYPE int;
DEFINE FIELD max_tokens ON collaboration_room TYPE int;
DEFINE FIELD max_cost_micros ON collaboration_room TYPE int;
DEFINE FIELD max_rounds ON collaboration_room TYPE int;
DEFINE FIELD round_count ON collaboration_room TYPE int;
DEFINE FIELD deadline ON collaboration_room TYPE option<datetime>;
DEFINE FIELD created_at ON collaboration_room TYPE datetime;
DEFINE FIELD updated_at ON collaboration_room TYPE datetime;
DEFINE INDEX collaboration_room_id ON collaboration_room FIELDS room_id UNIQUE;
DEFINE INDEX collaboration_room_work ON collaboration_room FIELDS organization_id, work_id;

DEFINE TABLE collaboration_participant SCHEMAFULL;
DEFINE FIELD participant_id ON collaboration_participant TYPE string;
DEFINE FIELD organization_id ON collaboration_participant TYPE string;
DEFINE FIELD work_id ON collaboration_participant TYPE string;
DEFINE FIELD room_id ON collaboration_participant TYPE string;
DEFINE FIELD kind ON collaboration_participant TYPE string;
DEFINE FIELD subject_id ON collaboration_participant TYPE string;
DEFINE FIELD role ON collaboration_participant TYPE string;
DEFINE FIELD status ON collaboration_participant TYPE string;
DEFINE FIELD joined_at ON collaboration_participant TYPE datetime;
DEFINE INDEX collaboration_participant_id ON collaboration_participant FIELDS participant_id UNIQUE;
DEFINE INDEX collaboration_participant_subject ON collaboration_participant FIELDS organization_id, room_id, kind, subject_id UNIQUE;

DEFINE TABLE collaboration_message SCHEMAFULL;
DEFINE FIELD message_id ON collaboration_message TYPE string;
DEFINE FIELD organization_id ON collaboration_message TYPE string;
DEFINE FIELD work_id ON collaboration_message TYPE string;
DEFINE FIELD room_id ON collaboration_message TYPE string;
DEFINE FIELD sequence ON collaboration_message TYPE int;
DEFINE FIELD message_type ON collaboration_message TYPE string;
DEFINE FIELD author_kind ON collaboration_message TYPE string;
DEFINE FIELD author_id ON collaboration_message TYPE string;
DEFINE FIELD content ON collaboration_message TYPE string;
DEFINE FIELD reply_to_message_id ON collaboration_message TYPE option<string>;
DEFINE FIELD caused_by_message_id ON collaboration_message TYPE option<string>;
DEFINE FIELD task_id ON collaboration_message TYPE option<string>;
DEFINE FIELD context_version_id ON collaboration_message TYPE option<string>;
DEFINE FIELD execution_id ON collaboration_message TYPE option<string>;
DEFINE FIELD artifact_version_id ON collaboration_message TYPE option<string>;
DEFINE FIELD token_count ON collaboration_message TYPE int;
DEFINE FIELD cost_micros ON collaboration_message TYPE int;
DEFINE FIELD created_at ON collaboration_message TYPE datetime;
DEFINE INDEX collaboration_message_id ON collaboration_message FIELDS message_id UNIQUE;
DEFINE INDEX collaboration_message_sequence ON collaboration_message FIELDS organization_id, room_id, sequence UNIQUE;

DEFINE TABLE shared_context_reference SCHEMAFULL;
DEFINE FIELD shared_context_reference_id ON shared_context_reference TYPE string;
DEFINE FIELD organization_id ON shared_context_reference TYPE string;
DEFINE FIELD work_id ON shared_context_reference TYPE string;
DEFINE FIELD room_id ON shared_context_reference TYPE string;
DEFINE FIELD source_kind ON shared_context_reference TYPE string;
DEFINE FIELD source_id ON shared_context_reference TYPE string;
DEFINE FIELD version_id ON shared_context_reference TYPE string;
DEFINE FIELD checksum ON shared_context_reference TYPE string;
DEFINE FIELD created_at ON shared_context_reference TYPE datetime;
DEFINE INDEX shared_context_reference_id ON shared_context_reference FIELDS shared_context_reference_id UNIQUE;
DEFINE INDEX shared_context_reference_unique ON shared_context_reference FIELDS organization_id, room_id, source_kind, source_id, version_id UNIQUE;

DEFINE TABLE resource_lease SCHEMAFULL;
DEFINE FIELD lease_id ON resource_lease TYPE string;
DEFINE FIELD organization_id ON resource_lease TYPE string;
DEFINE FIELD work_id ON resource_lease TYPE string;
DEFINE FIELD resource_key ON resource_lease TYPE string;
DEFINE FIELD holder_id ON resource_lease TYPE string;
DEFINE FIELD status ON resource_lease TYPE string;
DEFINE FIELD version ON resource_lease TYPE int;
DEFINE FIELD expires_at ON resource_lease TYPE datetime;
DEFINE FIELD created_at ON resource_lease TYPE datetime;
DEFINE FIELD updated_at ON resource_lease TYPE datetime;
DEFINE INDEX resource_lease_id ON resource_lease FIELDS lease_id UNIQUE;
DEFINE INDEX resource_lease_resource ON resource_lease FIELDS organization_id, work_id, resource_key UNIQUE;
`,
);

export const WORK_RECORDS_MIGRATION = defineMigration(
  "0007-work-records",
  `
DEFINE TABLE work_artifact SCHEMAFULL;
DEFINE FIELD artifact_id ON work_artifact TYPE string;
DEFINE FIELD organization_id ON work_artifact TYPE string;
DEFINE FIELD work_id ON work_artifact TYPE string;
DEFINE FIELD kind ON work_artifact TYPE string;
DEFINE FIELD name ON work_artifact TYPE string;
DEFINE FIELD created_by ON work_artifact TYPE string;
DEFINE FIELD created_at ON work_artifact TYPE datetime;
DEFINE INDEX work_artifact_id ON work_artifact FIELDS artifact_id UNIQUE;
DEFINE INDEX work_artifact_name ON work_artifact FIELDS organization_id, work_id, name UNIQUE;

DEFINE TABLE artifact_version SCHEMAFULL;
DEFINE FIELD artifact_version_id ON artifact_version TYPE string;
DEFINE FIELD artifact_id ON artifact_version TYPE string;
DEFINE FIELD organization_id ON artifact_version TYPE string;
DEFINE FIELD work_id ON artifact_version TYPE string;
DEFINE FIELD version ON artifact_version TYPE int;
DEFINE FIELD checksum ON artifact_version TYPE string;
DEFINE FIELD media_type ON artifact_version TYPE string;
DEFINE FIELD content_json ON artifact_version TYPE string;
DEFINE FIELD source_artifact_version_id ON artifact_version TYPE option<string>;
DEFINE FIELD created_by ON artifact_version TYPE string;
DEFINE FIELD created_at ON artifact_version TYPE datetime;
DEFINE INDEX artifact_version_id ON artifact_version FIELDS artifact_version_id UNIQUE;
DEFINE INDEX artifact_version_number ON artifact_version FIELDS organization_id, artifact_id, version UNIQUE;

DEFINE TABLE work_verification SCHEMAFULL;
DEFINE FIELD verification_id ON work_verification TYPE string;
DEFINE FIELD organization_id ON work_verification TYPE string;
DEFINE FIELD work_id ON work_verification TYPE string;
DEFINE FIELD verifier_id ON work_verification TYPE string;
DEFINE FIELD passed ON work_verification TYPE bool;
DEFINE FIELD criteria_json ON work_verification TYPE string;
DEFINE FIELD evidence_artifact_version_ids ON work_verification TYPE array<string>;
DEFINE FIELD created_at ON work_verification TYPE datetime;
DEFINE INDEX work_verification_id ON work_verification FIELDS verification_id UNIQUE;
DEFINE INDEX work_verification_work ON work_verification FIELDS organization_id, work_id;

DEFINE TABLE work_record SCHEMAFULL;
DEFINE FIELD work_record_id ON work_record TYPE string;
DEFINE FIELD organization_id ON work_record TYPE string;
DEFINE FIELD work_id ON work_record TYPE string;
DEFINE FIELD version ON work_record TYPE int;
DEFINE FIELD recorded_work_revision ON work_record TYPE int;
DEFINE FIELD summary ON work_record TYPE string;
DEFINE FIELD event_start_sequence ON work_record TYPE int;
DEFINE FIELD event_end_sequence ON work_record TYPE int;
DEFINE FIELD decision_message_ids ON work_record TYPE array<string>;
DEFINE FIELD artifact_version_ids ON work_record TYPE array<string>;
DEFINE FIELD verification_ids ON work_record TYPE array<string>;
DEFINE FIELD finalized ON work_record TYPE bool;
DEFINE FIELD finalized_by ON work_record TYPE string;
DEFINE FIELD finalized_at ON work_record TYPE datetime;
DEFINE INDEX work_record_id ON work_record FIELDS work_record_id UNIQUE;
DEFINE INDEX work_record_work_version ON work_record FIELDS organization_id, work_id, version UNIQUE;

DEFINE TABLE work_merge_plan SCHEMAFULL;
DEFINE FIELD merge_plan_id ON work_merge_plan TYPE string;
DEFINE FIELD organization_id ON work_merge_plan TYPE string;
DEFINE FIELD parent_work_id ON work_merge_plan TYPE string;
DEFINE FIELD child_work_id ON work_merge_plan TYPE string;
DEFINE FIELD parent_revision ON work_merge_plan TYPE int;
DEFINE FIELD status ON work_merge_plan TYPE string;
DEFINE FIELD conflict_json ON work_merge_plan TYPE string;
DEFINE FIELD artifact_version_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD decision_message_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD verification_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD created_by ON work_merge_plan TYPE string;
DEFINE FIELD created_at ON work_merge_plan TYPE datetime;
DEFINE FIELD applied_at ON work_merge_plan TYPE option<datetime>;
DEFINE INDEX work_merge_plan_id ON work_merge_plan FIELDS merge_plan_id UNIQUE;
DEFINE INDEX work_merge_plan_works ON work_merge_plan FIELDS organization_id, parent_work_id, child_work_id;
`,
);

export const WORK_CONSTRAINTS_MIGRATION = defineMigration(
  "0008-work-constraints",
  `
DEFINE FIELD OVERWRITE status ON work TYPE string ASSERT $value IN ['draft', 'planned', 'ready', 'running', 'waiting_approval', 'verifying', 'completed', 'failed', 'retrying', 'replanning', 'cancelled'];
DEFINE FIELD OVERWRITE revision ON work TYPE int ASSERT $value >= 1;
DEFINE EVENT work_create_state ON work
  WHEN $event = 'CREATE' AND $after.status != 'draft'
  THEN { THROW 'Work는 draft 상태로만 생성할 수 있습니다'; };
DEFINE EVENT work_transition_state ON work
  WHEN $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'draft' AND $after.status IN ['planned', 'cancelled']) OR
    ($before.status = 'planned' AND $after.status IN ['ready', 'cancelled']) OR
    ($before.status = 'ready' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['waiting_approval', 'verifying', 'failed', 'cancelled']) OR
    ($before.status = 'waiting_approval' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'verifying' AND $after.status IN ['completed', 'failed', 'cancelled']) OR
    ($before.status = 'failed' AND $after.status IN ['retrying', 'replanning', 'cancelled']) OR
    ($before.status = 'retrying' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'replanning' AND $after.status IN ['planned', 'cancelled'])
  )
  THEN { THROW '허용되지 않은 Work 상태 전이입니다'; };

DEFINE FIELD OVERWRITE status ON work_task TYPE string ASSERT $value IN ['blocked', 'ready', 'running', 'completed', 'failed', 'cancelled'];
DEFINE FIELD OVERWRITE revision ON work_task TYPE int ASSERT $value >= 1;
DEFINE EVENT task_create_state ON work_task
  WHEN $event = 'CREATE' AND $after.status NOT IN ['blocked', 'ready']
  THEN { THROW 'Task는 blocked 또는 ready 상태로만 생성할 수 있습니다'; };
DEFINE EVENT task_transition_state ON work_task
  WHEN $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'blocked' AND $after.status IN ['ready', 'cancelled']) OR
    ($before.status = 'ready' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['completed', 'failed', 'cancelled']) OR
    ($before.status = 'failed' AND $after.status IN ['ready', 'cancelled'])
  )
  THEN { THROW '허용되지 않은 Task 상태 전이입니다'; };
`,
);

export const WORK_STRATEGY_PROJECTION_MIGRATION = defineMigration(
  "0023-work-strategy-projection",
  `
DEFINE FIELD active_plan_version_id ON work TYPE option<string>;
DEFINE FIELD context_version_id ON plan_version TYPE option<string>;
DEFINE FIELD strategy_generation_id ON plan_version TYPE option<string>;
DEFINE FIELD strategy_checksum ON plan_version TYPE option<string>;
DEFINE FIELD plan_version_id ON work_task TYPE option<string>;
DEFINE FIELD task_key ON work_task TYPE option<string>;
DEFINE FIELD required_capabilities ON work_task TYPE option<array<string>>;
DEFINE FIELD recommended_agent_handles ON work_task TYPE option<array<string>>;
DEFINE FIELD parallelizable ON work_task TYPE option<bool>;
DEFINE INDEX work_active_plan ON work FIELDS organization_id, active_plan_version_id;
DEFINE INDEX work_task_plan ON work_task FIELDS organization_id, work_id, plan_version_id;
DEFINE INDEX work_task_strategy_key ON work_task FIELDS organization_id, work_id, plan_version_id, task_key UNIQUE;
`,
);

export const WORK_ASSURANCE_LINK_MIGRATION = defineMigration(
  "0042-work-assurance-link",
  `
DEFINE FIELD assurance_run_id ON work_verification TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD target_work_revision ON work_verification TYPE int ASSERT $value >= 1;
DEFINE FIELD projected_work_revision ON work_verification TYPE int ASSERT $value = $this.target_work_revision + 1;
DEFINE FIELD snapshot_hash ON work_verification TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD profile_id ON work_verification TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD profile_version ON work_verification TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD binding_version_id ON work_verification TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD evidence_artifact_version_id ON work_verification TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE INDEX work_verification_assurance_run ON work_verification FIELDS organization_id, assurance_run_id UNIQUE;

DEFINE FIELD creator_agent_handle ON artifact_version TYPE option<string> ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 200);
DEFINE FIELD creator_execution_id ON artifact_version TYPE option<string> ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 200);
DEFINE EVENT artifact_version_runtime_provenance ON TABLE artifact_version
WHEN $event = 'CREATE' AND ($after.creator_agent_handle != NONE OR $after.creator_execution_id != NONE)
THEN {
  IF $after.creator_agent_handle = NONE OR $after.creator_execution_id = NONE {
    THROW 'ArtifactVersion Runtime provenance는 handle과 execution이 함께 필요합니다';
  };
  LET $executions = (SELECT execution_id FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $after.creator_execution_id AND agent_handle = $after.creator_agent_handle AND status = 'succeeded');
  IF array::len($executions) != 1 {
    THROW 'ArtifactVersion creator Runtime Execution이 유효하지 않습니다';
  };
};
DEFINE EVENT artifact_version_immutable ON TABLE artifact_version
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'ArtifactVersion은 immutable입니다'; };

DEFINE EVENT work_verification_assurance_invariant ON TABLE work_verification
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'Assurance WorkVerification은 immutable입니다';
  };
  LET $works = (SELECT work_id FROM work WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND status = 'verifying' AND revision = $after.target_work_revision);
  IF array::len($works) != 1 {
    THROW 'WorkVerification target Work revision이 유효하지 않습니다';
  };
  LET $runs = (SELECT * FROM assurance_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND target_work_revision = $after.target_work_revision AND snapshot_hash = $after.snapshot_hash AND profile_id = $after.profile_id AND profile_version = $after.profile_version AND binding_version_id = $after.binding_version_id AND projected_work_revision = NONE);
  IF array::len($runs) != 1 OR
    ($after.passed = true AND $runs[0].status != 'passed') OR
    ($after.passed = false AND $runs[0].status != 'failed') {
    THROW 'WorkVerification terminal Assurance run 연결이 유효하지 않습니다';
  };
  LET $bindings = (SELECT binding_version_id FROM assurance_binding_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $after.binding_version_id AND plan_version_id = $runs[0].plan_version_id AND profile_id = $after.profile_id AND profile_version = $after.profile_version AND status = 'active');
  IF array::len($bindings) != 1 {
    THROW 'WorkVerification Assurance binding이 active가 아닙니다';
  };
  LET $nodes = (SELECT handle FROM organization_node WHERE organization_id = $after.organization_id AND handle = $runs[0].verifier_handle AND status = 'active');
  LET $verifier_executions = (SELECT execution_id FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $runs[0].verifier_execution_id AND agent_handle = $runs[0].verifier_handle AND status = 'succeeded');
  IF array::len($nodes) != 1 OR array::len($verifier_executions) != 1 {
    THROW 'WorkVerification verifier OrganizationNode와 Runtime Execution이 유효하지 않습니다';
  };
  LET $evidence = (SELECT artifact_version_id FROM artifact_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND artifact_version_id = $after.evidence_artifact_version_id);
  IF array::len($evidence) != 1 OR array::len($after.evidence_artifact_version_ids) != 1 OR $after.evidence_artifact_version_ids[0] != $after.evidence_artifact_version_id {
    THROW 'WorkVerification evidence ArtifactVersion 연결이 유효하지 않습니다';
  };
};

DEFINE EVENT OVERWRITE assurance_run_state_invariant ON TABLE assurance_run
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.status IN ['planned', 'running'] AND $after.active_guard_key != NONE AND $after.verdict = NONE AND $after.projected_work_revision = NONE AND $after.completed_at = NONE AND $after.failure_json = NONE) OR
    ($after.status = 'passed' AND $after.active_guard_key = NONE AND $after.verdict = 'passed' AND $after.completed_at != NONE AND $after.failure_json = NONE AND ($after.projected_work_revision = NONE OR $after.projected_work_revision = $after.target_work_revision + 1)) OR
    ($after.status = 'failed' AND $after.active_guard_key = NONE AND $after.verdict = 'failed' AND $after.completed_at != NONE AND $after.failure_json != NONE AND ($after.projected_work_revision = NONE OR $after.projected_work_revision = $after.target_work_revision + 1)) OR
    ($after.status = 'blocked' AND $after.active_guard_key = NONE AND $after.verdict = 'blocked' AND $after.projected_work_revision = NONE AND $after.completed_at != NONE AND $after.failure_json != NONE) OR
    ($after.status = 'cancelled' AND $after.active_guard_key = NONE AND $after.verdict = NONE AND $after.projected_work_revision = NONE AND $after.completed_at != NONE AND $after.failure_json = NONE)
  ) {
    THROW 'Assurance run 상태 metadata 불변식 위반';
  };
  IF $event = 'CREATE' AND $after.version != 1 {
    THROW 'Assurance run은 version 1로 생성해야 합니다';
  };
  IF $event = 'CREATE' AND $after.status != 'planned' {
    THROW 'Assurance run은 planned 상태로만 생성해야 합니다';
  };
  IF $event = 'CREATE' {
    LET $works = (SELECT work_id FROM work WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND status = 'verifying' AND revision = $after.target_work_revision);
    LET $nodes = (SELECT handle FROM organization_node WHERE organization_id = $after.organization_id AND handle = $after.verifier_handle AND status = 'active');
    LET $executions = (SELECT execution_id FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $after.verifier_execution_id AND agent_handle = $after.verifier_handle AND status IN ['queued', 'running']);
    IF array::len($works) != 1 OR array::len($nodes) != 1 OR array::len($executions) != 1 {
      THROW 'Assurance run의 Work·OrganizationNode·Runtime Execution 연결이 유효하지 않습니다';
    };
  };
  IF $event = 'UPDATE' AND $after.version != $before.version + 1 {
    THROW 'Assurance run version은 한 번에 1만 증가해야 합니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['blocked', 'cancelled'] {
    THROW 'Terminal Assurance run은 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['passed', 'failed'] AND !(
    $before.projected_work_revision = NONE AND
    $after.projected_work_revision = $before.target_work_revision + 1 AND
    $after.status = $before.status AND
    $after.verdict = $before.verdict AND
    $after.failure_json = $before.failure_json AND
    $after.completed_at = $before.completed_at
  ) {
    THROW 'Terminal Assurance run은 한 번만 Work에 투영할 수 있습니다';
  };
  IF $event = 'UPDATE' AND (
    $after.assurance_run_id != $before.assurance_run_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.target_work_revision != $before.target_work_revision OR
    $after.plan_version_id != $before.plan_version_id OR
    $after.binding_version_id != $before.binding_version_id OR
    $after.profile_id != $before.profile_id OR
    $after.profile_version != $before.profile_version OR
    $after.verifier_handle != $before.verifier_handle OR
    $after.verifier_execution_id != $before.verifier_execution_id OR
    $after.snapshot_hash != $before.snapshot_hash OR
    $after.attempt != $before.attempt OR
    $after.start_command_id != $before.start_command_id OR
    $after.created_by_user_id != $before.created_by_user_id OR
    $after.created_at != $before.created_at OR
    $after.expires_at != $before.expires_at OR
    $after.started_at != $before.started_at
  ) {
    THROW 'Assurance run identity field는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['planned', 'running'] AND $after.status IN ['planned', 'running'] AND $after.active_guard_key != $before.active_guard_key {
    THROW 'Active Assurance run guard key는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'planned' AND $after.status IN ['running', 'blocked', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['passed', 'failed', 'blocked', 'cancelled'])
  ) {
    THROW '허용되지 않은 Assurance run 상태 전이';
  };
};

DEFINE EVENT OVERWRITE work_assurance_completion_guard ON TABLE work
WHEN $event = 'UPDATE' AND $before.status != 'completed' AND $after.status = 'completed'
THEN {
  LET $verifications = (SELECT * FROM work_verification WHERE organization_id = $after.organization_id AND work_id = $after.work_id ORDER BY created_at DESC LIMIT 1);
  IF array::len($verifications) != 1 OR $verifications[0].passed != true {
    THROW 'completed 전이에는 최신 passed Assurance Verification이 필요합니다';
  };
  LET $runs = (SELECT * FROM assurance_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $verifications[0].assurance_run_id AND status = 'passed');
  IF array::len($runs) != 1 OR
    $runs[0].target_work_revision != $verifications[0].target_work_revision OR
    $runs[0].projected_work_revision != $verifications[0].projected_work_revision OR
    $runs[0].snapshot_hash != $verifications[0].snapshot_hash OR
    $runs[0].profile_id != $verifications[0].profile_id OR
    $runs[0].profile_version != $verifications[0].profile_version OR
    $runs[0].binding_version_id != $verifications[0].binding_version_id {
    THROW 'completed 전이의 Assurance run 연결이 유효하지 않습니다';
  };
  LET $records = (SELECT * FROM work_record WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND finalized = true ORDER BY version DESC LIMIT 1);
  IF array::len($records) != 1 OR
    $records[0].recorded_work_revision != $before.revision OR
    $before.revision != $verifications[0].projected_work_revision + 1 OR
    $verifications[0].verification_id NOT IN $records[0].verification_ids OR
    $verifications[0].evidence_artifact_version_id NOT IN $records[0].artifact_version_ids {
    THROW 'completed 전이에는 Assurance Verification을 포함한 최신 WorkRecord가 필요합니다';
  };
};
`,
);

export const WORK_RECORDS_LINK_MIGRATION = defineMigration(
  "0048-work-records-link",
  `
DEFINE FIELD records_schema_version ON work TYPE option<string> ASSERT $value = NONE OR $value = 'massion.work.records.v1';
DEFINE FIELD records_run_id ON work_record TYPE option<string>;
DEFINE FIELD records_snapshot_hash ON work_record TYPE option<string> ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD document_ids ON work_record TYPE option<array<string>> ASSERT $value = NONE OR array::len($value) <= 3;
DEFINE FIELD schema_version ON work_record TYPE option<string> ASSERT $value = NONE OR $value = 'massion.work-record.v1';
DEFINE INDEX work_record_records_run ON work_record FIELDS records_run_id UNIQUE;

DEFINE EVENT work_record_records_projection_invariant ON TABLE work_record
WHEN $event = 'CREATE'
THEN {
  LET $works = (SELECT records_schema_version FROM work WHERE organization_id = $after.organization_id AND work_id = $after.work_id);
  LET $runs = (SELECT * FROM records_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND records_run_id = $after.records_run_id);
  LET $any_runs = (SELECT records_run_id FROM records_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id LIMIT 1);
  IF array::len($works) != 1 {
    THROW 'WorkRecord 대상 Work를 찾을 수 없습니다';
  };
  IF ($works[0].records_schema_version = 'massion.work.records.v1' OR array::len($any_runs) != 0) AND (
    $after.records_run_id = NONE OR
    $after.records_snapshot_hash = NONE OR
    $after.document_ids = NONE OR
    $after.schema_version != 'massion.work-record.v1'
  ) {
    THROW 'Phase 13 WorkRecord는 Records projection으로만 생성할 수 있습니다';
  };
  IF $after.records_run_id != NONE {
    IF array::len($runs) != 1 OR
      $runs[0].status != 'rendering' OR
      $runs[0].target_work_revision + 1 != $after.recorded_work_revision OR
      $runs[0].snapshot_hash != $after.records_snapshot_hash OR
      $runs[0].verification_id NOT IN $after.verification_ids {
      THROW 'WorkRecord Records run 연결이 유효하지 않습니다';
    };
    LET $documents = (SELECT document_id FROM records_document WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND records_run_id = $after.records_run_id AND document_id IN $after.document_ids);
    IF array::len($documents) != array::len($after.document_ids) {
      THROW 'WorkRecord Records document 연결이 유효하지 않습니다';
    };
  };
};

DEFINE EVENT work_record_immutable ON TABLE work_record
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'WorkRecord는 immutable입니다';
};
`,
);

export const WORK_RECORDS_COMPLETION_MIGRATION = defineMigration(
  "0049-work-records-completion",
  `
DEFINE EVENT work_records_completion_guard ON TABLE work
WHEN $event = 'UPDATE' AND $before.status != 'completed' AND $after.status = 'completed'
THEN {
  LET $runs = (SELECT * FROM records_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id ORDER BY target_work_revision DESC LIMIT 1);
  IF array::len($runs) != 0 {
    IF $before.records_schema_version != 'massion.work.records.v1' OR $after.revision != $before.revision + 1 {
      THROW 'Records completed 전이의 Work schema 또는 revision이 유효하지 않습니다';
    };
    LET $run = $runs[0];
    IF $run.status NOT IN ['finalized', 'completed'] OR $before.revision != $run.target_work_revision + 1 {
      THROW 'Records completed 전이의 run 상태 또는 N+2 revision이 유효하지 않습니다';
    };
    LET $records = (SELECT * FROM work_record WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND finalized = true ORDER BY version DESC LIMIT 1);
    IF array::len($records) != 1 OR
      $records[0].recorded_work_revision != $before.revision OR
      $records[0].records_run_id != $run.records_run_id OR
      $records[0].records_snapshot_hash != $run.snapshot_hash OR
      $records[0].schema_version != 'massion.work-record.v1' OR
      $run.verification_id NOT IN $records[0].verification_ids {
      THROW 'Records completed 전이의 WorkRecord 계보가 유효하지 않습니다';
    };
    LET $verifications = (SELECT verification_id FROM work_verification WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND verification_id = $run.verification_id AND passed = true);
    IF array::len($verifications) != 1 {
      THROW 'Records completed 전이의 passed Verification이 유효하지 않습니다';
    };
    LET $required = (SELECT kind FROM documentation_impact_assessment WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND records_run_id = $run.records_run_id AND outcome = 'required' AND kind != 'work-record');
    LET $documents = (SELECT document_id, kind, artifact_version_id, markdown_checksum FROM records_document WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND records_run_id = $run.records_run_id AND document_id IN $records[0].document_ids);
    IF array::len($documents) != array::len($records[0].document_ids) OR array::len($documents) != array::len($required) OR !$required.all(|$assessment| $documents.any(|$document| $document.kind = $assessment.kind)) {
      THROW 'Records completed 전이의 required document 집합이 유효하지 않습니다';
    };
    LET $artifacts = (SELECT artifact_version_id, checksum FROM artifact_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND artifact_version_id IN $documents.artifact_version_id AND crypto::sha256(content_json) = checksum);
    IF array::len($artifacts) != array::len($documents) OR !$documents.all(|$document| $artifacts.any(|$artifact| $artifact.artifact_version_id = $document.artifact_version_id AND $artifact.checksum = $document.markdown_checksum)) OR !$documents.all(|$document| $document.artifact_version_id IN $records[0].artifact_version_ids) {
      THROW 'Records completed 전이의 document Artifact checksum이 유효하지 않습니다';
    };
  };
};
`,
);

export const WORK_PROMPT_VERSION_MIGRATION = defineMigration(
  "0053-work-prompt-version",
  `
DEFINE FIELD prompt_schema_version ON work TYPE option<string> ASSERT $value = NONE OR $value = 'massion.work.prompt.v1';
DEFINE EVENT work_prompt_version_invariant ON TABLE work
WHEN $event = 'CREATE' OR ($event = 'UPDATE' AND ($before.prompt_version_id != $after.prompt_version_id OR $before.prompt_schema_version != $after.prompt_schema_version))
THEN {
  IF $after.prompt_schema_version = 'massion.work.prompt.v1' AND $after.prompt_version_id = NONE {
    THROW 'Growth-aware Work에는 PromptVersion ID가 필요합니다';
  };
  IF $event = 'UPDATE' {
    THROW 'Work의 PromptVersion 계보는 변경할 수 없습니다';
  };
};
`,
);

export const WORK_WORKSPACE_MIGRATION = defineMigration(
  "0107-work-workspace",
  `
DEFINE FIELD workspace_id ON work TYPE option<string>;
DEFINE INDEX work_by_workspace ON work FIELDS organization_id, workspace_id;
`,
);

export const WORK_AUTONOMY_LINEAGE_MIGRATION = defineMigration(
  "0112-work-autonomy-lineage",
  `
DEFINE FIELD autonomy_mode ON work TYPE option<string>
  ASSERT $value = NONE OR $value IN ['automatic', 'review', 'full-access'];
DEFINE FIELD autonomy_revision ON work TYPE option<int>
  ASSERT $value = NONE OR $value >= 0;
DEFINE EVENT work_autonomy_lineage_invariant ON work
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF ($after.autonomy_mode = NONE) != ($after.autonomy_revision = NONE) {
    THROW 'Work 자율성 계보는 mode와 revision을 함께 저장해야 합니다';
  };
  IF $event = 'UPDATE' AND $before.autonomy_mode != NONE AND (
    $after.autonomy_mode != $before.autonomy_mode OR
    $after.autonomy_revision != $before.autonomy_revision
  ) {
    THROW 'Work 자율성 계보는 immutable입니다';
  };
};
`,
);

export const WORK_HANDOFF_RECIPIENT_MIGRATION = defineMigration(
  "0117-work-handoff-recipient",
  `
DEFINE FIELD recipient_agent_id ON collaboration_message TYPE option<string>;
`,
);

export const WORK_OUTPUT_LOCALE_MIGRATION = defineMigration(
  "0118-work-output-locale",
  `
DEFINE FIELD output_locale ON work_request TYPE option<string>
  ASSERT $value = NONE OR $value IN ['en', 'ko'];
`,
);

export const WORK_TASK_PLACEMENT_SIGNAL_MIGRATION = defineMigration(
  "0125-work-task-placement-signal",
  `
DEFINE FIELD task_axis ON work_task TYPE option<string>
  ASSERT $value = NONE OR $value IN ['code-generation', 'code-understanding', 'planning-design', 'review-critique', 'summary-records'];
DEFINE FIELD reasoning_difficulty ON work_task TYPE option<string>
  ASSERT $value = NONE OR $value IN ['low', 'medium', 'high'];
`,
);
