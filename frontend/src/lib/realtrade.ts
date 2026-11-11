/**
 * 실제 매매(토스증권 실제 계좌가 모의 한국 책을 따라 하기 — ADR 0028, docs/specs/2026-11-06-real-trade-mirror.md §8)의 표기·판단 —
 * React를 모르는 순수 함수(ADR 0004).
 *
 * 이 파일은 lib/format과 응답 계약 lib/types/realtrade만 가져옵니다. 모의·홈·실제 계좌 조회(brokerage) 모듈과 서로 가져오지 않습니다
 * (components/screens/realtrade/__tests__/realtradeBoundary.test.ts). 숫자는 백엔드가 보낸 값 그대로 찍고, 화면이 계산하는 것은 기준 대비 손익
 * (지금 값 − 기준)과 손실 멈춤선뿐입니다(`realTradePnl` — 기준 상한 없는 총액 baselineTotal이 오면 총액 기준, 없으면 운용 평가액 기준).
 * 모르는 값은 "—"이고 0으로 채우지 않습니다.
 */
import { EMPTY, formatKstSeconds, formatNumber, formatSigned } from "./format";
import type {
  RealTradeEvent,
  RealTradeLimits,
  RealTradeOrderRow,
  RealTradePreflight,
  RealTradePreviewSkipped,
  RealTradeServerEnabled,
  RealTradeStatusResponse,
  RealTradeWindow,
} from "./types/realtrade";

/** 카드의 출처 한 줄. */
export const REAL_TRADE_SOURCE = "토스증권 Open API(실제 계좌 주문·조회) · 이 대시보드의 실제 매매 기록";

/** 켜기 창의 세 가지 모양 — 켜기·설정 바꾸기·멈춤 해제(모두 확인 글자 + 운영자 비밀번호). */
export type RealTradeDialogMode = "enable" | "update" | "resume";

/** 모양마다 운영자가 그대로 쳐야 하는 확인 글자(명세 §7.2). 화면은 친 글자를 그대로 보내고 서버가 다시 검사합니다. */
export const CONFIRM_TEXT: Readonly<Record<RealTradeDialogMode, string>> = {
  enable: "실제 매매 켜기",
  update: "설정 바꾸기",
  resume: "멈춤 해제",
};

/** 창 제목·확인 단추 글. */
export const DIALOG_TITLE: Readonly<Record<RealTradeDialogMode, string>> = {
  enable: "실제 매매 켜기",
  update: "실제 매매 설정 바꾸기",
  resume: "실제 매매 멈춤 해제",
};

/** 따라 할 수 있는 책 셋(명세 §0) — 이름은 상태 응답의 책 목록보다 이 표가 먼저입니다(사용자가 고른 이름 그대로). */
export const SOURCE_BOOKS: readonly { code: string; label: string }[] = [
  { code: "kr_rules", label: "규칙 계좌" },
  { code: "kr_claude", label: "Claude 계좌1" },
  { code: "kr_claude2", label: "Claude 계좌2" },
];

/** 켜기 창의 기본 방식 — 규칙 계좌(사용자 결정 2026-11-06: 처음에 Claude 계좌2로 정했다가 같은 날 규칙 계좌로 되돌림). */
export const DEFAULT_SOURCE_BOOK = "kr_rules";

/** 손실 한도(%) — 기본 15, 1~50(DB 검사와 같음), 소수 둘째 자리까지. */
export const LOSS_LIMIT = { min: 1, max: 50, default: 15 } as const;

/** 켜기 창 경고(명세 §8 문구 그대로). */
export const ENABLE_WARNINGS: readonly string[] = [
  "원화 자산 전부를 운용합니다 — 따라 하는 모의 계좌에 없는 국내 주식은 다음 맞추기(보통 개장 10분 뒤 09:10, 시가 맞추기 날은 08:50)에서 팔립니다",
  "켠 동안 앱에서 국내 주식을 직접 사고팔지 마세요",
  "모의와 달리 실제 돈이 움직입니다",
];

/** 켜기 전 점검표(명세 §8 · ADR 0028 운영) — 모두 확인해야 켤 수 있습니다. */
export const PREFLIGHT_CHECKLIST: readonly string[] = [
  "토스증권 앱의 투자자 지시 거래소를 '통합'으로 두었습니다",
  "미수·신용 거래를 껐습니다",
  "토스증권의 위험 고지와 주문 사전 요건을 확인했습니다",
  "운영 서버 밖(로컬 등)에 같은 토스 키를 두지 않았습니다",
];

/** 끄기를 누른 뒤의 안내(명세 §8). */
export const DISABLE_SENT_TEXT = "새 주문 멈춤 — 이 기능의 미체결 주문 취소 중";
export const DISABLE_DONE_TEXT = "꺼졌습니다 — 새 주문 없음, 이 기능의 미체결 정리 끝(보유는 팔지 않음)";
/**
 * 끄기가 실패했거나 정기 작업이 멈췄을 때의 비상 순서(docs/DEVELOPMENT.md §7 '비상 끄기' — 앞 단계가 안 될 때만 다음으로). 셋째 단계는 수집기만 다시
 * 만듭니다 — deploy.sh는 코드를 받고 다시 빌드해 느리고, 켜진 채 거래 창이면 배포를 거부합니다(SEC-1).
 */
export const EMERGENCY_STEPS =
  "비상 순서: 화면 끄기(다시 누르기) → 운영 서버 셸에서 끄기 한 줄(POST /api/realtrade/disable) → 서버 .env의 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만듦(docker compose up -d --no-deps --no-build collector — deploy.sh 아님, docs/DEVELOPMENT.md §7 비상 끄기) → 토스증권 앱에서 미체결 취소";

/** 이 기능이 미체결을 취소할 수 없을 때(`cancelBlocked`)의 위험 배너 글. */
export const CANCEL_BLOCKED_TEXT =
  "운영 서버의 매매 스위치가 꺼져 있어(또는 확인되지 않아) 이 기능이 미체결을 취소할 수 없습니다 — 토스증권 앱에서 직접 취소하세요.";
/** 끄기를 보냈지만 이 기능이 미체결을 취소할 수 없을 때의 안내(DISABLE_SENT_TEXT·DISABLE_DONE_TEXT 대신 — 취소한다고 단정하지 않음). */
export const DISABLE_SENT_BLOCKED_TEXT = "끄기를 받았습니다 — 새 주문 멈춤. 미체결은 이 기능이 취소하지 못하니 아래 안내대로 토스증권 앱에서 직접 취소하세요.";

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

/** 정수 수량(국내 주식은 정수 주). 모르면 "—". */
export function formatShares(value: unknown): string {
  const number = toNumber(value);
  return number === null ? EMPTY : formatNumber(number, Number.isInteger(number) ? 0 : 2);
}

