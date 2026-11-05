/**
 * 데이터 출처 표기 — 화면 전체의 단일 출처.
 *
 * 규칙
 *   - 기관 이름 + 성격(공식·비공식·추정·자체 계산)을 함께 적습니다. "어디서 왔나"와 "얼마나
 *     믿을 수 있나"는 같이 읽혀야 합니다.
 *   - 실제 수집 경로(collector/app/services/*, docs/DATA_SOURCES.md)와 같아야 합니다. 출처를
 *     바꾸면 여기와 DATA_SOURCES.md를 함께 고치세요.
 *   - 백엔드가 출처를 내려주는 곳(레이더 순위·재무·금융위·토스 등)은 그 값을 우선 씁니다.
 */
export const SOURCES = {
  yahoo: "Yahoo Finance (yfinance, 15분 지연·일별 종가)",
  yahooEtf: "Yahoo Finance (yfinance) — ETF 일별 종가(수정주가)",
  tradingView: "TradingView Scanner (비공식 참고 시세)",
  fred: "FRED — 세인트루이스 연준 (공식)",
  fredLiquidity: "FRED (공식) — WALCL 연준 총자산 · WTREGEN 재무부 일반계정(TGA) · RRPONTSYD 역레포",
  sec13f: "SEC EDGAR 13F-HR 공시 (공식, 분기 종료 후 45일 이내 제출)",
  sec13fWithPrices: "SEC EDGAR 13F-HR (보유 비중) + Yahoo Finance 일별 종가 (가격·변동성)",
  cftc: "CFTC Commitments of Traders (공식, 주 1회 — 화요일 기준·금요일 발표)",
  cftcBacktest: "CFTC COT (포지션) + Yahoo Finance ETF 종가 (가격 대용)",
  krxFutures: "KRX Open API (공식) — 수집 실패 시 KODEX 200 기반 추정치(표시됨)",
  krxDerived: "KRX 미결제약정으로 대시보드가 계산",
  equityPrices: "Yahoo Finance (yfinance) — 일별 종가",
  regime: "FRED (공식) — 10Y−3M 금리차 · NFCI · 하이일드 스프레드 · 연준 순유동성(WALCL−TGA−RRP)",
  regimeLog: "대시보드 판정 기록 (PostgreSQL regime_log) — 그날 화면에 보인 판정, 입력은 FRED(공식)",
  regimeTrackRecord: "FRED (공식, 누적 이력·발표 지연 반영) 판정 재현 + Yahoo Finance ETF 수정 종가 — 대시보드 계산",
  radarHistory: "수집기가 쌓아 온 누적 이력 (PostgreSQL) — 각 날짜의 원래 출처는 순위 수집 당시 소스",
  internalRules: "대시보드 해석 기준표 (역사적 분포 참고치 — 공식 기준 아님)",
  collectorRuns: "수집기 실행 기록 (PostgreSQL collector_task_runs)",
  collectorKeys: "수집기 환경변수(.env) — 설정 여부만, 값은 표시하지 않음",
  snapshots: "PostgreSQL 저장본 (snapshots)",
  aiInput: "대시보드 저장본 전체 — 각 섹션에 원래 출처·데이터 성격을 함께 적음",
  aiEngines: "각 AI 제공사 API (백엔드가 호출, 키는 .env)",
  toss: "토스증권 Open API (공식)",
  tossAccount: "토스증권 Open API (공식) — 실제 계좌 조회(읽기 전용, 모의 장부와 별개)",
} as const;

/** "Yahoo Finance (^GSPC)" → "Yahoo Finance". 카드 전체 출처를 모을 때 씁니다. */
export function sourceName(source: string | null | undefined): string | null {
  if (!source) return null;
  return source.split(" (")[0].trim() || null;
}

/** 여러 지표의 출처를 겹치지 않게 모읍니다 (나온 순서 유지). */
export function uniqueSources(sources: (string | null | undefined)[]): string {
  return [...new Set(sources.map(sourceName).filter((value): value is string => Boolean(value)))].join(" · ");
}
