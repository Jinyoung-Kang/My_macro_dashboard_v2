/**
 * 상세 화면 공용 부품(DetailParts) — 가격 차트 패널(PriceChartPanel)·링크 목록(LinkListPanel)·속성 줄 바꾸기(propertyItems). 응답은 모두 합성 값입니다.
 *
 * 가격 차트 패널: 이름 있는 영역(제목) · 기간 탭 · 차트 이름 · 문지르기 읽기 줄(눈으로 보는 줄 aria-hidden + 조용한 알림 영역 '날짜 값') · 출처 캡션.
 * 네 상태 — 불러오는 중(Skeleton role=status), 차트 없음(이유 글, 기간 탭 없음), 오류(다시 시도), 값 있음(차트와 읽기 줄).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpoints } from "@/lib/endpoints";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const charts = vi.hoisted(() => ({ last: null as null | { onScrub?: (index: number | null) => void } }));
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel, onScrub }: { ariaLabel?: string; onScrub?: (index: number | null) => void }) => {
    charts.last = { onScrub };
    return <div role="img" aria-label={ariaLabel} />;
  },
}));

import { LinkListPanel, PriceChartPanel, PriceHero, propertyItems } from "../DetailParts";

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  charts.last = null;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

const TICKER = endpoints.macro.ticker("SYNQ", "1y");

describe("가격 차트 패널", () => {
  it("값 있음 — 영역 이름·기간 탭·차트 이름·캡션, 문지르면 읽기 줄에 날짜·값·단위·기간 시작 대비, 알림 영역이 '날짜 값 단위'", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-12", close: 10 }, { date: "2026-11-13", close: 9.5 }, { date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 종목 시세" symbol="SYNQ" valueDigits={2} unit="USD" caption="차트: Yahoo Finance SYNQ 일별 종가" />);
    const panel = screen.getByRole("region", { name: "합성 종목 시세" });
    expect(within(panel).getByRole("heading", { level: 2, name: "합성 종목 시세" })).toBeTruthy();
    expect(within(panel).getByRole("tablist", { name: "합성 종목 시세 차트 기간" })).toBeTruthy();
    expect(await within(panel).findByRole("img", { name: "합성 종목 시세 가격 차트" })).toBeTruthy();
    expect(within(panel).getByText("차트: Yahoo Finance SYNQ 일별 종가")).toBeTruthy();

    // 문지르기 전: 같은 자리에 안내(줄 높이를 지킴), 알림 영역은 비어 있음
    expect(within(panel).getByText("차트를 누르거나 가리키면 그 날 값")).toBeTruthy();
    const live = panel.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe("");

    act(() => charts.last?.onScrub?.(2));
    const value = within(panel).getByText("11.00");
    const line = value.closest('[aria-hidden="true"]') as HTMLElement;
    expect(line).not.toBeNull();
    // 줄 높이 고정 — 좁은 칸은 두 줄 자리, 칸이 26rem 이상이면 한 줄(QA-571, 아래 시험이 안내·문지른 상태를 함께 봄)
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-[2.375rem]", "@min-[26rem]:min-h-5"]));
    expect(within(line).getByText("2026-11-14")).toBeTruthy();
    expect(within(line).getByText("USD")).toBeTruthy();
    expect(within(line).getByText("기간 시작 대비")).toBeTruthy();
    // 기간 시작(10) 대비 +1.00(+10.00%) — 칩의 방향 글은 낭독용 sr-only
    expect(line.textContent).toContain("+1.00");
    expect(line.textContent).toContain("+10.00%");
    expect(live.textContent).toBe("2026-11-14 11.00 USD");

    act(() => charts.last?.onScrub?.(null));
    expect(within(panel).getByText("차트를 누르거나 가리키면 그 날 값")).toBeTruthy();
    expect(live.textContent).toBe("");
  });

  // QA-571: 읽기 줄이 min-h-5(20px) 한 줄 자리만 잡아, 좁은 화면(390 — 줄 폭 332px)에서 문지른 내용(날짜·값·단위·칩·'기간 시작 대비' 약 350~390px)이
  // 두 줄(38px)로 늘며 차트가 18px 아래로 밀렸습니다(손가락 아래에서 차트가 움직임 — 진행 기록 §P4 '정한 것' 2의 줄 높이 고정과 어긋남).
  // 고친 뒤: 좁은 칸은 처음부터 두 줄 자리(2.375rem = 38px), 칸이 26rem 이상이면 한 줄(20px) — 처음 고칠 때는 sm(뷰포트) 기준이었고 아래 검토 시험이 칸 폭으로 바꿈.
  // jsdom은 배치를 재지 못하므로 안내·문지른 상태가 같은 요소이고 두 클래스를 함께 가지는지 봅니다(높이는 브라우저 하네스로 잼).
  // 수정 전 실패: 읽기 줄 클래스가 min-h-5뿐(min-h-[2.375rem] 없음)(재현 커밋에서는 it.fails).
  it("읽기 줄은 좁은 칸에서 두 줄 자리를 늘 잡아 둔다 — 안내와 문지른 상태가 같은 요소이고 min-h-[2.375rem]·@min-[26rem]:min-h-5", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-12", close: 10 }, { date: "2026-11-13", close: 9.5 }, { date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 종목 시세" symbol="SYNQ" valueDigits={2} unit="원" />);
    const panel = screen.getByRole("region", { name: "합성 종목 시세" });
    await within(panel).findByRole("img", { name: "합성 종목 시세 가격 차트" });
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    const hintLine = within(panel).getByText("차트를 누르거나 가리키면 그 날 값").closest('[aria-hidden="true"]') as HTMLElement;
    expect(tokens(hintLine)).toEqual(expect.arrayContaining(["min-h-[2.375rem]", "@min-[26rem]:min-h-5"]));
    expect(tokens(hintLine)).not.toContain("min-h-5");
    act(() => charts.last?.onScrub?.(2));
    const heldLine = within(panel).getByText("11.00").closest('[aria-hidden="true"]') as HTMLElement;
    expect(heldLine).toBe(hintLine);
    expect(tokens(heldLine)).toEqual(expect.arrayContaining(["min-h-[2.375rem]", "@min-[26rem]:min-h-5"]));
  });

  // QA-571 검토: 줄이 접히는지는 화면 폭이 아니라 가운데 칸의 폭에 달렸습니다. 가변 폭 왼쪽 메뉴(206~320px, 계정 메뉴 '넓게' 280)가 넓으면 xl 가운데
  // 칸이 434px보다 좁아져 sm 이상의 한 줄 자리(min-h-5)를 넘고(1280·메뉴 320 → 읽기 줄 334px, 메뉴 280 → 374px, 1024·메뉴 320 → 382px — 문지르면
  // 20 → 38px, 차트 18px 이동), 반대로 480~639는 한 줄에 들어가는데도 두 줄 자리를 잡았습니다(QA 스택 fcbb4861에서 --shell-nav-w를 바꿔 잼).
  // 고친 뒤: 읽기 줄을 감싼 상자가 크기 질의 기준(@container)이고, 칸이 26rem(416px — 가장 긴 내용 약 413px, BRK-A 'USD' 줄) 이상일 때만 한 줄 자리.
  // 수정 전 실패: 읽기 줄의 부모에 @container가 없고 한 줄 자리가 뷰포트 기준(sm:min-h-5)(재현 커밋에서는 it.fails).
  it("읽기 줄의 한 줄 자리는 화면 폭이 아니라 칸 폭으로 정한다 — 부모가 @container이고 @min-[26rem]:min-h-5, 뷰포트 기준 sm:min-h-5는 없다", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-12", close: 10 }, { date: "2026-11-13", close: 9.5 }, { date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 종목 시세" symbol="SYNQ" valueDigits={2} unit="USD" />);
    const panel = screen.getByRole("region", { name: "합성 종목 시세" });
    await within(panel).findByRole("img", { name: "합성 종목 시세 가격 차트" });
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const line = within(panel).getByText("차트를 누르거나 가리키면 그 날 값").closest('[aria-hidden="true"]') as HTMLElement;
    expect({ line: tokens(line).filter((token) => token.includes("min-h")).sort(), parent: tokens(line.parentElement!).includes("@container") }).toEqual({
      line: ["@min-[26rem]:min-h-5", "min-h-[2.375rem]"],
      parent: true,
    });
  });

  it("기간을 누르면 그 기간 시계열을 읽는다(기본 1년)", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 종목 시세" symbol="SYNQ" valueDigits={2} />);
    await screen.findByRole("img", { name: "합성 종목 시세 가격 차트" });
    fireEvent.click(screen.getByRole("tab", { name: "5년" }));
    await waitFor(() => expect(api.apiGetShared.mock.calls.map(([path]) => path)).toContain(endpoints.macro.ticker("SYNQ", "5y")));
  });

  // 기간마다 서버(GET /api/macro/ticker → 백엔드 → 수집기 → Yahoo)를 부르므로 기간 탭은 수동 활성 — 화살표로 지나가는 기간은 부르지 않고 Enter로 고른 기간만
  // 부릅니다(QA 스택에서 5년 → ← 세 번이 1y·6mo·1mo 세 요청을 냈음).
  it("기간 탭을 화살표로 지나가도 시계열을 부르지 않고, Enter로 고른 기간만 부른다", async () => {
    const tnx = (period: string) => endpoints.macro.ticker("^TNX", period);
    reads[tnx("1y")] = { available: true, points: [{ date: "2026-11-14", close: 4.1 }] };
    render(<PriceChartPanel title="미국채 10년물" symbol="^TNX" valueDigits={3} />);
    await screen.findByRole("img", { name: "미국채 10년물 가격 차트" });
    const tickerCalls = () => api.apiGetShared.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith("/api/macro/ticker"));
    expect(tickerCalls()).toEqual([tnx("1y")]);
    const year = screen.getByRole("tab", { name: "1년" });
    year.focus();
    fireEvent.keyDown(year, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "1개월" }));
    await act(async () => {});
    expect(tickerCalls()).toEqual([tnx("1y")]);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(tickerCalls()).toEqual([tnx("1y"), tnx("1mo")]));
    expect(screen.getByRole("tab", { name: "1개월" }).getAttribute("aria-selected")).toBe("true");
  });

  // 종목 팝업 창(StockQuickView — 모의·실제 계좌·ISA 표의 종목 링크)의 시세 히어로도 같은 시계열을 기간마다 부르므로 같은 수동 활성입니다
  // (QA 스택 /paper/us/holdings AMZN 팝업에서 1년 → ← 세 번이 6mo·1mo·5y 세 요청을 냈음 — 개편 전 PriceHero부터 있던 자동 활성).
  it("종목 팝업 창의 시세 히어로도 기간 탭을 화살표로 지나가면 부르지 않고, Enter로 고른 기간만 부른다", async () => {
    const amzn = (period: string) => endpoints.macro.ticker("AMZN", period);
    reads[amzn("1y")] = { available: true, points: [{ date: "2026-11-14", close: 230.5 }] };
    render(<PriceHero label="Amazon.com, Inc." valueText="230.50" unit="USD" change={null} changePct={null} symbol="AMZN" valueDigits={2} />);
    await screen.findByRole("img", { name: "Amazon.com, Inc. 가격 차트" });
    const tickerCalls = () => api.apiGetShared.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith("/api/macro/ticker"));
    expect(tickerCalls()).toEqual([amzn("1y")]);
    const year = screen.getByRole("tab", { name: "1년" });
    year.focus();
    fireEvent.keyDown(year, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "1개월" }));
    await act(async () => {});
    expect(tickerCalls()).toEqual([amzn("1y")]);
    expect(screen.getByRole("tab", { name: "1년" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(tickerCalls()).toEqual([amzn("1y"), amzn("1mo")]));
    expect(screen.getByRole("tab", { name: "1개월" }).getAttribute("aria-selected")).toBe("true");
  });

  it("불러오는 중은 Skeleton(role=status), 오류는 다시 시도, 받지 않음은 그 글", async () => {
    const { unmount } = render(<PriceChartPanel title="합성 시세" symbol="SYNQ" valueDigits={2} />);
    expect(screen.getByRole("status", { name: "차트를 불러오는 중" })).toBeTruthy();
    unmount();

    reads[TICKER] = new Error("시계열 서버가 응답하지 않습니다.");
    const second = render(<PriceChartPanel title="합성 시세" symbol="SYNQ" valueDigits={2} />);
    expect(await screen.findByText("시계열 서버가 응답하지 않습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    // 차트가 없으면 읽기 줄·알림 영역도 없음
    expect(screen.queryByText("차트를 누르거나 가리키면 그 날 값")).toBeNull();
    second.unmount();

    reads[TICKER] = { available: false, message: "store_only 모드에서는 시계열을 조회하지 않습니다.", points: [] };
    render(<PriceChartPanel title="합성 시세" symbol="SYNQ" valueDigits={2} />);
    expect(await screen.findByText("store_only 모드에서는 시계열을 조회하지 않습니다.")).toBeTruthy();
  });

  it("심볼이 없으면 차트·기간 탭 없이 이유 한 줄 — 시계열을 부르지 않는다", () => {
    render(<PriceChartPanel title="코스피200 야간선물" symbol={null} valueDigits={2} noChartReason="이 카드는 Yahoo 티커가 없어 차트를 그리지 않습니다." />);
    const panel = screen.getByRole("region", { name: "코스피200 야간선물" });
    expect(within(panel).getByText("이 카드는 Yahoo 티커가 없어 차트를 그리지 않습니다.")).toBeTruthy();
    expect(within(panel).queryByRole("tablist")).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });

  it("문지른 날 값이 없으면 '—'(값 없음)이고 단위·칩을 붙이지 않는다", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-12", close: 10 }, { date: "2026-11-13", close: null }, { date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 시세" symbol="SYNQ" valueDigits={2} unit="USD" />);
    await screen.findByRole("img", { name: "합성 시세 가격 차트" });
    act(() => charts.last?.onScrub?.(1));
    const panel = screen.getByRole("region", { name: "합성 시세" });
    const live = panel.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe("2026-11-13 —");
    expect(within(panel).queryByText("USD")).toBeNull();
    expect(within(panel).queryByText("기간 시작 대비")).toBeNull();
  });

  // QA-579 후속 — 출처 캡션은 선을 그렸을 때만, 그림 상태는 onDrawState로 화면('출처' 패널 '차트' 줄)에 알린다.
  it("그림 상태 — 불러오는 중 loading → 그리면 drawn(캡션 보임), 사유 있는 available:false unavailable·사유 없음·값 없음 empty·읽기 실패 failed·심볼 없음 none(캡션 없음)", async () => {
    const CAPTION = "차트: Yahoo Finance SYNQ 일별 종가";
    const states: string[] = [];
    const onDrawState = (state: string) => void states.push(state);
    const draw = (symbol: string | null = "SYNQ") =>
      render(<PriceChartPanel title="합성 시세" symbol={symbol} valueDigits={2} caption={CAPTION} onDrawState={onDrawState} />);

    let resolve: (body: unknown) => void = () => {};
    api.apiGetShared.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    draw();
    expect(states).toEqual(["loading"]);
    expect(screen.queryByText(CAPTION)).toBeNull();
    await act(async () => resolve({ available: true, points: [{ date: "2026-11-13", close: 10 }, { date: "2026-11-14", close: 11 }] }));
    expect(states).toEqual(["loading", "drawn"]);
    expect(screen.getByText(CAPTION)).toBeTruthy();
    cleanup();

    for (const [body, state] of [
      [{ available: false, message: "외부 소스에서 시계열을 받지 못했습니다: 합성 실패", points: [] }, "unavailable"],
      [{ available: false, points: [] }, "empty"],
      [{ available: true, points: [{ date: "2026-11-14", close: null }] }, "empty"],
      [new Error("차트 서버 오류"), "failed"],
    ] as const) {
      states.length = 0;
      reads[TICKER] = body;
      draw();
      await waitFor(() => expect(states.at(-1)).toBe(state));
      expect(screen.queryByText(CAPTION)).toBeNull();
      cleanup();
    }

    states.length = 0;
    draw(null);
    expect(states).toEqual(["none"]);
    expect(screen.queryByText(CAPTION)).toBeNull();
  });
});

describe("링크 목록 패널", () => {
  it("앱 안 주소는 링크, 바깥 주소는 새 창(noopener) — 따로 선 링크라 좁은 화면 44px, 비면 그리지 않음", () => {
    const { container, unmount } = render(<LinkListPanel title="연결" links={[]} />);
    expect(container.innerHTML).toBe("");
    unmount();

    render(
      <LinkListPanel
        title="연결"
        links={[
          { label: "S&P 500 지표 상세", href: "/markets/i/sp500" },
          { label: "SEC EDGAR", href: "https://www.sec.gov/x", external: true },
          { label: "이상한 주소", href: "javascript:alert(1)", external: true },
        ]}
      />,
    );
    const panel = screen.getByRole("heading", { level: 2, name: "연결" }).closest("section") as HTMLElement;
    const inner = within(panel).getByRole("link", { name: "S&P 500 지표 상세" });
    expect(inner.getAttribute("href")).toBe("/markets/i/sp500");
    const outer = within(panel).getByRole("link", { name: /SEC EDGAR/ });
    expect(outer.getAttribute("target")).toBe("_blank");
    expect(outer.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(panel).getByText("이상한 주소").closest("a")).toBeNull();
    for (const link of [inner, outer]) expect(belowLgTarget(link.getAttribute("class") ?? "")).toBeNull();
  });
});

describe("속성 줄 바꾸기", () => {
  it("link가 있으면 값 글을 그 링크로(바깥은 새 창), 값이 없으면 링크를 만들지 않는다", () => {
    const items = propertyItems([
      { label: "홈페이지", value: "apple.com", link: { href: "https://www.apple.com", external: true } },
      { label: "지표", value: "S&P 500", link: { href: "/markets/i/sp500", external: false } },
      { label: "없음", value: null, link: { href: "/x", external: false } },
      { label: "글", value: "그대로" },
    ]);
    render(
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value as React.ReactNode}</dd>
          </div>
        ))}
      </dl>,
    );
    expect(screen.getByRole("link", { name: /apple\.com/ }).getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: "S&P 500" }).getAttribute("href")).toBe("/markets/i/sp500");
    expect(items[2]).toEqual({ label: "없음", value: null });
    expect(items[3]).toEqual({ label: "글", value: "그대로" });
  });
});
