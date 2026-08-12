import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app";
import {
  createFixtureDesktopService,
  type DesktopService,
  type DesktopWorkspaceView,
  type KnowledgeGraphView,
  type KnowledgeIndexView,
  type KnowledgeNodeKind,
} from "./desktop-service";
import {
  fixtureDataAdapter,
  type ActivityView,
  type InboxItem,
  type RoomView,
  type SpeakerView,
  type WorkView,
} from "./model";
import { I18nProvider } from "./i18n/context";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function service(overrides: Partial<DesktopService> = {}): DesktopService {
  const merged = { ...createFixtureDesktopService(), ...overrides };
  if (
    overrides.loadInbox === undefined &&
    (overrides.initialSnapshot !== undefined || overrides.loadPendingApprovals !== undefined)
  ) {
    merged.loadInbox = async () => {
      const works = merged.initialSnapshot?.works ?? [];
      const [approvals, growth] = await Promise.all([
        overrides.loadPendingApprovals === undefined
          ? Promise.resolve(works.flatMap((work) => work.approvals.filter((approval) => approval.status === "pending")))
          : merged.loadPendingApprovals(),
        merged.loadGrowth(),
      ]);
      const blocked: InboxItem[] = works.flatMap((work) =>
        work.run?.status === "blocked"
          ? [
              {
                kind: "blocked" as const,
                id: `blocked:${work.run.runId}`,
                runId: work.run.runId,
                workId: work.id,
                title: work.title,
                reason: work.run.blockedDetail ?? "실행 단계에서 오류가 발생했습니다.",
              },
            ]
          : [],
      );
      const approvalItems: InboxItem[] = approvals.map((approval) => {
        const workTitle = works.find((work) => work.id === approval.workId)?.title;
        return {
          kind: "approval",
          id: approval.id,
          approval,
          ...(workTitle === undefined ? {} : { workTitle }),
        };
      });
      const growthItems: InboxItem[] = growth.suggestions
        .filter((suggestion) => suggestion.status === "awaiting-review")
        .map((suggestion) => {
          const workTitle = works.find((work) => work.id === suggestion.workId)?.title;
          return {
            kind: "growth" as const,
            id: `growth:${suggestion.suggestionId}`,
            suggestionId: suggestion.suggestionId,
            workId: suggestion.workId,
            ...(workTitle === undefined ? {} : { workTitle }),
            title: suggestion.summary,
            reason: suggestion.rationale,
          };
        });
      return [...blocked, ...approvalItems, ...growthItems];
    };
  }
  return merged;
}

function workspaceFixture(
  workspaceId: string,
  name: string,
  path: string,
  trust: DesktopWorkspaceView["trust"],
  revision: number,
): DesktopWorkspaceView {
  return {
    workspaceId,
    name,
    path,
    kind: "local-directory",
    trust,
    status: "active",
    revision,
    createdAt: "2026-07-24T00:00:00.000Z",
    lastUsedAt: "2026-07-24T00:00:00.000Z",
  };
}

function knowledgeIndexFixture(workspaceId: string): KnowledgeIndexView {
  return {
    workspaceId,
    status: "ready",
    indexVersionId: `index-${workspaceId}`,
    fileCount: 1,
    symbolCount: 1,
    relationCount: 0,
    indexedAt: "2026-07-29T01:00:00.000Z",
    excluded: [],
  };
}

function knowledgeGraphFixture(lens: KnowledgeNodeKind, nodeId: string, label: string): KnowledgeGraphView {
  return { lens, nodes: [{ nodeId: `${lens}:${nodeId}`, kind: lens, label }], edges: [] };
}