/** 받은 글자의 이름표 — 모르는 값은 받은 글자 그대로(지어내지 않음), 없으면 "—". */
function labelOf(table: Readonly<Record<string, string>>, code: string | null | undefined): string {
  if (typeof code !== "string" || code.trim() === "") {
    return EMPTY;
  }
  return table[code] ?? code;
}

const BOOK_STATUS: Readonly<Record<string, string>> = { NOT_STARTED: "시작 전", ACTIVE: "운용 중", PAUSED: "일시정지" };

/** 모의 책 상태(시작 전·운용 중·일시정지). */
export function bookStatusLabel(status: string | null | undefined): string {
  return labelOf(BOOK_STATUS, status);
}

/** 책 코드 → 이름(규칙 계좌·Claude 계좌1·Claude 계좌2). 표에 없으면 서버 이름, 그것도 없으면 코드. */
export function sourceBookLabel(code: string | null | undefined, serverLabel?: string | null): string {
  if (typeof code !== "string" || code === "") {
    return EMPTY;
  }
  return SOURCE_BOOKS.find((book) => book.code === code)?.label ?? (serverLabel || code);
}

const HALT_REASON: Readonly<Record<string, string>> = {
  "unknown-order": "주문 결과를 모름",
  "idempotency-conflict": "멱등 키 충돌",
  "token-contention": "토스 토큰 경합",
  "repeated-error": "같은 오류 반복",
  turnover: "회전율 60% 초과",
  "book-changed": "따라 하는 계좌가 바뀜",
  "book-not-active": "따라 하는 계좌가 운용 중이 아님",
  "close-auction-mismatch": "종가 체결 시각 이상",
  "unknown-broker-status": "모르는 주문 상태",
  restored: "DB 복원 직후",
  "collector-disabled": "수집기 매매 스위치가 꺼져 멈춤 — 다시 켜려면 멈춤 해제",
};

/** 이상 멈춤 사유(명세 §7.3) — 이름표와 코드를 함께("주문 결과를 모름(unknown-order)"). 모르는 코드는 코드 그대로. */
export function haltReasonLabel(code: string | null | undefined): string {
  if (typeof code !== "string" || code.trim() === "") {
    return "사유 모름";
  }
  const label = HALT_REASON[code];
  return label ? `${label}(${code})` : code;
}

/**
 * 백엔드가 수집기 매매 스위치 상태를 읽지 못했을 때 싣는 사유 코드(RT3-UI-1) — 이때 `serverEnabled.collector`는 null(모름)입니다. 꺼짐이 아니라 모름이라
 * 화면은 '서버에서 꺼짐'으로 그리지 않습니다. collector 칸이 null이 아니어도 이 사유가 오면 수집기를 모름으로 봅니다(꺼짐으로 단정하지 않음).
 */
export const SERVER_STATUS_UNREADABLE = "status-unreadable";

/** 서버 스위치를 모를 때의 칩·문구(RT3-UI-1) — 상태 읽기는 15초마다 다시 합니다. */
export const SERVER_UNKNOWN_TEXT = "서버 상태를 읽지 못함 — 다시 읽는 중";

const SERVER_REASON: Readonly<Record<string, string>> = {
  disabled: "수집기 매매 스위치 꺼짐",
  "account-disabled": "실제 계좌 조회 꺼짐",
  "no-service-token": "서비스 토큰 없음",
  "limits-invalid": "한도 설정이 올바르지 않음",
  [SERVER_STATUS_UNREADABLE]: "수집기 상태를 읽지 못함",
};

/** 서버 스위치 사유(수집기 코드) — 이름표(코드). 모르는 코드는 그대로. */
export function serverReasonLabel(code: string | null | undefined): string | null {
  if (typeof code !== "string" || code.trim() === "") {
    return null;
  }
  const label = SERVER_REASON[code];
  return label ? `${label}(${code})` : code;
}

/** 수집기 스위치 값 — 사유가 '상태를 읽지 못함'이면 받은 값과 관계없이 모름(null). */
function collectorSwitch(server: RealTradeServerEnabled | null | undefined): boolean | null {
  if (!server || server.reason === SERVER_STATUS_UNREADABLE) {
    return null;
  }
  return typeof server.collector === "boolean" ? server.collector : null;
}

/** 서버 두 스위치를 읽은 결과 — 둘 다 켜짐(on), 하나라도 꺼짐을 확인함(off), 그 밖(하나라도 모름 — 읽지 못함)은 unknown. */
export type ServerSwitchState = "on" | "off" | "unknown";

/**
 * 서버 두 스위치(수집기·백엔드)의 상태(RT3-UI-1). 하나라도 꺼짐(false)을 확인했으면 off, 둘 다 켜짐이면 on, 그 밖은 unknown입니다 — 수집기 상태를 읽지
 * 못한 것(collector null 또는 사유 `status-unreadable`)을 꺼짐으로 그리지 않으려고 나눕니다.
 */
export function serverSwitchState(status: Pick<RealTradeStatusResponse, "serverEnabled"> | null | undefined): ServerSwitchState {
  const server = status?.serverEnabled;
  const collector = collectorSwitch(server);
  const backend = typeof server?.backend === "boolean" ? server.backend : null;
  if (collector === false || backend === false) {
    return "off";
  }
  return collector === true && backend === true ? "on" : "unknown";
}

/** 서버 두 스위치가 모두 켜져 있는가(수집기·백엔드). 모르면 거짓(취소 불가 판단·켜기 막기는 모름을 켜짐으로 보지 않음). */
export function serverEnabled(status: Pick<RealTradeStatusResponse, "serverEnabled"> | null | undefined): boolean {
  return serverSwitchState(status) === "on";
}

/** 서버 스위치 한 줄("수집기 켜짐 · 백엔드 꺼짐 — 사유"). 수집기 상태를 읽지 못했으면 수집기는 '모름'. */
export function serverSwitchText(server: RealTradeServerEnabled | null | undefined): string {
  const one = (value: boolean | null | undefined) => (value === true ? "켜짐" : value === false ? "꺼짐" : "모름");
  const reason = serverReasonLabel(server?.reason);
  return `수집기 ${one(collectorSwitch(server))} · 백엔드 ${one(server?.backend)}${reason ? ` — ${reason}` : ""}`;
}

/**
 * 켜짐인데 서버 스위치를 모를 때의 경고 문구(RT3-UI-1) — '꺼져 있어 주문이 나가지 않습니다'라고 단정하지 않고, 읽지 못했고 다시 읽는 중이라고 적습니다.
 */
export function serverUnknownText(server: RealTradeServerEnabled | null | undefined): string {
  const reason = serverReasonLabel(server?.reason);
  return `${SERVER_UNKNOWN_TEXT}${reason ? `(${reason})` : ""} — 이번 읽기에서 운영 서버의 매매 스위치(수집기) 상태를 확인하지 못했을 뿐 꺼졌다는 뜻은 아닙니다. 계속되면 운영 서버의 수집기를 확인하세요.`;
}

