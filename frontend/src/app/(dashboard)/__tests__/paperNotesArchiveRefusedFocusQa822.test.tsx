/**
 * QA-822 — 메모 보관(DELETE)에 서버가 200 {ok:false, message}로 답하면(보관하지 않음) 알림은 그 메모 칸의 role=status에 바르게 뜨지만, 포커스가 넓은 배치
 * (옆 검사 칸)에서는 BODY, 좁은 배치(위쪽 대화상자)에서는 대화상자 틀로 떨어졌습니다(자기 빌드 1440·390 — 500 실패는 '보관 #n'으로 돌아옴). runArchive가 요청
 * 성공을 '보관됨'으로 보고, 포커스 되돌림(QA-768)이 그 메모가 목록에서 빠지기를 기다렸는데 메모는 그대로 남아 끝내 되돌리지 않았습니다. 보관하지 않았다는
 * 답은 실패와 같이 그 메모의 '보관 #n'으로 돌아가야 합니다. 값은 모두 합성 값입니다.
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
  id: 902, kind: "MARKET", asOfDate: "2026-11-18", expiresOn: "2026-11-25", title: "합성 시황 메모 B", body: "합성 본문",
  archived: false, active: true, createdAtKst: "2026-11-18 21:10 KST",
};
const OTHER = { ...NOTE, id: 901, title: "합성 시황 메모 A", body: "합성 본문 A" };

beforeEach(() => {
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  // 서버가 보관하지 않았으므로 다시 읽어도 메모는 그대로 남습니다.
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/notes")) return Promise.resolve({ available: true, referenceDate: "2026-11-18", notes: [NOTE, OTHER] });
    if (path.startsWith("/api/paper/settings")) return Promise.resolve({ available: true, version: 2, body: {}, defaults: {}, keys: [] });
    return new Promise(() => {});
  });
  api.apiDelete.mockResolvedValue({ ok: false, message: "합성 거절 — 이미 보관한 메모입니다" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QA-822 — 보관하지 않았다는 답(200 ok:false)이면 포커스는 그 메모의 '보관 #n'으로", () => {
  it.fails("좁은 배치(대화상자): 알림은 그 칸의 role=status, 포커스는 '보관 #902'", async () => {
    render(<NotesSection startDate="2026-10-23" />);
    const list = await screen.findByRole("list", { name: "메모" });
    fireEvent.click(within(list).getByRole("button", { name: /#902/ }));
    const dialog = await screen.findByRole("dialog", { name: "#902 합성 시황 메모 B" });
    fireEvent.click(within(dialog).getByRole("button", { name: "보관 #902" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "보관 확인" }));
    });
    expect(api.apiDelete).toHaveBeenCalledWith("/api/paper/notes/902");
    const message = await within(dialog).findByText("합성 거절 — 이미 보관한 메모입니다");
    expect(message.closest('[role="status"]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "보관 #902" })));
  });

  it.fails("넓은 배치(옆 검사 칸): 포커스는 '보관 #902'(BODY로 떨어지지 않음)", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    render(<NotesSection startDate="2026-10-23" />);
    const list = await screen.findByRole("list", { name: "메모" });
    fireEvent.click(within(list).getByRole("button", { name: /#902/ }));
    const inspector = await screen.findByRole("region", { name: "메모 — #902 합성 시황 메모 B" });
    fireEvent.click(within(inspector).getByRole("button", { name: "보관 #902" }));
    await act(async () => {
      fireEvent.click(within(inspector).getByRole("button", { name: "보관 확인" }));
    });
    expect(await within(inspector).findByText("합성 거절 — 이미 보관한 메모입니다")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(inspector).getByRole("button", { name: "보관 #902" })));
  });
});
