/**
 * ISA 계좌(연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매' — ADR 0029·0034)의 표기·입력 검사 — React를 모르는 순수 함수(ADR 0004).
 *
 * 이 파일은 lib/format과 응답 계약 lib/types/isa만 가져옵니다. 모의·홈·실제 계좌 조회(brokerage)·실제 매매(realtrade) 모듈과 서로 가져오지 않습니다
 * (components/screens/isa/__tests__/isaBoundary.test.ts). 잔고 숫자(현금·평가액·손익·비중)는 백엔드가 계산한 값을 그대로 찍고, 화면이 계산하는 것은
 * 입력 창의 어림과, 보유 종목의 실시간 가격(표시 전용 — ADR 0024)을 받았을 때 그 가격으로 다시 센 평가액·손익·비중(`isaValuation` — 받은 가격이 없으면 서버 값 그대로)뿐입니다.
 * 모르는 값은 "—"이고 0으로 채우지 않습니다.
 */
import { EMPTY, formatKst, formatKstSeconds, formatNumber, formatSigned } from "./format";
import type {
  IsaApplyItem,
  IsaApplyRequest,
  IsaCommissionRequest,
  IsaDecimal,
  IsaEditTradeRequest,
  IsaInstructionItem,
  IsaPosition,
  IsaPositionRequest,
  IsaStartPosition,
  IsaStartRequest,
  IsaStopInstruction,
  IsaSummary,
  IsaTotalRequest,
  IsaTrade,
  IsaUnpriced,
} from "./types/isa";

/** 칸의 배너 글(명세 §8 그대로). */
export const ISA_BANNER = "연결되지 않은 다른 증권사 계좌 — 이 화면과 텔레그램의 지시를 보고 직접 매매합니다(주문 기능 없음)";

/** 카드의 출처 한 줄. */
export const ISA_SOURCE =
  "이 대시보드의 ISA 계좌 잔고(PostgreSQL manual_*) — 지시는 한국 규칙 계좌의 다음 맞추기(시가 또는 개장 10분 뒤) 목표 비중·장중 스탑(대시보드 계산), 평가는 실시간 가격(표시 전용 — 못 받은 종목은 밤 관측치 종가)";

/** 수수료·세금 안내. */
export const COST_NOTE =
  "수수료는 화면에서 바꾼 요율, 세금은 코스피 거래세+농특세 0.20%·코스닥 0.20%·ETF 0%(매도만, 원 미만 절사)로 어림합니다. 수수료는 '확인' 창에서 실제 값으로 고칠 수 있습니다.";

/** 장전 동시호가 길이 — 개장 30분 전부터(텔레그램 글 ManualAccountNotices와 같음). */
const AUCTION_MINUTES = 30;

/** 개장 시각을 모를 때의 시각(보통 날 09:00). */
const DEFAULT_OPEN = "09:00";

/** 개장 시각(ISO) → 서울 벽시계 "HH:mm". 못 읽으면 null. */
function openClock(open: string | null | undefined): string | null {
  const input = kstInputFromIso(open);
  return input === "" ? null : input.slice(11, 16);
}

/** 시각 맞추기 지시의 시각(ISO) → 서울 벽시계 "HH:mm"(예 "09:10"). 없거나 못 읽으면 null. */
export function targetClock(targetAt: string | null | undefined): string | null {
  return openClock(targetAt);
}

/**
 * 지시 칸의 매매 안내(텔레그램 글과 같은 뜻 — 명세 §4). 동시호가 구간은 그 세션 개장 시각(instructions.open)의 30분 전부터 개장까지
 * — 장 시간 변경일(수능일 10:00 개장 등)에도 맞게. 개장 시각을 모르면 보통 날(08:30~09:00). 개장 10분 뒤 시각 맞추기 지시
 * (instructions.targetAt — ADR 0033)면 'HH:MM 이후 시장가' 안내입니다.
 */
export function tradeGuide(open: string | null | undefined, targetAt?: string | null): string {
  const at = openClock(targetAt);
  if (at !== null) {
    return `${at} 이후 시장가로 내면 규칙 계좌와 같은 때(${at})에 체결됩니다. 장중 스탑이 걸리면 텔레그램으로 따로 알립니다. 매매했으면 '확인'을 눌러 실제 수량·체결 금액·수수료를 적으세요 — 적은 값으로 잔고에 바로 반영합니다.`;
  }
  const end = openClock(open) ?? DEFAULT_OPEN;
  const minutes = (Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5)) - AUCTION_MINUTES + 24 * 60) % (24 * 60);
  const start = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `장전 동시호가(${start}~${end})에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 매매했으면 '확인'을 눌러 실제 수량·체결 금액·수수료를 적으세요 — 적은 값으로 잔고에 바로 반영합니다.`;
}

/** '못 만듦'(UNAVAILABLE) 세션의 안내 — 사유 코드(instructions.reason)별로, 모르는 사유·없음은 단정하지 않는 문구. */
export function unavailableText(reason: string | null | undefined): string {
  switch (reason) {
    case "timed-orders":
      return "규칙 계좌가 시가 밖 시점으로 주문해 ISA는 이번 세션 시가 지시를 만들지 않았습니다(지시 시각 — 시가·개장 10분 뒤 — 밖의 주문) — 이번 세션은 매매하지 않고 다음 결정을 기다립니다.";
    default:
      return "이 세션의 지시를 만들지 못했습니다 — 이번 세션은 매매하지 않고 다음 결정을 기다립니다. 까닭이 있으면 요약 칸의 안내에 적혀 있습니다.";
  }
}

