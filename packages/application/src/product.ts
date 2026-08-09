import { randomUUID } from "node:crypto";

import type { ApprovalStore, AutonomyStore, EmergencyControl, PolicyStore } from "@massion/governance";
import type { IdentityService, OrganizationService, TenantContext } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";
import type { MassionDatabase } from "@massion/storage";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";

import { registerApplicationDomainCommands, type ApplicationDomainDependencies } from "./adapters/domain.js";
import type { ExecutionStreamRegistry } from "./execution-stream.js";
import { registerApplicationAccessCommands } from "./access-commands.js";
import { SurrealApplicationReadModel } from "./adapters/read-model.js";
import { ApplicationAccessTokenService } from "./auth.js";
import type { ApplicationArtifactGateway } from "./artifacts.js";
import { registerApplicationApprovalCommands } from "./approval-commands.js";
import { LocalApplicationBootstrap } from "./bootstrap.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { CoreWorkCoordinator, type CoreWorkStage, type CoreWorkStageExecutor } from "./core-work-coordinator.js";
import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import {
  ApplicationHttpServer,
  type ApplicationBootstrapAuthorization,
  type ApplicationHttpDependencies,
  type ApplicationHttpServerOptions,
} from "./http-server.js";
import {
  registerApplicationIntegrationOperations,
  type ApplicationIntegrationOperations,
} from "./integration-operations.js";
import { ApplicationMetricStore } from "./metrics.js";
import {
  ApplicationQueryRegistry,
  registerApplicationQueries,
  type ApplicationQueryDependencies,
} from "./query-registry.js";
import { registerApplicationRunCommands } from "./run-commands.js";
import { registerApplicationRegistryOperations, type ApplicationRegistryOperations } from "./registry-operations.js";
import { ApplicationRunStore } from "./run-store.js";
import { AutonomyTransitionCoordinator } from "./autonomy-transition-coordinator.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";
import { registerWorkDirectiveCommands } from "./work-directive-commands.js";
import { WorkDirectiveStore } from "./work-directive-store.js";

/**
 * 한 번에 투영할 최대 event 수. `ApplicationEventProjector.projectPending`의 상한과 같아야
 * "꽉 채웠다 = 남은 것이 있다"는 판정이 성립합니다.
 */
const PROJECTION_BATCH = 1_000;

export interface ApplicationProductDependencies {
  readonly database: MassionDatabase;
  readonly identities: IdentityService;
  readonly organizations: OrganizationService;
  readonly graph: OrganizationGraphService;
  readonly policies: PolicyStore;
  readonly tokenKey: { readonly keyId: string; readonly key: Buffer };
  readonly bootstrapAuthorization?: ApplicationBootstrapAuthorization;
  readonly executors: Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
  readonly domain: ApplicationDomainDependencies;
  readonly autonomyTransition?: {
    readonly autonomy: Pick<AutonomyStore, "get" | "set">;
    readonly approvals: Pick<ApprovalStore, "listPending" | "cancel">;
    readonly runtime: Pick<AgentRunner, "cancel" | "cancelOrganization">;
    readonly runtimeExecutions: Pick<RuntimeExecutionStore, "listActiveByAutonomy">;
    readonly emergency: Pick<EmergencyControl, "get" | "activate">;
  };
  readonly queries?: Omit<ApplicationQueryDependencies, "readModel" | "runs" | "snapshot" | "memberships" | "audit">;
  readonly executionStream?: ExecutionStreamRegistry;
  readonly artifacts?: Pick<ApplicationArtifactGateway, "inspect" | "install" | "update">;
  readonly integrations?: {
    readonly http?: NonNullable<ApplicationHttpDependencies["integrations"]>;
    readonly operations?: ApplicationIntegrationOperations;
  };
  readonly registry?: ApplicationRegistryOperations;
  readonly registryPublisher?: NonNullable<ApplicationHttpDependencies["registryPublisher"]>;
  readonly connectorEnrollments?: NonNullable<ApplicationHttpDependencies["connectorEnrollments"]>;
  readonly health?: NonNullable<ApplicationHttpDependencies["health"]>;
  readonly server?: ApplicationHttpServerOptions;
  readonly onInitialized?: (context: import("@massion/identity").TenantContext) => void | Promise<void>;
}

export class ApplicationProduct implements AsyncDisposable {
  private readonly background = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private readonly activeProjectionOrganizations = new Set<string>();
  private readonly pendingProjectionContexts = new Map<string, TenantContext>();

  private constructor(
    public readonly server: ApplicationHttpServer,
    public readonly commands: ApplicationCommandRegistry,
    public readonly queries: ApplicationQueryRegistry,
    public readonly runs: ApplicationRunStore,
    public readonly directives: WorkDirectiveStore,
    public readonly coordinator: CoreWorkCoordinator,
    public readonly tokens: ApplicationAccessTokenService,
    public readonly events: ApplicationEventStore,
    public readonly projector: ApplicationEventProjector,
    public readonly metrics: ApplicationMetricStore,
  ) {}

