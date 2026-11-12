/**
 * 백엔드 응답 계약 — ISA 계좌: 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매'(ADR 0029·0034).
 *
 * 모의 장부·실제 계좌 조회(brokerage)·실제 매매(realtrade)와 별개 기능이라 배럴(lib/types.ts)로 내보내지 않습니다 — 가져오는 곳은
 * `@/lib/types/isa`를 직접 적고, 경계 시험(components/screens/isa/__tests__/isaBoundary.test.ts)이 모의·홈 모듈과 배럴이 이 파일을 가져오지 않는지 봅니다.
 *
 * 금액·수량·가격·비율(decimal)은 숫자 또는 숫자 글자(`IsaDecimal`)로 받고, 화면은 lib/isa의 `toNumber`로 읽습니다(읽지 못하면 null → "—", 0으로 채우지 않음).
 */

/** 숫자 또는 숫자 글자(BigDecimal) — 모르면 null. */
export type IsaDecimal = number | string | null;

/** 매매 방향. */
export type IsaSide = "BUY" | "SELL";

/** 계좌(하나, `code = "isa"`, 시장 KR, 따라 하는 책 `kr_rules`). 시작 전에는 `startedAt`이 null일 수 있습니다. */
export interface IsaAccount {
  code: string;
  label: string | null;
  market: string | null;
  sourceBook: string | null;
  sourceLabel: string | null;
  /** ACTIVE·PAUSED. */
  state: string | null;
  startedAt: string | null;
}

/** 가격을 몰라 평가에서 뺀 종목 — 코드 글자 또는 {symbol, name}. */
export type IsaUnpriced = string | { symbol?: string | null; name?: string | null };

/** 요약 — 현금·평가액·총 잔고(평가액 + 현금)·매입 금액 합·평가손익(가격 모르는 보유가 있으면 null)·누적 수수료·세금·수수료율(%). */
export interface IsaSummary {
  cash: IsaDecimal;
  marketValue: IsaDecimal;
  totalAsset: IsaDecimal;
  purchaseTotal: IsaDecimal;
  profitLoss: IsaDecimal;
  profitLossPct: IsaDecimal;
  feesPaid: IsaDecimal;
  taxesPaid: IsaDecimal;
  commissionPct: IsaDecimal;
  unpriced: IsaUnpriced[] | null;
}

/** 잔고 한 줄 — 직전 종가 평가(모르면 lastPrice·marketValue·손익·비중이 null). */
export interface IsaPosition {
  symbol: string;
  name: string | null;
  quantity: IsaDecimal;
  avgPrice: IsaDecimal;
  purchaseAmount: IsaDecimal;
  lastPrice: IsaDecimal;
  marketValue: IsaDecimal;
  profitLoss: IsaDecimal;
  profitLossPct: IsaDecimal;
  weightPct: IsaDecimal;
  feesPaid: IsaDecimal;
  taxesPaid: IsaDecimal;
}

/** 지시 한 줄 — 다음에 무엇을 몇 주. 알림 시각은 보낸 시각(없으면 null). */
export interface IsaInstructionItem {
  id: number;
  /** 최근 지시(recentInstructions)에서만 — 그 지시의 세션. */
  session?: string | null;
  symbol: string;
  name: string | null;
  side: string;
  quantity: IsaDecimal;
  refPrice: IsaDecimal;
  weightPct: IsaDecimal;
  status: string;
  /** 개장 10분 뒤 시각 맞추기 지시면 그 시각(ISO — '그 시각 이후 시장가', ADR 0033), 시가 지시면 null. */
  targetAt?: string | null;
  notifiedNightAt?: string | null;
  notifiedMorningAt: string | null;
  notifiedMiddayAt?: string | null;
  notifiedPrecloseAt?: string | null;
  /** 닫힌 까닭(expired·no-holding·restart·not-trading 등). */
  autoNote?: string | null;
  /** 사용자가 '확인'한 지시인가. */
  recordedByUser?: boolean;
}

/** 장중 스탑 매도 지시 한 줄(ADR 0033 — 규칙 계좌의 STOP 주문 하나에 하나). 감지 즉시 텔레그램으로 종목 코드·이름·수량만 알립니다. 금액은 싣지 않습니다. */
export interface IsaStopInstruction {
  id: number;
  session: string | null;
  symbol: string;
  name: string | null;
  side: string;
  quantity: IsaDecimal;
  /** MARKET·AT_MINUTE(장중 시장가)·NEXT_CLOSE(종가 단일가 시장가). */
  timing: string | null;
  /** 그 모의 STOP 주문의 기준 시각(ISO). */
  targetAt: string | null;
  status: string;
  /** 즉시 알림을 보낸 시각(보내기 전 null). */
  notifiedAt: string | null;
  notifiedMiddayAt?: string | null;
  notifiedPrecloseAt?: string | null;
  /** 닫힌 까닭(not-notified·expired·no-holding 등). */
  autoNote?: string | null;
  recordedByUser?: boolean;
}

/** 다음 세션의 지시 묶음 — 세션(YYYY-MM-DD)·세션 상태(NONE '지시 없음'·PLANNED·UNAVAILABLE '못 만듦')·지시 목록. */
export interface IsaInstructions {
  session: string | null;
  status: string | null;
  items: IsaInstructionItem[] | null;
  /** 그 세션 개장 시각(ISO) — 장전 동시호가 안내. 모르면 null(화면은 08:30~09:00). */
  open?: string | null;
  /**
   * 그 세션 행의 사유 코드(못 만듦이면 timed-orders 등). 없으면 null. status가 PLANNED인데 cash-negative이면 손절 매도 지시만 만든 세션입니다(현금이 음수라 나머지
   * 매매 지시는 만들지 않음 — QA-381 후속. 개장 전에 잔고를 고쳐 나머지를 채우면 null).
   */
  reason?: string | null;
  /** 지시를 만든 뒤 잔고가 바뀌었는데 다시 계산하지 않음(그 세션 08:00 뒤의 쓰기) — 화면은 수량을 다시 확인하라고 경고합니다. */
  ledgerChanged?: boolean | null;
  /** 개장 10분 뒤 시각 맞추기 지시면 그 시각(ISO — 보통 09:10, ADR 0033), 시가 지시면 null. */
  targetAt?: string | null;
}

