import type { ReactNode } from "react";

import { EMPTY, formatNumber, formatWeightPercent } from "@/lib/format";

/*
 * 표 히트맵 — 차트 모듈 안의 표(Recharts를 쓰지 않음 — 크기 고정 ChartSizeHold와 무관). 화면은 `@/components/charts`에서 가져옵니다(index가 다시 내보냄).
 * 패턴 배럴이 아니라 차트 모듈에 두는 까닭: 화면 시험이 vi.mock("@/components/charts")로 히트맵을 빼고 있어(WeightHeatmap을 null로 바꾸는 시험 여섯 파일 —
 * 13F 포트폴리오 화면을 그리는 셋 포함), 자리를 옮기면 그 시험들에서 실제 표가 그려져 같은 이름을 찾는 단언이 여럿을 찾게 됩니다.
 */

/** 히트맵 열 하나 — `label`은 머리 글, `title`은 칸 마우스 설명에 쓰는 전체 이름(없으면 `label`). */
export type HeatmapColumn = { key: string; label: string; title?: string };

/** 히트맵 행 하나 — `label`은 첫 열 글, `title`은 전체 이름(없으면 `label`), `values`는 열 차례의 값(모름은 null·undefined). */
export type HeatmapRow = { key: string; label: string; title?: string; values: readonly (number | null | undefined)[] };

/**
 * 표 히트맵 — 행 × 열 값을 칸에 적고 값의 크기를 칸 바탕으로 칠합니다. 색만으로 값을 나르지 않도록 칸 안에 숫자도 함께 적습니다.
 *
 * - 영역 이름은 `${caption} (좌우 스크롤)`(가로로 스크롤하는 상자 — 키보드로도 옮길 수 있게 Tab 정지점).
 * - 값을 모르는 칸은 '—', 0인 칸은 `zeroText`(주면 — 예: 비중의 '·' 미보유), 둘 다 칠하지 않습니다. 0보다 큰 값만 `max`에 견준 크기로 칠합니다.
 * - 첫 열(`rowHeader`)은 가로 스크롤 때 왼쪽에 붙어 남습니다.
 * - `legend.note`는 표 아래 설명 글입니다.
 * - `minWidth`(px)를 주지 않으면 표 최소 폭 640px입니다.
 */
export function HeatmapTable({
  caption,
  rowHeader,
  columns,
  rows,
  max,
  format,
  zeroText,
  legend,
  minWidth,
}: {
  caption: string;
  rowHeader: string;
  columns: readonly HeatmapColumn[];
  rows: readonly HeatmapRow[];
  max: number;
  format: (value: number) => string;
  zeroText?: string;
  legend: { note?: ReactNode };
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${caption} (좌우 스크롤)`}>
      <table
        className={minWidth === undefined ? "w-full min-w-[640px] border-collapse text-xs" : "w-full border-collapse text-xs"}
        style={minWidth === undefined ? undefined : { minWidth }}
      >
        <thead>
          <tr className="text-xs text-text-3">
            <th className="sticky left-0 bg-surface px-3 py-2 text-left font-medium">{rowHeader}</th>
            {columns.map((column) => (
              <th key={column.key} className="px-2 py-2 text-right font-medium tabular-nums">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td title={row.title} className="sticky left-0 bg-surface px-3 py-1.5 text-left text-text-2">{row.label}</td>
              {row.values.map((value, index) => {
                const column = columns[index];
                // 0인 칸은 "데이터 없음"이 아니라 그 값이 0이라는 뜻입니다(비중이면 그 분기에 보유하지 않음).
                const ratio = typeof value === "number" && max > 0 ? value / max : 0;
                return (
                  <td
                    key={`${row.key}-${column?.key ?? index}`}
                    className="px-2 py-1.5 text-right tabular-nums"
                    style={{
                      backgroundColor:
                        typeof value === "number" && value > 0
                          ? `rgba(57, 135, 229, ${0.08 + ratio * 0.62})`
                          : "transparent",
                      // 칠한 칸의 숫자는 본문색(text) — 농도 전 범위(불투명도 0.08~0.70)에서 패널 면(surface) 위 13.7~5.3:1(WCAG AA 4.5:1).
                      // 보조 글자색(text-2)은 가장 진한 칸에서 3.5:1이라 쓰지 않습니다.
                      color: typeof value === "number" && value > 0 ? "var(--text)" : undefined,
                    }}
                    title={`${row.title ?? row.label} · ${column ? column.title ?? column.label : ""}`}
                  >
                    {typeof value === "number"
                      ? value === 0 && zeroText !== undefined
                        ? zeroText
                        : format(value)
                      : EMPTY}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-3">{legend.note}</p>
    </div>
  );
}

/**
 * 비중 히트맵 — 분기마다 어느 종목의 비중이 커지고 줄었는지(13F 포트폴리오 화면). 표 히트맵(`HeatmapTable`)의 감싸개입니다.
 *
 * <p>선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉킵니다. 값의 크기를
 * 색 농도로 칠하면 "어느 칸이 진해지는가"만 보면 됩니다.
 *
 * <p>색만으로 값을 나르지 않도록 <b>칸 안에 숫자도 함께</b> 적습니다.
 */
export function WeightHeatmap({
  dates,
  series,
  unit = "%",
}: {
  dates: string[];
  series: Record<string, (number | null)[]>;
  unit?: string;
}) {
  const names = Object.keys(series);
  if (names.length === 0 || dates.length === 0) {
    return <div className="py-10 text-center text-sm text-text-3">표시할 비중 이력이 없습니다.</div>;
  }

  const values = names.flatMap((name) => series[name] ?? []);
  const max = Math.max(...values.filter((v): v is number => typeof v === "number"), 0);

  return (
    <HeatmapTable
      caption="비중 히트맵"
      rowHeader="종목"
      columns={dates.map((date) => ({ key: date, label: date.slice(2), title: date }))}
      rows={names.map((name) => ({
        key: name,
        label: name,
        // 13F 비중에는 0보다 작은 값이 없습니다 — 혹시 0보다 크지 않은 수가 오면 예전처럼 0과 같은 '·'(그 분기에 보유하지 않음)로 적습니다.
        values: (series[name] ?? []).map((value) => (typeof value === "number" && !(value > 0) ? 0 : value)),
      }))}
      max={max}
      // 들고 있었지만 0.05% 미만인 칸은 '<0.1%' — '0.0%'면 미보유('·')처럼 없는 값으로 읽힙니다(QA-454).
      format={(value) => (unit === "%" ? formatWeightPercent(value, 1) : `${formatNumber(value, 1)}${unit}`)}
      // 0%는 "미보유"입니다. 값을 모르는 것(EMPTY)과 같은 기호를 쓰면 둘을 구분할 수 없습니다.
      zeroText="·"
      legend={{
        note: (
          <>
            색이 진할수록 비중이 큽니다. &quot;·&quot;는 그 분기에 <b>보유하지 않았다</b>는 뜻이고,
            &quot;{EMPTY}&quot;는 <b>값을 모른다</b>는 뜻입니다 — 둘은 다릅니다.
          </>
        ),
      }}
    />
  );
}
