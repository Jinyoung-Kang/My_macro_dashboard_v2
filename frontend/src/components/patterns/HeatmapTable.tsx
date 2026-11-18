"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { heatmapStep, SEQUENTIAL_STEPS, SEQUENTIAL_TEXT } from "@/lib/heatmap";

import { Empty } from "./Empty";

/*
 * 표 히트맵 — 데이터를 그리는 패턴(Recharts를 쓰지 않는 표 — 크기 고정 ChartSizeHold와 무관). 화면은 패턴 배럴(`@/components/patterns`)에서 가져옵니다.
 * 비중 히트맵(WeightHeatmap — 13F 화면)은 차트 모듈(components/charts/WeightHeatmap.tsx)의 감싸개로 남아, 화면 시험의 vi.mock("@/components/charts")가 그대로
 * 그것만 뺍니다(P5b 검토 — 처음에는 그 모의 때문에 표 전체를 차트 모듈에 두었음).
 */

/**
 * 히트맵 열 하나 — `label`은 머리 글, `title`은 전체 이름(머리 칸과 그 열 칸의 마우스 설명 — 없으면 `label`), `nowrap`은 머리 글을 줄바꿈하지 않음(날짜 —
 * 하이픈 뒤에서 '24-09-' / '30'처럼 꺾이지 않게. 주지 않으면 한글 낱말 사이에서만 꺾음).
 */
export type HeatmapColumn = { key: string; label: string; title?: string; nowrap?: boolean };

/**
 * 히트맵 행 하나 — `label`은 첫 열(행 머리) 글, `title`은 전체 이름(없으면 `label`), `values`는 열 차례의 값(모름은 null·undefined, 열보다 짧으면 모자란 칸도 모름),
 * `selfIndex`는 자기 자신과 견준 칸(기관 간 유사도의 대각선 — 늘 최대라 칠하면 그 줄만 눈에 띔)의 열 번호.
 */
export type HeatmapRow = {
  key: string;
  label: string;
  title?: string;
  values: readonly (number | null | undefined)[];
  selfIndex?: number | null;
};