const STOP_TIMING: Readonly<Record<string, string>> = {
  MARKET: "장중 시장가",
  AT_MINUTE: "장중 시장가",
  NEXT_CLOSE: "종가 단일가 시장가",
};

/** 장중 스탑 지시의 매도 방식 — 장중 시장가·종가 단일가 시장가(그 세션 마감 10분 전~마감 — stopWindowText). 모르는 값은 받은 글자 그대로. */
export function stopTimingLabel(timing: string | null | undefined): string {
  if (typeof timing !== "string" || timing.trim() === "") {
    return EMPTY;
  }
  return STOP_TIMING[timing] ?? timing;
}

/** 종가 단일가 길이 — 정규장 마감 10분 전부터(텔레그램 글 ManualAccountNotices·백엔드 SessionWindows.KR_CLOSING_AUCTION과 같음). */
const CLOSING_AUCTION_MINUTES = 10;

/**
 * 장중 스탑 지시 한 줄의 매도 창 — 그 세션 시각에서 셉니다(QA-314 — 예전에는 카드 안내가 09:10·15:20~15:30 고정이라 장 시간 변경일에 틀렸음).
 * 종가 단일가(NEXT_CLOSE)는 기준 시각(서버 targetAt — 그 세션 마감)의 10분 전부터 마감까지('16:20~16:30' — 수능일), 장중 시장가(MARKET·AT_MINUTE)는
 * 기준 시각 이후('10:10 이후' — 개장 10분 뒤 전에 걸린 스탑은 그 세션 첫 분). 텔레그램 글(ManualAccountNotices.stop)과 같은 시각입니다. 기준 시각이나
 * 방식을 모르면 "—"(시각을 지어내지 않음).
 */
