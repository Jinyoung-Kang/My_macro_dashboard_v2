/**
 * 차트 툴팁 줄의 차례와 글자색 — 순수 함수(공용 선 차트 `MultiLineSeries`의 선택 prop `tooltipOrder`·`tooltipSeriesColors`가 씀).
 *
 * <p>Recharts 3의 툴팁은 기본으로 줄을 이름 차례(`itemSorter: 'name'` — 알파벳·가나다)로 놓습니다. 기관 13F 비중 추이처럼 '그 시점의 순위'가
 * 뜻인 차트는 값이 큰 차례가 맞습니다(2026-11-17 사용자 요구). 글자를 계열 색으로 칠할 때는 덮개 바탕(surface-2)에서 본문 글자 대비 4.5:1을
 * 지키도록, 모자란 색만 같은 색을 흰색 쪽으로 밝혀 씁니다(선 색은 그대로 — 선은 비글자 대비 3:1 기준으로 고른 팔레트).
 */

/** 툴팁 덮개 바탕 — `app/globals.css`의 `--surface-2`(어두운 테마 고정). 바뀌면 `chartTooltip.test.ts`가 CSS 값과 대조해 막습니다. */
export const TOOLTIP_BG_HEX = "#252a31";

/** 본문 글자(12px 툴팁) 대비 기준 — WCAG 1.4.3 AA. */
export const TOOLTIP_TEXT_CONTRAST = 4.5;

function channels(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 두 색의 대비(WCAG 상대 밝기 비). 여섯 자리 16진수가 아니면 null. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = channels(a);
  const cb = channels(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 바탕 위 글자로 읽히는 색 — 대비가 이미 `min` 이상이면 그 색 그대로, 모자라면 흰색과 2%씩 더 섞어 처음으로 `min`을 넘는 색.
 * 16진수 여섯 자리가 아닌 값(CSS 변수 등)은 그대로 돌려줍니다(부르는 쪽 색을 바꾸지 않음).
 */
export function readableOn(color: string, background: string = TOOLTIP_BG_HEX, min: number = TOOLTIP_TEXT_CONTRAST): string {
  const base = channels(color);
  if (!base || (contrastRatio(color, background) ?? 0) >= min) return color;
  for (let step = 1; step <= 50; step += 1) {
    const t = step / 50;
    const mixed = toHex(base.map((channel) => channel + (255 - channel) * t) as [number, number, number]);
    if ((contrastRatio(mixed, background) ?? 0) >= min) return mixed;
  }
  return "#ffffff";
}

/**
 * 툴팁 줄을 값이 큰 차례로 — Recharts `itemSorter`(오름차순 안정 정렬)에 넘기는 열쇠라 값의 음수를 돌려줍니다. 같은 값은 계열 차례 그대로(안정
 * 정렬), 숫자가 아닌 값은 맨 뒤. 툴팁은 null 값 줄을 이미 뺍니다(`filterNull`).
 */
export function valueDescKey(item: { value?: unknown }): number {
  const value = Number(item.value);
  return Number.isFinite(value) ? -value : Number.POSITIVE_INFINITY;
}
