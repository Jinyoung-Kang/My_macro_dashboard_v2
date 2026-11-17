/**
 * 경제 캘린더(운영자 전용 — ADR 0026)의 응답 모양과 표시 규칙.
 *
 * 백엔드 `GET /api/macro/econ-calendar`가 수집기 저장본(`calendar.econ.tradingview`)을 그대로 내려 줍니다. 출처는 비공식이고
 * 차단 통과 수집 계층으로 받은 자료라, 없는 값은 만들지 않고 '—'로 둡니다(0과 다릅니다).
 */
import { EMPTY, MINUS, withMinusSign } from "@/lib/format";

export type EconEvent = {
  id: string | null;
  country: "US" | "KR";
  title: string;
  /** 발표 시각(ISO, UTC). */
  at: string;
  atKst: string | null;
  /** -1 낮음 · 0 보통 · 1 높음. 출처가 주지 않았으면 null. */
  importance: number | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  indicator?: string | null;
  period?: string | null;
  unit?: string | null;
  scale?: string | null;
  currency?: string | null;
  source?: string | null;
};

export type EconCalendarResponse = {
  available: boolean;
  collectedAtKst?: string;
  ageSeconds?: number | null;
  source?: string | null;
  sourceUrl?: string | null;
  sourceNote?: string | null;
  /** 통과한 계층 — impersonate(브라우저 TLS) · browser(브라우저 컨테이너). */
  fetchTier?: string | null;
  window?: { from: string; to: string } | null;
  events: EconEvent[];
};

const IMPORTANCE: Record<number, string> = { [-1]: "낮음", 0: "보통", 1: "높음" };

/** 중요도 글. 출처가 주지 않았거나 모르는 값이면 '—'. */
export function importanceLabel(importance: number | null | undefined): string {
  if (importance === null || importance === undefined) return EMPTY;
  return IMPORTANCE[importance] ?? EMPTY;
}

/** 숫자 앞에 붙이는 통화 기호 단위. 그 밖의 글자 단위(KRW·cf 등)는 숫자 뒤에 띄어 적습니다. */
const CURRENCY_SYMBOLS = new Set(["$", "€", "£", "¥", "₩"]);

/**
 * 값 한 칸 — 숫자와 배수·단위("3.1%", "218K", "$61.46B", "1.2T KRW"). 값이 없으면 '—'(0으로 그리지 않음).
 *
 * 소수 자릿수는 출처가 준 그대로 둡니다(정수는 0자리, 소수는 최대 2자리) — 자릿수를 늘려 없는 정밀도를 만들지 않습니다.
 * 단위 자리는 출처가 주는 조합에 맞춥니다(2026-11-06 실제 응답: 단위 %·$·KRW·cf, 배수 K·M·B·T): 통화 기호는 숫자 앞(음수는 부호 −(U+2212) 뒤),
 * %는 붙여서, 글자 단위는 띄어서.
 */
export function valueText(
  value: number | null | undefined,
  event: Pick<EconEvent, "unit" | "scale">,
  format: (value: number, digits: number) => string,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  const digits = Number.isInteger(value) ? 0 : Math.min(2, decimals(value));
  const scale = event.scale ?? "";
  const unit = event.unit ?? "";
  // 음수 부호는 −(U+2212) — 같은 화면군의 다른 음수와 같은 글자(명세 D4·§3-1, QA-648). 통화 기호 앞에 둡니다('−$7.5B').
  if (CURRENCY_SYMBOLS.has(unit)) {
    return `${value < 0 ? MINUS : ""}${unit}${format(Math.abs(value), digits)}${scale}`;
  }
  const number = `${withMinusSign(format(value, digits))}${scale}`;
  if (unit === "" || unit === "%") return `${number}${unit}`;
  return `${number} ${unit}`;
}

function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** '우회 수집' 표기 — 어느 계층으로 받았는지. 계층을 모르면 표기하지 않습니다. */
export function bypassBadge(fetchTier: string | null | undefined): string | null {
  if (fetchTier === "impersonate") return "우회 수집 · 브라우저 TLS";
  if (fetchTier === "browser") return "우회 수집 · 브라우저";
  return null;
}

// ---------------------------------------------------------------- 날짜 띠 + 그날 표(2026-11-18 사용자 결정)

/**
 * 화면에 보이는 중요도 — 보통(0)·높음(1)만. 낮음(-1)과 모름(null·그 밖의 값)은 숨기고 숨긴 건수를 한 줄로 적습니다(2026-11-18 사용자 요구 —
 * 운영 기준 창 안 311건 중 131건만 남음). 응답은 그대로이고 거르는 것은 화면입니다.
 */
export function isShownImportance(importance: number | null | undefined): boolean {
  return importance === 0 || importance === 1;
}

/** 숨긴 건수 — 중요도 낮음·모름, 그리고 보일 중요도인데 발표 날짜를 알 수 없는 일정(날짜 띠에 놓을 자리가 없음). */
export type EconHiddenCounts = { low: number; unknown: number; undated: number };