/** 칩 톤 — components/ui/icons의 StatusTone과 같은 네 값(lib는 화면 모듈을 가져오지 않음). */
export type RealTradeTone = "ok" | "warn" | "danger" | "neutral";

/** 상태 칩 — 글과 톤(색은 늘 글과 함께). */
export interface RealTradeChip {
  label: string;
  tone: RealTradeTone;
}

/**
 * 상태 칩(명세 §8 — 꺼짐·켜짐·멈춤(사유)·끄는 중·서버에서 꺼짐). 끄는 중·멈춤은 서버 스위치보다 먼저(사람이 할 일이 있음),
 * 그다음 서버 스위치가 하나라도 꺼져 있으면 '서버에서 꺼짐'(화면 스위치가 켜져 있어도 주문이 나가지 않음), 켜짐에 매수 멈춤이면 함께 적습니다.
 * 서버 스위치를 모르면(수집기 상태를 읽지 못함 — RT3-UI-1) '서버에서 꺼짐'이 아니라 상태 뒤에 '서버 상태를 읽지 못함 — 다시 읽는 중'(경고)입니다.
 */
export function realTradeChip(
  status: Pick<RealTradeStatusResponse, "state" | "haltReason" | "buysPaused" | "serverEnabled"> | null | undefined,
): RealTradeChip {
  const state = status?.state;
  if (state === "STOPPING") {
    return { label: "끄는 중", tone: "warn" };
  }
  if (state === "HALTED") {
    return { label: `멈춤(${haltReasonLabel(status?.haltReason)})`, tone: "danger" };
  }
  const server = serverSwitchState(status);
  if (status && server === "off" && (state === "OFF" || state === "LIVE")) {
    return { label: "서버에서 꺼짐", tone: "neutral" };
  }
  if (state === "LIVE") {
    const base = status?.buysPaused === true ? "켜짐 · 매수 멈춤(손실 한도)" : "켜짐";
    if (server === "unknown") {
      return { label: `${base} · ${SERVER_UNKNOWN_TEXT}`, tone: "warn" };
    }
    return status?.buysPaused === true ? { label: base, tone: "warn" } : { label: base, tone: "ok" };
  }
  if (state === "OFF") {
    return server === "unknown" ? { label: `꺼짐 · ${SERVER_UNKNOWN_TEXT}`, tone: "warn" } : { label: "꺼짐", tone: "neutral" };
  }
  return { label: typeof state === "string" && state !== "" ? state : "상태 모름", tone: "warn" };
}

/**
 * 끄기 단추를 보이는가 — 켜짐·멈춤·끄는 중이거나, 상태를 모를 때(읽기 실패·다시 읽기 실패·읽을 수 없음·모르는 상태) 늘 보입니다.
 * 끄기는 어떤 상태에서도 서버가 받으므로(명세 §7.2) 모를 때 보이는 쪽이 안전합니다. 꺼짐을 확실히 읽었을 때만 숨깁니다.
 */
export function showDisable(status: Pick<RealTradeStatusResponse, "available" | "state"> | null | undefined, readFailed: boolean): boolean {
  if (readFailed || !status || status.available !== true) {
    return true;
  }
  return status.state !== "OFF";
}

/** 켜기 단추를 누를 수 있는가와, 누를 수 없으면 그 이유(단추 옆 글). */
export function enableBlock(
  status: Pick<RealTradeStatusResponse, "available" | "supported" | "state" | "serverEnabled"> | null | undefined,
): string | null {
  if (!status || status.available !== true) {
    return "상태를 읽지 못해 켤 수 없습니다";
  }
  if (status.supported !== true) {
    return "이 시장은 준비 중입니다";
  }
  if (status.state !== "OFF") {
    return "꺼져 있을 때만 켤 수 있습니다";
  }
  const server = serverSwitchState(status);
  if (server === "unknown") {
    return "서버 스위치 상태를 읽지 못해 켤 수 없습니다 — 다시 읽는 중";
  }
  if (server !== "on") {
    return "서버 스위치가 꺼져 있어 켤 수 없습니다";
  }
  return null;
}

/**
 * 이 기능이 미체결을 취소할 수 없는가(SEC-5) — 서버 스위치(수집기·백엔드)가 하나라도 꺼졌거나 모르는데, 끄는 중·이상 멈춤이거나 이 기능의 미종료 토스 주문이
 * 있을 때. 백엔드 스위치가 꺼지면 정기 작업이 돌지 않고, 수집기 스위치가 꺼지면 취소도 보내지 않으므로 끄기·멈춤이 미체결을 정리하지 못합니다.
 * 미종료 건수(`unfinishedOrders`)가 없으면 상태만 봅니다. 서버 스위치가 켜져 있으면 거짓입니다(정기 작업이 취소를 보냄).
 */
export function cancelBlocked(
  status: Pick<RealTradeStatusResponse, "state" | "serverEnabled" | "unfinishedOrders"> | null | undefined,
): boolean {
  if (!status || serverEnabled(status)) {
    return false;
  }
  const unfinished = toNumber(status.unfinishedOrders);
  return status.state === "STOPPING" || status.state === "HALTED" || (unfinished !== null && unfinished > 0);
}

/**
 * 정기 작업이 멈췄다고 보는 간격 — 주기는 10초지만 한 주기 안에서 수집기 시간 초과(사전 조회 최대 40초 등)가 겹치면 1분을 넘을 수 있어
 * 3분 넘게 주기를 끝내지 못하면 멈춘 것으로 봅니다(RT-BE-6 — 오탐을 줄이려고 넉넉히).
 */
export const JOB_STALL_MS = 180_000;

/** ISO 시각 글자 → 밀리초. 시간대가 없으면 KST로 읽고(이 대시보드의 날짜·시각 기준), `[Asia/Seoul]` 꼬리는 떼며, 못 읽으면 null. */
function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim().replace(/\[.*\]$/, "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    return null;
  }
  const parsed = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+09:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 정기 작업이 멈춘 것 같은가(RT-BE-6·RT2-FE-2) — 켜짐·멈춤·끄는 중(정기 작업이 주문·취소·추적을 맡는 상태)인데 마지막으로 주기를 끝낸 시각
 * (`jobLastCycleAt`, 기동 뒤 아직 없으면 정기 작업이 시작된 시각 `jobStartedAt`)이 기준 시각보다 3분 넘게 앞일 때.
 *
 * <p>기준 시각은 같은 응답의 서버 시각(`serverTime`)이고, 없거나 못 읽을 때만 `receivedMs`(화면이 그 상태를 받은 시각)입니다 — 브라우저 시계가 어긋나도
 * 거짓 배너를 띄우거나 진짜 멈춤을 놓치지 않게, 그리고 상태 읽기가 실패하는 동안 오래된 값으로 멈춤을 짐작하지 않게(둘 다 그 응답의 시각).
 * 두 시각이 모두 null(백엔드 스위치·스케줄러 꺼짐)이거나 못 읽으면 판단하지 않습니다(거짓). 마지막 주기 칸이 있으면 그것만 봅니다(못 읽어도 기동 시각으로
 * 대신하지 않음 — 기동이 오래전이면 거짓 배너).
 */
