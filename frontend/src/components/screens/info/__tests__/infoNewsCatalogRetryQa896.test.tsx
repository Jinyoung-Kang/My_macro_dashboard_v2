/**
 * 정보 수집 뉴스 탭 — catalog가 실패한 뒤 다시 읽는 동안 — QA-896(D6 전 QA 반박 확인에서 찾음 — QA-894 고침 `3242c698`이 만든 새 동작).
 *
 * QA-894는 catalog를 처음 받기 전에 거르기 줄·목록 대신 읽는 중 한 줄을 두었는데, 그 조건(`catalog.loading && !catalog.data && !catalog.error`)이 실패한
 * 뒤 다시 읽는 동안(300초 자동 갱신·탭 복귀)에도 참이었습니다 — hooks/useApi가 다시 읽을 때 error를 비우고 failedAt만 남기기 때문입니다. 그래서 다시
 * 읽을 때마다 거르기 줄·목록·원문 칸이 통째로 내려갔다 다시 그려져, 검색 칸에 입력하던 포커스가 body로 떨어지고(이동 390 +0.18·1024 +0.14·1440 +0.13),
 * 1440 옆 칸에서 번역해 둔 원문은 번역이 사라지고 본문 GET을 다시 불렀습니다(QA 스택은 모두 그대로).
 *
 * 기대: 읽는 중 한 줄은 처음 읽는 동안(`firstLoadPending` — 값도 앞선 실패도 없음, QA-655)만. 실패 뒤 다시 읽는 동안은 거르기 줄·목록을 그대로 두고 검색
 * 칸의 포커스·입력이 남습니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected null to be truthy'(다시 읽는 동안 검색 칸이 사라짐).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "../InfoHub";

const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article", url: "https://blog.example/1/", title: "Rates Spike",
  titleKo: null, author: null, publishedAt: "2026-11-19 09:00 KST", firstSeenAt: "2026-11-19 09:30 KST", summary: null, bodyStatus: "none", fetchTier: null, category: null,
};
const LIST = { available: true, items: [ITEM], page: 1, size: 10, total: 1, pages: 1 };

/** catalog는 처음에 실패, `catalogFails`가 거짓이면 기다리는 중(다시 읽는 동안). 글 목록은 답함, 나머지는 기다리는 중. */
let catalogFails = true;
beforeEach(() => {
  catalogFails = true;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/info/catalog")) return catalogFails ? Promise.reject(new Error("합성 실패")) : new Promise(() => {});
    if (path.startsWith("/api/info/items?kind=blog")) return Promise.resolve(LIST);
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

describe("정보 수집 뉴스 탭 catalog 실패 뒤 다시 읽기(QA-896)", () => {
  it.fails("탭 복귀로 catalog를 다시 읽는 동안 거르기 줄·목록이 그대로이고 검색 칸의 포커스·입력이 남는다", async () => {
    render(<InfoHub tab="news" />);
    await settle();
    // catalog가 실패한 뒤 — 거르기 줄(검색 칸)과 목록이 보임.
    const search = screen.getByRole("searchbox");
    expect(screen.getByRole("button", { name: "Rates Spike" })).toBeTruthy();
    act(() => search.focus());
    fireEvent.change(search, { target: { value: "rates" } });

    // 탭 복귀 — catalog를 다시 읽고(두 훅이 함께 부름), 이번 응답은 아직 오지 않음.
    catalogFails = false;
    const before = api.apiGetShared.mock.calls.length;
    expect(document.visibilityState).toBe("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(api.apiGetShared.mock.calls.slice(before).some(([path]) => String(path).startsWith("/api/info/catalog"))).toBe(true);

    // 거르기 줄·목록이 그대로 — 같은 검색 칸에 포커스와 입력이 남음.
    expect(screen.queryByRole("searchbox")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe("rates");
    expect(screen.getByRole("button", { name: "Rates Spike" })).toBeTruthy();
  });
});
