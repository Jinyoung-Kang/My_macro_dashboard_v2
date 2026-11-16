/**
 * 홈(/) 표시 규칙(lib/home.ts).
 *  - 국면: 백엔드 라벨·문장 그대로, 신호 네 자리 고정(빠진 신호는 "—"+사유), 판정 불가면 받지 못한 입력 목록, 응답이 없어도 네 타일
 *  - 시장: 카드 → 자산 행(priceStr·delta/pct 그대로, "N/A"·null은 값 없음/칩 생략, 수집 실패는 값·변화를 비우고 "수집 실패"),
 *    추정·이전 값·참고 시세·경고는 넘기고, 장 상태는 보는 시각 기준 — 지연은 열린 장에만("개장 · 실시간"), 닫힌 장은 "마감"만,
 *    이어받은 값·실패에는 지연을 붙이지 않음, 변화량 자릿수는 deltaStr을 따름
 *  - 모의매매 패널: 네 계좌 줄(모의매매 개요와 같은 bookAssetRow — 출발 대비 수익률, 오래됨·사후 체결 대기), 출처, 정기 작업 꺼짐 안내, 처음 현금.
 *    개요 응답에 지금 값(current)이 있으면 줄이 같은 지금 값과 같은 단계 표기(lib/paperCurrent)
 *  - 알림: 모르는 수는 null(화면 "—"), 지난 사건은 강조하지 않음 / 저장소 상태: 모르는 수는 null, 수집기 연결 안 됨·누락 데이터셋
 *  - 계좌 손익 표: 개요의 계좌 행 규칙(bookAssetRow) + 최근 변화(서버 dayChangePct)·기준 칸, 출발 전·옛 응답은 '—'
 *  - 끊긴 출처: 서버 순서 그대로, 판정 기록이 없으면 '없음'이라 적지 않음 / KPI 띠: 국면·시장 넷·읽지 않은 알림·수집 오류(운영자), 모의 값 없음,
 *    읽는 중 자리표시·읽지 못함 '—'
 */
import { describe, expect, it } from "vitest";

import {
  COLLECTOR_UNREACHABLE_NOTE,
  deltaDigits,
  HOME_KPI_MARKET_KEYS,
  HOME_REFRESH_MS,
  type HomeKpi,
  type HomeKpiInput,
  homeKpiItems,
  KPI_NOT_IN_SNAPSHOT,
  KPI_READ_FAILED,
  latestAlerts,
  macroCardRow,
  macroCardSession,
  macroItemSource,
  type MarketClock,
  MARKET_HREF,
  marketGroups,
  NO_SOURCE_INCIDENTS,
  PAPER_COMPARE_NOTE,
  PAPER_DISABLED_NOTE,
  PAPER_HREF,
  PAPER_KR_HREF,
  paperHomeModel,
  paperPnlRows,
  pickMarketGroup,
  regimeHeroModel,
  sourceIncidentsModel,
  storeStatusModel,
  unreadText,
} from "../home";
import { TABS } from "../nav";
import { PAPER_SOURCES } from "../paper";
import { bookAssetRow, PENDING_BACKFILL_WARNING } from "../paperOverview";
import { assetRowModel } from "../patternRows";
import { provenanceText } from "../patterns";
import {
  book,
  inbox,
  incident,
  infoSources,
  issues,
  macroItem,
  macroOverview,
  paperOverview,
  paperOverviewKr,
  paperOverviewKrDormant,
  paperStatus,
  paperStatusKr,
  regimeExpansion,
  regimeUnknown,
} from "./homeFixtures";

// 2026-10-26(월) 16:51 KST = 뉴욕 03:51 — 외환·CME는 개장, 뉴욕 증시는 장 전(마감), KRX 선물은 주간장과 야간장 사이(휴식).
const MON_1651 = new Date("2026-10-26T07:51:00Z");
const CLOCK: MarketClock = { now: MON_1651, krOfficial: null, collectedAt: "2026-10-26 16:51 KST" };

/** 행의 출처 배지 글(AssetRow가 ProvenanceBadge로 그리는 글과 같음). */
const badge = (row: { source?: string | null; asOf?: string | null; delayMin?: number | null }) => provenanceText(row);

