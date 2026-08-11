import { randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { classifyFailure, type FailureClass, type FailureSignal } from "@massion/router";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type {
  AgentExecutionInput,
  AgentExecutionResult,
  RuntimeExecutionError,
  RuntimeExecutionStatus,
} from "./contracts.js";
import type { AgentConfigurationReader, ResolvedAgentConfiguration } from "./agent-configuration.js";
import {
  RUNTIME_ACTOR_LINEAGE_MIGRATION,
  RUNTIME_AUTONOMY_LINEAGE_MIGRATION,
  RUNTIME_BLOCKED_TRANSITION_MIGRATION,
  RUNTIME_EXECUTION_MIGRATION,
  RUNTIME_PROMPT_LINEAGE_MIGRATION,
} from "./schema.js";

export interface RuntimeExecution {
  readonly execution_id: string;
  readonly organization_id: string;
  readonly actor_user_id?: string;
  readonly work_id: string;
  readonly task_id?: string;
  readonly agent_handle: string;
  readonly model_route: string;
  readonly correlation_id: string;
  readonly input_json: string;
  readonly status: RuntimeExecutionStatus;
  readonly version: number;
  readonly event_sequence: number;
  readonly output_json?: string;
  readonly error_json?: string;
  readonly prompt_version_id?: string;
  readonly prompt_checksum?: string;
  readonly memory_version_ids?: readonly string[];
  readonly agent_instruction_checksum?: string;
  readonly autonomy_mode?: "automatic" | "review" | "full-access";
  readonly autonomy_revision?: number;
  readonly started_at?: unknown;
  readonly ended_at?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface RuntimeRecoveryCandidate {
  readonly execution_id: string;
  readonly organization_id: string;
  readonly actor_user_id?: string;
  readonly status: "running" | "suspended";
}

export interface RuntimeEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly execution_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

export interface RuntimeWorkflowBinding {
  readonly binding_id: string;
  readonly organization_id: string;
  readonly execution_id: string;
  readonly workflow_id: string;
  readonly workflow_execution_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const SAFE_RUNTIME_ERROR = {
  category: "runtime",
  retryable: false,
  userMessage: "Agent 실행이 종료됐습니다",
} as const;

const BLOCKED_MODEL_UNAVAILABLE_ERROR = {
  category: "runtime",
  retryable: false,
  userMessage: "Agent 실행에 실패했습니다",
} as const;

const RUNTIME_ERROR_RETRYABLE = {
  runtime: false,
  authentication: false,
  billing: false,
  quota: true,
  upstream: true,
  timeout: true,
  network: true,
  provider: true,
  input: false,
  policy: false,
  cancelled: false,
  output: false,
  unknown: false,
} as const satisfies Readonly<Record<FailureClass | "provider" | "runtime", boolean>>;

type RuntimeErrorCategory = keyof typeof RUNTIME_ERROR_RETRYABLE;

function safeCauseId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

export function runtimeErrorFromFailureSignal(
  signal: FailureSignal,
  causeId?: string,
): { readonly category: RuntimeErrorCategory; readonly retryable: boolean; readonly causeId?: string } {
  const category = classifyFailure(signal).failureClass;
  const safeId = safeCauseId(causeId);
  return {
    category,
    retryable: RUNTIME_ERROR_RETRYABLE[category],
    ...(safeId === undefined ? {} : { causeId: safeId }),
  };
}

export function runtimeErrorFromStructuredFailure(failure: {
  readonly category?: unknown;
  readonly retryable?: unknown;
  readonly signal: FailureSignal;
}): { readonly category: RuntimeErrorCategory; readonly retryable: boolean } {
  if (
    typeof failure.category === "string" &&
    Object.hasOwn(RUNTIME_ERROR_RETRYABLE, failure.category) &&
    typeof failure.retryable === "boolean"
  ) {
    const category = failure.category as RuntimeErrorCategory;
    if (failure.retryable === RUNTIME_ERROR_RETRYABLE[category]) {
      return { category, retryable: failure.retryable };
    }
  }
  return runtimeErrorFromFailureSignal(failure.signal);
}

function persistedError(errorJson: string | undefined): RuntimeExecutionError {
  if (!errorJson) return SAFE_RUNTIME_ERROR;
  let value: unknown;
  try {
    value = JSON.parse(errorJson) as unknown;
  } catch {
    return SAFE_RUNTIME_ERROR;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return SAFE_RUNTIME_ERROR;
  const error = value as Record<string, unknown>;
  const keys = Object.keys(error);
  if (
    keys.some((key) => !["category", "retryable", "causeId"].includes(key)) ||
    !Object.hasOwn(error, "category") ||
    !Object.hasOwn(error, "retryable") ||
    typeof error.category !== "string" ||
    !Object.hasOwn(RUNTIME_ERROR_RETRYABLE, error.category) ||
    typeof error.retryable !== "boolean"
  ) {
    return SAFE_RUNTIME_ERROR;
  }
  const category = error.category as RuntimeErrorCategory;
  if (error.retryable !== RUNTIME_ERROR_RETRYABLE[category]) return SAFE_RUNTIME_ERROR;
  const causeId = safeCauseId(error.causeId);
  return {
    category,
    retryable: error.retryable,
    userMessage: SAFE_RUNTIME_ERROR.userMessage,
    ...(causeId === undefined ? {} : { causeId }),
  };
}

function persistedOutput(outputJson: string | undefined): { readonly output: unknown } | undefined {
  if (!outputJson) return undefined;
  try {
    const stored = JSON.parse(outputJson) as unknown;
    return {
      output:
        stored && typeof stored === "object" && "output" in stored
          ? (stored as Record<string, unknown>).output
          : stored,
    };
  } catch {
    return undefined;
  }
}

export function runtimeExecutionResult(execution: RuntimeExecution): AgentExecutionResult {
  const output = persistedOutput(execution.output_json);
  const failed = ["failed", "interrupted"].includes(execution.status);
  const blocked = execution.status === "blocked_model_unavailable" && Boolean(execution.error_json);
  return {
    executionId: execution.execution_id,
    status: execution.status,
    ...(output ?? {}),
    ...(failed
      ? { error: persistedError(execution.error_json) }
      : blocked
        ? { error: BLOCKED_MODEL_UNAVAILABLE_ERROR }
        : {}),
  };
}

export interface TransitionExecutionInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
  readonly target: RuntimeExecutionStatus;
  readonly payload: unknown;
}

export interface BindWorkflowInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
}

export interface AppendRuntimeEventInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
  readonly eventType: string;
  readonly payload: unknown;
}

export type RuntimeSubscriptionReceiptEventType =
  | "subscription_route_session_acquired"
  | "subscription_invocation_started"
  | "subscription_checkpoint_observed"
  | "subscription_terminal_observed"
  | "subscription_settlement_completed";

export interface AppendRuntimeSubscriptionReceiptInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly eventType: RuntimeSubscriptionReceiptEventType;
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly executionId: string;
    readonly workId: string;
    readonly agentHandle: string;
    readonly routeAttemptId: string;
    readonly leaseId: string;
    readonly accountId: string;
    readonly connectorId: string;
    readonly adapterId: string;
    readonly quotaSnapshotId?: string;
  };
}

