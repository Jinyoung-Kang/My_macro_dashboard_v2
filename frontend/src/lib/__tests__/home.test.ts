/**
 * 홈(/) 표시 규칙(lib/home.ts).
 *  - 국면: 백엔드 라벨·문장 그대로, 신호 네 자리 고정(빠진 신호는 "—"+사유), 판정 불가면 받지 못한 입력 목록, 응답이 없어도 네 타일
 *  - 시장: 카드 → 자산 행(priceStr·delta/pct 그대로, "N/A"·null은 값 없음/칩 생략, 수집 실패는 값·변화를 비우고 "수집 실패"),
 *    추정·이전 값·참고 시세·경고는 넘기고, 장 상태는 보는 시각 기준 — 지연은 열린 장에만("개장 · 실시간"), 닫힌 장은 "마감"만,
 *    이어받은 값·실패에는 지연을 붙이지 않음, 변화량 자릿수는 deltaStr을 따름
 *  - 모의매매: Claude 계좌 순자산 히어로·마지막 관측, 네 계좌 행(모의매매 개요와 같은 bookAssetRow — 출발 대비 수익률, 오래됨·사후 체결 대기),
 *    정기 작업 꺼짐 안내, 처음 현금
 *  - 알림: 모르는 수는 null(화면 "—"), 지난 사건은 강조하지 않음 / 저장소 상태: 모르는 수는 null, 수집기 연결 안 됨·누락 데이터셋
 */
import { describe, expect, it } from "vitest";

import {
  COLLECTOR_UNREACHABLE_NOTE,
  deltaDigits,
  HOME_REFRESH_MS,
  latestAlerts,
  macroCardRow,
  macroCardSession,
  macroItemSource,
  type MarketClock,
  MARKET_HREF,
  marketGroups,
  PAPER_COMPARE_NOTE,
  PAPER_DISABLED_NOTE,
  PAPER_HREF,
  PAPER_KR_HREF,
  paperHomeModel,
  regimeHeroModel,
  storeStatusModel,
  unreadText,
} from "../home";
import { TABS } from "../nav";
import { bookAssetRow, PENDING_BACKFILL_WARNING } from "../paperOverview";
import { assetRowModel } from "../patternRows";
import { provenanceText } from "../patterns";
import {
  book,
  inbox,
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
    expect(nfci).toMatchObject({ valueText: "-0.496", unit: null });
    expect(hyOas).toMatchObject({ valueText: "3.40", unit: "%p" });
    // 0.031조 달러를 0.03으로 뭉개지 않습니다.
    expect(liquidity).toMatchObject({ valueText: "+0.031", unit: "조 달러", note: "확대 · 최근 4주 동안 시장으로 유동성이 들어왔습니다." });
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
    });
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

describe("paperHomeModel — 모의매매(한국 탭, 2단계 명세 §4-16)", () => {
  it("미국 모델은 인자 없이 예전 그대로 — 두 책 비교하지 않음 문구만 더함, 한국 사유 칸은 늘 null", () => {
    const model = paperHomeModel(paperOverview(), paperStatus(true));
    expect(model.market).toBe("US");
    expect(model.compareNote).toBe(PAPER_COMPARE_NOTE);
    expect(PAPER_COMPARE_NOTE).toBe("미국·한국 책은 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다");
    expect(model.dormantNote).toBeNull();
    expect(paperHomeModel(paperOverview(), paperStatus(true), { market: "US" })).toEqual(model);
  });

  it("한국: 히어로는 한국 Claude 계좌 순자산(원 정수), 행은 원·링크 /paper/kr·사후 체결 경고 없음, 출발 줄은 원", () => {
    const overview = paperOverviewKr();
    overview.pendingBackfill = ["kr_bench_k200"];
    const model = paperHomeModel(overview, paperStatusKr(true), { market: "KR" });
    expect(model).toMatchObject({
      market: "KR", available: true, message: null, heroCaption: "한국 Claude 계좌 순자산", heroValueText: "100,312,450", heroUnit: "원",
      heroReturnPct: 0.31, heroAsOf: "2026-11-03 21:57", dormantNote: null, disabledNote: null, compareNote: PAPER_COMPARE_NOTE,
      startLine: "출발 2026-10-29 · 처음 현금 100,000,000원 · 변화율은 출발 대비",
    });
    expect(model.rows.map((row) => [row.id, row.valueText, row.unit, row.href, row.warning])).toEqual([
      ["kr_rules", "99,874,120", "원", PAPER_KR_HREF, null],
      ["kr_claude", "100,312,450", "원", PAPER_KR_HREF, null],
      ["kr_bench_k200", "100,528,900", "원", PAPER_KR_HREF, null],
      ["kr_bench_mix", "100,211,300", "원", PAPER_KR_HREF, null],
    ]);
  });

  it("쉬는 한국: 계좌가 없으면 안내 자리에 사유, 계좌가 있으면 행 아래 한 줄 — 모르는 처음 현금은 '—'(1억을 짓지 않음)", () => {
    const reason = "한국 책 출발일이 비어 있어 한국 초기화·출발을 하지 않습니다";
    const empty = paperHomeModel(paperOverviewKrDormant(reason), null, { market: "KR" });
    expect(empty.message).toBe(`한국 책이 쉬고 있습니다 — ${reason}`);
    expect(empty.dormantNote).toBeNull();
    expect(empty.startLine).toBe("출발 — · 처음 현금 — · 변화율은 출발 대비");
    const started = paperHomeModel({ ...paperOverviewKr(), dormantReason: reason }, paperStatusKr(), { market: "KR" });
    expect(started.message).toBeNull();
    expect(started.dormantNote).toBe(`한국 정기 작업이 쉬고 있습니다 — ${reason}`);
    const none = paperHomeModel({ ...paperOverviewKr(), books: [] }, null, { market: "KR" });
    expect(none.message).toBe("아직 한국 계좌가 없습니다 — 모의매매(한국) 화면에서 한국 초기화를 합니다.");
  });
});

