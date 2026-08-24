import { randomUUID } from "node:crypto";

import type { CliInvocation } from "./parser.js";

export interface CliApplicationClient {
  status(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
  inspectArtifact(archive: Uint8Array): Promise<unknown>;
  installArtifact(commandId: string, archive: Uint8Array): Promise<unknown>;
  updateArtifact(commandId: string, archive: Uint8Array): Promise<unknown>;
  publishArtifact?(commandId: string, archive: Uint8Array, metadata: unknown): Promise<unknown>;
  issueConnectorEnrollment?(input: {
    readonly commandId: string;
    readonly location: "edge";
    readonly executionKind: "model" | "agent-runtime";
    readonly ttlMs?: number;
  }): Promise<unknown>;
}

export interface CliCommandInput {
  readonly readJson?: () => Promise<unknown>;
  readonly readArtifact?: (path: string) => Promise<Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly connectServerSubscription?: (input: {
    readonly providerId: string;
    readonly alias?: string;
    readonly modelId?: string;
    readonly newAccount?: boolean;
  }) => Promise<unknown>;
  readonly connectServerModelSubscription?: (input: {
    readonly providerId: "minimax-token-plan" | "zai-coding-plan";
    readonly alias: string;
    readonly authKind: "subscription-key" | "api-key";
    readonly billingKind: "token-plan" | "coding-plan";
    readonly secret: string;
    readonly priority?: number;
    readonly weight?: number;
  }) => Promise<unknown>;
}

function required(arguments_: readonly string[], index: number, label: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${label} 인자가 필요합니다`);
  return value;
}

function integer(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${label}가 유효하지 않습니다`);
  return Number(value);
}

function envelope(operation: string, payload: unknown, expectedRevision?: number, replayCommandId?: string): unknown {
  const commandId = replayCommandId ?? randomUUID();
  return {
    schemaVersion: "massion.application.v1",
    commandId,
    correlationId: randomUUID(),
    operation,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload,
  };
}

async function stdin(input: CliCommandInput, label: string): Promise<Record<string, unknown>> {
  if (!input.readJson) throw new Error(`${label} 입력은 stdin JSON이 필요합니다`);
  const value = await input.readJson();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} stdin JSON은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function exactInput(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
  requiredFields: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} stdin JSON에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = requiredFields.find((key) => value[key] === undefined);
  if (missing) throw new Error(`${label} stdin JSON에 필수 필드가 없습니다: ${missing}`);
  return value;
}

function jsonText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}가 유효하지 않습니다`);
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return normalized;
}

function jsonInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label}가 유효하지 않습니다`);
  return value as number;
}

function jsonSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 16 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("구독 Credential secret이 유효하지 않습니다");
  }
  return value;
}

function zaiCodingPlanEnvironmentSecret(environment: Readonly<Record<string, string | undefined>> | undefined): string {
  const secret = environment?.Z_AI_API_KEY;
  if (typeof secret !== "string" || !secret || secret !== secret.trim() || /[\0\r\n]/u.test(secret)) {
    throw new Error("Z.AI Coding Plan 연결에는 현재 셸의 Z_AI_API_KEY 환경 변수가 필요합니다");
  }
  return jsonSecret(secret);
}

async function subscriptionAccountRevision(client: CliApplicationClient, accountId: string): Promise<number> {
  const response = await client.query("subscription.accounts", {});
  if (!response || typeof response !== "object" || !Array.isArray((response as { data?: unknown }).data)) {
    throw new Error("구독 계정 조회 응답이 유효하지 않습니다");
  }
  const account = (response as { data: unknown[] }).data.find(
    (item) => item && typeof item === "object" && (item as { accountId?: unknown }).accountId === accountId,
  ) as { version?: unknown } | undefined;
  if (!account || !Number.isSafeInteger(account.version) || (account.version as number) < 1) {
    throw new Error(`구독 계정 또는 version을 찾을 수 없습니다: ${accountId}`);
  }
  return account.version as number;
}

const SUBSCRIPTION_APPROVAL_MODES = ["automatic", "review", "deny"] as const;
type SubscriptionApprovalMode = (typeof SUBSCRIPTION_APPROVAL_MODES)[number];

