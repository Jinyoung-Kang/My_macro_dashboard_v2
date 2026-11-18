/**
 * QA-816 — 개요 계좌 검사 칸(작업대 P6 — 넓은 화면 옆 칸 28rem = 448px, 안쪽 약 422px)에 들어온 계좌 상세의 '지금 설정' 목록이 컨테이너 질의
 * `@min-[24rem]:grid-cols-2`로 옆 칸 안에서도 두 칸 격자가 되어, 칸마다 이름(dt)·값(dd)을 나눠 이름 칸이 98px로 줄며 '모델(두 시장 공' / '용)'처럼
 * 음절 중간에서 꺾였습니다(D5 전 QA 스택 한국 1440 — 개편 전에는 계좌 목록 아래 전체 폭 패널의 sm:grid-cols-2). 옆 칸 폭(28rem) 안에서는 한 칸이고,
 * 이름은 낱말 사이에서만 꺾여야 합니다. jsdom은 배치를 재지 않아 클래스로 봅니다. 값은 모두 합성 값입니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
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

const BOOK = {
  code: "kr_claude", kind: "CLAUDE", label: "한국 Claude 계좌1", status: "ACTIVE", startedOn: "2026-11-02", initialCash: 100_000_000,
  cash: 340_000, nav: 100_312_450, equityValue: 99_972_450, exposurePct: 99.66, returnPct: 0.31, lastObservedAtKst: "2026-11-18 21:57 KST",
  positions: 0, staleCount: 0, stats: null, benchmark: "kr_bench_k200",
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/settings")) {
      return Promise.resolve({ available: true, version: 3, body: { claude: { model: "claude-sonnet-5-5" } }, defaults: {}, keys: [] });
    }
    if (path.includes("/positions")) return Promise.resolve({ available: true, book: BOOK, cash: 340_000, lockouts: [], positions: [] });
    if (path.includes("/fills")) return Promise.resolve({ available: true, fills: [] });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

/** 옆 검사 칸의 폭(rem) — InspectorFrame wide의 옆 칸 28rem. 계좌 상세의 컨테이너(@container)는 그보다 좁습니다. */
const SIDE_INSPECTOR_REM = 28;

describe("QA-816 — 계좌 상세 '지금 설정'은 옆 검사 칸 안에서 한 칸, 이름은 낱말 사이에서만 꺾임", () => {
  it.fails("두 칸 격자 문턱이 옆 칸 폭보다 넓고, 이름(dt)에 break-keep", async () => {
    render(<AccountDetailPanel id="detail" book={BOOK as never} books={[BOOK] as never} onClose={() => {}} market="KR" />);
    await act(async () => {});
    const heading = await screen.findByText("지금 설정");
    const list = heading.parentElement?.querySelector("dl") as HTMLElement;
    expect(list).not.toBeNull();
    const twoColumns = /@min-\[(\d+(?:\.\d+)?)rem\]:grid-cols-2/.exec(list.className);
    expect(twoColumns, list.className).not.toBeNull();
    expect(Number(twoColumns?.[1])).toBeGreaterThan(SIDE_INSPECTOR_REM);
    const terms = [...list.querySelectorAll("dt")];
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) expect(term.className.split(/\s+/), term.textContent ?? "").toContain("break-keep");
  });
});
