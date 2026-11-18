/**
 * 표 히트맵(HeatmapTable)이 처음에 빈 상태(행 없음)로 그려진 뒤 같은 자리에서 행이 오는 경우(QA-720). 값은 합성입니다(가상 이름).
 *
 * 넘침 재기(ResizeObserver)와 처음 스크롤 자리(initialScroll="end")가 마운트 때만, 또는 열이 바뀔 때만 돌아, 빈 상태로 먼저 그려지면 스크롤 상자가 없는
 * 때에 한 번 돌고 끝났습니다. 그래서 행이 온 뒤 표가 상자보다 넓어도 안내는 폰 전용으로 남고 스크롤은 왼쪽(가장 오래된 열)에서 시작했습니다.
 * 지금 두 화면은 이 길을 타지 않지만(비중 히트맵은 값이 오기 전 다른 글, 유사도 행렬은 값이 있을 때만 마운트) 빈 상태는 P6·P7이 다시 쓰는 패턴 몫입니다.
 * jsdom은 배치를 계산하지 않으므로 상자 폭·내용 폭을 흉내 냅니다(weightHeatmapQa713과 같은 방식).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeatmapTable, type HeatmapRow } from "../HeatmapTable";

const COLUMNS = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map((date) => ({ key: date, label: date.slice(2) }));
const ROWS: HeatmapRow[] = [
  { key: "alpha", label: "SYNTHETIC ALPHA CO", values: [1, 2, 3, 4] },
  { key: "beta", label: "SYNTHETIC BETA CO", values: [4, 3, 2, 1] },
];

/** 스크롤 상자(role=region)의 내용 폭·보이는 폭을 흉내 내고, scrollLeft를 요소마다 기억합니다(jsdom은 늘 0). */
function stubBox(content: number, visible: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  const scrolled = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "region" ? content : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "region" ? visible : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolled.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrolled.set(this, value);
    },
  });
}

afterEach(() => {
  cleanup();
  for (const name of ["scrollWidth", "clientWidth", "scrollLeft"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  vi.unstubAllGlobals();
});

function table(rows: readonly HeatmapRow[]) {
  return (
    <HeatmapTable
      caption="합성 히트맵"
      rowHeader="종목"
      columns={COLUMNS}
      rows={rows}
      max={4}
      format={(value) => value.toFixed(1)}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
      initialScroll="end"
    />
  );
}

function observed() {
  const hint = screen.queryByText("← 표를 좌우로 넘겨 보세요");
  return {
    hint: hint === null ? null : hint.className.split(/\s+/).includes("sm:hidden") ? "phone-only" : "shown",
    scrollLeft: screen.getByRole("region", { name: "합성 히트맵 (좌우 스크롤)" }).scrollLeft,
  };
}

describe("표 히트맵이 빈 상태로 먼저 그려진 뒤 행이 와도 넘침을 재고 처음 자리를 맞춘다(QA-720)", () => {
  it("처음부터 행이 있으면(기준) 안내가 폭과 상관없이 보이고 스크롤은 오른쪽 끝에서 시작한다", () => {
    stubBox(640, 482);
    render(table(ROWS));
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): { hint: "phone-only", scrollLeft: 0 } — 재기·처음 자리 효과가 상자 없는 빈 상태 때 한 번 돌고 끝남.
  it.fails("빈 상태(행 없음)로 그린 뒤 같은 자리에서 행이 오면 처음부터 행이 있을 때와 같다", () => {
    stubBox(640, 482);
    const view = render(table([]));
    expect(screen.getByText("표시할 값이 없습니다.")).toBeTruthy();
    view.rerender(table(ROWS));
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });
});
