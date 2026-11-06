/**
 * 백엔드 응답 계약 — ISA 계좌: 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매'
 * (ADR 0029, docs/specs/2026-11-06-isa-manual-account.md §5).
 *
 * 모의 장부·실제 계좌 조회(brokerage)·실제 매매(realtrade)와 별개 기능이라 배럴(lib/types.ts)로 내보내지 않습니다 — 가져오는 곳은
 * `@/lib/types/isa`를 직접 적고, 경계 시험(components/screens/isa/__tests__/isaBoundary.test.ts)이 모의·홈 모듈과 배럴이 이 파일을 가져오지 않는지 봅니다.
 *
 * 금액·수량·가격·비율(decimal)은 백엔드가 숫자로 보낼지 문자열로 보낼지 명세에 정하지 않아 `IsaDecimal`(숫자 또는 숫자 글자)로 받고,
 * 화면은 lib/isa의 `toNumber`로 읽습니다(읽지 못하면 null → "—", 0으로 채우지 않음).
 */

/** 숫자 또는 숫자 글자(BigDecimal) — 모르면 null. */
export type IsaDecimal = number | string | null;

/** 장부 행 종류(명세 §1) — 입금(시작 현금 포함)·출금·매수·매도·조정(수량만 바꿈 — 분할 등). */
export type IsaLedgerKind = "DEPOSIT" | "WITHDRAW" | "BUY" | "SELL" | "ADJUST";

/** 장부 행을 쓴 쪽 — 지시대로 자동 기록(AUTO)·사용자 입력(USER). */
export type IsaLedgerSource = "AUTO" | "USER";

/** 지시 한 줄의 상태(명세 §6 `manual_instructions.status`). 모르는 값이 와도 화면은 글자 그대로 보입니다. */
export type IsaInstructionStatus = "PLANNED" | "RECORDED" | "SKIPPED" | "SUPERSEDED";

/** 매매 방향. */
export type IsaSide = "BUY" | "SELL";

/** 계좌(명세 §1 — 하나, `code = "isa"`, 시장 KR, 따라 하는 책 `kr_rules`). 시작 전에는 `startedAt`·`startCash`가 null일 수 있습니다. */
export interface IsaAccount {
  code: string;
  label: string | null;
  market: string | null;
  sourceBook: string | null;
  sourceLabel: string | null;
  /** ACTIVE·PAUSED. */
  state: string | null;
  startedAt: string | null;
  startCash: IsaDecimal;
}

/** 가격을 몰라 평가에서 뺀 종목 — 명세가 원소 모양을 정하지 않아 코드 글자 또는 {symbol, name}을 받습니다. */
export type IsaUnpriced = string | { symbol?: string | null; name?: string | null };

/** 요약(명세 §1) — 현금·보유 평가·평가액·순입금(Σ입금 − Σ출금)·손익(평가액 − 순입금)·손익률. */
export interface IsaSummary {
  cash: IsaDecimal;
  marketValue: IsaDecimal;
  equity: IsaDecimal;
  netDeposit: IsaDecimal;
  profitLoss: IsaDecimal;
  profitLossPct: IsaDecimal;
  unpriced: IsaUnpriced[] | null;
}

/** 보유 한 줄 — 마지막 가격 평가(모르면 lastPrice·marketValue·weightPct가 null). */
export interface IsaHolding {
  symbol: string;
  name: string | null;
  quantity: IsaDecimal;
  avgPrice: IsaDecimal;
  lastPrice: IsaDecimal;
  marketValue: IsaDecimal;
  weightPct: IsaDecimal;
}

/** 지시 한 줄(명세 §2) — 다음 시가에 무엇을 몇 주. 알림 시각은 밤·아침 한 번씩 보낸 시각(없으면 null). */
export interface IsaInstructionItem {
  id: number;
  /** 최근 지시(recentInstructions)·처리 안 된 지난 지시(pendingInstructions)에서만 — 그 지시의 세션. */
  session?: string | null;
  symbol: string;
  name: string | null;
  side: string;
  quantity: IsaDecimal;
  refPrice: IsaDecimal;
  weightPct: IsaDecimal;
  status: string;
  notifiedNightAt: string | null;
  notifiedMorningAt: string | null;
}

