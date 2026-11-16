/**
 * QA-527: 공용 지표 칸(ui Metric)의 변화 줄 색(과 QA-525 뒤의 ▲▼·읽어 주는 방향 글)을 값(delta)과 자릿수(deltaDigits, 없으면 2)로 따로 판정해,
 * 부르는 쪽이 글을 다른 자릿수·다른 단위로 찍으면 보이는 글과 어긋났습니다(개편 전부터 — 색만, QA-525 뒤로는 방향 글까지).
 *  - 매크로 지표 카드: 수집기 deltaStr은 금리를 소수 셋째 자리로 찍는데('+0.004 (+0.09%)') 화면이 deltaDigits를 넘기지 않아, |변화| < 0.005면 중립색·'변화 없음'.
 *  - 순유동성: 변화(delta)는 조 달러, 글은 억 달러('+40.0억 달러' = 0.004조)라 소수 둘째 자리 반올림이 0 — 중립색·'변화 없음'.
 *  - 금리 스프레드 '오늘 스크랩' 칸도 글은 셋째 자리, 판정은 둘째 자리.
 *
 * 고친 뒤: 보이는 글에 부호 붙은 숫자가 있으면 그 부호(0이 아닌 자리가 있으면 상승·하락, 모두 0이면 보합)로 색·▲▼·방향 글을 정합니다 — 숫자 서식 규칙
 * '부호와 색은 보이는 숫자 기준'(lib/format). 부호 붙은 숫자가 없으면 지금처럼 값과 자릿수로 정합니다.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Metric } from "../index";

afterEach(() => cleanup());

/** 변화 줄(라벨 · 값 · 변화 — 셋째 줄)의 방향 표시와 색. */
function deltaRow(props: { delta?: number | null; deltaText?: string; deltaDigits?: number }) {
  const { container } = render(<Metric label="지표" value="100" {...props} />);
  const row = (container.firstElementChild as HTMLElement).children[2] as HTMLElement;
  return {
    arrow: row.querySelector('[aria-hidden="true"]')?.textContent ?? null,
    spoken: row.querySelector(".sr-only")?.textContent ?? null,
    tone: ["text-up", "text-down", "text-text-2", "text-text-3"].find((tone) => row.className.split(/\s+/).includes(tone)) ?? null,
  };
}

describe("QA-527 공용 지표 칸 — 변화 줄의 색·방향은 보이는 글의 부호를 따른다", () => {
  it.fails("매크로 지표 카드(셋째 자리 글 '+0.004 (+0.09%)', 자릿수 없음)는 상승 — ▲·'상승'·상승색", () => {
    expect(deltaRow({ delta: 0.004, deltaText: "+0.004 (+0.09%)" })).toEqual({ arrow: "▲", spoken: "상승", tone: "text-up" });
  });

  it.fails("순유동성(값은 조 달러, 글은 억 달러 '+40.0억 달러')은 상승", () => {
    expect(deltaRow({ delta: 0.004, deltaText: "+40.0억 달러" })).toEqual({ arrow: "▲", spoken: "상승", tone: "text-up" });
  });

  it.fails("순유동성 감소('-30.0억 달러')는 하락 — ▼·'하락'·하락색", () => {
    expect(deltaRow({ delta: -0.003, deltaText: "-30.0억 달러" })).toEqual({ arrow: "▼", spoken: "하락", tone: "text-down" });
  });

  it("글의 부호 숫자가 모두 0이면('+0.000 (+0.00%)') 보합, 부호 숫자가 없으면 값과 자릿수로 — 지금과 같다", () => {
    expect(deltaRow({ delta: 0.0001, deltaText: "+0.000 (+0.00%)" })).toEqual({ arrow: null, spoken: "변화 없음", tone: "text-text-2" });
    expect(deltaRow({ delta: 0.001, deltaText: "0.00%" })).toEqual({ arrow: null, spoken: "변화 없음", tone: "text-text-2" });
    expect(deltaRow({ delta: -1.5, deltaText: "-1.50%" })).toEqual({ arrow: "▼", spoken: "하락", tone: "text-down" });
    expect(deltaRow({ delta: null, deltaText: "—" })).toEqual({ arrow: null, spoken: null, tone: "text-text-3" });
  });
});
