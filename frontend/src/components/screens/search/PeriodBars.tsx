"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { NativeSelect } from "@/components/ui";
import {
  PERIOD_BARS_NOTE,
  periodAriaLabel,
  periodLabel,
  periodTickLabel,
  type PeriodBarsView,
  type PeriodBin,
} from "@/lib/infoSearch";
import { BUTTON } from "./parts";

/**
 * 결과 위의 기간 막대(계약 §9-1) — 고른 기간의 건수를 7일·30일은 하루씩, 1년·2년은 주(월요일 시작, KST)마다 세로 막대로 둡니다. 새 의존성 없이
 * div로 그립니다. 건수는 지금 탭·거르기를 거친 줄(묶어 보기와 상관없이 줄 수)이고 받은 자료 기준이라 그 한 줄을 늘 적습니다.
 *
 * 넓은 화면(lg)의 막대 줄은 도구 막대 하나(Tab 자리 하나 — ←→·Home·End로 옮김, Enter·Space·누르기로 그 날·주로 좁히고 다시 누르면 풂)이고,
 * 막대마다 낭독 이름(날짜·건수)과 눌림 상태(aria-pressed)가 있습니다. 0건 막대는 누를 수 없다고 알리고(aria-disabled) 옮겨 갈 수는 있습니다.
 * 좁은 화면(lg 미만)에서는 막대 하나의 폭이 손가락보다 훨씬 좁으므로(390px에서 30일 약 11px) 같은 막대를 그림으로만 그리고(낭독 제외), 날·주는
 * 44px 고르기 상자(건수가 있는 칸만, 최근부터)로 고릅니다(ADR 0041 결정 11 — lg 미만 누름 자리 44px).
 * 화면 읽기 프로그램용 표(숨김)에 같은 건수를 둡니다. 막대 색은 데이터라 중립(text-3), 좁힌 막대는 잉크(text)와 '좁힌 기간' 글 — 색만으로
 * 가르지 않습니다(명세 A1·A5). 고대비 모드에서는 바탕색이 지워지므로 테두리로 막대를 남깁니다.
 */
