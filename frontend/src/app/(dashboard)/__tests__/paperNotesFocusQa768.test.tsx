/**
 * QA-768 — 메모 보관 확인 상자를 '취소'로 닫거나 보관을 끝내면 포커스가 갈 곳 없이 문서(body)로 떨어지던 결함. 상자가 사라지며 누른 단추도 함께 사라지는데
 * 포커스를 되돌리지 않았습니다(같은 P6의 결정 로그 확인 상자는 닫을 때 여는 단추로 되돌림). 취소면 그 메모의 '보관 #n'으로, 보관으로 메모가 목록에서
 * 빠졌으면 목록의 Tab 정지점 줄로 돌아가야 합니다. 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { NotesSection } from "@/components/screens/paper/NotesSection";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

const NOTE = {
  id: 21, kind: "MARKET", asOfDate: "2026-10-28", expiresOn: "2026-11-02", title: "외국인 반도체 매수", body: "반도체 순매수 지속",
  archived: false, active: true, createdAtKst: "2026-10-28 21:10 KST",
};
const OTHER = { ...NOTE, id: 22, title: "환율", body: "원/달러 1,420" };

let notes: unknown[] = [];

beforeEach(() => {
  notes = [NOTE, OTHER];
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/notes")) return Promise.resolve({ available: true, referenceDate: "2026-10-28", notes });
    if (path.startsWith("/api/paper/settings")) return Promise.resolve({ available: true, version: 2, body: {}, defaults: {}, keys: [] });
    return new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QA-768 — 메모 보관 확인을 닫으면 포커스가 돌아온다", () => {
  it("취소하면 그 메모의 '보관 #n' 단추로", async () => {
    render(<NotesSection startDate="2026-10-23" />);
    const list = await screen.findByRole("list", { name: "메모" });
    fireEvent.click(within(list).getAllByRole("button")[0]);
    const dialog = await screen.findByRole("dialog", { name: "#21 외국인 반도체 매수" });
    fireEvent.click(within(dialog).getByRole("button", { name: "보관 #21" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "보관 #21" })));
  });

  it("보관으로 메모가 목록에서 빠지면 목록의 Tab 정지점 줄로(넓은 배치 — 옆 검사 칸)", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    api.apiDelete.mockResolvedValue({ ok: true });
    render(<NotesSection startDate="2026-10-23" />);
    const list = await screen.findByRole("list", { name: "메모" });
    fireEvent.click(within(list).getAllByRole("button")[0]);
    const inspector = await screen.findByRole("region", { name: "메모 — #21 외국인 반도체 매수" });
    fireEvent.click(within(inspector).getByRole("button", { name: "보관 #21" }));
    notes = [OTHER];
    await act(async () => {
      fireEvent.click(within(inspector).getByRole("button", { name: "보관 확인" }));
    });
    expect(api.apiDelete).toHaveBeenCalledWith("/api/paper/notes/21");
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(within(list).getByRole("button", { name: /환율/ })));
  });
});
