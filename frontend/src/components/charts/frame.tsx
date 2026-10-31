import type { CSSProperties } from "react";

/*
 * 차트 틀(축·기준선·툴팁·글자 범례)을 두 차트 파일(index.tsx의 래퍼들·LineChart.tsx)이 함께 씁니다 — 격자 없는 단일 선 문법
 * (docs/specs/2026-10-31-v2-coinbase-ui.md §5). index.tsx가 LineChart.tsx를 다시 내보내므로 둘이 서로 가져오지 않게 여기에 둡니다.
 *
 * 색은 디자인 토큰 CSS 변수(globals.css)라 라이트·다크가 :root에서 함께 바뀝니다. Recharts 기본값(축 #666·커서 #ccc·글자 #808080)은
 * 테마를 모르므로 축·기준선·커서·글자마다 이 값을 넘겨 덮습니다. 글자는 text-3(표면 대비 라이트 5.1·다크 6.0:1), 선은 border·text-3.
 */
export const AXIS_TEXT = "var(--text-3)";
export const AXIS_LINE = "var(--border)";
/** 0선·경계선·커서 선 — 격자가 없으니 기준선이 유일한 가로선입니다. 축선(border)보다 진하게(text-3). */
export const GUIDE = "var(--text-3)";
/** 차트 SVG 글자 크기 — 최소 글자 단계(micro 12px, 명세 D9). 10·11px은 쓰지 않습니다. */
export const CHART_FONT = 12;

/**
 * 시계열 색.
 *
 * dataviz 검증기(scripts/validate_palette.js)를 라이트(#ffffff)·다크(#141619) 표면 모두에서 통과한 조합입니다(명세 §2-2).
 * 이전 조합(#58A6FF·#D29922·#F85149)은 적록색약에서 노랑↔빨강 ΔE가 5.8로
 * 구분 한계(6) 아래였습니다 — 화면에서도 두 선이 겹쳐 보였습니다.
 */
export const SERIES_COLORS = {
  blue: "#3987e5",
  orange: "#d95926",
  green: "#199e70",
} as const;

/**
 * 툴팁 상자 — 떠 있는 덮개라 덮개 그림자(--elev-overlay)와 control 모서리(12px), 불투명한 표면색(surface)으로 선·막대를 가립니다.
 * 테두리는 옅은 경계(border) — 다크에서는 그림자가 잘 안 보여 상자 끝을 테두리가 보입니다. 글자는 본문색(text), 계열 색은 입히지 않습니다.
 */
export const TOOLTIP_BOX: CSSProperties = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "var(--elev-overlay)",
  fontSize: 12,
  padding: "8px 10px",
  color: "var(--text)",
};

/** 축 끝 날짜 — 첫 날짜는 왼쪽 끝에 붙여(start), 마지막은 오른쪽 끝에 붙여(end) 그립니다. 가운데 정렬이면 SVG 밖으로 잘립니다. */
export function EdgeDateTick({
  x,
  y,
  payload,
  first,
  last,
  fontSize = CHART_FONT,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  first: string;
  last: string;
  fontSize?: number;
}) {
  const value = String(payload?.value ?? "");
  const anchor = first === last ? "middle" : value === first ? "start" : value === last ? "end" : "middle";
  return (
    <text x={Number(x) || 0} y={Number(y) || 0} dy="0.71em" textAnchor={anchor} fill={AXIS_TEXT} fontSize={fontSize}>
      {value}
    </text>
  );
}

/** 글자 범례 한 줄 — 색 짧은 선(점선 계열은 점선) + 이름. 색은 보조이고 이름이 본 뜻입니다. */
export type LegendEntry = { key: string; label: string; color: string; dashed?: boolean };

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
          <span
            aria-hidden="true"
            className="inline-block w-3"
            style={{ borderTop: `2px ${entry.dashed ? "dashed" : "solid"} ${entry.color}` }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
