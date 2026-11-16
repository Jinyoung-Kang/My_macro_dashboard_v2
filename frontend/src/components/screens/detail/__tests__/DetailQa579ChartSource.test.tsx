/**
 * 종목 상세 — 시세를 읽지 못했거나(500) 조회하지 않을 때(available:false) 차트의 출처(QA-579). 응답은 모두 합성 값입니다.
 *
 * 차트는 시세가 없어도 코드로 정한 Yahoo 심볼(lib/detail chartSymbol)로 시계열을 읽어 그립니다. 그런데 차트 출처 캡션과 '출처' 패널의 '차트' 줄은
 * 시세가 있을 때만 나와, 그려진 차트가 출처 없이 보이고 출처 패널은 '차트 — 값 없음'이라고 적었습니다(PRINCIPLES '모든 숫자에 출처'). 지표 상세처럼
 * 심볼을 기준으로 적습니다 — 종목 상세의 심볼은 늘 있습니다.
 *
 * 후속(검토 지적 — 2026-11-16 결정 반영 묶음): 심볼 기준으로 늘 적으니 차트를 그리지 못한 경우(시계열 없음·읽기 실패·불러오는 중, 시세가 실패한
 * 코스닥 종목의 .KS 어림 심볼)에도 캡션과 '차트' 출처 줄이 붙어, 없는 차트의 출처를 적었습니다. 선을 실제로 그렸을 때만 적고, 아니면 '차트' 줄은
 * '—'와 짧은 까닭입니다(지표 상세도 같은 가격 차트 패널이라 같음).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "../IndicatorDetailScreen";
import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUOTE = endpoints.detail.quote("us", "AAPL");
const TICKER = endpoints.macro.ticker("AAPL", "1y");
const SERIES = { available: true, points: [{ date: "2026-10-29", close: 348.9 }, { date: "2026-10-30", close: 344.6 }] };

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

/** 차트가 그려진 뒤 'AAPL 시세' 영역의 캡션과 '출처' 패널 '차트' 줄의 값 칸. */
async function chartSourceOf(quote: unknown) {
  reads = { [QUOTE]: quote, [TICKER]: SERIES };
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market="us" code="AAPL" />
    </SessionUserProvider>,
  );
  const hero = await screen.findByRole("region", { name: "AAPL 시세" });
  await waitFor(() => expect(within(hero).getByRole("img", { name: "AAPL 시세 가격 차트" })).toBeTruthy());
  const sources = screen.getByRole("heading", { level: 2, name: "출처" }).closest("section") as HTMLElement;
  const row = within(sources).getByText("차트").closest("div") as HTMLElement;
  return { hero, value: row.querySelector("dd") as HTMLElement };
}

describe("종목 상세 — 시세 없이 그린 차트의 출처 (QA-579)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 두 경우 모두 캡션이 없고(시세 영역 안 '차트:' 글 0) 출처 패널 '차트' 줄이 '—값 없음'이었습니다.
  it("시세 읽기가 실패해도(500) 차트를 그렸으면 캡션과 '차트' 출처 줄에 Yahoo 심볼을 적는다", async () => {
    const { hero, value } = await chartSourceOf(new Error("시세 서버가 응답하지 않습니다."));
    expect(within(hero).getByText("차트: Yahoo Finance AAPL 일별 종가")).toBeTruthy();
    expect(value.textContent).toBe("Yahoo Finance AAPL 일별 종가");
  });

  it("시세를 조회하지 않아도(available:false) 차트를 그렸으면 캡션과 '차트' 출처 줄에 Yahoo 심볼을 적는다", async () => {
    const { hero, value } = await chartSourceOf({ available: false, message: "수집기에서 응답을 받지 못했습니다." });
    expect(within(hero).getByText("차트: Yahoo Finance AAPL 일별 종가")).toBeTruthy();
    expect(value.textContent).toBe("Yahoo Finance AAPL 일별 종가");
  });
});

