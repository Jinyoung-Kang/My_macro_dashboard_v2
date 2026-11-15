/**
 * 13F 보유 비중이 0보다 크지만 아주 작을 때(0.005% 미만)의 표기(QA-454). 응답은 모두 합성 값입니다(가상 기관·종목 이름).
 *
 * 큰 기관 포트폴리오에서 3억 달러 남짓한 보유는 비중이 0.003% 안팎이라 소수 둘째 자리로 반올림하면 '0.00%'가 되어 없는 값처럼 읽혔습니다
 * (정보 검색 보유 탭, 운영 화면 확인). 같은 13F 비중을 보이는 곳 — 정보 검색 보유 탭(회사 보유 기관·기관 상위 보유 종목), 종목 상세 13F 보유 기관 카드,
 * 기관 상세 상위 보유 종목, 13F 포트폴리오 표, 공통 보유(교집합·공통 신규 매수)의 평균·최대 비중, 스타일 화면 보유 기관 검색 — 모두 같은 표기여야 합니다.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다(비중 글은 표·목록에 있음).
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
  HorizontalBars: () => null,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { DetailQuote, GuruHoldersResponse, PortfolioResponse, SearchEntity, SessionUser } from "@/lib/types";
import { InstitutionDetailScreen } from "@/components/screens/detail/InstitutionDetailScreen";
import { StockDetailScreen } from "@/components/screens/detail/StockDetailScreen";
import { HoldingsPanel } from "@/components/screens/search/HoldingsPanel";
import ConsensusPage from "../consensus/page";
import InstitutionsPage from "../institutions/page";
import GuruPage from "../style/page";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const TINY = "<0.01%";
const ZERO = "0.00%";

const CIK = "0009999998";
const QUERY = "SYNTHETIC TINY HOLDINGS";

let reportDate = "";
let reads: Record<string, unknown> = {};

/** 보유 줄 둘 — 큰 기관이 아주 작게 든 줄(0.0032%)과 보통 줄(1.25%). */
function holders(): GuruHoldersResponse {
  return {
    available: true, query: QUERY, totalMatches: 2, truncated: false,
    rows: [
      { institution: "합성 자산운용", cik: "0000000011", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 1.25, value: 50_000_000, reportDate },
      { institution: "가상 연기금", cik: "0000000012", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 0.0032, value: 320_000_000, reportDate },
    ],
  };
}

function portfolio(): PortfolioResponse {
  return {
    available: true, cik: CIK,
    institution: { name: "🇺🇸 가상 대형운용 (Fictional Mega Advisors)", desc: "" },
    quarters: [{ filingDate: "2026-08-14", reportDate, totalValue: 10_000_000_000_000, holdingCount: 2 }],
    latest: { reportDate, filingDate: "2026-08-14", totalValue: 10_000_000_000_000 },
    holdings: [
      { name: "SYNTHETIC LARGE CO", cusip: "000000301", class: "COM", value: 9_999_680_000_000, shares: 1_000, weight: 99.9968, weightDiff: null, sharesDiff: null, action: "유지" },
      { name: "SYNTHETIC SMALL CO", cusip: "000000302", class: "COM", value: 320_000_000, shares: 10, weight: 0.0032, weightDiff: null, sharesDiff: null, action: "신규" },
    ],
  };
}

