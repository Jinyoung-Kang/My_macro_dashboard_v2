/**
 * QA-525: 공용 지표 칸(ui Metric)의 변화 줄이 등락을 색(상승 빨강·하락 파랑)과 ASCII 부호('-')만으로 날랐습니다 — ▲▼ 기호도, 낭독기가 읽는 방향 글도 없고
 * 음수 부호가 하이픈이라 변화 칩(ChangeChip — ▲▼ 12px·sr '상승/하락'·−(U+2212))과 문법이 달랐습니다(D1 QA 스택 확인 'metric-delta-colour-and-ascii-sign' — 개편 전부터,
 * 매크로·위험·스프레드·고급·환율 비교·KRX·COT·순유동성 화면의 지표 칸).
 *
 * 고친 뒤: 방향은 deltaDigits(없으면 2)로 반올림한 보이는 값으로 정합니다(deltaColor와 같은 규칙) — 상승은 aria-hidden '▲'(text-xs) + sr '상승', 하락은 '▼' + sr '하락',
 * 0으로 찍히면 화살표 없이 sr '변화 없음', 값을 모르면(null·'—') 방향 표시가 없습니다. 보이는 글의 음수 부호는 −(U+2212)이고 날짜·코드의 하이픈은 그대로입니다.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Metric } from "../index";

afterEach(() => cleanup());

/** 변화 줄(라벨 · 값 · 변화 — 캡션·주석·출처 없이 그린 칸의 셋째 줄)이 보이는 것과 읽히는 것. */
function deltaRow(props: { delta?: number | null; deltaText?: string; deltaDigits?: number }) {
  const { container } = render(<Metric label="지표" value="100" {...props} />);
  const row = (container.firstElementChild as HTMLElement).children[2] as HTMLElement | undefined;
  if (!row) return null;
  const arrow = row.querySelector('[aria-hidden="true"]');
  const visible = row.cloneNode(true) as HTMLElement;
  for (const hidden of visible.querySelectorAll('[aria-hidden="true"], .sr-only')) hidden.remove();
  return {
    arrow: arrow?.textContent ?? null,
    arrowSmall: arrow ? arrow.classList.contains("text-xs") : null,
    spoken: row.querySelector(".sr-only")?.textContent ?? null,
    text: visible.textContent,
    tone: ["text-up", "text-down", "text-text-2", "text-text-3"].find((tone) => row.className.split(/\s+/).includes(tone)) ?? null,
  };
}

describe("QA-525 공용 지표 칸의 변화 줄 — ▲▼·방향 글·−(U+2212)", () => {
  it.fails("하락(−1.5, '-1.50%')은 ▼(12px, 읽기에서 뺌)·sr '하락'·보이는 '−1.50%'이고 하락색이다", () => {
    expect(deltaRow({ delta: -1.5, deltaText: "-1.50%" })).toEqual({
      arrow: "▼",
      arrowSmall: true,
      spoken: "하락",
      text: "−1.50%",
      tone: "text-down",
    });
  });

  it.fails("상승(+0.2, '+0.20%')은 ▲·sr '상승'이고 상승색이다", () => {
    expect(deltaRow({ delta: 0.2, deltaText: "+0.20%" })).toEqual({
      arrow: "▲",
      arrowSmall: true,
      spoken: "상승",
      text: "+0.20%",
      tone: "text-up",
    });
  });

  it.fails("0으로 찍히는 값(0.001, 자릿수 2)은 화살표 없이 sr '변화 없음'이다", () => {
    expect(deltaRow({ delta: 0.001, deltaText: "0.00%" })).toEqual({
      arrow: null,
      arrowSmall: null,
      spoken: "변화 없음",
      text: "0.00%",
      tone: "text-text-2",
    });
  });

  it("값을 모르면(null·'—') 방향 표시가 없다 — '—'만", () => {
    expect(deltaRow({ delta: null, deltaText: "—" })).toEqual({
      arrow: null,
      arrowSmall: null,
      spoken: null,
      text: "—",
      tone: "text-text-3",
    });
  });

  it.fails("글 안의 날짜 하이픈은 그대로 두고 숫자 앞 음수 부호만 −로 그린다('기준 2026-11-10 -3', 자릿수 0)", () => {
    expect(deltaRow({ delta: -3, deltaText: "기준 2026-11-10 -3", deltaDigits: 0 })).toEqual({
      arrow: "▼",
      arrowSmall: true,
      spoken: "하락",
      text: "기준 2026-11-10 −3",
      tone: "text-down",
    });
  });
});
