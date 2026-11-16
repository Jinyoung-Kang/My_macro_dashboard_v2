/**
 * 종목 상세 — 애널리스트 의견 카드의 값이 잘리지 않는다(QA-455). 응답은 모두 합성 값입니다(가상 종목).
 *
 * 처음 결함: 애널리스트 의견은 lg 이상에서 1/3 폭의 옆 칸에 놓였는데, 값 표(KeyStats)가 sm 이상 두 칸 격자이고 값 칸이 한 줄 말줄임(truncate)이라 1440에서
 * '평균 목표가'의 '23.77 USD'가 '23.77 …'로 잘렸습니다(값 칸 61px, 글 68px — 1024에서는 칸이 더 좁음). 숫자는 잘라 보이지 않습니다.
 * 작업대 대상 문법(P4)부터 애널리스트 의견과 핵심 지표는 넓은 화면 13rem 왼쪽 칸의 속성 목록(PropertyList)입니다 — 더 좁은 칸이라 같은 뜻을 지금 구조로
 * 봅니다: 한 줄에 이름-값 한 쌍(여러 칸 격자 없음), 이름 칸은 줄지 않고 줄 폭의 절반까지(값 칸이 이름에 눌리지 않음), 값 글에서 카드까지 말줄임·줄바꿈
 * 금지가 없음. jsdom은 배치를 재지 못하므로 구조를 대조하고, 실제 폭은 QA 스택 브라우저(390·1024·1440)로 확인합니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

const QUOTE: DetailQuote = {
  market: "us", code: "SYNQ", yahooSymbol: "SYNQ", name: "Synthetic Quorum Bank", exchange: "NYSE", currency: "USD", kind: "ETF",
  price: 21.5, previousClose: 21.4, change: 0.1, changePct: 0.47, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [
    { key: "marketCap", label: "시가총액", value: 250_000_000_000, text: null, unit: "money" },
    { key: "range52", label: "52주 범위", value: null, text: "15.02 – 23.88 USD", unit: "text" },
  ],
  profile: null,
  consensus: { targetMean: 23.77, recommendation: "buy", analysts: 12 },
  research: [], source: { label: "합성 출처", url: "https://quote.example/SYNQ" }, error: null, fetchedAt: "2026-11-15T00:00:00+00:00",
};

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** element에서 stop(포함)까지 올라가는 조상 줄 — 말줄임·줄바꿈 금지는 조상 상자에서도 걸리므로 줄 전체를 봅니다. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}

/** 값 글을 자르거나(말줄임·넘침 숨김) 한 줄로 묶는(줄바꿈 금지) 클래스 — 어느 폭 접두든. */
const CLIPS = /^(?:[a-z0-9]+:)*(?:truncate|text-ellipsis|text-clip|overflow-hidden|overflow-x-hidden|whitespace-nowrap|line-clamp-\d+)$/;

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.detail.quote("us", "SYNQ") ? Promise.resolve({ available: true, quote: QUOTE }) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("종목 상세 — 애널리스트 의견·핵심 지표 값이 잘리지 않는다(QA-455)", () => {
  // QA-455: 값 칸(dd)이 truncate라 옆 칸 두 칸 격자에서 '23.77 USD'가 '23.77 …'로 잘렸습니다(1440 — 칸 61px, 글 68px).
  // 수정 전 실패: 값 글의 dd에 truncate가 있고, 옆 칸 표가 lg 이상에서도 두 칸(sm:grid-cols-2)(재현 커밋에서는 it.fails).
  it("왼쪽 칸 애널리스트 의견 속성은 한 줄에 한 쌍·이름 칸은 절반까지이고, 값 글에서 카드까지 말줄임·줄바꿈 금지가 없다 — 핵심 지표 값도 말줄임 없음", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNQ" />
      </SessionUserProvider>,
    );
    const card = (await screen.findByRole("heading", { name: "애널리스트 의견" })).closest("section") as HTMLElement;
    const value = within(card).getByText("23.77 USD");
    const offenders = chainTo(value, card).flatMap((node) => classes(node).filter((word) => CLIPS.test(word)));
    expect(offenders).toEqual([]);

    // 13rem 왼쪽 칸에서는 이름·값 한 쌍이 한 줄을 다 씁니다 — 목록을 어느 폭에서든 여러 칸 격자로 나누면 값 칸이 다시 좁아집니다.
    const list = value.closest("dl") as HTMLElement;
    expect(classes(list).filter((word) => /^(?:[a-z0-9]+:)*grid-cols-(?:[2-9]|\d{2,}|\[)/.test(word))).toEqual([]);

    // 이름은 줄지 않되(shrink-0) 줄 폭의 절반까지만(max-w-[50%]) — 값 칸이 늘 줄의 절반 이상을 가져 이름에 눌리지 않습니다. 값만 줄바꿈합니다 —
    // 숫자와 단위 사이의 공백에서 먼저 끊기고, 칸보다 긴 낱말만 안에서 끊습니다. 속성 목록(PropertyList)은 줄바꿈 규칙을 값 칸(dd)에 두고 값 글이
    // 물려받습니다(overflow-wrap은 상속) — 값 글에서 카드까지 줄에서 봅니다.
    const label = within(card).getByText("평균 목표가");
    expect(classes(label)).toEqual(expect.arrayContaining(["shrink-0", "max-w-[50%]"]));
    expect(chainTo(value, card).some((node) => classes(node).includes("wrap-anywhere"))).toBe(true);

    // 핵심 지표(같은 13rem 왼쪽 칸의 속성 목록)도 값 글을 자르지 않습니다.
    const stats = screen.getByRole("heading", { name: "핵심 지표" }).closest("section") as HTMLElement;
    const range = within(stats).getByText("15.02 – 23.88 USD");
    expect(chainTo(range, stats).flatMap((node) => classes(node).filter((word) => CLIPS.test(word)))).toEqual([]);
  });
});