describe("paperHomeModel — 모의매매(미국)", () => {
  it("히어로는 Claude 계좌 순자산·출발 대비 수익률·마지막 관측, 행은 네 계좌(이름·종류·상태·순자산·출발 대비)", () => {
    const model = paperHomeModel(paperOverview(), paperStatus(true));
    expect(model.available).toBe(true);
    expect(model.message).toBeNull();
    expect(model.heroCaption).toBe("Claude 계좌 순자산");
    expect(model.heroValueText).toBe("99,967.28");
    expect(model.heroUnit).toBe("달러");
    expect(model.heroReturnPct).toBe(-0.03);
    // 정기 작업이 켜져 있어도 평가 시각을 늘 적습니다.
    expect(model.heroAsOf).toBe("2026-10-26 04:56");
    expect(model.heroStale).toBe(false);
    expect(model.rows.map((row) => [row.name, row.sub.split(" · ").slice(0, 2).join(" · "), row.value, row.changePct])).toEqual([
      ["규칙 계좌", "규칙 · 운용 중", 99951, -0.05],
      ["Claude 계좌", "Claude · 운용 중", 99967.28, -0.03],
      ["SPY 계좌", "벤치마크 · 운용 중", 99950.22, -0.05],
      ["60/40 계좌", "벤치마크 · 운용 중", 99950.39, -0.05],
    ]);
    // 일간 변화 필드는 응답에 없습니다 — 변화량을 만들지 않습니다.
    expect(model.rows.every((row) => !("change" in row) && row.unit === "달러" && row.href === PAPER_HREF)).toBe(true);
    expect(model.startLine).toBe("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비");
    expect(model.disabledNote).toBeNull();
  });

  it("🧪 Claude 계좌2(체결 시점 실험)가 앞에 와도 히어로는 계좌1 — 계좌2는 행으로만(계좌2 명세 §13-3)", () => {
    const base = paperOverview();
    const claude1 = { ...base.books![1], label: "Claude 계좌1" };
    const claude2 = { ...claude1, code: "claude2", label: "Claude 계좌2", status: "NOT_STARTED" as const, nav: 100000, returnPct: null };
    const model = paperHomeModel({ ...base, books: [base.books![0], claude2, claude1, base.books![2], base.books![3]] }, paperStatus(true));
    expect(model.heroCaption).toBe("Claude 계좌1 순자산");
    expect(model.heroValueText).toBe("99,967.28");
    expect(model.rows.map((row) => row.name)).toEqual(["규칙 계좌", "Claude 계좌2", "Claude 계좌1", "SPY 계좌", "60/40 계좌"]);
  });

  it("계좌 행은 모의매매 개요와 같은 규칙(bookAssetRow) + 링크 — 규칙을 두 곳에 두지 않는다", () => {
    const overview = paperOverview();
    overview.pendingBackfill = ["bench_mix"];
    overview.quotes!.stale = true;
    const model = paperHomeModel(overview, paperStatus(true));
    expect(model.rows).toEqual(
      overview.books!.map((book) => ({ ...bookAssetRow(book, { pendingBackfill: ["bench_mix"], quotes: overview.quotes }), href: PAPER_HREF })),
    );
    // 사후 체결을 기다리는 벤치마크에는 그 경고가 붙습니다.
    expect(model.rows.find((row) => row.id === "bench_mix")?.warning).toBe(PENDING_BACKFILL_WARNING);
    expect(model.rows.find((row) => row.id === "rules")?.warning).toBeNull();
  });

  it("행 링크는 셸의 모의매매 탭과 같은 곳", () => {
    expect(PAPER_HREF).toBe(TABS.find((tab) => tab.key === "paper")?.href);
  });

  it("정기 작업이 꺼졌으면 읽기 전용 사본 안내, 마지막 관측은 켜짐·꺼짐과 상관없이 히어로(Claude 계좌)의 것", () => {
    const overview = paperOverview();
    overview.books![3].lastObservedAtKst = "2026-10-26 05:10 KST";
    const model = paperHomeModel(overview, paperStatus(false));
    expect(model.disabledNote).toBe(PAPER_DISABLED_NOTE);
    expect(model.heroAsOf).toBe("2026-10-26 04:56");
    // 상태를 모르면(응답 없음) 꺼졌다고도 켜졌다고도 적지 않습니다.
    expect(paperHomeModel(overview, null).disabledNote).toBeNull();
    expect(paperHomeModel(overview, null).heroAsOf).toBe("2026-10-26 04:56");
  });

  it("가격을 새로 받지 못한 보유가 있는 계좌는 이전 값 + 사유(lib/paper staleWarning)", () => {
    const overview = paperOverview();
    overview.books![1].staleCount = 2;
    const model = paperHomeModel(overview, paperStatus(true));
    const claude = model.rows.find((row) => row.id === "claude");
    expect(claude).toMatchObject({ isStale: true, staleReason: "가격 없음 2종목 — 지난 값으로 평가" });
    expect(model.heroStale).toBe(true);
    expect(model.heroStaleReason).toBe("가격 없음 2종목 — 지난 값으로 평가");
    expect(model.rows.find((row) => row.id === "rules")?.isStale).toBe(false);
  });

  it("장부 관측치 저장본이 늦었으면(백엔드 quotes.stale) 관측이 있는 계좌가 모두 이전 값(+ 마지막 관측), 히어로도", () => {
    const overview = paperOverview();
    overview.quotes!.stale = true;
    const model = paperHomeModel(overview, paperStatus(true));
    expect(model.rows.every((row) => row.isStale && row.staleReason === "관측치 저장본이 늦음 · 마지막 관측 2026-10-26 04:56")).toBe(true);
    expect(model.heroStale).toBe(true);
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
    expect(model.heroValueText).toBeNull();
    expect(model.heroReturnPct).toBeNull();
    expect(model.heroAsOf).toBeNull();
    expect(model.rows[0]).toMatchObject({ value: null, changePct: null });
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
    expect(unavailable).toMatchObject({ available: false, message: "모의 매매 테이블이 아직 없습니다", rows: [], heroValueText: null });
    expect(paperHomeModel({ available: false }, null).message).toBe("모의매매 장부를 아직 읽을 수 없습니다.");
    const empty = paperHomeModel({ ...paperOverview(), books: [] }, null);
    expect(empty.message).toBe("아직 계좌가 없습니다 — 모의매매 화면에서 초기화합니다.");
    expect(empty.heroCaption).toBe("Claude 계좌 순자산");
    expect(empty.heroAsOf).toBeNull();
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

  it("수집기에 닿지 못하면 '연결 안 됨 — DB 기록만'(warn), 누락 데이터셋은 모름 — 0/0이 정상처럼 읽히지 않게(QA-102)", () => {
    const down = { ...issues(0, 0), collectorReachable: false };
    down.counts = { ...down.counts, missingDatasets: null };
    const model = storeStatusModel(down);
    expect(model.notice).toBe(COLLECTOR_UNREACHABLE_NOTE);
    expect(model.tone).toBe("warn");
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

it("자동 갱신 간격 — 매크로는 live 없이 5분(Yahoo 429), 모의매매·상태 1분, 국면·알림 5분", () => {
  expect(HOME_REFRESH_MS).toEqual({ regime: 300_000, macro: 300_000, paper: 60_000, alerts: 300_000, storeStatus: 60_000 });
});