/** KST 하루의 일정 — 발표 시각 차례. `high`는 중요도 높음 건수. */
export type EconDay = { date: string; events: EconEvent[]; high: number };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (value: number) => String(value).padStart(2, "0");
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** KST로 옮긴 Date(UTC 필드가 KST 값)의 날짜 글. */
const dateText = (shifted: Date) => `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;

/** 시각(ms)의 KST 날짜(YYYY-MM-DD). KST는 서머타임이 없어 +9시간으로 셉니다. */
export function econToday(nowMs: number): string {
  return dateText(new Date(nowMs + KST_OFFSET_MS));
}

/** UTC ISO 시각을 KST로 옮긴 Date(UTC 필드가 KST 값). 알아볼 수 없으면 null. */
function kstShifted(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + KST_OFFSET_MS);
}

/** 일정의 KST 날짜(YYYY-MM-DD) — `atKst`('2026-11-18 22:30 KST')의 날짜, 없거나 알아볼 수 없으면 `at`(UTC)을 KST로. 둘 다 모르면 null. */
export function econEventDate(event: Pick<EconEvent, "at" | "atKst">): string | null {
  const own = /^(\d{4}-\d{2}-\d{2})/.exec(event.atKst ?? "");
  if (own) return own[1];
  const shifted = kstShifted(event.at);
  return shifted ? dateText(shifted) : null;
}

/** 일정의 KST 시각(HH:MM) — 날짜는 날짜 띠·표 머리에 있어 시각만. `atKst`에서, 없으면 `at`(UTC)을 KST로. 모르면 null. */
export function econEventTime(event: Pick<EconEvent, "at" | "atKst">): string | null {
  const own = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(event.atKst ?? "");
  if (own) return own[1];
  const shifted = kstShifted(event.at);
  return shifted ? `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}` : null;
}

/**
 * 보일 일정을 KST 날짜별로 묶고 숨긴 건수를 셉니다. 날짜는 오래된 차례, 그날 안은 발표 시각 차례(시각을 모르면 그날 끝 — 같은 시각은 받은 차례).
 * 보일 일정이 없는 날은 띠에 없습니다.
 */
export function econCalendarView(events: readonly EconEvent[]): { days: EconDay[]; hidden: EconHiddenCounts } {
  const hidden: EconHiddenCounts = { low: 0, unknown: 0, undated: 0 };
  const byDate = new Map<string, EconEvent[]>();
  for (const event of events) {
    if (!isShownImportance(event.importance)) {
      if (event.importance === -1) hidden.low += 1;
      else hidden.unknown += 1;
      continue;
    }
    const date = econEventDate(event);
    if (date === null) {
      hidden.undated += 1;
      continue;
    }
    const list = byDate.get(date);
    if (list) list.push(event);
    else byDate.set(date, [event]);
  }
  const timeKey = (event: EconEvent) => econEventTime(event) ?? "99:99";
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => {
      const sorted = [...list].sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : timeKey(a) > timeKey(b) ? 1 : 0));
      return { date, events: sorted, high: sorted.filter((event) => event.importance === 1).length };
    });
  return { days, hidden };
}

/** 숨긴 건수 한 줄 — 예 '중요도 낮음 172건·모름 3건은 숨겼습니다.' 숨긴 것이 없으면 null(0건 마디는 적지 않음). */
export function econHiddenText(hidden: EconHiddenCounts): string | null {
  const count = (value: number) => `${value.toLocaleString("ko-KR")}건`;
  const importance = [hidden.low > 0 ? `낮음 ${count(hidden.low)}` : null, hidden.unknown > 0 ? `모름 ${count(hidden.unknown)}` : null].filter(
    (part): part is string => part !== null,
  );
  const parts = [
    importance.length > 0 ? `중요도 ${importance.join("·")}` : null,
    hidden.undated > 0 ? `발표 날짜를 모르는 일정 ${count(hidden.undated)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join("과 ")}은 숨겼습니다.` : null;
}

/**
 * 처음 고를 날 — 오늘(KST)에 보일 일정이 있으면 오늘, 없으면 오늘 뒤 첫 날, 그것도 없으면 오늘 앞 마지막 날. 오늘을 아직 모르면(마운트 전) 첫 날.
 * 날이 하나도 없으면 null. 고른 날이 새 자료에서 사라졌을 때도 같은 규칙으로 다시 고릅니다.
 */
export function pickEconDay(dates: readonly string[], today: string | null): string | null {
  if (dates.length === 0) return null;
  if (today === null) return dates[0];
  if (dates.includes(today)) return today;
  const after = dates.filter((date) => date > today).sort();
  if (after.length > 0) return after[0];
  return [...dates].sort()[dates.length - 1];
}

function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** 날짜 띠의 칩 글 — '11/18 (수)'. */
export function econDayChip(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}/${day} (${weekday(date)})`;
}

/** 표 머리의 날짜 글 — '11월 18일 (수)'. */
export function econDayTitle(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}월 ${day}일 (${weekday(date)})`;
}

/** 칩의 건수 글 — '14건', 높음이 있으면 '14건 · 높음 2'(높음을 색이 아니라 글로). */
export function econDayCountText(day: Pick<EconDay, "events" | "high">): string {
  return `${day.events.length.toLocaleString("ko-KR")}건${day.high > 0 ? ` · 높음 ${day.high.toLocaleString("ko-KR")}` : ""}`;
}