async function assertSubscriptionProviderApprovalMode(
  client: CliApplicationClient,
  providerId: string,
  approvalMode: SubscriptionApprovalMode,
): Promise<void> {
  const response = await client.query("subscription.providers", {});
  if (!response || typeof response !== "object" || !Array.isArray((response as { data?: unknown }).data)) {
    throw new Error("구독 Provider 조회 응답이 유효하지 않습니다");
  }
  const provider = (response as { data: unknown[] }).data.find(
    (item) => item && typeof item === "object" && (item as { providerId?: unknown }).providerId === providerId,
  ) as
    | {
        readonly connectionSurface?: unknown;
        readonly runtimeCapabilities?: unknown;
      }
    | undefined;
  if (!provider) throw new Error(`구독 Provider를 찾을 수 없습니다: ${providerId}`);
  if (provider.connectionSurface === "unavailable") {
    throw new Error("공개 연결 표면이 없는 Provider에는 구독 실행 정책이 허용되지 않습니다");
  }
  const runtimeCapabilities =
    provider.runtimeCapabilities &&
    typeof provider.runtimeCapabilities === "object" &&
    !Array.isArray(provider.runtimeCapabilities)
      ? (provider.runtimeCapabilities as Record<string, unknown>)
      : undefined;
  if (!runtimeCapabilities) return;
  let approvalModes = Array.isArray(runtimeCapabilities.approvalModes)
    ? runtimeCapabilities.approvalModes.filter(
        (value): value is SubscriptionApprovalMode =>
          typeof value === "string" && SUBSCRIPTION_APPROVAL_MODES.includes(value as SubscriptionApprovalMode),
      )
    : [];
  const approvalModesBySurface =
    runtimeCapabilities.approvalModesBySurface &&
    typeof runtimeCapabilities.approvalModesBySurface === "object" &&
    !Array.isArray(runtimeCapabilities.approvalModesBySurface)
      ? (runtimeCapabilities.approvalModesBySurface as Record<string, unknown>)
      : undefined;
  if (approvalModesBySurface) {
    const accountsResponse = await client.query("subscription.accounts", {});
    if (
      !accountsResponse ||
      typeof accountsResponse !== "object" ||
      !Array.isArray((accountsResponse as { data?: unknown }).data)
    ) {
      throw new Error("구독 계정 조회 응답이 유효하지 않습니다");
    }
    const connectedSurfaces = new Set(
      (accountsResponse as { data: unknown[] }).data
        .filter(
          (item): item is { readonly providerId: string; readonly connectorLocation: "server" | "edge" } =>
            item !== null &&
            typeof item === "object" &&
            (item as { providerId?: unknown }).providerId === providerId &&
            ((item as { connectorLocation?: unknown }).connectorLocation === "server" ||
              (item as { connectorLocation?: unknown }).connectorLocation === "edge"),
        )
        .map((account) => account.connectorLocation),
    );
    if (connectedSurfaces.size > 0) {
      const supported = new Set<SubscriptionApprovalMode>();
      for (const surface of connectedSurfaces) {
        const modes = approvalModesBySurface[surface];
        if (!Array.isArray(modes)) continue;
        for (const mode of modes) {
          if (typeof mode === "string" && SUBSCRIPTION_APPROVAL_MODES.includes(mode as SubscriptionApprovalMode)) {
            supported.add(mode as SubscriptionApprovalMode);
          }
        }
      }
      approvalModes = SUBSCRIPTION_APPROVAL_MODES.filter((mode) => supported.has(mode));
    }
  }
  if (!Object.hasOwn(runtimeCapabilities, "approvalModes") && !approvalModesBySurface) return;
  if (!approvalModes.includes(approvalMode)) {
    throw new Error(`이 Provider에서 허용되지 않는 구독 승인 방식입니다: ${approvalMode}`);
  }
}

