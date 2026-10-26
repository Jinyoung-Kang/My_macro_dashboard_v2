/**
 * 숫자·날짜 표시 헬퍼.
 *
 * 핵심 규칙 — 값이 없으면 "—"(EMPTY)로 표시하고 **절대 0으로 대체하지 않습니다**.
 * 화면에서 "0.00%"는 '데이터 없음'이 아니라 '보합'으로 읽힙니다. 구버전에서
 * 실제로 잘못된 판단을 유발했던 부분입니다.
 */

export const EMPTY = "—";

/** 값이 없거나 숫자로 쓸 수 없는가(null·undefined·NaN·±Infinity). Infinity는 "∞"로 찍혀 나갔습니다. */
function missing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** 보이는 숫자에 0이 아닌 자리가 있는가 — 부호는 보이는 숫자 기준으로 붙입니다. */
function hasNonZeroDigit(text: string): boolean {
  return /[1-9]/.test(text);
}

/**
 * 표시 자릿수로 반올림합니다. `-0`은 `0`으로 정규화합니다.
 *
 * @param value  원래 값
 * @param digits 소수 자릿수
 * @returns 반올림된 값
 *
 * 부호와 색 판단은 **보이는 숫자**를 기준으로 해야 합니다. -0.004를 2자리로
 * 찍으면 "-0.00"이 나오는데, 읽는 사람에게 아무 뜻도 없으면서 하락색까지 입습니다.
 */