export function jobStalled(
  status: Pick<RealTradeStatusResponse, "state" | "jobLastCycleAt" | "jobStartedAt" | "serverTime"> | null | undefined,
  receivedMs: number,
): boolean {
  if (!status || !(status.state === "LIVE" || status.state === "HALTED" || status.state === "STOPPING")) {
    return false;
  }
  const at = instantMs(status.jobLastCycleAt ?? status.jobStartedAt);
  const reference = instantMs(status.serverTime) ?? receivedMs;
  return at !== null && reference - at > JOB_STALL_MS;
}

/**
 * 멈춤 배너의 마지막 주기 글 — 주기를 끝낸 적이 있으면 "마지막 주기 HH:mm:ss", 기동 뒤 한 번도 끝내지 못했으면 "기동 뒤 끝낸 주기 없음(기동 HH:mm:ss)".
 */
export function jobStallText(status: Pick<RealTradeStatusResponse, "jobLastCycleAt" | "jobStartedAt">): string {
  if (status.jobLastCycleAt != null) {
    return `마지막 주기 ${kstClock(status.jobLastCycleAt)}`;
  }
  return `기동 뒤 끝낸 주기 없음(기동 ${kstClock(status.jobStartedAt)})`;
}

/** 1 이상인 건수만 — 0·없음·못 읽음은 null. */
function positiveCount(value: unknown): number | null {
  const count = toNumber(value);
  return count !== null && count > 0 ? count : null;
}

/**
 * 취소를 정해진 횟수(5번) 보내고도 아직 살아 있는 이 기능의 미체결 수(`cancelGaveUpOrders`, RT2-FE-3) — 1건 이상일 때만 그 수, 아니면 null.
 * 상태와 관계없이 보입니다(정기 작업이 더는 취소를 보내지 않으므로 사람이 앱에서 취소해야 함).
 */
export function cancelGaveUpCount(status: Pick<RealTradeStatusResponse, "cancelGaveUpOrders"> | null | undefined): number | null {
  return positiveCount(status?.cancelGaveUpOrders);
}

/**
 * 꺼짐인데 보낸 결과를 모르는 주문 수(`unresolvedOrders`, RT2-FE-3) — 꺼짐이고 1건 이상일 때만 그 수, 아니면 null. 켜짐·멈춤·끄는 중에는 정기 작업이
 * 대조를 계속하므로(결과를 모르면 이상 멈춤) 이 경고를 띄우지 않습니다.
 */
export function unresolvedOffCount(status: Pick<RealTradeStatusResponse, "state" | "unresolvedOrders"> | null | undefined): number | null {
  return status?.state === "OFF" ? positiveCount(status.unresolvedOrders) : null;
}

/** 취소 포기 위험 문구(RT2-FE-3). */
export function cancelGaveUpText(count: number): string {
  return `취소를 5번 보냈지만 ${formatNumber(count, 0)}건이 아직 살아 있습니다 — 토스증권 앱에서 직접 취소하세요`;
}

/** 꺼졌지만 결과를 모르는 주문이 남았을 때의 경고 문구(RT2-FE-3 — DISABLE_DONE_TEXT의 '정리 끝' 대신). */
export function disableDoneUnresolvedText(count: number): string {
  return `꺼졌습니다 — 결과를 모르는 주문 ${formatNumber(count, 0)}건은 토스증권 앱에서 확인하세요`;
}

/** 끄기 뒤 안내 한 줄 — 종류(같은 내용의 칸 배너를 겹쳐 띄우지 않으려고)·문구·배너 톤. */
export interface DisableFeedback {
  kind: "gave-up" | "blocked" | "unresolved" | "done" | "sent";
  text: string;
  tone: "ok" | "info" | "warn" | "danger";
}

/**
 * 끄기를 보낸 뒤의 안내(명세 §8 · SEC-5 · RT2-FE-3) — 사람이 할 일이 있는 것부터: 취소를 포기한 미체결이 있으면 위험 문구(취소 중이라고 단정하지 않음),
 * 서버 스위치가 꺼져 이 기능이 취소할 수 없으면 앱에서 직접 취소 안내, 꺼짐인데 결과를 모르는 주문이 있으면 앱에서 확인 경고('정리 끝'이라고 단정하지 않음),
 * 그 밖에는 꺼짐이면 정리 끝, 아니면 취소 중.
 */
export function disableFeedback(
  status:
    | Pick<RealTradeStatusResponse, "state" | "serverEnabled" | "unfinishedOrders" | "cancelGaveUpOrders" | "unresolvedOrders">
    | null
    | undefined,
): DisableFeedback {
  const gaveUp = cancelGaveUpCount(status);
  if (gaveUp !== null) {
    return { kind: "gave-up", text: cancelGaveUpText(gaveUp), tone: "danger" };
  }
  if (cancelBlocked(status)) {
    return { kind: "blocked", text: DISABLE_SENT_BLOCKED_TEXT, tone: "warn" };
  }
  const unresolved = unresolvedOffCount(status);
  if (unresolved !== null) {
    return { kind: "unresolved", text: disableDoneUnresolvedText(unresolved), tone: "warn" };
  }
  return status?.state === "OFF"
    ? { kind: "done", text: DISABLE_DONE_TEXT, tone: "ok" }
    : { kind: "sent", text: DISABLE_SENT_TEXT, tone: "info" };
}

/**
 * 이 화면이 끄기를 보낸 표시(끄기 뒤 안내를 띄우는 동안) — 끄기 응답이 돌려준 설정 버전(없으면 null)과, 그 뒤 끄는 중·꺼짐 상태를 본 적이 있는가.
 */
export interface DisableSentMark {
  version: number | null;
  sawOff: boolean;
}

/**
 * 끄기 뒤 새로 받은 상태로 표시를 다음 값으로 — null이면 표시를 지웁니다(RT3-UI-3: 다른 기기·탭에서 다시 켰는데 '새 주문 멈춤 — 취소 중'이 남지 않게).
 *
 * <ul>
 *   <li>끄는 중·꺼짐 → 그대로 두고 '꺼짐 쪽을 봄'으로 적습니다(끄는 중 → 꺼짐도 설정 버전을 올리므로 버전만으로는 지우지 않음 — 정리 끝 안내가 보이게).</li>
 *   <li>켜짐·이상 멈춤 → 꺼짐 쪽을 이미 봤거나(다시 켜짐으로 돌아옴) 상태의 버전이 끄기 응답의 버전보다 크면(그 뒤 다른 곳에서 켬) 지웁니다.
 *       둘 다 아니면 끄기 직후 진행 중이던 읽기가 가져온 옛 켜짐이라 그대로 둡니다.</li>
 *   <li>그 밖(상태 없음·모르는 상태) → 그대로.</li>
 * </ul>
 */
