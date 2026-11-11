/**
 * 백엔드 응답 계약 — 토스증권 실제 계좌가 모의 한국 책을 따라 하는 실제 매매(ADR 0028, docs/specs/2026-11-06-real-trade-mirror.md §7.2).
 *
 * 모의 장부·실제 계좌 조회(brokerage)와 별개 기능이라 배럴(lib/types.ts)로 내보내지 않습니다 — 가져오는 곳은 `@/lib/types/realtrade`를 직접 적고,
 * 경계 시험(components/screens/realtrade/__tests__/realtradeBoundary.test.ts)이 모의·홈 모듈과 배럴이 이 파일을 가져오지 않는지 봅니다.
 *
 * 금액·수량·비율(decimal)은 백엔드가 숫자로 보낼지 문자열로 보낼지 명세에 정하지 않아 `RealTradeDecimal`(숫자 또는 숫자 글자)로 받고,
 * 화면은 lib/realtrade의 `toNumber`로 읽습니다(읽지 못하면 null → "—", 0으로 채우지 않음). 토스 주문 번호·clientOrderId·계좌번호는 응답에 없습니다.
 */

/** 시장 — 한국(원화)만 지원하고, 미국은 자리만 있습니다(`supported` 거짓, 켜기류는 400 `not-supported`). */
export type RealTradeMarket = "KR" | "US";

/** 상태 기계(명세 §1) — 꺼짐·켜짐·이상 멈춤·끄는 중. 모르는 값이 와도 화면은 글자 그대로 보이고 끄기 단추를 둡니다. */
export type RealTradeState = "OFF" | "LIVE" | "HALTED" | "STOPPING";

/** 따라 할 수 있는 모의 한국 책(명세 §0 `source_book`). */
export type RealTradeSourceBook = "kr_rules" | "kr_claude" | "kr_claude2";

/** 숫자 또는 숫자 글자(BigDecimal) — 모르면 null. */
export type RealTradeDecimal = number | string | null;

/**
 * 서버 두 스위치(명세 §1의 1·2) — 수집기 `TOSS_TRADING_ENABLED`·백엔드 `REAL_TRADE_ENABLED`. 사유는 수집기 코드(`disabled`·`limits-invalid` …).
 * 백엔드가 수집기 상태를 읽지 못하면 `collector`는 null(모름), 사유는 `status-unreadable`입니다 — 화면은 꺼짐이 아니라 '서버 상태를 읽지 못함 — 다시 읽는 중'으로
 * 그립니다(RT3-UI-1, lib/realtrade `serverSwitchState`).
 */
export interface RealTradeServerEnabled {
  collector: boolean | null;
  backend: boolean | null;
  reason: string | null;
}

/** 수집기 한도 네 값(명세 §1) — 서버 `.env`가 정하고 화면은 보이기만 합니다. */
export interface RealTradeLimits {
  maxOrderKrw: RealTradeDecimal;
  maxOrdersPerDay: RealTradeDecimal;
  maxBuyKrwPerDay: RealTradeDecimal;
  maxEquityKrw: RealTradeDecimal;
}

/**
 * 오늘 창 하나 — 명세가 원소 모양을 정하지 않아 화면이 가정한 모양입니다(종류 + 시작·끝 시각). 종류는 `kind`(없으면 `purpose`·`label`)로 읽고,
 * 시각은 ISO 또는 `HH:mm[:ss]`(KST) 글자를 받습니다. 글자 하나로 오면 그대로 적습니다.
 */
export interface RealTradeWindow {
  kind?: string | null;
  purpose?: string | null;
  label?: string | null;
  start?: string | null;
  end?: string | null;
}

/** 오늘(KST) — 쉬는 날이면 사유 코드(휴장·장 시간 다름·시계 어긋남·장부 밀림 — 명세 §3). */
export interface RealTradeToday {
  date: string | null;
  skipReason: string | null;
  windows: (RealTradeWindow | string)[] | null;
}

/** 마지막 preflight의 국내 보유 한 줄(명세 §5.2 preflight `holdings`). */
export interface RealTradePreflightHolding {
  symbol: string;
  name: string | null;
  quantity: RealTradeDecimal;
  lastPrice: RealTradeDecimal;
}

/** 마지막으로 토스에서 새로 읽은 값(운용 평가액 E·원화 매수 가능 금액·국내 보유) — 아직 없으면 null. */
export interface RealTradePreflight {
  fetchedAt: string | null;
  /**
   * 그 값을 그날(KST) 정규장 마감 뒤에 읽었는가(모의 한국 달력 — 그날이 휴장이면 true, 달력이 모르면 null). 2026-11-08 백엔드가 더하는 칸이라 없을 수
   * 있습니다. 백엔드는 마지막 값을 저장해 다시 띄워도·휴장일·토스 점검 중에도 보이고, 마지막 거래일 마감 뒤 값이 없으면 창 밖에서 한 번 읽습니다.
   */
  afterClose?: boolean | null;
  equity: RealTradeDecimal;
  /**
   * 상한 없는 총액(원화 매수 가능 금액 + 국내 보유 평가액 — 안전 상한 `maxEquityKrw`를 적용하기 전) — 손실 한도 판정의 '지금 값'.
   * 백엔드가 더하는 새 칸이라 없을 수 있습니다(그러면 기준 대비 손익은 `baselineTotal`이 있을 때 "—").
   */
  total?: RealTradeDecimal;
  cashBuyingPower: RealTradeDecimal;
  holdings: RealTradePreflightHolding[] | null;
}

