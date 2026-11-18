/**
 * 좁은 화면(lg 미만) 누르는 자리 44px — 운영 화면 조사(2026-11-15, 390px에서 요소 높이를 잼)가 짚은 곳(QA-458). 응답은 모두 합성 값입니다.
 *
 * 조사에서 44px 미만이던 누름 자리: 정보 수집 뉴스·글의 '번역·본문 보기·원문 열기'와 제목 단추(16px 안팎, 49개), 해외·공시·모의매매 입력
 * 출처 카드의 '출처 사이트·자료 보기'(16px), 수급 레이더 재무 표의 '원문'(20개 — 조사 측정 40px, 코드는 클래스 min-h-6 = 24px), 종목 상세
 * (22개 — '출처 보기' 16px, '정보 검색' 20px, 뉴스 제목·리서치·회사 개요 링크, 13F 보유 기관 이름, '다른 곳에서 보기' 36px)와 지표 상세(10개),
 * 모의 설정의 참·거짓 체크 상자(13px), 정렬할 수 있는 표 머리(↕ 20px), 스타일·위험의 '미커버 N종목 보기'(16px). 검토에서 더한 곳: 상세 화면
 * AI 요약의 '요약 근거' 목록(조사 때 요약을 열지 않아 재지 않음). 그린 DOM의 누름 자리마다 클래스로 lg 미만 44px을 따집니다
 * (lib/__tests__/touchTargetAudit — 문장 안의 링크는 WCAG 2.5.8 글 안 예외로 셈에서 뺌). 정보 검색(/search)은 행 전체가 min-h-11이라
 * 조사의 안쪽 링크 숫자(51개)는 과대 계산이었습니다 — 여기서 보지 않습니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다(누름 자리는 차트 밖에 있음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  HorizontalBars: () => null,
  SignedBars: () => null,
  WeightHeatmap: () => null,
  ScatterPlot: () => null,
  DonutChart: () => null,
  LineSeries: () => null,
}));

import { DataTable } from "@/components/patterns";
import { AiSummaryCard } from "@/components/screens/detail/DetailParts";
import { SourceCard } from "@/components/screens/info/CatalogSection";
import { NewsSection } from "@/components/screens/info/NewsSection";
import { IndicatorDetailScreen } from "@/components/screens/detail/IndicatorDetailScreen";
import { InstitutionDetailScreen } from "@/components/screens/detail/InstitutionDetailScreen";
import { StockDetailScreen } from "@/components/screens/detail/StockDetailScreen";
import PaperPage from "@/components/screens/paper/PaperScreen";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import type { CatalogSource } from "@/lib/info";
import type { DetailQuote, SessionUser } from "@/lib/types";
import RadarPage from "../radar/page";
import GuruPage from "../style/page";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };

/** 경로 앞부분 → 응답. 긴 앞부분부터 맞추고, 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(reads[key]);
  });
});
afterEach(() => cleanup());

const renderAs = (page: ReactElement) => render(<SessionUserProvider user={PRO}>{page}</SessionUserProvider>);

const CATALOG = { checkedAt: "2026-11-15 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };

const ARTICLE = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article",
  url: "https://blog.example/2026/11/15/rates/", title: "Synthetic rates outlook", titleKo: null, author: "A. Writer",
  publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: "합성 요약", bodyStatus: "full",
  fetchTier: null, category: null,
};

const SOURCE: CatalogSource = {
  task: "global_synthetic", key: "synthetic", label: "합성 출처", tab: "global", kind: "feed", siteUrl: "https://source.example/",
  origin: "합성 기관", access: "official", screen: "/macro", speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-15 09:00 KST",
  lastDetail: null, politeStatus: null, streak: null, lastOkAt: "2026-11-15 09:00 KST", nextDueAt: null, items: null, incident: null, tone: "ok",
};

function quote(): DetailQuote {
  return {
    market: "us", code: "SYNQ", yahooSymbol: "SYNQ", name: "Synthetic Quote Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
    price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
    stats: [{ key: "trailingPE", label: "PER", value: 12.3, text: null, unit: "x" }],
    profile: {
      sector: "Technology", industry: "Software", country: "United States", website: "https://synq.example", employees: 100, summary: "Synthetic.",
      summaryKo: "합성 회사.", industryKo: "소프트웨어", koSource: { label: "합성 개요 출처", url: "https://ko.example/synq" },
    },
    consensus: null,
    research: [{ title: "합성 리포트", broker: "합성 증권", date: "2026-11-14", url: "https://research.example/1" }],
    source: { label: "합성 시세", url: "https://quote.example/SYNQ" }, error: null, fetchedAt: "2026-11-15T00:00:00+00:00",
  };
}

const NEWS = {
  available: true,
  news: {
    items: [{ title: "Synthetic headline", url: "https://news.example/a", publisher: "Wire", publishedAt: "2026-11-15T00:00:00Z", source: "Google News" }],
    errors: {}, error: null, fetchedAt: "2026-11-15T00:00:00Z",
  },
};

describe("좁은 화면 누르는 자리 44px — 조사가 짚은 화면(QA-458)", () => {
  // 수정 전에는 아래 누름 자리가 모두 걸렸다(재현 커밋에서는 it.fails). 지금은 따로 선 글 링크·단추에 TEXT_TARGET(ui/classes —
  // 좁은 화면 min-h-11, lg 이상 글 높이), 체크 상자는 감싼 label, 표 머리·레이더 '원문'·'다른 곳에서 보기'·summary는 각자 min-h-11과 lg 변형.
  //  - 정보 수집 뉴스·글: 제목 단추, '번역', '본문 보기', '원문 열기'(블로그 글·헤드라인 모두)
  it("정보 수집 뉴스·글 — 제목 단추와 '번역·본문 보기·원문 열기'", async () => {
    reads = {
      [endpoints.info.catalog]: CATALOG,
      "/api/info/items?kind=blog": { available: true, items: [ARTICLE], page: 1, size: 10, total: 11, pages: 2 },
      "/api/info/headlines?set=world": {
        available: true, page: 1, size: 10, total: 1, pages: 1,
        items: [{ set: "world", title: "Synthetic press release", summary: null, link: "https://press.example/1", source: "Synthetic Wire",
          feed: "synthetic", publishedAt: "2026-11-15 09:00:00 KST", fetchedAt: "2026-11-15T00:10:00+00:00", timeBasis: "published" }],
      },
    };
    const { container } = render(<NewsSection />);
    await screen.findByRole("button", { name: "Synthetic rates outlook" });
    expect(screen.getByRole("link", { name: "원문 열기" })).toBeTruthy();
    const blog = smallTargets(container);
    fireEvent.click(screen.getByRole("button", { name: "보도자료·경제지" }));
    await screen.findByRole("button", { name: "Synthetic press release" });
    expect([...blog, ...smallTargets(container)]).toEqual([]);
  });

  //  - 해외·공시·모의매매 입력 출처 카드: '출처 사이트', '자료 보기'
  it("정보 수집 출처 카드 — '출처 사이트·자료 보기'", () => {
    const { container } = render(<ul><SourceCard source={SOURCE} /></ul>);
    expect(screen.getByRole("link", { name: "자료 보기" })).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
  });

  //  - 수급 레이더 재무 표: '원문'(클래스 min-h-6 = 24px, 조사 측정 40px)
  it("수급 레이더 재무 표 — '원문'", async () => {
    reads = {
      "/api/radar/ranking": {
        available: true, market: "KOSPI", investor: "외국인", tradeType: "순매수", readMode: "auto", source: "합성 순위", sourceKind: "krx",
        isHistorical: false, historyDate: null, intervalType: "TODAY", dataDate: "2026-11-14",
        rows: [{ rank: 1, code: "000001", name: "합성전자", price: 1000, changePct: 1.2, netAmountEok: 10 }],
      },
      [endpoints.publicData.fundamentals("000001")]: {
        available: true, priceDate: "2026-11-14", companies: [
          { code: "000001", available: true, name: "합성전자", bsnsYear: "2025", fsLabel: "연결", dartUrl: "https://dart.example/1", debtRatio: 50,
            roe: 10, operatingMargin: 5, revenueGrowth: 3, operatingIncomeGrowth: 4, marketCap: 1e12, per: 10, pbr: 1 },
        ],
      },
    };
    renderAs(<RadarPage />);
    const link = await screen.findByRole("link", { name: "원문" });
    const card = link.closest("section") as HTMLElement;
    expect(smallTargets(card)).toEqual([]);
  });

  //  - 종목 상세: '출처 보기', '정보 검색', 뉴스 제목, 리서치·회사 개요 출처·홈페이지 링크, 13F 보유 기관 이름, '다른 곳에서 보기'(min-h-9)
  it("종목 상세 — 출처·뉴스·리서치·개요·보유 기관·다른 곳에서 보기 링크", async () => {
    reads = {
      [endpoints.detail.quote("us", "SYNQ")]: { available: true, quote: quote() },
      "/api/detail/news": NEWS,
      [endpoints.macro.ticker("SYNQ", "1y")]: { available: true, points: [{ date: "2026-11-13", close: 9.5 }, { date: "2026-11-14", close: 10 }] },
      "/api/guru/holders": {
        available: true, query: "SYNTHETIC QUOTE", rows: [
          { institution: "합성 자산운용", cik: "0000000011", name: "SYNTHETIC QUOTE INC", cusip: "000000201", weight: 1.25, value: 5e7, reportDate: "2026-09-30" },
        ],
      },
    };
    const { container } = renderAs(<StockDetailScreen market="us" code="SYNQ" />);
    // 가운데 탭(개요·뉴스·리서치·보유 기관 — P4)마다 보이는 누름 자리를 따집니다(숨긴 탭은 감사가 건너뜀). 보유 기관 줄은 목록-검사의 줄 단추이고
    // 기관 상세 링크는 줄을 누르면 여는 대화상자(body 끝에 그림) 안이라 그것도 봅니다.
    await screen.findByRole("link", { name: /한국어 개요 출처/ });
    const found = [...smallTargets(container)];
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    await screen.findByRole("link", { name: /Synthetic headline/ });
    found.push(...smallTargets(container));
    fireEvent.click(screen.getByRole("tab", { name: "리서치" }));
    await screen.findByRole("link", { name: /합성 리포트/ });
    found.push(...smallTargets(container));
    fireEvent.click(screen.getByRole("tab", { name: "보유 기관" }));
    fireEvent.click(await screen.findByRole("button", { name: /합성 자산운용/ }));
    const dialog = await screen.findByRole("dialog", { name: "합성 자산운용" });
    expect(within(dialog).getByRole("link", { name: "기관 상세 열기" })).toBeTruthy();
    found.push(...smallTargets(dialog));
    expect(found).toEqual([]);
  });

  //  - 상세 화면 공용 AI 요약: '요약 근거' 목록의 출처 링크(따로 선 링크가 4px 간격으로 쌓인 목록 — 검토 지적). 문장 끝의 위첨자 [n]은
  //    문장 안 링크(글 안 예외)라 셈에서 빠집니다 — 이 시험이 그 예외가 실제로 쓰이는 자리입니다.
  it("AI 요약 — 요약 근거 목록의 출처 링크", async () => {
    api.apiPost.mockResolvedValue({
      status: true, summary: "한 줄 요약: 합성 회사는 올랐다 [1]\n- 실적 상회 [2]", model: "claude-haiku-5-5", generatedAtKst: "2026-11-15 10:00 KST",
      cached: false, quota: { used: 1, limit: 20 }, error: null,
      sources: [
        { n: 1, label: "시세·지표 — 합성 시세", url: "https://quote.example/SYNQ" },
        { n: 2, label: "Wire — Synthetic headline", url: "https://news.example/a" },
      ],
    });
    renderAs(<AiSummaryCard request={{ market: "us", code: "SYNQ", q: "Synthetic Quote Inc.", label: "Synthetic Quote Inc." }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AI 요약 만들기" }));
    });
    const list = await screen.findByRole("list", { name: "요약 근거" });
    expect(within(list).getAllByRole("link")).toHaveLength(2);
    const card = list.closest("section") as HTMLElement;
    const marks = within(card).getAllByRole("link", { name: /^\[\d\]/ });
    expect(marks).toHaveLength(2);
    expect(smallTargets(card)).toEqual([]);
    // 겉모양(P4): 본문은 긴 글 단계(running 15/24, 최대 72자), 근거 번호는 줄 높이를 밀지 않는 상대 위치(align-super 아님) — 번호는 문장 안 링크 그대로.
    const body = within(card).getByText("한 줄 요약: 합성 회사는 올랐다").parentElement as HTMLElement;
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-running", "max-w-[72ch]"]));
    for (const mark of marks) {
      const words = (mark.getAttribute("class") ?? "").split(/\s+/);
      expect(words).toEqual(expect.arrayContaining(["relative", "-top-[0.4em]", "text-xs", "leading-none"]));
      expect(words).not.toContain("align-super");
    }
  });

  //  - 지표 상세: '정보 검색', 뉴스 제목, 'Yahoo 시세 상세' 링크, '다른 곳에서 보기'(min-h-9)
  it("지표 상세 — 뉴스·시세 상세·다른 곳에서 보기 링크", async () => {
    reads = {
      [endpoints.macro.overview(false)]: macroOverview(),
      "/api/calendar/kr-holidays": { available: true, years: {} },
      "/api/detail/news": NEWS,
    };
    const { container } = renderAs(<IndicatorDetailScreen indicatorKey="sp500" />);
    // 가운데 탭(개요·뉴스 — P4)마다 보이는 누름 자리를 따집니다(숨긴 탭은 감사가 건너뜀). 탭 줄의 탭 단추도 셈에 듭니다.
    await screen.findByRole("link", { name: "^GSPC 시세·핵심 지표 보기" });
    const overview = smallTargets(container);
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    await screen.findByRole("link", { name: /Synthetic headline/ });
    expect([...overview, ...smallTargets(container)]).toEqual([]);
  });

  //  - 기관 상세(P4에서 더함 — D1 QA 넘김 touch-targets-lt-lg-missed-by-qa458의 기관 상세 몫, QA-531): 탭마다(개요·보유 종목·뉴스)와 보유 줄 대화상자
  it("기관 상세 — 연결·정보 검색·13F 포트폴리오·보유 줄·뉴스·다른 곳에서 보기 링크", async () => {
    reads = {
      [endpoints.institution.portfolio("0009999996", 8, 30)]: {
        available: true, cik: "0009999996", institution: { name: "🇺🇸 합성 자산운용 (Synthetic Asset)", desc: "합성 소개" },
        collectedAtKst: "2026-11-15 09:00 KST", ageSeconds: 60,
        quarters: [
          { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 9e8, holdingCount: 1 },
          { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1e9, holdingCount: 1 },
        ],
        latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1e9 },
        holdings: [{ name: "SYNTHETIC CO", cusip: "000000001", class: "COM", value: 1e9, shares: 1000, weight: 100, weightDiff: 0.5, sharesDiff: 10, action: "증가" }],
      },
      "/api/detail/news": NEWS,
    };
    const { container } = renderAs(<InstitutionDetailScreen cik="0009999996" />);
    await screen.findByRole("link", { name: "13F 포트폴리오(분기·비중 추이)" });
    const found = [...smallTargets(container)];
    fireEvent.click(screen.getByRole("tab", { name: "보유 종목" }));
    await screen.findByRole("link", { name: "13F 포트폴리오에서 자세히" });
    found.push(...smallTargets(container));
    fireEvent.click(within(screen.getByRole("list", { name: "상위 보유 종목" })).getByRole("button"));
    found.push(...smallTargets(await screen.findByRole("dialog", { name: "SYNTHETIC CO" })));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    await screen.findByRole("link", { name: /Synthetic headline/ });
    found.push(...smallTargets(container));
    expect(found).toEqual([]);
  });

  //  - 모의 설정: 참·거짓 키의 체크 상자(13px, 감싼 label 없음)
  it("모의 설정 — 참·거짓 키의 체크 상자", async () => {
    reads = {
      "/api/paper/overview": {
        available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
        navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
      },
      "/api/paper/settings/history": { available: true, history: [] },
      "/api/paper/settings": {
        available: true, version: 1, body: { parkCashInShy: true }, defaults: { parkCashInShy: true },
        keys: [{ key: "parkCashInShy", type: "boolean", min: null, max: null, affectsRules: true, description: "남는 현금을 SHY에" }],
      },
    };
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
    const checkbox = (await screen.findByLabelText("parkCashInShy")) as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    // 배치 클래스(.grid 등)가 아니라 구조로 — 상자(또는 감싼 label)가 놓인 칸. 재배치 뒤에도 감싼 label이 없으면 상자가 걸립니다.
    const cell = (checkbox.closest("label") ?? checkbox).parentElement;
    expect(cell).not.toBeNull();
    expect(smallTargets(cell as HTMLElement)).toEqual([]);
    // 높이만이 아니라 폭도 — '예' 글 하나면 감싼 label이 35px이었습니다(QA-757, 넓은 화면 24px는 paperSettingsQa757).
    expect(checkbox.closest("label")?.className.split(/\s+/)).toContain("min-w-11");
  });

  //  - 정렬할 수 있는 표 머리(DataTable — 보유·체결 표 등): ↕ 단추
  it("정렬할 수 있는 표 머리 단추", () => {
    const { container } = render(
      <DataTable
        caption="합성 표"
        rows={[{ id: "a", value: 1 }, { id: "b", value: 2 }]}
        rowKey={(row) => row.id}
        columns={[
          { key: "id", header: "이름", cell: (row) => row.id },
          { key: "value", header: "값", align: "right", cell: (row) => row.value, sortValue: (row) => row.value },
        ]}
      />,
    );
    expect(within(container).getByRole("button", { name: /값/ })).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
  });

  //  - 스타일·위험: '미커버 N종목 보기'(summary 16px)
  it("스타일·위험 — '미커버 N종목 보기'", async () => {
    reads = {
      "/api/guru/risk": {
        available: false, message: "가격을 찾을 수 있는 종목이 없습니다.", cik: "0001067983", benchmark: "SPY", years: 1,
        coverage: {
          holdings: 0, totalHoldings: 1, weight: 0, totalWeight: 30, uncoveredCount: 1,
          uncovered: [{ name: "SYNTHETIC PREFERRED", weight: 30, reason: "보통주가 아님(우선주·워런트 등)" }],
        },
      },
    };
    render(<GuruPage />);
    const summary = await screen.findByText("미커버 1종목 보기");
    await waitFor(() => expect(summary.closest("details")).not.toBeNull());
    expect(smallTargets(summary.closest("details") as HTMLElement)).toEqual([]);
  });
});
