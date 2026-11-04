/**
 * 통합 검색 색인·일치 — 정규화(대소문자·공백·기호·한글 자모), 순위(정확 > 앞부분 > 중간), 범주 묶음과 상한(브리프 §1.4).
 */
import { describe, expect, it } from "vitest";
import { navSearchItems } from "../nav";
import {
  SEARCH_PER_GROUP,
  buildSearchIndex,
  indicatorEntries,
  institutionEntries,
  menuEntries,
  noResultText,
  resultSummary,
  searchGroups,
  searchKey,
  sourceNotice,
  SYMBOL_GROUP_LABEL,
  symbolGroup,
  symbolNotice,
  tickerEntries,
  tickerHref,
  type SearchEntry,
} from "../search";
import type { DetailSymbolsResponse, MacroOverview, StockUniverseResponse } from "../types";

const OVERVIEW = {
  available: true,
  readMode: "auto",
  categories: [
    {
      id: "fx",
      title: "환율",
      items: [
        { key: "dxy", name: "달러 인덱스 (DXY)", ticker: "DX-Y.NYB", status: "ok" },
        { key: "usdkrw", name: "원/달러 (USD/KRW)", ticker: "KRW=X", status: "ok" },
      ],
    },
    {
      id: "index",
      title: "주가지수",
      items: [
        { key: "sp500", name: "S&P 500", ticker: "^GSPC", status: "ok" },
        { key: "ndx", name: "나스닥 100", ticker: null, status: "fail" },
        { key: "dxy", name: "달러 인덱스 (중복)", ticker: "DX-Y.NYB", status: "ok" },
      ],
    },
  ],
} as unknown as MacroOverview;