/**
 * 최근 실제 주문 한 줄(최근 50, 명세 §7.2) — DB `real_trade_orders`의 칸 이름을 camelCase로 옮긴 것으로 가정합니다.
 * 상태는 토스 상태(`brokerStatus` — PENDING·FILLED …)가 있으면 그것, 없으면 보낸 결과(`sendOutcome` — SENDING·ACCEPTED·REJECTED·UNKNOWN·NOT_SENT).
 * 토스 주문 번호·clientOrderId는 싣지 않습니다.
 */
export interface RealTradeOrderRow {
  session?: string | null;
  /** SYNC(시가 맞추기)·SYNC_FOLLOWUP(시가 뒤 마무리·개장 10분 뒤 맞추기의 시장가 주문)·MIRROR(장중 따라 하기·장중 스탑 매도). */
  purpose: string | null;
  symbol: string | null;
  name?: string | null;
  side: string | null;
  quantity: RealTradeDecimal;
  timeInForce: string | null;
  sendOutcome?: string | null;
  brokerStatus?: string | null;
  /** 결과 사유 코드(거절·안 보냄 코드 — 소문자·숫자·하이픈). */
  outcomeCode?: string | null;
  filledQuantity: RealTradeDecimal;
  averageFilledPrice: RealTradeDecimal;
  filledAmount: RealTradeDecimal;
  firstSentAt?: string | null;
  createdAt?: string | null;
  filledAt?: string | null;
}

/** 이벤트 한 줄(최근 30) — 종류(ENABLE·DISABLE·HALT·WINDOW_SUMMARY …)와 사유 코드·건수가 든 detail. */
export interface RealTradeEvent {
  at: string | null;
  kind: string | null;
  detail: Record<string, unknown> | null;
}

/** 고를 수 있는 책과 그 모의 상태(NOT_STARTED·ACTIVE·PAUSED). */
export interface RealTradeBook {
  code: string;
  label: string | null;
  status: string | null;
}

/** `GET /api/realtrade/status?market=KR|US` — 운영자 전용. */
export interface RealTradeStatusResponse {
  available: boolean;
  /** 읽을 수 없을 때(테이블 준비 전 등)의 서버 문구 — 명세에 없는 선택 칸. */
  message?: string | null;
  market: RealTradeMarket;
  /** 한국만 참. */
  supported: boolean;
  serverEnabled: RealTradeServerEnabled | null;
  state: RealTradeState | string | null;
  sourceBook: string | null;
  sourceLabel: string | null;
  lossLimitPct: RealTradeDecimal;
  /** 켤 때(또는 기준 다시 잡기 때) 안전 상한을 적용한 운용 평가액 E0 — 손실 한도 금액(E0 × 한도%)의 분모. */
  baselineEquity: RealTradeDecimal;
  /**
   * 켤 때(또는 기준 다시 잡기 때) 상한 없는 총액 U0 — 백엔드가 더하는 새 칸. 있으면 기준 대비 손익은 '지금 상한 없는 총액(lastPreflight.total) − U0'이고
   * 매수 멈춤선은 'U0 − E0 × 한도%'입니다(총액이 상한보다 커도 손실을 잡게). 없거나 null이면 예전처럼 운용 평가액 − E0.
   */
  baselineTotal?: RealTradeDecimal;
  buysPaused: boolean | null;
  haltReason: string | null;
  /** 이 기능의 아직 끝나지 않은 토스 주문 수(건수만) — 백엔드가 더하는 새 칸. 없으면 화면은 상태(끄는 중·멈춤)만 봅니다. */
  unfinishedOrders?: number | null;
  /**
   * 실제 매매 정기 작업이 마지막으로 주기를 끝낸 시각(ISO, 시간대 포함 — 없으면 KST로 읽음) — 백엔드가 더하는 새 칸. 켜짐·멈춤·끄는 중인데 3분 넘게
   * 지났으면 화면이 '정기 작업이 멈춘 것 같습니다'를 띄웁니다. null(기동 뒤 아직 주기를 끝내지 못함)이면 `jobStartedAt`으로 판단합니다.
   */
  jobLastCycleAt?: string | null;
  /**
   * 정기 작업이 시작된 시각(ISO) — 백엔드 스위치나 스케줄러가 꺼져 있으면 null(RT2-FE-2). 기동 뒤 한 주기도 끝내지 못한 채 3분이 지나도 멈춤을 잡으려고
   * `jobLastCycleAt ?? jobStartedAt`으로 견줍니다. 둘 다 null이면 판단하지 않습니다.
   */
  jobStartedAt?: string | null;
  /**
   * 이 응답을 만든 서버 시각(Instant ISO, Z) — 정기 작업 멈춤을 브라우저 시계가 아니라 같은 응답의 서버 시각과 견줍니다(RT2-FE-2). 없거나 못 읽으면
   * 화면이 응답을 받은 시각으로 대신합니다.
   */
  serverTime?: string | null;
  /**
   * 미종료 주문 중 취소를 정해진 횟수(5번) 보내고도 포기한 행 수(`cancel_gave_up_at`이 있는 행 — 건수만, RT2-FE-3). 1건 이상이면 화면이 '토스증권 앱에서
   * 직접 취소하세요' 위험 배너를 띄웁니다. 표 준비 전이면 null.
   */
  cancelGaveUpOrders?: number | null;
  /**
   * 미종료이고 보낸 결과를 모르며(send_outcome = UNKNOWN) 토스 주문 번호도 없는 행 수(건수만, RT2-FE-3). 꺼짐인데 1건 이상이면 화면이 '정리 끝' 대신
   * '토스증권 앱에서 확인하세요' 경고를 띄웁니다. 표 준비 전이면 null.
   */
  unresolvedOrders?: number | null;
  /** 켜기류 요청에 그대로 돌려보내는 설정 버전(다르면 409 `version-conflict`). */
  version: number | null;
  limits: RealTradeLimits | null;
  today: RealTradeToday | null;
  lastPreflight: RealTradePreflight | null;
  orders: RealTradeOrderRow[] | null;
  events: RealTradeEvent[] | null;
  books: RealTradeBook[] | null;
}

