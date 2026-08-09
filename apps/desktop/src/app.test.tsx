import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { createFixtureDesktopService } from "./desktop-service";
import { I18nProvider } from "./i18n/context";
import type { WorkView } from "./model";

function renderApp() {
  return render(<App service={createFixtureDesktopService()} />);
}

describe("AgentOS 데스크톱", () => {
  it("영어 설정에서 언어를 한국어로 즉시 전환한다", async () => {
    const user = userEvent.setup();
    localStorage.setItem("massion.language.v1", "en");
    render(
      <I18nProvider>
        <App service={createFixtureDesktopService()} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("main", { name: "Settings" });
    expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Organization" })).toBeInTheDocument();
    expect(within(settings).getByRole("region", { name: "Language" })).toBeInTheDocument();
    expect(within(settings).getAllByRole("button", { name: "Automatic" }).length).toBeGreaterThan(0);
    expect(within(settings).getByText("Trusted")).toBeInTheDocument();
    expect(within(settings).getByText("Finds Growth candidates in completed runs.")).toBeInTheDocument();
    expect(
      within(settings).getByText("Use English for the interface and responses from Agents in new Work."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Provider" }));
    const providers = await screen.findByRole("main", { name: "Provider" });
    await user.type(within(providers).getByRole("textbox", { name: "Search Providers" }), "ＣＯＤＥＸ");
    expect(within(providers).getAllByText("OpenAI Codex").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Organization" }));
    const organization = await screen.findByRole("main", { name: "Organization" });
    expect(within(organization).getAllByText("Request coordination").length).toBeGreaterThan(0);
    expect(within(organization).queryByText("사용자 요청 접수")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const reopenedSettings = await screen.findByRole("main", { name: "Settings" });
    await user.click(within(reopenedSettings).getByRole("button", { name: "한국어" }));
    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ko-KR");
  });

  it("네 개의 독립 영역과 선택한 Work 활동을 표시한다", () => {
    renderApp();

    expect(screen.getByRole("complementary", { name: "전역 탐색" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Work 목록" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAccessibleName("3분기 고객 이탈 원인 분석");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toBeInTheDocument();
    expect(screen.getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
  });

  it("Work 헤더에는 내부 Provider가 아니라 실제 모델만 표시한다", () => {
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const failed = {
      ...seed,
      status: "failed",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      modelRoute: "openai-codex/gpt-5.6-sol/ultra",
    } as WorkView & { modelRoute: string };
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [failed] },
          loadIndex: async () => [failed],
          loadWork: async () => failed,
        }}
      />,
    );

    const main = screen.getByRole("main", { name: failed.title });
    expect(within(main).getByText("gpt-5.6-sol")).toHaveClass("font-mono");
    expect(main).not.toHaveTextContent("openai-codex");
    expect(main).not.toHaveTextContent(failed.modelRoute);
  });

  it("방이 아직 없어도 routine 이벤트 대신 실제 Task 계획을 표시한다", async () => {
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const work: WorkView = {
      ...seed,
      activities: [
        {
          id: "routine-stage",
          kind: "event",
          semantic: "stage",
          time: "10:21",
          title: "업무가 접수되었습니다",
          detail: "",
          status: "",
        },
        {
          id: "actual-plan",
          kind: "plan",
          time: "10:22",
          title: "실행 계획",
          steps: [{ id: "task-1", title: "자연어 목표 분석", state: "active" }],
        },
      ],
    };
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadWork: async () => work,
          loadRooms: async () => [],
        }}
      />,
    );

    expect(await screen.findByText("자연어 목표 분석")).toBeInTheDocument();
    expect(screen.getByText("실행 계획").closest("details")).toBeInTheDocument();
    expect(screen.queryByText("업무가 접수되었습니다")).not.toBeInTheDocument();
  });

  it("문서가 아니라 각 열만 스크롤하고 composer를 viewport 안에 고정한다", () => {
    renderApp();

    expect(screen.getByTestId("desktop-shell")).toHaveClass("grid-rows-[minmax(0,1fr)]", "overflow-hidden");
    expect(screen.getByRole("complementary", { name: "전역 탐색" })).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("region", { name: "Work 목록" })).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("main")).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveClass("min-h-0", "overflow-y-auto");
    const inspector = screen.getByRole("complementary", { name: "Work 세부 정보" });
    expect(inspector).toHaveClass("min-h-0", "h-full");
    for (const label of ["편성", "산출물", "검증", "기록", "근거"]) {
      expect(within(inspector).getByRole("tab", { name: label })).toHaveClass("whitespace-nowrap");
    }
    expect(screen.getByTestId("directive-composer")).toBeInTheDocument();
  });

  it("Work 요청 입력은 저장되지 않는 로컬 제어와 정적 배치 문구를 노출하지 않는다", () => {
    renderApp();
    const composer = screen.getByTestId("directive-composer");

    expect(within(composer).queryByRole("combobox", { name: "모델" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("combobox", { name: "추론 수준" })).not.toBeInTheDocument();
    expect(
      within(composer).queryByRole("button", { name: /^(?:자동|수동|바이패스|전체 권한)$/u }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("조직이 실행 조건을 자동 배치합니다")).not.toBeInTheDocument();
  });

  it("검색과 상태 필터로 Work 목록을 좁힌다", async () => {
    const user = userEvent.setup();
    renderApp();
    const list = screen.getByRole("region", { name: "Work 목록" });

    await user.type(within(list).getByRole("searchbox"), "계약서");
    expect(within(list).getByRole("button", { name: /파트너 계약서 검토/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /3분기 고객 이탈 원인 분석/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("main", { name: "파트너 계약서 검토" })).toBeInTheDocument();

    await user.clear(within(list).getByRole("searchbox"));
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    expect(await within(list).findByRole("button", { name: /환불 지연 원인 제거/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /3분기 고객 이탈 원인 분석/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("main", { name: "환불 지연 원인 제거" })).toBeInTheDocument();
  });

  it("완료된 Work는 통과한 검증·최종 응답·기록을 함께 보여준다", async () => {
    const user = userEvent.setup();
    renderApp();
    const list = screen.getByRole("region", { name: "Work 목록" });

    await user.click(within(list).getByRole("tab", { name: "완료" }));
    await user.click(await within(list).findByRole("button", { name: /환불 지연 원인 제거/ }));

    // 최종 응답은 활동 흐름 안에서 다른 발언과 갈립니다.
    expect(await screen.findByText(/정산 배치 대기였습니다/)).toBeInTheDocument();
    const finalResponse = screen.getByText("최종 응답").closest("article");
    expect(finalResponse).toHaveClass("border", "border-control", "bg-surface-1");

    const composer = screen.getByTestId("directive-composer");
    expect(within(composer).getByRole("button", { name: "파일 첨부" })).toBeDisabled();
    expect(within(composer).getByRole("button", { name: "에이전트 멘션" })).toBeDisabled();
    expect(within(composer).getByRole("button", { name: "보내기" })).toBeDisabled();

    const inspector = screen.getByRole("complementary", { name: "Work 세부 정보" });
    await user.click(within(inspector).getByRole("tab", { name: "검증" }));
    expect(within(inspector).getByText("검증 기준")).toBeInTheDocument();
    // 도메인 슬러그는 화면에 그대로 나오지 않습니다. 사람이 읽는 말이 서고 슬러그는 툴팁입니다.
    expect(within(inspector).getByText("되돌릴 경로 존재")).toHaveAttribute("title", "rollback-path-exists");

    await user.click(within(inspector).getByRole("tab", { name: "기록" }));
    // 되돌릴 수 있는 지점과 결정이 기록에서 읽힙니다.
    expect(within(inspector).getByText("4f9c1ab7")).toBeInTheDocument();
    expect(within(inspector).getByText(/정산 배치 주기를 4시간으로 바꿉니다/)).toBeInTheDocument();
    expect(within(inspector).getByText("CHANGELOG")).toBeInTheDocument();
    expect(within(inspector).getByText("승인됨")).toBeInTheDocument();
    expect(within(inspector).getByText("Iris")).toBeInTheDocument();
    expect(within(inspector).getByText("환불 지연 분석.pdf")).toBeInTheDocument();
    expect(within(inspector).getByText("구간별 지연.csv")).toBeInTheDocument();
    expect(within(inspector).queryByText("verification-refund")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("artifact-version-refund-report")).not.toBeInTheDocument();
  });

  it("기록이 없는 Work의 기록 탭은 산출물 빈 상태를 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    renderApp();

    const inspector = screen.getByRole("complementary", { name: "Work 세부 정보" });
    await user.click(within(inspector).getByRole("tab", { name: "기록" }));
    expect(await within(inspector).findByText("아직 남은 기록이 없습니다.")).toBeInTheDocument();
    expect(within(inspector).queryByText("실행이 산출물을 만들면 여기에 표시됩니다.")).not.toBeInTheDocument();
  });

  it("진행 중 Work가 없어도 완료 탭에서 종료된 Work를 다시 연다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const completed: WorkView = { ...seed, status: "complete" };
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [] },
          loadIndex: async ({ filter }) => (filter === "complete" ? [completed] : []),
          loadWork: async () => completed,
        }}
      />,
    );

    const list = screen.getByRole("region", { name: "Work 목록" });
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    expect(await within(list).findByRole("button", { name: new RegExp(completed.title) })).toBeInTheDocument();
  });

  it("다른 Work를 선택하면 중앙 제목과 inspector가 함께 바뀐다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    expect(screen.getByRole("main")).toHaveAccessibleName("파트너 계약서 검토");
    expect(screen.getByRole("heading", { name: "파트너 계약서 검토" })).toBeInTheDocument();
    expect(screen.getByText("계약 조항 검증")).toBeInTheDocument();
  });

  it("요청 이해 Agent 실패를 행동 가능한 말로 설명하고 요청 해석부터 다시 시도한다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const blocked: WorkView = {
      ...seed,
      id: "work-representative-failed",
      title: "요청 이해가 멈춘 업무",
      run: {
        runId: "run-representative-failed",
        status: "blocked",
        stage: "intake",
        leaseGeneration: 2,
        blockedReason: "representative-failed",
      },
    };
    const resumeRun = vi.fn(async () => undefined);
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
          resumeRun,
        }}
      />,
    );

    // 차단 상태는 스트림 안에 놓이고 재시도가 원인 바로 옆에 붙습니다.
    const status = screen.getByRole("status", { name: "실행 상태" });
    expect(within(status).getByText("차단됨")).toHaveClass("text-halt");
    expect(status).toHaveTextContent(
      "요청 이해 Agent가 요청 해석에 실패했습니다. 다시 시도하면 요청 해석부터 다시 시작합니다.",
    );
    expect(status).not.toHaveTextContent(/representative-failed|실행 단계/u);
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });

  it("모델 부재를 내부 Provider 용어 없이 설명한다", () => {
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const blocked: WorkView = {
      ...seed,
      id: "work-model-unavailable",
      title: "모델을 기다리는 업무",
      run: {
        runId: "run-model-unavailable",
        status: "blocked",
        stage: "intake",
        leaseGeneration: 1,
        blockedReason: "model-unavailable",
      },
    };
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
        }}
      />,
    );

    const status = screen.getByRole("status", { name: "실행 상태" });
    expect(status).toHaveTextContent("사용 가능한 모델을 찾지 못했습니다.");
    expect(status).not.toHaveTextContent("Provider");
  });

  it("승인 결정을 반영하고 중복 결정을 막는다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "CRM 고객 데이터 읽기 승인" }));
    expect(screen.getByRole("status", { name: "알림" })).toHaveTextContent("승인되었습니다");
    expect(screen.queryByRole("button", { name: "CRM 고객 데이터 읽기 승인" })).not.toBeInTheDocument();
  });

  it("전역 메뉴가 여섯 제품 화면으로 전환되고 수신함 패널은 현재 화면 위에 열린다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "홈" }));
    expect(await screen.findByRole("main", { name: "홈" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "업무" }));
    expect(screen.getByRole("main", { name: "3분기 고객 이탈 원인 분석" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "조직" }));
    expect(await screen.findByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /수신함/ }));
    expect(await screen.findByRole("dialog", { name: "수신함" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "수신함 닫기" }));
    expect(screen.getByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "개선" }));
    expect(await screen.findByRole("main", { name: "개선" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "확장" }));
    expect(await screen.findByRole("main", { name: "확장" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
  });

  // 반영 시점은 보내기 «전»이 아니라 «후»에 고릅니다. 보낸 지시는 인풋 위에 카드로 섭니다.
  it("보낸 지시는 대기 카드로 서고 거기서 현재 작업에 반영한다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByRole("textbox", { name: "추가 지시" }), "산업군별 이탈률도 분리해줘");
    await user.click(screen.getByRole("button", { name: "보내기" }));

    expect(screen.getByRole("status", { name: "알림" })).toHaveTextContent("다음 단계에 반영하도록 예약했습니다");
    expect(screen.getByRole("textbox", { name: "추가 지시" })).toHaveValue("");
    expect(screen.getAllByText("산업군별 이탈률도 분리해줘").length).toBeGreaterThan(0);

    const cards = screen.getAllByRole("button", { name: /현재 작업 조정/ });
    await user.click(cards[cards.length - 1] as HTMLElement);
    expect(screen.getByRole("status", { name: "알림" })).toHaveTextContent(
      "대기 지시를 안전한 실행 경계에서 지금 반영하도록 변경했습니다",
    );
  });

  // 폼이 스스로 막는 것과 도메인이 거절하는 것은 다릅니다. 둘 다 사람이 읽을 수 있어야 합니다.
  it("팀 편성 폼이 handle과 필수 항목을 막고, 막지 못한 것은 거절 사유를 그대로 보여준다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "조직" }));
    expect(await screen.findByRole("main", { name: "조직" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^Atlas/ }));
    await user.click(screen.getByRole("button", { name: "여기 아래 팀 만들기" }));

    // 라벨은 눈에 보여야 합니다. placeholder는 글자를 넣는 순간 사라집니다.
    const handleField = screen.getByRole("textbox", { name: "handle" });
    expect(handleField).toHaveFocus();
    const nameField = screen.getByRole("textbox", { name: "이름" });
    const responsibilityField = screen.getByRole("textbox", { name: "책임" });

    await user.click(screen.getByRole("button", { name: "편성" }));
    expect(screen.getByRole("alert")).toHaveTextContent("handle은 소문자·숫자·하이픈만 쓰고 소문자로 시작합니다.");

    await user.type(handleField, "Refund-Analysis");
    await user.click(screen.getByRole("button", { name: "편성" }));
    expect(screen.getByRole("alert")).toHaveTextContent("handle은 소문자·숫자·하이픈만 쓰고 소문자로 시작합니다.");

    await user.clear(handleField);
    await user.type(handleField, "refund-analysis");
    await user.click(screen.getByRole("button", { name: "편성" }));
    expect(screen.getByRole("alert")).toHaveTextContent("이름과 책임을 모두 적어야 합니다.");

    await user.type(nameField, "환불 분석");
    await user.type(responsibilityField, "환불 지연 구간 조사");
    await user.click(screen.getByRole("button", { name: "편성" }));

    // Fixture에는 조직 원장이 없습니다. 편성된 척 그리지 않고 거절 사유를 그대로 세웁니다.
    expect(await screen.findByRole("alert")).toHaveTextContent("Fixture는 조직 편성을 구성하지 않았습니다: create");
    expect(screen.getByRole("textbox", { name: "handle" })).toHaveValue("refund-analysis");

    // 다른 자리를 고르면 앞 자리에 적던 입력과 앞 자리의 거절 사유를 버립니다.
    // 남겨 두면 화면은 Vega를 보여 주면서 Atlas에 적던 내용을 Vega 아래로 편성합니다.
    await user.click(screen.getByRole("button", { name: /^Vega/ }));
    expect(screen.queryByRole("textbox", { name: "handle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "여기 아래 팀 만들기" })).toBeInTheDocument();
  });
});
