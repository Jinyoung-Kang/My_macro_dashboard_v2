/**
 * 표 히트맵(HeatmapTable)의 기본 최소 폭이 열 수와 무관한 경우(QA-729). 값은 합성입니다(가상 이름).
 *
 * `minWidth`를 주지 않은 표는 열 수와 상관없이 최소 640px(클래스 `min-w-[640px]`)였습니다. 표 자동 배치는 640px에서 열의 max-content 합보다 남는 폭을
 * 그 비율로 나누므로, 분기 열이 적으면(13F 조회 분기 1·2, 4분기뿐인 기관) 고정(sticky) 행 머리(종목 이름)가 남는 폭 대부분을 받았습니다 — P5b QA 재확인
 * (qa@01693937)의 /institutions 비중 히트맵 행 머리 폭 8분기 128·4분기 260·2분기 370·1분기 469px. 390(상자 332px)에서 분기 2·1이면 값 칸이 어느 스크롤
 * 자리에서도 다 보이지 않았고(1px씩 훑어 0/30·0/15), 끝 자리에서 행 머리가 왼쪽으로 잘려 이름이 잘리거나 사라졌으며, 1024(상자 482px) 분기 1은 값 띠 13px(0/15).
 * jsdom은 배치를 계산하지 않으므로 표의 최소 폭(클래스 또는 인라인 모양)이 열 수에 따라 정해지는지를 봅니다.
 *
 * 고침과 함께: 넘김 안내를 폰(sm 미만)에서 늘 두던 규칙은 '폰 상자는 최소 폭 640px보다 좁음'에 기댔으므로, 최소 폭이 그보다 좁은 표(열이 적은 기본 폭)는
 * 잰 넘침으로만 안내를 둡니다(390 상자 332px에 열 둘 256px 표가 들어가는데 '넘겨 보세요'가 남지 않게) — 아래 둘째 묶음.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WeightHeatmap } from "@/components/charts";

import { HeatmapTable, type HeatmapColumn } from "../HeatmapTable";

afterEach(() => {
  cleanup();
  for (const name of ["scrollWidth", "clientWidth"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

const DATES = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];

/** 최근 n개 분기 열(오래된 것 → 최근). */
function columnsOf(count: number): HeatmapColumn[] {
  return DATES.slice(DATES.length - count).map((date) => ({ key: date, label: date.slice(2), title: date, nowrap: true }));
}

/** 표의 최소 폭(px) — 인라인 모양이 있으면 그것, 없으면 클래스 `min-w-[Npx]`, 둘 다 없으면 null. */
function tableMinWidth(): number | null {
  const table = screen.getByRole("table");
  if (table.style.minWidth) return Number.parseFloat(table.style.minWidth);
  const match = /(?:^|\s)min-w-\[(\d+)px\](?:\s|$)/.exec(table.className);
  return match ? Number(match[1]) : null;
}

/** 열 n개·행 둘인 표 히트맵을 그립니다. */
function renderTable(count: number, minWidth?: number) {
  const columns = count > DATES.length ? Array.from({ length: count }, (_, index) => ({ key: `c${index}`, label: `열 ${index + 1}` })) : columnsOf(count);
  return render(
    <HeatmapTable
      caption="합성 히트맵"
      rowHeader="종목"
      columns={columns}
      rows={[
        { key: "alpha", label: "SYNTHETIC ALPHA HOLDINGS INC", values: columns.map((_, index) => index + 1) },
        { key: "beta", label: "SYNTHETIC BETA CO", values: columns.map(() => 0.5) },
      ]}
      max={count}
      format={(value) => value.toFixed(1)}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
      minWidth={minWidth}
    />,
  );
}

/** 열 n개·행 둘인 표 히트맵의 최소 폭. */
function minWidthFor(count: number, minWidth?: number): number | null {
  const { unmount } = renderTable(count, minWidth);
  const width = tableMinWidth();
  unmount();
  return width;
}

