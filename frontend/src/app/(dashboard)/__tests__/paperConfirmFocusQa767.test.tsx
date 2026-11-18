/**
 * QA-767 — 모의매매 화면 안 확인 상자(Claude 계좌 '지금 결정 실행'의 확인, 메모 보관 확인)를 열면 첫 포커스가 실행 단추('결정 실행 확인'·'보관 확인')로
 * 가던 결함. 상자를 키보드로 연 뒤 Enter·Space를 한 번 더 누르거나 키를 누른 채 자동 반복되면 곧바로 쓰기(POST run/decision — Claude 호출 비용·하루 수동 상한,
 * DELETE /api/paper/notes/{id})가 나갔습니다. 저장소의 공용 확인 창 규칙은 '열면 첫 포커스는 입력칸(있으면) 또는 취소 단추(실수로 Enter를 눌러도 안전)'입니다
 * (ui/ConfirmDialog). 개편 전에는 이 단추로 포커스를 옮기지 않았습니다(작업대 P6 로그 갈래가 더함). 값은 모두 합성 값입니다.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { DecisionsSection } from "@/components/screens/paper/DecisionsSection";
import { NotesSection } from "@/components/screens/paper/NotesSection";
import type { PaperBookSummary } from "@/lib/types";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const CLAUDE = {
  code: "claude", kind: "CLAUDE", label: "Claude 계좌", status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
  cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05, lastObservedAtKst: "2026-10-24 05:15",
  positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy",
} as unknown as PaperBookSummary;

const NOTE = {
  id: 21, kind: "MARKET", asOfDate: "2026-10-28", expiresOn: "2026-11-02", title: "외국인 반도체 매수", body: "반도체 순매수 지속",
  archived: false, active: true, createdAtKst: "2026-10-28 21:10 KST",
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/decisions?book=claude": () => Promise.resolve({ available: true, decisions: [] }),
    "/api/paper/status": () => Promise.resolve({ available: true, jobs: [] }),
    "/api/paper/notes?includeExpired=false": () => Promise.resolve({ available: true, referenceDate: "2026-10-28", notes: [NOTE] }),
    "/api/paper/settings": () => Promise.resolve({ available: true, version: 2, body: {}, defaults: {}, keys: [] }),
  };
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

/** 단추의 aria-describedby가 가리키는 글. */
const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("QA-767 — 화면 안 확인 상자의 첫 포커스는 취소 단추", () => {
  it("Claude 계좌 '지금 결정 실행' — 확인 상자를 열면 '취소'에 포커스하고, 그 단추가 비용 안내를 설명으로 읽는다", async () => {
    render(<DecisionsSection books={[CLAUDE]} onChanged={() => {}} initialBook="claude" />);
    const run = await screen.findByRole("button", { name: "지금 결정 실행" });
    fireEvent.click(run);
    const box = document.getElementById(run.getAttribute("aria-controls") ?? "") as HTMLElement;
    const cancel = within(box).getByRole("button", { name: "취소" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(describedText(cancel)).toMatch(/Claude를 지금 부를까요\?/);
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("메모 보관 — 확인 상자를 열면 '취소'에 포커스하고, 그 단추가 보관 확인 글을 설명으로 읽는다", async () => {
    render(<NotesSection startDate="2026-10-23" />);
    const list = await screen.findByRole("list", { name: "메모" });
    fireEvent.click(within(list).getAllByRole("button")[0]);
    const dialog = await screen.findByRole("dialog", { name: "#21 외국인 반도체 매수" });
    fireEvent.click(within(dialog).getByRole("button", { name: "보관 #21" }));
    const cancel = within(dialog).getByRole("button", { name: "취소" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(describedText(cancel)).toMatch(/이 메모\(#21 외국인 반도체 매수\)를 보관할까요\?/);
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});