/** 차트 상태별로 'AAPL 시세'(또는 `region`) 영역과 '출처' 패널 '차트' 줄의 값 칸 — 차트가 그려지기를 기다리지 않습니다. */
function renderStock(market: "us" | "kr", code: string, quote: unknown, ticker: unknown, symbol = code) {
  reads = { [endpoints.detail.quote(market, code)]: quote };
  if (ticker !== PENDING) reads[endpoints.macro.ticker(symbol, "1y")] = ticker;
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market={market} code={code} />
    </SessionUserProvider>,
  );
}

const PENDING = Symbol("pending");

/** 백엔드가 수집기의 외부 소스 실패 사유를 실어 돌려주는 available:false 글(MacroService tickerSeries)의 꼴. */
const UPSTREAM_FAILED = "외부 소스에서 시계열을 받지 못했습니다: Yahoo 연결 실패";

function renderIndicator(ticker: unknown) {
  reads = {
    [endpoints.macro.overview(false)]: macroOverview(),
    "/api/calendar/kr-holidays": { available: true, years: {} },
    [endpoints.macro.ticker("^GSPC", "1y")]: ticker,
  };
  render(
    <SessionUserProvider user={MEMBER}>
      <IndicatorDetailScreen indicatorKey="sp500" />
    </SessionUserProvider>,
  );
}

function sourceRow() {
  const sources = screen.getByRole("heading", { level: 2, name: "출처" }).closest("section") as HTMLElement;
  return (within(sources).getByText("차트").closest("div") as HTMLElement).querySelector("dd") as HTMLElement;
}

describe("종목·지표 상세 — 그리지 못한 차트에는 출처를 적지 않는다 (QA-579 후속)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 모든 경우에 차트 영역에 '차트: Yahoo Finance … 일별 종가' 캡션이 있고 '차트' 줄도 그 글이었습니다.
  it.each([
    // 백엔드는 수집기가 빈 시계열을 사유 없이 주면 message 없이 available:false — 차트 칸은 기본 글 '표시할 시계열이 없습니다.'.
    ["시계열 없음(available:false, 사유 없음)", { available: false, points: [] }, "표시할 시계열이 없습니다.", "시계열 없음"],
    // 값이 없는 시계열의 안내 글은 차트 부품(LineChart — 이 시험에서는 이름만 둔 가짜)이 그리므로 여기서는 불러오기가 끝난 것만 기다립니다.
    ["값이 하나도 없는 시계열", { available: true, points: [{ date: "2026-10-30", close: null }] }, null, "시계열 없음"],
    ["시계열 읽기 실패", new Error("차트 서버가 응답하지 않습니다."), "차트 서버가 응답하지 않습니다.", "차트를 받지 못함"],
  ])("%s — 캡션 없음, '차트' 줄은 '—'와 까닭", async (_case, ticker, shown, reason) => {
    renderStock("us", "AAPL", new Error("시세 서버가 응답하지 않습니다."), ticker);
    const hero = await screen.findByRole("region", { name: "AAPL 시세" });
    await waitFor(() => expect(within(hero).queryByRole("status", { name: "차트를 불러오는 중" })).toBeNull());
    if (shown) expect(within(hero).getByText(shown)).toBeTruthy();
    expect(within(hero).queryByText(/^차트:/)).toBeNull();
    await waitFor(() => expect(sourceRow().textContent).toContain(reason));
    expect(sourceRow().textContent).not.toContain("Yahoo Finance");
    expect(sourceRow().textContent?.startsWith("—")).toBe(true);
  });

  it("불러오는 중에는 캡션 없음, '차트' 줄은 '—' 불러오는 중", async () => {
    renderStock("us", "AAPL", new Error("시세 서버가 응답하지 않습니다."), PENDING);
    const hero = await screen.findByRole("region", { name: "AAPL 시세" });
    expect(within(hero).getByRole("status", { name: "차트를 불러오는 중" })).toBeTruthy();
    expect(within(hero).queryByText(/^차트:/)).toBeNull();
    expect(sourceRow().textContent).toContain("차트를 불러오는 중");
    expect(sourceRow().textContent).not.toContain("Yahoo Finance");
  });

  it("시세가 실패한 국내 종목의 .KS 어림 심볼로 시계열을 받지 못하면 캡션·출처 줄에 .KS 심볼을 적지 않는다", async () => {
    renderStock("kr", "123456", new Error("시세 서버가 응답하지 않습니다."), { available: false, message: UPSTREAM_FAILED, points: [] }, "123456.KS");
    const hero = await screen.findByRole("region", { name: "123456 시세" });
    await waitFor(() => expect(within(hero).getByText(UPSTREAM_FAILED)).toBeTruthy());
    expect(within(hero).queryByText(/^차트:/)).toBeNull();
    await waitFor(() => expect(sourceRow().textContent).not.toContain("불러오는 중"));
    expect(sourceRow().textContent?.startsWith("—")).toBe(true);
    expect(sourceRow().textContent).not.toContain("123456.KS");
  });

  it("지표 상세도 같다 — 시계열이 없으면 캡션 없음, '차트' 줄은 '—' 시계열 없음", async () => {
    renderIndicator({ available: false, points: [] });
    const hero = await screen.findByRole("region", { name: "S&P 500" });
    await waitFor(() => expect(within(hero).getByText("표시할 시계열이 없습니다.")).toBeTruthy());
    expect(within(hero).queryByText(/^차트:/)).toBeNull();
    await waitFor(() => expect(sourceRow().textContent).toContain("시계열 없음"));
    expect(sourceRow().textContent).not.toContain("Yahoo Finance");
  });

  it("그린 차트에는 지금처럼 캡션과 '차트' 출처 줄(지표 상세)", async () => {
    reads = {
      [endpoints.macro.overview(false)]: macroOverview(),
      "/api/calendar/kr-holidays": { available: true, years: {} },
      [endpoints.macro.ticker("^GSPC", "1y")]: SERIES,
    };
    render(
      <SessionUserProvider user={MEMBER}>
        <IndicatorDetailScreen indicatorKey="sp500" />
      </SessionUserProvider>,
    );
    const hero = await screen.findByRole("region", { name: "S&P 500" });
    await waitFor(() => expect(within(hero).getByRole("img", { name: "S&P 500 가격 차트" })).toBeTruthy());
    expect(within(hero).getByText("차트: Yahoo Finance ^GSPC 일별 종가")).toBeTruthy();
    expect(sourceRow().textContent).toBe("Yahoo Finance ^GSPC 일별 종가");
  });
});

