/**
 * QA-759 — 모의 프레임 탭 폼의 라벨 모양이 섞임(진행 기록 넘긴 항목 `form-label-styles-mixed`의 프레임 몫 — 제안 요청 글·메모 고르기·직접 고치기 폼).
 * 공용 고르기(ui Select — '이미 있는 방법론 메모로 요청')의 라벨은 13px 보조 글(text-[13px] text-text-2)인데, 같은 카드의 '메모 제목'·'OS 원문' 라벨과
 * 직접 고치기 폼의 '제목'·'이름'·'지침'·'바꾼 내용' 라벨은 12px 흐린 글(text-xs text-text-3)이고, 고르기 상자는 넓은 화면 22rem(352px)까지인데 바로 아래
 * 한 줄 입력칸(메모 제목)은 칸 전체 폭입니다. jsdom은 배치를 재지 않으므로 클래스로 봅니다. 값은 합성 값입니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  engines: Array.from({ length: 8 }, (_, index) => ({
    id: `E${index + 1}`, name: `엔진 ${index + 1}`, rules: [{ id: `E${index + 1}-R1`, text: "규칙", addedIn: 1, sourceNoteId: null }],
  })),
  guidance: "",
};
const V1 = {
  version: 1, status: "USER", title: "합성 판", body: BODY, rendered: "# 투자 OS — v1", tokensEst: 100, overBudget: false,
  changelog: "처음", createdAtKst: "2026-10-25 02:37 KST",
};

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    "/api/paper/framework": { available: true, current: V1, versions: [{ version: 1, title: "합성 판", changelog: "처음", createdAtKst: null, sourceProposalId: null }] },
    "/api/paper/framework/proposals": { available: true, proposals: [] },
    "/api/paper/settings": { available: true, version: 1, body: {}, defaults: {}, keys: [] },
    "/api/paper/notes?includeExpired=false": {
      available: true,
      notes: [{ id: 10, kind: "INSIGHT", asOfDate: "2026-10-20", expiresOn: null, title: "방법론", body: "원문", archived: false, active: true, createdAtKst: null }],
    },
    "/api/paper/notes?includeExpired=false&market=KR": { available: true, market: "KR", notes: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

/** 라벨 글의 모양 — 글 크기·색 클래스만(배치 클래스는 보지 않음). */
function labelLook(label: Element): string {
  const tokens = (label.getAttribute("class") ?? "").split(/\s+/);
  return tokens.filter((token) => /^text-(xs|sm|\[\d+px\]|caption|body|text(-\d)?)$/.test(token)).sort().join(" ");
}

describe("QA-759 프레임 탭 폼 라벨 모양", () => {
  it("제안 요청 카드·직접 고치기 폼의 보이는 라벨이 공용 고르기와 같은 13px 보조 글, 한 줄 입력칸 폭은 고르기 상자와 같은 22rem까지", async () => {
    render(<FrameworkSection />);
    const picker = await screen.findByLabelText("이미 있는 방법론 메모로 요청");
    const selectLook = labelLook(picker.closest("label") as HTMLLabelElement);
    expect(selectLook).toBe("text-[13px] text-text-2");

    const card = picker.closest("section") as HTMLElement;
    const looks = within(card).getAllByText((_, element) => element?.tagName === "LABEL").map(labelLook);
    fireEvent.click(screen.getByRole("button", { name: "지금 판으로 편집 시작" }));
    const form = screen.getByRole("form", { name: "프레임 편집" });
    looks.push(...within(form).getAllByText((_, element) => element?.tagName === "LABEL").map(labelLook));
    expect(new Set(looks)).toEqual(new Set([selectLook]));

    // 같은 카드의 한 줄 입력칸(메모 제목)은 고르기 상자와 같은 폭 한도.
    const title = within(card).getByRole("textbox", { name: /^메모 제목/ });
    expect(title.className.split(/\s+/)).toContain("sm:max-w-[22rem]");
  });
});