export interface AppendRuntimeSubscriptionReceiptResult {
  readonly execution: RuntimeExecution;
  readonly event: RuntimeEvent;
  readonly replayed: boolean;
}

const TRANSITIONS: Readonly<Record<RuntimeExecutionStatus, readonly RuntimeExecutionStatus[]>> = {
  queued: ["running", "blocked_model_unavailable", "cancelled"],
  running: ["suspended", "succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"],
  suspended: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  blocked_model_unavailable: [],
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class RuntimeExecutionStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly configurations?: AgentConfigurationReader,
    private readonly autonomy?: (
      context: TenantContext,
      executor: QueryExecutor,
    ) => Promise<{
      readonly mode: "automatic" | "review" | "full-access";
      readonly revision: number;
    }>,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    configurations?: AgentConfigurationReader,
    autonomy?: (
      context: TenantContext,
      executor: QueryExecutor,
    ) => Promise<{
      readonly mode: "automatic" | "review" | "full-access";
      readonly revision: number;
    }>,
  ): Promise<RuntimeExecutionStore> {
    await applyMigrations(database, [
      RUNTIME_EXECUTION_MIGRATION,
      RUNTIME_BLOCKED_TRANSITION_MIGRATION,
      RUNTIME_PROMPT_LINEAGE_MIGRATION,
      RUNTIME_ACTOR_LINEAGE_MIGRATION,
      RUNTIME_AUTONOMY_LINEAGE_MIGRATION,
    ]);
    return new RuntimeExecutionStore(database, organizations, configurations, autonomy);
  }

  public async createExecution(
    context: TenantContext,
    input: AgentExecutionInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    const created = await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context, input.commandId, requestJson);
      if (repeated) return await this.resultFromEvent(tx, context, repeated);
      const autonomy = this.autonomy ? await this.autonomy(context, tx) : undefined;
      const executionId = randomUUID();
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "CREATE runtime_execution CONTENT { execution_id: $execution_id, organization_id: $organization_id, actor_user_id: $actor_user_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, model_route: $model_route, correlation_id: $correlation_id, input_json: $input_json, autonomy_mode: $autonomy_mode, autonomy_revision: $autonomy_revision, status: 'queued', version: 1, event_sequence: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          execution_id: executionId,
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          work_id: input.workId,
          task_id: input.taskId,
          agent_handle: input.agentHandle,
          model_route: input.modelRoute,
          correlation_id: input.correlationId,
          input_json: canonicalJson(input.input),
          autonomy_mode: autonomy?.mode,
          autonomy_revision: autonomy?.revision,
        },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Execution 생성 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        "execution_queued",
        requestJson,
        input.input,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event };
    });
    if (!this.configurations || created.execution.prompt_version_id) return created;
    const resolved = await this.configurations.resolve(context, {
      executionId: created.execution.execution_id,
      agentHandle: input.agentHandle,
    });
    return await this.attachConfiguration(context, created, resolved);
  }

  public async findExecutionIdByCommand(context: TenantContext, commandId: string): Promise<string | undefined> {
    await this.organizations.verifyTenantContext(context);
    const [events] = await this.database.query<[Pick<RuntimeEvent, "execution_id">[]]>(
      "SELECT execution_id FROM runtime_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    return (await this.findExecution(this.database, context, event.execution_id))?.execution_id;
  }

  public async findResultByCommand(
    context: TenantContext,
    commandId: string,
  ): Promise<AgentExecutionResult | undefined> {
    const executionId = await this.findExecutionIdByCommand(context, commandId);
    if (!executionId) return undefined;
    const execution = await this.execution(this.database, context, executionId);
    if (!["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(execution.status)) {
      return undefined;
    }
    return runtimeExecutionResult(execution);
  }

  public async findResultByExecutionId(
    context: TenantContext,
    executionId: string,
  ): Promise<AgentExecutionResult | undefined> {
    await this.organizations.verifyTenantContext(context);
    const execution = await this.findExecution(this.database, context, executionId);
    if (
      !execution ||
      !["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(execution.status)
    ) {
      return undefined;
    }
    return runtimeExecutionResult(execution);
  }

  private async attachConfiguration(
    context: TenantContext,
    created: { execution: RuntimeExecution; event: RuntimeEvent },
    configuration: ResolvedAgentConfiguration,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const current = await this.execution(transaction, context, created.execution.execution_id);
      if (current.prompt_version_id) {
        if (
          current.prompt_version_id !== configuration.promptVersionId ||
          current.prompt_checksum !== configuration.promptChecksum ||
          current.agent_instruction_checksum !== configuration.instructionChecksum
        ) {
          throw new Error("Runtime Execution Prompt 계보가 이미 다른 값으로 고정됐습니다");
        }
        return { execution: current, event: created.event };
      }
      const [executions] = await transaction.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET prompt_version_id = $prompt_version_id, prompt_checksum = $prompt_checksum, memory_version_ids = $memory_version_ids, agent_instruction_checksum = $agent_instruction_checksum WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        {
          organization_id: context.organizationId,
          execution_id: current.execution_id,
          prompt_version_id: configuration.promptVersionId,
          prompt_checksum: configuration.promptChecksum,
          memory_version_ids: configuration.memoryVersionIds,
          agent_instruction_checksum: configuration.instructionChecksum,
        },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Execution Prompt 계보 저장 결과가 없습니다");
      const result = { execution, event: created.event };
      await transaction.query(
        "UPDATE runtime_event SET result_json = $result_json WHERE organization_id = $organization_id AND event_id = $event_id;",
        {
          organization_id: context.organizationId,
          event_id: created.event.event_id,
          result_json: JSON.stringify(result),
        },
      );
      return result;
    });
  }

  public async transition(
    context: TenantContext,
    input: TransitionExecutionInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context, input.commandId, requestJson);
      if (repeated) return await this.resultFromEvent(tx, context, repeated);
      const current = await this.execution(tx, context, input.executionId);
      if (current.version !== input.expectedVersion)
        throw new Error(`현재 Runtime Execution version은 ${String(current.version)}입니다`);
      if (!TRANSITIONS[current.status].includes(input.target))
        throw new Error(`허용되지 않는 Runtime 전이: ${current.status} -> ${input.target}`);
      const nextSequence = current.event_sequence + 1;
      const terminal = ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(
        input.target,
      );
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET status = $status, version += 1, event_sequence = $sequence, started_at = IF $status = 'running' AND started_at = NONE { time::now() } ELSE { started_at }, ended_at = IF $terminal { time::now() } ELSE { ended_at }, output_json = IF $status = 'succeeded' { $payload_json } ELSE { output_json }, error_json = IF $status IN ['failed', 'interrupted', 'blocked_model_unavailable'] { $payload_json } ELSE { error_json }, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        {
          organization_id: context.organizationId,
          execution_id: current.execution_id,
          status: input.target,
          sequence: nextSequence,
          terminal,
          payload_json: canonicalJson(input.payload),
        },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Execution 전이 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        `execution_${input.target}`,
        requestJson,
        input.payload,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event };
    });
  }

  public async bindWorkflow(
    context: TenantContext,
    input: BindWorkflowInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent; binding: RuntimeWorkflowBinding }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const current = await this.execution(tx, context, input.executionId);
      const [bindings] = await tx.query<[RuntimeWorkflowBinding[]]>(
        "CREATE runtime_workflow_binding CONTENT { binding_id: $binding_id, organization_id: $organization_id, execution_id: $execution_id, workflow_id: $workflow_id, workflow_execution_id: $workflow_execution_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          binding_id: randomUUID(),
          organization_id: context.organizationId,
          execution_id: current.execution_id,
          workflow_id: input.workflowId,
          workflow_execution_id: input.workflowExecutionId,
        },
      );
      const binding = bindings[0];
      if (!binding) throw new Error("Runtime Workflow binding 생성 결과가 없습니다");
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET version += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        { organization_id: context.organizationId, execution_id: current.execution_id },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Workflow binding 전이 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        "workflow_bound",
        requestJson,
        input,
      );
      await this.saveResult(tx, event, { execution, event, binding });
      return { execution, event, binding };
    });
  }

  public async appendEvent(
    context: TenantContext,
    input: AppendRuntimeEventInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context, input.commandId, requestJson);
      if (repeated) return await this.resultFromEvent(tx, context, repeated);
      const current = await this.execution(tx, context, input.executionId);
      if (current.version !== input.expectedVersion)
        throw new Error(`현재 Runtime Execution version은 ${String(current.version)}입니다`);
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET version += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        { organization_id: context.organizationId, execution_id: current.execution_id },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Event append 실행 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        input.eventType,
        requestJson,
        input.payload,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event };
    });
  }

  public async appendSubscriptionReceipt(
    context: TenantContext,
    input: AppendRuntimeSubscriptionReceiptInput,
  ): Promise<AppendRuntimeSubscriptionReceiptResult> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context, input.commandId, requestJson);
      if (repeated) {
        return {
          execution: await this.execution(tx, context, repeated.execution_id),
          event: repeated,
          replayed: true,
        };
      }
      const current = await this.execution(tx, context, input.executionId);
      const [receiptEvents] = await tx.query<[RuntimeEvent[]]>(
        "SELECT * OMIT id FROM runtime_event WHERE organization_id = $organization_id AND execution_id = $execution_id AND event_type IN ['subscription_route_session_acquired', 'subscription_invocation_started', 'subscription_checkpoint_observed', 'subscription_terminal_observed', 'subscription_settlement_completed'] ORDER BY sequence ASC;",
        { organization_id: context.organizationId, execution_id: current.execution_id },
      );
      this.requireSubscriptionReceiptTransition(current, receiptEvents, input);
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET version += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        { organization_id: context.organizationId, execution_id: current.execution_id },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Subscription Receipt append 실행 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        input.eventType,
        requestJson,
        input.payload,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event, replayed: false };
    });
  }

  public async listEvents(context: TenantContext, executionId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    await this.organizations.verifyTenantContext(context);
    await this.execution(this.database, context, executionId);
    const [events] = await this.database.query<[RuntimeEvent[]]>(
      "SELECT * OMIT id FROM runtime_event WHERE organization_id = $organization_id AND execution_id = $execution_id AND sequence > $after_sequence ORDER BY sequence ASC;",
      { organization_id: context.organizationId, execution_id: executionId, after_sequence: afterSequence },
    );
    return events;
  }

  public async listRecoverable(context: TenantContext): Promise<RuntimeExecution[]> {
    await this.organizations.verifyTenantContext(context);
    const [executions] = await this.database.query<[RuntimeExecution[]]>(
      "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND actor_user_id = $actor_user_id AND status IN ['running', 'suspended'] ORDER BY created_at ASC, execution_id ASC;",
      { organization_id: context.organizationId, actor_user_id: context.userId },
    );
    return executions;
  }

  public async listActiveByAutonomy(
    context: TenantContext,
    input: { readonly mode: "automatic" | "review" | "full-access"; readonly revision: number },
  ): Promise<RuntimeExecution[]> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw new Error("자율성 revision이 유효하지 않습니다");
    }
    const [executions] = await this.database.query<[RuntimeExecution[]]>(
      "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND status IN ['running', 'suspended'] AND autonomy_mode = $autonomy_mode AND autonomy_revision = $autonomy_revision ORDER BY created_at ASC, execution_id ASC;",
      {
        organization_id: context.organizationId,
        autonomy_mode: input.mode,
        autonomy_revision: input.revision,
      },
    );
    return executions;
  }

  public async listByCorrelation(context: TenantContext, correlationId: string): Promise<RuntimeExecution[]> {
    await this.organizations.verifyTenantContext(context);
    const normalizedCorrelationId = correlationId.trim();
    if (!normalizedCorrelationId || normalizedCorrelationId.length > 256 || /[\0\r\n]/u.test(normalizedCorrelationId)) {
      throw new Error("실행 상관관계 ID가 유효하지 않습니다");
    }
    const [executions] = await this.database.query<[RuntimeExecution[]]>(
      `SELECT * OMIT id FROM runtime_execution
       WHERE organization_id = $organization_id AND actor_user_id = $actor_user_id
         AND correlation_id = $correlation_id
       ORDER BY created_at ASC, execution_id ASC;`,
      {
        organization_id: context.organizationId,
        actor_user_id: context.userId,
        correlation_id: normalizedCorrelationId,
      },
    );
    return executions;
  }

  public async listStartupRecoverable(): Promise<RuntimeRecoveryCandidate[]> {
    const [executions] = await this.database.query<[RuntimeRecoveryCandidate[]]>(
      "SELECT execution_id, organization_id, actor_user_id, status FROM runtime_execution WHERE status IN ['running', 'suspended'] ORDER BY execution_id ASC;",
    );
    return executions;
  }

  public async getRecovery(
    context: TenantContext,
    executionId: string,
  ): Promise<{
    execution: RuntimeExecution;
    events: RuntimeEvent[];
    binding?: RuntimeWorkflowBinding;
  }> {
    await this.organizations.verifyTenantContext(context);
    const execution = await this.execution(this.database, context, executionId);
    const events = await this.listEvents(context, executionId);
    const [bindings] = await this.database.query<[RuntimeWorkflowBinding[]]>(
      "SELECT * OMIT id FROM runtime_workflow_binding WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: context.organizationId, execution_id: executionId },
    );
    return { execution, events, ...(bindings[0] ? { binding: bindings[0] } : {}) };
  }

  private async execution(
    executor: QueryExecutor,
    context: TenantContext,
    executionId: string,
  ): Promise<RuntimeExecution> {
    const execution = await this.findExecution(executor, context, executionId);
    if (!execution) throw new Error("Runtime Execution을 찾을 수 없습니다");
    return execution;
  }

  private async findExecution(
    executor: QueryExecutor,
    context: TenantContext,
    executionId: string,
  ): Promise<RuntimeExecution | undefined> {
    const [executions] = await executor.query<[RuntimeExecution[]]>(
      "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND actor_user_id = $actor_user_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: context.organizationId, actor_user_id: context.userId, execution_id: executionId },
    );
    return executions[0];
  }

  private requireSubscriptionReceiptTransition(
    execution: RuntimeExecution,
    events: readonly RuntimeEvent[],
    input: AppendRuntimeSubscriptionReceiptInput,
  ): void {
    if (execution.status !== "running") {
      throw new Error("실행 중인 Runtime Execution에만 Subscription Receipt를 기록할 수 있습니다");
    }
    if (
      execution.execution_id !== input.payload.executionId ||
      execution.work_id !== input.payload.workId ||
      execution.agent_handle !== input.payload.agentHandle
    ) {
      throw new Error("Subscription Receipt Execution·Work·Agent 계보가 일치하지 않습니다");
    }
    const parsed = events.map((event) => ({
      event,
      payload: JSON.parse(event.payload_json) as Record<string, unknown>,
    }));
    const lineageEvents = parsed.filter(
      ({ payload }) =>
        payload.routeAttemptId === input.payload.routeAttemptId && payload.leaseId === input.payload.leaseId,
    );
    const previous = lineageEvents.at(-1)?.event;
    if (input.eventType === "subscription_route_session_acquired") {
      if (
        lineageEvents.length > 0 ||
        (events.length > 0 && events.at(-1)?.event_type !== "subscription_settlement_completed")
      ) {
        throw new Error(
          `허용되지 않는 Subscription Receipt 전이: ${events.at(-1)?.event_type ?? "none"} -> ${input.eventType}`,
        );
      }
      return;
    }
    const expectedPrevious: Readonly<
      Record<Exclude<RuntimeSubscriptionReceiptEventType, "subscription_route_session_acquired">, readonly string[]>
    > = {
      subscription_invocation_started: ["subscription_route_session_acquired", "subscription_checkpoint_observed"],
      subscription_checkpoint_observed: ["subscription_invocation_started"],
      subscription_terminal_observed: ["subscription_invocation_started", "subscription_checkpoint_observed"],
      subscription_settlement_completed: ["subscription_terminal_observed"],
    };
    if (!previous || !expectedPrevious[input.eventType].includes(previous.event_type)) {
      throw new Error(
        `허용되지 않는 Subscription Receipt 전이: ${previous?.event_type ?? "none"} -> ${input.eventType}`,
      );
    }
    const acquired = lineageEvents[0];
    if (acquired?.event.event_type !== "subscription_route_session_acquired") {
      throw new Error("Subscription Receipt 취득 계보가 없습니다");
    }
    for (const key of [
      "executionId",
      "workId",
      "agentHandle",
      "routeAttemptId",
      "leaseId",
      "accountId",
      "connectorId",
      "adapterId",
      "quotaSnapshotId",
    ] as const) {
      if (acquired.payload[key] !== input.payload[key]) {
        throw new Error("Subscription Receipt 계보가 중간에 변경됐습니다");
      }
    }
  }

  private async repeated(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    requestJson: string,
  ): Promise<RuntimeEvent | undefined> {
    const [events] = await executor.query<[RuntimeEvent[]]>(
      "SELECT * OMIT id FROM runtime_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    if (events[0] && !(await this.findExecution(executor, context, events[0].execution_id)))
      throw new Error("Runtime command의 행위자 계보가 일치하지 않습니다");
    // 물리 tombstone이 background batch를 기다리는 동안에도 과거 raw stream command는 재생하면 안 됩니다.
    if (events[0]?.event_type.startsWith("model_")) throw new Error("retired raw Runtime Event는 replay할 수 없습니다");
    if (events[0] && events[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Runtime 요청을 사용할 수 없습니다");
    return events[0];
  }

  private async resultFromEvent(
    executor: QueryExecutor,
    context: TenantContext,
    event: RuntimeEvent,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    return { execution: await this.execution(executor, context, event.execution_id), event };
  }

  private async insertEvent(
    executor: QueryExecutor,
    organizationId: string,
    execution: RuntimeExecution,
    commandId: string,
    eventType: string,
    requestJson: string,
    payload: unknown,
  ): Promise<RuntimeEvent> {
    const [events] = await executor.query<[RuntimeEvent[]]>(
      "CREATE runtime_event CONTENT { event_id: $event_id, organization_id: $organization_id, execution_id: $execution_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_json: $request_json, payload_json: $payload_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        execution_id: execution.execution_id,
        command_id: commandId,
        sequence: execution.event_sequence,
        event_type: eventType,
        request_json: requestJson,
        payload_json: canonicalJson(payload),
      },
    );
    if (!events[0]) throw new Error("Runtime Event 생성 결과가 없습니다");
    return events[0];
  }

  private async saveResult(executor: QueryExecutor, event: RuntimeEvent, result: unknown): Promise<void> {
    await executor.query("UPDATE runtime_event SET result_json = $result_json WHERE event_id = $event_id;", {
      event_id: event.event_id,
      result_json: JSON.stringify(result),
    });
  }
}