/** 넘김 안내 줄의 보임 — 'shown'(폭과 상관없이), 'phone-only'(sm 미만에서만), 'hidden'(늘 숨김). */
function hintState(): "shown" | "phone-only" | "hidden" {
  const classes = screen.getByText("← 표를 좌우로 넘겨 보세요").className.split(/\s+/);
  return classes.includes("hidden") ? "hidden" : classes.includes("sm:hidden") ? "phone-only" : "shown";
}

/** 열 n개 표를 그린 뒤 안내 줄의 보임(상자 폭은 흉내 내지 않으면 jsdom 0 — 넘치지 않음). */
function hintFor(count: number, minWidth?: number) {
  const { unmount } = renderTable(count, minWidth);
  const state = hintState();
  unmount();
  return state;
}

/** 스크롤 상자(role=region)의 내용 폭·보이는 폭을 흉내 냅니다(jsdom은 배치를 하지 않아 늘 0). */
function stubBox(content: number, visible: number) {
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
}

describe("표 히트맵의 기본 최소 폭은 열 수에 맞춘다(QA-729)", () => {
  // 수정 전 실패(plain it): [640, 640, 640, 640] — 열 수와 상관없이 640(기대 [192, 256, 384, 640]).
  it("minWidth를 주지 않으면 최소 폭이 '행 머리 128 + 열 수 × 64'(열 1·2·4·8 → 192·256·384·640px)", () => {
    expect([1, 2, 4, 8].map((count) => minWidthFor(count))).toEqual([192, 256, 384, 640]);
  });

  it("열이 여덟보다 많아도 기본 최소 폭은 640px을 넘지 않는다(상한 — 더 넓은 몫은 표 자동 배치가 정함)", () => {
    expect([8, 9, 12].map((count) => minWidthFor(count))).toEqual([640, 640, 640]);
  });

  it("minWidth를 준 표(/style 유사도 행렬 등)는 열 수와 상관없이 그 폭", () => {
    expect([1, 2, 4, 8, 12].map((count) => minWidthFor(count, 720))).toEqual([720, 720, 720, 720, 720]);
  });

  // 수정 전 실패(plain it): [640, 640, 640, 640] — 13F 화면 조회 분기 1·2·4·8(기대 [192, 256, 384, 640]).
  it("13F 비중 히트맵(WeightHeatmap)도 조회 분기 수(1·2·4·8)에 따라 최소 폭이 192·256·384·640px", () => {
    const widths = [1, 2, 4, 8].map((count) => {
      const dates = DATES.slice(DATES.length - count);
      const { unmount } = render(
        <WeightHeatmap dates={dates} series={{ "SYNTHETIC ALPHA HOLDINGS INC": dates.map(() => 12.5), "SYNTHETIC BETA CO": dates.map(() => 0) }} />,
      );
      const width = tableMinWidth();
      unmount();
      return width;
    });
    expect(widths).toEqual([192, 256, 384, 640]);
  });
});

describe("최소 폭이 640px보다 좁은 표는 넘칠 때만 넘김 안내를 둔다(QA-729 고침과 함께)", () => {
  // 고치기 전에는 최소 폭이 늘 640이라 넘치지 않으면 모두 'phone-only'였고 그것이 맞았습니다(sm 미만 상자는 640px보다 좁음).
  it("넘치지 않으면 기본 폭이 640 미만인 표(열 1·2·4)는 폰에서도 숨기고, 640 이상인 표(열 8·minWidth 720)는 지금처럼 폰에서는 둔다", () => {
    expect([1, 2, 4, 8].map((count) => hintFor(count))).toEqual(["hidden", "hidden", "hidden", "phone-only"]);
    expect(hintFor(2, 720)).toBe("phone-only");
  });

  it("좁은 표도 상자보다 넓으면(390 상자 332px에 열 넷 384px) 폭과 상관없이 안내를 둔다", () => {
    stubBox(384, 332);
    renderTable(4);
    expect(hintState()).toBe("shown");
  });
});