describe("regimeHeroModel — 오늘의 국면", () => {
  it("판정 라벨·문장·기준일은 백엔드 값 그대로, 신호 타일은 금리차·NFCI·하이일드·순유동성 순서", () => {
    const model = regimeHeroModel(regimeExpansion());
    expect(model.label).toBe("확장 (Expansion)");
    expect(model.known).toBe(true);
    expect(model.summary).toBe("성장·신용 신호가 모두 정상이고 유동성도 들어오고 있습니다. 위험자산에 우호적인 조합입니다.");
    expect(model.asOf).toBe("2026-10-16");
    expect(model.missing).toEqual([]);
    expect(model.tiles.map((tile) => tile.id)).toEqual(["curve", "nfci", "hyOas", "liquidity"]);
    expect(model.note).toBe("임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.");
  });

  it("값과 단위를 나눠 적고(단위는 백엔드 unit, 빈 단위는 없음), 상태·해석 글을 붙인다", () => {
    const [curve, nfci, hyOas, liquidity] = regimeHeroModel(regimeExpansion()).tiles;
    expect(curve).toMatchObject({ label: "장단기 금리차 10Y-3M", valueText: "+0.78", unit: "%p", emptyReason: null });
    expect(curve.note).toBe("정상 · 장기 금리가 단기보다 높습니다(정상 구조).");
    expect(nfci).toMatchObject({ valueText: "\u22120.496", unit: null });
    expect(hyOas).toMatchObject({ valueText: "3.40", unit: "%p" });
    // 0.031조 달러를 0.03으로 뭉개지 않습니다.
    expect(liquidity).toMatchObject({ valueText: "+0.031", unit: "조 달러", note: "확대 · 최근 4주 동안 시장으로 유동성이 들어왔습니다." });
  });

  // QA-600: 부호 있는 세 신호(금리차·NFCI·순유동성 4주 변화)가 formatSigned(ASCII 하이픈)로 찍혀, 같은 홈 화면의 변화 칩·KPI(−, U+2212)와
  // 음수 글자가 섞였습니다(QA 스택 '-0.487'·'-0.048' — 개편 전부터). 명세 D4: 등락은 ▲▼와 U+2212.
  // 수정 전(재현 커밋에서는 it.fails) 값은 '-0.12'·'-0.496'·'-0.048'(ASCII 하이픈)이었습니다.
  it("부호 있는 신호의 음수는 −(U+2212) — ASCII 하이픈이 아니다, 반올림 뒤 0은 부호 없음 (QA-600)", () => {
    const response = regimeExpansion();
    const signal = (id: string) => response.verdict!.signals.find((entry) => entry.id === id)!;
    signal("curve").value = -0.12;
    signal("liquidity").value = -0.048462;
    const [curve, nfci, hyOas, liquidity] = regimeHeroModel(response).tiles;
    expect([curve.valueText, nfci.valueText, liquidity.valueText]).toEqual(["\u22120.12", "\u22120.496", "\u22120.048"]);
    for (const tile of [curve, nfci, hyOas, liquidity]) {
      expect(tile.valueText, tile.id).not.toMatch(/(^|[\s(])-(?=[\d.])/);
    }
    signal("curve").value = 0.0004;
    signal("nfci").value = -0.0004;
    const [flatCurve, flatNfci] = regimeHeroModel(response).tiles;
    expect([flatCurve.valueText, flatNfci.valueText]).toEqual(["0.00", "0.000"]);
  });

  it("판정 불가 — 라벨·문장은 백엔드 그대로, 받지 못한 입력 목록, 빠진 신호 자리는 '—'(받지 못함)로 남는다", () => {
    const model = regimeHeroModel(regimeUnknown());
    expect(model.label).toBe("판정 불가");
    expect(model.known).toBe(false);
    expect(model.summary).toContain("입력 지표가 빠져");
    expect(model.missing).toEqual(["하이일드 스프레드 (HY OAS)"]);
    expect(model.asOf).toBeNull();
    const hyOas = model.tiles.find((tile) => tile.id === "hyOas");
    expect(hyOas).toEqual({ id: "hyOas", label: "하이일드 스프레드", valueText: null, unit: null, note: null, emptyReason: "받지 못함" });
    expect(model.tiles).toHaveLength(4);
  });

  it("응답·판정이 없으면 '판정 불가'와 빈 타일 네 개 — 0을 만들지 않는다", () => {
    for (const response of [null, undefined, { available: false }]) {
      const model = regimeHeroModel(response);
      expect(model.label).toBe("판정 불가");
      expect(model.known).toBe(false);
      expect(model.summary).toBeNull();
      expect(model.note).toBeNull();
      expect(model.tiles.map((tile) => tile.valueText)).toEqual([null, null, null, null]);
    }
  });

  it("신호 값이 null·NaN이면 값 없음, 백엔드가 다섯째 신호를 보내면 뒤에 붙인다", () => {
    const response = regimeExpansion();
    response.verdict!.signals[0].value = null;
    response.verdict!.signals[1].value = Number.NaN;
    response.verdict!.signals.push({ id: "extra", label: "새 신호", value: 1.234, unit: "%", state: "정상", reading: "", healthy: true });
    const model = regimeHeroModel(response);
    expect(model.tiles[0]).toMatchObject({ valueText: null, emptyReason: "값 없음" });
    expect(model.tiles[1]).toMatchObject({ valueText: null, emptyReason: "값 없음" });
    expect(model.tiles[4]).toMatchObject({ id: "extra", label: "새 신호", valueText: "1.23", unit: "%", note: "정상" });
  });
});

describe("macroCardRow — 매크로 카드 → 자산 행", () => {
  it("값은 수집기 priceStr, 변화는 delta·pct 숫자(자릿수는 deltaStr), 출처·장 상태·시각, 보조는 티커·시장 이름, 링크는 매크로 화면", () => {
    const row = macroCardRow(macroItem({ key: "sp500", name: "S&P 500" }), CLOCK);
    expect(row).toMatchObject({
      id: "sp500",
      name: "S&P 500",
      sub: "^GSPC · 뉴욕증권거래소·나스닥",
      value: 7622.990234375,
      valueText: "7,622.99",
      change: -40.4599609375,
      changePct: -0.5279601211768575,
      changeDigits: 2,
      asOf: "2026-10-24 04:59 KST",
      // 뉴욕 증시는 닫혀 있어 지연(실시간)을 적지 않고 "마감"만
      delayMin: null,
      source: "Yahoo Finance (^GSPC) · 마감",
      isEstimated: false,
      isStale: false,
      staleReason: null,
      warning: null,
      href: MARKET_HREF,
      // 아바타는 티커 앞 글자(assetMonogram — 앞의 ^는 빼고 세 글자까지)
      avatarText: "GSP",
    });
  });

  it("아바타 — 영문 티커가 없으면 이름 첫 글자, 이름도 없으면 그리지 않는다(null)", () => {
    expect(macroCardRow(macroItem({ key: "kr", name: "한국 기준금리", ticker: null }), CLOCK).avatarText).toBe("한");
    expect(macroCardRow(macroItem({ key: "fx", name: "원/달러", ticker: "KRW=X" }), CLOCK).avatarText).toBe("KRW");
    expect(macroCardRow(macroItem({ key: "x", name: "", ticker: "" }), CLOCK).avatarText).toBeNull();
  });

  it("닫힌 장의 이틀 지난 종가·'장 밖' 참고 시세에 '실시간'을 찍지 않는다 — 열린 장만 '개장 · 실시간|N분 지연'", () => {
    // 실측(2026-10-26 월 19:46 KST): S&P 500 delayMinutes 0·lastTs 토요일 04:59, 코스피 TradingView '장 밖'
    const evening: MarketClock = { now: new Date("2026-10-26T10:46:00Z"), krOfficial: null, collectedAt: "2026-10-26 19:37 KST" };
    const sp500 = macroCardRow(macroItem({ key: "sp500", name: "S&P 500" }), evening);
    expect(badge(sp500)).toBe("Yahoo Finance (^GSPC) · 마감 · 2026-10-24 04:59");
    const kospi = macroCardRow(macroItem({
      key: "kospi", name: "코스피", market: "krx", ticker: "^KS11", source: "TradingView (KRX:KOSPI)", delayMinutes: 0, isReference: true,
      lastTs: "2026-10-26 거래일 기준 (TradingView · 장 밖)",
    }), evening);
    expect(badge(kospi)).toBe("TradingView (KRX:KOSPI) · 참고 시세 · 마감 · 2026-10-26 거래일 기준 (TradingView · 장 밖)");
    for (const row of [sp500, kospi]) {
      expect(badge(row)).not.toContain("실시간");
      expect(badge(row)).not.toContain("지연");
      // 닫힌 장의 지연은 배지 글이 아니라 툴팁에(ADR 0017 결정 6 — /macro 장 상태 배지와 같음)
      expect(row.provenanceTitle).toBe("시세 실시간(출처 기준) — 장이 닫혀 있어 배지에는 적지 않습니다");
    }
    const closed15 = macroCardRow(macroItem({ key: "x", name: "X", delayMinutes: 15 }), evening);
    expect(closed15.provenanceTitle).toBe("시세 15분 지연(출처 기준) — 장이 닫혀 있어 배지에는 적지 않습니다");
    // 이어받은 값·지연을 모르는 카드는 툴팁도 없음
    expect(macroCardRow(macroItem({ key: "s", name: "S", isStale: true }), evening).provenanceTitle).toBeNull();
    expect(macroCardRow(macroItem({ key: "n", name: "N", delayMinutes: null }), evening).provenanceTitle).toBeNull();

    const usdkrw = macroCardRow(macroOverview().categories[0].items[0], CLOCK);
    expect(badge(usdkrw)).toBe("Yahoo Finance (KRW=X) · 개장 · 실시간 · 2026-10-26 16:51");
    // 열린 장은 지연이 배지에 있으므로 툴팁이 없음
    expect(usdkrw.provenanceTitle).toBeNull();
    const es = macroCardRow(macroOverview().categories[1].items[1], CLOCK);
    expect(badge(es)).toBe("Yahoo Finance (ES=F) · 개장 · 10분 지연 · 2026-10-26 16:41");
  });

  it("장 상태 — 주간·야간장 사이는 '휴식'(지연 없음), 시간표를 모르는 시장은 지연만, 보는 시각을 모르면(첫 렌더) 둘 다 없음", () => {
    const night = macroOverview().categories[2].items[0];
    expect(macroCardSession(night, CLOCK)).toEqual({ label: "휴식", delayMin: null });
    expect(macroCardSession({ market: "nowhere", delayMinutes: 15 }, CLOCK)).toEqual({ label: null, delayMin: 15 });
    expect(macroCardSession({ market: null, delayMinutes: 0 }, CLOCK)).toEqual({ label: null, delayMin: 0 });
    expect(macroCardSession({ market: "fx", delayMinutes: 0 }, { now: null })).toEqual({ label: null, delayMin: null });
    // 열린 장이라도 이어받은 값·수집 실패에는 지연을 적지 않습니다(장 상태는 그대로).
    expect(macroCardSession({ market: "fx", delayMinutes: 0, isStale: true }, CLOCK)).toEqual({ label: "개장", delayMin: null });
    expect(macroCardSession({ market: "fx", delayMinutes: 0, status: "fail" }, CLOCK)).toEqual({ label: "개장", delayMin: null });
    // 주말은 휴장
    const saturday: MarketClock = { now: new Date("2026-10-24T03:00:00Z"), krOfficial: null };
    expect(macroCardSession({ market: "krx", delayMinutes: 0 }, saturday)).toEqual({ label: "휴장", delayMin: null });
  });

  it("변화량 자릿수는 수집기 deltaStr을 따른다 — 금리 −0.007을 0.01로 뭉개지 않음", () => {
    const us10y = macroCardRow(macroItem({
      key: "us10y", name: "미국채 10년물", market: "ust", price: 4.992, priceStr: "4.992", delta: -0.007, pct: -0.14,
      deltaStr: "-0.007 (-0.14%)",
    }), CLOCK);
    expect(us10y).toMatchObject({ change: -0.007, changeDigits: 3 });
    expect(deltaDigits("-0.007 (-0.14%)")).toBe(3);
    expect(deltaDigits("+1,234.5 (+0.10%)")).toBe(1);
    expect(deltaDigits("−12 (−0.10%)")).toBe(0);
    expect(deltaDigits("N/A")).toBeNull();
    expect(deltaDigits(null)).toBeNull();
    // deltaStr이 "N/A"면 자릿수를 정하지 않습니다(칩도 생략됨).
    expect("changeDigits" in macroCardRow(macroItem({ key: "x", name: "X", delta: null, pct: null, deltaStr: "N/A" }), CLOCK)).toBe(false);
  });

  it("priceStr 'N/A'면 숫자가 있어도 값 없음, delta·pct가 null이면 변화도 null(칩 생략 — 0.00%를 만들지 않음)", () => {
    const row = macroCardRow(macroItem({ key: "x", name: "X", priceStr: "N/A", delta: null, pct: null, deltaStr: "N/A" }), CLOCK);
    expect(assetRowModel(row).valueText).toBeNull();
    expect(row.change).toBeNull();
    expect(row.changePct).toBeNull();
  });

  it("수집 실패 카드는 값·변화를 비우고 경고 '수집 실패'(+ 수집기 경고), 지금 시세의 지연을 붙이지 않는다", () => {
    const row = macroCardRow(macroItem({
      key: "us02y", name: "미국채 2년물", market: "fx", status: "fail", price: 4.6, priceStr: "N/A", delta: 0.1, pct: 1,
      warning: "수익률 보정 실패 — 원본(ZT=F)은 선물 가격이라 수익률로 쓰지 않습니다",
    }), CLOCK);
    expect(row).toMatchObject({ value: null, valueText: null, change: null, changePct: null, delayMin: null });
    expect(row.warning).toBe("수집 실패 · 수익률 보정 실패 — 원본(ZT=F)은 선물 가격이라 수익률로 쓰지 않습니다");
    expect(assetRowModel(row).valueText).toBeNull();
  });

  it("이어받은 값(isStale)은 이전 값 + 사유(없으면 '수집 실패'), 열린 장이어도 지연은 붙이지 않고 값은 그대로 보인다", () => {
    const stale = macroCardRow(macroItem({
      key: "wti", name: "WTI", market: "cme", isStale: true, staleReason: "Yahoo 429 — 직전 저장본 값", delayMinutes: 10,
      lastTs: "2026-10-26 16:41 KST",
    }), CLOCK);
    expect(stale).toMatchObject({ isStale: true, staleReason: "Yahoo 429 — 직전 저장본 값", delayMin: null, valueText: "7,622.99" });
    expect(badge(stale)).toBe("Yahoo Finance (^GSPC) · 개장 · 2026-10-26 16:41");
    expect(macroCardRow(macroItem({ key: "w", name: "W", isStale: true, staleReason: null }), CLOCK).staleReason).toBe("수집 실패");
  });

  it("추정(isEstimated)을 넘기고, 참고 시세는 출처 글에 '참고 시세'를 붙인다", () => {
    const row = macroCardRow(macroItem({ key: "k", name: "K", market: null, isEstimated: true, isReference: true, source: "TradingView Scanner" }), CLOCK);
    expect(row.isEstimated).toBe(true);
    expect(row.source).toBe("TradingView Scanner · 참고 시세");
  });

  it("출처가 없는 예전 저장본은 티커로 채우고, 둘 다 없으면 null(참고 시세면 '참고 시세'만)", () => {
    expect(macroItemSource({ source: null, ticker: "CL=F" })).toBe("Yahoo Finance (CL=F)");
    expect(macroItemSource({ source: null, ticker: null })).toBeNull();
    expect(macroItemSource({ source: "N/A", ticker: null, isReference: true })).toBe("참고 시세");
  });

  it("모르는 시장 id·빈 티커면 보조 글을 비운다", () => {
    expect(macroCardRow(macroItem({ key: "z", name: "Z", ticker: "", market: "nowhere" }), CLOCK).sub).toBeNull();
  });
});

describe("marketGroups", () => {
  it("범주 순서 그대로, 제목 앞 그림 문자를 떼고, 범주마다 행 — 장 상태는 보는 시각 기준", () => {
    const groups = marketGroups(macroOverview(), { now: MON_1651, krOfficial: null });
    expect(groups.map((group) => group.title)).toEqual(["통화 및 환율", "미국 주가지수 및 선물", "아시아 주요 주가지수"]);
    expect(groups[1].rows.map((row) => row.id)).toEqual(["sp500", "sp500_fut"]);
    // 야간선물 카드(20분 지연, '장 밖')는 주간·야간장 사이라 지연을 적지 않습니다.
    expect(groups[2].rows[0]).toMatchObject({ sub: "KRX 코스피200 선물", delayMin: null, source: "TradingView Scanner · 참고 시세 · 휴식" });
  });

  it("개장 중 체결이 한 시간 넘게 멈췄으면 개요의 수집 시각으로 휴장을 추정한다(지연 없음)", () => {
    const overview = macroOverview();
    // 도쿄 화요일 10:30 개장 시간 — 체결은 전날 15:30, 수집은 10:30
    overview.collectedAtKst = "2026-10-27 10:30 KST";
    overview.categories[2].items = [macroItem({
      key: "nikkei", name: "닛케이225", market: "tse", ticker: "^N225", source: "Yahoo Finance (^N225)", lastTs: "2026-10-26 15:30 KST",
      delayMinutes: 20,
    })];
    const [row] = marketGroups(overview, { now: new Date("2026-10-27T01:30:00Z"), krOfficial: null })[2].rows;
    expect(row).toMatchObject({ delayMin: null, source: "Yahoo Finance (^N225) · 휴장 추정" });
  });

  it("응답이 없으면 빈 목록", () => {
    expect(marketGroups(null, { now: MON_1651 })).toEqual([]);
    expect(marketGroups({ categories: [] }, { now: MON_1651 })).toEqual([]);
  });
});

describe("paperHomeModel — 계좌 손익 표 패널(한국, 2단계 명세 §4-16)", () => {
  it("미국 모델은 인자 없이도 같다 — 두 책 비교하지 않음 문구, 한국 사유 칸은 늘 null", () => {
    const model = paperHomeModel(paperOverview(), paperStatus(true));
    expect(model.market).toBe("US");
    expect(model.compareNote).toBe(PAPER_COMPARE_NOTE);
    expect(PAPER_COMPARE_NOTE).toBe("미국·한국 계좌는 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다");
    expect(model.dormantNote).toBeNull();
    expect(paperHomeModel(paperOverview(), paperStatus(true), { market: "US" })).toEqual(model);
  });

  it("한국: 줄은 원 정수·링크 /paper/kr·사후 체결 경고 없음, 출발 줄은 원, 출처는 한국 장부", () => {
    const overview = paperOverviewKr();
    overview.pendingBackfill = ["kr_bench_k200"];
    const model = paperHomeModel(overview, paperStatusKr(true), { market: "KR" });
    expect(model).toMatchObject({
      market: "KR", available: true, message: null, dormantNote: null, disabledNote: null, compareNote: PAPER_COMPARE_NOTE,
      startLine: "출발 2026-10-29 · 처음 현금 100,000,000원 · 변화율은 출발 대비", source: PAPER_SOURCES.krLedger,
    });
    expect(model.rows.map((row) => [row.id, row.valueText, row.unit, row.href, row.warning])).toEqual([
      ["kr_rules", "99,874,120", "원", PAPER_KR_HREF, null],
      ["kr_claude", "100,312,450", "원", PAPER_KR_HREF, null],
      ["kr_bench_k200", "100,528,900", "원", PAPER_KR_HREF, null],
      ["kr_bench_mix", "100,211,300", "원", PAPER_KR_HREF, null],
    ]);
  });

  it("쉬는 한국: 계좌가 없으면 안내 자리에 사유, 계좌가 있으면 표 아래 한 줄 — 모르는 처음 현금은 '—'(1억을 짓지 않음)", () => {
    const reason = "한국 계좌 출발일이 비어 있어 한국 초기화·출발을 하지 않습니다";
    const empty = paperHomeModel(paperOverviewKrDormant(reason), null, { market: "KR" });
    expect(empty.message).toBe(`한국 계좌가 쉬고 있습니다 — ${reason}`);
    expect(empty.dormantNote).toBeNull();
    expect(empty.startLine).toBe("출발 — · 처음 현금 — · 변화율은 출발 대비");
    const started = paperHomeModel({ ...paperOverviewKr(), dormantReason: reason }, paperStatusKr(), { market: "KR" });
    expect(started.message).toBeNull();
    expect(started.dormantNote).toBe(`한국 정기 작업이 쉬고 있습니다 — ${reason}`);
    const none = paperHomeModel({ ...paperOverviewKr(), books: [] }, null, { market: "KR" });
    expect(none.message).toBe("아직 한국 계좌가 없습니다 — 모의매매(한국) 화면에서 한국 초기화를 합니다.");
  });
});

describe("paperHomeModel — 계좌 손익 표 패널(미국)", () => {
  it("줄은 네 계좌(이름·종류·상태·순자산·출발 대비) — 계좌 손익 표의 줄(paperPnlRows) 그대로, 출발 줄", () => {
    const model = paperHomeModel(paperOverview(), paperStatus(true));
    expect(model.available).toBe(true);
    expect(model.message).toBeNull();
    expect(model.rows).toEqual(paperPnlRows(paperOverview()));
    expect(model.rows.map((row) => [row.name, row.sub, row.valueText, row.returnPct])).toEqual([
      ["규칙 계좌", "규칙 · 운용 중", "99,951.00", -0.05],
      ["Claude 계좌", "Claude · 운용 중", "99,967.28", -0.03],
      ["SPY 계좌", "벤치마크 · 운용 중", "99,950.22", -0.05],
      ["60/40 계좌", "벤치마크 · 운용 중", "99,950.39", -0.05],
    ]);
    // 일간 변화 필드는 옛 응답에 없습니다 — 변화를 만들지 않습니다(빼기로 짓지 않음).
    expect(model.rows.every((row) => !("change" in row) && row.day === null && row.unit === "달러" && row.href === PAPER_HREF)).toBe(true);
    expect(model.startLine).toBe("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비");
    expect(model.disabledNote).toBeNull();
    expect(model.source).toBe(PAPER_SOURCES.ledger);
  });

  it("Claude 계좌2(체결 시점 실험)도 한 줄 — 개요의 계좌 순서 그대로(계좌2 명세 §13-3)", () => {
    const base = paperOverview();
    const claude1 = { ...base.books![1], label: "Claude 계좌1" };
    const claude2 = { ...claude1, code: "claude2", label: "Claude 계좌2", status: "NOT_STARTED" as const, nav: 100000, returnPct: null };
    const model = paperHomeModel({ ...base, books: [base.books![0], claude2, claude1, base.books![2], base.books![3]] }, paperStatus(true));
    expect(model.rows.map((row) => row.name)).toEqual(["규칙 계좌", "Claude 계좌2", "Claude 계좌1", "SPY 계좌", "60/40 계좌"]);
    expect(model.rows[1]).toMatchObject({ valueText: "100,000.00", returnPct: null, day: null, basis: null });
  });

  // 수정 전에는 끝 줄이 개요의 출발일(startDate)만 적어, 늦게 앞으로 체결로 출발한 Claude 계좌2(행의 수익률은 서버가 계좌2 자기 출발 대비로 셈)도
  // 2026-10-23에 출발한 것처럼 읽혔다(화면 점검 — 수정 전에는 it.fails).
  it("출발일이 다른 계좌가 있으면 끝 줄에 '· Claude 계좌2는 S 출발(앞으로 체결)'을 덧붙인다 — 같은 날 출발·시작 전 계좌는 적지 않음", () => {
    const base = paperOverview();
    const claude2 = { ...base.books![1], code: "claude2", label: "Claude 계좌2", startedOn: "2026-11-02" };
    expect(paperHomeModel({ ...base, books: [...base.books!, claude2] }, paperStatus(true)).startLine)
      .toBe("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비 · Claude 계좌2는 2026-11-02 출발(앞으로 체결)");
    const waiting = { ...claude2, status: "NOT_STARTED" as const, startedOn: null };
    expect(paperHomeModel({ ...base, books: [...base.books!, waiting] }, paperStatus(true)).startLine)
      .toBe("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비");
  });

  it("사후 체결을 기다리는 벤치마크 줄에는 그 경고(모의매매 개요와 같은 bookAssetRow 규칙)", () => {
    const overview = paperOverview();
    overview.pendingBackfill = ["bench_mix"];
    const model = paperHomeModel(overview, paperStatus(true));
    expect(model.rows.find((row) => row.id === "bench_mix")?.warning).toBe(PENDING_BACKFILL_WARNING);
    expect(model.rows.find((row) => row.id === "rules")?.warning).toBeNull();
  });

  it("지금 값(current) — Claude 줄이 지금 값·단계 표기·추정 배지·최근 변화, 출처는 장중 추정이라 다시 평가했다는 말 · 옛 응답은 장부", () => {
    const overview = paperOverview();
    overview.liveSession = { phase: "REGULAR", sessionDate: "2026-10-26" };
    overview.books![1] = {
      ...overview.books![1],
      current: {
        nav: 100123.45, returnPct: 0.12, exposurePct: 97.5, dayChangePct: 0.3, previousTradingDate: "2026-10-23", previousNavFinal: false,
        basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-26", atKst: "2026-10-26 23:58 KST", isEstimated: true, livePriced: 8,
        positionCount: 9, pendingOrders: 0, neutral: false, note: "장중가 8/9종목 — 나머지는 장부 관측가",
      },
    };
    const model = paperHomeModel(overview, paperStatus(true));
    expect(model.rows.find((row) => row.id === "claude")).toMatchObject({
      valueText: "100,123.45", returnPct: 0.12, isEstimated: true, basis: "장중 추정 23:58 · 장중가 8/9종목",
      day: { pct: 0.3, label: "오늘", base: "10-23 잠정 대비" },
    });
    expect(model.source).toContain("보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정");
    // current가 없는 다른 계좌 줄은 장부 값 그대로
    expect(model.rows.find((row) => row.id === "rules")).toMatchObject({ valueText: "99,951.00", returnPct: -0.05, day: null });
    expect(paperHomeModel(paperOverview(), paperStatus(true)).source).not.toContain("장중");
  });

  it("행 링크는 셸의 모의매매 탭과 같은 곳", () => {
    expect(PAPER_HREF).toBe(TABS.find((tab) => tab.key === "paper")?.href);
  });

  it("정기 작업이 꺼졌으면 읽기 전용 사본 안내 — 상태를 모르면 꺼졌다고도 켜졌다고도 적지 않는다", () => {
    expect(paperHomeModel(paperOverview(), paperStatus(false)).disabledNote).toBe(PAPER_DISABLED_NOTE);
    expect(paperHomeModel(paperOverview(), null).disabledNote).toBeNull();
  });

  it("가격을 새로 받지 못한 보유가 있는 계좌는 이전 값 + 사유(lib/paper staleWarning)", () => {
    const overview = paperOverview();
    overview.books![1].staleCount = 2;
    const model = paperHomeModel(overview, paperStatus(true));
    expect(model.rows.find((row) => row.id === "claude")).toMatchObject({ isStale: true, staleReason: "가격 없음 2종목 — 지난 값으로 평가" });
    expect(model.rows.find((row) => row.id === "rules")?.isStale).toBe(false);
  });

  it("장부 관측치 저장본이 늦었으면(백엔드 quotes.stale) 관측이 있는 계좌가 모두 이전 값 — 시작 전 계좌(관측 없음)는 아님", () => {
    const overview = paperOverview();
    overview.quotes!.stale = true;
    const model = paperHomeModel(overview, paperStatus(true));
    // 기준 칸이 '마지막 관측 …'을 적으므로 사유에서 그 시각을 뺍니다(한 줄에 같은 시각을 두 번 적지 않음).
    expect(model.rows.every((row) => row.isStale && row.staleReason === "관측치 저장본이 늦음")).toBe(true);
    // 관측이 없는 시작 전 계좌(현금만)는 늦은 관측으로 평가한 값이 아니라 이전 값이 아닙니다(모의매매 개요와 같음).
    overview.books![0] = book({ code: "rules", kind: "RULES", label: "규칙 계좌", status: "NOT_STARTED", lastObservedAtKst: null });
    expect(paperHomeModel(overview, null).rows[0].isStale).toBe(false);
  });

  it("수익률·순자산·관측을 모르면 null — 0으로 채우지 않는다(시작 전 계좌)", () => {
    const overview = paperOverview();
    overview.books = [book({
      code: "claude", kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", nav: null, returnPct: null, lastObservedAtKst: null,
    })];
    const model = paperHomeModel(overview, null);
    expect(model.rows[0]).toMatchObject({ valueText: null, returnPct: null, day: null, basis: null });
    expect(model.rows[0].sub.startsWith("Claude · 시작 전 · 현금만")).toBe(true);
  });

  it("처음 현금 — 상태 응답이 우선, 없으면 계좌들이 모두 같을 때만, 다르면 '—'", () => {
    expect(paperHomeModel(paperOverview(), null).startLine).toContain("처음 현금 100,000 달러");
    const mixed = paperOverview();
    mixed.books![0].initialCash = 50000;
    expect(paperHomeModel(mixed, null).startLine).toBe("출발 2026-10-23 · 처음 현금 — · 변화율은 출발 대비");
  });

  it("장부를 읽을 수 없으면(테이블 없음) 서버 안내, 계좌가 없으면 초기화 안내", () => {
    const unavailable = paperHomeModel({ available: false, message: "모의 매매 테이블이 아직 없습니다" }, null);
    expect(unavailable).toMatchObject({ available: false, message: "모의 매매 테이블이 아직 없습니다", rows: [] });
    expect(paperHomeModel({ available: false }, null).message).toBe("모의매매 장부를 아직 읽을 수 없습니다.");
    const empty = paperHomeModel({ ...paperOverview(), books: [] }, null);
    expect(empty.message).toBe("아직 계좌가 없습니다 — 모의매매 화면에서 초기화합니다.");
    expect(empty.rows).toEqual([]);
  });
});

describe("알림 요약", () => {
  it("읽지 않은 수 — 'N건', 모르면 null(화면 '—' — 0으로 적지 않음)", () => {
    expect(unreadText({ unread: 3 })).toBe("3건");
    expect(unreadText({ unread: 0 })).toBe("0건");
    expect(unreadText(null)).toBeNull();
    expect(unreadText({})).toBeNull();
  });

  it("최근 알림 앞의 세 건 — 제목·발생일·읽음 글, 읽지 않은 수에 드는 것만 강조(unread)", () => {
    const response = inbox();
    response.items.push({ ...response.items[0], id: 9 });
    expect(latestAlerts(response)).toEqual([
      { id: 12, title: "[국면 전환] 후퇴 경계 → 확장", occurredOn: "2026-10-25", read: false, late: false, unread: true, readLabel: "안 읽음" },
      { id: 11, title: "Berkshire 13F 신규 편입", occurredOn: "2026-10-20", read: true, late: false, unread: false, readLabel: "읽음" },
      { id: 10, title: "외국인 5일 연속 순매수", occurredOn: "2026-10-18", read: false, late: false, unread: true, readLabel: "안 읽음" },
    ]);
    expect(latestAlerts(null)).toEqual([]);
  });

  it("알림 제목의 예전 그림 문자(기관 국기·나침반)는 뗀다 — 기호뿐인 제목은 '(제목 없음)'", () => {
    const response = inbox();
    response.items = [
      { ...response.items[0], id: 21, title: "13F 신규 편입 — 🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)" },
      { ...response.items[0], id: 22, title: "[국면 전환] 후퇴 경계 → 확장 (🧭 시장 국면)" },
      { ...response.items[0], id: 23, title: "🇺🇸" },
    ];
    expect(latestAlerts(response).map((row) => row.title)).toEqual([
      "13F 신규 편입 — 버크셔 해서웨이 (Berkshire Hathaway)",
      "[국면 전환] 후퇴 경계 → 확장 (시장 국면)",
      "(제목 없음)",
    ]);
  });

  it("지난 사건(late)은 읽지 않은 수에 들지 않으므로 '지난 사건'이고 강조하지 않는다 — 카드의 '읽지 않음 0건'과 어긋나지 않음", () => {
    const response = { unread: 0, items: [{ ...inbox().items[0], late: true, read: false }] };
    expect(unreadText(response)).toBe("0건");
    expect(latestAlerts(response)[0]).toMatchObject({ late: true, read: false, unread: false, readLabel: "지난 사건" });
    expect(latestAlerts({ unread: 0, items: [{ ...inbox().items[0], late: true, read: true }] })[0]).toMatchObject({
      unread: false, readLabel: "지난 사건",
    });
  });
});

describe("storeStatusModel — 데이터 저장소 상태 한 줄", () => {
  const texts = (model: ReturnType<typeof storeStatusModel>) => model.parts.map((part) => `${part.label} ${part.text ?? "?"}`);

  it("오류·경고·누락 데이터셋 수와 확인 시각, 오류가 있으면 danger·경고나 누락만 있으면 warn", () => {
    expect(storeStatusModel(issues(2, 1))).toEqual({
      parts: [
        { label: "수집 태스크 오류", text: "2건" },
        { label: "경고", text: "1건" },
        { label: "누락 데이터셋", text: "0개" },
      ],
      notice: null,
      tone: "danger",
      checkedAt: "2026-10-26 16:54",
    });
    expect(storeStatusModel(issues(0, 3)).tone).toBe("warn");
    expect(storeStatusModel(issues(0, 0))).toMatchObject({ notice: null, tone: "neutral" });
    const missing = issues(0, 0);
    missing.counts.missingDatasets = 3;
    expect(texts(storeStatusModel(missing))).toEqual(["수집 태스크 오류 0건", "경고 0건", "누락 데이터셋 3개"]);
    expect(storeStatusModel(missing).tone).toBe("warn");
  });

  it("수집기에 닿지 못하면 '연결 안 됨 — DB 기록만' 안내, 누락 데이터셋은 모름 — 0/0이 정상처럼 읽히지 않게(QA-102)", () => {
    const down = { ...issues(0, 0), collectorReachable: false };
    down.counts = { ...down.counts, missingDatasets: null };
    const model = storeStatusModel(down);
    expect(model.notice).toBe(COLLECTOR_UNREACHABLE_NOTE);
    // 주의는 안내 한 곳이 나릅니다 — 수 묶음의 톤은 수로만 정해, 오류·경고가 없으면 중립입니다(QA-505: 주의 아이콘이 두 번 섰음).
    expect(model.tone).toBe("neutral");
    expect(storeStatusModel({ ...issues(0, 2), collectorReachable: false }).tone).toBe("warn");
    expect(texts(model)).toEqual(["수집 태스크 오류 0건", "경고 0건", "누락 데이터셋 ?"]);
    // 예전 백엔드는 연결이 안 돼도 missingDatasets 0을 보냈습니다 — 연결 여부를 함께 봐 모름으로 둡니다.
    expect(storeStatusModel({ ...issues(0, 0), collectorReachable: false }).parts[2].text).toBeNull();
    // 오류가 있으면 danger가 이깁니다.
    expect(storeStatusModel({ ...issues(1, 0), collectorReachable: false }).tone).toBe("danger");
  });

  it("누락 데이터셋을 모르면(null) 그 칸만 모름, 수집기는 닿음", () => {
    const unknown = issues(0, 0);
    unknown.counts.missingDatasets = null;
    expect(storeStatusModel(unknown)).toMatchObject({ notice: null, tone: "neutral" });
    expect(texts(storeStatusModel(unknown))).toEqual(["수집 태스크 오류 0건", "경고 0건", "누락 데이터셋 ?"]);
  });

  it("모르면 null(화면 '—') — 0으로 적지 않는다", () => {
    expect(storeStatusModel(null)).toEqual({
      parts: [
        { label: "수집 태스크 오류", text: null },
        { label: "경고", text: null },
        { label: "누락 데이터셋", text: null },
      ],
      notice: null,
      tone: "neutral",
      checkedAt: null,
    });
  });
});

describe("pickMarketGroup — 시장 묶음 표의 탭", () => {
  it("고른 묶음이 있으면 그것, 없으면(처음·사라진 범주) 첫 묶음, 묶음이 없으면 null", () => {
    const groups = marketGroups(macroOverview(), { now: MON_1651, krOfficial: null });
    expect(pickMarketGroup(groups, null)?.id).toBe("fx");
    expect(pickMarketGroup(groups, "asia_equity")?.id).toBe("asia_equity");
    expect(pickMarketGroup(groups, "gone")?.id).toBe("fx");
    expect(pickMarketGroup([], "fx")).toBeNull();
  });
});

describe("paperPnlRows — 계좌 손익 표(운영자)", () => {
  it("옛 응답 — 이름·종류·상태·순자산(달러 둘째 자리)·출발 대비·기준(마지막 관측), 변화는 모름(null), 링크는 모의매매 화면", () => {
    const rows = paperPnlRows(paperOverview());
    expect(rows.map((row) => [row.id, row.name, row.sub, row.valueText, row.unit, row.returnPct, row.day, row.basis, row.href])).toEqual([
      ["rules", "규칙 계좌", "규칙 · 운용 중", "99,951.00", "달러", -0.05, null, "마지막 관측 2026-10-26 04:56", PAPER_HREF],
      ["claude", "Claude 계좌", "Claude · 운용 중", "99,967.28", "달러", -0.03, null, "마지막 관측 2026-10-26 04:56", PAPER_HREF],
      ["bench_spy", "SPY 계좌", "벤치마크 · 운용 중", "99,950.22", "달러", -0.05, null, "마지막 관측 2026-10-26 04:56", PAPER_HREF],
      ["bench_mix", "60/40 계좌", "벤치마크 · 운용 중", "99,950.39", "달러", -0.05, null, "마지막 관측 2026-10-26 04:56", PAPER_HREF],
    ]);
    expect(rows.every((row) => !row.isEstimated && !row.isStale && row.warning === null)).toBe(true);
  });

  it("순자산·출발 대비·추정·사후 체결 경고는 모의매매 개요의 계좌 행(bookAssetRow)과 같다 — 규칙을 두 곳에 두지 않는다", () => {
    const overview = paperOverview();
    overview.pendingBackfill = ["bench_mix"];
    const rows = paperPnlRows(overview);
    const context = { pendingBackfill: ["bench_mix"], quotes: overview.quotes };
    for (const [index, item] of overview.books!.entries()) {
      const asset = bookAssetRow(item, context);
      expect(rows[index].returnPct).toBe(asset.changePct);
      expect(rows[index].warning).toBe(asset.warning);
      expect(rows[index].valueText).toBe(assetRowModel(asset).valueText);
    }
    expect(rows.find((row) => row.id === "bench_mix")?.warning).toBe(PENDING_BACKFILL_WARNING);
  });

  it("지금 값(current) — 최근 변화는 서버 dayChangePct와 그 이름·기준, 기준 칸은 단계 표기·덧붙임, 추정 배지", () => {
    const overview = paperOverview();
    overview.liveSession = { phase: "REGULAR", sessionDate: "2026-10-26" };
    overview.books![1] = {
      ...overview.books![1],
      current: {
        nav: 100123.45, returnPct: 0.12, exposurePct: 97.5, dayChangePct: 0.3, previousTradingDate: "2026-10-23", previousNavFinal: false,
        basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-26", atKst: "2026-10-26 23:58 KST", isEstimated: true, livePriced: 8,
        positionCount: 9, pendingOrders: 0, neutral: false, note: null,
      },
    };
    const claude = paperPnlRows(overview).find((row) => row.id === "claude");
    expect(claude).toMatchObject({
      valueText: "100,123.45", returnPct: 0.12, isEstimated: true,
      day: { pct: 0.3, label: "오늘", base: "10-23 잠정 대비" },
      basis: "장중 추정 23:58 · 장중가 8/9종목",
    });
    // 변화를 모르면(dayChangePct null) 칸은 '—' — 0.00%를 짓지 않습니다.
    overview.books![1].current!.dayChangePct = null;
    expect(paperPnlRows(overview).find((row) => row.id === "claude")?.day).toBeNull();
  });

  it("이전 값 — 기준 칸이 관측 시각을 적으므로 사유에서 그 시각을 뺀다(같은 시각을 한 줄에 두 번 적지 않음)", () => {
    const overview = paperOverview();
    overview.quotes!.stale = true;
    overview.books![1].staleCount = 2;
    const rows = paperPnlRows(overview);
    expect(rows.map((row) => row.staleReason)).toEqual([
      "관측치 저장본이 늦음",
      "가격 없음 2종목 — 지난 값으로 평가 · 관측치 저장본이 늦음",
      "관측치 저장본이 늦음",
      "관측치 저장본이 늦음",
    ]);
    expect(rows.every((row) => row.isStale && row.basis === "마지막 관측 2026-10-26 04:56")).toBe(true);
  });

  it("출발 전 계좌는 순자산·수익률을 모르면 null, 변화·기준 없음 — 0으로 채우지 않는다", () => {
    const overview = paperOverview();
    overview.books![0] = book({ code: "claude2", kind: "CLAUDE", label: "Claude 계좌2", status: "NOT_STARTED", startedOn: null, nav: null,
      returnPct: null, lastObservedAtKst: null });
    const [first] = paperPnlRows(overview);
    expect(first).toMatchObject({ valueText: null, returnPct: null, day: null, basis: null, isStale: false });
    expect(first.sub).toBe("Claude · 시작 전 · 현금만");
  });

  it("한국 — 원 단위 정수, 링크 /paper/kr, 사후 체결 경고 없음 · 장부를 읽을 수 없으면 빈 목록", () => {
    const overview = paperOverviewKr();
    overview.pendingBackfill = ["kr_bench_mix"];
    const rows = paperPnlRows(overview, { market: "KR" });
    expect(rows.map((row) => [row.name, row.valueText, row.unit, row.href, row.warning])).toEqual([
      ["한국 규칙 계좌", "99,874,120", "원", PAPER_KR_HREF, null],
      ["한국 Claude 계좌", "100,312,450", "원", PAPER_KR_HREF, null],
      ["KODEX 200 계좌", "100,528,900", "원", PAPER_KR_HREF, null],
      ["한국 60/40 계좌", "100,211,300", "원", PAPER_KR_HREF, null],
    ]);
    expect(paperPnlRows({ available: false, message: "모의 매매 테이블이 아직 없습니다" })).toEqual([]);
    expect(paperPnlRows(null)).toEqual([]);
  });

  it("출처 — 장부, 장중 추정인 행이 있으면 장중 시세로 다시 평가했다는 말을 덧붙임(한국은 한국 장부)", () => {
    expect(paperHomeModel(paperOverview(), paperStatus(true)).source).toBe(PAPER_SOURCES.ledger);
    expect(paperHomeModel(paperOverviewKr(), paperStatusKr(true), { market: "KR" }).source).toBe(PAPER_SOURCES.krLedger);
    const overview = paperOverview();
    overview.books![2] = {
      ...overview.books![2],
      current: {
        nav: 100100, returnPct: 0.1, exposurePct: 99, dayChangePct: 0.2, previousTradingDate: "2026-10-23", previousNavFinal: true,
        basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-26", atKst: "2026-10-26 23:58 KST", isEstimated: true, livePriced: 1,
        positionCount: 1, pendingOrders: 0, neutral: false, note: null,
      },
    };
    expect(paperHomeModel(overview, paperStatus(true)).source).toContain("보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정");
  });
});

describe("sourceIncidentsModel — 끊긴 출처(운영자)", () => {
  it("서버 순서 그대로 이름·종류·사유·끊긴 시각(KST), 없으면 '끊긴 출처가 없습니다'", () => {
    const model = sourceIncidentsModel(infoSources([
      incident({ key: "wolf|blocked", label: "Wolf Street" }),
      incident({ key: "waedge|format", label: "waedge 시장", kind: "format", kindLabel: "형식 바뀜", reason: null, since: null }),
    ]));
    expect(model).toEqual({
      rows: [
        { key: "wolf|blocked", label: "Wolf Street", kindLabel: "차단됨 — 잠시 멈춤", reason: "HTTP 403", since: "2026-10-26 15:10" },
        { key: "waedge|format", label: "waedge 시장", kindLabel: "형식 바뀜", reason: null, since: null },
      ],
      message: null,
    });
    expect(sourceIncidentsModel(infoSources())).toEqual({ rows: [], message: NO_SOURCE_INCIDENTS });
  });

  it("판정 기록이 없거나(로컬 PC) 저장본을 읽을 수 없으면 '끊긴 출처가 없습니다'라고 적지 않는다 · 응답 전에는 줄도 글도 없음", () => {
    expect(sourceIncidentsModel({ ...infoSources(), recorded: false }).message).toBe("출처 판정 기록이 없습니다 — 판정은 운영 서버에서만 합니다");
    expect(sourceIncidentsModel({ checkedAt: "2026-10-26 16:50 KST", available: false, incidents: [] }).message)
      .toBe("출처 판정 저장본을 아직 읽을 수 없습니다");
    expect(sourceIncidentsModel(null)).toEqual({ rows: [], message: null });
  });
});

describe("homeKpiItems — 맨 위 KPI 띠", () => {
  const CLOCK_ONLY = { now: MON_1651, krOfficial: null };
  const ready = (overrides: Partial<HomeKpiInput> = {}): HomeKpiInput => ({
    regime: { data: regimeExpansion(), error: null },
    macro: { data: macroOverviewWithKpiCards(), error: null },
    unread: { data: { unread: 2 }, error: null },
    issues: { data: issues(0, 0), error: null },
    ...overrides,
  });
  /** 개요에 KPI 시장 카드 넷 가운데 셋(코스피는 빼 둠 — '저장본에 없음')을 넣습니다. */
  function macroOverviewWithKpiCards() {
    const overview = macroOverview();
    overview.categories[0].items.push(macroItem({
      key: "us10y", name: "미국채 10년물 수익률(%)", market: "ust", ticker: "^TNX", price: 4.992, priceStr: "4.992",
      delta: -0.007, pct: -0.14, deltaStr: "-0.007 (-0.14%)", lastTs: "2026-10-26 16:51 KST",
    }));
    return overview;
  }

  it("운영자 일곱 타일(국면·시장 넷·읽지 않은 알림·수집 오류), 회원은 수집 오류 없이 여섯 — 모의매매 값은 없다", () => {
    expect(homeKpiItems(ready(), { owner: true, clock: CLOCK_ONLY }).map((item) => [item.key, item.label, item.href])).toEqual([
      ["regime", "국면", "/regime"],
      ["sp500", "S&P 500", "/markets/i/sp500"],
      ["kospi", "코스피", "/markets/i/kospi"],
      ["usdkrw", "원/달러", "/markets/i/usdkrw"],
      ["us10y", "미국채 10년물", "/markets/i/us10y"],
      ["unread", "읽지 않은 알림", "/alerts"],
      ["errors", "수집 오류", "/status"],
    ]);
    expect(HOME_KPI_MARKET_KEYS).toEqual(["sp500", "kospi", "usdkrw", "us10y"]);
    const member = homeKpiItems(ready(), { owner: false, clock: CLOCK_ONLY });
    expect(member.map((item) => item.key)).toEqual(["regime", "sp500", "kospi", "usdkrw", "us10y", "unread"]);
    expect(JSON.stringify(member)).not.toMatch(/paper|모의|계좌/);
  });

  it("국면 — 백엔드 라벨(라벨 값), 기준일 줄 · 판정 불가는 중립, 기준일을 모르면 줄 없음", () => {
    const [regime] = homeKpiItems(ready(), { owner: true, clock: CLOCK_ONLY });
    expect(regime).toMatchObject({ value: "확장 (Expansion)", valueKind: "label", neutral: false, note: "기준일 2026-10-16" });
    const [unknown] = homeKpiItems(ready({ regime: { data: regimeUnknown(), error: null } }), { owner: true, clock: CLOCK_ONLY });
    expect(unknown).toMatchObject({ value: "판정 불가", neutral: true, note: null });
  });

  it("시장 — 값은 수집기 priceStr, 변화는 delta·pct 그대로(수집기 자릿수)와 캡션 '전일 대비', 단위, 출처 줄(출처·장 상태·시각) · 저장본에 없는 카드는 '—' + '저장본에 없음'", () => {
    const items = homeKpiItems(ready(), { owner: true, clock: CLOCK_ONLY });
    const byKey = new Map(items.map((item) => [item.key, item]));
    expect(byKey.get("sp500")).toMatchObject({
      value: "7,622.99", unit: null, change: { change: -40.4599609375, changePct: -0.5279601211768575, digits: 2, pctDigits: 2, caption: "전일 대비" },
      source: "Yahoo Finance (^GSPC) · 마감", asOf: "2026-10-24 04:59 KST", delayMin: null, isEstimated: false, isStale: false,
    });
    // 값의 시각은 출처 줄이 적습니다(따로 된 시각 줄 없음).
    expect(byKey.get("sp500")?.note ?? null).toBeNull();
    expect(byKey.get("usdkrw")).toMatchObject({ value: "1,322.28", unit: "원" });
    expect(byKey.get("us10y")).toMatchObject({ value: "4.992", unit: "%", change: { change: -0.007, changePct: -0.14, digits: 3, pctDigits: 2, caption: "전일 대비" } });
    expect(byKey.get("kospi")).toMatchObject({ value: null, emptyReason: KPI_NOT_IN_SNAPSHOT });
  });

  it("시장 — 비공식 참고 시세(미국채 TradingView)는 출처 줄에 '참고 시세'와 열린 장의 지연, 닫힌 장의 지연은 툴팁 — 시장 묶음 표와 같은 값", () => {
    const overview = macroOverviewWithKpiCards();
    const us10y = overview.categories[0].items.findIndex((item) => item.key === "us10y");
    overview.categories[0].items[us10y] = {
      ...overview.categories[0].items[us10y], source: "TradingView Scanner", isReference: true, delayMinutes: 15, lastTs: "2026-10-26 16:50 KST",
    };
    const OPEN = { now: new Date("2026-10-26T14:00:00Z"), krOfficial: null }; // 뉴욕 10:00 — 미국채 장 열림
    const open = homeKpiItems(ready({ macro: { data: overview, error: null } }), { owner: true, clock: OPEN }).find((item) => item.key === "us10y");
    const row = marketGroups(overview, OPEN).flatMap((group) => group.rows).find((entry) => entry.id === "us10y");
    expect(open).toMatchObject({ source: row?.source, asOf: row?.asOf, delayMin: row?.delayMin, provenanceTitle: row?.provenanceTitle ?? null });
    expect(open?.source).toMatch(/^TradingView Scanner · 참고 시세/);
    expect(open?.delayMin).toBe(15);
    const SATURDAY = { now: new Date("2026-10-31T14:00:00Z"), krOfficial: null }; // 토요일 — 장 닫힘
    const closed = homeKpiItems(ready({ macro: { data: overview, error: null } }), { owner: true, clock: SATURDAY }).find((item) => item.key === "us10y");
    expect(closed?.delayMin).toBeNull();
    expect(closed?.provenanceTitle).toMatch(/15분 지연/);
  });

  it("시장 — 이어받은 값은 이전 값 + 사유, 추정은 추정, 수집 실패는 '—' + '수집 실패'(0을 만들지 않음), 값이 있는 경고는 상태 글", () => {
    const overview = macroOverviewWithKpiCards();
    overview.categories[0].items[0] = { ...overview.categories[0].items[0], isStale: true, staleReason: "Yahoo 429 — 직전 저장본 값", isEstimated: true };
    overview.categories[1].items[0] = { ...overview.categories[1].items[0], status: "fail" };
    overview.categories[0].items[1] = { ...overview.categories[0].items[1], warning: "장 마감 뒤 값" };
    const byKey = new Map(homeKpiItems(ready({ macro: { data: overview, error: null } }), { owner: true, clock: CLOCK_ONLY })
      .map((item) => [item.key, item]));
    expect(byKey.get("usdkrw")).toMatchObject({ value: "1,322.28", isStale: true, staleReason: "Yahoo 429 — 직전 저장본 값", isEstimated: true });
    expect(byKey.get("sp500")).toMatchObject({ value: null, emptyReason: "수집 실패", change: { change: null, changePct: null } });
    expect(byKey.get("sp500")?.status).toBeUndefined();
    expect(byKey.get("us10y")).toMatchObject({ value: "4.992", status: { tone: "warn", text: "장 마감 뒤 값" } });
  });

  it("읽는 중이면 자리표시(pending), 읽지 못했으면 '—' + '읽지 못함' — 타일마다 따로(일부 실패)", () => {
    const items = homeKpiItems(
      ready({ regime: { data: null, error: null }, macro: { data: null, error: "요청 실패 (HTTP 500)" }, unread: { data: null, error: null } }),
      { owner: true, clock: CLOCK_ONLY },
    );
    expect(items.map((item) => [item.key, item.pending === true, item.value, item.emptyReason ?? null])).toEqual([
      ["regime", true, null, null],
      ["sp500", false, null, KPI_READ_FAILED],
      ["kospi", false, null, KPI_READ_FAILED],
      ["usdkrw", false, null, KPI_READ_FAILED],
      ["us10y", false, null, KPI_READ_FAILED],
      ["unread", true, null, null],
      ["errors", false, 0, null],
    ]);
  });

  // 수정 전(재현 커밋에서는 it.fails) 일곱 타일 모두 자리 줄이 0이었습니다.
  it("읽는 중이면 시장 타일 넷만 자리 줄(pendingLines 5 — 변화 1·배지 1·출처 3)을 받는다 — 값이 온 뒤의 높이에 가깝게 자리를 잡음 (QA-598)", () => {
    const pending = homeKpiItems(
      ready({ regime: { data: null, error: null }, macro: { data: null, error: null }, unread: { data: null, error: null }, issues: { data: null, error: null } }),
      { owner: true, clock: CLOCK_ONLY },
    );
    const lines = (item: HomeKpi) => item.pendingLines ?? 0;
    expect(pending.map((item) => [item.key, item.pending === true, lines(item)])).toEqual([
      ["regime", true, 0],
      ["sp500", true, 5],
      ["kospi", true, 5],
      ["usdkrw", true, 5],
      ["us10y", true, 5],
      ["unread", true, 0],
      ["errors", true, 0],
    ]);
    // 읽지 못했거나 값이 오면 자리 줄은 없습니다.
    const failed = homeKpiItems(ready({ macro: { data: null, error: "요청 실패 (HTTP 500)" } }), { owner: true, clock: CLOCK_ONLY });
    const loaded = homeKpiItems(ready(), { owner: true, clock: CLOCK_ONLY });
    expect([...failed, ...loaded].map(lines).every((count) => count === 0)).toBe(true);
  });

  // QA-598(마지막 타일): 수집 오류 타일은 일곱 타일의 마지막이라 두 칸(390)·세 칸(sm)에서 마지막 줄에 혼자 남아 그 줄 높이를 정하는데, 읽는 중 64px에서
  // 읽은 뒤 92px(값 + 상태 글 한 줄)로 자랐습니다(루프백 빌드 390 — 같은 줄에 더 높은 시장 타일이 없음).
  // 수정 전(재현 커밋에서는 it.fails) 수집 오류 타일의 자리 줄은 0이었습니다.
  it.fails("읽는 중 수집 오류 타일은 자리 줄 1(상태 글 한 줄 자리) — 국면·알림 타일은 0 그대로 (QA-598)", () => {
    const pending = homeKpiItems(
      ready({ regime: { data: null, error: null }, macro: { data: null, error: null }, unread: { data: null, error: null }, issues: { data: null, error: null } }),
      { owner: true, clock: CLOCK_ONLY },
    );
    const lines = (key: string) => pending.find((item) => item.key === key)?.pendingLines ?? 0;
    expect([lines("errors"), lines("regime"), lines("unread")]).toEqual([1, 0, 0]);
  });

  it("읽지 않은 알림 — 'N건', 모르면 '—'(0으로 적지 않음)", () => {
    const unread = (data: { unread?: number | null } | null) =>
      homeKpiItems(ready({ unread: { data, error: null } }), { owner: false, clock: CLOCK_ONLY }).find((item) => item.key === "unread");
    expect(unread({ unread: 2 })).toMatchObject({ value: 2, unit: "건" });
    expect(unread({ unread: 2 })?.format?.(1234)).toBe("1,234");
    expect(unread({ unread: null })?.value).toBeNull();
    expect(unread({})?.value).toBeNull();
  });

  it("수집 오류 — 오류 수(건)는 타일 값, 경고나 누락이 있으면 주의 상태 글(경고·누락 수 — 글과 톤이 같은 것을 말함), 그 밖이면 상태 글 없음", () => {
    const errors = (response: ReturnType<typeof issues> | null) =>
      homeKpiItems(ready({ issues: { data: response, error: null } }), { owner: true, clock: CLOCK_ONLY }).find((item) => item.key === "errors");
    expect(errors(issues(3, 19))).toMatchObject({ value: 3, unit: "건", status: { tone: "warn", text: "경고 19건 · 누락 0개" } });
    expect(errors(issues(0, 19))).toMatchObject({ value: 0, status: { tone: "warn", text: "경고 19건 · 누락 0개" } });
    // 오류만 있으면 상태 글 없음 — '경고 0건 · 누락 0개'에 위험 톤을 붙이지 않습니다(오류 수는 값이 나름).
    expect(errors(issues(1, 0))).toMatchObject({ value: 1 });
    expect(errors(issues(1, 0))?.status).toBeUndefined();
    expect(errors(issues(0, 0))?.status).toBeUndefined();
    expect(errors(issues(0, 0))?.value).toBe(0);
    const missing = issues(0, 0);
    missing.counts.missingDatasets = 2;
    expect(errors(missing)?.status).toEqual({ tone: "warn", text: "경고 0건 · 누락 2개" });
    // 수를 모르면 '—'(0으로 적지 않음), 상태 글도 없음 — counts가 빠진 응답(옛 백엔드)
    const uncounted = { ...issues(), counts: undefined } as unknown as ReturnType<typeof issues>;
    expect(errors(uncounted)).toMatchObject({ value: null });
    expect(errors(uncounted)?.status).toBeUndefined();
  });

  it("수집 오류 — 수집기에 닿지 못하면 주의 상태 글 '수집기 연결 안 됨'(누락은 모름 — 0으로 적지 않음), 경고가 있으면 그 수 뒤에 덧붙임", () => {
    const down = (errors: number, warnings = 0) => {
      const response = { ...issues(errors, warnings), collectorReachable: false };
      response.counts = { ...response.counts, missingDatasets: null };
      return homeKpiItems(ready({ issues: { data: response, error: null } }), { owner: true, clock: CLOCK_ONLY }).find((item) => item.key === "errors");
    };
    expect(down(0)?.status).toEqual({ tone: "warn", text: "수집기 연결 안 됨" });
    expect(down(2)).toMatchObject({ value: 2, status: { tone: "warn", text: "수집기 연결 안 됨" } });
    expect(down(2, 4)?.status).toEqual({ tone: "warn", text: "경고 4건 · 누락 — · 수집기 연결 안 됨" });
  });
});

it("자동 갱신 간격 — 매크로는 live 없이 5분(Yahoo 429), 모의매매·상태 1분, 국면·알림·끊긴 출처 5분", () => {
  expect(HOME_REFRESH_MS).toEqual({ regime: 300_000, macro: 300_000, paper: 60_000, alerts: 300_000, storeStatus: 60_000, sources: 300_000 });
});