/** 다음 세션의 지시 묶음 — 세션(YYYY-MM-DD)·세션 상태(NONE '지시 없음'·PLANNED·UNAVAILABLE '못 만듦')·지시 목록. */
export interface IsaInstructions {
  session: string | null;
  status: string | null;
  items: IsaInstructionItem[] | null;
  /** 그 세션 개장 시각(ISO) — 장전 동시호가 안내와 체결 고치기 기본 시각. 모르면 null(화면은 08:30~09:00·09:00). */
  open?: string | null;
  /** 그 세션 행의 사유 코드(못 만듦이면 record-pending·timed-orders 등). 없으면 null. */
  reason?: string | null;
  /** 지시를 만든 뒤 장부가 바뀌었는데 다시 계산하지 않음(그 세션 08:00 뒤의 장부 쓰기) — 화면은 수량을 다시 확인하라고 경고합니다. */
  ledgerChanged?: boolean | null;
}

/** 장부 한 줄(명세 §1·§6) — 금액(amount)은 입출금이면 입출금액, 매수·매도면 수량×체결가. 수량·가격은 매수·매도·조정. */
export interface IsaLedgerRow {
  id: number;
  at: string | null;
  kind: string;
  symbol: string | null;
  name: string | null;
  quantity: IsaDecimal;
  price: IsaDecimal;
  amount: IsaDecimal;
  fee: IsaDecimal;
  tax: IsaDecimal;
  source: string | null;
  instructionId: number | null;
  note: string | null;
}

/** GET /api/manual/isa — 표가 없으면 `available:false`(그때 `message`와 `notes`에 안내). */
export interface IsaResponse {
  available: boolean;
  message?: string | null;
  started?: boolean;
  account?: IsaAccount | null;
  summary?: IsaSummary | null;
  holdings?: IsaHolding[] | null;
  instructions?: IsaInstructions | null;
  /** 최신 세션보다 앞 세션의 PLANNED 지시(각 줄에 session) — 처리해야 다음 지시를 만듭니다(체결 고치기·건너뜀). */
  pendingInstructions?: IsaInstructionItem[] | null;
  /** 최근 지시(최근 30). */
  recentInstructions?: IsaInstructionItem[] | null;
  /** 장부(최근 200). */
  ledger?: IsaLedgerRow[] | null;
  notes?: string[] | null;
}

/** 시작 매수 한 줄(BUY 행, `source = USER`). */
export interface IsaStartBuy {
  symbol: string;
  quantity: number;
  price: number;
}

/** POST /api/manual/isa/start — 한 번만(이미 시작했으면 409 `already-started`). `startedAt`이 없으면 서버가 지금으로. */
export interface IsaStartRequest {
  cash: number;
  startedAt?: string;
  buys: IsaStartBuy[];
}

/** POST /api/manual/isa/ledger — `id`가 있으면 수정, 없으면 추가. */
export interface IsaLedgerRequest {
  id?: number;
  kind: IsaLedgerKind;
  symbol?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  fee?: number;
  tax?: number;
  at?: string;
  note?: string;
  instructionId?: number;
}

/**
 * 쓰기 응답 — `{ok}`(행 추가·수정은 `id`도). 오류는 `{ok:false, error, message}`(lib/api의 ApiError가 code·message로 나름).
 * 지시 번호만 있고 id가 없는 새 행은 그 지시에 자동(AUTO) 행만 있으면 그 행을 대신하고, 직접(USER) 행이 이미 있으면 409 `already-recorded`.
 */
export interface IsaOkResponse {
  ok: boolean;
  id?: number;
}
