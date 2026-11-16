/**
 * 종목 상세의 13F 보유 기관 카드 — 보유 줄의 공시 이름·보고일 줄(QA-445). 정보 검색 보유 탭(SearchQaHoldersRows)과 같은 처리입니다. 응답은 모두 합성 값입니다.
 *
 * QA-436 뒤로 카드 부제가 '(잘린 공시 이름 포함)'이라 알리고, 무엇이 걸렸는지 가를 근거는 줄마다의 공시 이름뿐입니다. 그런데 이 줄은
 * '공시 이름 · 보고일'을 한 줄 말줄임(block truncate)으로 묶고 title도 없어, 1440·390 모두 긴 공시 이름이면 보고일과 이름 끝이 잘렸습니다.
 * jsdom은 배치를 재지 못하므로 고침이 세우는 구조(클래스·요소의 자리)를 대조하고, 실제 폭은 QA 스택 브라우저로 확인합니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
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

/** root 안에서 text를 담은 가장 안쪽 요소 — 글이 몇 요소로 나뉘든(고치기 전후) 같은 방법으로 찾습니다. */
function deepest(root: Element, text: string): HTMLElement {
  const holders = [root, ...root.querySelectorAll("*")].filter((element) => element.textContent?.includes(text));
  const found = holders.find((element) => ![...element.children].some((child) => child.textContent?.includes(text)));
  if (!found) throw new Error(`'${text}'를 담은 요소가 없음`);
  return found as HTMLElement;
}

/** element에서 stop(포함)까지 올라가는 조상 줄 — overflow·white-space·overflow-wrap은 상속되거나 조상 상자에서 걸리므로 줄 전체를 봅니다. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}
const inChain = (chain: Element[], word: string) => chain.some((node) => classes(node).includes(word));

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUERY = "SYNTHETIC EXAMPLE FINANCIAL GROUP";
const REPORT_DATE = "2026-06-30";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNF", yahooSymbol: "SYNF", name: "Synthetic Example Financial Group, Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10.5, previousClose: 10.4, change: 0.1, changePct: 0.96, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNF" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

/** 공시 이름 셋 — 잘린 이름 둘(QA-436이 함께 찾는 모양)과 칸보다 훨씬 긴 이름 하나. */
const NAMES = [
  "SYNTHETIC EXAMPLE FINANCIAL G ADR",
  "SYNTHETIC EXAMPLE FINANCIAL GRO",
  "SYNTHETIC EXAMPLE FINANCIAL GROUP HOLDINGS INC SPONSORED ADR",
] as const;
const INSTITUTIONS = ["합성 자산운용", "가상 투자자문 (Example Advisors)", "예시 연기금"] as const;

const HOLDERS: GuruHoldersResponse = {
  available: true, query: QUERY, totalMatches: 3, truncated: false,
  rows: NAMES.map((name, index) => ({
    institution: INSTITUTIONS[index], cik: `000000000${index + 1}`, name, cusip: `00000010${index}`, weight: 3 - index, value: 1_000_000,
    reportDate: REPORT_DATE,
  })),
};

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.detail.quote("us", "SYNF")]: { available: true, quote: QUOTE },
    [endpoints.institution.guruHolders(QUERY)]: HOLDERS,
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

describe("종목 상세 — 13F 보유 줄의 공시 이름·보고일(QA-445)", () => {
  // QA-445: '{공시 이름} · {보고일}'을 한 줄 말줄임(block truncate)으로 묶어, 긴 공시 이름이면 보고일과 이름 끝이 잘리고 title도 없어 전체를 볼 수
  // 없었습니다. 수정 전 실패: 보고일·공시 이름을 담은 요소의 조상(줄까지)에 truncate가 있음(재현 커밋에서는 it.fails).
  it("공시 이름은 제 칸 안에서 줄바꿈(말줄임 없음)하고 보고일은 끊기지 않는 한 덩어리로 늘 보인다 — 숫자는 따로 제 폭", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNF" />
      </SessionUserProvider>,
    );
    // 보유 기관은 가운데 '보유 기관' 탭의 목록-검사(대상 문법 — P4): 줄은 단추이고 기관 이름·공시 이름·보고일 칸과 숫자 칸 구조는 같습니다.
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    const heading = await screen.findByRole("heading", { name: "13F 보유 기관" });
    const card = heading.closest("section") as HTMLElement;
    const list = await within(card).findByRole("list", { name: "13F 보유 기관" });

    for (const [index, name] of NAMES.entries()) {
      const button = within(list).getByRole("button", { name: new RegExp(INSTITUTIONS[index].replace(/[()]/g, "\\$&")) });
      const row = button.closest("li")!;
      const cell = within(button).getByText(INSTITUTIONS[index]).parentElement!;

      // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패) — 보고일과 공시 이름 어디에도 말줄임이 걸리지 않음.
      const date = deepest(row, REPORT_DATE);
      const nameLine = deepest(row, name);
      expect(inChain(chainTo(date, row), "truncate")).toBe(false);
      expect(inChain(chainTo(nameLine, row), "truncate")).toBe(false);

      // 수정이 정한 구조 — 정보 검색 보유 탭과 같음: 공시 이름은 칸 안에서 끊고(wrap-anywhere), 보고일('· YYYY-MM-DD')은 줄바꿈하지 않는 한 덩어리.
      expect(inChain(chainTo(nameLine, row), "wrap-anywhere")).toBe(true);
      expect(inChain(chainTo(date, row), "whitespace-nowrap")).toBe(true);
      expect(date.textContent).toBe(`· ${REPORT_DATE}`);
      expect(cell.contains(date) && cell.contains(nameLine)).toBe(true);

      // 숫자는 이름 칸 밖에서 제 폭(줄지 않음), 이름 칸은 줄어드는 칸.
      expect(classes(cell)).toContain("min-w-0");
      const weight = within(row).getByText(`${3 - index}.00%`);
      expect(cell.contains(weight)).toBe(false);
      expect(classes(weight.parentElement!)).toContain("shrink-0");
    }
  });
});
