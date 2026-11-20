/**
 * QA-838(작업대 P2 기록 'ReaderDialog 본문 칸 — P7'): 원문 읽기(Reader)의 본문 상자가 반투명 surface-2(bg-surface-2/60)라, 대화상자(덮개 면 bg-surface-2)
 * 안에서는 바탕이 덮개와 같아져 상자가 묻혔습니다(경계도 없음). 본문 상자는 놓인 면과 다른 면(bg-bg)과 1px 경계로 갈라야 합니다.
 * 재현 커밋에서는 it.fails였습니다.
 * 원문 읽기는 정보 수집 뉴스·글의 원문 검사 칸(좁은 화면 대화상자)과 원문 팝업(ReaderDialog — 정보 검색 피드)이 함께 그립니다. 응답은 합성 값입니다.
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
  key: "headline:https://press.example/1:0", sourceLabel: "Synthetic Wire", time: "2026-11-15 09:00 KST", title: "Synthetic press release",
  titleKo: null, url: "https://press.example/1", itemId: null, hasBody: true, text: "Synthetic summary paragraph.", note: "피드가 준 요약입니다.",
};

const tokens = (element: Element | null) => String(element?.getAttribute("class") ?? "").split(/\s+/);

describe("QA-838 원문 본문 상자 — 대화상자 덮개 면 위에서 묻히지 않는다", () => {
  it("본문 상자는 덮개 면(bg-surface-2)과 다른 면(bg-bg)과 1px 경계(border border-border)", () => {
    render(<ReaderDialog entry={ENTRY} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Synthetic press release" });
    expect(tokens(dialog)).toContain("bg-surface-2");
    const box = within(dialog).getByText("Synthetic summary paragraph.");
    const classes = tokens(box);
    expect(classes.some((name) => name.startsWith("bg-surface-2"))).toBe(false);
    expect(classes).toContain("bg-bg");
    expect(classes).toContain("border");
    expect(classes).toContain("border-border");
  });
});
