/**
 * QA-575: 상세 화면 공용 AI 요약 카드의 글 두 가지가 맞지 않았습니다. 응답은 모두 합성 값입니다.
 *  - 부제 '…숫자는 위 표와 출처에서 확인하세요.' — 지표 상세에는 표가 없고(속성 목록), P4 배치에서 종목·기관 상세의 표도 왼쪽 칸·다른 탭으로 옮겨
 *    넓은 화면 세 상세 모두에서 '위 표'가 가리키는 것이 없었습니다(QA 스택 /markets/i/us10y·/s/us/AAPL 1440·1024·390).
 *  - 요약하는 중(단추 '요약하는 중…')에도 '단추를 누르면 요약합니다(…)' 안내가 그대로 남았습니다 — 안내 조건이 결과·오류만 보고 진행 중을 보지 않음
 *    (첫 요약, 오류 뒤 다시 누를 때).
 *
 * 고친 뒤: 부제는 배치와 상관없는 글('…숫자는 이 화면의 값과 출처에서 확인하세요.'). 진행 중에는 안내 대신 '요약하는 중입니다 — AI를 부르면 몇 초
 * 걸립니다'를 QA-574의 그 알림 영역(role=status — 하나만, 둘이면 두 번 낭독) 안에 보입니다. 쉴 때의 안내는 그대로(낱말 사이 줄바꿈 — QA-568).
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

const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
const REQUEST = { market: "us", code: "^TNX", q: "미국채 10년물 수익률", label: "미국채 10년물" };
const HINT = /단추를 누르면 요약합니다/;
const BUSY = "요약하는 중입니다 — AI를 부르면 몇 초 걸립니다";

beforeEach(() => {
  api.apiPost.mockReset();
});
afterEach(cleanup);

function renderCard() {
  render(
    <SessionUserProvider user={OWNER}>
      <AiSummaryCard request={REQUEST} />
    </SessionUserProvider>,
  );
  return screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
}

describe("QA-575 AI 요약 카드 글 — 배치와 상관없는 부제, 요약하는 중에는 진행 글", () => {
  // 수정 전 실패: 부제에 '위 표'가 있음(재현 커밋에서는 it.fails).
  it("부제는 배치에 기대지 않는다('위 표' 없음) — 이 화면의 값과 출처", () => {
    const card = renderCard();
    const subtitle = within(card).getByText(/투자 권유가 아니며/);
    expect(subtitle.textContent).not.toMatch(/위 표/);
    expect(subtitle.textContent).toBe("이 화면의 시세·지표·뉴스만 근거로 Claude가 요약합니다. 투자 권유가 아니며, 숫자는 이 화면의 값과 출처에서 확인하세요.");
  });

  // 수정 전 실패: 누른 뒤에도 '단추를 누르면 요약합니다' 안내가 남고, 알림 영역에 보이는 진행 글이 없음(재현 커밋에서는 it.fails).
  it("요약하는 중에는 '단추를 누르면' 안내 대신 알림 영역(하나) 안에 보이는 진행 글 — 단추는 aria-disabled", async () => {
    api.apiPost.mockReturnValue(new Promise(() => {}));
    const card = renderCard();
    const hint = within(card).getByText(HINT);
    expect(hint.className.split(/\s+/)).toContain("break-keep");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    const button = within(card).getByRole("button", { name: "요약하는 중…" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(within(card).queryByText(HINT)).toBeNull();
    const regions = within(card).getAllByRole("status");
    expect(regions).toHaveLength(1);
    const busy = within(regions[0]).getByText(BUSY);
    expect(busy.closest(".sr-only")).toBeNull();
  });

  // 수정 전 실패: 오류 뒤 다시 누르면(run이 오류를 먼저 지움) 진행 중에 안내가 다시 보임(재현 커밋에서는 it.fails).
  it("오류 뒤 다시 누를 때도 진행 중에는 안내 대신 진행 글", async () => {
    api.apiPost.mockRejectedValueOnce(new Error("백엔드 API에 연결하지 못했습니다(합성)"));
    const card = renderCard();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    expect(within(card).getByText("백엔드 API에 연결하지 못했습니다(합성)")).toBeTruthy();
    expect(within(card).queryByText(HINT)).toBeNull();
    api.apiPost.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "AI 요약 만들기" }));
    });
    expect(within(card).queryByText(HINT)).toBeNull();
    expect(within(within(card).getByRole("status")).getByText(BUSY)).toBeTruthy();
  });
});
