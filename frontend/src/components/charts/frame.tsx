import type { CSSProperties } from "react";

/*
 * 차트 틀(축·기준선·격자·툴팁·글자 범례)을 두 차트 파일(index.tsx의 래퍼들·LineChart.tsx)이 함께 씁니다. 기본은 격자 없는 단일 선 문법
 * (docs/specs/2026-10-31-v2-coinbase-ui.md §5)이고, 큰 분석 차트만 옅은 가로 격자를 켭니다(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md
 * W6 — `grid`). index.tsx가 LineChart.tsx를 다시 내보내므로 둘이 서로 가져오지 않게 여기에 둡니다.
 *
 * 색은 디자인 토큰 CSS 변수(globals.css :root — 어두운 한 벌)입니다. Recharts 기본값(축 #666·커서 #ccc·글자 #808080)은
 * 토큰을 모르므로 축·기준선·커서·글자마다 이 값을 넘겨 덮습니다. 글자는 text-3(bg·surface 대비 6.4·5.6:1), 선은 border·text-3.
 */
export const AXIS_TEXT = "var(--text-3)";
export const AXIS_LINE = "var(--border)";
/** 0선·경계선·커서 선 — 격자보다 진한 기준선입니다. 축선(border)보다 진하게(text-3). */
export const GUIDE = "var(--text-3)";
/**
 * 옅은 격자 선(작업대 실행 명세 W6 — 1px 옅은 경계 border-subtle). 큰 분석 차트에서 `grid`를 켤 때의 가로선과 산점도 격자에만 씁니다 —
 * 스파크라인·히어로 차트에는 격자가 없습니다. 기준선(GUIDE)·축선(AXIS_LINE)보다 옅어 값 선과 0선을 가리지 않습니다.
 */
export const GRID_LINE = "var(--border-subtle)";
/**
 * 세로 격자를 그리지 않는 `CartesianGrid`(`vertical={false}`)에 주는 세로 좌표 생성기 — 늘 빈 목록. Recharts 3.10.1의 CartesianGrid는 세로 격자를 끈
 * 상태에서도 세로 좌표를 만들려고 X축 눈금 계산(getTicks)을 부르고, 그 계산이 날짜 눈금 글마다 DOM에 넣어 폭을 잽니다(measureTextWithDOM) — 매크로 화면을
 * 처음 열 때 CPU 4배 감속에서 약 0.9초(2026-11-22 프로파일, ADR 0047 결정 8). 세로 선은 원래 그리지 않으므로 그림은 같습니다.
 */
export const NO_VERTICAL_GRID = (): number[] => [];
/** 차트 SVG 글자 크기 — 최소 글자 단계(micro 12px, 명세 D9). 10·11px은 쓰지 않습니다. */
export const CHART_FONT = 12;

/**
 * 점선 두 가지 — 계산한 참고선(모의매매 한국의 노출 맞춘 참고선 K40, `MultiSeries.dashed`)은 "6 4", 장중 값 단계의 오늘 추정 꼬리(`tailOf`)는 더 잘게
 * "3 3". 둘이 한 그림에 함께 있어도 선 모양이 갈립니다(뜻은 이름 — 참고선은 범례 '…(계좌 아님)', 꼬리는 툴팁 '… · 추정 HH:MM' — 이 나름).
 */
export const REFERENCE_DASH = "6 4";
/**
 * 계산한 참고선의 표지 클래스 — 선(MultiLineSeries의 Line), 그 계열의 hover 점(activeDot circle — QA-509), 범례 견본에 붙입니다. 참고선 색은 토큰 밖
 * hex(모의매매 K40 #a7b0bd)라 고대비(forced-colors)의 밝은 Canvas 위에서 2.19:1이었고, globals.css의 고대비 블록이 이 표지로 CanvasText를 줍니다(QA-498).
 */
export const REFERENCE_LINE_CLASS = "chart-ref-line";
export const TAIL_DASH = "3 3";
/** 앞뒤가 모름인 외딴 값의 점 반지름 — 선(connectNulls=false)만으로는 사라지는 값을 점으로 남깁니다(두 선 차트가 같은 값). */
export const ISOLATED_DOT_R = 2.5;

/**
 * 시계열 색.
 *
 * dataviz 검증기(scripts/validate_palette.js)를 예전 라이트(#ffffff)·다크(#141619) 표면에서 통과했고, 어두운 한 벌의 두 면(surface #1c2127·
 * bg #111418)에서도 모든 쌍이 통과합니다(색약 ΔE 최소 9.4·정상 시각 20.9, 대비 4.17~5.42 — 작업대 실행 명세 §3-5 기록).
 * 이전 조합(#58A6FF·#D29922·#F85149)은 적록색약에서 노랑↔빨강 ΔE가 5.8로
 * 구분 한계(6) 아래였습니다 — 화면에서도 두 선이 겹쳐 보였습니다.
 */
export const SERIES_COLORS = {
  blue: "#3987e5",
  orange: "#d95926",
  green: "#199e70",
} as const;

