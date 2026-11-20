/**
 * QA-766 — 좁은 배치(검사 대화상자)에서 제안 승인·거절을 보내는 동안 대화상자를 닫으면(Esc·바깥 누르기·닫기 단추) 서버 결과·오류가 화면 어디에도 남지
 * 않던 결함.
 *
 * 승인·거절의 상태(useAsyncAction)가 대화상자 안의 제안 한 건(ProposalItem)에 있어, 대화상자가 닫히면 그 부품이 빠지며 늦게 온 결과·오류(400 '다른 판이
 * 먼저 승인됨' 등)를 버렸습니다(화면을 떠난 부품은 상태를 바꾸지 않음). 개편 전에는 제안이 늘 목록에 붙어 있어 결과·오류가 남았습니다. 공용 확인 창
 * (ConfirmDialog)은 같은 상황에서 처리 중 닫힘을 막습니다('확인은 결과가 나온 뒤 닫는다'). 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { FrameworkSection } from "@/components/screens/paper/FrameworkSection";

const BODY = {
  schemaVersion: 1, title: "합성 판", status: "USER", principles: [{ id: "P1", text: "패킷의 숫자에서 출발한다." }],
  engines: [{ id: "E1", name: "시장관", rules: [{ id: "E1-R1", text: "세 축으로 노출을 정한다.", addedIn: 0, sourceNoteId: null }] }],
  guidance: "",
};
const V2 = {
  version: 2, status: "USER", title: "합성 판", body: BODY, rendered: "# 투자 OS — v2 (합성 판)\n## 원칙\n1. 패킷의 숫자에서 출발한다.",
  tokensEst: 3600, overBudget: false, changelog: "직접 고침", createdAtKst: "2026-11-01 09:00 KST",
};
const VERSIONS = [{ version: 2, title: "합성 판", changelog: "직접 고침", createdAtKst: "2026-11-01 09:00 KST", sourceProposalId: null }];
const PROPOSAL = {
  id: 5, status: "PENDING", noteId: 10, model: "claude-sonnet-5-5", summary: "제안 5의 요약",
  operations: [{ op: "ADD_RULE", target: "E1", text: "VIX 30 이상이면 노출을 줄인다.", why: "원문 3절" }], assessment: [],
  beforeAfter: null, error: null, createdAtKst: "2026-11-01 08:00 KST", decidedAtKst: null, resultVersion: null, baseVersion: 2,
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/framework": () => Promise.resolve({ available: true, current: V2, versions: VERSIONS }),
    "/api/paper/framework/proposals": () => Promise.resolve({ available: true, proposals: [PROPOSAL] }),
    "/api/paper/settings": () => Promise.resolve({ available: true, version: 2, body: { frameworkTokenBudget: 50000 }, defaults: {}, keys: [] }),
    "/api/paper/notes?includeExpired=false": () => Promise.resolve({ available: true, notes: [] }),
  };
  window.history.replaceState(null, "", "/paper/us/framework");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (reads[path] ? reads[path]() : new Promise(() => {})));
});

afterEach(() => cleanup());

describe("QA-766 — 보내는 동안 검사 대화상자를 닫아도 결과가 남는다", () => {
  it("승인 확인 뒤 Esc를 눌러도 서버 거절 문구가 화면에 보인다", async () => {
    let fail: (error: Error) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((_, reject) => {
      fail = reject;
    }));
    render(<FrameworkSection />);
    const list = await screen.findByRole("list", { name: "제안 목록" });
    fireEvent.click(within(list).getByRole("button", { name: /^#5 / }));
    const dialog = await screen.findByRole("dialog", { name: "제안 #5" });
    fireEvent.click(within(dialog).getByRole("button", { name: "제안 #5 승인" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "승인 확인" }));
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/framework/proposals/5/approve");
    expect(within(dialog).getByRole("button", { name: "보내는 중…" })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => {
      fail(new Error("다른 판이 먼저 승인되었습니다 — 판을 다시 읽어 주세요."));
    });

    expect(screen.getByText("다른 판이 먼저 승인되었습니다 — 판을 다시 읽어 주세요.")).toBeTruthy();
  });
});
