/**
 * 경제 캘린더(운영자 전용 — ADR 0026)의 응답 모양과 표시 규칙.
 *
 * 백엔드 `GET /api/macro/econ-calendar`가 수집기 저장본(`calendar.econ.tradingview`)을 그대로 내려 줍니다. 출처는 비공식이고
 * 차단 통과 수집 계층으로 받은 자료라, 없는 값은 만들지 않고 '—'로 둡니다(0과 다릅니다).
 */
import { EMPTY } from "@/lib/format";

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
 * 단위 자리는 출처가 주는 조합에 맞춥니다(2026-11-06 실제 응답: 단위 %·$·KRW·cf, 배수 K·M·B·T): 통화 기호는 숫자 앞(음수는 부호 뒤),
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
  if (CURRENCY_SYMBOLS.has(unit)) {
    return `${value < 0 ? "-" : ""}${unit}${format(Math.abs(value), digits)}${scale}`;
  }
  const number = `${format(value, digits)}${scale}`;
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