export function PeriodBars({
  bars,
  active,
  onToggle,
  onClear,
}: {
  bars: PeriodBarsView;
  /** 좁힌 칸(없으면 null). */
  active: PeriodBin | null;
  onToggle: (bin: PeriodBin) => void;
  onClear: () => void;
}) {
  const headingId = useId();
  const selectId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const { bins, unit, max } = bars;
  const activeIndex = active ? bins.findIndex((bin) => bin.start === active.start) : -1;
  // 도구 막대의 Tab 자리(칸의 시작 날짜) — 마지막으로 옮긴 막대, 없으면 좁힌 막대, 처음에는 가장 최근 칸. 기간을 바꿔 그 칸이 없어지면 다시 처음처럼.
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorIndex = cursor === null ? -1 : bins.findIndex((bin) => bin.start === cursor);
  const focusIndex = cursorIndex >= 0 ? cursorIndex : activeIndex >= 0 ? activeIndex : bins.length - 1;

  if (bins.length === 0) return null;

  const move = (index: number) => {
    const next = Math.max(0, Math.min(bins.length - 1, index));
    setCursor(bins[next].start);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowLeft: focusIndex - 1, ArrowRight: focusIndex + 1, Home: 0, End: bins.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    move(keys[event.key]);
  };

  // '좁히기 풀기'는 누르면 사라지므로 포커스를 막대로 — 좁은 화면에서는 막대 줄이 숨어(포커스를 받지 못함) 고르기 상자로.
  const clear = () => {
    onClear();
    const bar = buttons.current[focusIndex];
    bar?.focus();
    if (!bar || document.activeElement !== bar) document.getElementById(selectId)?.focus();
  };

  const pick = (start: string) => {
    if (start === "") {
      onClear();
      return;
    }
    const bin = bins.find((entry) => entry.start === start);
    if (bin && bin.start !== active?.start) onToggle(bin);
  };

  const first = bins[0];
  const last = bins[bins.length - 1];
  // 고르기 상자의 칸 — 건수가 있는 칸(좁힌 칸은 0건이어도), 최근부터.
  const choices = bins.filter((bin, index) => bin.count > 0 || index === activeIndex).reverse();
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 id={headingId} className="text-xs font-semibold tracking-wide text-text-3">
          기간 막대 · {unit === "day" ? "하루씩" : "주마다(월요일 시작)"} · KST
        </h3>
        <p className="text-xs text-text-3">{PERIOD_BARS_NOTE}</p>
      </div>
      {/* 넓은 화면 — 누르는 막대 줄. */}
      <div
        role="toolbar"
        aria-label="기간 막대 — 누르면 그 날·주로 목록을 좁힘"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="hidden h-10 items-stretch border-b border-border-strong lg:flex"
      >
        {bins.map((bin, index) => {
          const pressed = index === activeIndex;
          const empty = bin.count === 0;
          // 0건 막대는 좁힐 수 없음 — 다만 좁힌 뒤 거르기로 0건이 된 막대는 다시 눌러 풀 수 있어야 합니다.
          const inert = empty && !pressed;
          return (
            <button
              key={bin.start}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-label={periodAriaLabel(bin, unit)}
              aria-pressed={pressed}
              aria-disabled={inert || undefined}
              onFocus={() => setCursor(bin.start)}
              onClick={() => {
                if (!inert) onToggle(bin);
              }}
              className={`group flex min-w-0 flex-1 items-end justify-center px-px focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                inert ? "cursor-default" : "cursor-pointer"
              }`}
            >
              <BarFill count={bin.count} max={max} pressed={pressed} hover />
            </button>
          );
        })}
      </div>
      {/* 좁은 화면 — 같은 막대를 그림으로만(누르는 자리는 아래 44px 고르기 상자). */}
      <div aria-hidden="true" className="flex h-12 items-stretch border-b border-border-strong lg:hidden">
        {bins.map((bin, index) => (
          <span key={bin.start} className="flex min-w-0 flex-1 items-end justify-center px-px">
            <BarFill count={bin.count} max={max} pressed={index === activeIndex} />
          </span>
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between gap-2 text-xs tabular-nums text-text-3">
        <span>{periodTickLabel(first, unit)}</span>
        <span>가장 큰 칸 {max}건</span>
        <span>{periodTickLabel(last, unit)}</span>
      </div>
      <div className="flex flex-col gap-1 lg:hidden">
        <label htmlFor={selectId} className="text-xs text-text-2">
          {unit === "day" ? "날" : "주"}로 좁히기
        </label>
        <NativeSelect
          id={selectId}
          inputSize="sm"
          wrapperClassName="block w-full"
          value={active?.start ?? ""}
          onChange={(event) => pick(event.target.value)}
        >
          <option value="">좁히지 않음</option>
          {choices.map((bin) => (
            <option key={bin.start} value={bin.start}>
              {periodAriaLabel(bin, unit)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-2">
        {/* 좁힘·풂을 같은 상태 영역에서 알립니다. */}
        <p role="status">{active ? `좁힌 기간: ${periodLabel(active, unit)} · ${active.count}건` : ""}</p>
        {active ? (
          <button type="button" className={BUTTON} onClick={clear}>
            좁히기 풀기
          </button>
        ) : null}
      </div>
      {bars.offChart > 0 ? <p className="text-xs text-text-3">시각을 모르거나 막대 범위 밖인 {bars.offChart}건은 막대에 없습니다.</p> : null}
      {/* sr-only를 표에 바로 주면 표는 1px 상자를 무시하고 줄 수만큼 커져 화면 밖으로 넘칩니다(시각 확인에서 찾음) — 감싼 div가 자릅니다. */}
      <div className="sr-only">
        <table>
          <caption>기간별 건수(받은 자료 기준 — {unit === "day" ? "하루씩" : "주마다, 월요일 시작"}, KST)</caption>
          <thead>
            <tr>
              <th scope="col">기간</th>
              <th scope="col">건수</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin) => (
              <tr key={bin.start}>
                <th scope="row">{periodLabel(bin, unit)}</th>
                <td>{bin.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 막대 하나의 채움(높이 = 건수 / 가장 큰 칸, 건수가 있으면 적어도 8%) — 좁힌 칸은 잉크, 나머지는 중립. 고대비 모드는 테두리. */
function BarFill({ count, max, pressed, hover = false }: { count: number; max: number; pressed: boolean; hover?: boolean }) {
  const empty = count === 0;
  const height = empty || max === 0 ? 0 : Math.max(8, Math.round((count / max) * 100));
  return (
    <span
      aria-hidden="true"
      style={{ height: `${height}%` }}
      className={`block w-full max-w-6 rounded-t-sm ${
        pressed ? "bg-text forced-colors:border-2" : `bg-text-3 forced-colors:border ${hover ? "group-hover:bg-text-2" : ""}`
      } ${empty ? "forced-colors:border-0" : ""}`}
    />
  );
}
