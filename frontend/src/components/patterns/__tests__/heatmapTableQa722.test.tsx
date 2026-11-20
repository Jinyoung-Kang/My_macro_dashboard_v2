/**
 * 표 히트맵(HeatmapTable, initialScroll="end")을 그린 뒤 상자 폭이 바뀌는 경우(QA-722). 값은 합성입니다(가상 이름).
 *
 * 끝 자리를 맞추는 효과는 처음 그릴 때·열이 바뀔 때·빈 상태에서 표가 생길 때만 돌고, 폭이 바뀔 때 도는 ResizeObserver는 넘김 안내만 다시 쟀습니다.
 * 그래서 1024에서 메뉴를 펴거나(표가 들어가던 654px → 가운데 칸 482px), 끝에서 시작해 메뉴를 접었다 펴거나(482 → 654 → 482), 창을 줄이면(558 → 482px)
 * 스크롤이 0이나 옛 자리에 남아 가장 최근 분기가 상자 밖이었습니다(P5b QA 스택 확인 — 비중 히트맵).
 * jsdom은 배치를 계산하지 않으므로 상자 폭·내용 폭을 흉내 냅니다(heatmapTableQa720과 같은 방식). 폭을 바꿀 때는 브라우저처럼 스크롤 자리를 새 끝 안으로
 * 줄이고, 관찰 콜백을 다시 부른 뒤, 줄었으면 scroll 이벤트를 보냅니다.
 *
 * 보강(검토 지적): 위 `resize`는 폭을 한 번에 바꾸고 부품 자신이 scrollLeft를 쓴 뒤의 scroll 이벤트를 보내지 않습니다. 브라우저는 그 이벤트를 다음 프레임에
 * 보내므로, 메뉴 접기·펴기(기본 움직임 — 폭 전환 150ms)나 창 끌기처럼 폭이 프레임마다 바뀌면 이벤트가 올 때의 끝은 이미 더 멀어져 있습니다. 아래 `frames`가
 * 그 차례(폭이 바뀜 → 앞 프레임에 바뀐 자리의 scroll 이벤트 → 관찰 콜백)를 흉내 냅니다 — 펴기 걸음은 QA 스택 1024 레일 펴기에서 프레임마다 잰 상자 폭.
 *
 * QA-730(같은 흉내 — 맨 아래 묶음): 사용자가 왼쪽으로 옮긴 자리가 표가 상자에 들어가는 폭을 지난 뒤 자리에 따라 다르게 끝났습니다. 키보드로 0에 둔 경우는
 * 메뉴를 레일로 접어 표가 들어가도 자리가 그대로라 scroll 이벤트가 없어 붙음이 풀린 채 남아 다시 펴면 0, 휠로 40에 둔 경우는 접을 때 브라우저가 0으로 줄인
 * 자리의 이벤트로 다시 붙어 펴면 끝(P5b QA 재확인 qa@01693937, 메뉴 206 — 0 / 144와 144 / 144). 2026-11-18 결정(사용자 위임 — 권장안): 둘 다 끝.
 * 넘치는 폭 안에서만 바뀌면 사용자 자리는 새 끝 안에 남는 동안 그대로이고, 새 끝이 그 자리보다 작아지면 브라우저가 끝으로 줄여 다시 붙습니다(QA-722 규칙 —
 * 받아들인 동작, 맨 아래 지킴 시험).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeatmapTable, type HeatmapRow } from "../HeatmapTable";

// 열 여덟(13F 8분기) — 아래 흉내 폭(최소 640px 표)과 같은 최소 폭(128 + 8 × 64 = 640 — QA-729 뒤 열이 적은 표는 더 좁음).
const COLUMNS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map((date) => ({
  key: date,
  label: date.slice(2),
}));
const ROWS: HeatmapRow[] = [
  { key: "alpha", label: "SYNTHETIC ALPHA CO", values: [1, 2, 3, 4, 5, 6, 7, 8] },
  { key: "beta", label: "SYNTHETIC BETA CO", values: [8, 7, 6, 5, 4, 3, 2, 1] },
];
/** 스크롤 상자 — 표가 상자에 들어가는 폭에서는 이름 있는 영역이 아니므로(QA-939) 표의 부모로 찾습니다. */
const scrollBox = () => document.querySelector("table")?.parentElement as HTMLElement;

type Sizes = { content: number; visible: number };

