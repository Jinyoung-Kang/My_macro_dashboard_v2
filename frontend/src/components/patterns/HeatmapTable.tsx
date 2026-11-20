"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { heatmapStep, SEQUENTIAL_STEPS, SEQUENTIAL_TEXT } from "@/lib/heatmap";

import { Empty } from "./Empty";
import { useScrollRegion } from "./useScrollRegion";

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
 * - 영역 이름은 `${caption} (좌우 스크롤)`(가로로 스크롤하는 상자 — 키보드로도 옮길 수 있게 Tab 정지점). 표가 상자에 들어가면 정지점·영역이 없습니다
 *   (공용 계약 useScrollRegion — 재기 전·잴 수 없으면 정지점을 둠, QA-939).
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
 * - 표 최소 폭: `minWidth`(px)를 주면 그 폭, 주지 않으면 열 수에 맞춘 '행 머리 128 + 열 수 × 64'px(상한 640 — 열 여덟부터 640, 아래 `defaultMinWidth`).
 *   예전에는 열 수와 상관없이 640px라 열이 적으면 고정 행 머리가 표 폭 대부분을 받아 값 칸이 가려졌습니다(QA-729).
 * - 빈 상태: 행이나 열이 없으면 표·범례 없이 `emptyText` 한 줄(기본 '표시할 값이 없습니다.' — 0으로 채운 표를 만들지 않음). 비중 히트맵은 그 전에 제 빈 글을 그립니다.
 * - 넘김 안내(공용 DataTable `scrollHint="overflow"`와 같은 글·규칙): 상자 위 '← 표를 좌우로 넘겨 보세요'(aria-hidden — 낭독기에는 영역 이름이 같은 말을 함)를
 *   폰(sm 미만 — 최소 폭보다 좁음)에서는 늘, 그 밖에서는 상자 폭을 재서 표가 넓을 때만 보입니다. 처음 재기는 그리기 전(layout effect)이라 안내가 나중에 끼어들어
 *   표를 밀지 않고, 그 뒤 폭이 바뀌면 ResizeObserver로 다시 잽니다. 예전에는 안내가 없어 1024(메뉴 220 — 두 칸 틀 가운데 482px)에서 가려진 열이 있다는 단서가
 *   없었습니다(QA-713). '폰에서는 늘'은 최소 폭이 640px 이상일 때만입니다 — 열이 적어 더 좁은 표는 폰 상자에도 들어갈 수 있어 잰 넘침으로만 보입니다(QA-729).
 * - `initialScroll="end"`(선택, 기본 "start"): 처음 그릴 때(와 열이 바뀔 때) 스크롤을 오른쪽 끝에 둡니다 — 열이 시간 차례인 표(비중 히트맵의 분기)에서 가장
 *   최근 열이 먼저 보이게. 끝에 붙어 있는 동안 상자·표 폭이 바뀌면(메뉴 접기·펴기 — 폭 전환 중에도, 창 크기 — 끄는 동안에도) 다시 끝으로 옮기고, 사용자가
 *   왼쪽으로 옮긴 뒤에는 그 자리를 지킵니다(브라우저가 끝으로 줄인 자리는 그 폭의 끝이라 다시 붙음). 예전에는 폭이 바뀌어도 그대로라 메뉴를
 *   펴면 0, 창을 줄이면 옛 끝에 남았고(QA-722), 그 고침도 부품이 쓴 자리의 scroll 이벤트(다음 프레임에 옴)를 사용자 이동으로 읽어 폭이 프레임마다 바뀌는
 *   동안(메뉴 폭 전환 150ms·창 끌기)에는 붙음이 풀렸습니다(QA-722 보강 — 이제 그 자리와 1px 안의 이벤트는 붙음을 바꾸지 않음).
 *   표가 상자에 들어가는 폭(넘침 1px 이하)을 재면 붙음을 참으로 둡니다 — 그 폭에서는 모든 열이 보이고 끝 = 처음이라 사용자 자리가 따로 없습니다. 예전에는
 *   scroll 이벤트로만 다시 붙어, 사용자가 0에 둔 자리는 들어가는 폭을 지나도(줄일 것이 없어 이벤트 없음) 풀린 채 남아 다시 좁히면 0, 40에 둔 자리는 브라우저가
 *   0으로 줄인 이벤트로 붙어 끝으로 가 둘이 달랐습니다(QA-730 — 2026-11-18 결정: 둘 다 끝).
 *   알려진 한계: 창을 넓혔다가 그 폭이 한 번도 그려지지 않은 채 곧바로 좁히면(개발자 도구 기기 모드 같은 에뮬레이션 경로에서만 재현 — 실제 창 크기·메뉴는
 *   아님) 넓은 폭에서 브라우저가 줄인 자리의 scroll 이벤트가 좁아진 뒤 와 사용자 이동으로 읽혀 붙음이 풀립니다. 사용자 이동을 입력(휠·키·끌기) 표시로만 가리면
 *   찾기(Ctrl+F)·낭독기·scrollIntoView의 정당한 이동까지 끝으로 되돌리므로 그대로 둡니다.
 *   행 머리는 왼쪽에 붙어 남고(sticky), 범례·설명 글도 상자 왼쪽에 붙어 남습니다(sticky — 스크롤해도 보임).
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
  const [overflowing, setOverflowing] = useState(false);
  // 표를 그리는지 — 빈 상태에는 스크롤 상자가 없어, 빈 상태로 먼저 그려진 뒤 행이 오면 아래 두 효과가 다시 돌아야 합니다(QA-720).
  const hasTable = rows.length > 0 && columns.length > 0;
  // 스크롤 상자 — 넘칠 때만 Tab 정지점·이름 있는 영역(공용 계약 useScrollRegion, QA-939). 아래 재기(안내·끝 자리)와 같은 상자를 봅니다.
  const boxRef = useRef<HTMLDivElement>(null);
  const { regionProps } = useScrollRegion(boxRef, `${caption} (좌우 스크롤)`, { axis: "x", enabled: hasTable });
  // 스크롤이 오른쪽 끝에 붙어 있는지(initialScroll="end"일 때만 씀) — 폭이 바뀌면 붙어 있던 때만 다시 끝으로 옮깁니다(QA-722). 상자의 scroll 이벤트로 갱신하므로
  // 사용자가 왼쪽으로 옮기면 풀리고, 브라우저가 줄인 자리가 끝이면 다시 붙습니다. 표가 상자에 들어가는 폭은 재기(measure)가 다시 붙입니다(QA-730).
  const pinnedEnd = useRef(initialScroll === "end");
  // 이 부품이 마지막으로 쓴 스크롤 자리(끝으로 옮길 때) — 그 쓰기의 scroll 이벤트는 다음 프레임에 와서, 그 사이 폭이 더 바뀌면(메뉴 폭 전환·창 끌기) 그때의 끝보다
  // 작아 사용자가 옮긴 것처럼 읽혔습니다(QA-722 보강). 이 자리와 1px 안의 이벤트는 붙음을 바꾸지 않고, 다른 자리의 이벤트(사용자 이동·브라우저가 줄인 자리)가 오면 비웁니다.
  const writtenLeft = useRef<number | null>(null);
  // 표가 상자보다 넓은지 — 그리기 전에 한 번 재고(안내가 뒤늦게 끼어들어 표를 밀지 않게), 그 뒤 폭이 바뀌면 다시 잽니다. 끝에 붙어 있었으면 새 끝으로 옮깁니다.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const followEnd = initialScroll === "end";
    const measure = () => {
      const fits = box.scrollWidth - box.clientWidth <= 1;
      setOverflowing(!fits);
      // 표가 상자에 들어가면 끝 = 처음이라 사용자 자리가 따로 없습니다 — 붙음을 참으로 둡니다. 자리가 이미 0이면 scroll 이벤트가 오지 않아, 이벤트로만 정하면
      // 사용자가 0에 둔 자리는 들어가는 폭을 지나도 풀린 채 남았습니다(QA-730).
      if (followEnd && fits) pinnedEnd.current = true;
      if (followEnd && pinnedEnd.current) {
        box.scrollLeft = Math.max(0, box.scrollWidth - box.clientWidth);
        writtenLeft.current = box.scrollLeft;
      }
    };
    const onScroll = () => {
      const written = writtenLeft.current;
      if (written !== null && Math.abs(box.scrollLeft - written) <= 1) return;
      writtenLeft.current = null;
      pinnedEnd.current = box.scrollLeft >= box.scrollWidth - box.clientWidth - 1;
    };
    measure();
    if (followEnd) box.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    if (observer && box.firstElementChild) observer.observe(box.firstElementChild);
    return () => {
      observer?.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [hasTable, initialScroll]);
  // 처음 스크롤 자리 — 열이 바뀌거나(다른 기관의 분기) 빈 상태에서 표가 생기면 다시 맞춥니다(끝에 다시 붙음).
  const columnKeys = columns.map((column) => column.key).join("\u0000");
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || initialScroll !== "end") return;
    box.scrollLeft = Math.max(0, box.scrollWidth - box.clientWidth);
    writtenLeft.current = box.scrollLeft;
    pinnedEnd.current = true;
  }, [initialScroll, columnKeys, hasTable]);

  if (!hasTable) {
    return <div className="py-6 text-center text-sm text-text-3">{emptyText}</div>;
  }

  const tableMinWidth = minWidth ?? defaultMinWidth(columns.length);
  // 넘치지 않을 때 안내를 폰에서는 남길지 — sm 미만 화면의 상자는 640px보다 좁아 최소 폭이 그 이상인 표는 늘 넘칩니다. 더 좁은 표(열이 적은 기본 폭)는 폰에서도
  // 들어갈 수 있어(390 상자 332px에 열 둘 256px) 잰 넘침으로만 보입니다(QA-729).
  const hintClass = overflowing ? "" : tableMinWidth >= SM_BREAKPOINT ? "sm:hidden" : "hidden";

  return (
    <div className="min-w-0">
      <p aria-hidden="true" className={`mb-1 text-xs text-text-3 ${hintClass}`}>
        ← 표를 좌우로 넘겨 보세요
      </p>
      <div ref={boxRef} className="overflow-x-auto" {...regionProps}>
        <table className="w-full border-collapse text-xs" style={{ minWidth: tableMinWidth }}>
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

/** Tailwind sm 경계(640px) — 그보다 좁은 화면의 표 상자는 640px보다 좁습니다. */
const SM_BREAKPOINT = 640;
/** 기본 최소 폭의 상한 — 열 여덟(13F 비중 히트맵 8분기)부터 이 폭이고, 그보다 넓은 몫은 표 자동 배치가 열 내용 폭으로 정합니다. */
const DEFAULT_MIN_WIDTH_CAP = 640;
/** 기본 최소 폭의 행 머리 몫·열 몫 — P5b QA 재확인(qa@01693937)에서 잰 8분기 비중 히트맵(최소 640px)의 행 머리 128px·분기 열 64px(날짜 머리 '25-09-30'
 * 한 줄 + 좌우 여백 16px — 값 칸보다 넓음). 8 × 64 + 128 = 640이라 열 여덟의 표는 예전과 같습니다. */
const ROW_HEADER_SHARE = 128;
const COLUMN_SHARE = 64;

/**
 * `minWidth`를 주지 않은 표의 최소 폭(px) — 행 머리 몫 + 열 수 × 열 몫, 상한 640(QA-729).
 *
 * 예전에는 열 수와 상관없이 640px였고, 표 자동 배치는 그 폭에서 열의 max-content 합보다 남는 폭을 max-content 비율로 나눠 고정(sticky) 행 머리(긴 종목
 * 이름)가 대부분을 받았습니다 — 비중 히트맵 행 머리 4분기 260·2분기 370·1분기 469px. 390(상자 332px)에서 분기 2·1이면 값 칸이 어느 스크롤 자리에서도
 * 보이지 않고 끝 자리에서 행 머리가 왼쪽으로 잘렸으며, 1024(상자 482px) 분기 1은 값 띠 13px였습니다. 이제 열이 적으면 표가 상자에 들어가 스크롤이 없고
 * (정적 페이지로 잰 390 분기 1·2, 1024 분기 1·2·4), 넘칠 때는 이 최소 폭에서 행 머리가 128px 안팎(가장 긴 낱말이 더 넓으면 그 폭)입니다(390 분기 4 — 표 384px).
 * 행 머리 최대 폭은 따로 두지 않습니다(이름 말줄임 없음 — 넘칠 때 행 머리를 키우던 것은 이 최소 폭이었음).
 */
function defaultMinWidth(columnCount: number): number {
  return Math.min(DEFAULT_MIN_WIDTH_CAP, ROW_HEADER_SHARE + columnCount * COLUMN_SHARE);
}
