/**
 * 13F 즐겨찾기를 교집합·알림에(ADR 0048 단계 3) — 교집합은 '분석 대상'(기본 12곳 — 지금 그대로) 아래 '즐겨찾기' 목록(여럿 고름, 처음엔 모두 꺼짐 — 처음 요청은
 * 지금 그대로), 켜면 요청 ciks = 기본 12곳의 유효 선택 + 켠 즐겨찾기. 알림 '관심 기관'에 즐겨찾기가 기본 12곳 뒤에 '(즐겨찾기)'로. 응답은 모두 합성 값.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ HorizontalBars: () => null }));

import { endpoints } from "@/lib/endpoints";
import { consensusCiks } from "@/lib/consensusScreen";
import ConsensusPage from "../consensus/page";

const A = "0001067983";
const B = "0001608046";
const FAV = "0009900001";
const LIST = {
  institutions: [
    { key: "berkshire", name: "가상 버크셔 (Fictional Berkshire)", cik: A, desc: "" },
    { key: "nps", name: "가상 연기금 (Fictional Pension)", cik: B, desc: "" },
  ],
  favorites: [{ key: `fav-${FAV}`, name: "가짜 운용", cik: FAV, desc: "", secName: "FAKE CAPITAL LLC", stored: true, source: "q8", latestReportDate: "2026-06-30" }],
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.institution.institutions) return Promise.resolve(LIST);
    if (path.startsWith("/api/sec13f/consensus")) {
      return Promise.resolve({ available: false, participants: [], participantCount: 0, availableDates: [], reportDate: null, minHolders: 2, rows: [] });
    }
    return new Promise(() => {});
  });
});
afterEach(cleanup);

const consensusCalls = () =>
  (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path).filter((path) => path.startsWith("/api/sec13f/consensus"));

describe("consensusCiks", () => {
  it("즐겨찾기를 켜지 않으면 지금 그대로(빈 글 = 기본 12곳), 켜면 기본 유효 선택 + 즐겨찾기", () => {
    expect(consensusCiks([A, B], [], [])).toBe("");
    expect(consensusCiks([A, B], [B], [])).toBe(B);
    expect(consensusCiks([A, B], [], [FAV])).toBe(`${A},${B},${FAV}`);
    expect(consensusCiks([A, B], [A], [FAV])).toBe(`${A},${FAV}`);
  });
});

describe("교집합의 즐겨찾기", () => {
  it("'즐겨찾기' 목록은 처음 모두 꺼짐 — 처음 요청은 지금 그대로, 켜면 기본 12곳 + 그 기관", async () => {
    render(<ConsensusPage />);
    const group = await screen.findByRole("group", { name: "교집합에 더할 즐겨찾기 기관" });
    const fav = within(group).getByRole("button", { name: "가짜 운용" });
    expect(fav.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(consensusCalls().length).toBeGreaterThan(0));
    expect(consensusCalls().every((path) => !path.includes("ciks="))).toBe(true);

    fireEvent.click(fav);
    expect(within(group).getByRole("button", { name: "가짜 운용" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(consensusCalls()).toContain(endpoints.institution.consensus({ minHolders: "2", topN: 40, ciks: `${A},${B},${FAV}`, reportDate: "" })),
    );
  });
});
