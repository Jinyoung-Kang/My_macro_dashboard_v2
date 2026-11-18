/**
 * QA-737 — 모의 좁은 표 칸에서 한글이 글자 단위로 끊김(진행 기록 넘긴 항목 paper-table-korean-char-wrap): '매/수'·'방/향'·'사후/체결'·'15거래/일'
 * (미국 보유 기간 칸 모든 행 72px). 한국어 글은 CSS 기본(word-break normal)에서 음절 사이 어디서나 줄을 바꿉니다 — 짧은 낱말 칸(방향·출처)은 줄을
 * 바꾸지 않고(whitespace-nowrap), 보유 기간 칸은 낱말 사이에서만(break-keep) + 날짜 한 줄 최소 폭을 둡니다(한국 표와 같은 규칙).
 * 대상: 보유·체결 탭의 미국 보유·주문·체결 표, 개요 계좌 상세의 최근 체결 표. 한국 표는 이미 같은 규칙입니다(그대로).
 *
 * jsdom은 배치를 계산하지 않으므로 칸의 클래스로 봅니다(브라우저 390 잰 값은 커밋 본문).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import { AccountDetailPanel } from "@/components/screens/paper/AccountDetailPanel";
import { HoldingsSection } from "@/components/screens/paper/HoldingsSection";

const BOOK = {
  code: "rules", kind: "RULES", label: "규칙 계좌", status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200,
  equityValue: 100700, exposurePct: 99.5, returnPct: 1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: null,
  benchmark: null,
};
const POSITION = {
  ticker: "NVDA", qty: 10, avgCost: 200, lastPrice: 202, lastPriceAtKst: null, marketValue: 2020, weightPct: 2, unrealizedPct: 1,
  highWatermark: 205, stopPrice: 188.6, stopDistancePct: 6.6, openedOn: "2026-10-23", holdingTradingDays: 15, priceStale: false,
  splitNote: null, cashLike: false, backfilled: false,
};
const ORDER = {
  id: 7, ticker: "NVDA", side: "BUY", qty: 10, targetWeightPct: null, sellFraction: null, timing: "NEXT_OBSERVATION", source: "BACKFILL",
  status: "FILLED", rejectReason: null, reason: null, asOfTradingDate: "2026-10-23", createdAtKst: "2026-10-24 05:00", expiresOn: null,
  filledAtKst: "2026-10-24 05:00",
};
const FILL = {
  id: 7, orderId: 7, ticker: "NVDA", side: "BUY", qty: 10, price: 202.4101, rawPrice: 202.31, slippageBp: 5, gross: 2024.1,
  observedAtKst: "2026-10-24 05:00", observationDate: "2026-10-23", priceSource: "equity_close", backfill: true,
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.includes("/positions")) return Promise.resolve({ available: true, book: BOOK, cash: 500, lockouts: [], positions: [POSITION] });
    if (path.includes("/orders")) return Promise.resolve({ available: true, orders: [ORDER] });
    if (path.includes("/fills")) return Promise.resolve({ available: true, fills: [FILL] });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

const settled = () => act(async () => {});
/** 표에서 머리 글이 `header`인 열의 칸들(머리 포함). */
function column(table: HTMLElement, header: string): HTMLElement[] {
  const heads = within(table).getAllByRole("columnheader");
  const index = heads.findIndex((th) => th.textContent === header);
  if (index < 0) throw new Error(`열 없음: ${header}`);
  const body = within(table).getAllByRole("row").slice(1).map((tr) => tr.children[index] as HTMLElement);
  return [heads[index], ...body];
}
const classes = (element: HTMLElement) => element.className.split(/\s+/);

describe("QA-737 — 모의 표의 짧은 한국어 칸은 글자 사이에서 끊기지 않는다", () => {
  it.fails("보유·체결(미국): 방향·출처 칸은 줄바꿈 없음, 보유 기간 칸은 낱말 사이에서만 + 최소 폭", async () => {
    render(<HoldingsSection books={[BOOK] as never} onChanged={() => {}} />);
    await settled();
    const positions = screen.getByRole("table", { name: "보유" });
    for (const cell of column(positions, "보유 기간").slice(1)) {
      expect(classes(cell)).toContain("break-keep");
      expect(cell.className).toMatch(/min-w-\[/);
    }
    const orders = screen.getByRole("table", { name: "주문" });
    for (const cell of [...column(orders, "방향").slice(1), ...column(orders, "출처").slice(1)]) {
      expect(classes(cell), cell.textContent ?? "").toContain("whitespace-nowrap");
    }
    const fills = screen.getByRole("table", { name: "체결" });
    for (const cell of column(fills, "방향").slice(1)) expect(classes(cell)).toContain("whitespace-nowrap");
  });

  it.fails("개요 계좌 상세의 최근 체결: 방향 머리·칸은 줄바꿈 없음", async () => {
    render(<AccountDetailPanel id="detail" book={BOOK as never} books={[BOOK] as never} onClose={() => {}} />);
    await settled();
    const table = within(screen.getByRole("region", { name: "최근 체결" })).getByRole("table");
    for (const cell of column(table, "방향")) expect(classes(cell), cell.tagName).toContain("whitespace-nowrap");
  });
});
