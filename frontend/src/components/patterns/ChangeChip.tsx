import type { JSX } from "react";

import { changeChipModel, type ChangeDirection } from "@/lib/patterns";

// 상승 빨강·하락 파랑(한국 관행). 이 글자색은 surface·bg 위에서만 4.5:1을 넘으므로 칩에 바탕을 칠하지 않습니다.
const TONE: Record<ChangeDirection, string> = {
  up: "text-up",
  down: "text-down",
  flat: "text-neutral",
};

const ARROW: Record<ChangeDirection, string | null> = { up: "▲", down: "▼", flat: null };

// 화살표는 읽어 주기에서 빼고 방향을 말로 읽습니다. 부호(+·−)도 글자로 남으므로 색만으로 뜻을 전하지 않습니다.
const SPOKEN: Record<ChangeDirection, string> = { up: "상승", down: "하락", flat: "변화 없음" };

/**
 * 변화 칩 — "▲ +1.23원 (+0.45%)". 변화량·변화율을 둘 다 모르면 그리지 않습니다(0.00%를 만들지 않음).
 *
 * - 방향·부호는 보이는(반올림된) 값 기준. 0으로 찍히면 화살표 없이 중립색.
 * - 음수 부호는 −(U+2212). 단위(`unit`)는 변화량 바로 옆에 작게, 변화율은 "%"를 붙입니다.
 * - `digits`(기본 2)는 변화량·변화율에 함께 씁니다. 변화율만 다르게 찍으려면 `pctDigits`(설계서 §1.5 계약에 더한 선택 prop —
 *   금리 카드의 "−0.007 (−0.14%)"처럼 수집기가 두 자릿수를 따로 정할 때).
 */
export function ChangeChip({
  change,
  changePct,
  digits = 2,
  pctDigits,
  unit,
  size = "md",
}: {
  change?: number | null;
  changePct?: number | null;
  digits?: number;
  pctDigits?: number;
  unit?: string;
  size?: "sm" | "md";
}): JSX.Element | null {
  const model = changeChipModel(change, changePct, digits, pctDigits ?? digits);
  if (model === null) {
    return null;
  }
  const arrow = ARROW[model.direction];
  return (
    <span
      className={`inline-flex flex-wrap items-baseline gap-x-1 font-medium tabular-nums ${size === "sm" ? "text-xs" : "text-sm"} ${TONE[model.direction]}`}
    >
      {arrow ? (
        <span aria-hidden="true" className="text-[0.8em]">
          {arrow}
        </span>
      ) : null}
      <span className="sr-only">{SPOKEN[model.direction]}</span>
      {model.change !== null ? (
        <span>
          {model.change}
          {unit ? <span className="ml-0.5 text-[0.85em] font-normal">{unit}</span> : null}
        </span>
      ) : null}
      {model.changePct !== null ? <span>{model.change !== null ? `(${model.changePct})` : model.changePct}</span> : null}
    </span>
  );
}
