/**
 * ISA 계좌(연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매' — ADR 0029,
 * docs/specs/2026-11-06-isa-manual-account.md §8)의 표기·입력 검사 — React를 모르는 순수 함수(ADR 0004).
 *
 * 이 파일은 lib/format과 응답 계약 lib/types/isa만 가져옵니다. 모의·홈·실제 계좌 조회(brokerage)·실제 매매(realtrade) 모듈과 서로 가져오지 않습니다
 * (components/screens/isa/__tests__/isaBoundary.test.ts). 장부 숫자(현금·평가액·손익·비중)는 백엔드가 계산한 값을 그대로 찍고, 화면이 계산하는 것은
 * 시작 창의 '시작 매수 합'(현금이 음수가 되는 장부를 보내기 전에 막으려는 어림)과, 보유 종목의 실시간 가격(표시 전용 — ADR 0024, 명세
 * docs/specs/2026-11-06-us-costs-backfill.md §6)을 받았을 때 그 가격으로 다시 센 평가액·손익·비중(`isaValuation` — 받은 가격이 없으면 서버 값 그대로)뿐입니다.
 * 모르는 값은 "—"이고 0으로 채우지 않습니다.
 */
import { EMPTY, formatKst, formatKstSeconds, formatNumber, formatSigned } from "./format";
import type {
  IsaHolding,
  IsaInstructionItem,
  IsaLedgerKind,
  IsaLedgerRequest,
  IsaLedgerRow,
  IsaStartBuy,
  IsaStartRequest,
  IsaStopInstruction,
  IsaSummary,
  IsaUnpriced,
} from "./types/isa";

/** 칸의 배너 글(명세 §8 그대로). */
export const ISA_BANNER = "연결되지 않은 다른 증권사 계좌 — 이 화면과 텔레그램의 지시를 보고 직접 매매합니다(주문 기능 없음)";

/** 카드의 출처 한 줄. */
export const ISA_SOURCE =
  "이 대시보드의 ISA 계좌 장부(PostgreSQL manual_*) — 지시는 한국 규칙 계좌의 다음 맞추기(시가 또는 개장 10분 뒤) 목표 비중·장중 스탑(대시보드 계산), 평가는 실시간 가격(표시 전용 — 못 받은 종목은 밤 관측치 종가)";

/** 자동 기록의 비용 안내(명세 §1 — 수수료·세금은 사용자가 고칠 때만). */
export const COST_NOTE = "비용 0으로 어림 — 지시대로 자동 기록한 행은 수수료·세금을 0으로 적습니다. 실제 체결과 다르면 장부에서 고치세요.";

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
    return `${at} 이후 시장가로 내면 규칙 계좌와 같은 때(${at})에 체결됩니다. 장중 스탑이 걸리면 텔레그램으로 따로 알립니다. 그날 밤 그 시각의 1분봉 값으로 장부에 자동 기록하니, 다르게 매매했으면 '체결 고치기'로 고치세요.`;
  }
  const end = openClock(open) ?? DEFAULT_OPEN;
  const minutes = (Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5)) - AUCTION_MINUTES + 24 * 60) % (24 * 60);
  const start = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `장전 동시호가(${start}~${end})에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 그날 밤 지시대로 장부에 자동 기록하니, 다르게 매매했으면 '체결 고치기'로 고치세요.`;
}

/**
 * 체결 고치기 새 행의 기본 시각(datetime-local 값) — 그 세션 개장 시각(자동 기록 행과 같은 시각이라 같은 세션 매도·매수 순서가 맞음),
 * 모르면 그 세션 09:00, 세션도 모르면 빈 칸(서버가 지금으로).
 */
export function fillAtDefault(session: string | null | undefined, open: string | null | undefined): string {
  const fromOpen = kstInputFromIso(open);
  if (fromOpen !== "") {
    return fromOpen;
  }
  return typeof session === "string" && session.trim() !== "" ? `${session.trim()}T${DEFAULT_OPEN}` : "";
}

