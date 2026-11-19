/**
 * 정보 수집 개요 '최근 받은 글'의 읽는 중·실패 — QA-873(작업대 P7 검토에서 찾음, 개편 전부터).
 *
 * 개요의 '최근 받은 글' 패널은 최근 글 다섯 편(GET /api/info/items?page=1&size=5)의 읽는 중·실패를 그리지 않아, 읽기에 실패하면 빈 목록과 '뉴스·글 전체 보기'
 * 링크만 남고(오류·다시 시도 없음) 읽는 동안에는 아무것도 없었습니다. 같은 화면의 분류 띠는 읽는 중(Loading)과 오류(ErrorState)를 그립니다(정직한 상태 원칙).
 *
 * 기대: 읽는 동안 '불러오는 중…', 실패하면 오류 상자 + '다시 시도'(다시 읽음). 요청 경로·간격은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 'Unable to find an element with the text: 불러오는 중…', 둘째 사례 'Unable to find an element with the text: 합성 실패'.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { OverviewSection } from "../OverviewSection";

const CATALOG = { checkedAt: "2026-11-14 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };
const LATEST = endpoints.info.items({ page: 1, size: 5 });

let latest: () => Promise<unknown>;
beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.info.catalog) return Promise.resolve(CATALOG);
    if (path === LATEST) return latest();
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

const latestCard = () => screen.getByRole("heading", { name: "최근 받은 글" }).closest("section") as HTMLElement;
const latestCalls = () => api.apiGetShared.mock.calls.filter(([path]) => path === LATEST).length;

describe("개요 '최근 받은 글'의 읽는 중·실패(QA-873)", () => {
  it.fails("읽는 동안 '불러오는 중…'", async () => {
    latest = () => new Promise(() => {});
    render(<OverviewSection />);
    await act(async () => {});
    expect(within(latestCard()).getByText("불러오는 중…")).toBeTruthy();
  });

  it.fails("실패하면 오류 상자 + '다시 시도' — 누르면 같은 경로를 다시 읽음", async () => {
    latest = () => Promise.reject(new Error("합성 실패"));
    render(<OverviewSection />);
    for (let round = 0; round < 4; round += 1) await act(async () => {});
    const card = latestCard();
    expect(within(card).getByText("합성 실패")).toBeTruthy();
    const before = latestCalls();
    fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    await act(async () => {});
    expect(latestCalls()).toBe(before + 1);
  });
});