/**
 * 표 히트맵 — 행 × 열 값을 칸에 적고 값의 크기를 칸 바탕의 순차 팔레트 단계로 칠합니다. 색만으로 값을 나르지 않도록 칸 안에 숫자도 함께 적습니다.
 *
 * - 영역 이름은 `${caption} (좌우 스크롤)`(가로로 스크롤하는 상자 — 키보드로도 옮길 수 있게 Tab 정지점).
 * - 칸 바탕은 순차 팔레트 다섯 단계(lib/heatmap — 명세 §3-5, 어두운 단계 = 0에 가까움 → 밝은 단계 = 큼): 값 ÷ `max`가 (0, 0.2]면 단계 1 … (0.8, 1]이면 5.
 *   칸 글자색은 단계마다 정해 두었습니다(단계 1~3 본문색·4~5 바탕색 — 모두 4.5:1 이상). 칠한 칸에는 `data-step`(1~5)을 붙입니다.
 *   고대비(forced-colors)에서도 단계가 남게 칠한 칸과 범례 견본은 색을 시스템 색으로 바꾸지 않습니다(forced-color-adjust: none — 글자·바탕 쌍이 4.5:1 이상이라 그대로 읽힘).
 * - 값을 모르는 칸(null·undefined·유한하지 않은 수)은 공용 '—'(Empty — 낭독 '값 없음'), 0인 칸은 `zeroText`(주면 — 보이는 기호 `text`는 읽기에서 빼고 낭독 글 `sr`을
 *   읽음, 예: 비중의 '·' = '보유하지 않음' — QA-717), 둘 다 칠하지 않습니다.
 *   0 이하·`max`가 0 이하도 칠하지 않습니다. 자기 칸(`selfIndex`)은 단계 대신 중립 바탕(surface-2)·보조 글자색입니다.
 * - 표 구조: 낭독용 표 이름(sr-only caption = `caption`), 열 머리(th scope=col — 전체 이름은 title), 첫 열은 행 머리(th scope=row — 가로 스크롤 때 왼쪽에 붙어 남음).
 *   머리 칸 글(열 머리·행 머리)은 한글을 낱말 사이에서만 꺾습니다(break-keep — 공용 글 부품 규약 QA-568). 없으면 최소 폭(minWidth)에 눌린 열에서 기관 이름이
 *   '노르웨|이 국부|펀드'처럼 글자 사이에서 꺾였습니다(스타일 화면 유사도 행렬 — 옮기기 전 행렬은 줄바꿈 금지였음). 영문·숫자 머리(비중 히트맵의 공시 이름·날짜)는
 *   그대로입니다.
 * - 범례(표 아래): 단계 견본 다섯(장식) + 단계 글(`legend.stepLabel` — 예 '최댓값의 0~20%') + '밝은 단계일수록 큼', 그 아래 `legend.note`(설명 글).
 * - `minWidth`(px)를 주지 않으면 표 최소 폭 640px입니다.
 * - 빈 상태: 행이나 열이 없으면 표·범례 없이 `emptyText` 한 줄(기본 '표시할 값이 없습니다.' — 0으로 채운 표를 만들지 않음). 비중 히트맵은 그 전에 제 빈 글을 그립니다.
 * - 넘김 안내(공용 DataTable `scrollHint="overflow"`와 같은 글·규칙): 상자 위 '← 표를 좌우로 넘겨 보세요'(aria-hidden — 낭독기에는 영역 이름이 같은 말을 함)를
 *   폰(sm 미만 — 최소 폭보다 좁음)에서는 늘, 그 밖에서는 상자 폭을 재서 표가 넓을 때만 보입니다. 처음 재기는 그리기 전(layout effect)이라 안내가 나중에 끼어들어
 *   표를 밀지 않고, 그 뒤 폭이 바뀌면 ResizeObserver로 다시 잽니다. 예전에는 안내가 없어 1024(메뉴 220 — 두 칸 틀 가운데 482px)에서 가려진 열이 있다는 단서가
 *   없었습니다(QA-713).
 * - `initialScroll="end"`(선택, 기본 "start"): 처음 그릴 때(와 열이 바뀔 때) 스크롤을 오른쪽 끝에 둡니다 — 열이 시간 차례인 표(비중 히트맵의 분기)에서 가장
 *   최근 열이 먼저 보이게. 행 머리는 왼쪽에 붙어 남고(sticky), 범례·설명 글도 상자 왼쪽에 붙어 남습니다(sticky — 스크롤해도 보임).
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
  initialScroll = "start",
  emptyText = "표시할 값이 없습니다.",
}: {
  caption: string;
  rowHeader: string;
  columns: readonly HeatmapColumn[];
  rows: readonly HeatmapRow[];
  max: number;
  format: (value: number) => string;
  /** 0인 칸의 글 — 보이는 기호(`text`)와 낭독 글(`sr`). 주지 않으면 0도 `format`대로. */
  zeroText?: { text: string; sr: string };
  legend: { stepLabel: (step: 1 | 2 | 3 | 4 | 5) => string; note?: ReactNode };
  minWidth?: number;
  /** 처음 스크롤 자리 — "end"면 오른쪽 끝(가장 최근 열). */
  initialScroll?: "start" | "end";
  /** 행이나 열이 없을 때의 한 줄. */
  emptyText?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // 표를 그리는지 — 빈 상태에는 스크롤 상자가 없어, 빈 상태로 먼저 그려진 뒤 행이 오면 아래 두 효과가 다시 돌아야 합니다(QA-720).
  const hasTable = rows.length > 0 && columns.length > 0;
  // 표가 상자보다 넓은지 — 그리기 전에 한 번 재고(안내가 뒤늦게 끼어들어 표를 밀지 않게), 그 뒤 폭이 바뀌면 다시 잽니다.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => setOverflowing(box.scrollWidth > box.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [hasTable]);
  // 처음 스크롤 자리 — 열이 바뀌거나(다른 기관의 분기) 빈 상태에서 표가 생기면 다시 맞춥니다.
  const columnKeys = columns.map((column) => column.key).join("\u0000");
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || initialScroll !== "end") return;
    box.scrollLeft = Math.max(0, box.scrollWidth - box.clientWidth);
  }, [initialScroll, columnKeys, hasTable]);

  if (!hasTable) {
    return <div className="py-6 text-center text-sm text-text-3">{emptyText}</div>;
  }

  return (
    <div className="min-w-0">
      <p aria-hidden="true" className={`mb-1 text-xs text-text-3 ${overflowing ? "" : "sm:hidden"}`}>
        ← 표를 좌우로 넘겨 보세요
      </p>
      <div ref={boxRef} className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${caption} (좌우 스크롤)`}>
        <table
          className={minWidth === undefined ? "w-full min-w-[640px] border-collapse text-xs" : "w-full border-collapse text-xs"}
          style={minWidth === undefined ? undefined : { minWidth }}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-xs text-text-3">
              <th scope="col" className="sticky left-0 break-keep bg-surface px-3 py-2 text-left font-medium">
                {rowHeader}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  title={column.title}
                  className={`${column.nowrap ? "whitespace-nowrap" : "break-keep"} px-2 py-2 text-right font-medium tabular-nums`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" title={row.title} className="sticky left-0 break-keep bg-surface px-3 py-1.5 text-left font-normal text-text-2">
                  {row.label}
                </th>
                {columns.map((column, index) => {
                  const raw = row.values[index];
                  // 유한하지 않은 수는 값을 모르는 것과 같게 봅니다(0으로 채우지 않음).
                  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
                  const self = row.selfIndex === index;
                  // 0인 칸은 "데이터 없음"이 아니라 그 값이 0이라는 뜻입니다(비중이면 그 분기에 보유하지 않음) — 칠하지 않습니다.
                  const step = self ? 0 : heatmapStep(value, max);
                  const title = `${row.title ?? row.label} · ${column.title ?? column.label}`;
                  // 0 칸의 기호는 읽기에서 빼고 뜻을 읽힙니다(기호만이면 낭독기가 읽지 않거나 '가운뎃점'으로 읽어 모름 칸과 갈리지 않았음 — QA-717). 바깥 span은
                  // relative — 안의 sr-only(절대 위치)가 가로 스크롤 상자 밖으로 빠져 문서 폭을 넓히지 않게(공용 Empty와 같은 까닭).
                  const text =
                    value === null ? (
                      <Empty align="end" />
                    ) : value === 0 && zeroText !== undefined ? (
                      <span className="relative">
                        <span aria-hidden="true">{zeroText.text}</span>
                        <span className="sr-only">{zeroText.sr}</span>
                      </span>
                    ) : (
                      format(value)
                    );
                  if (self) {
                    return (
                      <td key={column.key} className="bg-surface-2 px-2 py-1.5 text-right tabular-nums text-text-2" title={title}>
                        {text}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={column.key}
                      data-step={step === 0 ? undefined : step}
                      className={step === 0 ? "px-2 py-1.5 text-right tabular-nums" : "px-2 py-1.5 text-right tabular-nums forced-color-adjust-none"}
                      style={step === 0 ? undefined : { backgroundColor: SEQUENTIAL_STEPS[step - 1], color: SEQUENTIAL_TEXT[step - 1] }}
                      title={title}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {/* 범례·설명은 상자 왼쪽에 붙여 둡니다(sticky) — 스크롤한 자리(initialScroll="end" 등)에서도 보이게. */}
        <ul aria-label="칸 색 단계" className="sticky left-0 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
          {STEPS.map((step) => (
            <li key={step} className="inline-flex items-center gap-1 tabular-nums">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none"
                style={{ backgroundColor: SEQUENTIAL_STEPS[step - 1] }}
              />
              {legend.stepLabel(step)}
            </li>
          ))}
          <li>밝은 단계일수록 큼</li>
        </ul>
        {legend.note ? <p className="sticky left-0 mt-1 text-xs text-text-3">{legend.note}</p> : null}
      </div>
    </div>
  );
}

/** 범례의 단계 차례. */
const STEPS = [1, 2, 3, 4, 5] as const;