export function stopWindowText(item: Pick<IsaStopInstruction, "timing" | "targetAt">): string {
  const at = openClock(item.targetAt);
  if (at === null) {
    return EMPTY;
  }
  if (item.timing === "NEXT_CLOSE") {
    const minutes = (Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5)) - CLOSING_AUCTION_MINUTES + 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}~${at}`;
  }
  return item.timing === "MARKET" || item.timing === "AT_MINUTE" ? `${at} 이후` : EMPTY;
}

/**
 * 장중 스탑 카드 아래 안내 — 시각은 줄마다의 매도 창(stopWindowText)이 그 세션 시각으로 적으므로 여기에는 고정 시각을 넣지 않습니다(QA-314).
 */
export const STOP_GUIDE =
  "장중 시장가는 알림을 받으면 바로(개장 10분 뒤 전에 걸린 스탑은 그 시각 이후), 종가 단일가는 마감 10분 전부터 마감까지 시장가로 매도하세요 — "
  + "줄마다 '매도 창'이 그 세션의 시각입니다(장 시간 변경일은 그날 개장·마감 기준). 매매했으면 '확인'을 눌러 실제 수량·체결 금액·수수료를 적으세요 — 적은 값으로 잔고에 바로 반영합니다.";

const AUTO_NOTE: Readonly<Record<string, string>> = {
  "not-notified": "마감까지 알리지 못해 건너뜀",
  expired: "마감까지 확인하지 않아 닫힘",
  "no-holding": "보유 없음",
  restart: "새로 시작하며 닫힘",
  "not-trading": "거래일이 아니게 되어 닫힘",
  restored: "DB 복원으로 건너뜀",
};

/** 지시·스탑 지시가 닫힌 까닭. 없으면 "—", 모르는 값은 받은 글자 그대로. */
export function autoNoteLabel(note: string | null | undefined): string {
  if (typeof note !== "string" || note.trim() === "") {
    return EMPTY;
  }
  return AUTO_NOTE[note] ?? note;
}

/** 장중 스탑 지시의 알림 칸 — 보낸 시각("알림 11:32"), 보내기 전이면 "—". */
export function stopNotifiedText(item: Pick<IsaStopInstruction, "notifiedAt">): string {
  return typeof item.notifiedAt === "string" && item.notifiedAt.trim() !== "" ? `알림 ${kstShort(item.notifiedAt)}` : "보내기 전";
}

/** 지시를 만든 뒤 잔고가 바뀌었는데 다시 계산하지 않았을 때(instructions.ledgerChanged)의 경고. */
export const BALANCE_CHANGED_TEXT = "지시를 만든 뒤 잔고가 바뀌었습니다 — 수량을 다시 확인하세요.";

/** 숫자 또는 숫자 글자 → 숫자. 읽지 못하면 null(0으로 채우지 않음). */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 원 단위 금액("1,234,567원"). 모르면 "—"(단위 없이). */
export function formatWon(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : `${formatNumber(number, 0)}원`;
}

/** 부호를 붙인 원 단위 금액("+12,345원"·"-12,345원"). 모르면 "—". */
export function formatSignedWon(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : `${formatSigned(number, 0)}원`;
}

/** 주당 가격 — 원 단위 호가라 정수면 0자리, 소수가 있으면(사용자가 고친 값) 둘째 자리까지. 모르면 "—". */
export function formatPrice(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : `${formatNumber(number, Number.isInteger(number) ? 0 : 2)}원`;
}

/** 수량(주) — 정수면 0자리, 아니면 둘째 자리까지. 모르면 "—". */
export function formatShares(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : formatNumber(number, Number.isInteger(number) ? 0 : 2);
}

/** 비중(%) — 부호 없이 둘째 자리("12.34%"). 모르면 "—". */
export function formatWeight(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : `${formatNumber(number, 2)}%`;
}

/** 받은 글자의 이름표 — 모르는 값은 받은 글자 그대로(지어내지 않음), 없으면 "—". */
function labelOf(table: Readonly<Record<string, string>>, code: string | null | undefined): string {
  if (typeof code !== "string" || code.trim() === "") {
    return EMPTY;
  }
  return table[code] ?? code;
}

/** 방향 — 매수·매도. */
export function sideLabel(side: string | null | undefined): string {
  return labelOf({ BUY: "매수", SELL: "매도" }, side);
}

const INSTRUCTION_STATUS: Readonly<Record<string, string>> = {
  PLANNED: "미확인",
  RECORDED: "확인함(잔고 반영)",
  SKIPPED: "건너뜀",
  SUPERSEDED: "새 지시로 바뀜",
};

/** 지시 한 줄의 상태 이름표. */
export function instructionStatusLabel(status: string | null | undefined): string {
  return labelOf(INSTRUCTION_STATUS, status);
}

const SESSION_STATUS: Readonly<Record<string, string>> = { PLANNED: "지시 있음", NONE: "지시 없음", UNAVAILABLE: "못 만듦" };

/** 세션 상태 이름표(지시 있음·지시 없음·못 만듦). */
export function sessionStatusLabel(status: string | null | undefined): string {
  return labelOf(SESSION_STATUS, status);
}

const ACCOUNT_STATE: Readonly<Record<string, string>> = { ACTIVE: "운용 중", PAUSED: "일시정지" };

/** 계좌 상태 이름표. */
export function accountStateLabel(state: string | null | undefined): string {
  return labelOf(ACCOUNT_STATE, state);
}

/** 종목 칸 — "이름 코드" 또는 코드만. */
export function symbolText(symbol: string | null | undefined, name: string | null | undefined): string {
  if (!symbol) {
    return name || EMPTY;
  }
  return name ? `${name} ${symbol}` : symbol;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 지시 한 줄의 매매 시점 머리 — 세션이 있으면 '11/10(화) 시가 ' 또는 개장 10분 뒤 시각 맞추기 지시(targetAt — ADR 0033)면 '11/10(화) 09:10 이후 시장가 ',
 * 세션이 없으면(다음 세션 지시 표 — 칸 제목이 세션을 적음) 빈 글자. 건너뜀 확인 창이 씁니다(QA-324 — 예전에는 시각 맞추기 지시도 '시가').
 */
export function instructionWhenText(item: Pick<IsaInstructionItem, "session" | "targetAt">): string {
  if (!item.session) return "";
  const at = targetClock(item.targetAt);
  return `${sessionLabel(item.session)} ${at ? `${at} 이후 시장가` : "시가"} `;
}

/** 세션 날짜 "YYYY-MM-DD" → "11/09(월)". 알아볼 수 없으면 받은 글자 그대로, 없으면 "—". */
export function sessionLabel(session: string | null | undefined): string {
  if (typeof session !== "string" || session.trim() === "") {
    return EMPTY;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(session.trim());
  if (!match) {
    return session;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match[3])) {
    return session;
  }
  return `${match[2]}/${match[3]}(${WEEKDAYS[date.getUTCDay()]})`;
}

/** 시각 → 서울 시각 "MM/DD HH:mm"(formatKst의 분까지 글에서 해를 뗌). 알아볼 수 없으면 formatKst 그대로, 없으면 "—". */
export function kstShort(value: string | null | undefined): string {
  const full = formatKst(value);
  const match = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(full);
  return match ? `${match[1]}/${match[2]} ${match[3]}` : full;
}

/** 알림 칸 — "아침 11/09 08:00 · 장 중반 11/09 12:15 · 마감 전 11/09 15:00", 보낸 적이 없으면 "보내기 전". */
export function notifiedText(item: Pick<IsaInstructionItem, "notifiedMorningAt" | "notifiedMiddayAt" | "notifiedPrecloseAt">): string {
  const parts: string[] = [];
  if (item.notifiedMorningAt) parts.push(`아침 ${kstShort(item.notifiedMorningAt)}`);
  if (item.notifiedMiddayAt) parts.push(`장 중반 ${kstShort(item.notifiedMiddayAt)}`);
  if (item.notifiedPrecloseAt) parts.push(`마감 전 ${kstShort(item.notifiedPrecloseAt)}`);
  return parts.length > 0 ? parts.join(" · ") : "보내기 전";
}

/** 가격을 몰라 평가에서 뺀 종목들 — "이름 코드, 코드". 없으면 null. */
export function unpricedText(list: readonly IsaUnpriced[] | null | undefined): string | null {
  const names = (list ?? [])
    .map((item) => (typeof item === "string" ? item.trim() : symbolText(item?.symbol ?? null, item?.name ?? null)))
    .filter((text) => text !== "" && text !== EMPTY);
  return names.length > 0 ? names.join(", ") : null;
}

/** '확인'을 보이는가 — 아직 확인하지 않은 지시만. */
export function canConfirm(item: Pick<IsaInstructionItem, "status">): boolean {
  return item.status === "PLANNED";
}

/** 장 중반·마감 전 확인 알림 안내(지시 표 아래). */
export const MIDDAY_GUIDE =
  "이 시스템은 다른 증권사의 실제 매매를 볼 수 없습니다. 매매했으면 '확인'을 눌러 실제 수량·체결 금액·수수료를 적으세요 — 적은 값으로 잔고에 바로 반영합니다. 그날 정규장 절반(보통 12:15)과 마감 30분 전(보통 15:00)까지 확인하지 않은 지시는 텔레그램으로 한 번씩 더 알립니다. 체결가가 다르면 잔고에서 가격을 고치고, 잘못 눌렀으면 매매 내역에서 되돌리세요.";

/** 건너뜀을 보이는가 — 아직 확인하지 않은 지시만. */
export function canSkip(item: Pick<IsaInstructionItem, "status">): boolean {
  return item.status === "PLANNED";
}

// ---------------------------------------------------------------- 실시간 평가(명세 2026-11-06-us-costs-backfill §6)

/** 종목 하나의 실시간 가격(화면 표시 전용 — ADR 0024) — 가격과 그 가격의 시각(ISO, 출처가 밝힌 기준 시각 — 모르면 받은 시각). */
export interface IsaLiveQuote {
  price: number;
  at: string | null;
}

/** 평가한 잔고 한 줄 — 가격·평가액·손익·비중은 실시간 가격(있으면) 또는 서버가 준 직전 종가로 다시 센 값. */
export interface IsaPositionView extends IsaPosition {
  /** 가격의 출처 — 실시간(live)·서버가 준 직전 종가(close)·모름(null). */
  priceSource: "live" | "close" | null;
  /** 실시간 가격의 시각(ISO) — 직전 종가·모름이면 null. */
  priceAt: string | null;
}

/** 요약·잔고를 한 기준으로 평가한 결과 — 받은 실시간 가격이 없으면 서버 값 그대로(`live` 0). */
export interface IsaValuation {
  positions: IsaPositionView[];
  cash: number | null;
  marketValue: number | null;
  totalAsset: number | null;
  purchaseTotal: number | null;
  profitLoss: number | null;
  profitLossPct: number | null;
  /** 가격을 몰라 평가에서 뺀 종목(실시간도 직전 종가도 없음). 받은 가격이 없으면 서버 목록 그대로. */
  unpriced: IsaUnpriced[];
  /** 실시간 가격으로 평가한 종목 수. */
  live: number;
  /** 서버가 준 직전 종가로 둔 종목 수. */
  close: number;
  /** 기준 시각 — 평가에 쓴 실시간 가격의 시각 중 가장 이른 것(ISO). 실시간 가격이 없거나 시각을 모르면 null. */
  basisAt: string | null;
}

/** 쓸 수 있는 가격인가 — 0보다 큰 유한한 수. */
function usablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 잔고 + 요약 + 실시간 가격(종목 코드 → 가격) → 평가. 실시간 가격을 하나라도 받았으면 평가액 = Σ 수량 × 가격(실시간, 못 받은 종목은 서버가 준 직전 종가), 총 잔고 = 현금 + 평가액,
 * 손익 = 평가액 − 매입 금액 합(가격을 모르는 보유가 남으면 null — 서버와 같음), 비중 = 평가액(종목) ÷ 총 잔고로 다시 셉니다. 받은 가격이 없으면 서버 값을 그대로 돌려줍니다(같은 값을
 * 화면에서 다시 세어 반올림이 어긋나지 않게). 가격을 모르는 종목은 평가에서 빼고(0으로 채우지 않음) `unpriced`에 둡니다. 서버 지시는 이 값을 쓰지 않습니다(직전 종가 그대로).
 */
export function isaValuation(
  positions: readonly IsaPosition[] | null | undefined,
  summary: IsaSummary | null | undefined,
  quotes: Readonly<Record<string, IsaLiveQuote>>,
): IsaValuation {
  const rows = positions ?? [];
  const quoteOf = (symbol: string): IsaLiveQuote | null => {
    const quote = Object.hasOwn(quotes, symbol) ? quotes[symbol] : null;
    return quote && usablePrice(quote.price) ? quote : null;
  };
  const cash = toNumber(summary?.cash);
  const purchaseTotal = toNumber(summary?.purchaseTotal);
  const live = rows.filter((row) => quoteOf(row.symbol) !== null).length;

  if (live === 0) {
    const views: IsaPositionView[] = rows.map((row) => ({
      ...row,
      priceSource: toNumber(row.lastPrice) === null ? null : "close",
      priceAt: null,
    }));
    return {
      positions: views,
      cash,
      marketValue: toNumber(summary?.marketValue),
      totalAsset: toNumber(summary?.totalAsset),
      purchaseTotal,
      profitLoss: toNumber(summary?.profitLoss),
      profitLossPct: toNumber(summary?.profitLossPct),
      unpriced: [...(summary?.unpriced ?? [])],
      live: 0,
      close: views.filter((row) => row.priceSource === "close").length,
      basisAt: null,
    };
  }

  const priced = rows.map((row) => {
    const quote = quoteOf(row.symbol);
    const close = toNumber(row.lastPrice);
    const price = quote ? quote.price : close;
    const quantity = toNumber(row.quantity);
    const value = price !== null && quantity !== null ? quantity * price : null;
    return { row, quote, price, value, source: quote ? ("live" as const) : close === null ? null : ("close" as const) };
  });
  const marketValue = priced.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
  const totalAsset = cash === null ? null : cash + marketValue;
  const hasUnpriced = priced.some((entry) => entry.value === null && (toNumber(entry.row.quantity) ?? 0) > 0);
  const profitLoss = hasUnpriced || purchaseTotal === null ? null : marketValue - purchaseTotal;
  const profitLossPct = profitLoss === null || purchaseTotal === null || purchaseTotal <= 0 ? null : (profitLoss / purchaseTotal) * 100;
  let basis: number | null = null;
  let basisAt: string | null = null;
  for (const entry of priced) {
    const at = entry.quote?.at ? Date.parse(entry.quote.at) : NaN;
    if (Number.isFinite(at) && (basis === null || at < basis)) {
      basis = at;
      basisAt = entry.quote?.at ?? null;
    }
  }
  return {
    positions: priced.map(({ row, quote, price, value, source }) => {
      const purchase = toNumber(row.purchaseAmount);
      const pnl = value !== null && purchase !== null ? value - purchase : null;
      return {
        ...row,
        lastPrice: price,
        marketValue: value,
        profitLoss: pnl,
        profitLossPct: pnl !== null && purchase !== null && purchase > 0 ? (pnl / purchase) * 100 : null,
        weightPct: value !== null && totalAsset !== null && totalAsset > 0 ? (value / totalAsset) * 100 : null,
        priceSource: source,
        priceAt: quote?.at ?? null,
      };
    }),
    cash,
    marketValue,
    totalAsset,
    purchaseTotal,
    profitLoss,
    profitLossPct,
    unpriced: priced.filter((entry) => entry.value === null).map(({ row }) => ({ symbol: row.symbol, name: row.name })),
    live,
    close: priced.filter((entry) => entry.source === "close").length,
    basisAt,
  };
}

/** 체결 입력 창의 칸. */
export type IsaConfirmField = "quantity" | "amount" | "price" | "fee";

/**
 * 체결 입력 창의 한 줄(2026-11-09 사용자 결정) — 수량·체결 금액(총액)·평균 단가·수수료. 금액을 고치면 평균 단가가, 평균 단가나 수량을 고치면 금액이 따라 바뀌고, 수수료는 직접
 * 고치기 전까지 수수료율로 다시 셉니다. 채워 둔 값을 그대로 보내면 가격 출처는 live·close, 금액을 고치면 user입니다.
 */
export interface IsaConfirmLine {
  key: string;
  instructionId: number | null;
  stopInstructionId: number | null;
  side: string;
  symbol: string;
  name: string | null;
  /** 지시 수량(참고 — 고치기 창은 null). */
  instructed: number | null;
  quantity: string;
  amount: string;
  price: string;
  fee: string;
  feeEdited: boolean;
  source: "live" | "close" | "user";
  /** 벗어나면 경고할 참고 가격(실시간, 없으면 기준가·직전 종가). */
  refPrice: number | null;
}

/** 수수료 어림 — 금액 × 수수료율(%), 원 미만 절사. 수수료율을 모르면 0. */
export function estimateFee(amount: number, commissionPct: number | null): number {
  return commissionPct === null ? 0 : Math.floor((amount * commissionPct) / 100);
}

const wonText = (value: number): string => String(Math.round(value));
const priceText = (value: number): string => String(Number(value.toFixed(2)));

function confirmLine(
  ids: { key: string; instructionId: number | null; stopInstructionId: number | null },
  who: { side: string; symbol: string; name: string | null },
  quantity: number | null,
  quote: IsaLiveQuote | null,
  fallback: number | null,
  commissionPct: number | null,
): IsaConfirmLine {
  const live = quote && usablePrice(quote.price) ? quote.price : null;
  const price = live ?? fallback;
  const amount = price !== null && quantity !== null ? Math.round(price * quantity) : null;
  return {
    ...ids,
    ...who,
    instructed: quantity,
    quantity: quantity === null ? "" : String(quantity),
    amount: amount === null ? "" : String(amount),
    price: price === null ? "" : priceText(price),
    fee: amount === null ? "" : String(estimateFee(amount, commissionPct)),
    feeEdited: false,
    source: live !== null ? "live" : "close",
    refPrice: price,
  };
}

/** 다음 매매 지시 → 체결 입력 한 줄(실시간 가격, 없으면 지시 기준가로 채움). */
export function confirmLineFromInstruction(item: IsaInstructionItem, quotes: Readonly<Record<string, IsaLiveQuote>>, commissionPct: number | null): IsaConfirmLine {
  return confirmLine(
    { key: `i-${item.id}`, instructionId: item.id, stopInstructionId: null },
    { side: item.side, symbol: item.symbol, name: item.name },
    toNumber(item.quantity),
    Object.hasOwn(quotes, item.symbol) ? quotes[item.symbol] : null,
    toNumber(item.refPrice),
    commissionPct,
  );
}

/** 장중 스탑 지시 → 체결 입력 한 줄(실시간 가격, 없으면 잔고의 현재가로 채움). */
export function confirmLineFromStop(
  row: IsaStopInstruction,
  quotes: Readonly<Record<string, IsaLiveQuote>>,
  fallback: number | null,
  commissionPct: number | null,
): IsaConfirmLine {
  return confirmLine(
    { key: `s-${row.id}`, instructionId: null, stopInstructionId: row.id },
    { side: row.side, symbol: row.symbol, name: row.name },
    toNumber(row.quantity),
    Object.hasOwn(quotes, row.symbol) ? quotes[row.symbol] : null,
    fallback,
    commissionPct,
  );
}

/** 매매 내역 → 고치기 한 줄(적어 둔 값 그대로 — 수수료는 그 값을 유지). */
export function confirmLineFromTrade(trade: IsaTrade): IsaConfirmLine {
  const amount = toNumber(trade.amount);
  const price = toNumber(trade.price);
  const quantity = toNumber(trade.quantity);
  const fee = toNumber(trade.fee);
  return {
    key: `t-${trade.id}`,
    instructionId: null,
    stopInstructionId: null,
    side: trade.side,
    symbol: trade.symbol,
    name: trade.name,
    instructed: null,
    quantity: quantity === null ? "" : String(quantity),
    amount: amount === null ? "" : wonText(amount),
    price: price === null ? "" : priceText(price),
    fee: fee === null ? "" : String(fee),
    feeEdited: true,
    source: "user",
    refPrice: price,
  };
}

/** 칸 하나를 고친 줄 — 금액 ↔ 평균 단가 ↔ 수량을 맞추고, 직접 고치지 않은 수수료를 다시 셉니다. 읽지 못하는 입력은 그대로 두고 다른 칸은 건드리지 않습니다. */
export function updateConfirmLine(line: IsaConfirmLine, field: IsaConfirmField, value: string, commissionPct: number | null): IsaConfirmLine {
  const next: IsaConfirmLine = { ...line, [field]: value };
  if (field === "fee") return { ...next, feeEdited: true };
  if (field !== "quantity") next.source = "user";
  const quantity = parseDecimal(next.quantity, { maxDecimals: 0 });
  if (field === "amount") {
    const amount = parseDecimal(value, { maxDecimals: AMOUNT_DECIMALS });
    if (amount !== null && amount > 0 && quantity !== null && quantity > 0) next.price = priceText(amount / quantity);
  } else {
    const price = parseDecimal(next.price, { maxDecimals: PRICE_DECIMALS });
    if (price !== null && price > 0 && quantity !== null && quantity > 0) next.amount = wonText(price * quantity);
  }
  if (!next.feeEdited) {
    const amount = parseDecimal(next.amount, { maxDecimals: AMOUNT_DECIMALS });
    if (amount !== null) next.fee = String(estimateFee(amount, commissionPct));
  }
  return next;
}

/** 참고 가격에서 10% 넘게 벗어나면 경고 글(총액·단가를 바꿔 적었을 때 바로 보이게) — 막지는 않습니다(±40%는 서버가 거절). */
export function confirmLineWarning(line: Pick<IsaConfirmLine, "price" | "refPrice">): string | null {
  const price = parseDecimal(line.price, { maxDecimals: PRICE_DECIMALS });
  if (price === null || price <= 0 || line.refPrice === null || line.refPrice <= 0) return null;
  const gap = (price / line.refPrice - 1) * 100;
  return Math.abs(gap) < 10 ? null : `평균 단가가 참고 가격 ${formatPrice(line.refPrice)}보다 ${formatNumber(Math.abs(gap), 1)}% ${gap > 0 ? "높습니다" : "낮습니다"} — 총액과 단가 칸을 확인하세요.`;
}

/** 줄 하나의 수량·금액·수수료 읽기 — 문제가 있으면 errors에 글을 더하고 null. */
function readConfirmLine(line: IsaConfirmLine, errors: string[]): { quantity: number; amount: number; fee: number } | null {
  const who = symbolText(line.symbol, line.name);
  const quantity = parseDecimal(line.quantity, { maxDecimals: 0 });
  const amount = parseDecimal(line.amount, { maxDecimals: AMOUNT_DECIMALS });
  const fee = line.fee.trim() === "" ? 0 : parseDecimal(line.fee, { maxDecimals: AMOUNT_DECIMALS });
  if (quantity === null || quantity <= 0) errors.push(`${who} — 수량은 1 이상의 정수 주입니다.`);
  if (amount === null || amount <= 0) errors.push(`${who} — 체결 금액(총액)을 적으세요.`);
  if (fee === null) errors.push(`${who} — 수수료는 0 이상의 원 단위 금액입니다.`);
  return quantity !== null && quantity > 0 && amount !== null && amount > 0 && fee !== null ? { quantity, amount, fee } : null;
}

/** 체결 입력 → POST /api/manual/isa/instructions/apply 본문. */
export function buildApplyRequest(lines: readonly IsaConfirmLine[]): Checked<IsaApplyRequest> {
  if (lines.length === 0) return { ok: false, errors: ["반영할 줄이 없습니다."] };
  const errors: string[] = [];
  const items: IsaApplyItem[] = [];
  for (const line of lines) {
    const read = readConfirmLine(line, errors);
    if (read) {
      const id = line.instructionId !== null ? { instructionId: line.instructionId } : { stopInstructionId: line.stopInstructionId as number };
      items.push({ ...id, ...read, priceSource: line.source });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: { items } };
}

/** 매매 고치기 → POST /api/manual/isa/trades/{id} 본문. */
export function buildEditTradeRequest(line: IsaConfirmLine): Checked<IsaEditTradeRequest> {
  const errors: string[] = [];
  const read = readConfirmLine(line, errors);
  return read ? { ok: true, body: read } : { ok: false, errors };
}

/** 기준 시각 글 — "2026-11-06 14:31:05 KST"(초까지). 실시간 가격이 없거나 시각을 모르면 "—". */
export function isaBasisText(valuation: Pick<IsaValuation, "basisAt">): string {
  const text = formatKstSeconds(valuation.basisAt);
  return text === EMPTY ? EMPTY : `${text} KST`;
}

/** 기준 시각 옆 한 줄 — 몇 종목이 실시간이고 몇 종목이 직전 종가인지, 실시간 가격이 없으면 직전 종가로 평가한다는 것. */
export function isaBasisNote(valuation: Pick<IsaValuation, "live" | "close">): string {
  if (valuation.live === 0) {
    return "실시간 가격을 아직 받지 못해 서버가 준 직전 종가(밤 관측치)로 평가";
  }
  const close = valuation.close > 0 ? ` · 직전 종가 ${valuation.close}종목` : "";
  return `실시간 ${valuation.live}종목${close} — 평가액·손익·비중만 다시 계산(지시는 직전 종가)`;
}

/** 시각 글자 → 정렬 값(ms). 못 읽으면 null(정렬에서 맨 뒤). */
export function timeSortValue(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Date.parse(value.trim().replace(/\[.*\]$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------- 입력 검사

/** 종목 코드 — DB 검사와 같은 모양(숫자 하나 + 숫자·대문자 다섯). */
export const SYMBOL_PATTERN = /^[0-9][0-9A-Z]{5}$/;

/**
 * 숫자 입력 → 숫자. 천 단위 쉼표("10,000,000")는 자리가 맞을 때만 받고, 소수는 `maxDecimals` 자리까지. 음수는 `allowNegative`일 때만.
 * 빈 칸·모양이 틀림·자릿수 넘침 → null.
 */
export function parseDecimal(text: string, options: { maxDecimals: number; allowNegative?: boolean }): number | null {
  const trimmed = text.trim();
  const match = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  if (match[1] && !options.allowNegative) {
    return null;
  }
  if (match[3] && match[3].length > options.maxDecimals) {
    return null;
  }
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** 수량 — DB NUMERIC(20,6)과 같은 소수 여섯째 자리까지. */
const QUANTITY_DECIMALS = 6;
/** 가격 — NUMERIC(20,4). */
const PRICE_DECIMALS = 4;
/** 금액·수수료·세금 — NUMERIC(20,2). */
const AMOUNT_DECIMALS = 2;

/** 시각 글자(ISO) → datetime-local 입력값(서울 시각 "YYYY-MM-DDTHH:mm"). 시간대가 없으면 KST로 읽고, 못 읽으면 "". */
export function kstInputFromIso(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }
  const text = value.trim().replace(/\[.*\]$/, "");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    return "";
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    return `${text.slice(0, 10)}T${text.slice(11, 16)}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(parsed)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return "";
  }
}