function roundForDisplay(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatNumber(
  value: number | null | undefined,
  digits = 2,
): string {
  if (missing(value)) {
    return EMPTY;
  }
  return roundForDisplay(value, digits).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatSigned(
  value: number | null | undefined,
  digits = 2,
  suffix = "",
): string {
  if (missing(value)) {
    return EMPTY;
  }
  // 부호도 반올림 후 값으로 정합니다. 그래야 "+0.00"·"-0.00"이 안 나옵니다.
  const shown = roundForDisplay(value, digits);
  const sign = shown > 0 ? "+" : "";
  return `${sign}${formatNumber(shown, digits)}${suffix}`;
}

export function formatPercent(
  value: number | null | undefined,
  digits = 2,
): string {
  if (missing(value)) {
    return EMPTY;
  }
  return `${formatSigned(value, digits)}%`;
}

/** 음수 부호 — 하이픈(-)이 아니라 수학 기호 −(U+2212). 화면 패턴의 변화 칩이 씁니다(v2 설계, ChangeChip). */
export const MINUS = "−";

/**
 * 부호를 붙인 숫자 — 양수 "+", 음수 "−"(U+2212). 반올림 뒤 0이면 부호를 붙이지 않습니다("+0.00"·"−0.00"을 만들지 않음).
 *
 * @param value 유한한 숫자 — 값을 모르는 경우(null·NaN)는 부르는 쪽이 먼저 거릅니다
 * @returns 글과 **보이는** 숫자의 부호(-1·0·1). 색·화살표는 이 부호로 정합니다(formatSigned·deltaColor와 같은 규칙)
 */
export function formatSignedMinus(value: number, digits = 2): { text: string; sign: -1 | 0 | 1 } {
  const text = formatNumber(Math.abs(value), digits);
  if (!hasNonZeroDigit(text)) {
    return { text, sign: 0 };
  }
  return value > 0 ? { text: `+${text}`, sign: 1 } : { text: `${MINUS}${text}`, sign: -1 };
}

/**
 * 시세 지연(분) → 배지 문구. 0이면 "실시간", 모르면 null(표시하지 않음) — 수집기 indicators.delay_label과 같은 규칙(QA-137).
 */
export function delayLabel(minutes: number | null | undefined): string | null {
  if (missing(minutes)) {
    return null;
  }
  return minutes === 0 ? "실시간" : `${minutes}분 지연`;
}

/**
 * 등락 색상 클래스. 한국 시장 관행대로 상승은 빨강, 하락은 파랑입니다.
 *
 * @param value  등락 값
 * @param digits **그 자리에 함께 찍는 숫자의 자릿수**를 넘기세요
 * @returns Tailwind 클래스명. 값이 없으면 중립색
 *
 * `digits`를 맞추지 않으면 "0.00인데 파란색" 같은 화면이 나옵니다 — 반올림 후
 * 0이 된 값에 하락색이 남기 때문입니다.
 */
export function deltaColor(
  value: number | null | undefined,
  digits = 2,
): string {
  if (missing(value)) {
    return "text-muted";
  }
  const shown = roundForDisplay(value, digits);
  if (shown > 0) {
    return "text-up";
  }
  if (shown < 0) {
    return "text-down";
  }
  return "text-body";
}

export function formatCurrency(value: number | null | undefined): string {
  return formatUsd(value);
}

/**
 * 달러 금액을 한국식 단위(조·억)로.
 *
 * @param value 달러 금액 (원 단위 숫자 그대로)
 * @returns 예: `"2,992.5억 달러"`. 값이 없으면 `"—"`
 *
 * B·M을 쓰지 않는 이유 — "$299.25B"는 한국어로 읽을 때 자릿수를 머리로 한 번 더
 * 옮겨야 합니다. 이 대시보드는 원화와 나란히 읽는 화면이 많아 두 통화를 같은
 * 단위 체계로 맞춥니다.
 */
export function formatUsd(value: number | null | undefined): string {
  return formatKoreanScale(value, "달러");
}

/** 원화 금액을 조·억 단위로. */
export function formatKrw(value: number | null | undefined): string {
  return formatKoreanScale(value, "원");
}

/** 순매수처럼 부호가 뜻을 갖는 원화 금액. 양수에 +를 붙입니다(예: "+1,234억 원"). */
export function formatSignedKrw(value: number | null | undefined): string {
  const text = formatKrw(value);
  // 0.4원은 "0 원"으로 찍히는데 원래 값이 양수라고 "+0 원"을 만들면 안 됩니다(roundForDisplay와 같은 이유).
  return !missing(value) && value > 0 && hasNonZeroDigit(text) ? `+${text}` : text;
}

/**
 * 주식 수(순매수 거래량 등). 만 주 단위로 줄이고 부호를 붙입니다.
 *
 * @returns 예: `"+29.2만 주"`, `"-1,250 주"`, 값이 없으면 `"—"`
 */
export function formatShares(value: number | null | undefined): string {
  if (missing(value)) {
    return EMPTY;
  }
  const magnitude = Math.abs(value);
  const body =
    magnitude >= 1e8 ? `${formatNumber(value / 1e8, 2)}억 주`
    : magnitude >= 1e4 ? `${formatNumber(value / 1e4, 1)}만 주`
    : `${formatNumber(value, 0)} 주`;
  return value > 0 && hasNonZeroDigit(body) ? `+${body}` : body;
}

/**
 * 조(1e12)·억(1e8)·만(1e4) 단위 공통 규칙.
 *
 * @param value  금액
 * @param suffix 통화 표기 ("달러" / "원")
 * @returns 단위가 붙은 문자열
 */
function formatKoreanScale(value: number | null | undefined, suffix: string): string {
  if (missing(value)) {
    return EMPTY;
  }
  const magnitude = Math.abs(value);
  let index = SCALE_UNITS.findIndex(([unit]) => magnitude >= unit);
  if (index < 0) {
    index = SCALE_UNITS.length - 1;
  }
  for (;;) {
    const [unit, label] = SCALE_UNITS[index];
    const digits = scaleDigits(unit, magnitude);
    const rounded = roundForDisplay(value / unit, digits);
    // 반올림이 다음 단위에 닿으면 올립니다. 9,999.95억을 "10,000.0억"이라고 적지 않고 "1.000조"로.
    if (index > 0 && Math.abs(rounded) >= SCALE_UNITS[index - 1][0] / unit) {
      index -= 1;
      continue;
    }
    const number = formatNumber(rounded, digits);
    return label ? `${number}${label} ${suffix}` : `${number} ${suffix}`;
  }
}

const SCALE_UNITS: readonly (readonly [number, string])[] = [
  [1e12, "조"],
  [1e8, "억"],
  [1e4, "만"],
  [1, ""],
];

/**
 * 단위별 소수 자릿수.
 *
 * 조: 자릿수가 커질수록 소수는 의미를 잃습니다. "8,607.639조 원"에서 뒤 세 자리는 6,390억인데,
 *     8,607조 옆에 붙어 있으면 읽는 사람이 자릿수를 다시 세게 만들 뿐입니다. 1,000조를 넘으면 정수.
 * 억: 소수점을 거의 쓰지 않습니다. 1,000억이 넘으면 정수로 충분합니다.
 */
function scaleDigits(unit: number, magnitude: number): number {
  if (unit === 1e12) return magnitude >= 1e15 ? 0 : magnitude >= 1e14 ? 1 : 3;
  if (unit === 1e8) return magnitude >= 1e11 ? 0 : 1;
  return 0;
}

/**
 * 달러 금액과 원화 환산을 한 줄로.
 *
 * @param usd  달러 금액
 * @param rate 원/달러 환율
 * @returns 예: `"447.0억 달러 (약 61.8조 원)"`. **환율을 모르면 달러만** 돌려줍니다 —
 *          임의의 기본 환율로 원화를 지어내면 틀린 금액을 사실처럼 보여 주게 됩니다
 */
export function formatUsdWithKrw(
  usd: number | null | undefined,
  rate: number | null | undefined,
): string {
  const dollars = formatUsd(usd);
  if (missing(usd) || missing(rate) || rate <= 0) {
    return dollars;
  }
  return `${dollars} (약 ${formatKrw(usd * rate)})`;
}

/**
 * **조 달러 단위로 들어온 값**을 억/조 달러 표기로.
 *
 * @param valueInTrillions 조 달러 단위 값 (예: `netLiquidityT`)
 * @returns 예: 0.012 → `"120억 달러"`
 */
export function formatTrillionUsd(valueInTrillions: number | null | undefined): string {
  if (missing(valueInTrillions)) {
    return EMPTY;
  }
  return formatUsd(valueInTrillions * 1e12);
}

/**
 * **십억 달러 단위로 들어온 값**을 억/조 달러 표기로.
 *
 * @param valueInBillions 십억 달러 단위 값 (예: `tgaB`, `rrpB`)
 * @returns 예: 877.0 → `"8,770억 달러"`
 */
export function formatBillionUsd(valueInBillions: number | null | undefined): string {
  if (missing(valueInBillions)) {
    return EMPTY;
  }
  return formatUsd(valueInBillions * 1e9);
}

/**
 * 조 달러 단위 변화량 (부호 포함).
 *
 * @param value 조 달러 단위 변화량
 * @returns 예: -0.0005 → `"-5.0억 달러"`
 *
 * 조 단위로 그대로 적으면 "+0.000조 달러"가 되어 **변화가 없는 것처럼** 보입니다.
 * 크기에 맞는 단위로 내려 적습니다(같은 값입니다).
 */
export function formatTrillionDelta(value: number | null | undefined): string {
  if (missing(value)) {
    return EMPTY;
  }
  // 부호가 중요한 값이라 +/-를 앞에 붙이고, 단위는 억·조로 통일합니다.
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatTrillionUsd(Math.abs(value))}`;
}

/**
 * 경과 시간을 사람이 읽는 문장으로.
 *
 * @param seconds 경과 초
 * @returns 예: `"3분 전"`. 값이 없으면 `"—"`
 */
export function formatAge(seconds: number | null | undefined): string {
  if (missing(seconds)) {
    return EMPTY;
  }
  // 시계가 어긋나 음수가 와도 "-5초 전"을 찍지 않습니다.
  seconds = Math.max(0, seconds);
  if (seconds < 60) {
    return `${Math.round(seconds)}초 전`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}분 전`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}시간 전`;
  }
  return `${Math.round(seconds / 86400)}일 전`;
}

/**
 * 화면의 모든 시각을 한 형식으로 — `"YYYY-MM-DD HH:mm"` (한국 시간, 초 없음).
 *
 * 수집기(collector/app/kst.py)·백엔드(Kst.DISPLAY)도 같은 형식으로 보내지만,
 * DB에는 예전 형식("… 23:43:09 KST")으로 저장된 값이 남아 있고, 실행 기록처럼
 * ISO(UTC) 문자열로 오는 값도 있습니다. 어느 쪽이 와도 여기서 한 형식으로 맞춥니다.
 *
 * 받는 형식
 *   - ISO 시각(`2026-09-25T14:20:59Z`, `…+09:00[Asia/Seoul]`) → KST로 바꿔 표시
 *   - `YYYY-MM-DD HH:MM[:SS][ KST]` → 이미 KST이므로 초와 "KST"만 뗌
 *   - 문장 속 시각(`"2026-09-25 23:43:09 KST (TradingView 수집 시각)"`) → 시각 부분만 바꿈
 *   - 날짜 없는 옛 형식(`"23:33:00 KST"`) → `"23:33"` (날짜를 지어내지 않음)
 *
 * 주의사항 — 알아볼 수 없는 형식이면 받은 값을 그대로 돌려줍니다. 시각을 지어내지 않습니다.
 *
 * @param value 시각 문자열·Date
 * @returns 예 `"2026-09-25 23:43"`. 값이 없으면 `"—"`
 */
export function formatKst(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return EMPTY;
  }
  if (value instanceof Date) {
    return kstParts(value) ?? EMPTY;
  }
  // ISO 8601 (T 구분자 + 시간대). 자바 ZonedDateTime의 "[Asia/Seoul]" 꼬리는 Date가 못 읽어 뗍니다.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && /(Z|[+-]\d{2}:?\d{2})(\[.*\])?$/.test(value)) {
    const parsed = new Date(value.replace(/\[.*\]$/, ""));
    return Number.isNaN(parsed.getTime()) ? value : (kstParts(parsed) ?? value);
  }
  // 문장 속 KST 시각: 날짜+시각 → 분까지, 날짜 없는 시각 → 분까지.
  const replaced = value
    .replace(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?: KST)?/g, "$1 $2")
    .replace(/(^|[^\d:-])(\d{2}:\d{2}):\d{2} KST/g, "$1$2");
  return replaced;
}

/** Date → KST "YYYY-MM-DD HH:mm". 변환이 불가능한 환경이면 null. */
function kstParts(date: Date): string | null {
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
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return null;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return EMPTY;
  }
  return value.slice(0, 10);
}

/**
 * 백분위의 표본 — "2023-10-09 이후 784개 · 약 3.0년".
 *
 * 표본 길이가 지표마다 다릅니다(IG·HY 스프레드는 FRED가 최근 3년만 제공, 나머지는 약 10년).
 * 백분위 옆에 표본을 적지 않으면 "3년 안의 중간"이 "역사적 중간"처럼 읽힙니다.
 * 셋 중 하나라도 없으면 null — 모르는 표본을 지어내지 않습니다.
 */
export function formatSampleWindow(
  from: string | null | undefined,
  count: number | null | undefined,
  years: number | null | undefined,
): string | null {
  if (!from || missing(count) || missing(years)) {
    return null;
  }
  return `${from.slice(0, 10)} 이후 ${count.toLocaleString("ko-KR")}개 · 약 ${years.toFixed(1)}년`;
}

/**
 * 백엔드가 내려주는 해석 색상을 Tailwind 클래스명으로.
 *
 * @param color `"green"` | `"blue"` | `"orange"` | `"red"`
 * @returns 클래스명. 모르는 값이면 기본 본문색
 */
export function statusColor(color: string | null | undefined): string {
  switch (color) {
    case "green":
      return "text-ok";
    case "blue":
      return "text-accent";
    case "orange":
      return "text-warn";
    case "red":
      return "text-danger";
    default:
      return "text-body";
  }
}

/**
 * 제목 앞의 그림 문자(이모지·국기) 아이콘을 뗍니다 — 카드 제목에 아이콘을 쓰지 않습니다.
 * 수집기 데이터에서 오는 제목(예: 매크로 카테고리 "💵 통화 및 환율")도 같은 모양으로 맞춥니다.
 */
export function withoutLeadingIcon(text: string): string {
  return text.replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\s]+/u, "");
}

/**
 * 숫자 + 단위. 모르는 값이면 단위 없이 "—"입니다 — "—%"·"—억 원"은 값이 있는 것처럼 읽혔습니다(QA-049).
 *
 * @param unit 숫자 바로 뒤에 붙일 글자(예: "%", "%p", "억 원", "일 전 공시")
 */
export function formatWithUnit(value: number | null | undefined, digits: number, unit: string): string {
  const text = formatNumber(value, digits);
  return text === EMPTY ? EMPTY : `${text}${unit}`;
}

/** 밀리초를 사람이 읽는 시간으로. 3분 42초가 "222134ms"로 보이면 감이 안 옵니다. */
export function formatLatency(latencyMs?: number): string {
  if (latencyMs === undefined || latencyMs === null) {
    return "소요 시간 미상";
  }
  // 반올림을 먼저 하고 단위를 나눕니다. 분·초를 따로 반올림하면 119.6초가 "1분 60초", 59.96초가 "60.0초"였습니다(QA-048).
  const tenths = Math.round(latencyMs / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}초`;
  }
  const total = Math.round(latencyMs / 1000);
  return `${Math.floor(total / 60)}분 ${total % 60}초`;
}
