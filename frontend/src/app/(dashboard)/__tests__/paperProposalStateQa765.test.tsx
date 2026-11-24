/**
 * QA-765 — 프레임 제안 목록(목록-검사)의 넓은 배치에서 다른 제안을 고르면 앞 제안의 승인·거절 확인 단계가 새 제안으로 넘어가던 결함.
 *
 * 검사 칸은 고른 줄이 바뀌어도 같은 자리에서 `renderDetail`을 다시 그리므로, 제안 한 건(ProposalItem)에 key가 없으면 같은 부품 인스턴스가 다시 쓰여
 * 확인 단계(deciding)·보내는 중·결과·오류 상태가 그대로 남습니다. 승인할 수 없는 제안(변경 0건 — 승인 단추가 막힘)에도 막히지 않은 '승인 확인'이 보이고,
 * 누르면 POST …/approve가 나갔습니다(검토 재현 — 654b3aa3). 개편 전에는 제안마다 `key={proposal.id}`로 따로 그려 상태가 섞이지 않았습니다.
 * 값은 모두 합성 값입니다.
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

function proposal(id: number, operations: unknown[]) {
  return {
    id, status: "PENDING", noteId: 10, model: "claude-sonnet-5-5", summary: `제안 ${id}의 요약`, operations, assessment: [],
    beforeAfter: null, error: null, createdAtKst: "2026-11-01 08:00 KST", decidedAtKst: null, resultVersion: null, baseVersion: 2,
  };
}

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/framework": () => Promise.resolve({ available: true, current: V2, versions: VERSIONS }),
    "/api/paper/framework/proposals": () =>
      Promise.resolve({
        available: true,
        // #5는 변경 1건(승인할 수 있음), #6은 변경 0건(평가만 — 승인 단추가 막힘). 둘 다 기준 판 = 지금 판(v2).
        proposals: [proposal(5, [{ op: "ADD_RULE", target: "E1", text: "VIX 30 이상이면 노출을 줄인다.", why: "원문 3절" }]), proposal(6, [])],
      }),
    "/api/paper/settings": () => Promise.resolve({ available: true, version: 2, body: { frameworkTokenBudget: 50000 }, defaults: {}, keys: [] }),
    "/api/paper/notes?includeExpired=false": () => Promise.resolve({ available: true, notes: [] }),
  };
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

describe("QA-765 — 제안 검사 칸의 상태는 제안마다", () => {
  it("#5의 승인 확인 단계를 연 채 #6(변경 0건)을 고르면 #6에는 확인 단계가 없고 승인 단추는 막혀 있다", async () => {
    render(<FrameworkSection />);
    const list = await screen.findByRole("list", { name: "제안 목록" });

    fireEvent.click(within(list).getByRole("button", { name: /^#5 / }));
    const first = await screen.findByRole("region", { name: "제안 목록 — 제안 #5" });
    fireEvent.click(within(first).getByRole("button", { name: "제안 #5 승인" }));
    expect(within(first).getByRole("button", { name: "승인 확인" })).toBeTruthy();

    // 확인하지 않고 다른 제안을 고름.
    fireEvent.click(within(list).getByRole("button", { name: /^#6 / }));
    const second = await screen.findByRole("region", { name: "제안 목록 — 제안 #6" });
    expect(within(second).queryByRole("button", { name: "승인 확인" })).toBeNull();
    expect(within(second).queryByText(/이 제안\(#6\)을 승인할까요/)).toBeNull();
    expect((within(second).getByRole("button", { name: "제안 #6 승인" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});

// QA-1026: 승인·거절의 '보낸 제안 번호'와 '마지막 성공 결과'를 따로 쥐어, 제안 #5를 거절(성공)한 뒤 #6의 거절을 보내면 응답 전부터 #6 칸에 #5의
// "거절했습니다"가 떴고, #6이 실패하면 오류와 함께 남았습니다(useAsyncAction은 실패하거나 진행 중이어도 앞 결과를 남김).
describe("QA-1026 — 다른 제안에서 받은 성공 결과는 지금 보낸 제안 아래에 보이지 않는다", () => {
  it.fails("#5 거절 성공 뒤 #6 거절이 실패하면 #6 칸에는 오류만 — 보내는 동안에도 '거절했습니다'가 없다", async () => {
    let failSecond: (error: unknown) => void = () => {};
    api.apiPost.mockImplementation((path: string) =>
      path === "/api/paper/framework/proposals/5/reject"
        ? Promise.resolve({ ok: true })
        : new Promise((_resolve, reject) => {
          failSecond = reject;
        }));
    render(<FrameworkSection />);
    const list = await screen.findByRole("list", { name: "제안 목록" });

    fireEvent.click(within(list).getByRole("button", { name: /^#5 / }));
    const first = await screen.findByRole("region", { name: "제안 목록 — 제안 #5" });
    fireEvent.click(within(first).getByRole("button", { name: "제안 #5 거절" }));
    fireEvent.click(within(first).getByRole("button", { name: "거절 확인" }));
    expect(await within(first).findByText("거절했습니다 — 판은 그대로입니다.")).toBeTruthy();

    fireEvent.click(within(list).getByRole("button", { name: /^#6 / }));
    const second = await screen.findByRole("region", { name: "제안 목록 — 제안 #6" });
    fireEvent.click(within(second).getByRole("button", { name: "제안 #6 거절" }));
    fireEvent.click(within(second).getByRole("button", { name: "거절 확인" }));
    expect(api.apiPost).toHaveBeenLastCalledWith("/api/paper/framework/proposals/6/reject");
    // 응답 전 — #5의 결과가 #6 칸에 보이면 안 됩니다.
    expect(within(second).queryByText(/거절했습니다/)).toBeNull();

    await act(async () => failSecond(new Error("이미 결정된 제안입니다.")));
    expect(await within(second).findByText("이미 결정된 제안입니다.")).toBeTruthy();
    expect(within(second).queryByText(/거절했습니다/)).toBeNull();

    // 대조: #5로 돌아가면 #5의 결과는 #5 칸에 그대로(마지막 성공 결과).
    fireEvent.click(within(list).getByRole("button", { name: /^#5 / }));
    const back = await screen.findByRole("region", { name: "제안 목록 — 제안 #5" });
    expect(within(back).queryByText("이미 결정된 제안입니다.")).toBeNull();
  });
});