/** 보내기 전 검사 결과 — 보낼 본문 또는 사람이 고칠 것 목록. */
export type Checked<T> = { ok: true; body: T } | { ok: false; errors: string[] };

/** 시작 창의 한 줄(글자 그대로). */
export interface IsaStartLine {
  symbol: string;
  quantity: string;
  purchaseAmount: string;
}

/** 빈 줄. */
export function emptyStartLine(): IsaStartLine {
  return { symbol: "", quantity: "", purchaseAmount: "" };
}

/** 실시간 가격 칸(비었으면 뺌). */
function withPrices<T extends object>(body: T, prices: Readonly<Record<string, number>> | undefined): T & { prices?: Record<string, number> } {
  const entries = Object.entries(prices ?? {}).filter(([, price]) => usablePrice(price));
  return entries.length > 0 ? { ...body, prices: Object.fromEntries(entries) } : body;
}

/**
 * 시작 창 입력 → POST /api/manual/isa/start 본문. 총 잔고는 0보다 큰 원, 줄마다 종목(이름 또는 코드)·수량(0보다 큰 수)·매입 금액(0 이상의 원). 비어 있는 줄은 건너뜁니다(종목이 없으면 현금만으로 시작).
 */
export function buildStartRequest(input: {
  totalAsset: string;
  lines: readonly IsaStartLine[];
  prices?: Readonly<Record<string, number>>;
}): Checked<IsaStartRequest> {
  const errors: string[] = [];
  const total = parseDecimal(input.totalAsset, { maxDecimals: AMOUNT_DECIMALS });
  if (total === null || total <= 0) errors.push("총 잔고(총평가금액)는 0보다 큰 원 단위 금액입니다(예: 10,000,000).");
  const positions: IsaStartPosition[] = [];
  input.lines.forEach((line, index) => {
    if (line.symbol.trim() === "" && line.quantity.trim() === "" && line.purchaseAmount.trim() === "") {
      return;
    }
    const where = `${index + 1}번째 줄`;
    const quantity = parseDecimal(line.quantity, { maxDecimals: QUANTITY_DECIMALS });
    const purchase = parseDecimal(line.purchaseAmount, { maxDecimals: AMOUNT_DECIMALS });
    const problems: string[] = [];
    if (line.symbol.trim() === "") problems.push("종목(이름 또는 여섯 자리 코드)");
    if (quantity === null || quantity <= 0) problems.push("수량은 0보다 큰 수");
    if (purchase === null || purchase < 0) problems.push("매입 금액은 0 이상의 원");
    if (problems.length > 0) {
      errors.push(`${where}: ${problems.join(", ")}`);
      return;
    }
    positions.push({ symbol: line.symbol.trim(), quantity: quantity as number, purchaseAmount: purchase as number });
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: withPrices({ totalAsset: total as number, positions }, input.prices) };
}

/** 고치기 창의 입력(글자 그대로). */
export interface IsaPositionForm {
  symbol: string;
  name: string;
  quantity: string;
  price: string;
}

/** 빈 입력(행 추가). */
export function emptyPositionForm(): IsaPositionForm {
  return { symbol: "", name: "", quantity: "", price: "" };
}

/** 숫자를 입력칸 글자로(모르면 빈 칸). */
function inputText(value: unknown): string {
  const number = toNumber(value);
  return number === null ? "" : String(number);
}

/** 잔고 한 줄 → 고치기 창 입력(가격은 평균 매입가). */
export function positionFormFromRow(row: IsaPosition): IsaPositionForm {
  return { symbol: row.symbol, name: row.name ?? "", quantity: inputText(row.quantity), price: inputText(row.avgPrice) };
}

/** 고치기 창의 '매입 금액 = 수량 × 가격' — 두 칸을 읽지 못하면 null. */
export function positionFormAmount(form: IsaPositionForm): number | null {
  const quantity = parseDecimal(form.quantity, { maxDecimals: QUANTITY_DECIMALS });
  const price = parseDecimal(form.price, { maxDecimals: PRICE_DECIMALS });
  return quantity === null || price === null ? null : quantity * price;
}

/** 고치기 창 입력 → POST /api/manual/isa/positions 본문. `originalSymbol`이 있으면 그 행을 고칩니다(코드가 바뀌면 옮김 — 없는 값은 서버가 봄). */
export function buildPositionRequest(form: IsaPositionForm, originalSymbol?: string | null): Checked<IsaPositionRequest> {
  const errors: string[] = [];
  const symbol = form.symbol.trim();
  const quantity = parseDecimal(form.quantity, { maxDecimals: QUANTITY_DECIMALS });
  const price = parseDecimal(form.price, { maxDecimals: PRICE_DECIMALS });
  if (symbol === "") errors.push("종목(이름 또는 여섯 자리 코드)을 넣으세요.");
  if (quantity === null || quantity <= 0) errors.push("수량은 0보다 큰 수입니다.");
  if (price === null || price <= 0) errors.push("가격(평균 매입가)은 0보다 큰 원 단위 가격입니다.");
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const name = form.name.trim();
  return {
    ok: true,
    body: {
      ...(originalSymbol ? { originalSymbol } : {}),
      symbol,
      ...(name !== "" ? { name } : {}),
      quantity: quantity as number,
      price: price as number,
    },
  };
}

/** 총 잔고 다시 맞추기 입력 → 본문. */
export function buildTotalRequest(text: string, prices?: Readonly<Record<string, number>>): Checked<IsaTotalRequest> {
  const total = parseDecimal(text, { maxDecimals: AMOUNT_DECIMALS });
  if (total === null || total <= 0) {
    return { ok: false, errors: ["총 잔고(총평가금액)는 0보다 큰 원 단위 금액입니다."] };
  }
  return { ok: true, body: withPrices({ totalAsset: total }, prices) };
}

/** 수수료율 입력(%) → 본문. 0 이상 1 이하. */
export function buildCommissionRequest(text: string): Checked<IsaCommissionRequest> {
  const pct = parseDecimal(text, { maxDecimals: 6 });
  if (pct === null || pct < 0 || pct > 1) {
    return { ok: false, errors: ["수수료율은 0~1% 사이의 값입니다(예: 0.015)."] };
  }
  return { ok: true, body: { commissionPct: pct } };
}

// ---------------------------------------------------------------- 서버 오류

/** 서버 오류 코드(400 invalid-request, 404 not-found, 409 already-started·not-started·already-recorded). */
export const ISA_ERROR_CODES = ["invalid-request", "not-found", "already-started", "not-started", "already-recorded"] as const;

/** 현금이 음수일 때의 경고(요약 카드) — 잔고 쓰기는 막지 않습니다. */
export const NEGATIVE_CASH_TEXT = "현금이 음수입니다 — 매수가 현금을 넘었거나 잔고 숫자가 실제와 다를 수 있습니다. 총 잔고를 다시 맞추거나 잔고를 고치세요. 음수인 동안 다음 지시의 매수가 줄어듭니다.";

export type IsaErrorCode = (typeof ISA_ERROR_CODES)[number];

/**
 * 요청 오류 → 서버 오류 코드. lib/api의 ApiError는 서버 본문의 `error`를 `code` 칸으로 나릅니다 — 그 칸이 있으면 그것만 정확히 비교하고(아는 코드가
 * 아니면 null), 없을 때만 문구(message) 안의 코드 글자를 찾습니다. 모르면 null — 화면은 서버 문구를 그대로 보입니다.
 */
export function isaErrorCode(error: unknown): IsaErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && code !== "") {
    return ISA_ERROR_CODES.find((known) => known === code) ?? null;
  }
  if (typeof message === "string") {
    return ISA_ERROR_CODES.find((known) => message.includes(known)) ?? null;
  }
  return null;
}

