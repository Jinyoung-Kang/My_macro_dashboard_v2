/**
 * 모의매매 화면의 시장별 표기 — 통화·돈 자릿수·주당 가격 자릿수·거래일 이름·현금성 종목. React를 모르는 순수 함수(ADR 0004).
 *
 * 미국 책과 한국 책(2단계 명세 §4-16)은 같은 화면 패턴을 쓰고 "통화 ₩·정수 주·거래일 달력만 다릅니다". 그 다른 점을 이 표 하나에 모아,
 * 화면 함수들(lib/paper·lib/paperOverview)은 기본값이 미국(`"US"`)인 시장 인자만 받습니다 — 미국 호출부는 인자를 넘기지 않아 글자가
 * 예전 그대로입니다.
 *
 * - 미국: 달러, 총액 소수 2자리(" 달러"), 주당 가격 4자리(5bp 슬리피지가 싼 종목에서도 보이게 — 백엔드가 4자리로 보냄), 현금성 SHY.
 * - 한국: 원, 원 단위 정수("100,000,000원" — 백엔드가 정수로 보냄, 0으로 채우거나 조·억으로 줄이지 않음), 주당 가격 0자리(호가가 원
 *   단위), 현금성 153130(KODEX 단기채권).
 *
 * 이 파일은 lib/format만 가져옵니다(lib/paper가 이 파일을 가져오므로 반대 방향 import를 두지 않음 — 순환 방지).
 */
import { formatNumber, formatWithUnit } from "./format";
import type { PaperMarketCode } from "./types";

/** 모의매매 책의 시장 — 화면 주소(/paper/us·/paper/kr)와 API 시장 값(`?market=`)이 같은 글자를 씁니다(타입은 응답 계약 lib/types). */
export type { PaperMarketCode };

/** 시장 하나의 표기 규칙. */
export interface PaperMarketMeta {
  code: PaperMarketCode;
  /** 화면 이름("미국"·"한국"). */
  label: string;
  /** 장부 통화(API `currency`). */
  currency: "USD" | "KRW";
  /** 총액(현금·순자산·평가액·체결 금액)의 소수 자릿수. */
  moneyDigits: number;
  /** 총액 뒤에 붙는 단위(숫자 바로 뒤 — 미국은 띄어 씀). */
  moneyUnit: string;
  /** 표 머리·자산 행 단위 칸에 적는 단위 이름("달러"·"원"). */
  unitLabel: string;
  /** 주당 가격(평단·현재가·최고가·스탑가·체결가)의 소수 자릿수. */
  sharePriceDigits: number;
  /** 거래일을 셀 때의 이름 — 두 시장 달력이 달라 "거래일"만 적으면 어느 시장의 날인지 모릅니다. */
  tradingDayLabel: string;
  /** 남는 현금을 두는 현금성 종목(설정 기본값 — 지금 값은 설정 탭). */
  cashLike: string;
}

export const MARKET_META: Readonly<Record<PaperMarketCode, PaperMarketMeta>> = {
  US: {
    code: "US",
    label: "미국",
    currency: "USD",
    moneyDigits: 2,
    moneyUnit: " 달러",
    unitLabel: "달러",
    sharePriceDigits: 4,
    tradingDayLabel: "미국 거래일",
    cashLike: "SHY",
  },
  KR: {
    code: "KR",
    label: "한국",
    currency: "KRW",
    moneyDigits: 0,
    moneyUnit: "원",
    unitLabel: "원",
    sharePriceDigits: 0,
    tradingDayLabel: "KR 거래일",
    cashLike: "153130",
  },
};

/** 시장 표기 — 모르는 값(옛 응답·오타)은 미국으로 읽지 않고 호출한 쪽이 고른 시장을 그대로 씁니다(인자는 타입으로 막힘). */
export function marketMeta(market: PaperMarketCode = "US"): PaperMarketMeta {
  return MARKET_META[market];
}

/**
 * 총액 — 미국 "1,234.56 달러"(lib/paper formatDollars와 같은 글자), 한국 "100,000,000원"(원 단위 정수). 모르면 "—".
 *
 * @param digits 미국 자릿수(기본 2 — 처음 현금처럼 정수로 적을 곳은 0). 한국은 늘 0자리입니다(원 미만이 없는 장부).
 */
export function formatMoney(value: number | null | undefined, market: PaperMarketCode = "US", digits?: number): string {
  const meta = marketMeta(market);
  const places = market === "KR" ? 0 : (digits ?? meta.moneyDigits);
  return formatWithUnit(value, places, meta.moneyUnit);
}

/** 주당 가격 — 미국 소수 4자리, 한국 0자리("71,300"). 모르면 "—". */
export function formatSharePriceFor(value: number | null | undefined, market: PaperMarketCode = "US"): string {
  return formatNumber(value, marketMeta(market).sharePriceDigits);
}

/**
 * 계좌 코드의 시장 — 한국 계좌는 `kr_` 접두어(kr_rules·kr_claude·kr_bench_k200·kr_bench_mix, 백엔드 PaperBooks.KR), 그 밖은 미국.
 * 계좌 코드 경로(/books/{code}/…)는 코드가 시장을 정하므로(docs/API.md) 화면도 같은 규칙으로 표기를 고릅니다.
 */
export function marketOfBook(code: string | null | undefined): PaperMarketCode {
  return typeof code === "string" && code.startsWith("kr_") ? "KR" : "US";
}
