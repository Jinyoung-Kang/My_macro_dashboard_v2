/**
 * QA-814 — 보유·체결 머리 '일시정지'·'재개'(확인 없이 바로 POST)를 누르면 보내는 동안 단추가 막혀 포커스가 문서(body)로 떨어지고, 끝난 뒤에도 돌아오지
 * 않던 결함(D5 전 QA 스택 390·1440, 미국·한국 모두 — 다음 Tab이 문서 처음부터). 같은 머리 구조의 결정 로그는 끝나면 머리 동작으로 되돌립니다(QA-771).
 * 포커스를 잃었을 때만 머리의 그 동작(data-action=status — 바뀐 '재개'·'일시정지')으로 돌아와야 합니다. 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { HoldingsSection } from "@/components/screens/paper/HoldingsSection";

const BOOK = {
  code: "rules", kind: "RULES", label: "규칙 계좌", status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000, cash: 500, nav: 101200,
  equityValue: 100700, exposurePct: 99.5, returnPct: 1.2, lastObservedAtKst: "2026-10-24 05:15", positions: 0, staleCount: 0, stats: null,
  benchmark: null,
};

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.includes("/positions")) return Promise.resolve({ available: true, book: BOOK, cash: 500, lockouts: [], positions: [] });
    if (path.includes("/orders")) return Promise.resolve({ available: true, orders: [] });
    if (path.includes("/fills")) return Promise.resolve({ available: true, fills: [] });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

/** 크롬은 포커스가 있던 단추가 막히면 포커스를 문서(body)로 놓습니다 — jsdom은 그러지 않아 잠깐 둔 입력칸에 포커스를 옮겼다 지워 흉내 냅니다(QA-771 시험과 같음). */
function dropFocus() {
  act(() => {
    const spare = document.createElement("input");
    document.body.appendChild(spare);
    spare.focus();
    spare.remove();
  });
}

describe("QA-814 — 머리 '일시정지'·'재개'가 끝나면 그 동작으로 포커스", () => {
  it.each([
    ["성공", () => Promise.resolve({ ok: true, book: { ...BOOK, status: "PAUSED" }, cancelledOrders: 0 })],
    ["실패", () => Promise.reject(new Error("합성 오류 — 계좌 상태를 바꾸지 못했습니다"))],
  ])("%s: 막혀 잃은 포커스가 끝난 뒤 머리 상태 동작으로 돌아온다", async (_, answer) => {
    let finish: () => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve, reject) => {
      finish = () => {
        answer().then(resolve, reject);
      };
    }));
    render(<HoldingsSection books={[BOOK] as never} onChanged={() => {}} />);
    const pause = await screen.findByRole("button", { name: "일시정지" });
    pause.focus();
    fireEvent.click(pause);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/books/rules/status", { status: "PAUSED" });
    dropFocus();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-action")).toBe("status"));
  });
});