/** '못 만듦'(UNAVAILABLE) 세션의 안내 — 사유 코드(instructions.reason)별로, 모르는 사유·없음은 단정하지 않는 문구. */
export function unavailableText(reason: string | null | undefined): string {
  switch (reason) {
    case "record-pending":
      return "이 세션의 지시를 만들지 못했습니다 — 앞 세션 지시의 체결 기록이 남아 있습니다. 앞 세션 지시를 체결 고치기·건너뜀으로 처리하세요(아래 '처리 안 된 지난 지시'). 이번 세션은 매매하지 않습니다.";
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
  + "줄마다 '매도 창'이 그 세션의 시각입니다(장 시간 변경일은 그날 개장·마감 기준). 다르게 매매했으면 장부의 그 자동 기록 행을 고치세요.";

const STOP_NOTE: Readonly<Record<string, string>> = {
  "not-notified": "마감까지 알리지 못해 건너뜀",
  "close-fallback": "1분봉이 없어 그날 종가로 어림",
  halted: "그날 거래 없음(정지)",
  "no-holding": "보유 없음",
  "reduced-holding": "보유까지로 줄여 적음",
  // 백엔드 ManualAccountJob.AUTO_NO_PRICE(그다음 날 07:00까지 값을 못 구함)·DB 복원 SQL의 멈춤(ADR 0033 결정 8) — QA-324.
  "no-price": "값을 구하지 못해 건너뜀(다음 날 07:00)",
  restored: "DB 복원으로 건너뜀",
};

/** 장중 스탑 지시의 자동 기록·건너뜀 메모. 없으면 "—", 모르는 값은 받은 글자 그대로. */
export function stopNoteLabel(note: string | null | undefined): string {
  if (typeof note !== "string" || note.trim() === "") {
    return EMPTY;
  }
  return STOP_NOTE[note] ?? note;
}

/** 장중 스탑 지시의 알림 칸 — 보낸 시각("알림 11:32"), 보내기 전이면 "—". */
export function stopNotifiedText(item: Pick<IsaStopInstruction, "notifiedAt">): string {
  return typeof item.notifiedAt === "string" && item.notifiedAt.trim() !== "" ? `알림 ${kstShort(item.notifiedAt)}` : "보내기 전";
}

/** 지시를 만든 뒤 장부가 바뀌었는데 다시 계산하지 않았을 때(instructions.ledgerChanged)의 경고. */
export const LEDGER_CHANGED_TEXT = "지시를 만든 뒤 장부가 바뀌었습니다 — 수량을 다시 확인하세요.";

/** 장부 표 '금액' 칸의 뜻(서버가 매수·매도 행에도 거래 금액을 채움). */
export const LEDGER_AMOUNT_NOTE = "금액 — 입출금은 입출금액, 매수·매도는 수량×체결가(수수료·세금은 따로).";

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

/** 장부 행 종류 — 고르는 순서(행 추가 창)와 이름표. */
export const LEDGER_KINDS: readonly { kind: IsaLedgerKind; label: string }[] = [
  { kind: "BUY", label: "매수" },
  { kind: "SELL", label: "매도" },
  { kind: "DEPOSIT", label: "입금" },
  { kind: "WITHDRAW", label: "출금" },
  { kind: "ADJUST", label: "조정(수량만 — 분할 등)" },
];

const KIND_LABEL: Readonly<Record<string, string>> = { BUY: "매수", SELL: "매도", DEPOSIT: "입금", WITHDRAW: "출금", ADJUST: "조정" };

/** 장부 행 종류 이름표. */
export function kindLabel(kind: string | null | undefined): string {
  return labelOf(KIND_LABEL, kind);
}

/** 방향 — 매수·매도. */
export function sideLabel(side: string | null | undefined): string {
  return labelOf({ BUY: "매수", SELL: "매도" }, side);
}

const SOURCE_LABEL: Readonly<Record<string, string>> = { AUTO: "자동(지시대로)", USER: "직접 입력" };

/** 장부 행을 쓴 쪽 — 자동(지시대로)·직접 입력. */
export function sourceLabel(source: string | null | undefined): string {
  return labelOf(SOURCE_LABEL, source);
}

const INSTRUCTION_STATUS: Readonly<Record<string, string>> = {
  PLANNED: "지시 — 체결 기록 전",
  RECORDED: "체결 기록됨",
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

/** 세션 날짜 "YYYY-MM-DD" → "11/09(월)". 알아볼 수 없으면 받은 글자 그대로, 없으면 "—". */
/**
 * 지시 한 줄의 매매 시점 머리 — 세션이 있으면 '11/10(화) 시가 ' 또는 개장 10분 뒤 시각 맞추기 지시(targetAt — ADR 0033)면 '11/10(화) 09:10 이후 시장가 ',
 * 세션이 없으면(다음 세션 지시 표 — 칸 제목이 세션을 적음) 빈 글자. 건너뜀 확인 창이 씁니다(QA-324 — 예전에는 시각 맞추기 지시도 '시가').
 */
export function instructionWhenText(item: Pick<IsaInstructionItem, "session" | "targetAt">): string {
  if (!item.session) return "";
  const at = targetClock(item.targetAt);
  return `${sessionLabel(item.session)} ${at ? `${at} 이후 시장가` : "시가"} `;
}

/**
 * '처리 안 된 지난 지시' 안내 — 시가 지시는 그 세션 시가, 시각 맞추기 지시는 그 시각의 1분봉 값이 들어오면 자동 기록합니다(백엔드 ManualAccountJob 자동
 * 기록 — QA-324).
 */
export const PENDING_INSTRUCTIONS_GUIDE =
  "실제로 매매했으면 '체결 고치기'로 수량·체결가를, 매매하지 않았으면 '건너뜀'을 누르세요. 그 세션 시가(개장 10분 뒤 시각 맞추기 지시는 그 시각의 "
  + "1분봉 값)가 들어오면 지시대로 자동 기록합니다.";

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

/** 알림 칸 — "밤 11/06 22:41 · 아침 11/09 08:00", 보낸 적이 없으면 "보내기 전". */
export function notifiedText(item: Pick<IsaInstructionItem, "notifiedNightAt" | "notifiedMorningAt">): string {
  const parts: string[] = [];
  if (item.notifiedNightAt) parts.push(`밤 ${kstShort(item.notifiedNightAt)}`);
  if (item.notifiedMorningAt) parts.push(`아침 ${kstShort(item.notifiedMorningAt)}`);
  return parts.length > 0 ? parts.join(" · ") : "보내기 전";
}

/** 가격을 몰라 평가에서 뺀 종목들 — "이름 코드, 코드". 없으면 null. */
export function unpricedText(list: readonly IsaUnpriced[] | null | undefined): string | null {
  const names = (list ?? [])
    .map((item) => (typeof item === "string" ? item.trim() : symbolText(item?.symbol ?? null, item?.name ?? null)))
    .filter((text) => text !== "" && text !== EMPTY);
  return names.length > 0 ? names.join(", ") : null;
}

/** 체결 고치기를 보이는가 — 기록 전·기록됨(건너뜀·바뀐 지시는 장부에 쓰지 않은 지시라 '행 추가'로). */
export function canFixFill(item: Pick<IsaInstructionItem, "status">): boolean {
  return item.status === "PLANNED" || item.status === "RECORDED";
}

/** 건너뜀을 보이는가 — 아직 장부에 쓰지 않은 지시만(기록된 행은 장부에서 지움). */
export function canSkip(item: Pick<IsaInstructionItem, "status">): boolean {
  return item.status === "PLANNED";
}

/** 그 지시의 체결로 적힌 장부 행(자동·직접 — instructionId가 같은 것 중 가장 최근, 장부는 최근 순). 없으면 null. */
export function ledgerRowForInstruction(ledger: readonly IsaLedgerRow[] | null | undefined, instructionId: number): IsaLedgerRow | null {
  return (ledger ?? []).find((row) => row.instructionId === instructionId) ?? null;
}

// ---------------------------------------------------------------- 실시간 평가(명세 2026-11-06-us-costs-backfill §6)

/** 보유 종목 하나의 실시간 가격(화면 표시 전용 — ADR 0024) — 가격과 그 가격의 시각(ISO, 출처가 밝힌 기준 시각 — 모르면 받은 시각). */
export interface IsaLiveQuote {
  price: number;
  at: string | null;
}

/** 평가한 보유 한 줄 — 가격·평가액·비중은 실시간 가격(있으면) 또는 서버가 준 직전 종가로 다시 센 값. */
export interface IsaHoldingView extends IsaHolding {
  /** 가격의 출처 — 실시간(live)·서버가 준 직전 종가(close)·모름(null). */
  priceSource: "live" | "close" | null;
  /** 실시간 가격의 시각(ISO) — 직전 종가·모름이면 null. */
  priceAt: string | null;
}

/** 요약·보유를 한 기준으로 평가한 결과 — 받은 실시간 가격이 없으면 서버 값 그대로(`live` 0). */
export interface IsaValuation {
  holdings: IsaHoldingView[];
  cash: number | null;
  marketValue: number | null;
  equity: number | null;
  netDeposit: number | null;
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
 * 보유 + 요약 + 실시간 가격(종목 코드 → 가격) → 평가(명세 §6). 실시간 가격을 하나라도 받았으면 평가액 = 현금 + Σ 수량 × 가격(실시간, 못 받은 종목은
 * 서버가 준 직전 종가), 손익 = 평가액 − 순입금, 손익률 = 손익 ÷ 순입금(가격을 모르는 보유가 남으면 둘 다 null — 서버와 같음), 비중 = 평가액(종목) ÷
 * 평가액으로 다시 셉니다. 받은 가격이 없으면 서버 값을 그대로
 * 돌려줍니다(같은 값을 화면에서 다시 세어 반올림이 어긋나지 않게). 가격을 모르는 종목은 평가에서 빼고(0으로 채우지 않음) `unpriced`에 둡니다.
 * 서버 장부·지시는 이 값을 쓰지 않습니다(직전 종가 그대로).
 */
export function isaValuation(
  holdings: readonly IsaHolding[] | null | undefined,
  summary: IsaSummary | null | undefined,
  quotes: Readonly<Record<string, IsaLiveQuote>>,
): IsaValuation {
  const rows = holdings ?? [];
  const quoteOf = (symbol: string): IsaLiveQuote | null => {
    const quote = Object.hasOwn(quotes, symbol) ? quotes[symbol] : null;
    return quote && usablePrice(quote.price) ? quote : null;
  };
  const cash = toNumber(summary?.cash);
  const netDeposit = toNumber(summary?.netDeposit);
  const live = rows.filter((row) => quoteOf(row.symbol) !== null).length;

  if (live === 0) {
    const views: IsaHoldingView[] = rows.map((row) => ({
      ...row,
      priceSource: toNumber(row.lastPrice) === null ? null : "close",
      priceAt: null,
    }));
    return {
      holdings: views,
      cash,
      marketValue: toNumber(summary?.marketValue),
      equity: toNumber(summary?.equity),
      netDeposit,
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
  const equity = cash === null ? null : cash + marketValue;
  // 가격을 모르는 보유가 남아 있으면 손익·손익률은 비웁니다(서버 요약과 같은 정의 — 평가액·비중은 아는 종목만으로 셈, 없는 숫자를 만들지 않음).
  const hasUnpriced = priced.some((entry) => entry.value === null && (toNumber(entry.row.quantity) ?? 0) > 0);
  const profitLoss = hasUnpriced || equity === null || netDeposit === null ? null : equity - netDeposit;
  const profitLossPct = profitLoss === null || netDeposit === null || netDeposit <= 0 ? null : (profitLoss / netDeposit) * 100;
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
    holdings: priced.map(({ row, quote, price, value, source }) => ({
      ...row,
      lastPrice: price,
      marketValue: value,
      weightPct: value !== null && equity !== null && equity > 0 ? (value / equity) * 100 : null,
      priceSource: source,
      priceAt: quote?.at ?? null,
    })),
    cash,
    marketValue,
    equity,
    netDeposit,
    profitLoss,
    profitLossPct,
    unpriced: priced.filter((entry) => entry.value === null).map(({ row }) => ({ symbol: row.symbol, name: row.name })),
    live,
    close: priced.filter((entry) => entry.source === "close").length,
    basisAt,
  };
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
  return `실시간 ${valuation.live}종목${close} — 평가액·손익·비중만 다시 계산(장부·지시는 직전 종가)`;
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

/**
 * datetime-local 입력("2026-11-06T14:55", 초가 붙을 수 있음) → KST ISO("2026-11-06T14:55:00+09:00"). 빈 칸은 undefined(서버가 지금으로),
 * 모양이 틀리면 null.
 */
export function isoFromKstInput(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return `${match[1]}T${match[2]}:${match[3] ?? "00"}+09:00`;
}

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

/** 시작 매수 목록 읽기 결과 — 읽은 줄과 줄마다의 오류("3번째 줄: …"). */
export interface ParsedStartBuys {
  buys: IsaStartBuy[];
  errors: string[];
}

/**
 * 시작 매수 목록 붙여 넣기 → 줄마다 '코드 수량 가격'(빈칸·탭으로 나눔 — 표에서 복사한 줄도 받음). 빈 줄은 건너뜁니다.
 * 코드는 대문자로 바꿔 DB 모양(숫자 하나 + 숫자·대문자 다섯)과 맞추고, 수량·가격은 0보다 커야 합니다(천 단위 쉼표 허용).
 */
export function parseStartBuys(text: string): ParsedStartBuys {
  const buys: IsaStartBuy[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") {
      return;
    }
    const where = `${index + 1}번째 줄`;
    const cells = line.split(/\s+/);
    if (cells.length !== 3) {
      errors.push(`${where}: '코드 수량 가격' 세 칸이어야 합니다(빈칸이나 탭으로 나눔) — "${line}"`);
      return;
    }
    const symbol = cells[0].toUpperCase();
    const quantity = parseDecimal(cells[1], { maxDecimals: QUANTITY_DECIMALS });
    const price = parseDecimal(cells[2], { maxDecimals: PRICE_DECIMALS });
    const problems: string[] = [];
    if (!SYMBOL_PATTERN.test(symbol)) problems.push("종목 코드는 여섯 자리(예: 005930)");
    if (quantity === null || quantity <= 0) problems.push("수량은 0보다 큰 수");
    if (price === null || price <= 0) problems.push("가격은 0보다 큰 수(원)");
    if (problems.length > 0) {
      errors.push(`${where}: ${problems.join(", ")} — "${line}"`);
      return;
    }
    buys.push({ symbol, quantity: quantity as number, price: price as number });
  });
  return { buys, errors };
}

/** 시작 매수 합(Σ 수량 × 가격, 원) — 시작 창의 남는 현금 어림. 수수료는 넣지 않습니다(시작 매수 목록에 비용 칸이 없음). */
export function startBuysTotal(buys: readonly IsaStartBuy[]): number {
  return buys.reduce((sum, buy) => sum + buy.quantity * buy.price, 0);
}

/** 보내기 전 검사 결과 — 보낼 본문 또는 사람이 고칠 것 목록. */
export type Checked<T> = { ok: true; body: T } | { ok: false; errors: string[] };

/**
 * 시작 창 입력 → POST /api/manual/isa/start 본문. 시작 현금은 0보다 큰 원(소수 둘째 자리까지), 시작 시각은 비우면 서버가 지금으로,
 * 시작 매수 목록은 비어도 됩니다(현금만으로 시작). 시작 매수 합이 시작 현금보다 크면 보내지 않습니다(서버도 `ledger-invalid`로 거절).
 */
export function buildStartRequest(input: { cash: string; startedAt: string; buys: string }): Checked<IsaStartRequest> {
  const errors: string[] = [];
  const cash = parseDecimal(input.cash, { maxDecimals: AMOUNT_DECIMALS });
  if (cash === null || cash <= 0) errors.push("시작 현금은 0보다 큰 원 단위 금액입니다(예: 10,000,000).");
  const startedAt = isoFromKstInput(input.startedAt);
  if (startedAt === null) errors.push("시작 시각을 알아볼 수 없습니다 — 비우면 지금 시각으로 적습니다.");
  const parsed = parseStartBuys(input.buys);
  errors.push(...parsed.errors);
  if (cash !== null && cash > 0 && parsed.errors.length === 0) {
    const total = startBuysTotal(parsed.buys);
    if (total > cash) {
      errors.push(`시작 매수 합(${formatWon(total)})이 시작 현금(${formatWon(cash)})보다 큽니다 — 현금이 음수가 되는 장부는 받지 않습니다.`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: { cash: cash as number, ...(startedAt ? { startedAt } : {}), buys: parsed.buys },
  };
}

/** 행 추가·고치기 창의 입력(모두 글자 — 검사는 buildLedgerRequest). */
export interface IsaLedgerForm {
  kind: IsaLedgerKind;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fee: string;
  tax: string;
  /** datetime-local 값(서울 시각) — 비우면 서버가 지금으로. */
  at: string;
  note: string;
}

/** 종류마다 쓰는 칸 — 매수·매도는 종목·수량·체결가·비용, 조정은 종목·수량(음수 가능), 입출금은 금액. */
export function ledgerFields(kind: IsaLedgerKind): { symbol: boolean; quantity: boolean; price: boolean; amount: boolean; costs: boolean } {
  const trade = kind === "BUY" || kind === "SELL";
  return {
    symbol: trade || kind === "ADJUST",
    quantity: trade || kind === "ADJUST",
    price: trade,
    amount: kind === "DEPOSIT" || kind === "WITHDRAW",
    costs: trade,
  };
}

/** 빈 입력(행 추가 — 기본 매수). */
export function emptyLedgerForm(kind: IsaLedgerKind = "BUY"): IsaLedgerForm {
  return { kind, symbol: "", quantity: "", price: "", amount: "", fee: "", tax: "", at: "", note: "" };
}

const KINDS = new Set<string>(LEDGER_KINDS.map((entry) => entry.kind));

/** 숫자를 입력칸 글자로(모르면 빈 칸). */
function inputText(value: unknown): string {
  const number = toNumber(value);
  return number === null ? "" : String(number);
}

/** 장부 행 → 고치기 창 입력. 모르는 종류는 매수로 두지 않고 null(고칠 수 없음 — 지우기만). */
export function ledgerFormFromRow(row: IsaLedgerRow): IsaLedgerForm | null {
  if (!KINDS.has(row.kind)) {
    return null;
  }
  return {
    kind: row.kind as IsaLedgerKind,
    symbol: row.symbol ?? "",
    quantity: inputText(row.quantity),
    price: inputText(row.price),
    amount: inputText(row.amount),
    fee: inputText(row.fee),
    tax: inputText(row.tax),
    at: kstInputFromIso(row.at),
    note: row.note ?? "",
  };
}

/**
 * 지시 → 체결 고치기 창 입력. 그 지시로 적힌 장부 행이 있으면 그 행을 고치고(같은 id), 없으면 지시의 방향·종목·수량으로 새 행을 채웁니다
 * — 체결가는 비워 둡니다(실제 체결가를 적게 — 지시 기준가는 창에 참고로만 보임).
 */
export function ledgerFormFromInstruction(item: IsaInstructionItem, row: IsaLedgerRow | null): IsaLedgerForm {
  const fromRow = row ? ledgerFormFromRow(row) : null;
  if (fromRow) {
    return fromRow;
  }
  const kind: IsaLedgerKind = item.side === "SELL" ? "SELL" : "BUY";
  return { ...emptyLedgerForm(kind), symbol: item.symbol, quantity: inputText(item.quantity) };
}

/**
 * 행 추가·고치기 입력 → POST /api/manual/isa/ledger 본문. 종류에 쓰는 칸만 싣고(ledgerFields), 매수·매도의 수수료·세금은 비우면 0,
 * 고치기(`id`)에서는 메모를 늘 싣습니다(지운 메모가 남지 않게). 현금·보유가 음수가 되는지는 서버가 봅니다(`ledger-invalid`).
 *
 * <p>`originalAt`(고치는 행의 시각 원문)이 있고 시각 칸이 그 원문을 분까지 옮긴 값 그대로면(사용자가 시각을 바꾸지 않음) 원문을 그대로 싣습니다
 * — 입력칸은 분까지라, 초·소수초가 있는 행(시작 시각을 비운 시작 매수 등)을 고치면 같은 순간의 시작 입금보다 앞으로 옮겨져 거절되지 않게.
 */
export function buildLedgerRequest(
  form: IsaLedgerForm,
  context: { id?: number | null; instructionId?: number | null; originalAt?: string | null } = {},
): Checked<IsaLedgerRequest> {
  const errors: string[] = [];
  const fields = ledgerFields(form.kind);
  const body: IsaLedgerRequest = { kind: form.kind };
  if (typeof context.id === "number") body.id = context.id;
  if (typeof context.instructionId === "number") body.instructionId = context.instructionId;

  if (fields.symbol) {
    const symbol = form.symbol.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) errors.push("종목 코드는 여섯 자리입니다(예: 005930).");
    else body.symbol = symbol;
  }
  if (fields.quantity) {
    const adjust = form.kind === "ADJUST";
    const quantity = parseDecimal(form.quantity, { maxDecimals: QUANTITY_DECIMALS, allowNegative: adjust });
    if (quantity === null || quantity === 0 || (!adjust && quantity < 0)) {
      errors.push(adjust ? "조정 수량은 0이 아닌 수입니다(줄면 음수)." : "수량은 0보다 큰 수입니다.");
    } else {
      body.quantity = quantity;
    }
  }
  if (fields.price) {
    const price = parseDecimal(form.price, { maxDecimals: PRICE_DECIMALS });
    if (price === null || price <= 0) errors.push("체결가는 0보다 큰 원 단위 가격입니다.");
    else body.price = price;
  }
  if (fields.amount) {
    const amount = parseDecimal(form.amount, { maxDecimals: AMOUNT_DECIMALS });
    if (amount === null || amount <= 0) errors.push("금액은 0보다 큰 원 단위 금액입니다.");
    else body.amount = amount;
  }
  if (fields.costs) {
    for (const [key, label] of [["fee", "수수료"], ["tax", "세금"]] as const) {
      const text = form[key].trim();
      const value = text === "" ? 0 : parseDecimal(text, { maxDecimals: AMOUNT_DECIMALS });
      if (value === null) errors.push(`${label}는 0 이상의 원 단위 금액입니다(비우면 0).`);
      else body[key] = value;
    }
  }
  const original = typeof context.originalAt === "string" ? context.originalAt.trim() : "";
  const unchanged = original !== "" && form.at.trim() !== "" && form.at.trim() === kstInputFromIso(original);
  const at = unchanged ? original : isoFromKstInput(form.at);
  if (at === null) errors.push("시각을 알아볼 수 없습니다 — 비우면 지금 시각으로 적습니다.");
  else if (at) body.at = at;
  const note = form.note.trim();
  if (note !== "" || typeof context.id === "number") body.note = note;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, body };
}

// ---------------------------------------------------------------- 서버 오류

/** 서버 오류 코드(명세 §5 — 400 invalid-request·ledger-invalid, 404 not-found, 409 already-started·not-started·already-recorded). */
export const ISA_ERROR_CODES = ["invalid-request", "ledger-invalid", "not-found", "already-started", "not-started", "already-recorded"] as const;

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
    case "ledger-invalid":
      return `이 행을 적으면 현금이나 보유 수량이 음수가 됩니다 — 수량·가격·금액을 확인하세요.${detail ? ` (${detail})` : ""}`;
    case "not-found":
      return "그 행이나 지시를 찾지 못했습니다 — 그사이 지워졌을 수 있어 장부를 다시 읽었습니다.";
    case "already-started":
      return "이미 시작한 계좌입니다 — 시작은 한 번만 됩니다. 장부를 다시 읽었습니다.";
    case "not-started":
      return "아직 시작하지 않은 계좌입니다 — 먼저 '시작'으로 시작 현금과 시작 매수를 적으세요.";
    case "already-recorded":
      return "이 지시에는 이미 직접 적은 체결 행이 있습니다 — 장부를 다시 읽었습니다. 창을 닫고 그 지시의 '체결 고치기'로 그 행을 고치세요.";
    default:
      return detail ?? "요청을 처리하지 못했습니다.";
  }
}

/** 이 오류 뒤에 장부를 다시 읽어야 하는가(화면이 서버와 어긋났다는 뜻 — 없는 행·이미 시작·시작 전·이미 적힌 지시). */
export function isaErrorNeedsReload(code: IsaErrorCode | null): boolean {
  return code === "not-found" || code === "already-started" || code === "not-started" || code === "already-recorded";
}
