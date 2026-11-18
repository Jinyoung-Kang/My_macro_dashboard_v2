/**
 * 표 히트맵(HeatmapTable, initialScroll="end")을 그린 뒤 상자 폭이 바뀌는 경우(QA-722). 값은 합성입니다(가상 이름).
 *
 * 끝 자리를 맞추는 효과는 처음 그릴 때·열이 바뀔 때·빈 상태에서 표가 생길 때만 돌고, 폭이 바뀔 때 도는 ResizeObserver는 넘김 안내만 다시 쟀습니다.
 * 그래서 1024에서 메뉴를 펴거나(표가 들어가던 654px → 가운데 칸 482px), 끝에서 시작해 메뉴를 접었다 펴거나(482 → 654 → 482), 창을 줄이면(558 → 482px)
 * 스크롤이 0이나 옛 자리에 남아 가장 최근 분기가 상자 밖이었습니다(P5b QA 스택 확인 — 비중 히트맵).
 * jsdom은 배치를 계산하지 않으므로 상자 폭·내용 폭을 흉내 냅니다(heatmapTableQa720과 같은 방식). 폭을 바꿀 때는 브라우저처럼 스크롤 자리를 새 끝 안으로
 * 줄이고, 관찰 콜백을 다시 부른 뒤, 줄었으면 scroll 이벤트를 보냅니다.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeatmapTable, type HeatmapRow } from "../HeatmapTable";

const COLUMNS = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map((date) => ({ key: date, label: date.slice(2) }));
const ROWS: HeatmapRow[] = [
  { key: "alpha", label: "SYNTHETIC ALPHA CO", values: [1, 2, 3, 4] },
  { key: "beta", label: "SYNTHETIC BETA CO", values: [4, 3, 2, 1] },
];
const NAME = "합성 히트맵 (좌우 스크롤)";

type Sizes = { content: number; visible: number };

/**
 * 스크롤 상자(role=region)의 내용 폭·보이는 폭을 흉내 내고(바꿀 수 있음), scrollLeft를 요소마다 기억합니다(jsdom은 늘 0). 만든 ResizeObserver의 콜백을
 * 모아 두어 `resize`가 폭을 바꾼 뒤 다시 부릅니다.
 */
function stubBox(initial: Sizes) {
  const sizes = { ...initial };
  const callbacks = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {
        callbacks.add(callback);
      }
      observe() {
        this.callback();
      }
      disconnect() {
        callbacks.delete(this.callback);
      }
    },
  );
  const scrolled = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "region" ? sizes.content : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "region" ? sizes.visible : 0;
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
  return {
    /** 폭을 바꿉니다 — 스크롤 자리를 새 끝 안으로 줄이고(브라우저와 같이), 관찰 콜백을 부르고, 줄였으면 scroll 이벤트를 보냅니다. */
    resize(next: Sizes) {
      sizes.content = next.content;
      sizes.visible = next.visible;
      const region = screen.getByRole("region", { name: NAME });
      const end = Math.max(0, sizes.content - sizes.visible);
      const clamped = region.scrollLeft > end;
      if (clamped) region.scrollLeft = end;
      act(() => {
        for (const callback of [...callbacks]) callback();
      });
      if (clamped) fireEvent.scroll(region);
    },
  };
}

afterEach(() => {
  cleanup();
  for (const name of ["scrollWidth", "clientWidth", "scrollLeft"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  vi.unstubAllGlobals();
});

function table(initialScroll: "start" | "end" = "end") {
  return (
    <HeatmapTable
      caption="합성 히트맵"
      rowHeader="종목"
      columns={COLUMNS}
      rows={ROWS}
      max={4}
      format={(value) => value.toFixed(1)}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
      initialScroll={initialScroll}
    />
  );
}

function observed() {
  const hint = screen.getByText("← 표를 좌우로 넘겨 보세요");
  return {
    hint: hint.className.split(/\s+/).includes("sm:hidden") ? "phone-only" : "shown",
    scrollLeft: screen.getByRole("region", { name: NAME }).scrollLeft,
  };
}

/** 사용자가 상자를 옮긴 것처럼 scrollLeft를 두고 scroll 이벤트를 보냅니다. */
function userScroll(to: number) {
  const region = screen.getByRole("region", { name: NAME });
  region.scrollLeft = to;
  fireEvent.scroll(region);
}

describe("표 히트맵이 끝에 붙어 있는 동안 폭이 바뀌면 다시 끝(가장 최근 열)으로 간다(QA-722)", () => {
  // 수정 전 실패(plain it): { hint: "shown", scrollLeft: 0 } — 안내는 다시 재지만 스크롤은 0(가장 오래된 열)에 남음.
  it("표가 들어가던 폭(654)에서 넘치는 폭(640 > 482)으로 바뀌면(메뉴 펴기) 안내가 보이고 스크롤이 오른쪽 끝으로 간다", () => {
    const box = stubBox({ content: 654, visible: 654 });
    render(table());
    expect(observed()).toEqual({ hint: "phone-only", scrollLeft: 0 });
    box.resize({ content: 640, visible: 482 });
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): 펼친 뒤 { hint: "shown", scrollLeft: 0 } — 접을 때 0으로 줄어든 자리에 남음.
  it("끝에서 시작해 메뉴를 접었다 펴도(482 → 654 → 482) 끝으로 돌아온다", () => {
    const box = stubBox({ content: 640, visible: 482 });
    render(table());
    expect(observed().scrollLeft).toBe(158);
    box.resize({ content: 654, visible: 654 });
    expect(observed()).toEqual({ hint: "phone-only", scrollLeft: 0 });
    box.resize({ content: 640, visible: 482 });
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): scrollLeft 82(옛 끝) — 새 끝은 158.
  it("끝에 있던 채로 넘침이 커지면(558 → 482 — 창 줄이기) 새 끝으로 간다", () => {
    const box = stubBox({ content: 640, visible: 558 });
    render(table());
    expect(observed().scrollLeft).toBe(82);
    box.resize({ content: 640, visible: 482 });
    expect(observed().scrollLeft).toBe(158);
  });

  it("사용자가 왼쪽으로 옮긴 뒤에는 폭이 바뀌어도 그 자리를 지킨다", () => {
    const box = stubBox({ content: 640, visible: 482 });
    render(table());
    userScroll(0);
    box.resize({ content: 640, visible: 470 });
    expect(observed().scrollLeft).toBe(0);
    userScroll(60);
    box.resize({ content: 640, visible: 450 });
    expect(observed().scrollLeft).toBe(60);
  });

  it("처음 자리가 왼쪽(initialScroll 기본 \"start\")인 표는 폭이 바뀌어도 스크롤을 옮기지 않는다", () => {
    const box = stubBox({ content: 654, visible: 654 });
    render(table("start"));
    box.resize({ content: 640, visible: 482 });
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 0 });
  });
});