describe("AgentOS native data flow", () => {
  it("선택한 활성 Work를 백그라운드에서 승인 대기부터 완료까지 동기화하고 완료 뒤 조회를 멈춘다", async () => {
    vi.useFakeTimers();
    try {
      const base = fixtureDataAdapter().works[0] as WorkView;
      const completedFixture = fixtureDataAdapter().works.find((work) => work.status === "complete") as WorkView;
      const approval = {
        id: "approval-live-refresh",
        title: "전문 Agent 배치 승인",
        description: "보고서 작성 담당을 배치합니다.",
        workId: base.id,
        revision: 1,
        status: "pending" as const,
      };
      const running: WorkView = {
        ...base,
        approvals: [],
        tasks: [],
        agents: [],
        artifacts: [],
        verifications: [],
        records: [],
        activities: [],
        progress: 0,
        run: { runId: "run-live-refresh", status: "running", stage: "delivery", leaseGeneration: 4 },
      };
      const awaiting: WorkView = {
        ...running,
        revision: 2,
        approvals: [approval],
        tasks: [{ id: "task-live-refresh", title: "우선순위 보고서 작성", state: "active", time: "13:00" }],
        activities: [
          {
            id: "approval-live-refresh-activity",
            kind: "approval",
            time: "13:00",
            approvalId: approval.id,
            title: approval.title,
            description: approval.description,
          },
        ],
        progress: 25,
        run: { runId: "run-live-refresh", status: "awaiting-approval", stage: "delivery", leaseGeneration: 4 },
      };
      const completed = {
        ...completedFixture,
        id: base.id,
        title: base.title,
        revision: 3,
        activities: [],
        run: { runId: "run-live-refresh", status: "completed", stage: "terminal", leaseGeneration: 7 },
      } satisfies WorkView;
      const partialTerminal: WorkView = {
        ...running,
        status: "complete",
        sourceStatus: "completed",
        revision: completed.revision,
        run: completed.run,
      };
      const atlas: SpeakerView = {
        handle: "representative",
        name: "Atlas",
        initial: "A",
        accentSlot: 0,
        role: "조정",
        modelId: "gpt-5.6-sol",
      };
      const lyra: SpeakerView = {
        handle: "context-strategy",
        name: "Lyra",
        initial: "L",
        accentSlot: 1,
        role: "전략",
        modelId: "gpt-5.6-sol",
      };
      const room = (work: WorkView): RoomView => {
        const completeProjection = work.status === "complete" && work.artifacts.length > 0;
        return {
          roomId: "room-live-refresh",
          name: "대표 방",
          status: work.status === "complete" ? "closed" : "active",
          participants: completeProjection ? [atlas, lyra] : [atlas],
          lastMessageSequence: completeProjection ? 2 : 0,
          budgets: [],
          sharedContexts: [],
          activities: completeProjection
            ? [
                {
                  id: "handoff-live-refresh",
                  kind: "handoff",
                  time: "13:01",
                  from: atlas,
                  to: lyra,
                },
                {
                  id: "answer-live-refresh",
                  kind: "room",
                  messageType: "answer",
                  time: "13:02",
                  speaker: atlas,
                  content: "# 완료 보고서\n\n| 순위 | 항목 |\n|---:|---|\n| 1 | 내보내기 중복 |",
                  final: true,
                },
              ]
            : [],
        };
      };
      let current = running;
      const loadWork = vi.fn(async () => current);
      const loadPendingApprovals = vi.fn(async () => current.approvals);
      const loadRooms = vi.fn(async () => [room(current)]);
      let durable: ((event: unknown) => void) | undefined;
      render(
        <App
          service={service({
            initialSnapshot: { works: [running] },
            loadIndex: async ({ filter }) =>
              (current.status === "active" ? "active" : "complete") === filter ? [current] : [],
            loadWork,
            loadPendingApprovals,
            loadRooms,
            subscribeDurable: async (handler) => {
              durable = handler;
              return async () => undefined;
            },
          })}
        />,
      );
      await act(async () => await Promise.resolve());
      expect(durable).toBeTypeOf("function");

      current = awaiting;
      await act(async () => await vi.advanceTimersByTimeAsync(1_000));

      const workList = screen.getByRole("region", { name: "Work 목록" });
      expect(within(workList).getByText("승인 대기")).toHaveClass("text-gate");
      expect(screen.getByRole("status", { name: "실행 상태" })).toHaveTextContent("승인 대기");
      expect(screen.getByRole("button", { name: "전문 Agent 배치 승인 승인" })).toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveTextContent("작업 0/1");
      expect(loadPendingApprovals).toHaveBeenCalledTimes(2);

      current = partialTerminal;
      act(() =>
        durable?.({
          sequence: 902,
          type: "run.completed",
          payload: { workId: running.id, stage: "terminal" },
          resource: { type: "ApplicationRun", id: "run-live-refresh" },
        }),
      );
      await act(async () => await vi.advanceTimersByTimeAsync(100));

      expect(screen.getByRole("main", { name: completed.title })).toHaveTextContent("완료");
      expect(screen.queryByRole("heading", { level: 1, name: "완료 보고서" })).not.toBeInTheDocument();

      current = completed;
      await act(async () => await vi.advanceTimersByTimeAsync(1_000));

      const main = screen.getByRole("main", { name: completed.title });
      expect(within(main).getByRole("heading", { level: 1, name: "완료 보고서" })).toBeInTheDocument();
      expect(within(main).getByRole("table")).toHaveTextContent("내보내기 중복");
      expect(within(main).getByText("최종 응답")).toBeInTheDocument();
      expect(within(main).getAllByText("Atlas").length).toBeGreaterThan(0);
      expect(within(main).getByText("Lyra")).toBeInTheDocument();
      expect(within(main).getAllByText("gpt-5.6-sol").length).toBeGreaterThan(0);
      const inspector = screen.getByRole("complementary", { name: "Work 세부 정보" });
      expect(inspector).toHaveTextContent(`작업 ${String(completed.tasks.length)}/${String(completed.tasks.length)}`);
      expect(inspector).toHaveTextContent("이 방의 참가자 2");

      await act(async () => {
        screen.getByRole("tab", { name: "산출물" }).click();
      });
      expect(inspector).toHaveTextContent(completed.artifacts[0]?.name ?? "");
      await act(async () => {
        screen.getByRole("tab", { name: "검증" }).click();
      });
      expect(inspector).toHaveTextContent(completed.verifications[0]?.verifier ?? "");
      await act(async () => {
        screen.getByRole("tab", { name: "기록" }).click();
      });
      expect(inspector).toHaveTextContent(completed.records[0]?.summary ?? "");
      await act(async () => {
        screen.getByRole("tab", { name: "완료" }).click();
      });
      expect(within(workList).getByRole("button", { name: new RegExp(completed.title, "u") })).toHaveTextContent(
        "완료",
      );

      await act(async () => await vi.advanceTimersByTimeAsync(1_000));
      expect(loadRooms.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(loadPendingApprovals.mock.calls.length).toBeGreaterThanOrEqual(4);
      const terminalCalls = loadWork.mock.calls.length;
      await act(async () => await vi.advanceTimersByTimeAsync(5_000));
      expect(loadWork).toHaveBeenCalledTimes(terminalCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("협업방 투영 전에는 구조화 인계 JSON을 노출하지 않고 풍부한 인계가 준비되면 모델 계보를 표시한다", async () => {
    const work = fixtureDataAdapter().works[0] as WorkView;
    const rooms = deferred<RoomView[]>();
    const rawHandoff = JSON.stringify({
      handoffType: "ContextStrategyExecutionHandoff",
      objective: "내부 실행 목표",
      recommendedAssignment: { primary: { handle: "context-strategy" } },
    });
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
      modelId: "gpt-5.6-sol",
    };
    const lyra: SpeakerView = {
      handle: "context-strategy",
      name: "Lyra",
      initial: "L",
      accentSlot: 1,
      role: "전략",
      modelId: "gpt-5.6-sol",
    };
    render(
      <App
        service={service({
          initialSnapshot: {
            works: [
              {
                ...work,
                activities: [
                  {
                    id: "message:handoff-live",
                    kind: "message",
                    messageType: "handoff",
                    time: "13:00",
                    author: "Atlas",
                    initials: "A",
                    human: false,
                    content: rawHandoff,
                  },
                  {
                    id: "message:json-answer-live",
                    kind: "message",
                    messageType: "answer",
                    time: "13:01",
                    author: "Atlas",
                    initials: "A",
                    human: false,
                    content: '{"handoffTo":"context-strategy","result":"사용자에게 보여줄 JSON"}',
                  },
                ],
              },
            ],
          },
          loadIndex: async () => [work],
          loadRooms: async () => await rooms.promise,
        })}
      />,
    );

    expect(screen.queryByText(rawHandoff)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Work 활동" })).not.toHaveTextContent("handoffType");
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("사용자에게 보여줄 JSON");

    rooms.resolve([
      {
        roomId: "room-handoff-live",
        name: "대표 방",
        status: "active",
        participants: [atlas, lyra],
        lastMessageSequence: 1,
        budgets: [],
        sharedContexts: [],
        activities: [{ id: "handoff-live", kind: "handoff", time: "13:00", from: atlas, to: lyra }],
      },
    ]);

    const activity = await screen.findByRole("region", { name: "협업방 대표 방" });
    expect(activity).toHaveTextContent("Atlas");
    expect(activity).toHaveTextContent("Lyra");
    expect(activity).toHaveTextContent("gpt-5.6-sol");
    expect(activity).not.toHaveTextContent("handoffType");
    expect(activity).not.toHaveTextContent("recommendedAssignment");
  });

  it("백그라운드의 늦은 Work 응답은 새 선택을 덮지 않고 unmount 뒤 재조회를 예약하지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = fixtureDataAdapter();
      const first: WorkView = {
        ...(snapshot.works[0] as WorkView),
        run: { runId: "run-live-race-first", status: "running", stage: "delivery", leaseGeneration: 2 },
      };
      const second: WorkView = {
        ...(snapshot.works[1] as WorkView),
        run: { runId: "run-live-race-second", status: "running", stage: "delivery", leaseGeneration: 3 },
      };
      const stale = deferred<WorkView>();
      let firstReads = 0;
      const loadWork = vi.fn(async (workId: string) => {
        if (workId !== first.id) return second;
        firstReads += 1;
        return firstReads === 1 ? await stale.promise : first;
      });
      const view = render(
        <App
          service={service({
            initialSnapshot: { works: [first, second] },
            loadIndex: async () => [first, second],
            loadWork,
          })}
        />,
      );
      await act(async () => await Promise.resolve());
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      await act(async () => {
        screen.getByRole("button", { name: new RegExp(second.title, "u") }).click();
        await Promise.resolve();
      });
      expect(screen.getByRole("main", { name: second.title })).toBeInTheDocument();

      stale.resolve({ ...first, title: "늦게 도착한 이전 Work" });
      await act(async () => await Promise.resolve());
      expect(screen.getByRole("main", { name: second.title })).toBeInTheDocument();
      expect(screen.queryByRole("main", { name: "늦게 도착한 이전 Work" })).not.toBeInTheDocument();

      const callsAtUnmount = loadWork.mock.calls.length;
      view.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(loadWork).toHaveBeenCalledTimes(callsAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("늦은 이전 revision 목록은 완료된 선택 상세를 덮지 않고 더 최신 목록은 보존한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const running: WorkView = {
      ...base,
      revision: 4,
      run: { runId: "run-stale-index", status: "running", stage: "records", leaseGeneration: 6 },
    };
    const terminal: WorkView = {
      ...running,
      status: "complete",
      sourceStatus: "completed",
      revision: 5,
      run: { runId: "run-stale-index", status: "completed", stage: "terminal", leaseGeneration: 6 },
    };
    const newer: WorkView = { ...terminal, revision: 6, updatedAt: "13:09" };
    const staleIndex = deferred<WorkView[]>();
    let durable: ((event: unknown) => void) | undefined;
    let background = false;
    const loadIndex = vi.fn(async () => (background ? await staleIndex.promise : [running]));
    render(
      <App
        service={service({
          initialSnapshot: { works: [running] },
          loadIndex,
          loadWork: async () => terminal,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    await waitFor(() => expect(durable).toBeTypeOf("function"));

    background = true;
    act(() =>
      durable?.({
        sequence: 901,
        type: "run.completed",
        payload: { workId: running.id, stage: "terminal" },
        resource: { type: "ApplicationRun", id: "run-stale-index" },
      }),
    );
    await waitFor(() => expect(screen.getByRole("main", { name: terminal.title })).toHaveTextContent("완료"));

    staleIndex.resolve([running]);
    await act(async () => await Promise.resolve());
    await act(async () => {
      screen.getByRole("tab", { name: "완료" }).click();
    });
    const workList = screen.getByRole("region", { name: "Work 목록" });
    await waitFor(() =>
      expect(within(workList).getByRole("button", { name: new RegExp(terminal.title, "u") })).toHaveTextContent("완료"),
    );

    background = false;
    loadIndex.mockResolvedValueOnce([newer]);
    await act(async () => {
      screen.getByRole("tab", { name: "진행 중" }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("tab", { name: "완료" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(within(workList).getByText("13:09")).toBeInTheDocument());
  });

  it("같은 Work의 백그라운드·사용자 refresh burst를 한 비행과 한 trailing 조회로 합친다", async () => {
    vi.useFakeTimers();
    try {
      const running: WorkView = {
        ...(fixtureDataAdapter().works[0] as WorkView),
        run: { runId: "run-single-flight", status: "running", stage: "delivery", leaseGeneration: 3 },
      };
      const first = deferred<WorkView>();
      let activeLoads = 0;
      let maxActiveLoads = 0;
      const loadWork = vi.fn(async () => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        try {
          return loadWork.mock.calls.length === 1 ? await first.promise : running;
        } finally {
          activeLoads -= 1;
        }
      });
      const view = render(
        <App
          service={service({
            initialSnapshot: { works: [running] },
            loadIndex: async () => [running],
            loadWork,
            subscribeDurable: async () => async () => undefined,
          })}
        />,
      );
      await act(async () => await Promise.resolve());
      act(() => {
        vi.advanceTimersByTime(1_000);
        const selected = screen.getByRole("button", { name: new RegExp(running.title, "u") });
        selected.click();
        selected.click();
      });
      await act(async () => await Promise.resolve());
      expect(maxActiveLoads).toBe(1);

      first.resolve(running);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(loadWork).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("main", { name: running.title })).not.toHaveAttribute("aria-busy");
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("같은 Work의 trailing 대기 중 unmount하면 첫 조회 완료 뒤 추가 조회를 시작하지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const running: WorkView = {
        ...(fixtureDataAdapter().works[0] as WorkView),
        run: { runId: "run-single-flight-unmount", status: "running", stage: "delivery", leaseGeneration: 3 },
      };
      const first = deferred<WorkView>();
      const loadWork = vi.fn(async () => (loadWork.mock.calls.length === 1 ? await first.promise : running));
      const view = render(
        <App
          service={service({
            initialSnapshot: { works: [running] },
            loadIndex: async () => [running],
            loadWork,
            subscribeDurable: async () => async () => undefined,
          })}
        />,
      );
      await act(async () => await Promise.resolve());
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(loadWork).toHaveBeenCalledOnce();

      act(() => {
        screen.getByRole("button", { name: new RegExp(running.title, "u") }).click();
      });
      expect(loadWork).toHaveBeenCalledOnce();

      const firstRequest = loadWork.mock.results[0]?.value;
      if (!(firstRequest instanceof Promise)) throw new Error("첫 Work 조회 Promise가 필요합니다.");
      view.unmount();
      first.resolve(running);
      await act(async () => await firstRequest);

      expect(loadWork).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("service lifecycle은 이전 foreground loading 소유권을 해제하고 늦은 응답을 버린다", async () => {
    const snapshot = fixtureDataAdapter();
    const first = snapshot.works[0] as WorkView;
    const second = snapshot.works[1] as WorkView;
    const stale = deferred<WorkView>();
    const initialService = service({
      initialSnapshot: { works: [first, second] },
      loadIndex: async () => [first, second],
      loadWork: async (workId) => (workId === second.id ? await stale.promise : first),
    });
    const replacementService = service({
      initialSnapshot: { works: [first, second] },
      loadIndex: async () => [first, second],
      loadWork: async (workId) => (workId === second.id ? second : first),
    });
    const view = render(<App service={initialService} />);

    act(() => {
      screen.getByRole("button", { name: new RegExp(second.title, "u") }).click();
    });
    expect(screen.getByRole("main", { name: first.title })).toHaveAttribute("aria-busy", "true");

    view.rerender(<App service={replacementService} />);
    await waitFor(() => expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy"));
    stale.resolve({ ...second, title: "이전 service의 늦은 Work" });
    await act(async () => await Promise.resolve());
    expect(screen.queryByRole("main", { name: "이전 service의 늦은 Work" })).not.toBeInTheDocument();
  });

  it.each([
    ["unmount", "resolve"],
    ["unmount", "reject"],
    ["service 교체", "resolve"],
    ["service 교체", "reject"],
  ] as const)("pending start는 %s 뒤 %s되어도 상태와 후속 I/O를 바꾸지 않는다", async (lifecycle, outcome) => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const started = deferred<{ runId: string }>();
    const initialLoadIndex = vi.fn(async () => snapshot.works);
    const replacementLoadIndex = vi.fn(async () => snapshot.works);
    const initialService = service({
      initialSnapshot: snapshot,
      loadIndex: initialLoadIndex,
      startWork: async () => await started.promise,
    });
    const replacementService = service({ initialSnapshot: snapshot, loadIndex: replacementLoadIndex });
    const view = render(<App service={initialService} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "lifecycle 뒤에는 이어서 처리하지 마");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument());
    const initialCalls = initialLoadIndex.mock.calls.length;

    if (lifecycle === "unmount") view.unmount();
    else {
      view.rerender(<App service={replacementService} />);
      await waitFor(() => expect(replacementLoadIndex).toHaveBeenCalled());
    }
    const replacementCalls = replacementLoadIndex.mock.calls.length;
    await act(async () => {
      if (outcome === "resolve") started.resolve({ runId: "run-stale-start" });
      else started.reject(new Error("이전 service의 늦은 실패"));
      await Promise.resolve();
    });

    expect(initialLoadIndex).toHaveBeenCalledTimes(initialCalls);
    expect(replacementLoadIndex).toHaveBeenCalledTimes(replacementCalls);
    if (lifecycle === "service 교체") {
      expect(screen.queryByText("이전 service의 늦은 실패")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "service 교체 commit 직후 이전 start가 %s되어도 후속 상태와 I/O를 만들지 않는다",
    async (outcome) => {
      const user = userEvent.setup();
      const snapshot = fixtureDataAdapter();
      const started = deferred<{ runId: string }>();
      const replacementBootstrap = deferred<"ready">();
      const initialLoadIndex = vi.fn(async () => snapshot.works);
      const replacementLoadIndex = vi.fn(async () => snapshot.works);
      const initialService = service({
        initialSnapshot: snapshot,
        loadIndex: initialLoadIndex,
        startWork: async () => await started.promise,
      });
      const replacementService = service({
        bootstrap: async () => await replacementBootstrap.promise,
        initialSnapshot: snapshot,
        loadIndex: replacementLoadIndex,
      });
      const view = render(<App service={initialService} />);

      await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
      await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "교체된 service에서는 이어서 처리하지 마");
      await user.click(screen.getByRole("button", { name: "실행 시작" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument());
      const initialCalls = initialLoadIndex.mock.calls.length;

      view.rerender(<App service={replacementService} />);
      const replacementCalls = replacementLoadIndex.mock.calls.length;
      await act(async () => {
        if (outcome === "resolve") started.resolve({ runId: "run-stale-immediate" });
        else started.reject(new Error("교체 직후 도착한 이전 실패"));
        await Promise.resolve();
      });

      expect(initialLoadIndex).toHaveBeenCalledTimes(initialCalls);
      expect(replacementLoadIndex).toHaveBeenCalledTimes(replacementCalls);
      expect(screen.queryByText("교체 직후 도착한 이전 실패")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument();
      replacementBootstrap.resolve("ready");
    },
  );

  it("StrictMode 재실행과 unmount에서도 selected Work timer를 하나만 유지한다", async () => {
    vi.useFakeTimers();
    try {
      const running: WorkView = {
        ...(fixtureDataAdapter().works[0] as WorkView),
        run: { runId: "run-strict-refresh", status: "running", stage: "delivery", leaseGeneration: 2 },
      };
      const loadWork = vi.fn(async () => running);
      const view = render(
        <StrictMode>
          <App
            service={service({
              initialSnapshot: { works: [running] },
              loadIndex: async () => [running],
              loadWork,
              subscribeDurable: async () => async () => undefined,
            })}
          />
        </StrictMode>,
      );
      await act(async () => await Promise.resolve());
      await act(async () => await vi.advanceTimersByTimeAsync(1_000));
      expect(loadWork).toHaveBeenCalledOnce();

      view.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(loadWork).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("선택한 Work의 run event는 상세 상태·계획·승인을 다시 읽는다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const blocked: WorkView = {
      ...base,
      approvals: [],
      tasks: [],
      activities: [],
      progress: 0,
      run: {
        runId: "run-projection-refresh",
        status: "blocked",
        stage: "context-strategy",
        blockedReason: "strategy-failed",
        leaseGeneration: 4,
      },
    };
    const approval = {
      id: "approval-projection-refresh",
      title: "배포 계획 승인",
      description: "확정된 작업 2개를 실행합니다.",
      workId: blocked.id,
      revision: 1,
      status: "pending" as const,
    };
    const refreshed: WorkView = {
      ...blocked,
      approvals: [approval],
      tasks: base.tasks.slice(0, 2),
      activities: [
        {
          id: "approval-projection-refresh-activity",
          kind: "approval",
          time: "10:30",
          approvalId: approval.id,
          title: approval.title,
          description: approval.description,
        },
      ],
      progress: 50,
      run: {
        runId: "run-projection-refresh",
        status: "awaiting-approval",
        stage: "delivery",
        leaseGeneration: 5,
      },
    };
    let durable: ((event: unknown) => void) | undefined;
    const loadWork = vi.fn(async () => refreshed);
    render(
      <App
        service={service({
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    expect(screen.getByRole("status", { name: "실행 상태" })).toHaveTextContent("차단됨");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveTextContent("작업 0/0");
    await waitFor(() => expect(durable).toBeTypeOf("function"));

    act(() =>
      durable?.({
        sequence: 30,
        type: "run.suspended",
        resource: { type: "ApplicationRun", id: "run-projection-refresh", revision: 5 },
        payload: { stage: "delivery", workId: blocked.id },
      }),
    );

    await waitFor(() => expect(loadWork).toHaveBeenCalledWith(blocked.id));
    expect(screen.getByRole("status", { name: "실행 상태" })).toHaveTextContent("승인 대기");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveTextContent("작업 1/2");
    expect(screen.getByRole("button", { name: "배포 계획 승인 승인" })).toBeInTheDocument();
  });

  it("durable 갱신은 선택한 Work의 방만 다시 읽고 탭·오류·이전 성공 데이터를 보존한다", async () => {
    const user = userEvent.setup();
    const work = fixtureDataAdapter().works[0] as WorkView;
    // 이 테스트는 durable 이벤트가 «방만» 다시 읽는지를 봅니다. 실행 중인 run이 붙어 있으면
    // 무관한 배경 조정 폴러가 무장해 loadWork를 부르고, 단언이 시간에 따라 뒤집힙니다.
    delete work.run;
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const quill: SpeakerView = {
      handle: "evidence-research",
      name: "Quill",
      initial: "Q",
      accentSlot: 2,
      role: "조사",
    };
    const auditMessage = (content: string): ActivityView => ({
      id: "audit-message",
      kind: "room",
      messageType: "evidence",
      time: "10:02",
      speaker: quill,
      content,
    });
    const auditRoom = (content: string): RoomView => ({
      roomId: "room-audit",
      name: "감사 방",
      status: "active",
      participants: [quill],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: [auditMessage(content)],
    });
    const coreRoom = (extraRooms: RoomView[]): RoomView => ({
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: extraRooms.map((candidate) => ({
        id: `roomref:${candidate.roomId}`,
        kind: "roomRef" as const,
        time: "10:01",
        roomId: candidate.roomId,
        name: candidate.name,
        participants: candidate.participants,
        messageCount: candidate.activities.length,
        lastLine: "감사 대화",
        waiting: false,
      })),
    });
    const newRoom: RoomView = {
      roomId: "room-new",
      name: "새 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [],
    };
    let durable: ((event: unknown) => void) | undefined;
    let revision: "initial" | "refreshed" | "failed" | "removed" = "initial";
    const loadRooms = vi.fn(async () => {
      if (revision === "failed") throw new Error("협업방을 다시 읽지 못했습니다.");
      if (revision === "removed") return [auditRoom("갱신된 감사 대화"), newRoom];
      const audit = auditRoom(revision === "initial" ? "처음 감사 대화" : "갱신된 감사 대화");
      return [
        coreRoom([audit, ...(revision === "refreshed" ? [newRoom] : [])]),
        audit,
        ...(revision === "refreshed" ? [newRoom] : []),
      ];
    });
    const loadWork = vi.fn(async () => work);
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadWork,
          loadRooms,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "협업방 감사 방 열기" }));
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("처음 감사 대화");
    await waitFor(() => expect(durable).toBeTypeOf("function"));

    revision = "refreshed";
    act(() =>
      durable?.({
        sequence: 30,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: "another-work" },
      }),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 150)));
    expect(loadRooms).toHaveBeenCalledOnce();
    act(() =>
      durable?.({
        sequence: 31,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: work.id },
      }),
    );
    await waitFor(() => expect(loadRooms).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("갱신된 감사 대화");
    expect(screen.getByRole("button", { name: /대표 방/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { current: true })).toHaveTextContent("감사 방");
    expect(screen.queryByRole("button", { name: /^새 방/u })).not.toBeInTheDocument();
    expect(loadWork).not.toHaveBeenCalled();

    revision = "failed";
    act(() =>
      durable?.({
        sequence: 32,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: work.id },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("협업방을 다시 읽지 못했습니다.");
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("갱신된 감사 대화");

    revision = "removed";
    act(() =>
      durable?.({
        sequence: 33,
        type: "work.room.removed",
        resource: { type: "Work", id: work.id },
      }),
    );
    await waitFor(() => expect(loadRooms).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { current: true })).toHaveTextContent("감사 방");
    expect(screen.queryByRole("button", { name: /대표 방/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^새 방/u })).not.toBeInTheDocument();
  });

  it("방과 Work 활동을 ID 중복 없이 시간순으로 합치고 최종 응답 문법을 유지한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: "stage",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          occurredAt: "2026-07-31T10:00:00.000Z",
          title: "실행 단계",
          detail: "준비",
          status: "진행",
        },
        {
          id: "duplicate",
          kind: "artifacts",
          time: "10:02",
          occurredAt: "2026-07-31T10:02:00.000Z",
          title: "산출물 활동",
          artifacts: [{ id: "artifact-1", name: "결과.csv", format: "CSV", size: "1 KB", createdAt: "10:02" }],
        },
        {
          id: "verification",
          kind: "event",
          semantic: "verification",
          time: "10:03",
          occurredAt: "2026-07-31T10:03:00.000Z",
          title: "검증 활동",
          detail: "통과",
          status: "완료",
        },
        {
          id: "record",
          kind: "event",
          semantic: "record",
          time: "10:04",
          occurredAt: "2026-07-31T10:04:00.000Z",
          title: "기록 활동",
          detail: "확정",
          status: "완료",
        },
        {
          id: "final",
          kind: "room",
          time: "10:05",
          occurredAt: "2026-07-31T10:05:00.000Z",
          messageType: "answer",
          speaker: atlas,
          content: "대표 최종 답변",
          final: true,
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 2,
      budgets: [],
      sharedContexts: [],
      activities: [
        {
          id: "room-message",
          kind: "room",
          time: "23:59",
          occurredAt: "2026-07-31T10:01:00.000Z",
          messageType: "evidence",
          speaker: atlas,
          content: "방 대화",
        },
        {
          id: "duplicate",
          kind: "room",
          time: "10:02",
          occurredAt: "2026-07-31T10:02:30.000Z",
          messageType: "evidence",
          speaker: atlas,
          content: "중복 방 대화",
        },
      ],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const activity = await screen.findByRole("region", { name: "협업방 대표 방" });
    for (const text of ["실행 단계", "방 대화", "산출물 활동", "검증 활동", "기록 활동", "대표 최종 답변"]) {
      expect(within(activity).getByText(text)).toBeInTheDocument();
    }
    expect(within(activity).queryByText("중복 방 대화")).not.toBeInTheDocument();
    expect(within(activity).getByText("최종 응답")).toHaveClass("bg-fg", "text-canvas");
    const text = activity.textContent ?? "";
    expect(text.indexOf("실행 단계")).toBeLessThan(text.indexOf("방 대화"));
    expect(text.indexOf("방 대화")).toBeLessThan(text.indexOf("산출물 활동"));
    expect(text.indexOf("산출물 활동")).toBeLessThan(text.indexOf("검증 활동"));
    expect(text.indexOf("검증 활동")).toBeLessThan(text.indexOf("기록 활동"));
    expect(text.indexOf("기록 활동")).toBeLessThan(text.indexOf("대표 최종 답변"));
  });

  it("같은 협업 메시지는 풍부한 방 활동 하나만 표시한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const messageId = "018f0f36-7b55-7d5c-9bb6-5f9979f52291";
    const occurredAt = "2026-07-31T10:01:00.000Z";
    const content = "근거를 확인했습니다.";
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: `message:${messageId}`,
          kind: "message",
          time: occurredAt,
          occurredAt,
          author: "collaboration.message-posted",
          initials: "C",
          human: false,
          content,
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: [
        {
          id: messageId,
          kind: "room",
          time: "10:01",
          occurredAt,
          messageType: "evidence",
          speaker: atlas,
          content,
        },
      ],
    };

    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const activity = await screen.findByRole("region", { name: "협업방 대표 방" });
    expect(within(activity).getAllByText(content)).toHaveLength(1);
    expect(within(activity).getByText("Atlas")).toBeInTheDocument();
    expect(activity).not.toHaveTextContent(messageId);
    expect(activity).not.toHaveTextContent(occurredAt);
    expect(activity).not.toHaveTextContent("collaboration.message-posted");
  });

  it("ISO 시각이 없는 legacy 활동은 ISO 활동과 섞어 비교하지 않고 뒤에서 결정적으로 정렬한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: "legacy-z",
          kind: "event",
          semantic: "stage",
          time: "00:01",
          title: "Legacy Z",
          detail: "",
          status: "",
        },
        {
          id: "legacy-a",
          kind: "event",
          semantic: "stage",
          time: "00:01",
          title: "Legacy A",
          detail: "",
          status: "",
        },
        {
          id: "canonical",
          kind: "event",
          semantic: "stage",
          time: "23:59",
          occurredAt: "2026-07-31T23:59:00.000Z",
          title: "Canonical",
          detail: "",
          status: "",
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const text = (await screen.findByRole("region", { name: "협업방 대표 방" })).textContent ?? "";
    expect(text.indexOf("Canonical")).toBeLessThan(text.indexOf("Legacy A"));
    expect(text.indexOf("Legacy A")).toBeLessThan(text.indexOf("Legacy Z"));
  });

  it("최초 방 조회 실패는 접근 가능한 오류이고 정상 무방 상태는 Work 활동이다", async () => {
    const work: WorkView = {
      ...(fixtureDataAdapter().works[0] as WorkView),
      activities: [
        {
          id: "agent-message",
          kind: "message",
          time: "09:58",
          author: "Atlas",
          initials: "A",
          human: false,
          content: "## 결과\n\n- 항목",
        },
        {
          id: "user-message",
          kind: "message",
          time: "09:59",
          author: "나",
          initials: "나",
          human: true,
          content: "## 요청\n\n- 그대로",
        },
        {
          id: "work-only",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          title: "Work 전용 활동",
          detail: "",
          status: "",
        },
      ],
    };
    const expectFallbackMessages = () => {
      const activity = screen.getByRole("region", { name: "Work 활동" });
      expect(within(activity).getByRole("heading", { level: 2, name: "결과" })).toBeInTheDocument();
      expect(within(activity).getByText("항목").tagName).toBe("LI");
      expect(within(activity).queryByRole("heading", { name: "요청" })).toBeNull();
      const userMessage = within(activity).getByText(/## 요청/u);
      expect(userMessage).toHaveClass("whitespace-pre-wrap");
      expect(userMessage.textContent).toBe("## 요청\n\n- 그대로");
    };
    const failed = render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => {
            throw new Error("최초 협업방 조회 실패");
          },
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("최초 협업방 조회 실패");
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("Work 전용 활동");
    expectFallbackMessages();
    failed.unmount();

    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [],
        })}
      />,
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("Work 전용 활동"));
    expectFallbackMessages();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("이전 Work의 늦은 방 응답은 방이 없는 현재 Work를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const first = snapshot.works[0] as WorkView;
    const secondBase = snapshot.works[1] as WorkView;
    const second: WorkView = {
      ...secondBase,
      activities: [
        {
          id: "second-activity",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          title: "현재 Work 활동",
          detail: "",
          status: "",
        },
      ],
    };
    const firstRooms = deferred<RoomView[]>();
    const staleRoom: RoomView = {
      roomId: "stale-room",
      name: "이전 Work 방",
      status: "active",
      participants: [],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [{ id: "stale", kind: "roomStatus", time: "10:00", content: "오래된 방 응답" }],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [first, second] },
          loadIndex: async () => [first, second],
          loadWork: async (workId) => (workId === second.id ? second : first),
          loadRooms: async (workId) => (workId === first.id ? await firstRooms.promise : []),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: new RegExp(second.title) }));
    expect(await screen.findByRole("region", { name: "Work 활동" })).toHaveTextContent("현재 Work 활동");
    firstRooms.resolve([staleRoom]);
    await Promise.resolve();
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("현재 Work 활동");
    expect(screen.queryByText("오래된 방 응답")).not.toBeInTheDocument();
  });

  it("워크스페이스 없는 Work의 근거 빈 상태는 산출물 안내를 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadWorkKnowledge: async (workId) => ({ workId, status: "not-applicable", references: [] }),
        })}
      />,
    );

    await user.click(await screen.findByRole("tab", { name: "근거" }));

    expect(await screen.findByText("이 Work는 워크스페이스 근거를 사용하지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByText("워크스페이스를 선택한 새 Work에서 코드 근거를 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.queryByText("실행이 산출물을 만들면 여기에 표시됩니다.")).not.toBeInTheDocument();
  });

  it("지식 workspace를 A에서 차단된 B로 바꾸는 첫 render부터 A graph·count·detail을 숨긴다", async () => {
    const user = userEvent.setup();
    const workspaceA = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const workspaceB = workspaceFixture("workspace-b", "B 폴더", "/tmp/b", "blocked", 1);
    const bIndex = deferred<KnowledgeIndexView>();
    const bGraph = deferred<KnowledgeGraphView>();
    let staleAtBRequest: { label: boolean; count: boolean; detail: boolean } | undefined;
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspaceA, workspaceB],
          loadKnowledgeIndex: async (workspaceId) => {
            if (workspaceId === workspaceB.workspaceId) {
              staleAtBRequest = {
                label: screen.queryAllByText("A 전용 노드").length > 0,
                count: screen.queryByText(/1개 · 0개 연결/u) !== null,
                detail: screen.queryByRole("complementary", { name: "노드 상세" }) !== null,
              };
              return await bIndex.promise;
            }
            return knowledgeIndexFixture(workspaceId);
          },
          loadKnowledgeGraph: async (workspaceId, lens) => {
            if (workspaceId === workspaceB.workspaceId) return await bGraph.promise;
            return knowledgeGraphFixture(lens, "a", "A 전용 노드");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    expect(await screen.findByText("A 전용 노드")).toBeInTheDocument();
    for (const label of ["업무별", "문서별", "파일별", "심볼별", "산출물별", "담당별"]) {
      expect(screen.getByRole("button", { name: `${label} 지도` })).toBeInTheDocument();
    }
    const explorer = screen.getByText("노드 탐색").closest("details");
    if (!explorer) throw new Error("노드 탐색 구역이 없습니다");
    await user.click(within(explorer).getByText("노드 탐색"));
    await user.click(within(explorer).getByRole("button", { name: "지도에서 선택: A 전용 노드" }));
    expect(screen.getByRole("complementary", { name: "노드 상세" })).toHaveTextContent("A 전용 노드");

    await user.selectOptions(screen.getByLabelText("워크스페이스"), workspaceB.workspaceId);
    expect(staleAtBRequest).toEqual({ label: false, count: false, detail: false });
    expect(screen.queryByText("A 전용 노드")).not.toBeInTheDocument();
    expect(screen.queryByText(/1개 · 0개 연결/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "노드 상세" })).not.toBeInTheDocument();

    await act(async () => {
      bIndex.reject(new Error("B 폴더는 차단되었습니다"));
      bGraph.resolve(knowledgeGraphFixture("work", "b", "B 비공개 노드"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("B 폴더는 차단되었습니다");
    expect(screen.queryByText("A 전용 노드")).not.toBeInTheDocument();
    expect(screen.queryByText("B 비공개 노드")).not.toBeInTheDocument();
  });

  it("느린 A workspace 응답이 빠른 B 선택 뒤에 도착해도 B graph를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const workspaceA = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const workspaceB = workspaceFixture("workspace-b", "B 폴더", "/tmp/b", "trusted", 1);
    const aIndex = deferred<KnowledgeIndexView>();
    const aGraph = deferred<KnowledgeGraphView>();
    const loadKnowledgeGraph = vi.fn(async (workspaceId: string, lens: KnowledgeNodeKind) =>
      workspaceId === workspaceA.workspaceId ? await aGraph.promise : knowledgeGraphFixture(lens, "b", "B 전용 노드"),
    );
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspaceA, workspaceB],
          loadKnowledgeIndex: async (workspaceId) =>
            workspaceId === workspaceA.workspaceId ? await aIndex.promise : knowledgeIndexFixture(workspaceId),
          loadKnowledgeGraph,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    await waitFor(() => expect(loadKnowledgeGraph).toHaveBeenCalledWith(workspaceA.workspaceId, "work"));
    await user.selectOptions(screen.getByLabelText("워크스페이스"), workspaceB.workspaceId);
    expect(await screen.findByText("B 전용 노드")).toBeInTheDocument();

    await act(async () => {
      aIndex.reject(new Error("A 지연 오류"));
      aGraph.resolve(knowledgeGraphFixture("work", "a", "A 지연 노드"));
    });
    expect(screen.getByText("B 전용 노드")).toBeInTheDocument();
    expect(screen.queryByText("A 지연 노드")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("느린 이전 lens가 새 lens보다 늦게 끝나도 새 graph를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const fileGraph = deferred<KnowledgeGraphView>();
    let staleAtFileRequest: { label: boolean; count: boolean; detail: boolean } | undefined;
    const loadKnowledgeGraph = vi.fn(async (_workspaceId: string, lens: KnowledgeNodeKind) => {
      if (lens === "file") {
        staleAtFileRequest = {
          label: screen.queryAllByText("이전 업무 노드").length > 0,
          count: screen.queryByText(/1개 · 0개 연결/u) !== null,
          detail: screen.queryByRole("complementary", { name: "노드 상세" }) !== null,
        };
        return await fileGraph.promise;
      }
      if (lens === "symbol") return knowledgeGraphFixture(lens, "new", "새 심볼 노드");
      return knowledgeGraphFixture(lens, "old", "이전 업무 노드");
    });
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspace],
          loadKnowledgeIndex: async () => knowledgeIndexFixture(workspace.workspaceId),
          loadKnowledgeGraph,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    expect(await screen.findByText("이전 업무 노드")).toBeInTheDocument();
    const explorer = screen.getByText("노드 탐색").closest("details");
    if (!explorer) throw new Error("노드 탐색 구역이 없습니다");
    await user.click(within(explorer).getByText("노드 탐색"));
    await user.click(within(explorer).getByRole("button", { name: "지도에서 선택: 이전 업무 노드" }));
    expect(screen.getByRole("complementary", { name: "노드 상세" })).toHaveTextContent("이전 업무 노드");
    await user.click(screen.getByRole("button", { name: "파일별 지도" }));
    await waitFor(() => expect(loadKnowledgeGraph).toHaveBeenCalledWith(workspace.workspaceId, "file"));
    expect(staleAtFileRequest).toEqual({ label: false, count: false, detail: false });
    expect(screen.queryByText("이전 업무 노드")).not.toBeInTheDocument();
    expect(screen.queryByText(/1개 · 0개 연결/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "노드 상세" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "심볼별 지도" }));
    expect(await screen.findByText("새 심볼 노드")).toBeInTheDocument();

    await act(async () => {
      fileGraph.resolve(knowledgeGraphFixture("file", "late", "늦은 파일 노드"));
    });
    expect(screen.getByText("새 심볼 노드")).toBeInTheDocument();
    expect(screen.queryByText("늦은 파일 노드")).not.toBeInTheDocument();
  });

  it("노드 탐색은 Tab·Enter로 열고 선택하여 pointer와 같은 상세·links·선택 상태를 제공한다", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture("workspace-keyboard", "키보드 폴더", "/tmp/keyboard", "trusted", 1);
    const alpha = {
      nodeId: "work:alpha",
      kind: "work" as const,
      label: "Alpha 노드",
      detail: "alpha detail",
    };
    const zeta = {
      nodeId: "work:zeta",
      kind: "work" as const,
      label: "Zeta 노드",
      detail: "zeta detail",
    };
    const graph: KnowledgeGraphView = { lens: "work", nodes: [zeta, alpha], edges: [] };
    const loadKnowledgeLinks = vi.fn(async (_workspaceId: string, nodeId: string) =>
      nodeId === alpha.nodeId ? [{ node: zeta, kind: "documents" as const, direction: "outgoing" as const }] : [],
    );
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspace],
          loadKnowledgeIndex: async () => knowledgeIndexFixture(workspace.workspaceId),
          loadKnowledgeGraph: async () => graph,
          loadKnowledgeLinks,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    const details = (await screen.findByText("노드 탐색")).closest("details");
    if (!details) throw new Error("노드 탐색 구역이 없습니다");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByRole("button", { name: "지도에서 선택: Alpha 노드" })).not.toBeVisible();

    screen.getByRole("button", { name: "담당별 지도" }).focus();
    await user.tab();
    expect(details.querySelector("summary")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("open");

    await user.tab();
    const alphaButton = within(details).getByRole("button", { name: "지도에서 선택: Alpha 노드" });
    const zetaButton = within(details).getByRole("button", { name: "지도에서 선택: Zeta 노드" });
    expect(alphaButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(alphaButton).toHaveAttribute("aria-pressed", "true");
    expect(zetaButton).toHaveAttribute("aria-pressed", "false");
    const inspector = await screen.findByRole("complementary", { name: "노드 상세" });
    expect(within(inspector).getByRole("heading", { name: "Alpha 노드" })).toBeInTheDocument();
    await waitFor(() => expect(loadKnowledgeLinks).toHaveBeenCalledWith(workspace.workspaceId, alpha.nodeId));
    expect(within(inspector).getByRole("button", { name: "Zeta 노드(으)로 이동" })).toBeInTheDocument();

    await user.click(zetaButton);
    expect(alphaButton).toHaveAttribute("aria-pressed", "false");
    expect(zetaButton).toHaveAttribute("aria-pressed", "true");
    expect(within(inspector).getByRole("heading", { name: "Zeta 노드" })).toBeInTheDocument();
    await waitFor(() => expect(loadKnowledgeLinks).toHaveBeenCalledWith(workspace.workspaceId, zeta.nodeId));
    expect(within(inspector).getByText("이어진 것이 없습니다.")).toBeInTheDocument();
  });

  it("설정은 실제 읽기 전용 상태만 조회하고 자격증명 값을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const loadSettings = vi.fn(async () => ({
      catalog: [],
      credentials: [{ value: "절대-표시되면-안됨" }],
      routes: [{ id: "route-1" }],
      providers: [{ id: "provider-1" }],
      accounts: [{ id: "account-1" }],
      quota: [],
      policy: [],
    }));
    const loadAutonomy = vi.fn(createFixtureDesktopService().loadAutonomy);
    render(<App service={service({ loadAutonomy, loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await screen.findByRole("main", { name: "설정" });
    // 설정은 탭도 목록도 아닌 한 문서입니다. 세 구역이 함께 보입니다.
    for (const title of ["권한", "자가개선"]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    // 프로바이더와 계정은 프로바이더 표면이 소유합니다.
    expect(screen.queryByText(/Provider 연결/)).not.toBeInTheDocument();
    expect(screen.queryByText("구독 계정")).not.toBeInTheDocument();
    // 설정 표면 진입이 실제 조회를 유발했는지만 봅니다. 소유한 것은 권한·자가개선·언어·작업공간이므로
    // 그 조회만 나가야 합니다. router·subscription 7개를 부르면 렌더에 쓰지도 않으면서 왕복을 쓰고,
    // 하나만 실패해도 이 화면과 무관한 오류가 뜹니다.
    expect(loadAutonomy).toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
    expect(screen.queryByText("절대-표시되면-안됨")).not.toBeInTheDocument();
  });

  it("Provider 정본을 읽기 전에는 manifest를 연결 상태로 단정하지 않는다", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<DesktopService["loadSettings"]>>>();
    const loadSettings = vi.fn(() => pending.promise);
    render(<App service={service({ loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    expect(screen.getAllByText("불러오는 중…").length).toBeGreaterThan(0);
    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument();
    expect(screen.queryByText("사용 가능")).not.toBeInTheDocument();
    expect(screen.queryByText("로그인이 필요합니다")).not.toBeInTheDocument();
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByText(/0\/0 활성/u)).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        catalog: {
          providers: [
            { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
          ],
          endpoints: [
            {
              endpointId: "endpoint-openrouter",
              providerId: "openrouter",
              name: "API",
              baseUrl: "https://openrouter.ai/api/v1",
              local: false,
              enabled: true,
            },
          ],
          models: [],
          discoveredModels: [],
          catalogStatuses: [
            {
              providerId: "openrouter",
              endpointId: "endpoint-openrouter",
              status: "available",
              activeCount: 0,
              invalidCount: 0,
              duplicateCount: 0,
              lastAttemptedAt: "2026-08-10T04:00:00.000Z",
            },
          ],
        },
        credentials: [],
        routes: [],
        providers: [],
        accounts: [],
        quota: [],
        policy: [],
      });
    });

    expect(await screen.findByRole("button", { name: /OpenRouter.*활성/u })).toBeInTheDocument();
  });

  it("Provider 인증 연결을 순서대로 저장하고 secret을 다시 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    // 서버는 base_url을 정규화해 저장하므로 catalog의 주소가 입력 원문과 달라도
    // 등록 응답의 endpointId를 그대로 써야 합니다.
    const loadSettings = vi.fn(async () => ({
      catalog: {
        endpoints: [
          { endpointId: "endpoint-1", providerId: "openai", name: "api", baseUrl: "https://api.openai.com/v1" },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    const registerProvider = vi.fn(async () => {
      calls.push("provider");
    });
    const registerEndpoint = vi.fn(async () => {
      calls.push("endpoint");
      return { endpointId: "endpoint-1" };
    });
    const addCredential = vi.fn(async () => {
      calls.push("credential");
    });
    const syncProviderModels = vi.fn(async () => {
      calls.push("sync");
      return { status: "available" as const, activeCount: 2, invalidCount: 0, duplicateCount: 0 };
    });
    render(
      <App
        service={service({ loadSettings, registerProvider, registerEndpoint, addCredential, syncProviderModels })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "프로바이더 추가" }));
    const form = await screen.findByRole("form", { name: "프로바이더 추가" });
    // 사람이 대는 것은 넷뿐이고 내부 id·endpoint 이름·자격 종류는 도출합니다.
    await user.type(within(form).getByRole("textbox", { name: "이름" }), "OpenAI");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://api.openai.com/v1/");
    const secret = within(form).getByLabelText(/키/);
    await user.type(secret, "never-render-this");
    await user.click(within(form).getByRole("button", { name: "추가" }));

    expect(await screen.findByText("프로바이더를 추가했습니다.")).toBeInTheDocument();
    expect(calls).toEqual(["provider", "endpoint", "credential", "sync"]);
    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-1");
    expect(addCredential).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: "endpoint-1", secret: "never-render-this", priority: 0, weight: 100 }),
    );
    expect(secret).toHaveValue("");
    expect(screen.queryByText("never-render-this")).not.toBeInTheDocument();
  });

  it("Provider 저장 뒤 모델 확인이 실패해도 저장 실패로 오인하지 않는다", async () => {
    const user = userEvent.setup();
    const registerProvider = vi.fn(async () => undefined);
    const registerEndpoint = vi.fn(async () => ({ endpointId: "endpoint-openrouter" }));
    const addCredential = vi.fn(async () => undefined);
    const syncProviderModels = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    const loadSettings = vi.fn(async () => ({
      catalog: { providers: [], endpoints: [], models: [], discoveredModels: [], catalogStatuses: [] },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(
      <App
        service={service({
          addCredential,
          loadSettings,
          registerEndpoint,
          registerProvider,
          syncProviderModels,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "프로바이더 추가" }));
    const form = await screen.findByRole("form", { name: "프로바이더 추가" });
    await user.type(within(form).getByRole("textbox", { name: "이름" }), "OpenRouter");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://openrouter.ai/api/v1");
    await user.click(within(form).getByRole("button", { name: "추가" }));

    expect(await screen.findByText("프로바이더는 저장했지만 모델 목록을 확인하지 못했습니다.")).toBeInTheDocument();
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerEndpoint).toHaveBeenCalledOnce();
  });

  it("API 모델은 실행 비활성으로 표시하고 내부 발견 상태를 노출하지 않는다", async () => {
    const user = userEvent.setup();
    const synced = deferred<{
      status: "available";
      activeCount: number;
      invalidCount: number;
      duplicateCount: number;
    }>();
    const syncProviderModels = vi.fn(async () => await synced.promise);
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        candidates: [],
        discoveredModels: [
          {
            catalogEntryId: "catalog-openrouter-free",
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            modelId: "vendor/free-model",
            state: "active",
          },
        ],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 1,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
            lastSuccessfulAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    const model = await screen.findByText("vendor/free-model");
    const modelRow = model.closest("li") as HTMLElement;
    expect(within(modelRow).getByText("꺼짐")).toBeInTheDocument();
    expect(within(modelRow).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("0/1 활성")).toBeInTheDocument();
    expect(screen.queryByText("발견됨")).not.toBeInTheDocument();
    expect(screen.queryByText("등록됨")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /모델 새로고침/u }));
    const busyMessage = await screen.findByText("모델 목록을 확인하고 있습니다.");
    const busyLiveRegion = busyMessage.closest('[aria-live="polite"]');
    expect(busyLiveRegion).toHaveAttribute("aria-atomic", "true");
    expect(busyLiveRegion?.querySelector("ul")).toBeNull();
    expect(modelRow.closest('[aria-live="polite"]')).toBeNull();
    await act(async () => {
      synced.resolve({ status: "available", activeCount: 1, invalidCount: 0, duplicateCount: 0 });
    });

    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-openrouter");
    expect(await screen.findByRole("status")).toHaveTextContent("모델 목록을 확인했습니다.");
  });

  it("등록 모델만 저장되는 On/Off 제어로 바꾼다", async () => {
    const user = userEvent.setup();
    const settings = {
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [
          {
            modelProfileId: "registered-profile",
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            modelId: "vendor/registered",
            routeKind: "chat",
            verified: true,
            enabled: true,
          },
        ],
        candidates: [],
        discoveredModels: [
          {
            catalogEntryId: "catalog-openrouter-free",
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            modelId: "vendor/free-model",
            state: "active",
          },
        ],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 2,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    };
    const setModelEnabled = vi.fn(async (modelProfileId: string, enabled: boolean) => {
      expect(modelProfileId).toBe("registered-profile");
      const registered = settings.catalog.models.at(0);
      if (!registered) throw new Error("등록 모델 fixture가 필요합니다");
      registered.enabled = enabled;
    });
    const loadSettings = vi.fn(async () => structuredClone(settings));
    render(<App service={service({ loadSettings, setModelEnabled })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    const registered = await screen.findByRole("switch", { name: "vendor/registered", checked: true });
    await user.click(registered);

    expect(setModelEnabled).toHaveBeenCalledWith("registered-profile", false);
    expect(await screen.findByRole("switch", { name: "vendor/registered", checked: false })).toBeInTheDocument();
    expect(screen.getByText("모델을 껐습니다.")).toBeInTheDocument();
    const catalogOnly = screen.getByText("vendor/free-model").closest("li") as HTMLElement;
    expect(within(catalogOnly).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("Endpoint별 모델·상태·새로고침을 분리하고 비활성 주소는 읽기 전용으로 둔다", async () => {
    const user = userEvent.setup();
    const syncProviderModels = vi.fn(async () => ({
      status: "empty" as const,
      activeCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
    }));
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-primary",
            providerId: "openrouter",
            name: "Primary",
            baseUrl: "https://primary.example/v1",
            local: false,
            enabled: true,
          },
          {
            endpointId: "endpoint-secondary",
            providerId: "openrouter",
            name: "Secondary",
            baseUrl: "https://secondary.example/v1",
            local: false,
            enabled: true,
          },
          {
            endpointId: "endpoint-retired",
            providerId: "openrouter",
            name: "Retired",
            baseUrl: "https://retired.example/v1",
            local: false,
            enabled: false,
          },
        ],
        models: [
          {
            modelProfileId: "registered-profile",
            providerId: "openrouter",
            endpointId: "endpoint-primary",
            modelId: "vendor/registered",
            routeKind: "chat",
            verified: false,
            enabled: true,
          },
          {
            modelProfileId: "verified-profile",
            providerId: "openrouter",
            endpointId: "endpoint-secondary",
            modelId: "vendor/verified-stale",
            routeKind: "chat",
            verified: true,
            enabled: true,
          },
        ],
        discoveredModels: [
          {
            catalogEntryId: "stale-entry",
            providerId: "openrouter",
            endpointId: "endpoint-secondary",
            modelId: "vendor/verified-stale",
            state: "stale",
          },
          {
            catalogEntryId: "retired-entry",
            providerId: "openrouter",
            endpointId: "endpoint-retired",
            modelId: "vendor/retired",
            state: "stale",
          },
        ],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-primary",
            status: "available",
            activeCount: 1,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
          {
            providerId: "openrouter",
            endpointId: "endpoint-secondary",
            status: "empty",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:01:00.000Z",
          },
          {
            providerId: "openrouter",
            endpointId: "endpoint-retired",
            status: "degraded",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:02:00.000Z",
          },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    const registered = await screen.findByText("vendor/registered");
    expect(within(registered.closest("li") as HTMLElement).getByText("켜짐")).toBeInTheDocument();
    expect(within(registered.closest("li") as HTMLElement).getByText("미확인")).toBeInTheDocument();
    expect(screen.queryByText("등록됨")).not.toBeInTheDocument();
    expect(screen.queryByText("발견됨")).not.toBeInTheDocument();
    const verifiedStale = screen.getByText("vendor/verified-stale").closest("li") as HTMLElement;
    expect(within(verifiedStale).getByText("이전 목록")).toBeInTheDocument();
    expect(within(verifiedStale).queryByText(/검증됨/u)).not.toBeInTheDocument();
    const catalogWarning = screen.getByText(
      "모델 API가 빈 목록을 반환했습니다. 저장된 이전 목록은 교체하지 않았습니다.",
    );
    const catalogLiveRegion = catalogWarning.closest('[aria-live="polite"]');
    expect(catalogLiveRegion).not.toBeNull();
    expect(catalogLiveRegion).toHaveAttribute("aria-atomic", "true");
    expect(catalogLiveRegion?.querySelector("ul")).toBeNull();
    expect(verifiedStale.closest('[aria-live="polite"]')).toBeNull();
    expect(screen.getByText("비활성 주소 · 읽기 전용 이전 목록")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /모델 새로고침 · Retired/u })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /모델 새로고침 · Secondary/u }));
    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-secondary");
    expect(await screen.findByText("모델 API가 빈 목록을 반환했습니다.")).toBeInTheDocument();
  });

  it("상태가 없는 기존 Endpoint의 모델 목록을 화면 진입 뒤 한 번만 자동 확인한다", async () => {
    const user = userEvent.setup();
    const syncProviderModels = vi.fn(async () => ({
      status: "available" as const,
      activeCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
    }));
    const settings = {
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        discoveredModels: [],
        catalogStatuses: [],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    };
    const loadSettings = vi.fn(async () => settings);
    render(<App service={service({ loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await waitFor(() => expect(syncProviderModels).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-openrouter");
    expect(syncProviderModels).toHaveBeenCalledTimes(1);
  });

  it("미래·경과 retryAt은 각각 한 번 재시도하고 화면이 닫히면 예약을 취소한다", async () => {
    vi.useFakeTimers();
    try {
      const syncProviderModels = vi.fn(async () => ({
        status: "available" as const,
        activeCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
      }));
      const retryAt = new Date(Date.now() + 1_000).toISOString();
      const loadSettings = vi.fn(async () => ({
        catalog: {
          providers: [
            { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
          ],
          endpoints: [
            {
              endpointId: "endpoint-openrouter",
              providerId: "openrouter",
              name: "API",
              baseUrl: "https://openrouter.ai/api/v1",
              local: false,
              enabled: true,
            },
          ],
          models: [],
          discoveredModels: [],
          catalogStatuses: [
            {
              providerId: "openrouter",
              endpointId: "endpoint-openrouter",
              status: "degraded",
              activeCount: 0,
              invalidCount: 0,
              duplicateCount: 0,
              retryAt,
              lastAttemptedAt: new Date(Date.now() - 1_000).toISOString(),
            },
          ],
        },
        credentials: [],
        routes: [],
        providers: [],
        accounts: [],
        quota: [],
        policy: [],
      }));
      const first = render(<App service={service({ loadSettings, syncProviderModels })} />);
      fireEvent.click(screen.getByRole("button", { name: "프로바이더" }));
      await act(async () => Promise.resolve());
      expect(syncProviderModels).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(syncProviderModels).toHaveBeenCalledTimes(1);
      first.unmount();

      syncProviderModels.mockClear();
      const pastRetryAt = new Date(Date.now() - 1_000).toISOString();
      const pastLoadSettings = vi.fn(async () => {
        const value = await loadSettings();
        return {
          ...value,
          catalog: {
            ...value.catalog,
            catalogStatuses: value.catalog.catalogStatuses.map((status) => ({ ...status, retryAt: pastRetryAt })),
          },
        };
      });
      const past = render(<App service={service({ loadSettings: pastLoadSettings, syncProviderModels })} />);
      fireEvent.click(screen.getByRole("button", { name: "프로바이더" }));
      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTime(0));
      await act(async () => Promise.resolve());
      expect(syncProviderModels).toHaveBeenCalledTimes(1);
      past.unmount();

      syncProviderModels.mockClear();
      const cancelRetryAt = new Date(Date.now() + 2_000).toISOString();
      const cancelLoadSettings = vi.fn(async () => {
        const value = await loadSettings();
        return {
          ...value,
          catalog: {
            ...value.catalog,
            catalogStatuses: value.catalog.catalogStatuses.map((status) => ({ ...status, retryAt: cancelRetryAt })),
          },
        };
      });
      const second = render(<App service={service({ loadSettings: cancelLoadSettings, syncProviderModels })} />);
      fireEvent.click(screen.getByRole("button", { name: "프로바이더" }));
      await act(async () => Promise.resolve());
      second.unmount();
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(syncProviderModels).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("400개 모델 목록을 스크롤·키보드로 다루며 지연 상태 문구도 한국어와 영어로 번역한다", async () => {
    const discoveredModels = Array.from({ length: 400 }, (_, index) => ({
      catalogEntryId: `catalog-${index}`,
      providerId: "openrouter",
      endpointId: "endpoint-openrouter",
      modelId: `vendor/model-${String(index).padStart(3, "0")}`,
      state: "active",
    }));
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        discoveredModels,
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 400,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    try {
      localStorage.setItem("massion.language.v1", "ko");
      const koreanSync = vi.fn(async () => ({
        status: "available" as const,
        activeCount: 400,
        invalidCount: 0,
        duplicateCount: 0,
      }));
      const korean = render(
        <I18nProvider>
          <App service={service({ loadSettings, syncProviderModels: koreanSync })} />
        </I18nProvider>,
      );
      const koreanUser = userEvent.setup();
      await koreanUser.click(screen.getByRole("button", { name: "프로바이더" }));
      const lastModel = await screen.findByText("vendor/model-399");
      const modelScroll = screen.getByTestId("provider-model-scroll");
      const modelClip = screen.getByTestId("provider-model-clip");
      expect(modelScroll).toHaveClass("min-w-0", "overflow-y-auto");
      expect(modelScroll).toHaveAttribute("role", "region");
      expect(modelScroll).toHaveAccessibleName("모델 목록");
      expect(modelScroll).toHaveAttribute("tabindex", "0");
      modelScroll.focus();
      expect(modelScroll).toHaveFocus();
      expect(modelScroll).not.toHaveClass("overflow-x-auto", "overflow-x-scroll");
      expect(modelClip).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      expect(modelScroll.closest("aside")).toHaveClass("min-w-0", "overflow-hidden");
      expect(lastModel).toHaveClass("min-w-0", "truncate");
      const lastModelRow = lastModel.closest("li");
      expect(lastModelRow).not.toBeNull();
      expect(lastModelRow).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      const modelList = lastModelRow?.parentElement;
      const modelContainer = modelList?.parentElement;
      const endpointSection = modelContainer?.parentElement;
      const modelGrid = endpointSection?.parentElement;
      expect(modelList).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      expect(modelContainer).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      expect(modelContainer).not.toHaveAttribute("aria-live");
      expect(endpointSection).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      expect(modelGrid).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      expect(within(lastModelRow as HTMLElement).getByText("꺼짐")).toHaveClass("shrink-0");
      const koreanRefresh = screen.getByRole("button", { name: /모델 새로고침 · API/u });
      koreanRefresh.focus();
      await koreanUser.keyboard("{Enter}");
      expect(koreanSync).toHaveBeenCalledWith("endpoint-openrouter");
      expect(await screen.findByText("모델 목록을 확인했습니다.")).toBeInTheDocument();
      expect(screen.getAllByText(/^vendor\/model-/u)).toHaveLength(400);
      expect(screen.getByTestId("provider-model-clip")).toHaveClass("max-w-full", "overflow-hidden");
      korean.unmount();

      localStorage.setItem("massion.language.v1", "en");
      const englishSync = vi.fn(async () => ({
        status: "partial" as const,
        activeCount: 400,
        invalidCount: 1,
        duplicateCount: 0,
      }));
      const english = render(
        <I18nProvider>
          <App service={service({ loadSettings, syncProviderModels: englishSync })} />
        </I18nProvider>,
      );
      const englishUser = userEvent.setup();
      await englishUser.click(screen.getByRole("button", { name: "Provider" }));
      expect(await screen.findByText("vendor/model-399")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Model list" })).toHaveAttribute("tabindex", "0");
      expect(screen.getAllByText("Off")).toHaveLength(400);
      expect(screen.queryByText("Discovered")).not.toBeInTheDocument();
      const englishRefresh = screen.getByRole("button", { name: /Refresh models · API/u });
      englishRefresh.focus();
      await englishUser.keyboard("{Enter}");
      expect(
        await screen.findByText("Some model data was invalid, so the last good catalog was kept."),
      ).toBeInTheDocument();
      expect(screen.queryByText("모델 응답 일부가 유효하지 않아 이전 목록을 유지했습니다.")).not.toBeInTheDocument();
      english.unmount();
    } finally {
      localStorage.setItem("massion.language.v1", "ko");
    }
  });

  it("직접 등록한 Provider는 상세에서 제거하고 구독 연결은 제거 대상이 아니다", async () => {
    const user = userEvent.setup();
    const removeProvider = vi.fn(async () => ({ removed: true }));
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "api",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        ],
        models: [],
        candidates: [],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ loadSettings, removeProvider })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "프로바이더 제거" }));
    // 첫 클릭은 확인만 요청하고 아직 지우지 않습니다.
    expect(removeProvider).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "제거" }));

    expect(removeProvider).toHaveBeenCalledWith("openrouter");
    expect(await screen.findByText("프로바이더를 제거했습니다.")).toBeInTheDocument();
  });

  it("직접 등록한 Provider도 endpoint에 키를 달 수 있고 실패는 모달 안에서 알린다", async () => {
    const user = userEvent.setup();
    const addCredential = vi.fn(async () => {
      throw new Error("키가 거부됐습니다.");
    });
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "api",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        ],
        models: [],
        candidates: [],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ addCredential, loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    // manifest에 없는 Provider라도 어댑터가 키를 받으면 연결 경로가 있어야 합니다.
    await user.click(await screen.findByRole("button", { name: "키 추가" }));
    await user.type(screen.getByLabelText("키"), "sk-test");
    await user.click(screen.getByRole("button", { name: "연결" }));

    expect(addCredential).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openrouter", endpointId: "endpoint-openrouter", secret: "sk-test" }),
    );
    // 실패 사유가 모달 뒤로 숨지 않아야 합니다.
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("키가 거부됐습니다.");
  });

  it("키 저장 뒤 모델 확인 실패는 부분 성공으로 알리고 입력값을 지운다", async () => {
    const user = userEvent.setup();
    const addCredential = vi.fn(async () => undefined);
    const syncProviderModels = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        discoveredModels: [],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ addCredential, loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "키 추가" }));
    const key = screen.getByLabelText("키");
    await user.type(key, "sk-test");
    await user.click(screen.getByRole("button", { name: "연결" }));

    expect(await screen.findByText("키는 저장했지만 모델 목록을 확인하지 못했습니다.")).toBeInTheDocument();
    expect(addCredential).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "키로 연결" })).not.toBeInTheDocument();
  });

  it("키 해지 뒤 모델 재확인이 실패해도 해지 성공을 유지한다", async () => {
    const user = userEvent.setup();
    const disableCredential = vi.fn(async () => undefined);
    const syncProviderModels = vi.fn(async () => {
      throw new Error("credential revoked");
    });
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        discoveredModels: [],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [
        {
          credentialId: "credential-openrouter",
          providerId: "openrouter",
          endpointId: "endpoint-openrouter",
          label: "기본 키",
          status: "active",
          version: 1,
        },
      ],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ disableCredential, loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "제거" }));

    expect(disableCredential).toHaveBeenCalledWith("credential-openrouter", 1);
    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-openrouter");
    expect(await screen.findByText("키는 제거했지만 모델 목록을 다시 확인하지 못했습니다.")).toBeInTheDocument();
  });

  it("키가 등록된 Provider는 빈 상태 대신 교체 경로를 보여준다", async () => {
    const user = userEvent.setup();
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "api",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        ],
        models: [],
        candidates: [],
      },
      credentials: [
        {
          providerId: "openrouter",
          endpointId: "endpoint-openrouter",
          credentialId: "credential-openrouter",
          label: "기본 키",
          status: "active",
          version: 1,
        },
      ],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    // 계정이 아니라 자격 증명이 사실이므로, 키가 있으면 빈 상태가 아니어야 합니다.
    // 키가 있으면 목록으로 보이고, 추가는 언제나 «추가»입니다.
    expect(await screen.findByText("기본 키")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "키 추가" })).toBeInTheDocument();
    expect(screen.queryByText("등록된 키가 없습니다.")).not.toBeInTheDocument();
  });

  it("영어 UI는 제품 기본 키만 번역하고 사용자 지정 키 이름은 그대로 둔다", async () => {
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "API",
            baseUrl: "https://openrouter.ai/api/v1",
            local: false,
            enabled: true,
          },
        ],
        models: [],
        discoveredModels: [],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [
        {
          providerId: "openrouter",
          endpointId: "endpoint-openrouter",
          credentialId: "credential-default",
          label: "기본 키",
          status: "active",
          version: 1,
        },
        {
          providerId: "openrouter",
          endpointId: "endpoint-openrouter",
          credentialId: "credential-custom",
          label: "팀 전용",
          status: "active",
          version: 1,
        },
      ],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    try {
      localStorage.setItem("massion.language.v1", "en");
      const view = render(
        <I18nProvider>
          <App service={service({ loadSettings })} />
        </I18nProvider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Provider" }));

      expect(await screen.findByText("Default key")).toBeInTheDocument();
      expect(screen.getByText("팀 전용")).toBeInTheDocument();
      expect(screen.queryByText("기본 키")).not.toBeInTheDocument();
      view.unmount();
    } finally {
      localStorage.setItem("massion.language.v1", "ko");
    }
  });

  it("프로바이더를 불러오지 못하면 같은 자리에서 다시 시도할 수 있다", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const loadSettings = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("불러오지 못했습니다.");
      return {
        catalog: { providers: [], endpoints: [], models: [], candidates: [] },
        credentials: [],
        routes: [],
        providers: [],
        accounts: [],
        quota: [],
        policy: [],
      };
    });
    render(<App service={service({ loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("불러오지 못했습니다.");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => {
      expect(loadSettings).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("등록한 키는 같은 화면에서 제거할 수 있다", async () => {
    const user = userEvent.setup();
    const disableCredential = vi.fn(async () => undefined);
    const syncProviderModels = vi.fn(async () => ({
      status: "available" as const,
      activeCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
    }));
    const loadSettings = vi.fn(async () => ({
      catalog: {
        providers: [
          { providerId: "openrouter", displayName: "OpenRouter", adapterKind: "openai-compatible", enabled: true },
        ],
        endpoints: [
          {
            endpointId: "endpoint-openrouter",
            providerId: "openrouter",
            name: "api",
            baseUrl: "https://openrouter.ai/api/v1",
            enabled: true,
          },
        ],
        models: [],
        candidates: [],
        catalogStatuses: [
          {
            providerId: "openrouter",
            endpointId: "endpoint-openrouter",
            status: "available",
            activeCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
            lastAttemptedAt: "2026-08-10T04:00:00.000Z",
          },
        ],
      },
      credentials: [
        {
          providerId: "openrouter",
          endpointId: "endpoint-openrouter",
          credentialId: "credential-openrouter",
          label: "기본 키",
          status: "active",
          version: 2,
        },
      ],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ disableCredential, loadSettings, syncProviderModels })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "제거" }));

    expect(disableCredential).toHaveBeenCalledWith("credential-openrouter", 2);
    expect(syncProviderModels).toHaveBeenCalledWith("endpoint-openrouter");
    expect(await screen.findByRole("status")).toHaveTextContent("키를 제거했습니다.");
  });

  it("깨끗한 프로필에서도 공식 OpenAI Codex 카드로 로그인한다", async () => {
    const user = userEvent.setup();
    const loginSubscription = vi.fn(async () => undefined);
    const official = {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      connectionSurface: "server-and-edge",
    };
    const zai = {
      providerId: "zai-coding-plan",
      displayName: "Z.AI GLM Coding Plan",
      adapterKind: "subscription-connector",
      enabled: true,
    };
    const initial = {
      catalog: { providers: [zai], endpoints: [], models: [], credentials: [] },
      credentials: [],
      routes: [],
      providers: [official],
      accounts: [],
      quota: [],
      policy: [],
    };
    const connected = {
      ...initial,
      catalog: {
        providers: [
          {
            providerId: "openai-codex",
            displayName: "OpenAI Codex",
            adapterKind: "subscription-connector",
            enabled: true,
          },
          zai,
        ],
        endpoints: [
          {
            endpointId: "codex-app-server",
            providerId: "openai-codex",
            name: "Codex app server",
            baseUrl: "massion-connector:///openai-codex/codex-app-server",
            local: false,
          },
        ],
        models: [],
        credentials: [],
      },
      accounts: [
        {
          accountId: "account-codex",
          providerId: "openai-codex",
          alias: "OpenAI Codex",
          status: "active",
          billingKind: "consumer-subscription",
        },
      ],
    };
    const loadSettings = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(connected);
    render(<App service={service({ loadSettings, loginSubscription })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));

    expect(await screen.findByRole("button", { name: /OpenAI Codex/ })).toBeInTheDocument();
    expect(screen.getAllByText("사용 가능").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Codex 로그인" }));
    expect(loginSubscription).toHaveBeenCalledWith({
      providerId: "openai-codex",
      alias: "OpenAI Codex",
      newAccount: false,
    });
    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: /OpenAI Codex/ })).toHaveLength(1);
    expect(await screen.findByText("구독 계정으로 연결됨")).toBeInTheDocument();
    expect(screen.getAllByText("활성").length).toBeGreaterThan(0);
    const modelRegion = screen.getByRole("region", { name: "모델 목록" });
    expect(screen.queryByRole("button", { name: /모델 새로고침/u })).not.toBeInTheDocument();
    modelRegion.focus();
    expect(modelRegion).toHaveFocus();
  }, 15_000);

  it("잘못된 Adapter의 기존 Codex ID를 연결 충돌로 표시하고 공식 로그인을 유지한다", async () => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadSettings: async () => ({
            catalog: {
              providers: [
                {
                  providerId: "openai-codex",
                  displayName: "Legacy Codex",
                  adapterKind: "openai-compatible",
                  enabled: true,
                },
              ],
              endpoints: [],
              models: [],
              credentials: [],
            },
            credentials: [],
            routes: [],
            providers: [
              {
                providerId: "openai-codex",
                displayName: "OpenAI Codex",
                connectionSurface: "server-and-edge",
              },
            ],
            accounts: [],
            quota: [],
            policy: [],
          }),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "프로바이더" }));

    expect(await screen.findByText("연결 충돌")).toBeInTheDocument();
    expect(screen.getByText(/다른 어댑터로 등록/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex 로그인" })).toBeInTheDocument();
  }, 15_000);

  it("일반 Provider 추가는 구독 커넥터를 노출하지 않는다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "프로바이더 추가" }));

    const form = await screen.findByRole("form", { name: "프로바이더 추가" });
    expect(within(form).queryByRole("option", { name: "구독 커넥터" })).not.toBeInTheDocument();
    expect(within(form).queryByRole("option", { name: "Anthropic" })).not.toBeInTheDocument();
  }, 15_000);

  it.each([
    ["활성", [{ status: "active" }], "구독 계정으로 연결됨"],
    ["비활성", [{ status: "expired" }], "계정 확인이 필요합니다"],
    ["없음", [], "로그인이 필요합니다"],
  ] as const)("구독 커넥터의 %s OAuth 계정을 인증 상태로 표시한다", async (_case, rows, expected) => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadSettings: async () => ({
            catalog: {
              providers: [
                {
                  providerId: "openai-codex",
                  displayName: "OpenAI Codex",
                  adapterKind: "subscription-connector",
                  enabled: true,
                },
              ],
              endpoints: [
                {
                  endpointId: "codex-app-server",
                  providerId: "openai-codex",
                  name: "Codex app server",
                  baseUrl: "massion-connector:///openai-codex/codex-app-server",
                  local: false,
                },
              ],
              models: [],
              credentials: [],
            },
            credentials: [],
            routes: [],
            providers: [],
            accounts: rows.map((account) => ({
              accountId: "account-codex",
              providerId: "openai-codex",
              alias: "Codex",
              status: account.status,
              billingKind: "consumer-subscription",
            })),
            quota: [],
            policy: [],
          }),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "프로바이더" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("등록되지 않았습니다")).not.toBeInTheDocument();
  });

  it.each([
    ["첫 로그인", [], "Codex 로그인", false, "OpenAI Codex"],
    ["기존 계정 재연결", [{ status: "offline" }], "다시 연결", false, "Codex"],
    ["비활성 계정 옆 새 계정", [{ status: "offline" }], "새 계정 추가", true, "OpenAI Codex"],
    ["활성 계정 옆 추가", [{ status: "active" }], "계정 추가", true, "OpenAI Codex"],
  ] as const)(
    "구독 커넥터의 %s 동작을 실제 로그인 워크플로에 연결한다",
    async (_case, rows, label, newAccount, alias) => {
      const user = userEvent.setup();
      const loginSubscription = vi.fn(async () => undefined);
      const loadSettings = vi.fn(async () => ({
        catalog: {
          providers: [
            {
              providerId: "openai-codex",
              displayName: "OpenAI Codex",
              adapterKind: "subscription-connector",
              enabled: true,
            },
          ],
          endpoints: [],
          models: [],
          credentials: [],
        },
        credentials: [],
        routes: [],
        providers: [],
        accounts: rows.map((account) => ({
          accountId: "account-codex",
          providerId: "openai-codex",
          alias: "Codex",
          status: account.status,
          billingKind: "consumer-subscription",
        })),
        quota: [],
        policy: [],
      }));
      render(<App service={service({ loadSettings, loginSubscription })} />);

      await user.click(screen.getByRole("button", { name: "프로바이더" }));
      await user.click(await screen.findByRole("button", { name: label }));

      expect(loginSubscription).toHaveBeenCalledWith({
        providerId: "openai-codex",
        alias,
        newAccount,
      });
      expect(loadSettings).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("Codex 계정 연결을 완료했습니다.")).toBeInTheDocument();
    },
  );

  it("확장 화면은 조직에 늘어난 Capability를 버전·출처보다 먼저 보인다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "installation-notes-1",
        packageName: "@massion-ext/notes",
        version: "1.0.0",
        description: "노트를 업무에 연결합니다.",
        provenance: "official",
        installed: true,
        state: "healthy",
        contributions: [{ kind: "runtimeTools" as const, items: ["notes.search"] }],
        permissions: [{ kind: "network" as const, items: ["notes.example"] }],
      },
      {
        id: "version-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "팀 일정을 Work에 연결합니다.",
        provenance: "community",
        installed: false,
        contributions: [],
        permissions: [],
      },
    ]);
    const installRegistry = vi.fn(async () => ({ outcome: "awaiting-approval", approvalId: "approval-install-1" }));
    render(<App service={service({ loadExtensions, installRegistry })} />);

    await user.click(screen.getByRole("button", { name: "확장" }));
    await screen.findByRole("main", { name: "확장" });
    expect(loadExtensions).toHaveBeenCalledOnce();

    // 설치된 것이 목록에서도 상세에서도 먼저입니다. 헌법 6절이 요구하는 순서입니다.
    const detail = screen.getByRole("main", { name: "확장" }).textContent ?? "";
    expect(detail.indexOf("조직이 무엇을 할 수 있게 되나")).toBeLessThan(detail.indexOf("출처"));
    // 도메인 키가 아니라 사람의 말로 나옵니다.
    expect(screen.getByText("도구")).toBeInTheDocument();
    expect(screen.getByText("notes.search")).toBeInTheDocument();
    expect(detail).not.toContain("runtimeTools");
    // 설치된 확장에는 설치 버튼이 없습니다.
    expect(screen.queryByRole("button", { name: "설치" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /calendar/ }));
    await user.click(await screen.findByRole("button", { name: "설치" }));
    expect(await screen.findByText("설치가 승인을 기다립니다.")).toBeInTheDocument();
    expect(installRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "version-calendar-1", environment: "production", riskClass: "medium" }),
      expect.objectContaining({ commandId: expect.any(String), correlationId: expect.any(String) }),
    );
  });

  it("설치된 확장 선택은 Registry 상세를 조회하지 않는다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "installation-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "",
        provenance: "official",
        installed: true,
        state: "healthy",
        contributions: [],
        permissions: [],
      },
    ]);
    const loadRegistryInfo = vi.fn(async () => {
      throw new Error("요청을 처리하지 못했습니다");
    });
    render(<App service={service({ loadExtensions, loadRegistryInfo })} />);

    await user.click(screen.getByRole("button", { name: "확장" }));
    await user.click(await screen.findByRole("button", { name: /calendar/ }));

    expect(loadRegistryInfo).not.toHaveBeenCalled();
    expect(screen.getByText("동작 중")).toBeInTheDocument();
    // 계약이 Capability를 주지 않는다는 사실을 화면이 감추지 않습니다.
    expect(screen.getByText(/조직에 무엇을 더하는지 계약이 알려주지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("결정 승인 직후 대기한 Registry 설치를 원래 identity로 한 번 자동 재개한다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "version-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "",
        provenance: "community",
        installed: false,
        contributions: [],
        permissions: [],
      },
    ]);
    const installRegistry = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "awaiting-approval", approvalId: "approval-install-1" })
      .mockResolvedValueOnce({ outcome: "succeeded", installationId: "installation-1" });
    const approval = {
      id: "approval-install-1",
      title: "Calendar 설치",
      description: "설치 승인",
      revision: 1,
      status: "pending",
    };
    const decideApproval = vi.fn(async () => ({
      approvalId: approval.id,
      status: "approved",
      revision: approval.revision + 1,
    }));
    render(
      <App
        service={service({
          decideApproval,
          installRegistry,
          loadExtensions,
          loadPendingApprovals: async () => [approval],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "확장" }));
    await user.click(await screen.findByRole("button", { name: "설치" }));
    const initialRequest = installRegistry.mock.calls[0]?.[0];
    const identity = installRegistry.mock.calls[0]?.[1];

    await user.click(screen.getByRole("button", { name: /수신함/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(panel).queryByRole("button", { name: /승인$/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "승인 검토 열기: Calendar 설치" }));
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const extension = await screen.findByRole("main", { name: "확장" });
    await user.click(within(extension).getByRole("button", { name: "Calendar 설치 승인" }));
    expect(decideApproval).toHaveBeenCalledWith(approval, "approve", "데스크톱 확장에서 승인");
    await waitFor(() => expect(installRegistry).toHaveBeenCalledTimes(2));
    expect(installRegistry).toHaveBeenNthCalledWith(
      2,
      { ...initialRequest, installApprovalId: "approval-install-1" },
      identity,
    );
    expect(screen.getByRole("button", { name: /수신함/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인 반영 후 설치 재개" })).not.toBeInTheDocument();
  });

  it("사이드바를 포인터와 [ 키로 접고 확장 항목의 이름을 유지한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    expect(screen.getByRole("button", { name: "확장" })).toBeInTheDocument();
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("150px");
    await user.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(screen.getByTestId("desktop-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("4.25rem");
    await user.keyboard("[[]");
    expect(screen.getByTestId("desktop-shell")).toHaveAttribute("data-sidebar-collapsed", "false");
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("150px");
  });

  it("수신함 배지는 선택한 업무와 무관하게 전역 미해결 항목을 유지한다", async () => {
    const user = userEvent.setup();
    const approval = {
      id: "approval-crm-access",
      title: "CRM 고객 데이터 읽기",
      description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
      revision: 1,
      status: "pending",
      workId: "churn-q3",
    };
    render(<App service={service({ loadPendingApprovals: async () => [approval] })} />);

    expect(await screen.findByRole("button", { name: "수신함, 미해결 4개" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    expect(screen.getByRole("button", { name: "수신함, 미해결 4개" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "수신함, 미해결 4개" }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(panel).getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
    expect(within(panel).getAllByText("3분기 고객 이탈 원인 분석").length).toBeGreaterThan(0);

    await user.click(within(panel).getByRole("button", { name: "수신함 닫기" }));
    await user.click(screen.getByRole("button", { name: "수신함, 미해결 4개" }));
    expect(await screen.findByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
  });

  it("정본 Inbox는 현재 검색·필터·50개 Work 밖의 차단 실행을 Home·배지·수신함에 유지한다", async () => {
    const user = userEvent.setup();
    const visible = {
      ...(fixtureDataAdapter().works[0] as WorkView),
      id: "visible-nonmatching-work",
      title: "현재 필터에만 보이는 Work",
      approvals: [],
      run: { runId: "run-visible", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const loadInbox = vi.fn(async () => [
      {
        kind: "blocked" as const,
        id: "blocked:run-beyond-page",
        runId: "run-beyond-page",
        workId: "work-beyond-page-051",
        title: "51번째 검색 밖 차단 Work",
        reason: "사용 가능한 모델이 없습니다.",
      },
    ]);
    const fake = service({
      initialSnapshot: { works: [visible] },
      loadIndex: async () => [visible],
      loadPendingApprovals: async () => [],
      loadGrowth: async () => ({ suggestions: [], memories: [], effects: [] }),
    });
    (fake as DesktopService & { loadInbox: typeof loadInbox }).loadInbox = loadInbox;

    render(<App service={fake} />);

    expect(await screen.findByRole("button", { name: "수신함, 미해결 1개" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "홈" }));
    expect(
      within(await screen.findByRole("main", { name: "홈" })).getByRole("button", {
        name: /51번째 검색 밖 차단 Work/u,
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "수신함, 미해결 1개" }));
    expect(
      within(await screen.findByRole("dialog", { name: "수신함" })).getByRole("button", {
        name: "업무로 이동: 51번째 검색 밖 차단 Work",
      }),
    ).toBeInTheDocument();
    expect(loadInbox).toHaveBeenCalled();
  });

  it("수신함 승인 결정은 영속 명령 후 정본을 다시 읽어 해결한 한 항목만 제거한다", async () => {
    const user = userEvent.setup();
    const first = {
      id: "approval-inbox-first",
      title: "첫 번째 승인",
      description: "첫 항목만 해결합니다.",
      revision: 1,
      status: "pending",
    };
    const second = {
      id: "approval-inbox-second",
      title: "두 번째 승인",
      description: "두 번째 항목은 남아야 합니다.",
      revision: 1,
      status: "pending",
    };
    let approvals = [first, second];
    const loadInbox = vi.fn(async () =>
      approvals.map((approval) => ({ kind: "approval" as const, id: approval.id, approval })),
    );
    const decideApproval = vi.fn(async (approval: typeof first) => {
      approvals = approvals.filter((candidate) => candidate.id !== approval.id);
      return { approvalId: approval.id, status: "approved", revision: approval.revision + 1 };
    });
    const fake = service({
      decideApproval: decideApproval as never,
      loadPendingApprovals: async () => [],
      loadGrowth: async () => ({ suggestions: [], memories: [], effects: [] }),
    });
    (fake as DesktopService & { loadInbox: typeof loadInbox }).loadInbox = loadInbox;
    render(<App service={fake} />);

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 2개" }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    await user.click(within(inbox).getByRole("button", { name: "첫 번째 승인 승인" }));

    await waitFor(() => {
      expect(within(inbox).queryByText("첫 번째 승인")).not.toBeInTheDocument();
      expect(within(inbox).getByText("두 번째 승인")).toBeInTheDocument();
    });
    expect(decideApproval).toHaveBeenCalledOnce();
    expect(loadInbox.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Approval quorum이 남으면 투표 기록을 알리고 최신 revision의 Inbox 카드를 유지한다", async () => {
    const user = userEvent.setup();
    let approval = {
      id: "approval-inbox-quorum",
      title: "복수 승인 필요",
      description: "추가 승인자를 기다립니다.",
      revision: 1,
      status: "pending",
    };
    const loadInbox = vi.fn(async () => [{ kind: "approval" as const, id: approval.id, approval }]);
    const decideApproval = vi.fn(async () => {
      approval = { ...approval, revision: 2 };
      return { approvalId: approval.id, status: "pending", revision: approval.revision };
    });
    const fake = service({
      decideApproval: decideApproval as never,
      loadPendingApprovals: async () => [],
      loadGrowth: async () => ({ suggestions: [], memories: [], effects: [] }),
    });
    (fake as DesktopService & { loadInbox: typeof loadInbox }).loadInbox = loadInbox;
    render(<App service={fake} />);

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 1개" }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    await user.click(within(inbox).getByRole("button", { name: "복수 승인 필요 승인" }));

    expect(await within(inbox).findByText("승인 투표가 기록되었습니다. 추가 의결을 기다립니다.")).toBeInTheDocument();
    expect(within(inbox).getByText("복수 승인 필요")).toBeInTheDocument();
    expect(loadInbox.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      "approve",
      expect.any(String),
    );
  });

  it("같은 차단 실행을 Home·Inbox·Work에서 같은 상태로 표시하고 폴더 신뢰는 Settings 해결 지점으로 이동한다", async () => {
    const user = userEvent.setup();
    const resumeRun = vi.fn(async () => undefined);
    render(<App service={service({ resumeRun })} />);

    await user.click(screen.getByRole("button", { name: "홈" }));
    const home = await screen.findByRole("main", { name: "홈" });
    const homeBlocked = within(home).getByRole("button", { name: /파트너 계약서 검토/u });
    expect(within(homeBlocked).getByText("차단됨")).toHaveClass("text-halt");

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const approvalSource = within(panel).getByRole("button", { name: "승인 검토 열기: CRM 고객 데이터 읽기" });
    const blockedSource = within(panel).getByRole("button", { name: "업무로 이동: 파트너 계약서 검토" });

    expect(approvalSource).toHaveTextContent("CRM 고객 데이터 읽기승인 대기");
    expect(within(blockedSource).getByText("차단됨")).toHaveClass("text-halt");
    expect(approvalSource.lastElementChild?.tagName).toBe("svg");
    expect(blockedSource.lastElementChild?.tagName).toBe("svg");
    expect(approvalSource.parentElement?.tagName).toBe("H3");
    expect(blockedSource.parentElement?.tagName).toBe("H3");
    expect(within(panel).queryByRole("button", { name: "CRM 고객 데이터 읽기 승인" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "CRM 고객 데이터 읽기 거절" })).not.toBeInTheDocument();
    expect(within(panel).queryByText("업무 열기")).not.toBeInTheDocument();

    await user.click(blockedSource);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const work = screen.getByRole("main", { name: "파트너 계약서 검토" });
    const workList = screen.getByRole("region", { name: "Work 목록" });
    const workRow = within(workList).getByRole("button", { name: /파트너 계약서 검토/u });
    const runStatus = within(work).getByRole("status", { name: "실행 상태" });
    expect(within(workRow).getByText("차단됨")).toHaveClass("text-halt");
    expect(within(runStatus).getByText("차단됨")).toHaveClass("text-halt");
    expect(runStatus).not.toHaveTextContent(/막힘|중단됨|에서 멈춤/u);
    await user.click(within(runStatus).getByRole("button", { name: "신뢰하기" }));
    const settings = await screen.findByRole("main", { name: "설정" });
    const workspaceTrust = within(settings).getByRole("region", { name: "워크스페이스 신뢰" });
    expect(workspaceTrust).toHaveFocus();
    expect(within(workspaceTrust).getByRole("button", { name: "ops-runbook 신뢰하기" })).toBeInTheDocument();
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("Assurance 거부 상세를 Inbox와 기존 실행 카드에 안전한 사용자 문구로 표시하고 재시도를 숨긴다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const detail = "산출물 <strong>모순</strong>을 보완해야 합니다.";
    const rejected: WorkView = {
      ...base,
      approvals: [],
      id: "work-assurance-rejected",
      title: "검증 보완 업무",
      run: {
        runId: "run-assurance-rejected",
        status: "blocked",
        stage: "assurance",
        leaseGeneration: 3,
        blockedReason: "assurance-verifier-rejected",
        blockedDetail: detail,
      },
    };
    const resumeRun = vi.fn(async () => undefined);
    render(
      <App
        service={service({
          initialSnapshot: { works: [rejected] },
          loadIndex: async () => [rejected],
          loadWork: async () => rejected,
          resumeRun,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/u }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    const source = within(inbox).getByRole("button", { name: "업무로 이동: 검증 보완 업무" });
    expect(source.closest("section")).toHaveTextContent(detail);
    expect(inbox).not.toHaveTextContent("assurance-verifier-rejected");
    expect(inbox).not.toHaveTextContent("run-assurance-rejected");

    await user.click(source);
    const main = screen.getByRole("main", { name: rejected.title });
    const status = within(main).getByRole("status", { name: "실행 상태" });
    expect(within(status).getByText("검증에서 보완 필요")).toBeInTheDocument();
    expect(status).toHaveTextContent(detail);
    expect(status).toHaveTextContent("산출물의 모순을 보완한 새 Work가 필요합니다.");
    expect(status.querySelector("strong, script")).toBeNull();
    expect(within(status).queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(status).not.toHaveTextContent("assurance-verifier-rejected");
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it.each([
    ["assurance-blocked", "검증을 완료하지 못해 결과를 확정하지 않았습니다. 다시 시도할 수 있습니다."],
    ["assurance-verifier-interrupted", "검증 실행이 중단되어 결과를 확정하지 않았습니다. 다시 시도할 수 있습니다."],
    ["assurance-stage-failed", "검증 단계를 완료하지 못해 결과를 확정하지 않았습니다. 다시 시도할 수 있습니다."],
  ])("Assurance %s는 안전 차단과 재시도 가능성을 구별해 보인다", async (blockedReason, reason) => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const blocked: WorkView = {
      ...base,
      approvals: [],
      id: `work-${blockedReason}`,
      title: "검증 재시도 업무",
      run: {
        runId: `run-${blockedReason}`,
        status: "blocked",
        stage: "assurance",
        leaseGeneration: 4,
        blockedReason,
      },
    };
    const resumeRun = vi.fn(async () => undefined);
    render(
      <App
        service={service({
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
          resumeRun,
        })}
      />,
    );

    const main = await screen.findByRole("main", { name: blocked.title });
    const status = within(main).getByRole("status", { name: "실행 상태" });
    expect(within(status).getByText("검증 안전 차단")).toBeInTheDocument();
    expect(status).toHaveTextContent(reason);
    expect(status).toHaveTextContent("검증");
    expect(status).not.toHaveTextContent(/assurance-|실행 단계에서 오류가 발생했습니다./u);
    await user.click(within(status).getByRole("button", { name: "다시 시도" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });

  it("승인 대기 실행은 Home·Inbox·Work에서 gate 상태로 일치한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const awaiting: WorkView = {
      ...base,
      run: { runId: "run-awaiting-status", status: "awaiting-approval", stage: "evidence", leaseGeneration: 1 },
    };
    const ready: WorkView = {
      ...base,
      approvals: [],
      id: "work-ready-status",
      title: "준비된 업무",
      run: { runId: "run-ready-status", status: "ready", stage: "intake", leaseGeneration: 1 },
    };
    const running: WorkView = {
      ...base,
      approvals: [],
      id: "work-running-status",
      title: "실행 중인 업무",
      run: { runId: "run-running-status", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const excluded = (["blocked", "cancelled", "completed", "failed"] as const).map((status): WorkView => ({
      ...base,
      approvals: [],
      id: `work-${status}-status`,
      title: `${status} 실행 업무`,
      run: { runId: `run-${status}-status`, status, stage: "delivery", leaseGeneration: 1 },
    }));
    // base가 실행을 갖든 말든 이 Work에는 실행이 없어야 합니다. spread에 기대면 fixture가
    // 바뀌는 순간 «실행 없는 업무»가 조용히 실행을 갖습니다.
    const withoutRun: WorkView = { ...base, approvals: [], id: "work-without-run", title: "실행 없는 업무" };
    delete withoutRun.run;
    const works = [awaiting, ready, running, withoutRun, ...excluded];
    render(
      <App
        service={service({
          initialSnapshot: { works },
          loadIndex: async () => works,
          loadWork: async () => awaiting,
        })}
      />,
    );

    const workList = screen.getByRole("region", { name: "Work 목록" });
    expect(within(workList).getByText("승인 대기")).toHaveClass("text-gate");

    await user.click(screen.getByRole("button", { name: "홈" }));
    const home = await screen.findByRole("main", { name: "홈" });
    const waiting = within(home).getByRole("region", { name: "나를 기다리는 것" });
    const active = within(home).getByRole("region", { name: "지금 도는 것" });
    expect(within(waiting).getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
    expect(within(waiting).getByText("승인 대기")).toHaveClass("text-gate");
    expect(within(active).getByRole("button", { name: /준비된 업무/u })).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: /실행 중인 업무/u })).toBeInTheDocument();
    for (const title of [awaiting.title, withoutRun.title, ...excluded.map((work) => work.title)]) {
      expect(within(active).queryByRole("button", { name: new RegExp(title, "u") })).not.toBeInTheDocument();
    }

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/u }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const approvalSource = within(panel).getByRole("button", { name: "승인 검토 열기: CRM 고객 데이터 읽기" });
    expect(within(approvalSource).getByText("승인 대기")).toHaveClass("text-gate");

    await user.click(approvalSource);
    const work = screen.getByRole("main", { name: awaiting.title });
    const runStatus = within(work).getByRole("status", { name: "실행 상태" });
    expect(within(runStatus).getByText("승인 대기")).toHaveClass("text-gate");
    expect(within(runStatus).queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });

  it("빈 Inbox는 차단 상태의 정본 용어를 사용한다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const growth = await fixture.loadGrowth();
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [] },
          loadGrowth: async () => ({ ...growth, suggestions: [] }),
          loadInbox: async () => [],
          loadIndex: async () => [],
          loadPendingApprovals: async () => [],
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "수신함" }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(inbox).getByText("지금 사람을 기다리거나 차단된 것이 없습니다.")).toBeInTheDocument();
    expect(within(inbox).queryByText(/막힌 것이/u)).not.toBeInTheDocument();
  });

  it("취소와 실패 상태는 Work 목록과 상세에서 정본 용어와 색을 유지한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const cancelled: WorkView = { ...base, id: "work-cancelled", title: "취소한 업무", status: "cancelled" };
    const failed: WorkView = { ...base, id: "work-failed", title: "실패한 업무", status: "failed" };
    render(
      <App
        service={service({
          initialSnapshot: { works: [cancelled, failed] },
          loadIndex: async () => [cancelled, failed],
          loadWork: async (workId) => (workId === failed.id ? failed : cancelled),
        })}
      />,
    );

    const list = screen.getByRole("region", { name: "Work 목록" });
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    const cancelledRow = await within(list).findByRole("button", { name: /취소한 업무/u });
    expect(within(cancelledRow).getByText("취소됨")).toHaveClass("text-muted");
    expect(screen.getByRole("heading", { name: cancelled.title }).nextElementSibling).toHaveClass("text-muted");

    const failedRow = within(list).getByRole("button", { name: /실패한 업무/u });
    expect(within(failedRow).getByText("실패")).toHaveClass("text-danger");
    await user.click(failedRow);
    expect(await screen.findByRole("main", { name: failed.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: failed.title }).nextElementSibling).toHaveClass("text-danger");
  });

  it("수신함은 검토 대기 개선을 집계하고 해당 개선 상세로 이동한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 4개" }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const improvement = within(panel).getByRole("button", {
      name: "개선 검토 열기: 분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다.",
    });
    expect(improvement).toHaveTextContent("검토 대기");

    await user.click(improvement);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const growth = await screen.findByRole("main", { name: "개선" });
    expect(
      within(growth).getByRole("heading", { name: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다." }),
    ).toBeInTheDocument();
    expect(
      within(growth).getByRole("button", { name: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다. 승인" }),
    ).toBeEnabled();
  });

  it("수신함의 51번째 개선은 첫 목록 항목으로 fallback하지 않고 exact 상세를 연다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const initial = await fixture.loadGrowth();
    const template = initial.suggestions[0];
    if (!template) throw new Error("Growth suggestion fixture가 없습니다");
    const firstSuggestion = {
      ...template,
      suggestionId: "suggestion-recent-0000",
      summary: "1번째 최근 개선",
    };
    const firstFifty = [
      firstSuggestion,
      ...Array.from({ length: 49 }, (_, index) => ({
        ...template,
        suggestionId: `suggestion-recent-${String(index + 1).padStart(4, "0")}`,
        summary: `${String(index + 2)}번째 최근 개선`,
      })),
    ];
    const target = {
      ...template,
      suggestionId: "suggestion-exact-0051",
      workId: "work-exact-0051",
      summary: "51번째 정확한 개선",
      rationale: "최근 목록 밖 대상입니다",
      status: "awaiting-review" as const,
    };
    const loadGrowthSuggestion = vi.fn(async (suggestionId: string) => {
      if (suggestionId !== target.suggestionId) throw new Error("다른 개선을 조회했습니다");
      return target;
    });
    render(
      <App
        service={service({
          loadGrowth: async () => ({ ...initial, suggestions: firstFifty }),
          loadGrowthSuggestion,
          loadInbox: async () => [
            {
              kind: "growth",
              id: `growth:${target.suggestionId}`,
              suggestionId: target.suggestionId,
              workId: target.workId,
              title: target.summary,
              reason: target.rationale,
            },
          ],
        } as Partial<DesktopService>)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 1개" }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    await user.click(within(inbox).getByRole("button", { name: `개선 검토 열기: ${target.summary}` }));

    const growth = await screen.findByRole("main", { name: "개선" });
    expect(await within(growth).findByRole("heading", { name: target.summary })).toBeInTheDocument();
    expect(within(growth).queryByRole("heading", { name: firstSuggestion.summary })).not.toBeInTheDocument();
    expect(loadGrowthSuggestion).toHaveBeenCalledWith(target.suggestionId);
  });

  it("권한은 설정에서 실제 서비스 조회를 사용한다", async () => {
    const user = userEvent.setup();
    const loadPendingApprovals = vi.fn(createFixtureDesktopService().loadPendingApprovals);
    const loadAutonomy = vi.fn(createFixtureDesktopService().loadAutonomy);
    render(<App service={service({ loadPendingApprovals, loadAutonomy })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByRole("region", { name: "권한과 자가개선" })).toBeInTheDocument();
    await waitFor(() => {
      expect(loadPendingApprovals).toHaveBeenCalledOnce();
      expect(loadAutonomy).toHaveBeenCalledOnce();
    });
  });

  it("Settings의 자가개선 반영 방식은 실제 Growth 설정으로 저장한다", async () => {
    const user = userEvent.setup();
    const loadAutonomy = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "review",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 3,
      })
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "auto",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 4,
      });
    const configureGrowth = vi.fn(async () => undefined);
    render(<App service={service({ loadAutonomy, configureGrowth })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const settings = await screen.findByRole("region", { name: "권한과 자가개선" });
    const growth = within(settings).getByRole("region", { name: "자가개선" });
    expect(within(growth).getByRole("button", { name: "수동" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(growth).getByRole("button", { name: "자동" }));

    await waitFor(() =>
      expect(configureGrowth).toHaveBeenCalledWith({
        reflectionEnabled: true,
        adoptionMode: "auto",
        expectedVersion: 3,
      }),
    );
    await waitFor(() => expect(loadAutonomy).toHaveBeenCalledTimes(2));
    expect(within(growth).getByRole("button", { name: "자동" })).toHaveAttribute("aria-pressed", "true");
  });

  it("자가개선 저장 후 재조회 실패는 저장 성공과 조회 실패를 구분한다", async () => {
    const user = userEvent.setup();
    const loadAutonomy = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "review",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 3,
      })
      .mockRejectedValueOnce(new Error("최신 설정 조회 실패"));
    render(<App service={service({ loadAutonomy, configureGrowth: vi.fn(async () => undefined) })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const growth = within(await screen.findByRole("region", { name: "권한과 자가개선" })).getByRole("region", {
      name: "자가개선",
    });
    await user.click(within(growth).getByRole("button", { name: "자동" }));

    expect(await within(growth).findByRole("alert")).toHaveTextContent(
      "자가개선 설정은 저장됐지만 최신 상태를 불러오지 못했습니다. 최신 설정 조회 실패",
    );
  });

  it("Settings의 전체 권한은 확인 뒤 실제 지속 권한 명령으로 저장한다", async () => {
    const user = userEvent.setup();
    const setAutonomy = vi.fn(createFixtureDesktopService().setAutonomy);
    render(<App service={service({ setAutonomy })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const settings = await screen.findByRole("region", { name: "권한과 자가개선" });
    expect(within(settings).queryByText("바이패스")).not.toBeInTheDocument();
    await user.click(within(settings).getByRole("button", { name: "전체 권한" }));
    await user.click(within(settings).getByRole("button", { name: "승인" }));

    await waitFor(() => expect(setAutonomy).toHaveBeenCalledWith("full-access", 0));
    expect(screen.getByText("권한을 저장했습니다.")).toBeInTheDocument();
  });

  it("설정은 작업공간의 신뢰 상태와 개정을 표시하고 신뢰 명령의 실제 반환 행만 갱신한다", async () => {
    const user = userEvent.setup();
    const pending = workspaceFixture("workspace-pending", "검토 폴더", "/tmp/pending", "pending", 1);
    const blocked = workspaceFixture("workspace-blocked", "차단 폴더", "/tmp/blocked", "blocked", 2);
    const trusted = workspaceFixture("workspace-trusted", "신뢰 폴더", "/tmp/trusted", "trusted", 3);
    const response = deferred<DesktopWorkspaceView>();
    const loadWorkspaces = vi.fn(async () => [pending, blocked, trusted]);
    const decideWorkspaceTrust = vi.fn(async () => await response.promise);
    render(<App service={service({ loadWorkspaces, decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "워크스페이스 신뢰" });
    for (const title of ["권한", "자가개선", "워크스페이스 신뢰"]) {
      expect(screen.getByRole("heading", { name: title, level: 2 })).toBeInTheDocument();
    }
    const pendingRow = within(section).getByRole("row", { name: /검토 폴더/u });
    expect(pendingRow).toHaveTextContent("/tmp/pending");
    expect(pendingRow).toHaveTextContent("확인 전");
    expect(pendingRow).toHaveTextContent("개정 1");
    expect(within(section).getByRole("row", { name: /차단 폴더/u })).toHaveTextContent("차단됨");
    expect(within(section).getByRole("row", { name: /신뢰 폴더/u })).toHaveTextContent("신뢰함");

    const trustButton = within(pendingRow).getByRole("button", { name: "검토 폴더 신뢰하기" });
    await user.click(trustButton);
    await user.click(trustButton);
    expect(decideWorkspaceTrust).toHaveBeenCalledOnce();
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(pending, "trusted");
    expect(trustButton).toBeDisabled();

    response.resolve({ ...pending, name: "서버가 돌려준 폴더", trust: "trusted", revision: 9 });
    const updatedRow = await within(section).findByRole("row", { name: /서버가 돌려준 폴더/u });
    expect(updatedRow).toHaveTextContent("신뢰함");
    expect(updatedRow).toHaveTextContent("개정 9");
    expect(within(section).getByRole("row", { name: /차단 폴더/u })).toHaveTextContent("개정 2");
    expect(loadWorkspaces).toHaveBeenCalledOnce();
  });

  it("신뢰된 작업공간은 확인 뒤에만 회수하고 revision 오류를 해당 설정 구역에 표시한다", async () => {
    const user = userEvent.setup();
    const trusted = workspaceFixture("workspace-trusted", "신뢰 폴더", "/tmp/trusted", "trusted", 3);
    const decideWorkspaceTrust = vi.fn(async () => {
      throw new Error("workspace revision이 일치하지 않습니다");
    });
    render(<App service={service({ loadWorkspaces: async () => [trusted], decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "워크스페이스 신뢰" });
    await user.click(within(section).getByRole("button", { name: "신뢰 폴더 신뢰 해제" }));
    expect(decideWorkspaceTrust).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alertdialog", { name: "신뢰를 해제할까요?" });
    expect(confirmation).toHaveTextContent("/tmp/trusted");
    await user.click(within(confirmation).getByRole("button", { name: "신뢰 폴더 신뢰 해제" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent("workspace revision이 일치하지 않습니다");
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(trusted, "blocked");
    const unchangedRow = within(section).getByRole("row", { name: /신뢰 폴더/u });
    expect(unchangedRow).toHaveTextContent("신뢰함");
    expect(unchangedRow).toHaveTextContent("개정 3");
  });

  it("신뢰 명령의 늦은 다른 작업공간 응답은 어느 행에도 주입하지 않는다", async () => {
    const user = userEvent.setup();
    const current = workspaceFixture("workspace-current", "현재 폴더", "/tmp/current", "pending", 4);
    const foreign = workspaceFixture("workspace-foreign", "다른 폴더", "/tmp/foreign", "trusted", 99);
    const decideWorkspaceTrust = vi.fn(async () => foreign);
    render(<App service={service({ loadWorkspaces: async () => [current], decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "워크스페이스 신뢰" });
    await user.click(within(section).getByRole("button", { name: "현재 폴더 신뢰하기" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent(
      "워크스페이스 신뢰 응답의 식별자가 요청과 일치하지 않습니다.",
    );
    const unchangedRow = within(section).getByRole("row", { name: /현재 폴더/u });
    expect(unchangedRow).toHaveTextContent("확인 전");
    expect(unchangedRow).toHaveTextContent("개정 4");
    expect(within(section).queryByText("다른 폴더")).not.toBeInTheDocument();
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(current, "trusted");
  });

  it("권한 조회 실패가 작업공간 신뢰 목록을 가리지 않는다", async () => {
    const user = userEvent.setup();
    const pending = workspaceFixture("workspace-pending", "검토 폴더", "/tmp/pending", "pending", 1);
    render(
      <App
        service={service({
          loadAutonomy: async () => {
            throw new Error("권한 조회 실패");
          },
          loadWorkspaces: async () => [pending],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "워크스페이스 신뢰" });
    expect(within(section).getByRole("row", { name: /검토 폴더/u })).toBeInTheDocument();
    expect(screen.getByText("권한 조회 실패")).toBeInTheDocument();
  });

  it("작업공간 목록 조회 실패가 권한 설정을 가리지 않는다", async () => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadWorkspaces: async () => {
            throw new Error("작업공간 목록 조회 실패");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "설정" }));
    const permissions = await screen.findByRole("region", { name: "권한" });
    expect(within(permissions).getByRole("button", { name: "전체 권한" })).toBeInTheDocument();
    const workspaces = screen.getByRole("region", { name: "워크스페이스 신뢰" });
    expect(within(workspaces).getByRole("alert")).toHaveTextContent("작업공간 목록 조회 실패");
  });

  it("성장 화면은 개인 기억과 승인 근거를 함께 표시한다", async () => {
    const user = userEvent.setup();
    const loadGrowth = vi.fn(async () => ({
      configuration: {
        reflectionEnabled: true,
        adoptionMode: "review" as const,
        governanceDecisionId: "decision-growth-0001",
        activatedAt: "2026-07-22T00:00:00.000Z",
      },
      memories: [
        {
          memoryVersionId: "memory-0001",
          revision: 3,
          entries: [
            {
              key: "verification-required",
              kind: "procedure" as const,
              value: "검증 근거를 남긴다",
              authority: "explicit" as const,
            },
          ],
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-0001",
          workId: "work-0001",
          targetKind: "memory",
          operation: "add-entry",
          summary: "검증 근거 보강",
          rationale: "기록된 검증 누락을 줄이기 위해",
          expectedEffect: "검증 계보 보강",
          riskSummary: "검토 필요",
          status: "awaiting-review",
        },
      ],
      effects: [{ effectEvaluationId: "effect-0001", adoptionId: "adoption-0001", result: "improved" }],
    }));
    render(<App service={service({ loadGrowth } as Partial<DesktopService>)} />);

    await user.click(screen.getByRole("button", { name: "개선" }));

    // 마스터-디테일이므로 요약은 목록과 본문 양쪽에 있습니다.
    expect(await screen.findAllByText("검증 근거 보강")).toHaveLength(2);
    expect(screen.getByText(/decision-growth-0001/)).toBeInTheDocument();
    expect(screen.getByText("검증 근거를 남긴다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "앞으로 사용하지 않음" })).toBeInTheDocument();
    // 판단에 필요한 증거가 순서대로 있어야 합니다. 요약만 보고 채택하면 승인 버튼 하나와 같습니다.
    expect(screen.getByRole("region", { name: "왜" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "승인하면" })).toBeInTheDocument();
    // 어떤 작업에서 올라온 제안인지 추적할 수 있어야 합니다.
    expect(screen.getByRole("region", { name: "어디서 나왔나" })).toBeInTheDocument();
    expect(screen.getByText("개선 확인")).toBeInTheDocument();
    expect(loadGrowth).toHaveBeenCalledOnce();

    // 채택 command가 아직 없으므로 제안 판단은 여전히 실행하지 않습니다.
    // 문구가 아니라 disabled로 검사해야 나중에 버튼 라벨이 바뀌어도 규칙이 지켜집니다.
    expect(screen.getByRole("button", { name: "검증 근거 보강 승인" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "검증 근거 보강 거절" })).toBeDisabled();
  });

  // 헌법 4.8의 «보수적 채택»은 채택 전후 효과 비교와 악화 시 되돌리기로만 증명됩니다.
  // 검토 대기만 보이면 그 근거가 화면에 없는 것과 같으므로 네 상태를 함께 고정합니다.
  it("개선은 검토 대기·채택·되돌림·거부를 한 화면에서 구분한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(screen.getByRole("button", { name: "개선" }));
    const growth = await screen.findByRole("main", { name: "개선" });
    const list = within(growth).getByRole("region", { name: "개선 제안 목록" });

    await user.click(within(list).getByRole("tab", { name: /전체/u }));
    for (const label of ["승인 대기", "반영됨", "되돌림", "거부됨"]) {
      expect(within(list).getAllByText(label).length).toBeGreaterThan(0);
    }

    // 자동 채택 + 개선 확인. 무엇을 어떻게 쟀는지가 표본 수와 함께 보여야 합니다.
    await user.click(within(list).getByText("인계할 때 해소하지 못한 질문을 함께 넘깁니다."));
    expect(within(growth).getByRole("region", { name: "채택" })).toHaveTextContent("자동");
    // 라벨과 값이 별도 칸이라 붙어 읽힙니다. 값이 맞는지만 봅니다.
    expect(within(growth).getByRole("region", { name: "적용 후 측정" })).toHaveTextContent(/표본\s*14 \/ 최소 10/u);
    // 좋아졌는지 나빠졌는지를 문장이 아니라 부호가 말해야 합니다.
    expect(within(growth).getByRole("region", { name: "적용 후 측정" })).toHaveTextContent("▲0.17");
    expect(within(growth).getByText("개선 확인")).toBeInTheDocument();

    // 사람 채택 + 저하 관찰 → 되돌림. 되돌린 시각이 채택 계보와 같은 자리에 있어야 합니다.
    await user.click(within(list).getByText("수치 결론에는 독립 검증을 두 번 거칩니다."));
    const adoption = within(growth).getByRole("region", { name: "채택" });
    expect(adoption).toHaveTextContent("사람");
    expect(adoption).toHaveTextContent("approval-growth-0018");
    // 화살표가 별도 칸이라 붙어 읽힙니다. 되돌렸으면 지금 사는 것이 이전 버전임도 함께 말해야 합니다.
    expect(adoption).toHaveTextContent(/policy-assurance-v3\s*→\s*policy-assurance-v4/u);
    expect(adoption).toHaveTextContent("현재 이전 버전");
    expect(adoption).toHaveTextContent("효과 저하");
    expect(within(growth).getByText("저하 관찰")).toBeInTheDocument();

    // 사람이 거부한 것은 사유가 남아야 합니다. 도메인이 거절에 결정 계보를 강제합니다.
    await user.click(within(list).getByText("모든 보고를 5줄 이내로 고정합니다."));
    expect(within(growth).getByRole("region", { name: "거부" })).toHaveTextContent(
      "규제 검토 보고는 근거를 줄이면 다시 물어야 해서 길이를 고정하지 않는다",
    );
    expect(within(growth).queryByRole("region", { name: "채택" })).not.toBeInTheDocument();
  });

  it("성장 기록이 없으면 검증된 실행 기록을 기다리는 빈 상태를 표시한다", async () => {
    const user = userEvent.setup();
    const loadGrowth = vi.fn(async () => ({ memories: [], suggestions: [], effects: [] }));
    render(<App service={service({ loadGrowth })} />);

    await user.click(screen.getByRole("button", { name: "개선" }));

    expect(await screen.findByText("조직이 아직 바꾸자고 제안한 것이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("직접 저장한 기억이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("늦게 끝난 이전 Work 조회가 최신 선택을 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const second = snapshot.works[1];
    const third = snapshot.works[2];
    if (!second || !third) throw new Error("Work fixture가 부족합니다");
    const secondRequest = deferred<WorkView>();
    const thirdRequest = deferred<WorkView>();
    const fake = service({
      loadWork: (workId) => {
        if (workId === second.id) return secondRequest.promise;
        if (workId === third.id) return thirdRequest.promise;
        return Promise.resolve(snapshot.works[0] as WorkView);
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    await user.click(screen.getByRole("button", { name: /주간 운영 보고서/ }));
    thirdRequest.resolve(third);
    expect(await screen.findByRole("main", { name: third.title })).toBeInTheDocument();
    secondRequest.resolve(second);
    await Promise.resolve();
    expect(screen.getByRole("main", { name: third.title })).toBeInTheDocument();
  });

  it("구독 등록이 unmount 뒤 끝나도 stop을 실행한다", async () => {
    const pending = deferred<() => Promise<void>>();
    const stop = vi.fn(async () => undefined);
    const fake = service({ subscribeDurable: async () => await pending.promise });
    const view = render(<App service={fake} />);

    view.unmount();
    pending.resolve(stop);

    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("등록된 stream 정리 실패를 unhandled rejection으로 남기지 않는다", async () => {
    const subscribed = deferred<undefined>();
    const stop = vi.fn(async () => {
      throw new Error("이미 종료된 stream입니다");
    });
    const fake = service({
      subscribeDurable: async () => {
        subscribed.resolve(undefined);
        return stop;
      },
    });
    const view = render(<App service={fake} />);
    await subscribed.promise;

    view.unmount();

    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("지시 제출 실패 시 입력을 보존하고 중복 제출을 막는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const first = snapshot.works[0];
    if (!first) throw new Error("Work fixture가 없습니다");
    const active = {
      ...first,
      revision: 4,
      queuedDirectives: [],
      run: { runId: "run-fixture-1", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const submitDirective = vi.fn(async () => {
      throw new Error("지시를 저장하지 못했습니다");
    });
    const fake = service({
      initialSnapshot: { works: [active] },
      loadIndex: async () => [active],
      loadWork: async () => active,
      submitDirective,
    });
    render(<App service={fake} />);

    const input = screen.getByRole("textbox", { name: "추가 지시" });
    await user.type(input, "산업군별 이탈률도 분리해줘");
    await user.click(screen.getByRole("button", { name: "보내기" }));

    expect(await screen.findByText("지시를 저장하지 못했습니다")).toBeInTheDocument();
    expect(input).toHaveValue("산업군별 이탈률도 분리해줘");
    expect(screen.queryByText("산업군별 이탈률도 분리해줘", { selector: "span" })).not.toBeInTheDocument();
    expect(submitDirective).toHaveBeenCalledOnce();
  });

  it("대기 지시는 영속 편집·취소 명령을 쓰고 실행 중 파일·멘션은 지원 전 상태로 둔다", async () => {
    const user = userEvent.setup();
    const updateDirective = vi.fn(async () => undefined);
    const cancelDirective = vi.fn(async () => undefined);
    render(<App service={service({ updateDirective, cancelDirective })} />);

    const composer = screen.getByTestId("directive-composer");
    await user.click(within(composer).getByRole("button", { name: "현재 작업 조정" }));
    expect(updateDirective).toHaveBeenCalledWith(
      expect.objectContaining({ id: "churn-q3" }),
      expect.objectContaining({ id: "queued-cohort", revision: 1 }),
      "코호트를 계약 규모별로도 나눠줘",
      "now",
    );
    await user.click(within(composer).getByRole("button", { name: "대기 지시 삭제" }));
    expect(cancelDirective).toHaveBeenCalledWith(
      expect.objectContaining({ id: "churn-q3" }),
      expect.objectContaining({ id: "queued-cohort", revision: 1 }),
    );

    const attachment = within(composer).getByRole("button", { name: "파일 첨부" });
    const mention = within(composer).getByRole("button", { name: "에이전트 멘션" });
    expect(attachment).toBeDisabled();
    expect(mention).toBeDisabled();
    expect(within(composer).getByText("실행 중 파일 첨부·에이전트 멘션은 아직 지원하지 않습니다.")).toBeInTheDocument();
  });

  it("아직 적용되지 않은 fixture 조직 제안은 결정 명령 없이 성공을 알리지 않는다", async () => {
    render(<App service={service()} />);

    const proposal = await screen.findByRole("region", { name: /\uc870\uc9c1 \ubcc0\uacbd \uc81c\uc548/u });
    expect(within(proposal).queryByRole("button", { name: /신설 승인$/u })).not.toBeInTheDocument();
    expect(within(proposal).queryByRole("button", { name: /신설 거절$/u })).not.toBeInTheDocument();
    expect(within(proposal).getByText("이 화면에서는 조직 변경을 결정할 수 없습니다.")).toBeInTheDocument();
    expect(
      screen.queryByText(/신설을 승인했습니다|\uc2e0\uc124을 \uac70\uc808\ud588\uc2b5\ub2c8\ub2e4/u),
    ).not.toBeInTheDocument();
  });

  it("Work 근거에서 실제 evidence 관계의 대상·종류·경로·줄·ID·checksum을 탐색한다", async () => {
    const user = userEvent.setup();
    const knowledge = {
      workId: "churn-q3",
      workspaceId: "workspace-analytics",
      status: "ready" as const,
      indexVersionId: "index-knowledge",
      freshnessStatus: "fresh" as const,
      references: [
        {
          referenceId: "symbol-order-total",
          kind: "symbol" as const,
          relativePath: "src/order.ts",
          qualifiedName: "calculateTotal",
          startLine: 3,
          endLine: 6,
          contentHash: "a".repeat(64),
          nodeId: "symbol:symbol-order-total",
          relations: [
            {
              node: {
                nodeId: "symbol:symbol-tax-rate",
                kind: "symbol" as const,
                label: "resolveTaxRate",
                detail: "src/tax.ts:8",
              },
              kind: "calls" as const,
              direction: "outgoing" as const,
              relationId: "relation-order-tax",
              snapshotChecksum: "b".repeat(64),
              sourcePath: "src/order.ts",
              sourceLine: 5,
            },
          ],
        },
      ],
    };
    render(<App service={service({ loadWorkKnowledge: async () => knowledge as never })} />);

    const inspector = screen.getByRole("complementary", { name: "Work 세부 정보" });
    await user.click(within(inspector).getByRole("tab", { name: "근거" }));
    await user.click(await within(inspector).findByRole("button", { name: "src/order.ts 연결된 지식 보기" }));

    expect(within(inspector).getByText("resolveTaxRate")).toBeInTheDocument();
    expect(within(inspector).getByText("이 심볼이 부르는 대상")).toBeInTheDocument();
    expect(within(inspector).getByText("src/order.ts:5")).toBeInTheDocument();
    expect(within(inspector).getByText("relation-order-tax")).toBeInTheDocument();
    expect(within(inspector).getByText(`snapshot ${"b".repeat(64)}`)).toBeInTheDocument();
  });

  it("새 Work 실행을 임시 행으로 표시하고 재조회된 Work를 자동 선택한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-0001",
      title: "파트너 계약 위험 검토",
      run: { runId: "run-created-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    const startWork = vi.fn(async () => ({ runId: "run-created-0001" }));
    const workspace = {
      workspaceId: "workspace-0001",
      name: "계약 폴더",
      path: "/tmp/contracts",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const fake = service({
      startWork,
      loadWorkspaces: async () => [workspace],
      loadIndex: async () => (createdVisible ? [...snapshot.works, created] : snapshot.works),
      loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/contracts/src/contract.ts"]),
    };
    render(<App contextPicker={contextPicker} service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "파트너 계약 위험을 검토해줘");
    await user.click(await within(dialog).findByRole("button", { name: /계약 폴더/ }));
    const attachmentStatus = within(dialog).getByRole("status", { name: "파일 첨부 상태" });
    expect(attachmentStatus).toBeEmptyDOMElement();
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    expect(attachmentStatus).toHaveTextContent("파일을 첨부했습니다: src/contract.ts");
    await user.click(within(dialog).getByRole("button", { name: "실행 시작" }));

    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();
    expect(startWork).toHaveBeenCalledWith({
      outputLocale: "ko",
      text: "파트너 계약 위험을 검토해줘",
      workspaceId: "workspace-0001",
      workspacePaths: ["src/contract.ts"],
    });

    createdVisible = true;
    durable?.({ sequence: 12, type: "work.created", resource: { type: "Work", id: created.id } });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
  });

  it("완료 목록에서 생성한 Work를 진행 중 목록으로 전환해 선택하고 실행 식별자를 숨긴다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const active = snapshot.works.find((candidate) => candidate.status === "active") as WorkView;
    const completed = snapshot.works.find((candidate) => candidate.status === "complete") as WorkView;
    const created: WorkView = {
      ...active,
      id: "work-created-from-complete-0001",
      title: "완료 목록에서 시작한 새 Work",
      run: {
        runId: "26cd20b6-c6f9-40cd-9c36-82bd22f7f529",
        status: "running",
        stage: "delivery",
        leaseGeneration: 1,
      },
    };
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId: created.run?.runId ?? "" }),
          loadIndex: async ({ filter }) =>
            filter === "complete" ? [completed] : createdVisible ? [created, active] : [active],
          loadWork: async (workId) => {
            if (workId === created.id) return created;
            if (workId === completed.id) return completed;
            return active;
          },
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "완료" }));
    expect(await screen.findByRole("main", { name: completed.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "새 완료 보고서를 만들어줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    expect(screen.getByRole("tab", { name: "진행 중" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(created.run?.runId);

    createdVisible = true;
    durable?.({ sequence: 61, type: "work.created", resource: { type: "Work", id: created.id } });

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("생성 대기 중인 실행의 종료 이벤트를 받으면 임시 행을 제거한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const runId = "26cd20b6-c6f9-40cd-9c36-82bd22f7f529";
    let durable: ((event: unknown) => void) | undefined;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId }),
          loadIndex: async () => [active],
          loadWork: async () => active,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "종료 경계를 확인해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    durable?.({
      sequence: 62,
      type: "run.completed",
      payload: { workId: "work-terminal-before-created-0001", stage: "terminal" },
      resource: { type: "ApplicationRun", id: runId },
    });

    await waitFor(() => expect(screen.queryByText("Work 생성 중")).not.toBeInTheDocument());
  });

  it.each([
    ["run.blocked", "blocked", "active", "차단된 새 Work", "새 Work가 차단되었습니다."],
    ["run.suspended", "awaiting-approval", "active", "승인을 기다리는 새 Work", "새 Work가 승인을 기다리고 있습니다."],
    ["run.failed", "failed", "failed", "실패한 새 Work", "새 Work 실행에 실패했습니다."],
    ["run.cancelled", "cancelled", "cancelled", "취소된 새 Work", "새 Work 실행이 취소되었습니다."],
  ] as const)(
    "%s가 생성 Work를 연결해 선택하고 사람이 이해할 안내를 표시한다",
    async (eventType, runStatus, workStatus, title, notice) => {
      const user = userEvent.setup();
      const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
      delete active.run;
      const runId = `run-created-${runStatus}`;
      const created: WorkView = {
        ...active,
        id: `work-created-${runStatus}`,
        title,
        status: workStatus,
        run: { runId, status: runStatus, stage: "delivery", leaseGeneration: 2 },
      };
      const loadIndex = vi.fn(async ({ filter }: { filter: "active" | "complete" }) =>
        filter === "active" ? [active] : [],
      );
      let durable: ((event: unknown) => void) | undefined;
      render(
        <App
          service={service({
            initialSnapshot: { works: [active] },
            startWork: async () => ({ runId }),
            loadIndex,
            loadWork: async (workId) => (workId === created.id ? created : active),
            subscribeDurable: async (handler) => {
              durable = handler;
              return async () => undefined;
            },
          })}
        />,
      );

      await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
      await user.type(screen.getByRole("textbox", { name: "업무 요청" }), `${title} 경계를 확인해줘`);
      await user.click(screen.getByRole("button", { name: "실행 시작" }));
      expect(await screen.findByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();

      durable?.({
        sequence: 63,
        type: eventType,
        payload: { workId: created.id },
        resource: { type: "ApplicationRun", id: runId },
      });

      expect(await screen.findByRole("main", { name: title }, { timeout: 2_000 })).toBeInTheDocument();
      expect(screen.getByText(notice)).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: workStatus === "active" ? "진행 중" : "완료" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      if (workStatus !== "active") {
        await waitFor(() => expect(loadIndex).toHaveBeenCalledWith(expect.objectContaining({ filter: "complete" })));
        expect(
          within(screen.getByRole("region", { name: "Work 목록" })).getByRole("button", {
            name: new RegExp(title, "u"),
          }),
        ).toBeInTheDocument();
      }
    },
  );

  it.each([
    ["run.blocked", "새 Work가 차단되었습니다."],
    ["run.failed", "새 Work 실행에 실패했습니다."],
    ["run.cancelled", "새 Work 실행이 취소되었습니다."],
  ] as const)("%s에 Work 연결 정보가 없어도 생성 대기를 해소한다", async (eventType, notice) => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const runId = `run-without-work-${eventType}`;
    let durable: ((event: unknown) => void) | undefined;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId }),
          loadIndex: async () => [active],
          loadWork: async () => active,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), `${eventType} 종료를 확인해줘`);
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();

    durable?.({ sequence: 67, type: eventType, resource: { type: "ApplicationRun", id: runId } });

    await waitFor(() => expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument());
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(screen.getByRole("main", { name: active.title })).toBeInTheDocument();
  });

  it("생성 응답 직후 목록에 실행 계보가 나타나면 durable 이벤트 없이 즉시 선택한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const created: WorkView = {
      ...active,
      id: "work-created-in-start-reload",
      title: "응답 직후 나타난 새 Work",
      run: { runId: "run-created-in-start-reload", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    let started = false;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => {
            started = true;
            return { runId: created.run?.runId ?? "" };
          },
          loadIndex: async () => (started ? [created, active] : [active]),
          loadWork: async (workId) => (workId === created.id ? created : active),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "응답 직후 Work를 연결해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    expect(await screen.findByRole("main", { name: created.title })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("생성 대기 중 재연결한 초기 목록의 실행 계보로 새 Work를 즉시 선택한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const created: WorkView = {
      ...active,
      id: "work-created-on-reconnect",
      title: "재연결에서 찾은 새 Work",
      run: { runId: "run-created-on-reconnect", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    const first = service({
      initialSnapshot: { works: [active] },
      startWork: async () => ({ runId: created.run?.runId ?? "" }),
      loadIndex: async () => [active],
      loadWork: async () => active,
    });
    const view = render(<App service={first} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "재연결 목록에서 Work를 찾아줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();

    view.rerender(
      <App
        service={service({
          initialSnapshot: { works: [created, active] },
          loadIndex: async () => [created, active],
          loadWork: async (workId) => (workId === created.id ? created : active),
        })}
      />,
    );

    expect(await screen.findByRole("main", { name: created.title })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("work.created가 생성 응답보다 빨라도 응답 직후 새 Work를 선택한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const created: WorkView = {
      ...active,
      id: "work-created-before-start-response",
      title: "응답보다 먼저 생긴 새 Work",
      run: { runId: "run-created-before-start-response", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    const started = deferred<{ runId: string }>();
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    let eventBatchApplied = false;
    const startWork = vi.fn(async () => await started.promise);
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork,
          loadIndex: async () => {
            if (createdVisible) eventBatchApplied = true;
            return createdVisible ? [created, active] : [active];
          },
          loadWork: async (workId) => (workId === created.id ? created : active),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "빠른 생성 이벤트를 연결해줘");
    const submitting = user.click(screen.getByRole("button", { name: "실행 시작" }));
    await waitFor(() => expect(durable).toBeTypeOf("function"));
    await waitFor(() => expect(startWork).toHaveBeenCalledOnce());
    createdVisible = true;
    durable?.({ sequence: 64, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(eventBatchApplied).toBe(true));
    started.resolve({ runId: created.run?.runId ?? "" });
    await submitting;

    expect(await screen.findByRole("main", { name: created.title })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("run 투영 전에도 work.created correlation 계보로 자기 Work를 즉시 선택한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const active = snapshot.works.find((candidate) => candidate.status === "active") as WorkView;
    const completed = snapshot.works.find((candidate) => candidate.status === "complete") as WorkView;
    const runId = "1b3d0000-0000-4000-8000-000000000001";
    const foreignRunId = "1b3d0000-0000-4000-8000-000000000002";
    const { run: _activeRun, ...withoutRun } = active;
    void _activeRun;
    const created: WorkView = {
      ...withoutRun,
      id: "a5b00000-0000-4000-8000-000000000001",
      title: "Intake 실행 전 생성된 Work",
    };
    const foreign: WorkView = {
      ...withoutRun,
      id: "a5b00000-0000-4000-8000-000000000002",
      title: "다른 실행에서 생성된 Work",
    };
    const conflicting: WorkView = {
      ...withoutRun,
      id: "a5b00000-0000-4000-8000-000000000003",
      title: "correlation만 같은 다른 실행 Work",
      run: { runId: foreignRunId, status: "running", stage: "intake", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let started = false;
    const loadWork = vi.fn(async (workId: string) => {
      if (workId === created.id) return created;
      if (workId === foreign.id) return foreign;
      if (workId === conflicting.id) return conflicting;
      if (workId === completed.id) return completed;
      return active;
    });
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => {
            started = true;
            return { runId };
          },
          loadIndex: async ({ filter }) =>
            filter === "complete" ? [completed] : started ? [foreign, conflicting, created, active] : [active],
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "완료" }));
    const completedWorkRow = await within(screen.getByRole("region", { name: "Work 목록" })).findByRole("button", {
      name: new RegExp(completed.title, "u"),
    });
    await user.click(completedWorkRow);
    expect(await screen.findByRole("main", { name: completed.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "Intake 전에 Work를 연결해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(runId);

    durable?.({
      sequence: 73,
      type: "work.created",
      correlationId: `${foreignRunId}:intake:work`,
      resource: { type: "Work", id: foreign.id, revision: 1 },
      payload: { domainSequence: 1 },
    });
    durable?.({
      sequence: 74,
      type: "work.created",
      correlationId: `${runId}:intake:work`,
      resource: { type: "Work", id: conflicting.id, revision: 1 },
      payload: { domainSequence: 1 },
    });

    await waitFor(() => expect(loadWork).toHaveBeenCalledWith(conflicting.id));
    expect(screen.getByRole("main", { name: completed.title })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();

    durable?.({
      sequence: 75,
      type: "work.created",
      correlationId: `${runId}:intake:work`,
      resource: { type: "Work", id: created.id, revision: 1 },
      payload: { domainSequence: 1 },
    });

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(loadWork).not.toHaveBeenCalledWith(foreign.id);
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(runId);
  });

  it("start 응답 전에 받은 own correlation Work도 응답 직후 선택한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const { run: _activeRun, ...withoutRun } = active;
    void _activeRun;
    const runId = "run-buffered-correlation";
    const created: WorkView = {
      ...withoutRun,
      id: "work-buffered-correlation",
      title: "응답 전에 생성된 correlation Work",
      run: { runId, status: "awaiting-approval", stage: "delivery", leaseGeneration: 1 },
    };
    const foreignWorkId = "work-buffered-foreign";
    const started = deferred<{ runId: string }>();
    const bufferedStartWork = vi.fn(async () => await started.promise);
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    let eventBatchApplied = false;
    const loadWork = vi.fn(async (workId: string) => (workId === created.id ? created : active));
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: bufferedStartWork,
          loadIndex: async () => {
            if (createdVisible) eventBatchApplied = true;
            return createdVisible ? [created, active] : [active];
          },
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "버퍼된 correlation을 연결해줘");
    const submitting = user.click(screen.getByRole("button", { name: "실행 시작" }));
    await waitFor(() => expect(durable).toBeTypeOf("function"));
    await waitFor(() => expect(bufferedStartWork).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument();
    createdVisible = true;
    durable?.({
      sequence: 74,
      type: "work.created",
      correlationId: "run-foreign:intake:work",
      resource: { type: "Work", id: foreignWorkId, revision: 1 },
    });
    durable?.({
      sequence: 75,
      type: "work.created",
      correlationId: `${runId}:intake:work`,
      resource: { type: "Work", id: created.id, revision: 1 },
      payload: { domainSequence: 1 },
    });
    durable?.({
      sequence: 76,
      type: "run.suspended",
      payload: { workId: created.id },
      resource: { type: "ApplicationRun", id: runId },
    });
    await waitFor(() => expect(eventBatchApplied).toBe(true));
    expect(screen.getByRole("main", { name: active.title })).toBeInTheDocument();
    started.resolve({ runId });
    await submitting;

    expect(await screen.findByRole("main", { name: created.title })).toBeInTheDocument();
    expect(screen.getByText("새 Work가 승인을 기다리고 있습니다.")).toBeInTheDocument();
    expect(loadWork).not.toHaveBeenCalledWith(foreignWorkId);
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("완료 이벤트가 생성 연결보다 먼저 오면 payload Work를 선택하고 완료 목록으로 전환한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const completed: WorkView = {
      ...active,
      id: "work-completed-before-creation-link",
      title: "연결 전에 완료된 새 Work",
      status: "complete",
      run: { runId: "run-completed-before-creation-link", status: "completed", stage: "terminal", leaseGeneration: 3 },
    };
    let durable: ((event: unknown) => void) | undefined;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId: completed.run?.runId ?? "" }),
          loadIndex: async ({ filter }) => (filter === "active" ? [active] : [completed]),
          loadWork: async (workId) => (workId === completed.id ? completed : active),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "완료된 Work를 연결해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    durable?.({
      sequence: 65,
      type: "run.completed",
      payload: { workId: completed.id, stage: "terminal" },
      resource: { type: "ApplicationRun", id: completed.run?.runId },
    });

    expect(await screen.findByRole("main", { name: completed.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "완료" })).toHaveAttribute("aria-selected", "true");
    expect(
      within(screen.getByRole("region", { name: "Work 목록" })).getByRole("button", {
        name: new RegExp(completed.title, "u"),
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main", { name: completed.title })).toBeInTheDocument();
  });

  it("종료 이벤트의 Work 조회가 일시 실패하면 미래 이벤트 없이 다시 연결한다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const failed: WorkView = {
      ...active,
      id: "work-transient-terminal-load",
      title: "재조회로 연결한 실패 Work",
      status: "failed",
      run: { runId: "run-transient-terminal-load", status: "failed", stage: "terminal", leaseGeneration: 3 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let attempts = 0;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId: failed.run?.runId ?? "" }),
          loadIndex: async () => [active],
          loadWork: async (workId) => {
            if (workId !== failed.id) return active;
            attempts += 1;
            if (attempts === 1) throw new Error("Work 투영이 아직 준비되지 않았습니다.");
            return failed;
          },
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "종료 Work 조회를 재시도해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    durable?.({
      sequence: 68,
      type: "run.failed",
      payload: { workId: failed.id },
      resource: { type: "ApplicationRun", id: failed.run?.runId },
    });

    expect(await screen.findByRole("main", { name: failed.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("이전 생성에서 받은 foreign run 이벤트를 다음 생성에 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const first: WorkView = {
      ...active,
      id: "work-first-cleanup",
      title: "첫 번째 생성 Work",
      run: { runId: "run-first-cleanup", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    const stale: WorkView = {
      ...active,
      id: "work-stale-next-creation",
      title: "이전 foreign 이벤트 Work",
      status: "complete",
      run: { runId: "run-stale-next-creation", status: "completed", stage: "terminal", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let firstVisible = false;
    let starts = 0;
    const loadWork = vi.fn(async (workId: string) => {
      if (workId === first.id) return first;
      if (workId === stale.id) return stale;
      return active;
    });
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId: ++starts === 1 ? (first.run?.runId ?? "") : (stale.run?.runId ?? "") }),
          loadIndex: async () => (firstVisible ? [first, active] : [active]),
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "첫 번째 Work를 만들어줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    durable?.({
      sequence: 69,
      type: "run.completed",
      payload: { workId: stale.id },
      resource: { type: "ApplicationRun", id: stale.run?.runId },
    });
    firstVisible = true;
    durable?.({ sequence: 70, type: "work.created", resource: { type: "Work", id: first.id } });
    expect(await screen.findByRole("main", { name: first.title }, { timeout: 2_000 })).toBeInTheDocument();

    loadWork.mockClear();
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "두 번째 Work를 만들어줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    expect(loadWork).not.toHaveBeenCalledWith(stale.id);
    expect(screen.getByRole("status", { name: "Work 생성 중" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: first.title })).toBeInTheDocument();
  });

  it("실패한 생성 요청 중 수집한 foreign 이벤트와 후보를 다음 생성에 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const foreign: WorkView = {
      ...active,
      id: "work-foreign-before-start-reject",
      title: "실패한 요청의 foreign Work",
      run: { runId: "run-foreign-before-start-reject", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    const created: WorkView = {
      ...active,
      id: "work-after-start-reject",
      title: "실패 뒤 생성한 새 Work",
      run: { runId: "run-after-start-reject", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    const firstStart = deferred<{ runId: string }>();
    let starts = 0;
    let durable: ((event: unknown) => void) | undefined;
    let foreignEventsSent = false;
    let firstBatchApplied = false;
    let secondVisible = false;
    const startWork = vi.fn(async () => {
      starts += 1;
      return starts === 1 ? await firstStart.promise : { runId: created.run?.runId ?? "" };
    });
    const loadWork = vi.fn(async (workId: string) => {
      if (workId === foreign.id) return foreign;
      if (workId === created.id) return created;
      return active;
    });
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork,
          loadIndex: async () => {
            if (foreignEventsSent && !secondVisible) firstBatchApplied = true;
            return secondVisible ? [foreign, created, active] : [active];
          },
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "첫 실패 뒤 다시 생성해줘");
    const firstSubmitting = user.click(screen.getByRole("button", { name: "실행 시작" }));
    await waitFor(() => expect(durable).toBeTypeOf("function"));
    await waitFor(() => expect(startWork).toHaveBeenCalledOnce());
    foreignEventsSent = true;
    durable?.({
      sequence: 71,
      type: "run.completed",
      payload: { workId: foreign.id },
      resource: { type: "ApplicationRun", id: created.run?.runId },
    });
    durable?.({ sequence: 72, type: "work.created", resource: { type: "Work", id: foreign.id } });
    await waitFor(() => expect(firstBatchApplied).toBe(true));
    expect(await screen.findByText("업데이트 72을 반영했습니다.")).toBeInTheDocument();
    firstStart.reject(new Error("첫 생성 요청이 늦게 실패했습니다."));
    await firstSubmitting;
    expect(await screen.findByText("첫 생성 요청이 늦게 실패했습니다.")).toBeInTheDocument();

    loadWork.mockClear();
    secondVisible = true;
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    expect(await screen.findByRole("main", { name: created.title })).toBeInTheDocument();
    expect(loadWork).not.toHaveBeenCalledWith(foreign.id);
    expect(screen.queryByText("첫 생성 요청이 늦게 실패했습니다.")).not.toBeInTheDocument();
    expect(screen.getByText("새 Work가 생성되어 선택했습니다.")).toBeInTheDocument();
  });

  it("완료 이벤트 payload가 다른 실행의 Work를 가리키면 선택하지 않는다", async () => {
    const user = userEvent.setup();
    const active = fixtureDataAdapter().works.find((candidate) => candidate.status === "active") as WorkView;
    delete active.run;
    const foreign: WorkView = {
      ...active,
      id: "work-foreign-terminal-payload",
      title: "다른 실행의 완료 Work",
      status: "complete",
      run: { runId: "run-foreign-terminal-payload", status: "completed", stage: "terminal", leaseGeneration: 3 },
    };
    const runId = "run-owned-terminal-payload";
    let durable: ((event: unknown) => void) | undefined;
    render(
      <App
        service={service({
          initialSnapshot: { works: [active] },
          startWork: async () => ({ runId }),
          loadIndex: async () => [active],
          loadWork: async (workId) => (workId === foreign.id ? foreign : active),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "내 실행만 연결해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    durable?.({
      sequence: 66,
      type: "run.completed",
      payload: { workId: foreign.id, stage: "terminal" },
      resource: { type: "ApplicationRun", id: runId },
    });

    await waitFor(() => expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument());
    expect(screen.getByRole("main", { name: active.title })).toBeInTheDocument();
    expect(screen.queryByRole("main", { name: foreign.title })).not.toBeInTheDocument();
  });

  it("Work 생성 이벤트가 실행 원장보다 먼저 와도 다음 이벤트에서 임시 행을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-before-run-0001",
      title: "실행 원장 순서 확인",
      run: { runId: "run-created-before-run-0001", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    let runVisible = false;
    const startWork = vi.fn(async () => ({ runId: "run-created-before-run-0001" }));
    const { run: _unusedRun, ...createdWithoutRun } = created;
    void _unusedRun;
    const fake = service({
      startWork,
      loadIndex: async () => (createdVisible ? [...snapshot.works, createdWithoutRun] : snapshot.works),
      loadWork: async (workId) =>
        workId === created.id ? (runVisible ? created : createdWithoutRun) : (snapshot.works[0] as WorkView),
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "실행 원장 순서를 확인해줘");
    await user.click(within(dialog).getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    createdVisible = true;
    durable?.({ sequence: 12, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(screen.getByText("Work 생성 중")).toBeInTheDocument());

    runVisible = true;
    durable?.({
      sequence: 13,
      type: "runtime.execution-running",
      resource: { type: "Execution", id: "execution-0001" },
    });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(startWork).toHaveBeenCalledOnce();
  });

  it("동시 durable batch의 첫 목록 응답이 stale이어도 다음 batch가 Work 생성을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created: WorkView = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-concurrent-0001",
      title: "동시 생성 후보 확인",
      run: { runId: "run-created-concurrent-0001", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const firstEventLoad = deferred<WorkView[]>();
    let durable: ((event: unknown) => void) | undefined;
    let eventLoads = 0;
    let eventsStarted = false;
    const loadIndex = vi.fn(async () => {
      if (!eventsStarted) return snapshot.works;
      eventLoads += 1;
      if (eventLoads === 1) return await firstEventLoad.promise;
      firstEventLoad.resolve([...snapshot.works, created]);
      return [...snapshot.works, created];
    });
    render(
      <App
        service={service({
          startWork: async () => ({ runId: "run-created-concurrent-0001" }),
          loadIndex,
          loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "동시 생성 후보를 확인해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    eventsStarted = true;
    durable?.({ sequence: 41, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(eventLoads).toBe(1));
    durable?.({ sequence: 42, type: "run.claimed", payload: { workId: created.id } });
    await waitFor(() => expect(eventLoads).toBe(2));

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    await waitFor(() => expect(loadIndex).toHaveBeenCalled());
    expect(screen.queryByText("Work 생성 중")).not.toBeInTheDocument();
  });

  it("Work 후보의 첫 목록 조회가 실패해도 다음 durable batch 성공으로 생성을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created: WorkView = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-retry-0001",
      title: "실패 뒤 생성 후보 확인",
      run: { runId: "run-created-retry-0001", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let eventLoads = 0;
    let eventsStarted = false;
    const loadIndex = vi.fn(async () => {
      if (!eventsStarted) return snapshot.works;
      eventLoads += 1;
      if (eventLoads === 1) throw new Error("첫 생성 목록 조회 실패");
      return [...snapshot.works, created];
    });
    render(
      <App
        service={service({
          startWork: async () => ({ runId: "run-created-retry-0001" }),
          loadIndex,
          loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "실패 뒤 생성 후보를 확인해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    eventsStarted = true;
    durable?.({ sequence: 51, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(eventLoads).toBe(1));
    expect(screen.getByText("Work 생성 중")).toBeInTheDocument();
    durable?.({ sequence: 52, type: "run.claimed", payload: { workId: created.id } });

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByText("Work 생성 중")).not.toBeInTheDocument();
  });

  it("네이티브 선택 취소와 워크스페이스 밖 파일은 현재 draft를 보존한다", async () => {
    const user = userEvent.setup();
    const workspace = {
      workspaceId: "workspace-picker-0001",
      name: "선택 폴더",
      path: "/tmp/picker",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(["/tmp/outside.ts"]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces: async () => [workspace] })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    await user.type(request, "선택 취소 뒤에도 남아야 하는 요청");
    await user.click(await within(dialog).findByRole("button", { name: /선택 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));

    expect(request).toHaveValue("선택 취소 뒤에도 남아야 하는 요청");
    expect(within(dialog).getByRole("button", { name: /선택 폴더/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("선택한 파일은 현재 워크스페이스 안에 있어야 합니다.")).toBeInTheDocument();
  });

  it("폴더 등록 중에는 Work 문맥을 바꾸거나 실행하지 않고 완료 후 새 폴더를 선택한다", async () => {
    const user = userEvent.setup();
    const registered = deferred<{
      workspaceId: string;
      name: string;
      path: string;
      kind: "local-directory";
      trust: "pending";
      status: "active";
      revision: number;
      createdAt: string;
      lastUsedAt: string;
    }>();
    const current = {
      workspaceId: "workspace-current",
      name: "현재 폴더",
      path: "/tmp/current",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const added = {
      workspaceId: "workspace-added",
      name: "새 폴더",
      path: "/tmp/added",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const startWork = vi.fn(async () => ({ runId: "run-unexpected" }));
    const registerWorkspace = vi.fn(async () => await registered.promise);
    const contextPicker = {
      pickDirectory: vi.fn(async () => "/tmp/added"),
      pickFiles: vi.fn(async () => ["/tmp/current/src/keep.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({ loadWorkspaces: async () => [current], registerWorkspace, startWork })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "등록 중인 폴더를 기다려줘");
    await user.click(await within(dialog).findByRole("button", { name: /현재 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "폴더 추가" }));
    await waitFor(() => expect(registerWorkspace).toHaveBeenCalledWith("/tmp/added"));

    expect(within(dialog).getByRole("button", { name: /현재 폴더/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "폴더 추가" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "파일 첨부" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "src/keep.ts 제거" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "실행 시작" })).toBeDisabled();
    expect(startWork).not.toHaveBeenCalled();

    registered.resolve(added);
    expect(await within(dialog).findByRole("button", { name: /새 폴더/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByText("src/keep.ts")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "폴더 추가" })).toBeEnabled();
  });

  it("네이티브 파일 선택기 오류를 표시하고 draft를 보존한다", async () => {
    const user = userEvent.setup();
    const workspace = {
      workspaceId: "workspace-picker-error",
      name: "오류 확인 폴더",
      path: "/tmp/picker-error",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn().mockRejectedValueOnce(new Error("dialog unavailable")).mockResolvedValueOnce([]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces: async () => [workspace] })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    await user.type(request, "선택기 오류 뒤에도 남아야 하는 요청");
    await user.click(await within(dialog).findByRole("button", { name: /오류 확인 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));

    expect(await within(dialog).findByText("파일 선택기를 열지 못했습니다.")).toBeInTheDocument();
    expect(request).toHaveValue("선택기 오류 뒤에도 남아야 하는 요청");
    expect(within(dialog).getByRole("button", { name: /오류 확인 폴더/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await waitFor(() => expect(within(dialog).queryByText("파일 선택기를 열지 못했습니다.")).not.toBeInTheDocument());
    expect(request).toHaveValue("선택기 오류 뒤에도 남아야 하는 요청");
  });

  it("새 Work 제출은 즉시 모달을 닫고 실패 시 입력·폴더·파일·포커스를 복원한다", async () => {
    const user = userEvent.setup();
    const started = deferred<{ runId: string }>();
    const startWork = vi.fn(async () => await started.promise);
    const workspace = {
      workspaceId: "workspace-0002",
      name: "운영 폴더",
      path: "/tmp/operations",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/operations/reports/monthly.csv"]),
    };
    render(
      <App contextPicker={contextPicker} service={service({ startWork, loadWorkspaces: async () => [workspace] })} />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    const submit = within(dialog).getByRole("button", { name: "실행 시작" });
    await user.type(request, "월간 운영 지표를 분석해줘");
    await user.click(await within(dialog).findByRole("button", { name: /운영 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    expect(within(dialog).getByText("reports/monthly.csv")).toBeInTheDocument();
    act(() => {
      submit.click();
      submit.click();
    });

    expect(startWork).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument());
    expect(screen.getByRole("main", { name: (fixtureDataAdapter().works[0] as WorkView).title })).toBeInTheDocument();
    const pendingStatus = screen.getByRole("status", { name: "새 Work 요청 상태" });
    const pendingCreateButton = screen.getByRole("button", { name: "새 Work 만들기" });
    expect(pendingStatus).toHaveTextContent("새 Work 요청을 처리하고 있습니다.");
    expect(pendingCreateButton).toBeDisabled();
    expect(pendingCreateButton).toHaveAttribute("aria-describedby", pendingStatus.id);
    expect(screen.queryByRole("dialog", { name: "새 Work" })).not.toBeInTheDocument();
    expect(startWork).toHaveBeenCalledOnce();

    await act(async () => {
      started.reject(new Error("실행을 시작하지 못했습니다"));
    });
    const reopened = await screen.findByRole("dialog", { name: "새 Work" });
    const restoredRequest = within(reopened).getByRole("textbox", { name: "업무 요청" });
    expect(await within(reopened).findByText("실행을 시작하지 못했습니다")).toBeInTheDocument();
    expect(restoredRequest).toHaveValue("월간 운영 지표를 분석해줘");
    expect(within(reopened).getByRole("button", { name: /운영 폴더/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(reopened).getByText("reports/monthly.csv")).toBeInTheDocument();
    await waitFor(() => expect(restoredRequest).toHaveFocus());
    await user.click(within(reopened).getByRole("button", { name: "새 Work 닫기" }));
    expect(screen.queryByRole("status", { name: "새 Work 요청 상태" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 Work 만들기" })).toBeEnabled();
  });

  it("영어 UI도 pending start 이유를 버튼과 live status에 표시한다", async () => {
    const started = deferred<{ runId: string }>();
    try {
      localStorage.setItem("massion.language.v1", "en");
      const view = render(
        <I18nProvider>
          <App service={service({ startWork: async () => await started.promise })} />
        </I18nProvider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Create new Work" }));
      await user.type(screen.getByRole("textbox", { name: "Work request" }), "Check the pending start state");
      await user.click(screen.getByRole("button", { name: "Start run" }));

      const status = await screen.findByRole("status", { name: "New Work request status" });
      const button = screen.getByRole("button", { name: "Create new Work" });
      expect(status).toHaveTextContent("Processing the new Work request.");
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Processing the new Work request.");

      await act(async () => {
        started.reject(new Error("Start failed"));
      });
      expect(await screen.findByRole("dialog", { name: "New Work" })).toBeInTheDocument();
      view.unmount();
    } finally {
      localStorage.setItem("massion.language.v1", "ko");
    }
  });

  it.each([
    {
      create: "새 Work 만들기",
      dialog: "새 Work",
      firstCreate: "첫 Work 만들기",
      home: "홈",
      locale: "ko",
      request: "업무 요청",
      start: "실행 시작",
      status: "새 Work 요청 상태",
      statusText: "새 Work 요청을 처리하고 있습니다.",
      work: "업무",
    },
    {
      create: "Create new Work",
      dialog: "New Work",
      firstCreate: "Create your first Work",
      home: "Home",
      locale: "en",
      request: "Work request",
      start: "Start run",
      status: "New Work request status",
      statusText: "Processing the new Work request.",
      work: "Work",
    },
  ] as const)("$locale UI는 pending start를 Home과 Work의 모든 진입점에 유지한다", async (labels) => {
    const started = deferred<{ runId: string }>();
    localStorage.setItem("massion.language.v1", labels.locale);
    const view = render(
      <I18nProvider>
        <App
          service={service({
            initialSnapshot: { works: [] },
            loadIndex: async () => [],
            startWork: async () => await started.promise,
          })}
        />
      </I18nProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: labels.home }));
    const home = await screen.findByRole("main", { name: labels.home });
    const homeCreate = within(home).getByRole("button", { name: labels.create });
    await user.click(homeCreate);
    await user.type(screen.getByRole("textbox", { name: labels.request }), "Keep the pending state visible");
    await user.click(screen.getByRole("button", { name: labels.start }));

    const status = await screen.findByRole("status", { name: labels.status });
    expect(status).toHaveTextContent(labels.statusText);
    expect(homeCreate).toBeDisabled();
    expect(homeCreate).toHaveAttribute("aria-describedby", status.id);
    expect(homeCreate).toHaveAttribute("title", labels.statusText);

    await user.click(screen.getByRole("button", { name: labels.work }));
    const listCreate = screen.getByRole("button", { name: labels.create });
    const firstCreate = screen.getByRole("button", { name: labels.firstCreate });
    expect(screen.getByRole("status", { name: labels.status })).toBe(status);
    for (const button of [listCreate, firstCreate]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-describedby", status.id);
      expect(button).toHaveAttribute("title", labels.statusText);
    }

    await act(async () => {
      started.reject(new Error("Start failed"));
    });
    expect(await screen.findByRole("dialog", { name: labels.dialog })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: labels.status })).not.toBeInTheDocument();
    view.unmount();
    localStorage.setItem("massion.language.v1", "ko");
  });

  it("다른 워크스페이스를 선택하면 이전 파일 첨부를 지운다", async () => {
    const user = userEvent.setup();
    const workspace = (workspaceId: string, name: string) => ({
      workspaceId,
      name,
      path: `/tmp/${workspaceId}`,
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    });
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/workspace-a/src/a.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces: async () => [workspace("workspace-a", "A 폴더"), workspace("workspace-b", "B 폴더")],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /A 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: /B 폴더/ }));

    expect(within(dialog).queryByText("src/a.ts")).not.toBeInTheDocument();
  });

  it("다시 열어 정상 목록을 받으면 이전 workspace load 오류를 지운다", async () => {
    const user = userEvent.setup();
    const loadWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error("워크스페이스를 불러오지 못했습니다"))
      .mockResolvedValueOnce([]);
    render(<App service={service({ loadWorkspaces })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    expect(await within(dialog).findByText("워크스페이스를 불러오지 못했습니다")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "새 Work 닫기" }));
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));

    expect(await screen.findByText("저장된 폴더가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("워크스페이스를 불러오지 못했습니다")).not.toBeInTheDocument();
  });

  it("다시 열 때 차단된 workspace는 선택과 파일 draft에서 제거한다", async () => {
    const user = userEvent.setup();
    const active = {
      workspaceId: "workspace-reconciled-0001",
      name: "변경될 폴더",
      path: "/tmp/reconciled",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const blocked = { ...active, trust: "blocked" as const, revision: 2 };
    const loadWorkspaces = vi.fn().mockResolvedValueOnce([active]).mockResolvedValueOnce([blocked]);
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/reconciled/src/attached.ts"]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    let dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /변경될 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "새 Work 닫기" }));
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    dialog = screen.getByRole("dialog", { name: "새 Work" });

    expect(await within(dialog).findByText("차단된 폴더는 선택할 수 없습니다.")).toBeInTheDocument();
    expect(within(dialog).queryByText("src/attached.ts")).not.toBeInTheDocument();
  });

  it("늦은 A 신뢰 응답이 이후 선택한 B workspace와 파일 draft를 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const trust = deferred<{
      workspaceId: string;
      name: string;
      path: string;
      kind: "local-directory";
      trust: "trusted";
      status: "active";
      revision: number;
      createdAt: string;
      lastUsedAt: string;
    }>();
    const pending = {
      workspaceId: "workspace-pending-a",
      name: "A 폴더",
      path: "/tmp/a",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const trusted = {
      workspaceId: "workspace-trusted-b",
      name: "B 폴더",
      path: "/tmp/b",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/b/src/b.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces: async () => [pending, trusted],
          decideWorkspaceTrust: async () => await trust.promise,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /A 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "신뢰하기" }));
    await user.click(within(dialog).getByRole("button", { name: /B 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    trust.resolve({ ...pending, trust: "trusted", revision: 2 });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: /A 폴더/ })).toHaveTextContent("신뢰함"));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: /B 폴더/ })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(dialog).getByText("src/b.ts")).toBeInTheDocument();
  });

  it("워크스페이스를 불러오는 동안 공간을 유지하고 차단된 폴더는 설정으로 안내한다", async () => {
    const user = userEvent.setup();
    const loading = deferred<
      readonly {
        workspaceId: string;
        name: string;
        path: string;
        kind: "local-directory";
        trust: "blocked";
        status: "active";
        revision: number;
        createdAt: string;
        lastUsedAt: string;
      }[]
    >();
    render(<App service={service({ loadWorkspaces: async () => await loading.promise })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    expect(within(dialog).getByLabelText("워크스페이스 불러오는 중")).toBeInTheDocument();
    loading.resolve([
      {
        workspaceId: "workspace-blocked-0001",
        name: "차단된 폴더",
        path: "/tmp/blocked",
        kind: "local-directory",
        trust: "blocked",
        status: "active",
        revision: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        lastUsedAt: "2026-07-24T00:00:00.000Z",
      },
    ]);
    await user.click(await within(dialog).findByRole("button", { name: "설정으로 이동" }));

    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
  });

  it("폴더 등록은 이전 파일 draft를 지우고 신뢰 충돌 뒤 목록을 다시 읽는다", async () => {
    const user = userEvent.setup();
    const current = {
      workspaceId: "workspace-current-0001",
      name: "현재 폴더",
      path: "/tmp/current",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const added = {
      workspaceId: "workspace-added-0001",
      name: "새 폴더",
      path: "/tmp/added",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const refreshed = { ...added, revision: 2 };
    const loadWorkspaces = vi.fn().mockResolvedValueOnce([current]).mockResolvedValueOnce([refreshed]);
    const contextPicker = {
      pickDirectory: vi.fn(async () => "/tmp/added"),
      pickFiles: vi.fn(async () => ["/tmp/current/src/current.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces,
          registerWorkspace: async () => added,
          decideWorkspaceTrust: async () => {
            throw new Error("workspace revision이 일치하지 않습니다");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /현재 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    expect(within(dialog).getByText("src/current.ts")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "폴더 추가" }));
    expect(within(dialog).queryByText("src/current.ts")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "신뢰하기" }));

    expect(await within(dialog).findByText("workspace revision이 일치하지 않습니다")).toBeInTheDocument();
    expect(loadWorkspaces).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("button", { name: /새 폴더/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("동시에 생긴 다른 Work는 자동 선택하지 않고 run 계보가 맞는 Work만 선택한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const foreign = {
      ...(snapshot.works[1] as WorkView),
      id: "work-foreign-0001",
      title: "다른 사용자의 Work",
      run: { runId: "run-foreign-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    const created = {
      ...(snapshot.works[2] as WorkView),
      id: "work-owned-0001",
      title: "내가 요청한 Work",
      run: { runId: "run-owned-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let visible: "base" | "foreign" | "both" = "base";
    const fake = service({
      startWork: async () => ({ runId: "run-owned-0001" }),
      loadIndex: async () =>
        visible === "base"
          ? snapshot.works
          : visible === "foreign"
            ? [...snapshot.works, foreign]
            : [...snapshot.works, foreign, created],
      loadWork: async (workId) => {
        if (workId === foreign.id) return foreign;
        if (workId === created.id) return created;
        return snapshot.works.find((value) => value.id === workId) as WorkView;
      },
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "내 운영 보고서를 만들어줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    visible = "foreign";
    durable?.({ sequence: 21, type: "work.created", resource: { type: "Work", id: foreign.id } });
    await waitFor(() => expect(screen.getByRole("status", { name: "Work 생성 중" })).toBeInTheDocument());
    expect(screen.getByRole("main")).not.toHaveAccessibleName(foreign.title);

    visible = "both";
    durable?.({ sequence: 22, type: "work.created", resource: { type: "Work", id: created.id } });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Work 생성 중" })).not.toBeInTheDocument();
  });

  it("승인 대기 run에는 재개를 노출하지 않고 blocked run만 재개한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const awaiting = {
      ...base,
      run: { runId: "run-awaiting-0001", status: "awaiting-approval", stage: "evidence", leaseGeneration: 1 },
    };
    const resumeRun = vi.fn(async () => undefined);
    const awaitingService = service({
      initialSnapshot: { works: [awaiting] },
      loadIndex: async () => [awaiting],
      loadWork: async () => awaiting,
      resumeRun,
    });
    const view = render(<App service={awaitingService} />);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    view.unmount();

    const blocked = {
      ...base,
      run: { runId: "run-blocked-0001", status: "blocked", stage: "evidence", leaseGeneration: 2 },
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
          resumeRun,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });
});
