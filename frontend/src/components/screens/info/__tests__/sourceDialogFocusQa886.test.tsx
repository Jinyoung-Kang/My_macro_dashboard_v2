/**
 * 정보 수집 출처 검사 대화상자의 첫 포커스 — QA-886(D6 전 QA 스택 확인에서 찾음, 작업대 P7의 새 대화상자).
 *
 * 출처 표(상태 탭·분류 탭 다섯의 '출처' 패널)의 이름 단추로 검사 대화상자를 열면 첫 포커스가 오른쪽 위 '닫기' 단추에 갔습니다(모든 폭 42회 — 공용 대화상자
 * 기본 content: Radix 첫 포커스 후보에서 링크 '출처 사이트'·'자료 보기'가 빠져 DOM 끝의 닫기 단추). 연 직후 Enter·Space 한 번이면 대화상자가 닫히고,
 * 낭독기는 속성 목록 대신 '닫기'부터 읽었습니다. 같은 P7의 원문 대화상자(QA-871)·알림·모의매매 검사 대화상자는 첫 포커스가 제목입니다.
 *
 * 기대: 첫 포커스는 대화상자 제목(h2 — 출처 이름). Esc로 닫으면 연 이름 단추로 돌아갑니다(그대로). 열어도 새 요청이 없습니다(그대로).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected <button type="button" …(2)>…(1)</button> to be <h2 id="radix-…" …(1)></h2>'(activeElement가 닫기 단추).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import type { CatalogSource } from "@/lib/info";
import { SourceTable } from "../SourceTable";

afterEach(() => cleanup());

const SOURCE: CatalogSource = {
  task: "info_blog_synthetic", key: "blog.synthetic", label: "합성 블로그", tab: "news", kind: "blog", siteUrl: "https://blog.example/", origin: "합성 기관",
  access: "bypass", screen: "/info/news", speed: "polite", lastStatus: "ok", lastRunAt: "2026-11-11 16:41 KST", lastDetail: "새 글 3편",
  politeStatus: "ok", streak: null, lastOkAt: "2026-11-11 16:40 KST", nextDueAt: "2026-11-11 19:12 KST", items: 12, incident: null, tone: "ok",
};

describe("출처 검사 대화상자의 첫 포커스(QA-886)", () => {
  it("이름 단추로 열면 첫 포커스는 제목(h2) — 닫기 단추가 아님, Esc 뒤 그 이름 단추로", async () => {
    render(<SourceTable sources={[SOURCE]} variant="tab" caption="출처" pagerLabel="출처" emptyText="없음" />);
    const trigger = screen.getByRole("button", { name: "합성 블로그" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "합성 블로그" });
    await act(async () => {});
    expect(within(dialog).getByRole("link", { name: /출처 사이트/ })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "합성 블로그" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });
});
