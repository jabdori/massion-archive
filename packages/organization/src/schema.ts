import { defineMigration } from "@massion/storage";

export const ORGANIZATION_GRAPH_MIGRATION = defineMigration(
  "0003-organization-graph",
  `
DEFINE TABLE organization_node SCHEMAFULL;
DEFINE FIELD node_id ON organization_node TYPE string;
DEFINE FIELD organization_id ON organization_node TYPE string;
DEFINE FIELD handle ON organization_node TYPE string;
DEFINE FIELD name ON organization_node TYPE string;
DEFINE FIELD responsibility ON organization_node TYPE string;
DEFINE FIELD outputs ON organization_node TYPE array<string>;
DEFINE FIELD parent_handle ON organization_node TYPE option<string>;
DEFINE FIELD scope ON organization_node TYPE string;
DEFINE FIELD work_id ON organization_node TYPE option<string>;
DEFINE FIELD builtin ON organization_node TYPE bool;
DEFINE FIELD status ON organization_node TYPE string;
DEFINE FIELD role ON organization_node TYPE string;
DEFINE FIELD created_at ON organization_node TYPE datetime;
DEFINE INDEX organization_node_id ON organization_node FIELDS node_id UNIQUE;
DEFINE INDEX organization_node_handle ON organization_node FIELDS organization_id, handle UNIQUE;
DEFINE INDEX organization_node_tenant ON organization_node FIELDS organization_id;

DEFINE TABLE organization_version SCHEMAFULL;
DEFINE FIELD version_id ON organization_version TYPE string;
DEFINE FIELD organization_id ON organization_version TYPE string;
DEFINE FIELD version ON organization_version TYPE int;
DEFINE FIELD previous_version ON organization_version TYPE option<int>;
DEFINE FIELD command_id ON organization_version TYPE string;
DEFINE FIELD command_kind ON organization_version TYPE string;
DEFINE FIELD request_json ON organization_version TYPE string;
DEFINE FIELD impact_json ON organization_version TYPE string;
DEFINE FIELD actor_user_id ON organization_version TYPE string;
DEFINE FIELD before_json ON organization_version TYPE string;
DEFINE FIELD after_json ON organization_version TYPE string;
DEFINE FIELD created_at ON organization_version TYPE datetime;
DEFINE INDEX organization_version_id ON organization_version FIELDS version_id UNIQUE;
DEFINE INDEX organization_version_number ON organization_version FIELDS organization_id, version UNIQUE;
DEFINE INDEX organization_version_command ON organization_version FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE organization_reference SCHEMAFULL;
DEFINE FIELD reference_id ON organization_reference TYPE string;
DEFINE FIELD organization_id ON organization_reference TYPE string;
DEFINE FIELD node_handle ON organization_reference TYPE string;
DEFINE FIELD kind ON organization_reference TYPE string;
DEFINE FIELD target_id ON organization_reference TYPE string;
DEFINE FIELD created_at ON organization_reference TYPE datetime;
DEFINE INDEX organization_reference_id ON organization_reference FIELDS reference_id UNIQUE;
DEFINE INDEX organization_reference_unique ON organization_reference FIELDS organization_id, node_handle, kind, target_id UNIQUE;
DEFINE INDEX organization_reference_node ON organization_reference FIELDS organization_id, node_handle;
`,
);

export const ORGANIZATION_CAPABILITY_MIGRATION = defineMigration(
  "0034-organization-capabilities",
  `
DEFINE FIELD capabilities ON organization_node TYPE array<string> DEFAULT [];
UPDATE organization_node SET capabilities = [] WHERE capabilities = NONE;
`,
);

export const ORGANIZATION_CORE_OFFICE_CAPABILITY_BACKFILL_MIGRATION = defineMigration(
  "0124-organization-core-office-capability-backfill",
  `
UPDATE organization_node SET capabilities = ["request-coordination"] WHERE builtin = true AND handle = "representative" RETURN NONE;
UPDATE organization_node SET capabilities = ["context-strategy"] WHERE builtin = true AND handle = "context-strategy" RETURN NONE;
UPDATE organization_node SET capabilities = ["evidence-research"] WHERE builtin = true AND handle = "evidence-research" RETURN NONE;
UPDATE organization_node SET capabilities = ["governance"] WHERE builtin = true AND handle = "governance" RETURN NONE;
UPDATE organization_node SET capabilities = ["delivery-coordination"] WHERE builtin = true AND handle = "delivery-coordination" RETURN NONE;
UPDATE organization_node SET capabilities = ["assurance"] WHERE builtin = true AND handle = "assurance" RETURN NONE;
UPDATE organization_node SET capabilities = ["records-documentation"] WHERE builtin = true AND handle = "records-documentation" RETURN NONE;
UPDATE organization_node SET capabilities = ["growth"] WHERE builtin = true AND handle = "growth" RETURN NONE;
`,
);
