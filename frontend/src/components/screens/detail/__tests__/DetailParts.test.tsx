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

import { LinkListPanel, PriceChartPanel, propertyItems } from "../DetailParts";

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
    expect(line.className).toContain("min-h-5");
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

  it("기간을 누르면 그 기간 시계열을 읽는다(기본 1년)", async () => {
    reads[TICKER] = { available: true, points: [{ date: "2026-11-14", close: 11 }] };
    render(<PriceChartPanel title="합성 종목 시세" symbol="SYNQ" valueDigits={2} />);
    await screen.findByRole("img", { name: "합성 종목 시세 가격 차트" });
    fireEvent.click(screen.getByRole("tab", { name: "5년" }));
    await waitFor(() => expect(api.apiGetShared.mock.calls.map(([path]) => path)).toContain(endpoints.macro.ticker("SYNQ", "5y")));
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