export function nextDisableSentMark(
  mark: DisableSentMark | null,
  status: Pick<RealTradeStatusResponse, "state" | "version"> | null | undefined,
): DisableSentMark | null {
  if (!mark || !status) {
    return mark;
  }
  if (status.state === "STOPPING" || status.state === "OFF") {
    return mark.sawOff ? mark : { ...mark, sawOff: true };
  }
  if (status.state === "LIVE" || status.state === "HALTED") {
    const newer = typeof status.version === "number" && typeof mark.version === "number" && status.version > mark.version;
    return mark.sawOff || newer ? null : mark;
  }
  return mark;
}

/** 멈춤 해제를 보이는가 — 이상 멈춤이거나, 켜짐에 손실 한도로 매수가 멈췄을 때(명세 §7.2 resume). */
export function canResume(status: Pick<RealTradeStatusResponse, "state" | "buysPaused"> | null | undefined): boolean {
  return status?.state === "HALTED" || (status?.state === "LIVE" && status.buysPaused === true);
}

/** 설정 바꾸기를 보이는가 — 켜짐일 때만(명세 §1 `LIVE→LIVE`). */
export function canUpdate(status: Pick<RealTradeStatusResponse, "state"> | null | undefined): boolean {
  return status?.state === "LIVE";
}

/**
 * 손실 한도 입력 → 숫자. 1~50, 소수 둘째 자리까지만 받습니다(그 밖·빈 칸·숫자가 아님 → null).
 */
export function parseLossLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= LOSS_LIMIT.min && value <= LOSS_LIMIT.max ? value : null;
}

/** 손실 한도 숫자(단위 없이) — 정수면 "15", 소수면 둘째 자리까지("12.50"). */
export function lossLimitText(value: number): string {
  return formatNumber(value, Number.isInteger(value) ? 0 : 2);
}

/** 기준 대비 손익 — 금액(평가액 − 기준)과 비율(× 100 ÷ 기준). 둘 중 하나라도 모르거나 기준이 0 이하면 null. */
export function baselineDelta(equity: unknown, baseline: unknown): { amount: number | null; pct: number | null } {
  const e = toNumber(equity);
  const b = toNumber(baseline);
  if (e === null || b === null) {
    return { amount: null, pct: null };
  }
  return { amount: e - b, pct: b > 0 ? ((e - b) * 100) / b : null };
}

/** 손실 멈춤선 — 기준 × (1 − 한도%). 이 값 이하면 새 매수를 멈춥니다(명세 §7.3). 모르면 null. */
export function lossLine(baseline: unknown, lossLimitPct: unknown): number | null {
  const b = toNumber(baseline);
  const pct = toNumber(lossLimitPct);
  return b === null || pct === null ? null : b * (1 - pct / 100);
}

/** 기준 대비 손익과 손실 멈춤선(실제 매매 칸의 두 칸). */
export interface RealTradePnl {
  /** "total"이면 상한 없는 총액 기준(baselineTotal이 옴), "equity"면 운용 평가액 기준(예전 — baselineTotal 없음). */
  basis: "total" | "equity";
  /** 지금 값 − 기준(원). 둘 중 하나라도 모르면 null. */
  amount: number | null;
  /** amount × 100 ÷ 운용 기준 평가액(baselineEquity — 손실 한도 %와 같은 분모). 모르거나 기준이 0 이하면 null. */
  pct: number | null;
  /** 손실 멈춤선 — 지금 값이 이 값 이하면 새 매수를 멈춥니다. 모르면 null. */
  line: number | null;
  /** 지금 값 — total이면 상한 없는 총액(lastPreflight.total), equity면 운용 평가액(lastPreflight.equity). */
  now: number | null;
  /** 기준 값 — total이면 baselineTotal, equity면 baselineEquity. */
  base: number | null;
}

/**
 * '운용 평가액' 타일의 설명 줄 — 토스에서 읽은 시각(초까지)과, 그날 정규장 마감 뒤(휴장일 포함)에 읽은 값이면 '마지막 거래일 마감 뒤 값', 아니고 읽은 날이 오늘(KST — 서버 시각,
 * 없으면 지금)보다 이전이면 '이전 값'(2026-11-08 — 휴장일·토스 점검 중에도 마지막 값이 보이게 백엔드가 저장). 읽은 적이 없으면 그렇게 적습니다.
 */
export function preflightNote(
  preflight: Pick<RealTradePreflight, "fetchedAt" | "afterClose"> | null | undefined,
  serverTime?: string | null,
): string {
  if (!preflight?.fetchedAt) {
    return "아직 토스에서 읽은 적 없음";
  }
  const read = formatKstSeconds(preflight.fetchedAt);
  const base = `토스에서 읽은 시각 ${read}`;
  if (preflight.afterClose === true) {
    return `${base} · 마지막 거래일 마감 뒤 값`;
  }
  const readDay = /^\d{4}-\d{2}-\d{2}/.exec(read)?.[0];
  const today = /^\d{4}-\d{2}-\d{2}/.exec(formatKstSeconds(serverTime || new Date()))?.[0];
  return readDay && today && readDay < today ? `${base} · 이전 값` : base;
}

/**
 * 기준 대비 손익·손실 멈춤선. 상태에 기준 상한 없는 총액(`baselineTotal`, U0)이 오면 '지금 상한 없는 총액(U) − U0'으로 재고 멈춤선은
 * 'U0 − E0 × 한도%'(E0 = baselineEquity)입니다 — 계좌 총액이 운용 평가액 상한보다 커도 손실이 보이게(RT-BE-3, 백엔드 판정 (U − U0) ≤ −한도% × E0와 같음).
 * baselineTotal이 없거나 null이면 예전처럼 운용 평가액 − E0, 멈춤선 E0 × (1 − 한도%). 지금 총액을 모르면 운용 평가액으로 대신하지 않고 null입니다.
 */
export function realTradePnl(
  status: Pick<RealTradeStatusResponse, "baselineEquity" | "baselineTotal" | "lossLimitPct"> & {
    lastPreflight: Pick<RealTradePreflight, "equity" | "total"> | null | undefined;
  },
): RealTradePnl {
  const baseTotal = toNumber(status.baselineTotal);
  if (baseTotal === null) {
    const delta = baselineDelta(status.lastPreflight?.equity, status.baselineEquity);
    return {
      basis: "equity",
      amount: delta.amount,
      pct: delta.pct,
      line: lossLine(status.baselineEquity, status.lossLimitPct),
      now: toNumber(status.lastPreflight?.equity),
      base: toNumber(status.baselineEquity),
    };
  }
  const total = toNumber(status.lastPreflight?.total);
  const e0 = toNumber(status.baselineEquity);
  const limit = toNumber(status.lossLimitPct);
  const amount = total === null ? null : total - baseTotal;
  return {
    basis: "total",
    amount,
    pct: amount !== null && e0 !== null && e0 > 0 ? (amount * 100) / e0 : null,
    line: e0 === null || limit === null ? null : baseTotal - (e0 * limit) / 100,
    now: total,
    base: baseTotal,
  };
}

