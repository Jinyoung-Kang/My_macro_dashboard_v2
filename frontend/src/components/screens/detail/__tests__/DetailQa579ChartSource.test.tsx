/**
 * 종목 상세 — 시세를 읽지 못했거나(500) 조회하지 않을 때(available:false) 차트의 출처(QA-579). 응답은 모두 합성 값입니다.
 *
 * 차트는 시세가 없어도 코드로 정한 Yahoo 심볼(lib/detail chartSymbol)로 시계열을 읽어 그립니다. 그런데 차트 출처 캡션과 '출처' 패널의 '차트' 줄은
 * 시세가 있을 때만 나와, 그려진 차트가 출처 없이 보이고 출처 패널은 '차트 — 값 없음'이라고 적었습니다(PRINCIPLES '모든 숫자에 출처'). 지표 상세처럼
 * 심볼을 기준으로 적습니다 — 종목 상세의 심볼은 늘 있습니다.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

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