const INSTITUTIONS = {
  institutions: [
    { key: "berkshire", name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", cik: "0001067983", desc: "가치투자 포트폴리오, 핵심 우량주 집중" },
    { key: "bridgewater", name: "🇺🇸 브리지워터 어소시에이츠 (Bridgewater)", cik: "0001350694", desc: "레이 달리오 설립, 올웨더 및 글로벌 매크로 헤지펀드" },
  ],
};

const UNIVERSE: StockUniverseResponse = {
  available: true,
  rows: [
    { ticker: "AAPL", name: "Apple Inc.", sector: "Technology" },
    { ticker: "AMZN", name: "Amazon.com Inc.", sector: null },
  ],
};

const entry = (label: string, kind: SearchEntry["kind"] = "menu", keywords: string[] = []): SearchEntry => ({
  kind, id: `${kind}:${label}`, label, sub: null, href: "/x", dest: null, keywords,
});

const labels = (groups: ReturnType<typeof searchGroups>) => groups.map((group) => [group.kind, group.items.map((item) => item.label)]);

describe("정규화", () => {
  it("대소문자·공백·기호·전각을 무시한다", () => {
    expect(searchKey("AAPL").jamo).toBe("aapl");
    expect(searchKey("ＡＡＰＬ").jamo).toBe("aapl");
    expect(searchKey("S&P 500").jamo).toBe("sp500");
    expect(searchKey("  ^GSPC ").jamo).toBe("gspc");
    expect(searchKey("🇺🇸 · —").jamo).toBe("");
  });

  it("한글은 자모로 풀어 — 분해형(NFD) 입력도 같은 열쇠, 겹모음·겹받침은 낱자로", () => {
    expect(searchKey("매크로".normalize("NFD"))).toEqual(searchKey("매크로"));
    expect(searchKey("과").jamo).toBe("ㄱㅗㅏ");
    expect(searchKey("닭").jamo).toBe("ㄷㅏㄹㄱ");
    expect(searchKey("시장").cho).toBe("ㅅㅈ");
  });

  it("입력 중인 글자(맼 → 매크로)·초성(ㅅㅈ → 시장)·호환 자모 한 글자도 맞는다", () => {
    const index = buildSearchIndex([entry("매크로 지표"), entry("시장"), entry("기관")]);
    expect(labels(searchGroups(index, "맼"))).toEqual([["menu", ["매크로 지표"]]]);
    expect(labels(searchGroups(index, "ㅅㅈ"))).toEqual([["menu", ["시장"]]]);
    expect(labels(searchGroups(index, "ㄱ"))).toEqual([["menu", ["기관"]]]);
  });
});

describe("순위", () => {
  it("정확히 같음 > 앞부분 > 중간, 같은 단계면 원래 순서", () => {
    const index = buildSearchIndex([entry("미국채 10년물"), entry("10년 기대 인플레"), entry("10년"), entry("미국 10년")]);
    expect(labels(searchGroups(index, "10년"))).toEqual([["menu", ["10년", "10년 기대 인플레", "미국채 10년물", "미국 10년"]]]);
  });

  it("같은 단계면 이름으로 맞은 것이 다른 말로 맞은 것보다 앞선다", () => {
    const index = buildSearchIndex([entry("국면 판정", "menu", ["시장 국면 판정"]), entry("시장")]);
    expect(labels(searchGroups(index, "시장"))).toEqual([["menu", ["시장", "국면 판정"]]]);
  });

  it("티커를 정확히 치면 이름이 앞부분만 맞는 종목보다 앞선다", () => {
    const index = buildSearchIndex([...tickerEntries({ ...UNIVERSE, rows: [{ ticker: "AAPLX", name: "aapl fund", sector: null }, ...UNIVERSE.rows] })]);
    expect(labels(searchGroups(index, "aapl"))).toEqual([["ticker", ["Apple Inc.", "aapl fund"]]]);
  });
});

describe("묶음과 상한", () => {
  const index = buildSearchIndex([
    ...menuEntries(navSearchItems({ email: "m@x", role: "MEMBER", tier: "FREE" })),
    ...indicatorEntries(OVERVIEW),
    ...institutionEntries(INSTITUTIONS),
    ...tickerEntries(UNIVERSE),
  ]);

  it("범주 순서는 색인 순서와 상관없이 메뉴 → 지표 → 기관 → 종목, 맞은 것이 없는 범주는 빠진다", () => {
    const mixed = buildSearchIndex([
      entry("공통 종목", "ticker"), entry("공통 기관", "institution"), entry("공통 지표", "indicator"), entry("공통 메뉴", "menu"),
    ]);
    expect(labels(searchGroups(mixed, "공통"))).toEqual([
      ["menu", ["공통 메뉴"]], ["indicator", ["공통 지표"]], ["institution", ["공통 기관"]], ["ticker", ["공통 종목"]],
    ]);
    expect(searchGroups(index, "버크셔").map((group) => group.kind)).toEqual(["institution"]);
    expect(labels(searchGroups(index, "aapl"))).toEqual([["ticker", ["Apple Inc."]]]);
    expect(labels(searchGroups(index, "gspc"))).toEqual([["indicator", ["S&P 500"]]]);
  });

  it("검색어가 비었거나 기호뿐이면 결과가 없다", () => {
    expect(searchGroups(index, "")).toEqual([]);
    expect(searchGroups(index, "  · ")).toEqual([]);
    expect(searchGroups(index, "없는말")).toEqual([]);
  });

  it("범주마다 상한까지만 보이고 넘친 수를 more로 알린다(조용히 자르지 않음)", () => {
    const many = buildSearchIndex(Array.from({ length: 9 }, (_, at) => entry(`종목 ${at}`, "ticker")));
    const [group] = searchGroups(many, "종목");
    expect(group.items).toHaveLength(SEARCH_PER_GROUP);
    expect(group.total).toBe(9);
    expect(group.more).toBe(9 - SEARCH_PER_GROUP);
    expect(searchGroups(many, "종목", 20)[0].more).toBe(0);
  });

  it("결과 수 안내는 맞은 수를 말하고, 상한 때문에 덜 보이면 보이는 수를 함께 말한다", () => {
    const many = buildSearchIndex([
      ...Array.from({ length: 9 }, (_, at) => entry(`종목 ${at}`, "ticker")),
      entry("종목 스코어카드", "menu"),
    ]);
    expect(resultSummary(searchGroups(many, "종목"))).toBe(`결과 10건 중 ${1 + SEARCH_PER_GROUP}건 표시`);
    expect(resultSummary(searchGroups(many, "종목", 20))).toBe("결과 10건");
    expect(resultSummary(searchGroups(many, "없는말"))).toBe("결과 0건");
  });

  // 색인이 덜 찬 동안(지표·기관·종목을 읽는 중·실패)의 "결과 0건"·"맞는 결과가 없습니다"는 사실이 아니다.
  it("아직 다 읽지 못한 범주가 있으면 수 안내 뒤에 그 이유를 붙이고, 결과 없음을 단정하지 않는다", () => {
    const index = buildSearchIndex([entry("순유동성", "menu")]);
    const pending = ["종목: 불러오는 중…", "기관: 불러오지 못했습니다 — 시간 초과"];
    expect(resultSummary(searchGroups(index, "aapl"), pending)).toBe("결과 0건 — 종목: 불러오는 중… · 기관: 불러오지 못했습니다 — 시간 초과");
    expect(resultSummary(searchGroups(index, "순유"), pending)).toBe("결과 1건 — 종목: 불러오는 중… · 기관: 불러오지 못했습니다 — 시간 초과");
    expect(resultSummary(searchGroups(index, "순유"), [])).toBe("결과 1건");

    expect(noResultText("aapl", pending)).toBe("‘aapl’와 맞는 결과가 아직 없습니다 — 일부 범주를 다 읽지 못했습니다(아래 안내).");
    expect(noResultText("aapl")).toBe("‘aapl’와 맞는 결과가 없습니다.");
  });
});

describe("색인 항목", () => {
  it("지표: 매크로 카드 이름·티커 → 지표 상세(/markets/i/<키>), 같은 키는 한 번만, 저장본이 없으면 비어 있다", () => {
    const entries = indicatorEntries(OVERVIEW);
    expect(entries.map((item) => item.label)).toEqual(["달러 인덱스 (DXY)", "원/달러 (USD/KRW)", "S&P 500", "나스닥 100"]);
    expect(entries[0]).toMatchObject({ kind: "indicator", sub: "환율 · DX-Y.NYB", href: "/markets/i/dxy", dest: "지표 상세", keywords: ["DX-Y.NYB", "dxy"] });
    expect(entries[3]).toMatchObject({ sub: "주가지수", keywords: ["ndx"] });
    // 범주 제목의 예전 그림 문자는 보조 글에서 뗀다
    const flagged = { ...OVERVIEW, categories: [{ ...OVERVIEW.categories[0], title: "💵 통화 및 환율" }] } as MacroOverview;
    expect(indicatorEntries(flagged)[0].sub).toBe("통화 및 환율 · DX-Y.NYB");
    expect(indicatorEntries({ ...OVERVIEW, available: false })).toEqual([]);
    expect(indicatorEntries(null)).toEqual([]);
  });

  it("기관: 국기를 뗀 이름·CIK → 기관 상세(/institutions/<CIK>), 운용자 소개로도 찾는다('달리오' → 브리지워터)", () => {
    const entries = institutionEntries(INSTITUTIONS);
    expect(entries[0]).toMatchObject({
      kind: "institution", label: "버크셔 해서웨이 (Berkshire Hathaway)", sub: "13F · CIK 0001067983", href: "/institutions/0001067983", dest: "기관 상세",
    });
    const index = buildSearchIndex(entries);
    expect(labels(searchGroups(index, "달리오"))).toEqual([["institution", ["브리지워터 어소시에이츠 (Bridgewater)"]]]);
    expect(labels(searchGroups(index, "1067983"))).toEqual([["institution", ["버크셔 해서웨이 (Berkshire Hathaway)"]]]);
    expect(institutionEntries(undefined)).toEqual([]);
  });

  it("종목: 이름·티커·섹터 → 종목 상세(/s/us/<티커>, Yahoo 형식 국내 종목은 /s/kr/<코드>), 저장본이 없으면 비어 있다", () => {
    const entries = tickerEntries(UNIVERSE);
    expect(entries[0]).toMatchObject({ kind: "ticker", label: "Apple Inc.", sub: "AAPL · Technology", href: "/s/us/AAPL", dest: "종목 상세" });
    expect(tickerHref("BRK-B")).toBe("/s/us/BRK-B");
    expect(tickerHref("^gspc")).toBe("/s/us/%5EGSPC");
    expect(tickerHref("069500.KS")).toBe("/s/kr/069500");
    expect(tickerHref("035720.kq")).toBe("/s/kr/035720");
    expect(entries[1].sub).toBe("AMZN");
    expect(tickerEntries({ available: false, message: "저장본 없음", rows: [] })).toEqual([]);
  });

  it("메뉴: 탭 이름이 화면 이름과 같으면(홈) 보조 글을 두지 않는다", () => {
    const entries = menuEntries(navSearchItems(undefined));
    expect(entries[0]).toMatchObject({ kind: "menu", label: "홈", sub: null, href: "/", dest: null });
    expect(entries.find((item) => item.href === "/macro")?.sub).toBe("시장");
  });

  it("결과 행 왼쪽 원 — 메뉴는 그 화면의 탭 아이콘, 지표는 시장·기관은 기관 아이콘, 종목은 티커 모노그램", () => {
    const menus = menuEntries(navSearchItems({ email: "o@x", role: "OWNER", tier: "PRO" }));
    expect(menus.find((item) => item.href === "/liquidity")?.avatar).toEqual({ tab: "markets" });
    expect(menus.find((item) => item.href === "/paper/kr")?.avatar).toEqual({ tab: "paper" });
    expect(menus.find((item) => item.href === "/more")?.avatar).toEqual({ tab: "more" });
    expect(indicatorEntries(OVERVIEW)[0].avatar).toEqual({ tab: "markets" });
    expect(institutionEntries(INSTITUTIONS)[0].avatar).toEqual({ tab: "institutions" });
    expect(tickerEntries(UNIVERSE).map((item) => item.avatar)).toEqual([{ text: "AAP" }, { text: "AMZ" }]);
    // 영문 티커가 아니면 이름 첫 글자, 그것도 없으면 빈 원
    expect(tickerEntries({ available: true, rows: [{ ticker: "005930", name: "삼성전자", sector: null }] })[0].avatar).toEqual({ text: "삼" });
    expect(tickerEntries({ available: true, rows: [{ ticker: "", name: "", sector: null }] })[0].avatar).toBeUndefined();
  });

  it("메뉴: 무료 회원에게 잠긴 유료 화면은 locked를 그대로 넘긴다(결과의 자물쇠 아이콘)", () => {
    const entries = menuEntries(navSearchItems({ email: "m@x", role: "MEMBER", tier: "FREE" }));
    expect(entries.find((item) => item.href === "/ai/report")?.locked).toBe(true);
    expect(entries.find((item) => item.href === "/macro")?.locked).toBe(false);
  });
});

describe("범주 자료 상태", () => {
  it("읽는 중·실패·저장본 없음은 한 줄로, 자료가 있으면 null", () => {
    expect(sourceNotice("종목", { loading: true, error: null, data: null })).toBe("종목: 불러오는 중…");
    expect(sourceNotice("종목", { loading: false, error: "시간 초과", data: null })).toBe("종목: 불러오지 못했습니다 — 시간 초과");
    expect(sourceNotice("종목", { loading: false, error: null, data: { available: false, message: "저장본이 없습니다." } }))
      .toBe("종목: 저장본이 없습니다.");
    expect(sourceNotice("종목", { loading: false, error: null, data: { available: false } })).toBe("종목: 저장본이 아직 없습니다");
    expect(sourceNotice("기관", { loading: false, error: null, data: INSTITUTIONS })).toBeNull();
    expect(sourceNotice("종목", { loading: false, error: null, data: null })).toBeNull();
  });

  it("종목 찾기는 200 응답 안의 출처 실패도 적는다(QA-256) — 모두 실패는 출처 이름(없으면 원문), 일부 실패는 그 출처, 실패 없으면 null", () => {
    const state = (symbols: DetailSymbolsResponse["symbols"]) =>
      ({ loading: false, error: null, data: { available: true, symbols } satisfies DetailSymbolsResponse });
    expect(symbolNotice(state({ items: [], errors: { "네이버 증권": "x", "Yahoo Finance": "y" }, error: "x; y" })))
      .toBe(`${SYMBOL_GROUP_LABEL}: 출처를 받지 못했습니다(네이버 증권·Yahoo Finance)`);
    expect(symbolNotice(state({ items: [], error: "시간 초과" }))).toBe(`${SYMBOL_GROUP_LABEL}: 출처를 받지 못했습니다 — 시간 초과`);
    expect(symbolNotice(state({ items: [], errors: { "네이버 증권": "x" }, error: null })))
      .toBe(`${SYMBOL_GROUP_LABEL}: 일부 출처를 받지 못했습니다(네이버 증권)`);
    expect(symbolNotice(state({ items: [], errors: {}, error: null }))).toBeNull();
    expect(symbolNotice({ loading: false, error: "연결 실패", data: null })).toBe(`${SYMBOL_GROUP_LABEL}: 불러오지 못했습니다 — 연결 실패`);
  });
});

describe("종목 찾기(외부 검색 묶음)", () => {
  const SYMBOLS: DetailSymbolsResponse = {
    available: true,
    symbols: {
      items: [
        { market: "us", code: "AAPL", yahooSymbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", kind: "EQUITY", source: "Yahoo Finance" },
        { market: "us", code: "APLE", yahooSymbol: "APLE", name: "Apple Hospitality REIT", exchange: "NYSE", kind: "EQUITY", source: "Yahoo Finance" },
        { market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자", exchange: "코스피", kind: "stock", source: "네이버 증권" },
        { market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자(중복)", exchange: null, kind: null, source: "Yahoo Finance" },
      ],
    },
  };

  it("색인에 이미 있는 종목·겹치는 주소는 빼고 종목 상세로 — 보조 글은 코드·거래소·종류·출처", () => {
    const shown = searchGroups(buildSearchIndex(tickerEntries(UNIVERSE)), "apple");
    const group = symbolGroup(SYMBOLS, shown);
    expect(group).toMatchObject({ kind: "symbol", label: SYMBOL_GROUP_LABEL, total: 2, more: 0 });
    expect(group?.items.map((item) => [item.label, item.href, item.sub, item.dest])).toEqual([
      ["Apple Hospitality REIT", "/s/us/APLE", "APLE · NYSE · 주식 · Yahoo Finance", "종목 상세"],
      ["삼성전자", "/s/kr/005930", "005930 · 코스피 · 주식 · 네이버 증권", "종목 상세"],
    ]);
  });

  it("결과가 없거나 응답이 없으면(조회하지 않음 포함) 묶음을 그리지 않는다, 상한을 넘으면 more", () => {
    expect(symbolGroup(null, [])).toBeNull();
    expect(symbolGroup({ available: false, message: "store_only" }, [])).toBeNull();
    expect(symbolGroup({ available: true, symbols: { items: [] } }, [])).toBeNull();
    expect(symbolGroup(SYMBOLS, [], 1)).toMatchObject({ total: 3, more: 2 });
  });
});