// 검토 지적(QA-579 후속): available:false는 백엔드가 상류 실패(수집기 응답 없음·외부 소스 실패 사유)에도 돌려주고, 그때 차트 칸은 '…시계열을 받지
// 못했습니다'라고 적는데 '차트' 줄은 늘 '시계열 없음'이라 두 글이 어긋났습니다. 사유 글이 있으면 '시계열을 받지 못함', 없으면(빈 시계열) '시계열 없음'.
describe("'차트' 줄 까닭 — 시계열을 받지 못함과 시계열 없음을 가른다 (QA-579 후속)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 두 화면 모두 '— 시계열 없음'이었습니다.
  it("종목 — 외부 소스 실패(available:false + 사유)는 '—' 시계열을 받지 못함", async () => {
    renderStock("us", "AAPL", new Error("시세 서버가 응답하지 않습니다."), { available: false, message: UPSTREAM_FAILED, points: [] });
    const hero = await screen.findByRole("region", { name: "AAPL 시세" });
    await waitFor(() => expect(within(hero).getByText(UPSTREAM_FAILED)).toBeTruthy());
    await waitFor(() => expect(sourceRow().textContent).toContain("시계열을 받지 못함"));
    expect(sourceRow().textContent?.startsWith("—")).toBe(true);
    expect(sourceRow().textContent).not.toContain("Yahoo Finance");
  });

  it("지표 — 수집기 응답 없음(available:false + 사유)은 '—' 시계열을 받지 못함", async () => {
    renderIndicator({ available: false, message: "수집기에서 시계열을 받지 못했습니다.", points: [] });
    const hero = await screen.findByRole("region", { name: "S&P 500" });
    await waitFor(() => expect(within(hero).getByText("수집기에서 시계열을 받지 못했습니다.")).toBeTruthy());
    await waitFor(() => expect(sourceRow().textContent).toContain("시계열을 받지 못함"));
    expect(sourceRow().textContent).not.toContain("Yahoo Finance");
  });
});