/**
 * 스크롤 상자(표를 바로 감싼 상자 — 넘치지 않으면 영역 역할이 빠지므로 역할로 찾지 않음, QA-939)의 내용 폭·보이는 폭을 흉내 내고(바꿀 수 있음), scrollLeft를 요소마다 기억합니다(jsdom은 늘 0). 만든 ResizeObserver의 콜백을
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
      return this.querySelector(":scope > table") !== null ? sizes.content : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelector(":scope > table") !== null ? sizes.visible : 0;
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
      const region = scrollBox();
      const end = Math.max(0, sizes.content - sizes.visible);
      const clamped = region.scrollLeft > end;
      if (clamped) region.scrollLeft = end;
      act(() => {
        for (const callback of [...callbacks]) callback();
      });
      if (clamped) fireEvent.scroll(region);
    },
    /**
     * 폭을 프레임마다 바꿉니다(전환·창 끌기). 프레임마다 폭을 바꾸고 스크롤 자리를 새 끝 안으로 줄인 뒤, 앞 프레임 뒤로 자리가 바뀌었으면(부품의 쓰기·줄임)
     * scroll 이벤트를 보내고(브라우저는 다음 프레임에 보냄 — 받는 쪽은 그때의 폭을 읽음), 관찰 콜백을 부릅니다. 끝나면 남은 이벤트를 보냅니다.
     */
    frames(steps: readonly Sizes[]) {
      const region = scrollBox();
      let pending = false;
      for (const next of steps) {
        sizes.content = next.content;
        sizes.visible = next.visible;
        const end = Math.max(0, sizes.content - sizes.visible);
        if (region.scrollLeft > end) {
          region.scrollLeft = end;
          pending = true;
        }
        if (pending) fireEvent.scroll(region);
        const before = region.scrollLeft;
        act(() => {
          for (const callback of [...callbacks]) callback();
        });
        pending = region.scrollLeft !== before;
      }
      if (pending) fireEvent.scroll(region);
    },
  };
}

/** 표(최소 폭 640px — 열 여덟)가 보이는 폭마다 차지하는 크기 — 들어가면 상자를 채움. */
function fit(visible: number): Sizes {
  return { content: Math.max(640, visible), visible };
}

/** 1024(메뉴 220)에서 레일 → 펼친 메뉴로 폭이 전환되는 동안 상자 폭(QA 스택 — 프레임마다 잼, 654 → 482px). */
const EXPAND = [648, 624, 576, 534, 510, 496, 487, 483, 482].map(fit);
/** 같은 자리에서 펼친 메뉴 → 레일(482 → 654px). */
const COLLAPSE = [488, 512, 561, 602, 626, 640, 649, 653, 654].map(fit);

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
      max={8}
      format={(value) => value.toFixed(1)}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
      initialScroll={initialScroll}
    />
  );
}

/**
 * 넘김 안내 줄의 보임('shown' 폭과 상관없이 · 'phone-only' sm 미만에서만 · 'hidden' 늘 숨김 — 최소 폭이 640px보다 좁고 넘치지 않는 표, QA-729)과 스크롤 자리.
 * 'hidden'을 따로 읽어야 넘침을 잘못 재 안내가 숨은 것이 'shown'으로 읽혀 지나가지 않습니다(heatmapTableQa729의 hintState와 같은 판정).
 */
function observed() {
  const classes = screen.getByText("← 표를 좌우로 넘겨 보세요").className.split(/\s+/);
  return {
    hint: classes.includes("hidden") ? "hidden" : classes.includes("sm:hidden") ? "phone-only" : "shown",
    scrollLeft: scrollBox().scrollLeft,
  };
}