/** 켜기 창 예상 목록의 주문 한 줄 — 지금 값으로 계산한 예상(실제 주문은 다음 맞추기에서 그때 값으로 다시 계산). */
export interface RealTradePreviewOrder {
  symbol: string;
  name: string | null;
  side: string;
  quantity: RealTradeDecimal;
  estAmount: RealTradeDecimal;
}

/** 예상 목록에서 건너뛴 종목 — 명세가 원소 모양을 정하지 않아 가정한 모양(종목 + 사유 코드). 글자 하나로 오면 그대로 적습니다. */
export interface RealTradePreviewSkipped {
  symbol?: string | null;
  name?: string | null;
  reason?: string | null;
}

/**
 * `GET /api/realtrade/preview?market=KR&sourceBook=…` — 지금 preflight + 그 책의 다음 맞추기 목표로 계산한 예상 목록(명세 §2·§3.1). 다음 맞추기가
 * 개장 10분 뒤 시각 맞추기면 `syncAt`(ISO)이 그 시각이고 목표는 그 시각까지의 모의 주문을 반영합니다(ADR 0033), 시가 맞추기면 null.
 */
export interface RealTradePreviewResponse {
  ok: boolean;
  /** ok가 거짓일 때의 사유 코드 — 명세에 없는 선택 칸. */
  reason?: string | null;
  /** 예상의 세션(YYYY-MM-DD) — 정기 작업이 다음에 묶음을 만드는 날(맞추기 창이 열려 있고 오늘 묶음이 없으면 오늘, QA-344). */
  session?: string | null;
  /** 그 세션의 맞추기 창이 지금 열려 있는가 — 참이면 켜기·바꾸기·해제 직후 정기 작업이 이 목록(그때 값으로 다시 계산)을 바로 주문합니다. */
  immediate?: boolean | null;
  /** 다음 맞추기 시각(ISO) — 개장 10분 뒤 시각 맞추기면 그 시각, 시가 맞추기면 null. */
  syncAt?: string | null;
  equity: RealTradeDecimal;
  orders: RealTradePreviewOrder[] | null;
  skipped: (RealTradePreviewSkipped | string)[] | null;
  turnoverPct: RealTradeDecimal;
  warnings: string[] | null;
}

/** 켜기 — confirm은 운영자가 친 글자 그대로(정확히 `실제 매매 켜기`), password는 운영자 비밀번호. */
export interface RealTradeEnableRequest {
  market: RealTradeMarket;
  sourceBook: string;
  lossLimitPct: number;
  confirm: string;
  password: string;
  version: number;
}

/** 끄기 — 비밀번호·확인 글자 없음, 늘 받음. */
export interface RealTradeDisableRequest {
  market: RealTradeMarket;
}

/** 설정 바꾸기 — 바꾸는 칸만 보냅니다(방식·손실 한도·기준 다시 잡기). confirm은 정확히 `설정 바꾸기`. */
export interface RealTradeUpdateRequest {
  market: RealTradeMarket;
  sourceBook?: string;
  lossLimitPct?: number;
  rebaseline?: boolean;
  confirm: string;
  password: string;
  version: number;
}

/** 멈춤 해제(HALTED → LIVE, 매수 멈춤 해제도) — confirm은 정확히 `멈춤 해제`. */
export interface RealTradeResumeRequest {
  market: RealTradeMarket;
  confirm: string;
  password: string;
  version: number;
}

/** 켜기류·끄기의 응답 — 명세가 모양을 정하지 않아 화면은 성공 여부만 보고 상태를 다시 읽습니다. */
export interface RealTradeActionResponse {
  ok?: boolean;
  state?: string | null;
  version?: number | null;
  message?: string | null;
}
