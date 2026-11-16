/**
 * 종목 상세의 13F 보유 기관 카드 — 기관 이름(한글) 링크의 줄바꿈(QA-449). 정보 검색 보유 탭(HoldingsPanel, QA-432)과 같은 처리입니다.
 * 응답은 모두 합성 값입니다(가상 기관 이름).
 *
 * 기관 이름 링크에 줄바꿈 규칙이 없어 word-break가 기본(normal)이었고, 한글은 음절 사이 어디서나 줄을 바꿀 수 있어 1024(링크 폭 96px)·390에서
 * '운/용'·'법/인'·'연금자산/운용'처럼 낱말 가운데서 끊겼습니다. jsdom은 배치를 재지 못하므로 고침이 세우는 구조(이름 글에 걸리는 클래스)를
 * 대조하고, 실제 폭은 QA 스택 브라우저로 확인합니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { institutionHref } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import type { DetailQuote, GuruHoldersResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { StockDetailScreen } from "../StockDetailScreen";

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** element에서 stop(포함)까지 올라가는 조상 줄 — word-break·overflow-wrap은 상속되므로 이름 글에서 줄까지 어디에 걸려도 됩니다. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}
const inChain = (chain: Element[], word: string) => chain.some((node) => classes(node).includes(word));

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUERY = "SYNTHETIC EXAMPLE";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNE", yahooSymbol: "SYNE", name: "Synthetic Example Corp", exchange: "NASDAQ", currency: "USD", kind: "EQUITY",
  price: 10.5, previousClose: 10.4, change: 0.1, changePct: 0.96, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNE" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

/** 띄어 쓴 한글 이름·띄어 쓰지 않은 긴 한글 이름(칸보다 긴 낱말)·한글과 영문을 섞은 이름. */
const INSTITUTIONS = ["가상 국민연금 자산운용 법인", "합성연금자산운용주식회사국제투자본부", "예시 투자자문 (Example Advisors)"] as const;

const HOLDERS: GuruHoldersResponse = {
  available: true, query: QUERY, totalMatches: INSTITUTIONS.length, truncated: false,
  rows: INSTITUTIONS.map((institution, index) => ({
    institution, cik: `000000000${index + 1}`, name: "SYNTHETIC EXAMPLE CORP", cusip: "000000001", weight: 3 - index, value: 1_000_000,
    reportDate: "2026-06-30",
  })),
};

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.detail.quote("us", "SYNE")]: { available: true, quote: QUOTE },
    [endpoints.institution.guruHolders(QUERY)]: HOLDERS,
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

describe("종목 상세 — 13F 보유 기관 이름의 줄바꿈(QA-449)", () => {
  // QA-449: 기관 이름 링크(Link)에 word-break 규칙이 없어(기본 normal) 한글 이름이 음절 사이에서 끊겼습니다('운/용'·'법/인'). 정보 검색 보유 탭은
  // 이름 글에 break-keep(낱말 사이에서만)과 wrap-anywhere(칸보다 긴 낱말만 칸 안에서 끊음)를 겁니다.
  // 수정 전 실패: 이름 글에서 줄(li)까지 어디에도 break-keep·wrap-anywhere가 없음(재현 커밋에서는 it.fails).
  // 고침: 기관 이름 링크에 break-keep·wrap-anywhere.
  // 대상 문법(P4)에서 보유 기관은 가운데 '보유 기관' 탭의 목록-검사(MasterDetail)입니다 — 줄은 단추(이름 글은 단추 안), 기관 상세 링크는 줄을 고르면
  // 여는 검사(좁은 화면 대화상자)의 '기관 상세 열기'. 이름 글의 줄바꿈 규칙과 숫자 칸 구조는 같습니다.
  it("기관 이름은 낱말 사이에서만 줄을 바꾸고(break-keep) 칸보다 긴 낱말만 칸 안에서 끊는다(wrap-anywhere) — 말줄임 없음, 기관 상세 링크·숫자 칸 그대로", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNE" />
      </SessionUserProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    const heading = await screen.findByRole("heading", { name: "13F 보유 기관" });
    const card = heading.closest("section") as HTMLElement;
    const list = await within(card).findByRole("list", { name: "13F 보유 기관" });

    for (const [index, institution] of INSTITUTIONS.entries()) {
      const button = within(list).getByRole("button", { name: new RegExp(institution.replace(/[()]/g, "\\$&")) });
      const row = button.closest("li")!;
      const name = within(button).getByText(institution);
      const chain = chainTo(name, row);

      // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패).
      expect(inChain(chain, "break-keep")).toBe(true);
      expect(inChain(chain, "wrap-anywhere")).toBe(true);
      // 전체 이름이 보임(말줄임 없음), 이름 칸은 줄어드는 칸이고 숫자는 칸 밖에서 제 폭.
      expect(inChain(chain, "truncate")).toBe(false);
      const cell = name.parentElement!;
      expect(classes(cell)).toContain("min-w-0");
      const weight = within(row).getByText(`${3 - index}.00%`);
      expect(cell.contains(weight)).toBe(false);
      expect(classes(weight.parentElement!)).toContain("shrink-0");

      // 기관 이름은 기관 상세로 이어짐 — 줄을 누르면 연 검사의 '기관 상세 열기'.
      fireEvent.click(button);
      const dialog = await screen.findByRole("dialog", { name: institution });
      expect(within(dialog).getByRole("link", { name: "기관 상세 열기" }).getAttribute("href")).toBe(institutionHref(`000000000${index + 1}`));
      fireEvent.keyDown(dialog, { key: "Escape" });
      await within(document.body).findByRole("list", { name: "13F 보유 기관" });
    }
  });
});