beforeEach(() => {
  reportDate = rangeStart("30d", kstToday(Date.now()));
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

/** root 안에 아주 작은 비중이 '<0.01%'로 보이고 '0.00%'는 없는지. */
function expectTiny(root: HTMLElement) {
  expect(within(root).queryByText(ZERO)).toBeNull();
  expect(within(root).getAllByText(TINY).length).toBeGreaterThan(0);
}

describe("13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)", () => {
  // QA-454: formatNumber(weight, 2)로 0.0032가 '0.00%'가 되어 3.2억 달러 보유가 없는 값처럼 읽혔습니다.
  // 수정 전 실패: 아래 화면 모두 '0.00%'가 보이고 '<0.01%'가 없음(재현 커밋에서는 it.fails).
  it.fails("정보 검색 보유 탭 — 회사의 13F 보유 기관 줄", async () => {
    reads = { [endpoints.institution.guruHolders(QUERY)]: holders() };
    const company: SearchEntity = {
      key: "us:SYTH", kind: "company", name: "합성 소형", nameKo: "합성 소형", nameEn: "Synthetic Tiny Holdings", aliases: [], description: null,
      ids: { ticker: "SYTH", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null }, links: [], sources: [],
    };
    render(<HoldingsPanel entity={company} loading={false} />);
    const section = (await screen.findByRole("heading", { name: /13F 보유 기관/ })).closest("section") as HTMLElement;
    expect(within(section).getByText("1.25%")).toBeTruthy();
    expectTiny(section);
  });

  it.fails("정보 검색 보유 탭 — 13F 기관의 상위 보유 종목", async () => {
    reads = { [endpoints.institution.portfolio(CIK, 8, 30)]: portfolio() };
    const institution: SearchEntity = {
      key: `cik:${CIK}`, kind: "institution", name: "가상 대형운용", nameKo: "가상 대형운용", nameEn: "Fictional Mega Advisors", aliases: [], description: null,
      ids: { ticker: null, market: null, stockCode: null, cik: CIK, dartCorpCode: null, wikidata: null }, links: [], sources: [],
    };
    render(<HoldingsPanel entity={institution} loading={false} />);
    const section = (await screen.findByRole("heading", { name: /상위 보유 종목/ })).closest("section") as HTMLElement;
    expectTiny(section);
  });

  it.fails("종목 상세 — 13F 보유 기관 카드", async () => {
    const quote: DetailQuote = {
      market: "us", code: "SYTH", yahooSymbol: "SYTH", name: "Synthetic Tiny Holdings, Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
      price: 10, previousClose: 10, change: 0, changePct: 0, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
      stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYTH" }, error: null,
      fetchedAt: "2026-11-15T00:00:00+00:00",
    };
    reads = { [endpoints.detail.quote("us", "SYTH")]: { available: true, quote }, [endpoints.institution.guruHolders(QUERY)]: holders() };
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYTH" />
      </SessionUserProvider>,
    );
    const card = (await screen.findByRole("heading", { name: "13F 보유 기관" })).closest("section") as HTMLElement;
    await within(card).findByText("1.25%");
    expectTiny(card);
  });

  it.fails("기관 상세 — 상위 보유 종목", async () => {
    reads = { [endpoints.institution.portfolio(CIK, 8, 30)]: portfolio() };
    render(
      <SessionUserProvider user={MEMBER}>
        <InstitutionDetailScreen cik={CIK} />
      </SessionUserProvider>,
    );
    const card = (await screen.findByRole("heading", { level: 2, name: "상위 보유 종목" })).closest("section") as HTMLElement;
    await within(card).findByText("SYNTHETIC SMALL CO");
    expectTiny(card);
  });

  it.fails("13F 포트폴리오 화면 — 보유 종목 표", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(portfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    const cell = await screen.findByText("SYNTHETIC SMALL CO");
    const table = cell.closest("table") as HTMLElement;
    expectTiny(table);
  });

  it.fails("공통 보유 — 교집합·공통 신규 매수의 평균·최대 비중", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [reportDate], reportDate: null, minHolders: 2,
          rows: [{ key: "cusip:000000201", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", holders: ["가상 연기금"], actions: [], holderCount: 2,
            totalValue: 320_000_000, avgWeight: 0.003, maxWeight: 0.004, buyCount: 0, sellCount: 0 }],
        });
      }
      if (path.startsWith("/api/sec13f/new-buys")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], minHolders: 3, note: "13F는 분기 공시입니다.",
          rows: [{ key: "cusip:000000202", name: "SYNTHETIC NEW CO", cusip: "000000202", buyers: ["가상 연기금"], buyerCount: 3,
            totalValue: 100, avgWeight: 0.002, reportDate }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const both = (await screen.findByText("SYNTHETIC TINY HOLDINGS")).closest("table") as HTMLElement;
    expect(within(both).getAllByText(TINY)).toHaveLength(2);
    expect(within(both).queryByText(ZERO)).toBeNull();
    const fresh = (await screen.findByText("SYNTHETIC NEW CO")).closest("table") as HTMLElement;
    expectTiny(fresh);
  });

  it.fails("스타일 화면 — 이 종목을 누가 들고 있나", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/holders") ? Promise.resolve(holders()) : new Promise(() => {}));
    render(<GuruPage />);
    fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: QUERY } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    await waitFor(() => expect(within(card).getByText("1.25%")).toBeTruthy());
    expectTiny(card);
  });
});
