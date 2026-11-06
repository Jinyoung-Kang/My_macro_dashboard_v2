/**
 * 백엔드 응답 계약 — 토스증권 실제 계좌 읽기 전용 조회(`GET /api/brokerage/account?market=KR|US`, ADR 0025,
 * docs/specs/2026-11-05-toss-account-readonly.md §4).
 *
 * 모의 장부와 별개 기능이라 배럴(lib/types.ts)로 내보내지 않습니다 — 가져오는 곳은 `@/lib/types/brokerage`를 직접 적고, 경계 시험
 * (components/screens/brokerage/__tests__/brokerageBoundary.test.ts)이 모의·홈 모듈이 이 파일을 가져오지 않는지 봅니다.
 * 숫자는 number | null입니다(백엔드가 토스의 문자열 decimal을 바꿔 보냄 — 바꾸지 못하면 null). 화면은 null을 "—"로 그리고 0으로 채우지 않습니다.
 * 계좌번호·계좌 식별 키·주문 번호는 응답에 없습니다.
 */

/** 이 화면의 시장 — 한국은 원화 쪽, 미국은 달러 쪽입니다(모의매매 화면 주소의 시장과 같은 글자). */
export type BrokerageMarket = "KR" | "US";

/**
 * 조회 상태 — 백엔드가 수집기 응답을 이 열 가지로 바꿉니다(명세 §4 대응 표). OK만 숫자가 있고, 이전 값을 보일 때도 OK(`isStale` 참)입니다.
 * 모르는 값이 와도 화면은 실패로 다룹니다(lib/brokerage `brokerageView`).
 */
export type BrokerageState =
  | "OK"
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "COLLECTOR_UNREACHABLE"
  | "IP_NOT_ALLOWED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NO_ACCOUNT"
  | "REFRESHING"
  | "UPSTREAM_ERROR";

/**
 * 그 통화의 보유 요약(토스 HoldingsOverview의 `.krw` 또는 `.usd`). 토스 요약의 비율(원화 환산 합산)은 싣지 않고, 두 Pct는
 * 백엔드가 같은 통화끼리 계산한 값입니다(손익 × 100 ÷ 매입금액, 매입금액이 null·0이면 null) — 화면은 "대시보드 계산"이라고 적습니다.
 * 일간 수익률은 없습니다(일간 손익은 금액만).
 */
export interface BrokerageSummary {
  purchaseAmount: number | null;
  marketValue: number | null;
  marketValueAfterCost: number | null;
  profitLoss: number | null;
  profitLossAfterCost: number | null;
  dailyProfitLoss: number | null;
  profitLossPct: number | null;
  profitLossPctAfterCost: number | null;
}

/** 보유 종목 한 줄 — 토스 HoldingsItem에서 옮긴 칸. 비율은 퍼센트 값(×100)이고, 종목 하나는 한 통화라 섞이지 않습니다. */
export interface BrokerageHoldingRow {
  symbol: string;
  name: string | null;
  marketCountry: string | null;
  currency: string | null;
  /** 미국 소수점 주식은 소수 6자리까지 옵니다(lib/brokerage `formatQuantity`). */
  quantity: number | null;
  lastPrice: number | null;
  averagePurchasePrice: number | null;
  purchaseAmount: number | null;
  marketValue: number | null;
  marketValueAfterCost: number | null;
  profitLoss: number | null;
  profitLossAfterCost: number | null;
  profitLossPct: number | null;
  profitLossPctAfterCost: number | null;
  dailyProfitLoss: number | null;
  dailyProfitLossPct: number | null;
}

/**
 * 주문 한 줄(진행 중·최근 끝남) — 토스 Order와 execution.*에서 옮긴 칸. 방향·호가 유형·유효 조건·상태는 토스 원문(모르는 값도 그대로),
 * 시각은 `yyyy-MM-dd HH:mm`(KST, 바꾸지 못하면 null). 종목 이름은 같은 종목의 보유 이름표에서만 채웁니다(없으면 null).
 */
export interface BrokerageOrderRow {
  symbol: string | null;
  name: string | null;
  side: string | null;
  orderType: string | null;
  timeInForce: string | null;
  status: string | null;
  currency: string | null;
  price: number | null;
  quantity: number | null;
  /** 금액 기반 미국 시장가 매수에만(달러). 그 밖은 null. */
  orderAmount: number | null;
  orderedAtKst: string | null;
  canceledAtKst: string | null;
  filledQuantity: number | null;
  averageFilledPrice: number | null;
  filledAmount: number | null;
  commission: number | null;
  tax: number | null;
  filledAtKst: string | null;
  /** 결제 예정일 원문(YYYY-MM-DD). */
  settlementDate: string | null;
}

/** `GET /api/brokerage/account?market=KR|US` — 늘 200(market이 틀리면 400). `available`은 `state == "OK"`. */
export interface BrokerageAccountResponse {
  available: boolean;
  state: BrokerageState;
  /** state별 고정 문구(수집기·토스 문구를 옮기지 않음). OK이고 새 값이면 null. */
  message: string | null;
  market: BrokerageMarket;
  currency: "KRW" | "USD";
  accountLabel: string | null;
  accountCount: number | null;
  /**
   * 보이는 데이터를 수집기가 토스에서 받은 시각(KST) — 화면의 '기준 시각'(명세 2026-11-06-us-costs-backfill §6). 초까지(`yyyy-MM-dd HH:mm:ss`)를
   * 기대하고, 예전 응답처럼 분까지(`yyyy-MM-dd HH:mm`)면 화면은 받은 그대로 적습니다(초를 지어내지 않음).
   */
  fetchedAtKst: string | null;
  /** 이전 값을 보일 때 첫 실패 시각. */
  staleSinceKst: string | null;
  ageSeconds: number | null;
  isStale: boolean;
  /** 이전 값을 보일 때 그 실패의 state. */
  staleReason: BrokerageState | null;
  /** 토스 오류 코드(소문자·숫자·하이픈 40자 이내일 때만). */
  upstreamCode: string | null;
  buyingPower: number | null;
  summary: BrokerageSummary | null;
  holdings: BrokerageHoldingRow[];
  openOrders: BrokerageOrderRow[];
  /** 최근 30일 끝난 주문(최신순). */
  closedOrders: BrokerageOrderRow[];
  closedFromDate: string | null;
  /** 끝난 주문을 세 쪽에서 끊었으면 참(토스에 더 남음). */
  closedTruncated: boolean;
  /** 이 화면의 통화와 맞지 않아 뺀 보유·주문 수. */
  unclassifiedCount: number;
}