/** 사용자가 상자를 옮긴 것처럼 scrollLeft를 두고 scroll 이벤트를 보냅니다. */
function userScroll(to: number) {
  const region = scrollBox();
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

describe("폭이 프레임마다 바뀌어도(메뉴 폭 전환·창 끌기) 끝에 붙은 표는 끝에 남는다(QA-722 보강)", () => {
  // 수정 전 실패(plain it): scrollLeft 16(기대 158) — 624px 프레임에 끝 16으로 옮긴 쓰기의 scroll 이벤트가 576px 프레임(끝 64)에 와 사용자 이동으로 읽혀 붙음이
  // 풀리고, 그 뒤로는 따라가지 않음(QA 스택 레일 펴기 실측과 같은 16).
  it("레일에서 메뉴를 기본 움직임으로 펴면(654 → 482px, 프레임 아홉) 오른쪽 끝(158)에 남는다", () => {
    const box = stubBox(fit(654));
    render(table());
    box.frames(EXPAND);
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): 접은 뒤 0, 편 뒤 16(기대 158) — 접을 때는 브라우저가 줄인 자리가 끝이라 붙어 있고, 펼 때 위와 같이 풀림.
  it("끝에서 시작해 기본 움직임으로 접었다 펴도(482 → 654 → 482px) 끝으로 돌아온다", () => {
    const box = stubBox(fit(482));
    render(table());
    expect(observed().scrollLeft).toBe(158);
    box.frames(COLLAPSE);
    expect(observed()).toEqual({ hint: "phone-only", scrollLeft: 0 });
    box.frames(EXPAND);
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): scrollLeft 90(기대 158) — 550px 프레임에 끝 90으로 옮긴 쓰기의 이벤트가 542px 프레임(끝 98)에 와 풀림.
  it("끝에 있던 채로 창을 프레임마다 8px씩 줄여도(558 → 482px) 새 끝으로 간다", () => {
    const box = stubBox(fit(558));
    render(table());
    expect(observed().scrollLeft).toBe(82);
    box.frames([550, 542, 534, 526, 518, 510, 502, 494, 486, 482].map(fit));
    expect(observed().scrollLeft).toBe(158);
  });

  it("사용자가 왼쪽으로 옮긴 자리는 폭이 프레임마다 바뀌어도 지킨다", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(40);
    box.frames([470, 450, 430, 418, 414].map(fit));
    expect(observed().scrollLeft).toBe(40);
    box.frames(COLLAPSE.slice(0, 3));
    expect(observed().scrollLeft).toBe(40);
  });
});

describe("사용자가 왼쪽으로 옮긴 자리도 표가 상자에 들어가는 폭을 지나면 다시 끝에 붙는다(QA-730)", () => {
  // 수정 전 실패(plain it): 접은 뒤 { hint: "phone-only", scrollLeft: 0 }(같음), 편 뒤 { hint: "shown", scrollLeft: 0 }(기대 158) — 0에 있던 자리는 표가 들어가도
  // 줄일 것이 없어 scroll 이벤트가 오지 않아 붙음이 풀린 채 남음.
  it("키보드로 0에 둔 뒤 메뉴를 레일로 접어(482 → 654px — 표가 들어감, scroll 이벤트 없음) 다시 펴면 오른쪽 끝(158)으로 간다", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(0);
    box.resize(fit(654));
    expect(observed()).toEqual({ hint: "phone-only", scrollLeft: 0 });
    box.resize(fit(482));
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  // 수정 전 실패(plain it): { hint: "shown", scrollLeft: 0 }(기대 158) — 위와 같은 까닭, 폭 전환(프레임 아홉씩)에서도 같음.
  it("키보드로 0에 둔 뒤 기본 움직임으로 접었다 펴도(482 → 654 → 482px) 오른쪽 끝(158)으로 간다", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(0);
    box.frames(COLLAPSE);
    box.frames(EXPAND);
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  it("휠로 40에 둔 뒤 접었다 펴도(한 번에·기본 움직임) 오른쪽 끝(158)으로 간다 — 지금도 같음(브라우저가 줄인 자리의 이벤트로 붙음)", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(40);
    box.resize(fit(654));
    box.resize(fit(482));
    expect(observed().scrollLeft).toBe(158);
    userScroll(40);
    box.frames(COLLAPSE);
    box.frames(EXPAND);
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  it("표가 들어가는 폭에 닿지 않고 새 끝이 그 자리 이상이면(넘치는 폭 안에서만 바뀜) 사용자가 둔 0·40은 그대로", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(0);
    box.frames(COLLAPSE.slice(0, 5));
    box.frames([...COLLAPSE.slice(0, 4)].reverse());
    expect(observed().scrollLeft).toBe(0);
    userScroll(40);
    box.frames(COLLAPSE.slice(0, 3));
    box.frames(EXPAND.slice(5));
    expect(observed().scrollLeft).toBe(40);
  });

  // 받아들인 동작(QA-722 규칙 — QA-730 고침 앞뒤 같음): 넘치는 폭 안이어도 새 끝이 사용자 자리보다 작아지면 브라우저가 자리를 그 끝으로 줄이고, 줄인 자리는 그 폭의
  // 끝이라 다시 붙습니다. 그래서 0(어떤 끝보다도 작지 않음)과 40은 '넘치는 폭 안에서 넓히기'에서도 다르게 끝날 수 있습니다(정적 페이지 482 → 614 → 482px: 40 → 26 → 158).
  it("넘치는 폭 안에서 넓혀 새 끝이 사용자 자리(40)보다 작아지면 끝으로 줄인 자리에 다시 붙어, 좁히면 오른쪽 끝으로 간다", () => {
    const box = stubBox(fit(482));
    render(table());
    userScroll(40);
    box.resize(fit(614));
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 26 });
    box.resize(fit(482));
    expect(observed().scrollLeft).toBe(158);
    userScroll(40);
    // 488 → 626px(끝 152 → 14 — 602px에서 끝 38이 40보다 작아짐) → 다시 488px.
    box.frames(COLLAPSE.slice(0, 5));
    expect(observed()).toEqual({ hint: "shown", scrollLeft: 14 });
    box.frames([...COLLAPSE.slice(0, 4)].reverse());
    expect(observed().scrollLeft).toBe(152);
  });
});
