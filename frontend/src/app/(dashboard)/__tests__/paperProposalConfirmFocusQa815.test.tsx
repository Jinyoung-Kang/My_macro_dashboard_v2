/**
 * QA-815 — 프레임 제안의 승인·거절 확인 단계에 포커스 관리와 알림 영역이 없던 결함(D5 전 QA 스택 쓰기 갈래 — 합성 제안 #6·#7, 쓰기는 가로챔). '제안 #n 승인'을
 * 누르면 그 단추가 확인 상자로 바뀌며 사라져 포커스가 문서(1440 — body)나 대화상자 틀(390)로 떨어졌고, 보내는 동안·끝난 뒤에도 그대로였습니다. 결과·오류
 * Callout은 role=status·aria-live 밖이라 들리지 않았습니다. 결정 로그·메모의 화면 안 확인 상자와 같은 규칙이어야 합니다 — 열면 '취소'(QA-767), 닫거나 끝나면
 * 그 제안의 승인·거절 단추(없으면 제안 칸)로(QA-768·771), 결과·오류는 늘 그려 둔 role=status 안. 값은 모두 합성 값입니다.
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

import { FrameworkSection } from "@/components/screens/paper/FrameworkSection";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

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
  id: 7, status: "PENDING", noteId: 10, model: "claude-sonnet-5-5", summary: "제안 7의 요약", assessment: [], beforeAfter: null, error: null,
  operations: [{ op: "ADD_RULE", target: "E1", text: "VIX 30 이상이면 노출을 줄인다.", why: "원문 3절" }],
  createdAtKst: "2026-11-01 08:00 KST", decidedAtKst: null, resultVersion: null, baseVersion: 2,
};

const reads: Record<string, () => Promise<unknown>> = {
  "/api/paper/framework": () => Promise.resolve({ available: true, current: V2, versions: VERSIONS }),
  "/api/paper/framework/proposals": () => Promise.resolve({ available: true, proposals: [PROPOSAL] }),
  "/api/paper/settings": () => Promise.resolve({ available: true, version: 2, body: { frameworkTokenBudget: 50000 }, defaults: {}, keys: [] }),
  "/api/paper/notes?includeExpired=false": () => Promise.resolve({ available: true, notes: [] }),
};

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/us/framework");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (reads[path] ? reads[path]() : new Promise(() => {})));
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openProposal() {
  render(<FrameworkSection />);
  const list = await screen.findByRole("list", { name: "제안 목록" });
  fireEvent.click(within(list).getByRole("button", { name: /^#7 / }));
  return screen.findByRole("region", { name: "제안 목록 — 제안 #7" });
}

describe("QA-815 — 제안 승인·거절 확인 단계의 포커스와 알림", () => {
  it("확인 단계를 열면 '취소'로, 취소하면 연 단추('제안 #7 승인')로", async () => {
    const inspector = await openProposal();
    const approve = within(inspector).getByRole("button", { name: "제안 #7 승인" });
    approve.focus();
    fireEvent.click(approve);
    await waitFor(() => expect(document.activeElement).toBe(within(inspector).getByRole("button", { name: "취소" })));
    fireEvent.click(within(inspector).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(within(inspector).getByRole("button", { name: "제안 #7 승인" })));
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("거절이 실패하면 오류가 role=status 안이고, 포커스는 '제안 #7 거절'로", async () => {
    api.apiPost.mockRejectedValue(new Error("합성 오류 — 거절하지 못했습니다"));
    const inspector = await openProposal();
    fireEvent.click(within(inspector).getByRole("button", { name: "제안 #7 거절" }));
    await act(async () => {
      fireEvent.click(within(inspector).getByRole("button", { name: "거절 확인" }));
    });
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/framework/proposals/7/reject");
    const message = await within(inspector).findByText("합성 오류 — 거절하지 못했습니다");
    expect(message.closest('[role="status"]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(inspector).getByRole("button", { name: "제안 #7 거절" })));
  });
});