/** 매매 내역 한 줄('확인'으로 잔고에 반영한 것). 금액은 수량 × 가격, 수수료·세금·실현 손익은 원 단위. */
export interface IsaTrade {
  id: number;
  at: string | null;
  side: string;
  symbol: string;
  name: string | null;
  quantity: IsaDecimal;
  price: IsaDecimal;
  amount: IsaDecimal;
  fee: IsaDecimal;
  tax: IsaDecimal;
  /** 매도의 실현 손익 — 매수는 null. */
  realizedPnl: IsaDecimal;
  realizedPct: IsaDecimal;
  /** live(실시간 가격)·close(서버 직전 종가)·user(사용자가 적은 체결 금액). */
  priceSource: string | null;
  /** 시장 구분을 몰라 코스피 세율로 어림한 매도인가. */
  taxAssumed: boolean | null;
  instructionId?: number | null;
  stopInstructionId?: number | null;
}

/** 다음 세션 지시를 아직 만들지 않은 사유(정기 작업이 기다리는 중) — 세션(YYYY-MM-DD)과 사유 코드(cash-negative·decision-pending·price-missing 등). */
export interface IsaWaiting {
  session: string | null;
  reason: string | null;
}

/** GET /api/manual/isa — 표가 없으면 `available:false`(그때 `message`와 `notes`에 안내). */
export interface IsaResponse {
  available: boolean;
  message?: string | null;
  started?: boolean;
  account?: IsaAccount | null;
  summary?: IsaSummary | null;
  positions?: IsaPosition[] | null;
  instructions?: IsaInstructions | null;
  /** 최근 지시(최근 30). */
  recentInstructions?: IsaInstructionItem[] | null;
  /** 장중 스탑 매도 지시(최근 30 — ADR 0033). */
  stopInstructions?: IsaStopInstruction[] | null;
  /** 매매 내역(최근 200). */
  trades?: IsaTrade[] | null;
  /** 다음 세션 지시를 아직 만들지 않은 사유 — 기다리는 것이 없으면 null. 화면은 cash-negative(현금이 음수라 만들지 않음 — QA-381)만 지시 카드에 띄웁니다. 손절 매도 지시만 만든 세션은 여기가 아니라 instructions.reason으로 옵니다. */
  waiting?: IsaWaiting | null;
  notes?: string[] | null;
}

/** 시작 보유 한 줄. */
export interface IsaStartPosition {
  /** 종목 이름 또는 여섯 자리 코드. */
  symbol: string;
  quantity: number;
  purchaseAmount: number;
}

/** POST /api/manual/isa/start — 한 번만(이미 시작했으면 409 `already-started`). `prices`는 화면이 받은 실시간 가격(코드 → 가격). */
export interface IsaStartRequest {
  totalAsset: number;
  positions: IsaStartPosition[];
  prices?: Record<string, number>;
}

/** POST /api/manual/isa/balance/total — 총 잔고를 다시 넣어 현금을 다시 셉니다. */
export interface IsaTotalRequest {
  totalAsset: number;
  prices?: Record<string, number>;
}

/** POST /api/manual/isa/balance/commission — 수수료율(%, 0~1). */
export interface IsaCommissionRequest {
  commissionPct: number;
}

/** POST /api/manual/isa/positions — `originalSymbol`이 있으면 그 행을 고침(코드가 바뀌면 옮김). `price`는 평균 매입가. */
export interface IsaPositionRequest {
  originalSymbol?: string;
  symbol: string;
  name?: string;
  quantity: number;
  price: number;
}

/** POST /api/manual/isa/instructions/apply 한 줄 — 지시나 장중 스탑 지시 하나에 묶입니다(번호는 둘 중 하나만). `price`가 없으면 서버 직전 종가. */
export interface IsaApplyItem {
  instructionId?: number;
  stopInstructionId?: number;
  price?: number;
  /** live(실시간 가격 그대로)·close(직전 종가 그대로)·user(사용자가 적음). */
  priceSource?: "live" | "close" | "user";
  /** 실제 체결 수량(정수 주). */
  quantity?: number;
  /** 체결 금액(총액, 원) — 평균 단가는 서버가 금액 ÷ 수량으로 셉니다. */
  amount?: number;
  /** 매매 비용(수수료, 원). */
  fee?: number;
}

/** POST /api/manual/isa/trades/{id} 본문 — 확인한 매매의 실제 수량·체결 금액·수수료. */
export interface IsaEditTradeRequest {
  quantity: number;
  amount: number;
  fee: number;
}

/** POST /api/manual/isa/instructions/apply 본문 — 한 트랜잭션으로 잔고에 반영합니다. */
export interface IsaApplyRequest {
  items: IsaApplyItem[];
}

/** 쓰기 응답 — `{ok}`, 시작·총 잔고는 `notes`(어림한 가격 등), 확인은 `count`(반영)·`skipped`(보유가 없어 닫음). 오류는 `{ok:false, error, message}`. */
export interface IsaOkResponse {
  ok: boolean;
  symbol?: string;
  count?: number;
  skipped?: number;
  notes?: string[];
}