/** 서버 안전 상한 네 줄(이름표 · 값). 모르는 값은 "—". */
export function limitRows(limits: RealTradeLimits | null | undefined): { label: string; text: string }[] {
  const count = toNumber(limits?.maxOrdersPerDay);
  return [
    { label: "운용 평가액 상한", text: formatWon(limits?.maxEquityKrw) },
    { label: "1건 상한", text: formatWon(limits?.maxOrderKrw) },
    { label: "하루 매수 상한", text: formatWon(limits?.maxBuyKrwPerDay) },
    { label: "하루 주문 수 상한", text: count === null ? EMPTY : `${formatNumber(count, 0)}건` },
  ];
}

const PURPOSE: Readonly<Record<string, string>> = {
  SYNC: "시가 맞추기",
  SYNC_AT: "개장 10분 뒤 맞추기",
  SYNC_FOLLOWUP: "맞추기(시장가)",
  MIRROR: "장중 따라 하기",
  NEXT_CLOSE: "종가 따라 하기",
};

/**
 * 용도·창 종류(시가 맞추기·개장 10분 뒤 맞추기·맞추기 시장가·장중 따라 하기). 모르는 값은 원문. SYNC_FOLLOWUP은 시가 뒤 마무리와 개장 10분 뒤
 * 맞추기 날의 시장가 주문이 함께 쓰는 용도라 '맞추기(시장가)'로 적습니다(ADR 0033).
 */
export function purposeLabel(purpose: string | null | undefined): string {
  return labelOf(PURPOSE, purpose);
}

const SIDE: Readonly<Record<string, string>> = { BUY: "매수", SELL: "매도" };

/** 방향 — 매수·매도. */
export function sideLabel(side: string | null | undefined): string {
  return labelOf(SIDE, side);
}

const TIME_IN_FORCE: Readonly<Record<string, string>> = { OPG: "시가 단일가", DAY: "당일" };

/** 주문 조건 — 시가 단일가(OPG)·당일(DAY). */
export function timeInForceLabel(timeInForce: string | null | undefined): string {
  return labelOf(TIME_IN_FORCE, timeInForce);
}

const BROKER_STATUS: Readonly<Record<string, string>> = {
  PENDING: "체결 대기",
  PENDING_CANCEL: "취소 대기",
  PARTIAL_FILLED: "부분 체결",
  FILLED: "체결 완료",
  CANCELED: "취소 완료",
  REJECTED: "거부됨",
  CANCEL_REJECTED: "취소 거부",
  REPLACED: "정정됨",
};

const SEND_OUTCOME: Readonly<Record<string, string>> = {
  SENDING: "보내는 중",
  ACCEPTED: "접수",
  REJECTED: "거절",
  UNKNOWN: "결과 모름",
  NOT_SENT: "안 보냄",
};

/** 주문 상태 칸 — 토스 상태가 있으면 그것, 없으면 보낸 결과. 모르는 값은 원문. */
export function orderStatusText(row: Pick<RealTradeOrderRow, "brokerStatus" | "sendOutcome">): string {
  if (typeof row.brokerStatus === "string" && row.brokerStatus !== "") {
    return labelOf(BROKER_STATUS, row.brokerStatus);
  }
  return labelOf(SEND_OUTCOME, row.sendOutcome);
}

/** 주문 시각 칸 — 처음 보낸 시각, 없으면 행을 쓴 시각. */
export function orderTime(row: Pick<RealTradeOrderRow, "firstSentAt" | "createdAt">): string | null {
  return row.firstSentAt || row.createdAt || null;
}

/** 종목 칸 — "이름 코드" 또는 코드만. */
export function symbolText(symbol: string | null | undefined, name: string | null | undefined): string {
  if (!symbol) {
    return name || EMPTY;
  }
  return name ? `${name} ${symbol}` : symbol;
}

/**
 * 시각 글자 → 서울 시각 "HH:mm:ss"(초가 0이면 "HH:mm"). ISO(시간대 있음)는 서울 시각으로 바꾸고, "HH:mm[:ss]"는 그대로,
 * 알아볼 수 없으면 받은 글자 그대로(지어내지 않음). 없으면 "—".
 */
export function kstClock(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    return EMPTY;
  }
  const text = value.trim();
  const plain = /^(\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (plain) {
    return plain[2] && plain[2] !== "00" ? `${plain[1]}:${plain[2]}` : plain[1];
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})(\[.*\])?$/.test(text)) {
    const parsed = new Date(text.replace(/\[.*\]$/, ""));
    if (!Number.isNaN(parsed.getTime())) {
      try {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Seoul",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          })
            .formatToParts(parsed)
            .map((part) => [part.type, part.value]),
        );
        return parts.second && parts.second !== "00" ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
      } catch {
        return text;
      }
    }
  }
  return text;
}

/** 오늘 창 한 줄("시가 맞추기 08:50:30~08:58:30"). 글자 하나로 오면 그대로. */
export function windowText(window: RealTradeWindow | string | null | undefined): string {
  if (typeof window === "string") {
    return window.trim() === "" ? EMPTY : window;
  }
  if (!window) {
    return EMPTY;
  }
  const kind = window.kind || window.purpose || window.label || null;
  const name = kind ? purposeLabel(kind) : "창";
  return `${name} ${kstClock(window.start)}~${kstClock(window.end)}`;
}

/**
 * 켜기 창 예상 목록의 다음 맞추기 방식("개장 10분 뒤 맞추기 09:10 시장가"·"시가 맞추기(시가 단일가)") — 예상 응답의 `syncAt`으로(ADR 0033).
 * 시각을 읽지 못하면 시각 없이.
 */
export function previewTimingText(syncAt: string | null | undefined, session?: string | null): string {
  // 세션 날짜(YYYY-MM-DD)가 오면 앞에 적습니다 — 시각만으로는 오늘 맞추기인지 다음 거래일 맞추기인지 알 수 없습니다(QA-344).
  const day = typeof session === "string" && /^\d{4}-\d{2}-\d{2}$/.test(session.trim()) ? `${session.trim()} ` : "";
  if (typeof syncAt !== "string" || syncAt.trim() === "") {
    return `${day}시가 맞추기(시가 단일가)`;
  }
  const clock = kstClock(syncAt);
  return clock === EMPTY ? `${day}개장 10분 뒤 맞추기(시장가)` : `${day}개장 10분 뒤 맞추기 ${clock.slice(0, 5)} 시장가`;
}

const IMMEDIATE_VERB: Readonly<Record<RealTradeDialogMode, string>> = { enable: "켜면", update: "바꾸면", resume: "멈춤을 풀면" };