/** 오류 코드별 문구 — 서버 문구(fallback)가 무엇이 틀렸는지 적으면 덧붙입니다. */
export function isaErrorText(code: IsaErrorCode | null, fallback: string | null): string {
  const detail = fallback && fallback.trim() !== "" ? fallback.trim() : null;
  switch (code) {
    case "invalid-request":
      return `입력이 올바르지 않습니다${detail ? ` — ${detail}` : ". 칸을 확인하세요."}`;
    case "not-found":
      return "그 행이나 지시를 찾지 못했습니다 — 그사이 지워졌을 수 있어 화면을 다시 읽었습니다.";
    case "already-started":
      return "이미 시작한 계좌입니다 — 시작은 한 번만 됩니다. 화면을 다시 읽었습니다.";
    case "not-started":
      return "아직 시작하지 않은 계좌입니다 — 먼저 '시작'으로 총 잔고와 보유를 넣으세요.";
    case "already-recorded":
      return "이미 확인한 지시입니다 — 화면을 다시 읽었습니다. 잘못 눌렀으면 매매 내역에서 되돌리세요.";
    default:
      return detail ?? "요청을 처리하지 못했습니다.";
  }
}

/** 이 오류 뒤에 화면을 다시 읽어야 하는가(화면이 서버와 어긋났다는 뜻 — 없는 행·이미 시작·시작 전·이미 적힌 지시). */
export function isaErrorNeedsReload(code: IsaErrorCode | null): boolean {
  return code === "not-found" || code === "already-started" || code === "not-started" || code === "already-recorded";
}
