/**
 * QA-812 — 메모 보관(DELETE)이 실패하면 그 오류 알림이 목록-검사(MasterDetail) 뒤 패널 끝에 그려져, 좁은 배치(검사 칸이 위쪽 대화상자)에서는 대화상자 밖 —
 * Radix가 aria-hidden으로 감춘 덮개 뒤 — 라 보이지도 들리지도 않았습니다(D5 전 QA 스택 390: 오류 Callout 문서 y 1,024, 조상 aria-hidden, 알림 영역 밖).
 * 개편 전에는 표 아래 확인 상자 바로 밑이었습니다. 실패 사유는 보관 단추·확인 상자가 있던 그 메모 칸 안의 알림 영역(role=status)에 있어야 하고, 보내는 동안
 * 대화상자를 Esc로 닫지 못해야 합니다(QA-766의 제안 승인·거절과 같은 규칙 — 결과를 볼 칸이 사라지지 않게). 값은 모두 합성 값입니다.
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

const NOTE = {
  id: 902, kind: "MARKET", asOfDate: "2026-11-18", expiresOn: "2026-11-25", title: "합성 시황 메모 B", body: "합성 본문",
  archived: false, active: true, createdAtKst: "2026-11-18 21:10 KST",
};

beforeEach(() => {
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/notes")) return Promise.resolve({ available: true, referenceDate: "2026-11-18", notes: [NOTE] });
    if (path.startsWith("/api/paper/settings")) return Promise.resolve({ available: true, version: 2, body: {}, defaults: {}, keys: [] });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

async function openArchiveConfirm() {
  render(<NotesSection startDate="2026-10-23" />);
  const list = await screen.findByRole("list", { name: "메모" });
  fireEvent.click(within(list).getAllByRole("button")[0]);
  const dialog = await screen.findByRole("dialog", { name: "#902 합성 시황 메모 B" });
  fireEvent.click(within(dialog).getByRole("button", { name: "보관 #902" }));
  return dialog;
}

describe("QA-812 — 메모 보관 실패 알림은 그 메모 칸 안의 알림 영역에", () => {
  it.fails("좁은 배치: 보관이 실패하면 오류 글이 대화상자 안 role=status에", async () => {
    api.apiDelete.mockRejectedValue(new Error("합성 오류 — 메모를 보관하지 못했습니다"));
    const dialog = await openArchiveConfirm();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "보관 확인" }));
    });
    expect(api.apiDelete).toHaveBeenCalledWith("/api/paper/notes/902");
    const message = await screen.findByText("합성 오류 — 메모를 보관하지 못했습니다");
    expect(dialog.contains(message)).toBe(true);
    expect(message.closest('[role="status"]')).not.toBeNull();
  });

  it.fails("좁은 배치: 보관을 보내는 동안 Esc로 대화상자를 닫지 못함", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiDelete.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const dialog = await openArchiveConfirm();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "보관 확인" }));
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "#902 합성 시황 메모 B" })).not.toBeNull();
    await act(async () => finish({ ok: false, message: "합성 거절" }));
    await waitFor(() => expect(within(dialog).getByText("합성 거절").closest('[role="status"]')).not.toBeNull());
  });
});