export async function executeCliInvocation(
  client: CliApplicationClient,
  invocation: CliInvocation,
  input: CliCommandInput = {},
): Promise<unknown> {
  const args = invocation.arguments;
  if (invocation.command === "status" || invocation.command === "doctor") return await client.status();
  if (invocation.command === "resume") {
    const resumeInput = invocation.retryBlocked ? undefined : input.readJson ? await input.readJson() : undefined;
    return await client.command(
      envelope("run.resume", {
        runId: required(args, 0, "runId"),
        ...(resumeInput === undefined ? {} : { resumeInput }),
        retryBlocked: invocation.retryBlocked,
      }),
    );
  }
  if (invocation.command === "org" && invocation.subcommand === "graph") return await client.snapshot();
  if (invocation.command === "work" && invocation.subcommand === "list") return await client.query("work.list", {});
  if (invocation.command === "work" && invocation.subcommand === "get")
    return await client.query("work.get", { workId: required(args, 0, "workId") });
  if (invocation.command === "chat" && invocation.subcommand === "rooms")
    return await client.query("work.rooms", { workId: required(args, 0, "workId") });
  if (invocation.command === "chat" && invocation.subcommand === "messages")
    return await client.query("work.messages", {
      workId: required(args, 0, "workId"),
      roomId: required(args, 1, "roomId"),
    });
  if (invocation.command === "task" && invocation.subcommand === undefined)
    return await client.query("work.tasks", { workId: required(args, 0, "workId") });
  if (invocation.command === "approval" && invocation.subcommand === "list")
    return await client.query("governance.approval.list", {});
  if (invocation.command === "approval" && invocation.subcommand === "get")
    return await client.query("governance.approval.get", { approvalId: required(args, 0, "approvalId") });
  if (invocation.command === "assurance" && invocation.subcommand === "binding-get")
    return await client.query("assurance.binding.get", { bindingVersionId: required(args, 0, "bindingVersionId") });
  if (invocation.command === "assurance" && invocation.subcommand === "binding-active")
    return await client.query("assurance.binding.active", {
      workId: required(args, 0, "workId"),
      planVersionId: required(args, 1, "planVersionId"),
    });
  if (invocation.command === "runtime" && invocation.subcommand === "get")
    return await client.query("runtime.execution.get", { executionId: required(args, 0, "executionId") });
  if (invocation.command === "runtime" && invocation.subcommand === "lineage") {
    if (args[0] === "correlation") {
      return await client.query("runtime.execution.subscription-lineage", {
        correlationId: required(args, 1, "correlationId"),
      });
    }
    return await client.query("runtime.execution.subscription-lineage", {
      executionId: args[0] === "execution" ? required(args, 1, "executionId") : required(args, 0, "executionId"),
    });
  }
  if (invocation.command === "provider" && invocation.subcommand === "list") {
    const [catalog, credentials, routes] = await Promise.all([
      client.query("router.catalog", {}),
      client.query("router.credentials", {}),
      client.query("router.routes", {}),
    ]);
    return { catalog, credentials, routes };
  }
  if (invocation.command === "ext" && invocation.subcommand === "list") return await client.query("extension.list", {});
  if (invocation.command === "ext" && invocation.subcommand === "search")
    return await client.query("registry.search", { query: args.join(" "), limit: 20 });
  if (invocation.command === "ext" && invocation.subcommand === "info")
    return await client.query("registry.info", { versionId: required(args, 0, "versionId") });
  if (invocation.command === "ext" && invocation.subcommand === "inventory")
    return await client.query("registry.inventory", {});
  if (invocation.command === "integration" && invocation.subcommand === "list")
    return await client.query("integration.list", {});
  if (invocation.command === "integration" && invocation.subcommand === "deliveries")
    return await client.query(
      "integration.deliveries",
      args[0] === undefined ? {} : { limit: integer(args[0], "limit") },
    );
  if (invocation.command === "growth" && invocation.subcommand === "status")
    return await client.query("growth.configuration.get", {});
  if (invocation.command === "growth" && invocation.subcommand === "suggestions")
    return await client.query("growth.suggestions", {});
  if (invocation.command === "optimization" && invocation.subcommand === "policy")
    return await client.query("optimization.policy", {});
  if (invocation.command === "optimization" && invocation.subcommand === "receipts")
    return await client.query("optimization.receipts", {});
  if (invocation.command === "optimization" && invocation.subcommand === "recommendations")
    return await client.query("optimization.recommendations", {});
  if (invocation.command === "optimization" && invocation.subcommand === "observations")
    return await client.query("optimization.observations", {});
  if (invocation.command === "optimization" && invocation.subcommand === "batch-active")
    return await client.query("optimization.batch.active", { roleKey: required(args, 0, "roleKey") });
  if (invocation.command === "subscription" && invocation.subcommand === "providers")
    return await client.query("subscription.providers", {});
  if (invocation.command === "subscription" && invocation.subcommand === "enroll") {
    if (!client.issueConnectorEnrollment) throw new Error("Connector enrollment API를 사용할 수 없습니다");
    const location = required(args, 0, "location");
    const executionKind = required(args, 1, "executionKind");
    if (location === "server") {
      throw new Error("server Connector는 검증된 server-managed provisioning 경로를 사용해야 합니다");
    }
    if (location !== "edge") throw new Error("location은 edge여야 합니다");
    if (executionKind !== "model" && executionKind !== "agent-runtime") {
      throw new Error("executionKind는 model 또는 agent-runtime이어야 합니다");
    }
    return await client.issueConnectorEnrollment({
      commandId: randomUUID(),
      location,
      executionKind,
      ...(args[2] === undefined ? {} : { ttlMs: integer(args[2], "ttlMs") }),
    });
  }
  if (invocation.command === "subscription" && invocation.subcommand === "accounts")
    return await client.query("subscription.accounts", {});
  if (invocation.command === "subscription" && invocation.subcommand === "quota")
    return await client.query(
      "subscription.quota",
      args[0] === undefined ? {} : { accountId: required(args, 0, "accountId") },
    );
  if (invocation.command === "subscription" && invocation.subcommand === "doctor")
    return await client.query(
      "subscription.doctor",
      args[0] === undefined ? {} : { accountId: required(args, 0, "accountId") },
    );
  if (invocation.command === "subscription" && invocation.subcommand === "policy" && args[1] === undefined)
    return await client.query("subscription.policy", { providerId: required(args, 0, "providerId") });
  if (invocation.command === "auth" && invocation.subcommand === "login") {
    const providerId = required(args, 0, "providerId");
    if (providerId === "zai-coding-plan") {
      if (!input.connectServerModelSubscription) throw new Error("서버 model 구독 연결 adapter가 필요합니다");
      if (invocation.model !== undefined && invocation.model !== "glm-5.2") {
        throw new Error("Z.AI Coding Plan auth login은 현재 glm-5.2 model만 지원합니다");
      }
      const alias = args.slice(1).join(" ").trim();
      return await input.connectServerModelSubscription({
        providerId: "zai-coding-plan",
        alias: alias || "Z.AI GLM Coding Plan",
        authKind: "api-key",
        billingKind: "coding-plan",
        secret: zaiCodingPlanEnvironmentSecret(input.environment),
      });
    }
    if (!input.connectServerSubscription) throw new Error("로컬 구독 로그인 adapter가 필요합니다");
    const alias = args.slice(1).join(" ").trim();
    return await input.connectServerSubscription({
      providerId,
      ...(alias ? { alias } : {}),
      ...(invocation.model === undefined ? {} : { modelId: invocation.model }),
      ...(invocation.newAccount ? { newAccount: true } : {}),
    });
  }
  if (invocation.command === "subscription" && invocation.subcommand === "connect-model") {
    const providerId = required(args, 0, "providerId");
    if (args.length !== 1) {
      throw new Error("model 구독 secret은 명령행(argv)이 아니라 stdin JSON으로만 전달해야 합니다");
    }
    const preset =
      providerId === "minimax-token-plan"
        ? {
            providerId: "minimax-token-plan" as const,
            defaultAlias: "MiniMax Token Plan",
            authKind: "subscription-key" as const,
            billingKind: "token-plan" as const,
          }
        : providerId === "zai-coding-plan"
          ? {
              providerId: "zai-coding-plan" as const,
              defaultAlias: "Z.AI GLM Coding Plan",
              authKind: "api-key" as const,
              billingKind: "coding-plan" as const,
            }
          : undefined;
    if (!preset) throw new Error("현재 자동 model 구독 연결은 MiniMax Token Plan 또는 Z.AI Coding Plan만 지원합니다");
    if (!input.connectServerModelSubscription) throw new Error("서버 model 구독 연결 adapter가 필요합니다");
    const label = "model 구독 연결";
    const connection = exactInput(await stdin(input, label), ["secret", "alias", "priority", "weight"], label, [
      "secret",
    ]);
    const secret = jsonSecret(connection.secret);
    return await input.connectServerModelSubscription({
      providerId: preset.providerId,
      alias: connection.alias === undefined ? preset.defaultAlias : jsonText(connection.alias, "구독 계정 별칭", 128),
      authKind: preset.authKind,
      billingKind: preset.billingKind,
      secret,
      ...(connection.priority === undefined
        ? {}
        : { priority: jsonInteger(connection.priority, "Credential priority", 0) }),
      ...(connection.weight === undefined ? {} : { weight: jsonInteger(connection.weight, "Credential weight", 1) }),
    });
  }
  if (invocation.command === "subscription" && invocation.subcommand === "connect-advanced") {
    const providerId = required(args, 0, "providerId");
    const label = "구독 Connector 연결";
    const connection = exactInput(
      await stdin(input, label),
      [
        "alias",
        "connectorId",
        "profileLocator",
        "authKind",
        "billingKind",
        "endpointUrl",
        "protocol",
        "acceptExperimental",
        "priority",
        "weight",
      ],
      label,
      ["alias", "connectorId", "profileLocator", "authKind", "billingKind"],
    );
    return await client.command(envelope("subscription.account.register", { providerId, ...connection }));
  }
  if (
    invocation.command === "subscription" &&
    ["share", "unshare", "disconnect"].includes(invocation.subcommand ?? "")
  ) {
    const accountId = required(args, 0, "accountId");
    const revision = await subscriptionAccountRevision(client, accountId);
    const approvalId = invocation.subcommand === "share" ? args[1] : undefined;
    const replayCommandId = invocation.subcommand === "share" ? args[2] : undefined;
    if ((approvalId === undefined) !== (replayCommandId === undefined)) {
      throw new Error("구독 공유 승인 재개에는 approvalId와 원래 commandId가 함께 필요합니다");
    }
    return await client.command(
      envelope(
        `subscription.account.${invocation.subcommand ?? ""}`,
        { accountId, ...(approvalId === undefined ? {} : { approvalId }) },
        revision,
        replayCommandId,
      ),
    );
  }
  if (invocation.command === "subscription" && invocation.subcommand === "policy") {
    const providerId = required(args, 0, "providerId");
    const credentialPolicy = required(args, 1, "credentialPolicy");
    const approvalMode = required(args, 2, "approvalMode");
    if (!SUBSCRIPTION_APPROVAL_MODES.includes(approvalMode as SubscriptionApprovalMode)) {
      throw new Error("approvalMode은 automatic, review 또는 deny여야 합니다");
    }
    await assertSubscriptionProviderApprovalMode(client, providerId, approvalMode as SubscriptionApprovalMode);
    const revision = args[3] === undefined ? undefined : integer(args[3], "expected revision");
    return await client.command(
      envelope("subscription.policy.configure", { providerId, credentialPolicy, approvalMode }, revision),
    );
  }
  if (invocation.command === "work" && invocation.subcommand === "cancel")
    return await client.command(
      envelope(
        "work.cancel",
        { workId: required(args, 0, "workId") },
        integer(required(args, 1, "expected revision"), "expected revision"),
      ),
    );
  if (invocation.command === "work" && invocation.subcommand === "follow-up")
    return await client.command(
      envelope("work.follow-up", {
        parentWorkId: required(args, 0, "parentWorkId"),
        text: required(args, 1, "request text"),
        surface: "cli",
      }),
    );
  if (invocation.command === "work" && invocation.subcommand === "fork")
    return await client.command(
      envelope(
        "work.fork",
        { workId: required(args, 0, "workId"), objective: required(args, 2, "objective") },
        integer(required(args, 1, "expected revision"), "expected revision"),
      ),
    );
  if (invocation.command === "chat" && invocation.subcommand === "send") {
    const me = (await client.query("identity.me", {})) as { data?: { userId?: string } };
    return await client.command(
      envelope("collaboration.message.post", {
        workId: required(args, 0, "workId"),
        roomId: required(args, 1, "roomId"),
        messageType: "text",
        authorKind: "user",
        authorId: me.data?.userId,
        content: required(args, 2, "message"),
      }),
    );
  }
  if (invocation.command === "approval" && ["approve", "reject"].includes(invocation.subcommand ?? ""))
    return await client.command(
      envelope("approval.vote", {
        approvalId: required(args, 0, "approvalId"),
        vote: invocation.subcommand,
        reason: required(args, 1, "reason"),
      }),
    );
  if (invocation.command === "approval" && invocation.subcommand === "cancel")
    return await client.command(
      envelope("approval.cancel", { approvalId: required(args, 0, "approvalId"), reason: required(args, 1, "reason") }),
    );
  if (invocation.command === "runtime" && ["cancel", "suspend", "resume"].includes(invocation.subcommand ?? ""))
    return await client.command(
      envelope(`runtime.${invocation.subcommand ?? ""}`, {
        executionId: required(args, 0, "executionId"),
        ...(args[1] === undefined ? {} : { reason: args[1] }),
      }),
    );
  if (invocation.command === "ext" && invocation.subcommand === "validate")
    return await client.command(envelope("extension.validate", { source: required(args, 0, "source") }));
  if (invocation.command === "ext" && invocation.subcommand === "publish") {
    if (!input.readArtifact || !client.publishArtifact) throw new Error("Registry publish adapter가 필요합니다");
    return await client.publishArtifact(
      randomUUID(),
      await input.readArtifact(required(args, 0, "artifact path")),
      await stdin(input, "registry.publish"),
    );
  }
  if (invocation.command === "ext" && ["install", "update"].includes(invocation.subcommand ?? "")) {
    const target = required(args, 0, "artifact path 또는 Registry versionId");
    if (!target.endsWith(".tgz")) {
      return await client.command(
        envelope("registry.install", {
          versionId: target,
          environment: args[1] ?? "production",
          riskClass: args[2] ?? "medium",
          executionId: randomUUID(),
        }),
      );
    }
    if (!input.readArtifact) throw new Error("Extension artifact reader가 필요합니다");
    const archive = await input.readArtifact(target);
    return invocation.subcommand === "install"
      ? await client.installArtifact(randomUUID(), archive)
      : await client.updateArtifact(randomUUID(), archive);
  }
  const operationMap: Readonly<Record<string, string>> = {
    "org:apply": "organization.command",
    "task:assign": "task.assign",
    "task:reassign": "task.assign",
    "provider:provider-add": "router.provider.register",
    "provider:endpoint-add": "router.endpoint.register",
    "provider:credential-add": "router.credential.add",
    "provider:credential-disable": "router.credential.disable",
    "provider:model-add": "router.model.register",
    "provider:route-set": "router.route.configure",
    "provider:candidate-add": "router.candidate.add",
    "assurance:binding-propose": "assurance.binding.propose",
    "assurance:binding-activate": "assurance.binding.activate",
    "growth:configure": "growth.configure",
    "growth:adopt": "growth.adopt",
    "growth:revert": "growth.revert",
    "optimization:policy-configure": "optimization.policy.configure",
    "optimization:bundle-create": "optimization.bundle.create",
    "optimization:bundle-export": "optimization.bundle.export",
    "optimization:bundle-import": "optimization.bundle.import",
    "optimization:evaluation-execute": "optimization.evaluation.execute",
    "optimization:recommend": "optimization.recommend",
    "optimization:recommendation-approve": "optimization.recommendation.approve",
    "optimization:batch-create": "optimization.batch.create",
    "optimization:batch-activate": "optimization.batch.activate",
    "optimization:recover": "optimization.recover",
    "chat:join": "collaboration.participant.join",
    "chat:leave": "collaboration.participant.leave",
    "ext:link": "extension.link",
    "ext:pack": "extension.pack",
    "ext:rollback": "extension.rollback",
    "ext:recall": "registry.recall",
    "integration:oauth-start": "integration.oauth.start",
    "integration:connect": "integration.connect",
    "integration:user-bind": "integration.user.bind",
    "integration:channel-bind": "integration.channel.bind",
  };
  const operation = operationMap[`${invocation.command}:${invocation.subcommand ?? ""}`] ?? "";
  if (operation) {
    const payload = await stdin(input, operation);
    const revision = typeof payload.expectedRevision === "number" ? payload.expectedRevision : undefined;
    const clean = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "expectedRevision"));
    return await client.command(envelope(operation, clean, revision));
  }
  throw new Error(`CLI 실행 adapter가 아직 정의되지 않았습니다: ${invocation.command} ${invocation.subcommand ?? ""}`);
}
