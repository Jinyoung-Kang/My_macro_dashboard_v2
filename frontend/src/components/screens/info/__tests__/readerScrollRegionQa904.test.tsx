/**
 * QA-904(진행 기록 P7 검토 '원문 본문 상자 Tab 정지점' — P8 `datatable-scroll-region-tabstop-without-overflow`와 함께): 원문 읽기(Reader)의 본문 상자는
 * 높이 한도(60dvh) 안에서 세로로 스크롤하는데 Tab 정지점·이름이 없어, 넘치는 긴 원문을 키보드로 내려 읽을 수 없는 브라우저가 있었습니다(크롬 130 이상만
 * 넘치는 상자를 스스로 정지점으로 삼음). 공용 계약 useScrollRegion(QA-939 — 넘칠 때만 정지점, 재기 전·잴 수 없으면 정지점)을 따라야 합니다.
 * jsdom에는 ResizeObserver가 없어 '잴 수 없음' 길(정지점을 둠)을 봅니다. 재현 커밋에서는 it.fails였습니다. 응답은 합성 값입니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import type { ReaderEntry } from "@/lib/info";
import { ReaderDialog } from "../ReaderDialog";

afterEach(() => cleanup());

const ENTRY: ReaderEntry = {
  key: "headline:https://press.example/2:0", sourceLabel: "Synthetic Wire", time: "2026-11-15 09:00 KST", title: "Synthetic long release",
  titleKo: null, url: "https://press.example/2", itemId: null, hasBody: true, text: "Synthetic long paragraph.", note: "피드가 준 요약입니다.",
};

describe("QA-904 원문 본문 상자 — 스크롤 상자 공용 계약", () => {
  it("잴 수 없으면 본문 상자는 Tab 정지점이고 이름 있는 영역 '본문 (스크롤)'", () => {
    render(<ReaderDialog entry={ENTRY} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Synthetic long release" });
    const box = within(dialog).getByRole("region", { name: "본문 (스크롤)" });
    expect(box.textContent).toBe("Synthetic long paragraph.");
    expect(box.getAttribute("tabindex")).toBe("0");
  });
});
