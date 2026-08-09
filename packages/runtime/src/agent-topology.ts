import type { DynamicValue } from "@voltagent/core";
import type { OrganizationNode } from "@massion/organization";

import type { AgentInstructionRegistry } from "./agent-configuration.js";

export interface OrganizationNodeSource {
  listNodes(): Promise<OrganizationNode[]>;
}

export interface MaterializedAgent {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly instructions: string | DynamicValue<string>;
  readonly role: OrganizationNode["role"];
}

export interface AgentTopologyRuntime {
  list(prefix: string): MaterializedAgent[];
  get(id: string): MaterializedAgent | undefined;
  create(agent: MaterializedAgent): void;
  remove(id: string): void;
  connect(parentId: string, childId: string): void;
  disconnect(parentId: string, childId: string): void;
  childIds(parentId: string): string[];
}

export type ActiveExecutionCounter = (agentId: string) => Promise<number>;

export function runtimeAgentName(organizationId: string, handle: string, workId?: string): string {
  return JSON.stringify([organizationId, workId ?? null, handle]);
}

/**
 * `runtimeAgentName`의 역함수. VoltAgent가 `delegate_task` 인자에 실어 보내는 것은 agent name이고,
 * 협업방·화면이 정체성으로 쓰는 것은 조직 handle이라 그 사이를 되돌릴 곳이 한 군데는 있어야 합니다.
 * 이름 규칙을 아는 곳을 여기 하나로 유지합니다.
 */
export function runtimeAgentHandle(name: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(name);
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const handle: unknown = (parsed as readonly unknown[])[2];
    return typeof handle === "string" && handle.length > 0 ? handle : undefined;
  } catch {
    return undefined;
  }
}

export class OrganizationAgentTopology {
  public constructor(
    private readonly organizationId: string,
    private readonly source: OrganizationNodeSource,
    private readonly runtime: AgentTopologyRuntime,
    private readonly activeExecutions: ActiveExecutionCounter,
    private readonly instructions?: Pick<AgentInstructionRegistry, "instructions">,
  ) {
    if (!organizationId.trim()) throw new Error("Agent topology organizationId가 필요합니다");
  }

  public async sync(): Promise<void> {
    const nodes = await this.source.listNodes();
    if (nodes.some((node) => node.organization_id !== this.organizationId)) {
      throw new Error("다른 organization의 Node를 Agent topology에 사용할 수 없습니다");
    }
    const active = nodes.filter((node) => node.status === "active");
    const byHandle = new Map<string, OrganizationNode>();
    for (const node of active) {
      if (byHandle.has(node.handle)) throw new Error(`중복 Organization handle입니다: ${node.handle}`);
      byHandle.set(node.handle, node);
    }
    this.validateTree(active, byHandle);

    const desired = new Map(active.map((node) => [this.agentId(node), this.materialized(node)]));
    for (const agent of desired.values()) {
      const existing = this.runtime.get(agent.id);
      if (!existing) {
        this.runtime.create(agent);
      } else if (existing.name !== agent.name || existing.handle !== agent.handle) {
        throw new Error(`기존 Agent 식별자가 Organization Node와 충돌합니다: ${agent.id}`);
      }
    }

    for (const node of active) {
      const parentId = this.agentId(node);
      const desiredChildren = new Set(
        active
          .filter(
            (candidate) =>
              candidate.parent_handle === node.handle &&
              candidate.scope === node.scope &&
              (node.scope === "persistent" || candidate.work_id === node.work_id),
          )
          .map((candidate) => this.agentId(candidate)),
      );
      for (const childId of this.runtime.childIds(parentId)) {
        if (childId.startsWith(this.prefix()) && !desiredChildren.has(childId))
          this.runtime.disconnect(parentId, childId);
      }
      for (const childId of desiredChildren) {
        if (!this.runtime.childIds(parentId).includes(childId)) this.runtime.connect(parentId, childId);
      }
    }

    for (const agent of this.runtime.list(this.prefix())) {
      if (desired.has(agent.id)) continue;
      const count = await this.activeExecutions(agent.id);
      if (count > 0) throw new Error(`${agent.handle} Agent에 활성 Runtime Execution ${String(count)}개가 있습니다`);
      this.runtime.remove(agent.id);
    }
  }

  private validateTree(nodes: readonly OrganizationNode[], byHandle: ReadonlyMap<string, OrganizationNode>): void {
    for (const node of nodes) {
      if (node.parent_handle && !byHandle.has(node.parent_handle)) {
        throw new Error(`${node.handle} Agent의 활성 부모를 찾을 수 없습니다: ${node.parent_handle}`);
      }
      const visited = new Set<string>();
      let cursor: OrganizationNode | undefined = node;
      while (cursor?.parent_handle) {
        if (visited.has(cursor.handle)) throw new Error(`Organization Agent topology 순환: ${node.handle}`);
        visited.add(cursor.handle);
        cursor = byHandle.get(cursor.parent_handle);
      }
    }
  }

  private materialized(node: OrganizationNode): MaterializedAgent {
    const legacyInstruction = `${node.responsibility}\n주요 산출물: ${node.outputs.join(", ")}`;
    return {
      id: this.agentId(node),
      name: runtimeAgentName(this.organizationId, node.handle, node.scope === "work" ? node.work_id : undefined),
      handle: node.handle,
      instructions: this.instructions?.instructions(node.handle) ?? legacyInstruction,
      role: node.role,
    };
  }

  private agentId(node: OrganizationNode): string {
    return `${this.organizationId}:${node.node_id}`;
  }

  private prefix(): string {
    return `${this.organizationId}:`;
  }
}