/**
 * 예상 목록의 맞추기 창이 지금 열려 있을 때의 안내(QA-344) — 응답의 `immediate`가 정확히 true일 때만, 아니면 null. 그 창 안에서 켜면 정기 작업이
 * 다음 주기에 오늘 묶음을 만들어 바로 보냅니다. 예상을 읽은 때와 확인을 누르는 때 사이에 창이 닫힐 수 있어 '창이 열려 있는 동안'이라고 적습니다.
 */
export function previewImmediateText(immediate: unknown, mode: RealTradeDialogMode): string | null {
  if (immediate !== true) {
    return null;
  }
  return `지금 맞추기 창이 열려 있습니다 — 창이 열려 있는 동안 ${IMMEDIATE_VERB[mode]} 이 목록이 바로 주문됩니다(실제 주문은 그때 보유·가격으로 다시 계산).`;
}

const EVENT_KIND: Readonly<Record<string, string>> = {
  ENABLE: "켜기",
  DISABLE: "끄기",
  STOPPED: "꺼짐",
  UPDATE: "설정 바꾸기",
  RESUME: "멈춤 해제",
  HALT: "이상 멈춤",
  BUYS_PAUSED: "매수 멈춤(손실 한도)",
  SKIP_DAY: "오늘 쉼",
  WINDOW_SUMMARY: "창 요약",
  PASSWORD_FAILED: "비밀번호 틀림",
  RESTORED: "복원 뒤 멈춤",
  CANCEL_GAVE_UP: "취소 못 함(토스증권 앱에서 직접 취소)",
  SKIPPED: "건너뜀",
  STOP_SELL: "스탑 매도",
  RESTRICTED: "매매 제한으로 대기(VI·서킷브레이커 등)",
  // 개장이 가깝도록 토스 장 운영 정보·수집기 매매 상태를 받지 못함(QA-342 — 하루 한 번, 사유 코드 calendar-unavailable·status-unavailable)
  UNAVAILABLE: "준비 안 됨(주문을 내지 못하는 중)",
};

/** 이벤트 종류 이름표. 모르는 값은 원문. */
export function eventKindLabel(kind: string | null | undefined): string {
  return labelOf(EVENT_KIND, kind);
}

/** 창 요약 건수(명세 §7.3 — 접수·체결·놓침·건너뜀·막힘·미룸) — detail 키와 이름표. */
const EVENT_COUNTS: readonly [string, string][] = [
  // 스탑 매도(STOP_SELL — ADR 0033) 보냄·막힘·놓침
  ["sent", "보냄"],
  ["accepted", "접수"],
  ["filled", "체결"],
  ["missed", "놓침"],
  ["skipped", "건너뜀"],
  ["blocked", "막힘"],
  ["deferred", "미룸"],
  // 창 요약의 결과 모름(전송 결과를 아직 모르는 주문 — 재전송·대조 중)
  ["unknown", "결과 모름"],
  // 꺼짐(STOPPED) 정리 결과 — 취소로 끝남·체결로 끝남·그 밖·확인 필요
  ["canceled", "취소로 끝남"],
  ["other", "그 밖"],
  ["unresolved", "확인 필요"],
  // 취소 못 함(CANCEL_GAVE_UP)
  ["count", "건수"],
];

/**
 * 이벤트 detail → 한 줄("시가 맞추기 · 사유 unknown-order · 접수 5 · 체결 5"). 용도·사유 코드·건수·책만 적고 그 밖의 칸은 적지 않습니다.
 * 이상 멈춤(HALT) 이벤트의 사유는 멈춤 사유 이름표와 코드로 적습니다("사유 수집기 매매 스위치가 꺼져 멈춤 — 다시 켜려면 멈춤 해제(collector-disabled)").
 * 아무것도 없으면 null.
 */