/**
 * 툴팁 상자 — 떠 있는 덮개(실행 명세 §3-3 3층): 바탕 surface-2(text-3 대비 5.0)·안쪽 밝은 1px 경계(border-overlay — 대화상자·토스트·맨 위로
 * 단추와 같은 토큰)·덮개 그림자(--elev-overlay)·4px 모서리(§3-5)이고, 불투명해서 선·막대를 가립니다. 어두운 면에서는 그림자가 잘 안 보여 경계가
 * 상자 끝을 보입니다(패널 경계 border였을 때 surface 위 1.50, border-overlay 1.64 [계산]). 글자는 본문색(text), 계열 색은 입히지 않습니다 —
 * 예외는 `MultiLineSeries`의 선택 `tooltipSeriesColors`(기관 13F 비중 추이·모의매매 순자산 곡선·환율 비교·COT 포지셔닝 추이 — 줄 글자를 선 색으로, 대비 4.5:1이
 * 모자란 색은 `lib/chartTooltip readableOn`이 밝힘).
 */
export const TOOLTIP_BOX: CSSProperties = {
  backgroundColor: "var(--surface-2)",
  border: "1px solid var(--border-overlay)",
  borderRadius: 4,
  boxShadow: "var(--elev-overlay)",
  fontSize: 12,
  padding: "8px 10px",
  color: "var(--text)",
};

/**
 * X 날짜 눈금 — 첫 날짜는 왼쪽 끝에 붙여(start), 마지막은 오른쪽 끝에 붙여(end), 중간 눈금은 가운데 맞춤으로 그립니다. 끝 글을 가운데 정렬하면
 * SVG 밖으로 잘립니다. `labels`(선택)는 눈금 행의 date → 적을 글(중간 눈금의 짧은 글 — `lib/lineChart` `lineXAxis`), 없으면 date 그대로.
 */
export function EdgeDateTick({
  x,
  y,
  payload,
  first,
  last,
  labels,
  fontSize = CHART_FONT,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  first: string;
  last: string;
  labels?: Readonly<Record<string, string>>;
  fontSize?: number;
}) {
  const value = String(payload?.value ?? "");
  const anchor = first === last ? "middle" : value === first ? "start" : value === last ? "end" : "middle";
  return (
    <text x={Number(x) || 0} y={Number(y) || 0} dy="0.71em" textAnchor={anchor} fill={AXIS_TEXT} fontSize={fontSize}>
      {labels?.[value] ?? value}
    </text>
  );
}

/**
 * 글자 범례 한 줄 — 색 짧은 선(점선 계열은 그림 선과 같은 점선 REFERENCE_DASH) + 이름. 색은 보조이고 이름이 본 뜻입니다.
 * 견본은 SVG 선(16px — 점선 한 주기 6 + 4 + 6)입니다. CSS 테두리(border-top dashed, 12px)는 크롬이 굵기 2px에서 토막 6 x 2 이하 길이를
 * 실선으로 칠해 점선 견본이 실선 토막이 됐습니다(QA-496 — 테두리 점선 모양은 엔진마다 다름).
 * 고대비(forced-colors)에서도 견본은 그림 선과 같은 계열 색입니다(forced-color-adjust-none) — 그 모드에서 SVG 선은 작성자 색이 남는데 견본만
 * 시스템 색이 되면 이름과 선을 맞출 수 없었습니다(QA-497).
 */
export type LegendEntry = { key: string; label: string; color: string; dashed?: boolean };

/** 범례 견본 길이(px) — 점선 REFERENCE_DASH("6 4")의 한 주기와 토막 하나(6 + 4 + 6). 실선 견본도 같은 길이로 맞춰 범례 줄을 고르게 둡니다. */
const LEGEND_SWATCH_WIDTH = 16;

/**
 * 글자 범례 — 그림 위에 둡니다(Recharts Legend 대신). 이름 글자에는 계열 색을 입히지 않습니다(글자 대비).
 * 두 줄 이상일 때만 그립니다 — 한 줄이면 카드 제목이 이름을 나릅니다.
 */
export function ChartLegend({ entries }: { entries: readonly LegendEntry[] }) {
  if (entries.length < 2) {
    return null;
  }
  return (
    <ul aria-label="범례" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2">
      {entries.map((entry) => (
        <li key={entry.key} className="inline-flex items-center gap-1.5">
          <svg
            aria-hidden="true"
            width={LEGEND_SWATCH_WIDTH}
            height={2}
            className={`shrink-0 forced-color-adjust-none${entry.dashed ? ` ${REFERENCE_LINE_CLASS}` : ""}`}
          >
            <line
              x1={0}
              y1={1}
              x2={LEGEND_SWATCH_WIDTH}
              y2={1}
              stroke={entry.color}
              strokeWidth={2}
              strokeDasharray={entry.dashed ? REFERENCE_DASH : undefined}
            />
          </svg>
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
