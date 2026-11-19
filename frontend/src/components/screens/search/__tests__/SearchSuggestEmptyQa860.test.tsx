/**
 * 정보 검색 입력 후보 0건 — 아무 안내가 없음(QA-860, D1 '그대로 둔 것' `search-suggest-zero-no-message` — 사용자 결정 거리 U4 권장안).
 *
 * 치는 동안 가진 색인에서 후보를 찾는데(GET /api/search/suggest — 외부 호출 없음), 응답이 0건이면 목록이 그냥 닫히고 아무 글도 없어 낭독기 사용자에게는
 * '결과 없음'이 전해지지 않았습니다(받지 못한 경우의 안내만 있었음). 기대: 그 검색어의 응답이 0건으로 온 뒤 입력칸 아래에 상태 글(role=status) 한 줄 —
 * Enter로 찾을 수는 있다는 것과 함께. 묻는 동안(멈추기 전·응답 전)에는 보이지 않고, 요청은 그대로 한 번입니다.
 * 수정 전(재현 커밋에서는 it.fails): "Unable to find an element with the text: /후보가 없습니다/".
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { SearchBox } from "../SearchBox";

beforeEach(() => {
  vi.useFakeTimers();
  api.apiGet.mockReset();
  api.apiGet.mockImplementation((path: string) =>
    path === endpoints.search.suggest("없는말") ? Promise.resolve({ available: true, items: [] }) : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("입력 후보 0건 안내(QA-860)", () => {
  it.fails("그 검색어의 응답이 0건이면 상태 글 한 줄(role=status) — 묻는 동안에는 없고, 요청은 한 번", async () => {
    render(<SearchBox initial={null} onSubmit={() => {}} onChoose={() => {}} />);
    const input = screen.getByRole("combobox", { name: "대상 검색" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "없는말" } });
    // 멈추기 전(묻기 전)에는 안내가 없습니다.
    expect(screen.queryByText(/후보가 없습니다/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const status = screen.getByText(/후보가 없습니다/);
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(status.textContent).toContain("Enter로 찾을 수는 있습니다");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(api.apiGet.mock.calls.map(([path]) => path)).toEqual([endpoints.search.suggest("없는말")]);
  });
});