export function eventDetailText(detail: RealTradeEvent["detail"], kind?: RealTradeEvent["kind"]): string | null {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const parts: string[] = [];
  // 글자 "null"은 값 없음으로 봅니다 — 예전 멈춤 해제 이벤트는 사유가 없을 때 그 글자를 저장했습니다(QA-346, 지금은 칸을 넣지 않음).
  const text = (key: string) => {
    const value = detail[key];
    return typeof value === "string" && value.trim() !== "" && value !== "null" ? value : null;
  };
  const purpose = text("purpose") ?? text("window");
  if (purpose) parts.push(purposeLabel(purpose));
  const book = text("sourceBook");
  if (book) parts.push(sourceBookLabel(book));
  const reason = text("reason") ?? text("code") ?? text("haltReason") ?? text("skipReason");
  if (reason) parts.push(`사유 ${kind === "HALT" ? haltReasonLabel(reason) : reason}`);
  for (const [key, label] of EVENT_COUNTS) {
    const count = toNumber(detail[key]);
    if (count !== null) parts.push(`${label} ${formatNumber(count, 0)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * 종목 건너뜀 사유 이름표 — 열쇠는 백엔드가 보내는 코드 그대로입니다(RealTradePlanner의 SKIP_*, RealTradeJob의 건너뜀 코드). 백엔드에 코드가 늘면
 * `__tests__/realtradeCodes.test.ts`가 Java 소스를 읽어 이름표를 요구합니다(QA-346 — 예전에는 열쇠가 `fractional`이라 `fractional-part`에 닿지 않았음).
 */
const SKIP_REASON: Readonly<Record<string, string>> = {
  "opposite-pending": "반대 방향 미체결 있음",
  "own-pending": "이 기능의 주문이 진행 중",
  "pending-unknown": "미체결 잔량을 모름",
  "price-missing": "가격을 모름",
  "pending-stop": "따라 하는 계좌의 오늘 대기 스탑 종목 — 매수 안 함",
  "deferred-cash": "매수 가능 금액 부족으로 미룸",
  capped: "1건 상한까지만",
  "timing-unsupported": "모르는 체결 시점",
  "fractional-part": "소수 부분은 팔 수 없음",
  "not-sellable": "팔 수 있는 수량 없음",
  "deferred-daily-cap": "하루 한도로 미룸",
  "sellable-unknown": "팔 수 있는 수량을 못 받음",
  "buys-paused": "매수 멈춤 중(손실 한도)",
  "weight-unknown": "목표 비중을 모름",
  "symbol-unsupported": "지원하지 않는 종목 코드",
  "batch-stale": "방식이 바뀌어 오늘 묶음은 쓰지 않음",
  "paper-cancelled-after-claim": "따라 한 뒤 모의 주문이 취소됨(다음 맞추기가 되돌림)",
};

/** 예상 목록 경고 이름표 — 열쇠는 백엔드(RealTradeService.preview)가 보내는 경고 코드. */
const PREVIEW_WARNING: Readonly<Record<string, string>> = {
  "targets-incomplete": "모의 계좌의 대기 주문 가운데 가격을 몰라 목표에 넣지 못한 것이 있음",
  "book-not-active": "고른 모의 계좌가 운용 중이 아님 — 켜면 정기 작업이 바로 멈춤",
  "turnover-over-60": "회전율이 60%를 넘음 — 켜기·방식 바꾸기·이상 멈춤 해제 뒤 첫 맞추기가 아니면 이상 멈춤",
  "equity-capped": "운용 평가액이 서버 안전 상한을 넘어 상한까지만 운용",
};

/** 예상 목록 경고 한 줄 — 아는 코드는 "이름표(코드)", 모르는 글은 받은 그대로(QA-346 — 예전에는 코드를 그대로 그렸음). */
export function warningText(warning: string | null | undefined): string {
  if (typeof warning !== "string" || warning.trim() === "") {
    return EMPTY;
  }
  const label = PREVIEW_WARNING[warning];
  return label ? `${label}(${warning})` : warning;
}

/** 예상 목록에서 건너뛴 한 줄("삼성전자 005930 — 반대 방향 미체결 있음(opposite-pending)"). 글자 하나로 오면 그대로. */
export function skippedText(item: RealTradePreviewSkipped | string | null | undefined): string {
  if (typeof item === "string") {
    return item.trim() === "" ? EMPTY : item;
  }
  if (!item) {
    return EMPTY;
  }
  const who = symbolText(item.symbol, item.name);
  const reason = typeof item.reason === "string" && item.reason !== "" ? item.reason : null;
  if (!reason) {
    return who;
  }
  const label = SKIP_REASON[reason];
  return `${who} — ${label ? `${label}(${reason})` : reason}`;
}

/** 켜기류 서버 오류 코드(명세 §7.2 · docs/API.md — 409는 version-conflict·invalid-state·server-disabled·book-changed·not-ready). */
export const REAL_TRADE_ERROR_CODES = [
  "confirm-mismatch",
  "password-invalid",
  "password-locked",
  "version-conflict",
  "not-supported",
  "server-disabled",
  "book-changed",
  "invalid-state",
  "not-ready",
] as const;

export type RealTradeErrorCode = (typeof REAL_TRADE_ERROR_CODES)[number];

/**
 * 요청 오류 → 서버 오류 코드. lib/api의 ApiError는 서버 본문의 `error`를 `code` 칸으로 나릅니다 — 그 칸이 있으면 그것만 정확히 비교하고(아는 코드가
 * 아니면 null), 그 칸이 없을 때만 문구(message) 안의 코드 글자를 찾으며, 그래도 없으면 409를 버전 충돌로 어림합니다(본문이 JSON이 아닌 409).
 * 409는 버전 충돌만이 아니라 invalid-state·book-changed·not-ready에도 쓰이므로(SEC-3), 코드가 있는 409를 버전 충돌로 바꾸지 않습니다.
 * 모르면 null — 화면은 서버 문구를 그대로 보입니다.
 */
export function realTradeErrorCode(error: unknown): RealTradeErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const { code, message, status } = error as { code?: unknown; message?: unknown; status?: unknown };
  if (typeof code === "string" && code !== "") {
    return REAL_TRADE_ERROR_CODES.find((known) => known === code) ?? null;
  }
  if (typeof message === "string") {
    const found = REAL_TRADE_ERROR_CODES.find((known) => message.includes(known));
    if (found) return found;
  }
  return status === 409 ? "version-conflict" : null;
}

/**
 * 끄기 POST의 시간 한도(QA-345) — 끄기는 DB 상태만 바꾸는 가벼운 요청이고 멱등이라(다시 눌러도 안전) 짧게 둡니다. 예전에는 한도가 없어 응답이 오지
 * 않으면 끄기 단추가 '끄는 중…'으로 잠기고 비상 순서 안내도 뜨지 않았습니다.
 */
export const DISABLE_TIMEOUT_MS = 20_000;
/**
 * 켜기·바꾸기·해제 POST의 시간 한도(QA-345) — 백엔드가 그 요청 안에서 수집기를 부르는 상한의 합(매매 상태·사전 조회·미체결 목록 —
 * `CollectorTradeClient`의 연결·읽기 시간 초과)을 덮게 둡니다. 넘기면 창이 '보내는 중'에서 풀려 닫을 수 있고 상태를 다시 읽습니다.
 */
export const ACTION_TIMEOUT_MS = 90_000;

/** 시간 한도를 넘겨 끊긴 요청의 오류인가(lib/api `NetworkError.timedOut`) — 서버가 요청을 처리했을 수 있습니다. */
export function requestTimedOut(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { timedOut?: unknown }).timedOut === true;
}

/** 켜기류 요청이 시간 한도를 넘겼을 때의 문구 — 처리 여부를 모르므로 상태 확인을 안내합니다(같은 요청을 바로 다시 보내라고 하지 않음). */
export function actionTimeoutText(): string {
  return `${ACTION_TIMEOUT_MS / 1000}초 안에 응답을 받지 못했습니다 — 요청이 처리됐을 수 있으니 창을 닫고 상태를 확인하세요(상태는 다시 읽는 중입니다).`;
}

/** 오류 코드별 문구. */
export function realTradeErrorText(code: RealTradeErrorCode | null, mode: RealTradeDialogMode, fallback: string | null): string {
  switch (code) {
    case "confirm-mismatch":
      return `확인 글자가 다릅니다 — '${CONFIRM_TEXT[mode]}'를 그대로 입력하세요.`;
    case "password-invalid":
      return "비밀번호가 틀렸습니다. 연속 5번 틀리면 30분 동안 켜기·바꾸기·해제가 잠깁니다.";
    case "password-locked":
      return "비밀번호를 연속으로 틀려 30분 동안 켜기·바꾸기·해제가 잠겼습니다. 끄기는 그대로 됩니다.";
    case "version-conflict":
      return "그사이 다른 곳에서 실제 매매 설정이 바뀌었습니다. 상태를 다시 읽었으니 확인하고 다시 시도하세요.";
    case "not-supported":
      return "이 시장의 실제 매매는 아직 지원하지 않습니다.";
    case "server-disabled":
      return "운영 서버의 매매 스위치(수집기·백엔드)가 꺼져 있어 켤 수 없습니다.";
    case "book-changed":
      return "따라 하던 계좌가 리셋·재출발했습니다 — 실제 매매를 끄고 다시 켜서 예상 목록을 확인하세요.";
    case "invalid-state":
      return fallback && fallback.trim() !== "" ? fallback : "지금 상태에서는 할 수 없는 요청입니다 — 상태를 확인하세요.";
    case "not-ready":
      return fallback && fallback.trim() !== "" ? fallback : "실제 매매가 아직 준비되지 않았습니다(서버 준비 전).";
    default:
      return fallback && fallback.trim() !== "" ? fallback : "요청을 처리하지 못했습니다.";
  }
}
