import { Agent, type AgentModelValue } from "@voltagent/core";

import type { AgentTopologyRuntime, MaterializedAgent } from "./agent-topology.js";

/**
 * Massion daemon이 process lifecycle을 소유하면서 VoltAgent Agent 빌딩 블록을 직접 실행하는 레지스트리입니다.
 */
export class EmbeddedVoltAgentRuntime implements AgentTopologyRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly metadata = new Map<string, MaterializedAgent>();
  private readonly children = new Map<string, Set<string>>();

  public constructor(private readonly defaultModel: AgentModelValue) {}

  public getAgents(): Agent[] {
    return [...this.agents.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public list(prefix: string): MaterializedAgent[] {
    return [...this.metadata.values()]
      .filter((agent) => agent.id.startsWith(prefix))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public get(id: string): MaterializedAgent | undefined {
    return this.metadata.get(id);
  }

  public create(agent: MaterializedAgent): void {
    if (this.agents.has(agent.id) || this.getAgents().some((existing) => existing.name === agent.name)) {
      throw new Error(`VoltAgent ID 또는 name 충돌: ${agent.id}`);
    }
    this.agents.set(
      agent.id,
      new Agent({
        id: agent.id,
        name: agent.name,
        purpose: agent.handle,
        instructions: agent.instructions,
        model: this.defaultModel,
        memory: false,
        maxRetries: 0,
      }),
    );
    this.metadata.set(agent.id, agent);
  }

  public remove(id: string): void {
    this.requireAgent(id);
    for (const children of this.children.values()) children.delete(id);
    this.children.delete(id);
    this.agents.delete(id);
    this.metadata.delete(id);
  }

  public connect(parentId: string, childId: string): void {
    this.requireAgent(parentId);
    this.requireAgent(childId);
    const children = this.children.get(parentId) ?? new Set<string>();
    children.add(childId);
    this.children.set(parentId, children);
  }

  public disconnect(parentId: string, childId: string): void {
    this.requireAgent(parentId);
    this.children.get(parentId)?.delete(childId);
  }

  public childIds(parentId: string): string[] {
    this.requireAgent(parentId);
    return [...(this.children.get(parentId) ?? [])].sort();
  }

  private requireAgent(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`VoltAgent Agent를 찾을 수 없습니다: ${id}`);
    return agent;
  }
}
