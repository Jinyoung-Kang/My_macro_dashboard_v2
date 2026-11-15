/**
 * 종목 상세의 13F 보유 기관 카드 — 정보 검색 보유 탭과 같은 검색어(lib/detail holderQuery)·같은 경로를 씁니다(QA-436). 응답은 모두 합성 값입니다.
 * 이름으로 찾아 0건이면 무엇으로 찾았는지와 그 한계를 적고 '보유한 곳이 없다'고 단정하지 않습니다(공시 이름이 줄여 적힌 보유는 이름으로 못 찾음).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUERY = "SYNTHETIC EXAMPLE FINANCIAL GROUP";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNF", yahooSymbol: "SYNF", name: "Synthetic Example Financial Group, Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10.5, previousClose: 10.4, change: 0.1, changePct: 0.96, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNF" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

const NO_MATCH: GuruHoldersResponse = {
  query: QUERY,
  available: false,
  rows: [],
  totalMatches: 0,
  truncated: false,
  message: "그 이름을 포함한 보유 종목이 없습니다. 13F 공시 이름은 대문자 영문입니다(예: APPLE, NVIDIA).",
};

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.detail.quote("us", "SYNF")]: { available: true, quote: QUOTE },
    [endpoints.institution.guruHolders(QUERY)]: NO_MATCH,
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

describe("종목 상세 — 13F 보유 기관이 이름으로 찾아 0건(QA-436)", () => {
  // QA-436: 0건이면 '이 대시보드가 받은 13F 기관 가운데 보유한 곳이 없습니다'로 없다고 단정했습니다(공시 이름이 잘리거나 줄여 적혀 못 찾은 경우에도).
  // 수정 전 실패: 찾은 이름을 적은 안내가 없고 '보유한 곳이 없습니다'가 보임(재현 커밋에서는 it.fails).
  it.fails("카드는 찾은 이름과 '줄여 적은 공시 이름은 찾지 못함'을 적고, 보유한 곳이 없다고 단정하지 않는다", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNF" />
      </SessionUserProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "13F 보유 기관" });
    const card = heading.closest("section") as HTMLElement;
    await within(card).findByText(/없습니다/);

    expect(card.textContent).toContain(`‘${QUERY}’ 이름으로 찾은 13F 보유 줄이 없습니다`);
    expect(card.textContent).toContain("보유한 곳이 없다고 단정할 수 없습니다");
    expect(within(card).queryByText(/보유한 곳이 없습니다/)).toBeNull();
  });
});
