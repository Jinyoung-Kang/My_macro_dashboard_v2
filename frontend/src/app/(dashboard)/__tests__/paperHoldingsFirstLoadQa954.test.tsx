/**
 * 보유·체결 탭 첫 적재 자리 — QA-954(작업대 P8 후속, 결정 거리 `paper-first-load-placeholder` — P6 회귀).
 *
 * 보유 표의 읽는 중 자리가 한 줄('보유를 읽는 중…' — 본문 약 100px)이라, P6의 한 줄 머리·압축으로 첫 화면 안에 들어온 아래 '주문' 패널이 보유 응답 뒤 표
 * (7종목 — 넓은 화면 약 550px)와 '재진입 금지' 패널에 밀려 화면 밖으로 나갔습니다. 빌드한 화면(QA 스택, 미국 규칙 계좌 7종목)의 첫 적재 CLS 1440 0.082·
 * 1280 0.0897(P6 전 0.0127·0.0212), 합성 한국 자료 7종목 1440 0.0579.
 *
 * 기대(값이 온 뒤의 꼴로 자리 — QA-892·930과 같은 원칙): 처음 읽는 동안에는 개요 응답의 계좌 요약이 아는 보유 종목 수(`positions`)만큼의 표 높이 자리를
 * 둡니다(줄 높이는 좁은 화면·넓은 화면이 다르고, 옆 검사 칸 배치면 검사 칸 높이 이상). 종목 수를 모르거나 0이면 자리를 키우지 않습니다. 읽기가 실패한 뒤
 * 다시 읽는 동안은 예전 한 줄 그대로(QA-655 — 오류 상자와 번갈아 높이가 크게 오르내리지 않게). 응답 뒤의 겉모습·요청은 그대로입니다.
 * jsdom은 배치를 재지 않아 자리의 줄 수와 높이 클래스를 봅니다(브라우저 잰 값은 고친 커밋 본문).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "", UnauthorizedError };
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
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";
import type { PaperMarketCode } from "@/lib/paperMarket";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const book = (code: string, kind: string, label: string, positions: number | null) => ({
  code, kind, label, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200, equityValue: 100700,
  exposurePct: 99.5, returnPct: -1.2, lastObservedAtKst: "2026-10-24 05:15", positions, staleCount: 0, stats: STATS, benchmark: null,
});
const overviewOf = (market: PaperMarketCode, positions: number | null) => ({
  available: true, initialized: true, market, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], quotes: null,
  navSeries: { dates: [], books: {} }, dormantReason: null,
  books: market === "KR"
    ? [book("kr_rules", "RULES", "한국 규칙 계좌", positions), book("kr_bench_k200", "BENCHMARK", "KODEX 200 계좌", 1)]
    : [book("rules", "RULES", "규칙 계좌", positions), book("bench_spy", "BENCHMARK", "SPY 계좌", 1)],
});

let positions: number | null = 7;
let failPositions = false;

beforeEach(() => {
  positions = 7;
  failPositions = false;
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve(overviewOf(path.includes("market=KR") ? "KR" : "US", positions));
    if (path.endsWith("/positions") && failPositions) return Promise.reject(new Error("보유 응답 500"));
    // 보유·주문·체결 등은 끝나지 않는 요청 — 첫 적재 자리를 봅니다.
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

const settled = () => act(async () => {});
const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
/** '보유를 읽는 중…'을 감싼 첫 적재 자리(없으면 null). */
const pendingSlot = () => screen.getByText("보유를 읽는 중…").closest("[data-pending-rows]");

describe("보유 표 첫 적재 자리(QA-954)", () => {
  for (const market of ["US", "KR"] as const) {
    it(`${market}: 처음 읽는 동안 계좌 요약의 보유 종목 수만큼 표 높이 자리 — 좁은 화면·넓은 화면·옆 검사 칸 높이`, async () => {
      render(<PaperScreen market={market} initialTab="holdings" />);
      await settled();
      const slot = pendingSlot();
      expect(slot?.getAttribute("data-pending-rows")).toBe("7");
      expect((slot as HTMLElement | null)?.style.getPropertyValue("--pending-rows")).toBe("7");
      const classes = tokens(slot);
      // 좁은 화면 줄 높이(기본) · 넓은 화면 줄 높이(lg) · 옆 검사 칸 배치(lg + 틀 52rem)면 검사 칸 높이 이상.
      expect(classes.some((name) => name.startsWith("min-h-[calc("))).toBe(true);
      expect(classes.some((name) => name.startsWith("lg:min-h-[calc("))).toBe(true);
      expect(classes.some((name) => name.startsWith("lg:@min-[52rem]:min-h-[max("))).toBe(true);
      // 옆 칸 배치는 틀 폭으로 정하므로 자리를 크기 질의 틀(@container)이 감쌉니다.
      expect(tokens(slot?.parentElement ?? null)).toContain("@container");
    });
  }

  it("보유 종목 수가 0이면 줄 자리 없음(검사 칸 높이도 잡지 않음)", async () => {
    positions = 0;
    render(<PaperScreen market="US" initialTab="holdings" />);
    await settled();
    const slot = pendingSlot();
    expect(slot?.getAttribute("data-pending-rows")).toBe("0");
    expect(tokens(slot).some((name) => name.includes("@min-[52rem]"))).toBe(false);
  });

  it("종목 수를 모르면(null) 자리를 키우지 않음 — 예전 한 줄", async () => {
    positions = null;
    render(<PaperScreen market="US" initialTab="holdings" />);
    await settled();
    expect(screen.getByText("보유를 읽는 중…").closest("[data-pending-rows]")).toBeNull();
  });

  it("읽기가 실패한 뒤에는 오류 상자(큰 자리를 그리지 않음)", async () => {
    failPositions = true;
    render(<PaperScreen market="US" initialTab="holdings" />);
    await settled();
    expect(await screen.findByText("보유 응답 500")).toBeTruthy();
    expect(document.querySelector("[data-pending-rows]")).toBeNull();
  });
});