  public static async create(dependencies: ApplicationProductDependencies): Promise<ApplicationProduct> {
    const runs = await ApplicationRunStore.create(dependencies.database, dependencies.organizations, {
      graph: dependencies.graph,
    });
    const directives = await WorkDirectiveStore.create(dependencies.database, dependencies.organizations);
    const coordinator = new CoreWorkCoordinator(runs, dependencies.executors, {}, directives);
    const autonomyTransition = dependencies.autonomyTransition
      ? new AutonomyTransitionCoordinator(
          dependencies.autonomyTransition.autonomy,
          dependencies.autonomyTransition.approvals,
          runs,
          coordinator,
          dependencies.autonomyTransition.runtime,
          dependencies.autonomyTransition.runtimeExecutions,
          dependencies.autonomyTransition.emergency,
        )
      : undefined;
    const commandStore = await ApplicationCommandStore.create(dependencies.database, dependencies.organizations);
    const commands = new ApplicationCommandRegistry(commandStore);
    registerApplicationDomainCommands(commands, {
      ...dependencies.domain,
      ...(autonomyTransition === undefined ? {} : { autonomyTransition }),
    });
    const productReference: { current?: ApplicationProduct } = {};
    if (dependencies.domain.approvals) {
      registerApplicationApprovalCommands(commands, {
        approvals: dependencies.domain.approvals,
        ...(dependencies.domain.growth === undefined ? {} : { growth: dependencies.domain.growth }),
        runs,
        coordinator,
        ...(dependencies.domain.runtime === undefined ? {} : { runtime: dependencies.domain.runtime }),
        schedule(context, continuation) {
          const product = productReference.current;
          if (!product) throw new Error("Application product 조립이 완료되지 않았습니다");
          product.track(async () => {
            await continuation();
            product.scheduleProjection(context);
          });
        },
      });
    }

    const readModel = new SurrealApplicationReadModel(dependencies.database, dependencies.organizations);
    const snapshot = new CollaborationGraphSnapshotProjector(readModel);
    const queries = new ApplicationQueryRegistry();

    const tokens = await ApplicationAccessTokenService.create(dependencies.database, dependencies.organizations, {
      keyId: dependencies.tokenKey.keyId,
      key: dependencies.tokenKey.key,
    });
    const metrics = await ApplicationMetricStore.create(dependencies.database, dependencies.organizations);
    const events = await ApplicationEventStore.create(dependencies.database, dependencies.organizations);
    const projector = await ApplicationEventProjector.create(dependencies.database, dependencies.organizations);
    registerApplicationAccessCommands(commands, { organizations: dependencies.organizations });
    registerApplicationQueries(queries, {
      ...dependencies.queries,
      readModel,
      runs,
      snapshot,
      memberships: dependencies.organizations,
      ...(dependencies.domain.workspaces === undefined ? {} : { workspaces: dependencies.domain.workspaces }),
      audit: events,
    });
    if (dependencies.integrations?.operations)
      registerApplicationIntegrationOperations(commands, queries, dependencies.integrations.operations);
    registerApplicationRegistryOperations(
      commands,
      queries,
      dependencies.registry ?? {
        search() {
          return Promise.resolve({ items: [] });
        },
        info() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
        inventory() {
          return Promise.resolve([]);
        },
        install() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
        recall() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
      },
    );
    const bootstrap = new LocalApplicationBootstrap(
      dependencies.identities,
      dependencies.organizations,
      dependencies.graph,
      dependencies.policies,
      tokens,
      dependencies.domain.growth,
      dependencies.onInitialized,
    );

    registerApplicationRunCommands(commands, {
      store: runs,
      coordinator,
      ...(dependencies.domain.workspaces === undefined ? {} : { workspaces: dependencies.domain.workspaces }),
      schedule(context, runId, retryAttemptId) {
        if (!productReference.current) throw new Error("Application product 조립이 완료되지 않았습니다");
        productReference.current.schedule(context, runId, retryAttemptId);
      },
    });
    registerWorkDirectiveCommands(commands, {
      directives,
      runs,
      schedule(context, runId) {
        if (!productReference.current) throw new Error("Application product 조립이 완료되지 않았습니다");
        productReference.current.schedule(context, runId);
      },
    });
    const server = new ApplicationHttpServer(
      {
        auth: tokens,
        queries: {
          async query(context, scopes, operation, payload) {
            const started = performance.now();
            const operationClass = operation.split(".", 1)[0] ?? "unknown";
            const key = randomUUID();
            try {
              const output = await queries.query(context, scopes, operation, payload);
              await metrics.recordOnce(context, `${key}:total`, {
                name: "application_request_total",
                value: 1,
                dimensions: { operationClass, result: "succeeded" },
              });
              await metrics.recordOnce(context, `${key}:duration`, {
                name: "application_request_duration_ms",
                value: performance.now() - started,
                dimensions: { operationClass, result: "succeeded" },
              });
              return output;
            } catch (error) {
              await metrics.recordOnce(context, `${key}:total`, {
                name: "application_request_total",
                value: 1,
                dimensions: { operationClass, result: "failed" },
              });
              throw error;
            }
          },
        },
        commands: {
          async dispatch(context, scopes, input) {
            const output = await commands.dispatch(context, scopes, input);
            await metrics.recordOnce(context, `${output.commandId}:command:${output.outcome}`, {
              name: "application_command_total",
              value: 1,
              dimensions: {
                operationClass: output.operation.split(".", 1)[0] ?? "unknown",
                result: output.outcome,
              },
            });
            if (!productReference.current) throw new Error("Application product 조립이 완료되지 않았습니다");
            productReference.current.scheduleProjection(context);
            return output;
          },
        },
        events: {
          async recover(context) {
            const product = productReference.current;
            if (!product) throw new Error("Application product 조립이 완료되지 않았습니다");
            return await product.drainProjection(context);
          },
          async read(context, input) {
            return await events.read(context, input);
          },
        },
        tokens,
        ...(dependencies.executionStream === undefined ? {} : { executionStream: dependencies.executionStream }),
        ...(dependencies.artifacts === undefined ? {} : { artifacts: dependencies.artifacts }),
        ...(dependencies.integrations?.http === undefined ? {} : { integrations: dependencies.integrations.http }),
        ...(dependencies.registryPublisher === undefined ? {} : { registryPublisher: dependencies.registryPublisher }),
        ...(dependencies.connectorEnrollments === undefined
          ? {}
          : { connectorEnrollments: dependencies.connectorEnrollments }),
        ...(dependencies.health === undefined ? {} : { health: dependencies.health }),
        ...(dependencies.bootstrapAuthorization === undefined
          ? {}
          : {
              bootstrap: {
                authorization: dependencies.bootstrapAuthorization,
                initialize: bootstrap.initialize.bind(bootstrap),
              },
            }),
      },
      dependencies.server,
    );
    const product = new ApplicationProduct(
      server,
      commands,
      queries,
      runs,
      directives,
      coordinator,
      tokens,
      events,
      projector,
      metrics,
    );
    productReference.current = product;
    return product;
  }

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    return await this.server.start();
  }

  public async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
    if (this.failures.length > 0) {
      const failures = this.failures.splice(0);
      throw new AggregateError(failures, "Application background run이 실패했습니다");
    }
  }

  public async close(): Promise<void> {
    await this.server.close();
    await this.drain();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private schedule(context: TenantContext, runId: string, retryAttemptId?: string): void {
    this.track(async () => {
      const run = retryAttemptId
        ? await this.coordinator.retryBlocked(context, runId, retryAttemptId)
        : await this.coordinator.recover(context, runId);
      await this.metrics.recordOnce(context, `${runId}:run:${String(run.leaseGeneration)}`, {
        name: "application_run_total",
        value: 1,
        dimensions: { stage: run.stage, result: run.status },
      });
      this.scheduleProjection(context);
    });
  }

  private scheduleProjection(context: TenantContext): void {
    const organizationId = context.organizationId;
    this.pendingProjectionContexts.set(organizationId, context);
    if (this.activeProjectionOrganizations.has(organizationId)) return;
    this.activeProjectionOrganizations.add(organizationId);
    this.track(async () => {
      try {
        let pending: TenantContext | undefined;
        while ((pending = this.pendingProjectionContexts.get(organizationId)) !== undefined) {
          this.pendingProjectionContexts.delete(organizationId);
          await this.drainProjection(pending);
        }
      } finally {
        this.activeProjectionOrganizations.delete(organizationId);
        const pending = this.pendingProjectionContexts.get(organizationId);
        if (pending) this.scheduleProjection(pending);
      }
    });
  }

  private async drainProjection(context: TenantContext): Promise<boolean> {
    let projected = 0;
    let batch: number;
    do {
      batch = await this.projector.projectPending(context, PROJECTION_BATCH);
      projected += batch;
      // 상한까지 찼으면 다음 명령이나 poll을 기다리지 않고 같은 wake-up에서 계속 비웁니다.
    } while (batch === PROJECTION_BATCH);
    return projected > 0;
  }

  private track(operation: () => Promise<void>): void {
    const task = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        if (this.failures.length >= 32) this.failures.shift();
        this.failures.push(error);
      })
      .finally(() => {
        this.background.delete(task);
      });
    this.background.add(task);
  }
}
