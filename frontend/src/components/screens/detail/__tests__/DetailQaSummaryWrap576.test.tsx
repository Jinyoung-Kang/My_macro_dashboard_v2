/**
 * QA-576: 상세 화면 공용 AI 요약 본문(긴 글 단계 running 15/24, 최대 72자)에 줄바꿈 규칙이 없어, 끊을 자리가 없는 긴 글자열(가운뎃점 U+00B7로 이은 이름 목록·
 * '/'로 이은 업종·공백 없는 영문)이 줄 폭보다 길면 카드 밖으로 나가고 셸 main(overflow-x-clip·hidden)이 잘라 읽을 수 없었습니다(QA 스택
 * /institutions/0001608046 390 — 'NVIDIA·Apple·…·Broadcom·Tesla' 글 오른쪽 끝 480 > 카드 374, 공백 없는 90자 main 넘침 657px). 응답은 모두 합성 값입니다.
 *
 * 고친 뒤: 본문 묶음에 wrap-anywhere(overflow-wrap: anywhere)만 — 넘치는 글자열만 줄 안에서 꺾습니다. break-keep은 넣지 않습니다(한글 줄 끊는 자리가
 * 바뀜 — 1440 첫 줄 오른쪽 끝 1077 → 1028). 같은 상세 화면의 회사 소개(QA-530)·속성 값·연결 링크가 이미 같은 규칙입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { AiSummaryCard } from "../DetailParts";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };
const CHAIN = "NVIDIA·Apple·Microsoft·Alphabet·Amazon·Meta·Broadcom·Tesla";

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiPost.mockResolvedValue({
    status: true,
    summary: `한 줄 요약: 합성 기관이 큰 기술주를 늘렸다 [1]\n핵심:\n- ${CHAIN}`,
    model: "test-model",
    generatedAtKst: null,
    cached: false,
    sources: [{ n: 1, label: "합성 출처", url: "https://news.example/1" }],
    quota: null,
    error: null,
  });
});
afterEach(cleanup);

describe("QA-576 AI 요약 본문 — 끊을 자리 없는 긴 글자열은 줄 안에서 꺾는다", () => {
  // 수정 전 실패: 본문 묶음 클래스에 wrap-anywhere가 없음(재현 커밋에서는 it.fails).
  it("본문 묶음은 wrap-anywhere(넘치는 글자열만 꺾음)이고 break-keep은 없다 — 한글 줄 끊는 자리는 그대로", async () => {
    render(
      <SessionUserProvider user={PRO}>
        <AiSummaryCard request={{ q: "합성 기관", label: "합성 기관" }} />
      </SessionUserProvider>,
    );
    const card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    const line = within(card).getByText(CHAIN);
    const body = line.parentElement as HTMLElement;
    const tokens = body.className.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(["text-running", "max-w-[72ch]", "wrap-anywhere"]));
    expect(tokens).not.toContain("break-keep");
    // 머리 줄('한 줄 요약')도 같은 묶음 안 — 묶음의 규칙을 물려받습니다(overflow-wrap은 상속).
    expect(body.contains(within(card).getByText("한 줄 요약: 합성 기관이 큰 기술주를 늘렸다"))).toBe(true);
  });
});
