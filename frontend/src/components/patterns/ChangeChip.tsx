import type { JSX } from "react";

import { changeChipModel, type ChangeDirection, isMissingValue } from "@/lib/patterns";

import { Empty } from "./Empty";

// 상승 빨강·하락 파랑(한국 관행). 이 글자색은 surface·bg 위에서만 4.5:1을 넘으므로 칩에 바탕을 칠하지 않습니다.
const TONE: Record<ChangeDirection, string> = {
  up: "text-up",
  down: "text-down",
  flat: "text-neutral",
};

const ARROW: Record<ChangeDirection, string | null> = { up: "▲", down: "▼", flat: null };

// 화살표는 읽어 주기에서 빼고 방향을 말로 읽습니다. 부호(+·−)도 글자로 남으므로 색만으로 뜻을 전하지 않습니다.
const SPOKEN: Record<ChangeDirection, string> = { up: "상승", down: "하락", flat: "변화 없음" };

// 글자 단계(작업대 실행 명세 §3-6): md는 히어로·KPI 값 아래(body 14px 굵게 — 없앤 15px UI 단계 대신), sm은 표·자산 행 값 아래(caption 13px).
// 화살표·단위는 칩 크기와 상관없이 글자 하한 12px(text-xs)입니다 — 칩 크기의 비율(0.8em·0.85em)로 두면 13px 칩 안에서 10.4px·11.05px가
// 되었습니다(QA-457).
const SIZE: Record<"sm" | "md", string> = {
  sm: "text-caption font-medium",
  md: "text-body font-semibold",
};

/**
 * 변화 칩 — "▲ +1.23원 (+0.45%)". 변화량·변화율을 둘 다 모르면 그리지 않습니다(0.00%를 만들지 않음).
 *
 * - 방향·부호는 보이는(반올림된) 값 기준. 0으로 찍히면 화살표 없이 중립색.
 * - 음수 부호는 −(U+2212). 단위(`unit`)는 변화량 바로 옆에 작게, 변화율은 "%"를 붙입니다.
 * - `digits`(기본 2)는 변화량·변화율에 함께 씁니다. 변화율만 다르게 찍으려면 `pctDigits`(설계서 §1.5 계약에 더한 선택 prop —
 *   금리 카드의 "−0.007 (−0.14%)"처럼 수집기가 두 자릿수를 따로 정할 때).
 * - 화살표·읽어 주는 방향 글·첫 값(변화량, 없으면 변화율)은 줄 바꿈 없는 묶음 하나라, 줄은 변화량과 변화율 사이에서만 바뀝니다(화살표만 윗줄에 남지 않음 — QA-595).
 * - `nowrap`(기본 false — 설계서 §1.5 계약에 더한 선택 prop): 표 칸 안의 칩은 변화량과 변화율 사이에서도 꺾지 않습니다(flex-nowrap). 칸의
 *   `whitespace-nowrap`(DataTable 오른쪽 정렬 칸)은 flex 항목 사이의 줄바꿈을 막지 못해, 표 자동 배치가 칸에 최소 내용 폭(숫자 하나)만 주면 칩이 꺾였습니다(QA-595).
 */
export function ChangeChip({
  change,
  changePct,
  digits = 2,
  pctDigits,
  unit,
  size = "md",
  nowrap = false,
}: {
  change?: number | null;
  changePct?: number | null;
  digits?: number;
  pctDigits?: number;
  unit?: string;
  size?: "sm" | "md";
  nowrap?: boolean;
}): JSX.Element | null {
  const model = changeChipModel(change, changePct, digits, pctDigits ?? digits);
  if (model === null) {
    return null;
  }
  const arrow = ARROW[model.direction];
  const amount =
    model.change !== null ? (
      <span>
        {model.change}
        {unit ? <span className="ml-0.5 text-xs font-normal">{unit}</span> : null}
      </span>
    ) : null;
  const pct = model.changePct !== null ? <span>{model.change !== null ? `(${model.changePct})` : model.changePct}</span> : null;
  return (
    <span
      className={`inline-flex ${nowrap ? "flex-nowrap" : "flex-wrap"} items-baseline gap-x-1 tabular-nums ${SIZE[size]} ${TONE[model.direction]}`}
    >
      {/* 화살표·방향 글·첫 값을 한 덩어리로 — 화살표만 윗줄에 홀로 남지 않게(QA-595). */}
      <span className="inline-flex items-baseline gap-x-1 whitespace-nowrap">
        {arrow ? (
          <span aria-hidden="true" className="text-xs">
            {arrow}
          </span>
        ) : null}
        <span className="sr-only">{SPOKEN[model.direction]}</span>
        {amount ?? pct}
      </span>
      {amount ? pct : null}
    </span>
  );
}

/**
 * 표 칸의 변화 — 공용 변화 칩의 표 칸 꼴(작은 크기 sm·칸 안에서 꺾지 않음 nowrap). 변화량·변화율을 둘 다 모르면 공용 표가 모르는 칸에 그리는 것과 같은
 * '—'(Empty — 읽기는 '값 없음', 보조 글자색)을 그립니다 — 0.00%를 만들지 않습니다(작업대 P5a 검토 — 섹터·COT·매크로 표가 화면마다 따로 두던 감싸개를 하나로,
 * P5b 기관 표 등락 칸이 같은 것을 씀). 표 칸 안의 묶음(현재가 아래 오늘 등락 등)에도 그대로 둡니다. 값이 null이면 '—'와 사유를 스스로 그리는 자리(PropertyList
 * 값)에는 이것 대신 모를 때 null을 넘기고, 알 때만 `ChangeChip`을 둡니다.
 */
export function ChangeCell({
  change,
  changePct,
  digits = 2,
  pctDigits,
  unit,
}: {
  change?: number | null;
  changePct?: number | null;
  digits?: number;
  pctDigits?: number;
  unit?: string;
}): JSX.Element {
  if (isMissingValue(change) && isMissingValue(changePct)) {
    return (
      <span className="text-text-3">
        <Empty />
      </span>
    );
  }
  return <ChangeChip size="sm" nowrap change={change} changePct={changePct} digits={digits} pctDigits={pctDigits} unit={unit} />;
}
