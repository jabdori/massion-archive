import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DesktopFilter, DesktopService, DesktopWorkspaceView, StartWorkInput } from "@/desktop-service";
import type { ApprovalView, WorkView } from "@/model";
import { normalizeSearch } from "@/i18n/locale";

export type DesktopPhase = "loading" | "ready" | "error";

interface PendingCreation {
  runId: string;
  baselineWorkIds: ReadonlySet<string>;
}

interface ExecutionNotice {
  executionId: string;
  message: string;
}

interface WorkLoadFlight {
  readonly service: DesktopService;
  readonly active: Promise<WorkView>;
  trailing?: Promise<WorkView>;
}

interface TerminalStabilization {
  readonly workId: string;
  readonly fingerprint: string;
  readonly remaining: number;
}

const SELECTED_WORK_RECONCILE_MS = 1_000;
const TERMINAL_STABILIZATION_PASSES = 3;
const PENDING_CREATION_RECONCILE_PASSES = 3;

export function useDesktopController(service: DesktopService, outputLocale: "en" | "ko" = "en") {
  const initialWorks = service.initialSnapshot?.works ?? [];
  const initialWork = initialWorks[0];
  const [phase, setPhase] = useState<DesktopPhase>(service.initialSnapshot ? "ready" : "loading");
  const [works, setWorks] = useState<WorkView[]>(initialWorks);
  const [selectedId, setSelectedIdState] = useState(initialWork?.id ?? "");
  const [work, setWork] = useState<WorkView | undefined>(initialWork);
  const [filter, setFilterState] = useState<DesktopFilter>("active");
  const [query, setQueryState] = useState("");
  const [composer, setComposer] = useState("");
  const [announcement, setAnnouncementState] = useState("");
  /*
   * 알림은 스스로 사라져야 합니다. 남겨 두면 Work를 세 번 갈아탄 뒤에도 「실행 재개를
   * 요청했습니다」가 화면 아래에 걸려 있고, 그 문장이 지금 화면과 아무 관계가 없어집니다.
   */
  const announcementTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setAnnouncement = useCallback((message: string) => {
    setAnnouncementState(message);
    clearTimeout(announcementTimer.current);
    if (message === "") return;
    announcementTimer.current = setTimeout(() => {
      setAnnouncementState("");
    }, 6000);
  }, []);
  useEffect(
    () => () => {
      clearTimeout(announcementTimer.current);
    },
    [],
  );
  const [rootError, setRootError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingDirective, setPendingDirective] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ReadonlySet<string>>(new Set());
  const [approvalDecisions, setApprovalDecisions] = useState<Record<string, "approved" | "rejected">>({});
  const [pendingRunAction, setPendingRunAction] = useState<"cancel" | "resume" | undefined>();
  const [pendingCreation, setPendingCreationState] = useState<PendingCreation | undefined>();
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newWorkText, setNewWorkText] = useState("");
  const [newWorkWorkspace, setNewWorkWorkspace] = useState<DesktopWorkspaceView | undefined>();
  const [newWorkWorkspaces, setNewWorkWorkspaces] = useState<readonly DesktopWorkspaceView[]>([]);
  const [newWorkWorkspacesLoading, setNewWorkWorkspacesLoading] = useState(false);
  const [newWorkWorkspacePaths, setNewWorkWorkspacePaths] = useState<readonly string[]>([]);
  const [newWorkError, setNewWorkError] = useState("");
  const [newWorkPickerError, setNewWorkPickerError] = useState("");
  const [newWorkWorkspaceLoadError, setNewWorkWorkspaceLoadError] = useState("");
  const [registeringWorkspace, setRegisteringWorkspace] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [executionNotice, setExecutionNotice] = useState<ExecutionNotice | undefined>();
  const [eventRevision, setEventRevision] = useState(0);
  const [selectedWorkEventRevision, setSelectedWorkEventRevision] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);

  const deferredQuery = useDeferredValue(query);
  const selectedIdRef = useRef(selectedId);
  const worksRef = useRef(works);
  const workRef = useRef(work);
  const newWorkWorkspaceRef = useRef<DesktopWorkspaceView | undefined>(newWorkWorkspace);
  const filterRef = useRef(filter);
  const queryRef = useRef(deferredQuery);
  const pendingCreationRef = useRef(pendingCreation);
  const durableWorkCandidatesRef = useRef(new Set<string>());
  const durableWorkCorrelationsRef = useRef(new Map<string, string>());
  const durableRunEventsRef = useRef(new Map<string, unknown>());
  const durableChangedWorkIdsRef = useRef(new Set<string>());
  const durableDetailWorkIdsRef = useRef(new Set<string>());
  const preserveSelectionOnNextIndexRef = useRef(false);
  const detailRequestRef = useRef(0);
  const detailLoadingOwnerRef = useRef<number | undefined>(undefined);
  const indexRequestRef = useRef(0);
  const workLoadFlightsRef = useRef(new Map<string, WorkLoadFlight>());
  const terminalStabilizationRef = useRef<TerminalStabilization | undefined>(undefined);
  const commandLocks = useRef(new Set<string>());
  const startWorkRequestRef = useRef(0);
  const activeServiceRef = useRef(service);

  useLayoutEffect(() => {
    activeServiceRef.current = service;
    startWorkRequestRef.current += 1;
    commandLocks.current.delete("start-work");
    setStartingWork(false);
    return () => {
      startWorkRequestRef.current += 1;
      commandLocks.current.delete("start-work");
    };
  }, [service]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    worksRef.current = works;
  }, [works]);
  useEffect(() => {
    workRef.current = work;
  }, [work]);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    queryRef.current = deferredQuery;
  }, [deferredQuery]);
  useEffect(() => {
    pendingCreationRef.current = pendingCreation;
  }, [pendingCreation]);
  useEffect(() => {
    newWorkWorkspaceRef.current = newWorkWorkspace;
  }, [newWorkWorkspace]);
  useEffect(() => {
    if (!newWorkOpen) return;
    let active = true;
    setNewWorkWorkspacesLoading(true);
    setNewWorkWorkspaceLoadError("");
    void service.loadWorkspaces().then(
      (workspaces) => {
        if (active) {
          setNewWorkWorkspaces(workspaces);
          const selected = newWorkWorkspaceRef.current;
          const refreshed =
            selected === undefined ? undefined : workspaces.find((item) => item.workspaceId === selected.workspaceId);
          if (!refreshed || refreshed.status !== "active" || refreshed.trust === "blocked") {
            newWorkWorkspaceRef.current = undefined;
            setNewWorkWorkspace(undefined);
            setNewWorkWorkspacePaths([]);
          } else if (selected !== undefined) {
            newWorkWorkspaceRef.current = refreshed;
            setNewWorkWorkspace(refreshed);
          }
          setNewWorkWorkspaceLoadError("");
          setNewWorkWorkspacesLoading(false);
        }
      },
      (error: unknown) => {
        if (active) {
          setNewWorkWorkspaceLoadError(errorMessage(error, "워크스페이스를 불러오지 못했습니다."));
          setNewWorkWorkspacesLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [newWorkOpen, service]);

  const loadWorkSingleFlight = useCallback(
    (workId: string): Promise<WorkView> => {
      const current = workLoadFlightsRef.current.get(workId);
      if (current?.service === service) {
        if (current.trailing) return current.trailing;
        const trailing = current.active.then(
          (value) =>
            workLoadFlightsRef.current.get(workId) === current && current.service === service
              ? service.loadWork(workId)
              : value,
          (error: unknown) => {
            if (workLoadFlightsRef.current.get(workId) === current && current.service === service)
              return service.loadWork(workId);
            throw error;
          },
        );
        current.trailing = trailing;
        void trailing.then(
          () => {
            if (workLoadFlightsRef.current.get(workId) === current) workLoadFlightsRef.current.delete(workId);
          },
          () => {
            if (workLoadFlightsRef.current.get(workId) === current) workLoadFlightsRef.current.delete(workId);
          },
        );
        return trailing;
      }
      const active = service.loadWork(workId);
      const flight: WorkLoadFlight = { service, active };
      workLoadFlightsRef.current.set(workId, flight);
      void active.then(
        () => {
          if (workLoadFlightsRef.current.get(workId) === flight && flight.trailing === undefined)
            workLoadFlightsRef.current.delete(workId);
        },
        () => {
          if (workLoadFlightsRef.current.get(workId) === flight && flight.trailing === undefined)
            workLoadFlightsRef.current.delete(workId);
        },
      );
      return active;
    },
    [service],
  );

  const refreshSelectedWork = useCallback(
    async (workId: string, foreground: boolean): Promise<WorkView | undefined> => {
      if (!foreground && detailLoadingOwnerRef.current !== undefined) return undefined;
      const request = ++detailRequestRef.current;
      if (foreground) {
        detailLoadingOwnerRef.current = request;
        setDetailLoading(true);
      }
      try {
        const next = await loadWorkSingleFlight(workId);
        if (request !== detailRequestRef.current || selectedIdRef.current !== workId) return undefined;
        const current = workRef.current;
        if (current?.id === workId && current.revision > next.revision) return current;
        if (foreground && current?.id === workId && !terminalWork(current) && terminalWork(next)) {
          terminalStabilizationRef.current = {
            workId,
            fingerprint: JSON.stringify(next),
            remaining: TERMINAL_STABILIZATION_PASSES,
          };
        }
        workRef.current = next;
        setWork(next);
        setWorks((values) =>
          values.map((value) => (value.id === next.id && value.revision <= next.revision ? next : value)),
        );
        return next;
      } catch (error) {
        if (request === detailRequestRef.current && selectedIdRef.current === workId && foreground)
          setAnnouncement(errorMessage(error, "Work 상세 정보를 불러오지 못했습니다."));
        return undefined;
      } finally {
        if (detailLoadingOwnerRef.current === request) {
          detailLoadingOwnerRef.current = undefined;
          setDetailLoading(false);
        }
      }
    },
    [loadWorkSingleFlight, setAnnouncement],
  );

  const setSelectedId = useCallback(
    (nextId: string) => {
      if (selectedIdRef.current !== nextId) terminalStabilizationRef.current = undefined;
      selectedIdRef.current = nextId;
      setSelectedIdState(nextId);
      void refreshSelectedWork(nextId, true);
    },
    [refreshSelectedWork],
  );

  const selectPendingCreation = useCallback(
    (candidate: WorkView, creation: PendingCreation, eventType?: string, authoritativeLineage = false): boolean => {
      const candidateRunId = candidate.run?.runId;
      if (
        pendingCreationRef.current?.runId !== creation.runId ||
        (candidateRunId !== creation.runId && !(authoritativeLineage && candidateRunId === undefined))
      )
        return false;
      detailRequestRef.current += 1;
      detailLoadingOwnerRef.current = undefined;
      terminalStabilizationRef.current = undefined;
      durableWorkCandidatesRef.current.clear();
      durableWorkCorrelationsRef.current.clear();
      durableRunEventsRef.current.clear();
      pendingCreationRef.current = undefined;
      setPendingCreationState(undefined);
      selectedIdRef.current = candidate.id;
      setSelectedIdState(candidate.id);
      workRef.current = candidate;
      setWork(candidate);
      setDetailLoading(false);
      const nextWorks = [candidate, ...worksRef.current.filter((value) => value.id !== candidate.id)];
      worksRef.current = nextWorks;
      setWorks(nextWorks);
      const nextFilter: DesktopFilter = candidate.status === "active" ? "active" : "complete";
      if (filterRef.current !== nextFilter) {
        preserveSelectionOnNextIndexRef.current = true;
        filterRef.current = nextFilter;
        setFilterState(nextFilter);
      }
      setAnnouncement(creationEventMessage(eventType));
      return true;
    },
    [setAnnouncement],
  );

  const resolvePendingCreation = useCallback(
    async (index: readonly WorkView[]): Promise<boolean> => {
      const creation = pendingCreationRef.current;
      if (!creation) return false;
      const runEvent = durableRunEventsRef.current.get(creation.runId);
      const acknowledgedWorkId = runEventWorkId(runEvent);
      if (acknowledgedWorkId) {
        try {
          const candidate = await service.loadWork(acknowledgedWorkId);
          if (pendingCreationRef.current?.runId !== creation.runId) return true;
          if (selectPendingCreation(candidate, creation, runEventType(runEvent))) return true;
        } catch (error) {
          if (pendingCreationRef.current?.runId !== creation.runId) return true;
          setAnnouncement(errorMessage(error, "새 Work의 실행 계보를 확인하지 못했습니다."));
          return false;
        }
      }
      if (creationSettledEvent(runEvent)) {
        durableRunEventsRef.current.clear();
        durableWorkCandidatesRef.current.clear();
        durableWorkCorrelationsRef.current.clear();
        pendingCreationRef.current = undefined;
        setPendingCreationState(undefined);
        setAnnouncement(creationEventMessage(runEventType(runEvent)));
        return true;
      }

      const candidateIds = new Set(durableWorkCandidatesRef.current);
      const expectedCorrelationId = `${creation.runId}:intake:work`;
      for (const candidate of index) {
        if (!creation.baselineWorkIds.has(candidate.id) && candidate.run?.runId === creation.runId)
          candidateIds.add(candidate.id);
      }
      for (const candidateId of candidateIds) {
        const correlationId = durableWorkCorrelationsRef.current.get(candidateId);
        if (correlationId !== undefined && correlationId !== expectedCorrelationId) {
          durableWorkCandidatesRef.current.delete(candidateId);
          durableWorkCorrelationsRef.current.delete(candidateId);
          continue;
        }
        if (creation.baselineWorkIds.has(candidateId)) {
          durableWorkCandidatesRef.current.delete(candidateId);
          durableWorkCorrelationsRef.current.delete(candidateId);
          continue;
        }
        const indexed = index.find((candidate) => candidate.id === candidateId);
        if (!indexed) continue;
        try {
          const candidate = await service.loadWork(candidateId);
          if (pendingCreationRef.current?.runId !== creation.runId) return true;
          if (selectPendingCreation(candidate, creation, undefined, correlationId === expectedCorrelationId))
            return true;
          durableWorkCandidatesRef.current.add(candidateId);
        } catch (error) {
          if (pendingCreationRef.current?.runId === creation.runId)
            setAnnouncement(errorMessage(error, "새 Work의 실행 계보를 확인하지 못했습니다."));
        }
      }
      return false;
    },
    [selectPendingCreation, service, setAnnouncement],
  );

  const applyIndex = useCallback(
    (next: WorkView[], preserveSelection = false) => {
      const selectedDetail = workRef.current;
      const currentById = new Map(worksRef.current.map((candidate) => [candidate.id, candidate]));
      const merged = next.map((candidate) => {
        const current = currentById.get(candidate.id);
        const newest = current !== undefined && current.revision > candidate.revision ? current : candidate;
        return selectedDetail?.id === candidate.id && selectedDetail.revision >= newest.revision
          ? selectedDetail
          : newest;
      });
      if (
        preserveSelection &&
        selectedDetail &&
        !merged.some((candidate) => candidate.id === selectedDetail.id) &&
        (filterRef.current === "active" ? selectedDetail.status === "active" : selectedDetail.status !== "active")
      )
        merged.unshift(selectedDetail);
      worksRef.current = merged;
      setWorks(merged);

      const currentId = selectedIdRef.current;
      if (
        currentId &&
        (merged.some((candidate) => candidate.id === currentId) ||
          (preserveSelection && workRef.current?.id === currentId))
      )
        return merged;
      if (pendingCreationRef.current) return merged;
      const first = merged[0];
      if (first) {
        setSelectedId(first.id);
        return merged;
      }
      detailRequestRef.current += 1;
      detailLoadingOwnerRef.current = undefined;
      terminalStabilizationRef.current = undefined;
      selectedIdRef.current = "";
      workRef.current = undefined;
      setSelectedIdState("");
      setWork(undefined);
      setDetailLoading(false);
      return merged;
    },
    [setSelectedId],
  );

  const reloadIndex = useCallback(
    async (options: { preserveSelection?: boolean; surfaceError?: boolean } = {}): Promise<WorkView[] | undefined> => {
      const request = ++indexRequestRef.current;
      const requestService = service;
      try {
        const next = await requestService.loadIndex({
          filter: filterRef.current,
          locale: outputLocale,
          search: queryRef.current,
        });
        if (request !== indexRequestRef.current || activeServiceRef.current !== requestService) return undefined;
        return applyIndex([...next], options.preserveSelection);
      } catch (error) {
        if (request !== indexRequestRef.current || activeServiceRef.current !== requestService) return undefined;
        if (options.surfaceError) throw error;
        setAnnouncement(errorMessage(error, "Work 목록을 새로 고치지 못했습니다."));
        return undefined;
      }
    },
    [applyIndex, outputLocale, service],
  );

  useEffect(() => {
    detailRequestRef.current += 1;
    detailLoadingOwnerRef.current = undefined;
    terminalStabilizationRef.current = undefined;
    workLoadFlightsRef.current.clear();
    setDetailLoading(false);
    let disposed = false;
    async function connect() {
      if (!service.initialSnapshot) setPhase("loading");
      setRootError("");
      try {
        await service.bootstrap();
        if (disposed) return;
        setPhase("ready");
        const next = await reloadIndex({ surfaceError: !service.initialSnapshot });
        if (next) await resolvePendingCreation(next);
      } catch (error) {
        if (disposed) return;
        setRootError(errorMessage(error, "로컬 AgentOS에 연결하지 못했습니다."));
        setPhase("error");
      }
    }
    void connect();
    return () => {
      disposed = true;
      detailRequestRef.current += 1;
      detailLoadingOwnerRef.current = undefined;
      terminalStabilizationRef.current = undefined;
      workLoadFlightsRef.current.clear();
      indexRequestRef.current += 1;
    };
  }, [reloadIndex, resolvePendingCreation, retryVersion, service]);

  useEffect(() => {
    if (phase !== "ready") return;
    const preserveSelection = preserveSelectionOnNextIndexRef.current;
    preserveSelectionOnNextIndexRef.current = false;
    void reloadIndex({ preserveSelection }).then((next) => {
      if (next) void resolvePendingCreation(next);
    });
  }, [deferredQuery, filter, phase, reloadIndex, resolvePendingCreation]);

  useEffect(() => {
    const selectedWorkId = work?.id;
    const runStatus = work?.run?.status;
    const stabilizing = terminalStabilizationRef.current?.workId === selectedWorkId;
    if (phase !== "ready" || selectedWorkId === undefined || (!reconcilableRunStatus(runStatus) && !stabilizing))
      return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        timer = undefined;
        const before = workRef.current;
        void refreshSelectedWork(selectedWorkId, false).then((next) => {
          if (disposed || selectedIdRef.current !== selectedWorkId) return;
          if (next === undefined) {
            const terminal = terminalStabilizationRef.current;
            if (terminal?.workId === selectedWorkId) {
              if (terminal.remaining <= 1) {
                terminalStabilizationRef.current = undefined;
                return;
              }
              terminalStabilizationRef.current = { ...terminal, remaining: terminal.remaining - 1 };
            }
            schedule();
            return;
          }
          if (terminalWork(next)) {
            setEventRevision((current) => current + 1);
            setSelectedWorkEventRevision((current) => current + 1);
            const fingerprint = JSON.stringify(next);
            const terminal = terminalStabilizationRef.current;
            if (terminal?.workId === selectedWorkId && terminal.fingerprint === fingerprint) {
              terminalStabilizationRef.current = undefined;
              return;
            }
            const remaining =
              terminal?.workId === selectedWorkId ? terminal.remaining - 1 : TERMINAL_STABILIZATION_PASSES;
            if (remaining <= 0) {
              terminalStabilizationRef.current = undefined;
              return;
            }
            terminalStabilizationRef.current = { workId: selectedWorkId, fingerprint, remaining };
            schedule();
            return;
          }
          terminalStabilizationRef.current = undefined;
          if (
            before?.revision !== next.revision ||
            before.status !== next.status ||
            before.run?.status !== next.run?.status ||
            before.run?.stage !== next.run?.stage ||
            before.run?.leaseGeneration !== next.run?.leaseGeneration
          ) {
            setEventRevision((current) => current + 1);
            setSelectedWorkEventRevision((current) => current + 1);
          }
          if (reconcilableRunStatus(next.run?.status)) schedule();
        });
      }, SELECTED_WORK_RECONCILE_MS);
    };
    schedule();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, refreshSelectedWork, work?.id, work?.run?.status]);

  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => Promise<void>) | undefined;
    const scheduleReconciliation = (event: unknown, remaining: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (remaining === PENDING_CREATION_RECONCILE_PASSES) {
          setEventRevision((current) => current + 1);
          const selectedWorkId = selectedIdRef.current;
          if (durableChangedWorkIdsRef.current.has(selectedWorkId))
            setSelectedWorkEventRevision((current) => current + 1);
          durableChangedWorkIdsRef.current.clear();
          if (durableDetailWorkIdsRef.current.has(selectedWorkId)) setSelectedId(selectedWorkId);
          durableDetailWorkIdsRef.current.clear();
        }
        void (async () => {
          const next = await reloadIndex({ preserveSelection: true });
          if (disposed || !next) return;
          if (await resolvePendingCreation(next)) return;
          const creation = pendingCreationRef.current;
          if (creation && creationSettledEvent(durableRunEventsRef.current.get(creation.runId))) {
            if (remaining > 1) scheduleReconciliation(event, remaining - 1);
            return;
          }
          if (!creation && !commandLocks.current.has("start-work")) {
            durableWorkCandidatesRef.current.clear();
            durableWorkCorrelationsRef.current.clear();
            durableRunEventsRef.current.clear();
          }

          /*
           * 여기서 선택을 다시 밀지 않습니다. 스트림 이벤트마다(100ms 디바운스) 이전 Work로
           * 되돌려서, 사용자가 방금 누른 Work가 간헐적으로 버려졌습니다. 목록 갱신은 아래
           * setWorks가 이미 합니다 — 선택은 사용자만 바꿉니다.
           */
          const value = asRecord(event);
          if (typeof value?.sequence === "number")
            setAnnouncement(`업데이트 ${String(value.sequence)}을 반영했습니다.`);
        })();
      }, 100);
    };
    void service
      .subscribeDurable((event) => {
        if (disposed) return;
        const runId = applicationRunEventId(event);
        if (runId && (pendingCreationRef.current || commandLocks.current.has("start-work")))
          durableRunEventsRef.current.set(runId, event);
        const candidateWorkId = createdWorkId(event);
        if (candidateWorkId && (pendingCreationRef.current || commandLocks.current.has("start-work"))) {
          durableWorkCandidatesRef.current.add(candidateWorkId);
          const correlationId = asRecord(event)?.correlationId;
          if (typeof correlationId === "string") durableWorkCorrelationsRef.current.set(candidateWorkId, correlationId);
        }
        const changedWorkId = eventWorkId(event);
        if (changedWorkId) durableChangedWorkIdsRef.current.add(changedWorkId);
        const detailWorkId = detailEventWorkId(event);
        if (detailWorkId) durableDetailWorkIdsRef.current.add(detailWorkId);
        scheduleReconciliation(event, PENDING_CREATION_RECONCILE_PASSES);
      })
      .then(async (cleanup) => {
        if (disposed) await cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) setAnnouncement(errorMessage(error, "업데이트 스트림에 연결하지 못했습니다."));
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (stop) stopStream(stop);
    };
  }, [phase, reloadIndex, resolvePendingCreation, service, setSelectedId]);

  useEffect(() => {
    const executionId = work?.activeExecutionId;
    if (phase !== "ready" || !executionId) {
      setExecutionNotice(undefined);
      return;
    }
    let disposed = false;
    let stop: (() => Promise<void>) | undefined;
    void service
      .subscribeExecution(executionId, (payload) => {
        if (disposed) return;
        const notice = executionMessage(payload, executionId);
        if (notice) setExecutionNotice({ executionId, message: notice });
      })
      .then(async (cleanup) => {
        if (disposed) await cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) setAnnouncement(errorMessage(error, "실행 진행 스트림에 연결하지 못했습니다."));
      });
    return () => {
      disposed = true;
      if (stop) stopStream(stop);
    };
  }, [phase, service, work?.activeExecutionId]);

  const setFilter = (next: DesktopFilter) => {
    preserveSelectionOnNextIndexRef.current = false;
    filterRef.current = next;
    setFilterState(next);
  };

  const setQuery = (next: string) => {
    setQueryState(next);
  };

  /** `override`가 있으면 인풋이 아니라 그 내용을 보냅니다 — 대기 카드가 자기 내용을 다시 보낼 때 씁니다. */
  const submitDirective = async (mode: "now" | "next-stage", override?: string) => {
    const current = workRef.current;
    const content = (override ?? composer).trim();
    if (!current || !content || commandLocks.current.has("directive")) return;
    commandLocks.current.add("directive");
    setPendingDirective(true);
    setAnnouncement("지시를 저장하고 있습니다.");
    try {
      await service.submitDirective(current, content, mode);
      if (override === undefined) setComposer("");
      setAnnouncement(
        mode === "now" ? "안전한 실행 경계에서 지금 반영합니다." : "다음 단계에 반영하도록 예약했습니다.",
      );
      setSelectedId(current.id);
    } catch (error) {
      setAnnouncement(errorMessage(error, "지시를 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete("directive");
      setPendingDirective(false);
    }
  };

  const updateDirective = async (
    directive: NonNullable<WorkView["queuedDirectives"]>[number],
    content: string,
    mode: "now" | "next-stage",
  ) => {
    const current = workRef.current;
    const nextContent = content.trim();
    const lock = `directive:${directive.id}`;
    if (!current || !nextContent || commandLocks.current.has(lock)) return;
    commandLocks.current.add(lock);
    setPendingDirective(true);
    try {
      await service.updateDirective(current, directive, nextContent, mode);
      setAnnouncement(
        mode === "now"
          ? "대기 지시를 안전한 실행 경계에서 지금 반영하도록 변경했습니다."
          : "대기 지시를 다음 단계로 옮겼습니다.",
      );
      await refreshSelectedWork(current.id, false);
    } catch (error) {
      setAnnouncement(errorMessage(error, "대기 지시를 변경하지 못했습니다."));
    } finally {
      commandLocks.current.delete(lock);
      setPendingDirective(false);
    }
  };

  const cancelDirective = async (directive: NonNullable<WorkView["queuedDirectives"]>[number]) => {
    const current = workRef.current;
    const lock = `directive:${directive.id}`;
    if (!current || commandLocks.current.has(lock)) return;
    commandLocks.current.add(lock);
    setPendingDirective(true);
    try {
      await service.cancelDirective(current, directive);
      setAnnouncement("대기 지시를 취소했습니다.");
      await refreshSelectedWork(current.id, false);
    } catch (error) {
      setAnnouncement(errorMessage(error, "대기 지시를 취소하지 못했습니다."));
    } finally {
      commandLocks.current.delete(lock);
      setPendingDirective(false);
    }
  };

  const decideApproval = async (approval: ApprovalView, decision: "approved" | "rejected") => {
    const lock = `approval:${approval.id}`;
    if (commandLocks.current.has(lock)) return;
    commandLocks.current.add(lock);
    setPendingApprovals((current) => new Set(current).add(approval.id));
    try {
      const vote = decision === "approved" ? "approve" : "reject";
      const reason = decision === "approved" ? "데스크톱 Work 화면에서 검토 완료" : "데스크톱 Work 화면에서 거절";
      const result = await service.decideApproval(approval, vote, reason);
      if (result.status !== "pending") {
        setApprovalDecisions((current) => ({ ...current, [approval.id]: decision }));
      }
      setAnnouncement(
        result.status === "pending"
          ? "승인 투표가 기록되었습니다. 추가 의결을 기다립니다."
          : decision === "approved"
            ? "승인되었습니다. 실행을 계속합니다."
            : "거절되었습니다. 실행을 중단했습니다.",
      );
      const currentWork = workRef.current;
      if (currentWork) await refreshSelectedWork(currentWork.id, false);
      return result;
    } catch (error) {
      setAnnouncement(errorMessage(error, "승인 결정을 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete(lock);
      setPendingApprovals((current) => {
        const next = new Set(current);
        next.delete(approval.id);
        return next;
      });
    }
  };

  const controlRun = async (action: "cancel" | "resume") => {
    const current = workRef.current;
    if (!current?.run || commandLocks.current.has("run")) return;
    const canCancel = ["ready", "running", "awaiting-approval", "blocked"].includes(current.run.status);
    const canResume = current.run.status === "blocked";
    if ((action === "cancel" && !canCancel) || (action === "resume" && !canResume)) return;
    commandLocks.current.add("run");
    setPendingRunAction(action);
    try {
      if (action === "cancel") await service.cancelRun(current);
      else await service.resumeRun(current);
      setAnnouncement(action === "cancel" ? "실행 취소를 요청했습니다." : "실행 재개를 요청했습니다.");
      setSelectedId(current.id);
    } catch (error) {
      setAnnouncement(
        errorMessage(error, action === "cancel" ? "실행을 취소하지 못했습니다." : "실행을 재개하지 못했습니다."),
      );
    } finally {
      commandLocks.current.delete("run");
      setPendingRunAction(undefined);
    }
  };

  const startWork = async () => {
    const text = newWorkText.trim();
    if (!text || registeringWorkspace || commandLocks.current.has("start-work")) return;
    if (newWorkWorkspace?.trust === "pending") {
      setNewWorkError("선택한 폴더를 신뢰한 뒤 실행할 수 있습니다.");
      return;
    }
    commandLocks.current.add("start-work");
    const request = ++startWorkRequestRef.current;
    const requestService = service;
    setStartingWork(true);
    setNewWorkError("");
    setNewWorkOpen(false);
    const input: StartWorkInput = {
      text,
      outputLocale,
      ...(newWorkWorkspace === undefined ? {} : { workspaceId: newWorkWorkspace.workspaceId }),
      ...(newWorkWorkspacePaths.length === 0 ? {} : { workspacePaths: newWorkWorkspacePaths }),
    };
    const baselineWorkIds = new Set(worksRef.current.map((value) => value.id));
    let result: Awaited<ReturnType<DesktopService["startWork"]>>;
    try {
      result = await requestService.startWork(input);
    } catch (error) {
      if (startWorkRequestRef.current !== request || activeServiceRef.current !== requestService) return;
      durableRunEventsRef.current.clear();
      durableWorkCandidatesRef.current.clear();
      durableWorkCorrelationsRef.current.clear();
      commandLocks.current.delete("start-work");
      setStartingWork(false);
      setNewWorkError(errorMessage(error, "새 Work 실행을 시작하지 못했습니다."));
      setNewWorkOpen(true);
      return;
    }
    if (startWorkRequestRef.current !== request || activeServiceRef.current !== requestService) return;
    const ownRunEvent = durableRunEventsRef.current.get(result.runId);
    durableRunEventsRef.current.clear();
    if (ownRunEvent) durableRunEventsRef.current.set(result.runId, ownRunEvent);
    const expectedCorrelationId = `${result.runId}:intake:work`;
    for (const [workId, correlationId] of durableWorkCorrelationsRef.current) {
      if (correlationId === expectedCorrelationId) continue;
      durableWorkCorrelationsRef.current.delete(workId);
      durableWorkCandidatesRef.current.delete(workId);
    }
    const creation: PendingCreation = {
      runId: result.runId,
      baselineWorkIds,
    };
    pendingCreationRef.current = creation;
    setPendingCreationState(creation);
    filterRef.current = "active";
    setFilterState("active");
    setNewWorkText("");
    newWorkWorkspaceRef.current = undefined;
    setNewWorkWorkspace(undefined);
    setNewWorkWorkspacePaths([]);
    commandLocks.current.delete("start-work");
    setStartingWork(false);
    setAnnouncement("새 Work 실행을 시작했습니다. Work 생성을 기다리고 있습니다.");
    const next = await reloadIndex();
    if (next && startWorkRequestRef.current === request && activeServiceRef.current === requestService)
      await resolvePendingCreation(next);
  };

  const registerWorkspace = async (path: string) => {
    if (!path || commandLocks.current.has("register-workspace")) return;
    commandLocks.current.add("register-workspace");
    setRegisteringWorkspace(true);
    setNewWorkError("");
    try {
      const workspace = await service.registerWorkspace(path);
      setNewWorkWorkspaces((current) => [
        workspace,
        ...current.filter((item) => item.workspaceId !== workspace.workspaceId),
      ]);
      newWorkWorkspaceRef.current = workspace;
      setNewWorkWorkspace(workspace);
      setNewWorkWorkspacePaths([]);
    } catch (error) {
      setNewWorkError(errorMessage(error, "폴더를 추가하지 못했습니다."));
    } finally {
      commandLocks.current.delete("register-workspace");
      setRegisteringWorkspace(false);
    }
  };

  const decideWorkspaceTrust = async (decision: "trusted" | "blocked") => {
    if (registeringWorkspace || !newWorkWorkspace || commandLocks.current.has("workspace-trust")) return;
    const requestedWorkspaceId = newWorkWorkspace.workspaceId;
    commandLocks.current.add("workspace-trust");
    setNewWorkError("");
    try {
      const workspace = await service.decideWorkspaceTrust(newWorkWorkspace, decision);
      setNewWorkWorkspaces((current) =>
        current.map((item) => (item.workspaceId === workspace.workspaceId ? workspace : item)),
      );
      if (newWorkWorkspaceRef.current?.workspaceId !== requestedWorkspaceId) return;
      if (decision === "trusted") {
        newWorkWorkspaceRef.current = workspace;
        setNewWorkWorkspace(workspace);
      } else {
        newWorkWorkspaceRef.current = undefined;
        setNewWorkWorkspace(undefined);
        setNewWorkWorkspacePaths([]);
      }
    } catch (error) {
      setNewWorkWorkspaceLoadError("");
      try {
        const workspaces = await service.loadWorkspaces();
        setNewWorkWorkspaces(workspaces);
        setNewWorkWorkspaceLoadError("");
        if (newWorkWorkspaceRef.current?.workspaceId === requestedWorkspaceId) {
          const refreshed = workspaces.find((item) => item.workspaceId === requestedWorkspaceId);
          if (!refreshed || refreshed.status !== "active" || refreshed.trust === "blocked") {
            newWorkWorkspaceRef.current = undefined;
            setNewWorkWorkspace(undefined);
            setNewWorkWorkspacePaths([]);
          } else {
            newWorkWorkspaceRef.current = refreshed;
            setNewWorkWorkspace(refreshed);
          }
        }
      } catch (reloadError) {
        // 신뢰 충돌 뒤 재조회 실패는 원래 오류를 덮어쓰지 않습니다.
        setNewWorkWorkspaceLoadError(errorMessage(reloadError, "워크스페이스를 불러오지 못했습니다."));
      }
      setNewWorkError(errorMessage(error, "폴더 신뢰 상태를 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete("workspace-trust");
    }
  };

  const addWorkspacePaths = (files: readonly string[]) => {
    if (registeringWorkspace || !newWorkWorkspace || files.length === 0) return;
    const paths = relativeWorkspacePaths(newWorkWorkspace.path, files);
    if (paths === undefined) {
      setNewWorkError("선택한 파일은 현재 워크스페이스 안에 있어야 합니다.");
      return;
    }
    setNewWorkError("");
    setNewWorkWorkspacePaths((current) => {
      const next = [...current];
      for (const path of paths) {
        if (next.length >= 20) break;
        if (!next.includes(path)) next.push(path);
      }
      return next;
    });
  };

  const visibleWorks = works.filter((value) => {
    const search = normalizeSearch(query, outputLocale);
    return (
      (filter === "active" ? value.status === "active" : value.status !== "active") &&
      (!search || normalizeSearch(value.title, outputLocale).includes(search))
    );
  });

  return {
    announcement,
    approvalDecisions,
    composer,
    cancelDirective,
    controlRun,
    decideApproval,
    detailLoading,
    executionNotice,
    eventRevision,
    selectedWorkEventRevision,
    filter,
    newWork: {
      error: [newWorkError, newWorkPickerError, newWorkWorkspaceLoadError].filter(Boolean).join(" "),
      open: newWorkOpen,
      setOpen: (open: boolean) => {
        if (open && commandLocks.current.has("start-work")) return;
        setNewWorkOpen(open);
      },
      setText: setNewWorkText,
      setWorkspace: (workspace: DesktopWorkspaceView | undefined) => {
        if (registeringWorkspace || workspace?.trust === "blocked") return;
        newWorkWorkspaceRef.current = workspace;
        setNewWorkWorkspace(workspace);
        if (workspace?.workspaceId !== newWorkWorkspace?.workspaceId) {
          setNewWorkWorkspacePaths([]);
        }
      },
      addWorkspacePaths,
      removeWorkspacePath: (path: string) => {
        if (registeringWorkspace) return;
        setNewWorkWorkspacePaths((current) => current.filter((item) => item !== path));
      },
      registerWorkspace,
      registeringWorkspace,
      setPickerError: setNewWorkPickerError,
      decideWorkspaceTrust,
      start: startWork,
      starting: startingWork,
      text: newWorkText,
      workspace: newWorkWorkspace,
      workspacePaths: newWorkWorkspacePaths,
      workspaces: newWorkWorkspaces,
      workspacesLoading: newWorkWorkspacesLoading,
    },
    pendingApprovals,
    pendingCreation,
    pendingDirective,
    pendingRunAction,
    phase,
    query,
    retry: () => {
      setRetryVersion((current) => current + 1);
    },
    rootError,
    selectedId,
    setAnnouncement,
    setComposer,
    setFilter,
    setQuery,
    setSelectedId,
    submitDirective,
    updateDirective,
    visibleWorks,
    work,
    works,
  };
}

export function relativeWorkspacePaths(rootPath: string, files: readonly string[]): readonly string[] | undefined {
  const root = normalizeNativeRoot(rootPath);
  if (!root) return undefined;
  const rootDirectory = root === "/";
  const prefix = rootDirectory ? root : `${root}/`;
  const paths: string[] = [];
  for (const file of files) {
    if (!file || file === root || !file.startsWith(prefix)) return undefined;
    const relativePath = file.slice(root.length + (rootDirectory ? 0 : 1));
    if (!relativePath || relativePath.startsWith("/")) return undefined;
    paths.push(relativePath);
  }
  return paths;
}

function normalizeNativeRoot(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function stopStream(stop: () => Promise<void>): void {
  void stop().catch(() => undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function createdWorkId(value: unknown): string | undefined {
  const event = asRecord(value);
  if (event?.type !== "work.created") return undefined;
  const resource = asRecord(event.resource);
  return resource?.type === "Work" && typeof resource.id === "string" ? resource.id : undefined;
}

function eventWorkId(value: unknown): string | undefined {
  const event = asRecord(value);
  const resource = asRecord(event?.resource);
  if (resource?.type === "Work" && typeof resource.id === "string") return resource.id;
  const payload = asRecord(event?.payload);
  return typeof payload?.workId === "string" ? payload.workId : undefined;
}

function detailEventWorkId(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  return typeof type === "string" && (type.startsWith("work.") || type.startsWith("run."))
    ? eventWorkId(value)
    : undefined;
}

function applicationRunEventId(value: unknown): string | undefined {
  const event = asRecord(value);
  if (typeof event?.type !== "string" || !event.type.startsWith("run.")) return undefined;
  const resource = asRecord(event.resource);
  return resource?.type === "ApplicationRun" && typeof resource.id === "string" ? resource.id : undefined;
}

function runEventType(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  return typeof type === "string" ? type : undefined;
}

function runEventWorkId(value: unknown): string | undefined {
  if (!applicationRunEventId(value)) return undefined;
  const payload = asRecord(asRecord(value)?.payload);
  return typeof payload?.workId === "string" ? payload.workId : undefined;
}

function creationSettledEvent(value: unknown): boolean {
  return ["run.blocked", "run.suspended", "run.completed", "run.failed", "run.cancelled"].includes(
    runEventType(value) ?? "",
  );
}

function creationEventMessage(type: string | undefined): string {
  if (type === "run.blocked") return "새 Work가 차단되었습니다.";
  if (type === "run.suspended") return "새 Work가 승인을 기다리고 있습니다.";
  if (type === "run.failed") return "새 Work 실행에 실패했습니다.";
  if (type === "run.cancelled") return "새 Work 실행이 취소되었습니다.";
  if (type === "run.completed") return "새 Work가 완료되어 선택했습니다.";
  return "새 Work가 생성되어 선택했습니다.";
}

function executionMessage(value: unknown, executionId: string): string | undefined {
  const delta = asRecord(value);
  if (!delta || delta.executionId !== executionId) return undefined;
  if (delta.kind === "tool-call" && typeof delta.toolName === "string") return `${delta.toolName} 도구 실행 중`;
  if (delta.kind === "tool-result" && typeof delta.toolName === "string") return `${delta.toolName} 도구 실행 완료`;
  if (delta.kind === "lifecycle" && typeof delta.summary === "string") return delta.summary;
  if (delta.kind === "error") return typeof delta.summary === "string" ? delta.summary : "실행 오류 수신";
  if (delta.kind === "output-text") return "에이전트 응답을 생성하고 있습니다.";
  if (delta.kind === "reasoning") return "에이전트가 다음 단계를 검토하고 있습니다.";
  return undefined;
}

function reconcilableRunStatus(status: string | undefined): boolean {
  return status === "ready" || status === "running" || status === "awaiting-approval";
}

function terminalWork(work: WorkView): boolean {
  return (
    work.run?.stage === "terminal" ||
    work.status === "complete" ||
    work.status === "failed" ||
    work.status === "cancelled"
  );
}
