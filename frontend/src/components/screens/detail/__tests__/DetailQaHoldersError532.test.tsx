/**
 * 종목 상세 13F 보유 기관 — 읽기 실패의 표시(QA-532). 응답은 모두 합성 값입니다(가상 종목).
 *
 * 보유 기관 읽기(GET /api/guru/holders)가 실패하면 오류 글을 위험색 글자 하나(`text-danger`)로만 적고 아이콘도 '다시 시도'도 없었습니다 — 같은
 * 화면의 핵심 지표·기관 상세 보유 종목은 QA-190에서 공용 오류 상자(아이콘 + 글 + 다시 시도)로 바꿨는데 이 자리만 남았습니다. 상태·위험은 늘 아이콘과
 * 글로(작업대 명세 W4), 실패는 다시 시도할 수 있어야 합니다(QA-190과 같은 원칙). 검색어와 상관없는 보유 목록은 응답 캐시라 몰리면 429(QA-133)가
 * 나는 경로라 일시 실패가 실제로 생깁니다.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const HOLDERS = endpoints.institution.guruHolders("SYNTHETIC ERROR");
const FAILURE = "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNX", yahooSymbol: "SYNX", name: "Synthetic Error Corp", exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: null, marketState: null, stats: [], profile: null, consensus: null, research: [],
  source: null, error: null, fetchedAt: null,
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.detail.quote("us", "SYNX")) return Promise.resolve({ available: true, quote: QUOTE });
    if (path === HOLDERS) return Promise.reject(Object.assign(new Error(FAILURE), { status: 429 }));
    return new Promise(() => {});
  });
});
afterEach(cleanup);

describe("종목 상세 — 13F 보유 기관 읽기 실패(QA-532)", () => {
  // QA-532: 실패 글이 <p class="text-sm text-danger">뿐이라 아이콘이 없고 다시 읽을 방법이 없었습니다(화면을 새로 열어야 함).
  // 수정 전 실패: 카드 안에 '다시 시도' 단추가 없음(재현 커밋에서는 it.fails).
  // 고침: 공용 ErrorState(XCircleIcon + 글 + '다시 시도' → holders.reload).
  it("오류는 아이콘과 글, '다시 시도'를 누르면 보유 기관을 다시 읽는다", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNX" />
      </SessionUserProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    const card = (await screen.findByRole("heading", { name: "13F 보유 기관" })).closest("section") as HTMLElement;
    const message = await within(card).findByText(FAILURE);

    // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패).
    const retry = within(card).getByRole("button", { name: "다시 시도" });
    expect(message.parentElement?.querySelector("svg")).not.toBeNull();
    const before = api.apiGetShared.mock.calls.filter(([path]) => path === HOLDERS).length;
    fireEvent.click(retry);
    await waitFor(() => expect(api.apiGetShared.mock.calls.filter(([path]) => path === HOLDERS)).toHaveLength(before + 1));
  });
});
