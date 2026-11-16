/**
 * QA-574: 상세 화면 공용 AI 요약 카드(AiSummaryCard)를 누르면 단추가 진짜 disabled가 되어 크롬이 포커스를 body로 옮겼고(끝난 뒤에도 돌아오지 않음),
 * 실패(경고 안내)·연결 실패(오류 상자)·완료가 낭독되지 않았습니다 — 카드 안에 늘 있는 알림 영역이 없고 공용 Callout·ErrorState에는 role이 없습니다
 * (QA 스택 /institutions/0001608046 1440·390, 페이지 안 fetch 감싸기로 POST는 서버에 가지 않음). 응답은 모두 합성 값입니다.
 *
 * 고친 뒤(QA-553 새로고침 단추·QA-444·정보 검색 요약 패널과 같은 꼴): 진행 중에는 disabled 대신 aria-disabled·aria-busy를 달고 누르기를 무시합니다
 * (포커스가 단추에 남음, 다시 그리기 전 두 번 눌러도 요청 하나 — 진행 중 가드). 진짜 disabled는 대상·사용자를 모르는 정적 잠금에만 둡니다(QA-453).
 * 늘 그려 두는 role=status 영역 하나에 경고 안내와 진행·완료 글을, 연결 실패 오류 상자는 role=alert 상자에 둡니다. 공용 Callout·ErrorState에는 role을
 * 주지 않습니다(QA-268 — 늘 보이는 경고 약 220곳이 읽히게 됨). jsdom은 disabled 단추에서 포커스를 옮기지 않으므로 activeElement가 아니라 속성을 봅니다.
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
const REQUEST = { market: "us", code: "SYNQ", q: "Synthetic Quorum", label: "Synthetic Quorum" };

beforeEach(() => {
  api.apiPost.mockReset();
});
afterEach(cleanup);

function renderCard() {
  render(
    <SessionUserProvider user={PRO}>
      <AiSummaryCard request={REQUEST} />
    </SessionUserProvider>,
  );
  return screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
}

const liveOf = (element: Element) => element.closest('[role="status"],[role="alert"]');

describe("QA-574 AI 요약 — 진행 중 포커스 유지·결과와 오류 낭독", () => {
  // 수정 전 실패: (a) 누른 뒤 단추가 disabled=true·aria-disabled 없음, 한 번에 두 번 누르면 POST 2건 (b)(c) 경고·오류 글의 live 조상 없음
  // (d) 카드 안 role=status 영역 없음(재현 커밋에서는 it.fails).
  it("(a) 진행 중 단추는 disabled가 아니라 aria-disabled·aria-busy이고 누르기를 무시한다 — 다시 그리기 전 두 번 눌러도 요청 하나", async () => {
    api.apiPost.mockReturnValue(new Promise(() => {}));
    const card = renderCard();
    const button = within(card).getByRole("button", { name: "AI 요약 만들기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    act(() => {
      button.click();
      button.click();
    });
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    const busy = within(card).getByRole("button") as HTMLButtonElement;
    expect(busy).toBe(button);
    expect(busy.disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    expect(api.apiPost).toHaveBeenCalledTimes(1);
  });

  it("(b) 요약을 만들지 못함(status false)의 경고 안내는 늘 있는 알림 영역(role=status) 안", async () => {
    api.apiPost.mockResolvedValue({ status: false, summary: null, error: "하루 한도를 넘었습니다(합성)" });
    const card = renderCard();
    const region = within(card).getByRole("status");
    expect(region.textContent).toBe("");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    const warn = within(card).getByText("하루 한도를 넘었습니다(합성)");
    expect(liveOf(warn)).toBe(region);
    expect(within(card).getAllByRole("status")).toHaveLength(1);
  });

  it("(c) 연결 실패 오류 상자는 role=alert 상자 안", async () => {
    api.apiPost.mockRejectedValue(new Error("백엔드 API에 연결하지 못했습니다(합성)"));
    const card = renderCard();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    const message = within(card).getByText("백엔드 API에 연결하지 못했습니다(합성)");
    expect(message.closest('[role="alert"]')).not.toBeNull();
    // 단추는 다시 누를 수 있다
    const button = within(card).getByRole("button", { name: "AI 요약 만들기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("(d) 요약을 받으면 같은 알림 영역이 완료 글을 읽힌다 — 영역은 하나", async () => {
    api.apiPost.mockResolvedValue({ status: true, summary: "한 줄 요약: 합성 요약", model: "test-model", generatedAtKst: null, cached: false, sources: [], quota: null, error: null });
    const card = renderCard();
    const region = within(card).getByRole("status");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    expect(within(card).getByText("한 줄 요약: 합성 요약")).toBeTruthy();
    expect(within(card).getAllByRole("status")).toEqual([region]);
    expect(region.textContent).toContain("AI 요약을 만들었습니다");
    const button = within(card).getByRole("button", { name: "다시 불러오기" });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });
});
