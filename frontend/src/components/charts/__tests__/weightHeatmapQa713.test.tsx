/**
 * 13F 포트폴리오 화면의 비중 히트맵(WeightHeatmap — 표 히트맵 HeatmapTable의 감싸개)이 상자보다 넓을 때(QA-713). 값은 합성입니다(가상 종목 이름).
 *
 * 1024(메뉴 220)에서 두 칸 틀의 가운데 칸이 482px인데 표 최소 폭은 640px라, 스크롤이 왼쪽(가장 오래된 분기)에서 시작해 가장 최근 분기 열이 첫 화면
 * 밖에 있었고 넘김 안내도 없었습니다(같은 화면 보유 표 — 공용 DataTable — 에는 있음). jsdom은 배치를 계산하지 않으므로 상자 폭·내용 폭을 흉내 냅니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WeightHeatmap } from "@/components/charts";

const DATES = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const SERIES = { "SYNTHETIC ALPHA CO": [1, 2, 3, 4, 5, 6, 7, 8], "SYNTHETIC BETA CO": [8, 7, 6, 5, 4, 3, 2, 1] };

/** 스크롤 상자(표를 바로 감싼 상자 — 넘치지 않으면 영역 역할이 빠지므로 역할로 찾지 않음, QA-939)의 내용 폭·보이는 폭을 흉내 내고, scrollLeft를 요소마다 기억합니다(jsdom은 늘 0). */
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
      return this.querySelector(":scope > table") !== null ? content : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelector(":scope > table") !== null ? visible : 0;
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

describe("비중 히트맵이 상자보다 넓으면 최신 분기가 보이게 시작하고 넘김 안내를 둔다(QA-713)", () => {
  // 수정 전 실패(plain it): { hint: null, scrollLeft: 0 } — 안내 줄이 없고 스크롤이 왼쪽(가장 오래된 분기)에서 시작.
  it("표가 상자보다 넓으면(640 > 482px) 안내 줄이 폭과 상관없이 보이고, 스크롤은 오른쪽 끝(가장 최근 분기)에서 시작한다", () => {
    stubBox(640, 482);
    render(<WeightHeatmap dates={DATES} series={SERIES} />);
    const region = screen.getByRole("region", { name: "비중 히트맵 (좌우 스크롤)" });
    const hint = screen.queryByText("← 표를 좌우로 넘겨 보세요");
    const classes = hint === null ? null : hint.className.split(/\s+/);
    // 'hidden'(늘 숨김 — 최소 폭이 640px보다 좁고 넘치지 않는 표, QA-729)을 따로 읽습니다 — 'shown'으로 읽으면 넘침을 잘못 잰 것이 지나감.
    expect({
      hint: classes === null ? null : classes.includes("hidden") ? "hidden" : classes.includes("sm:hidden") ? "phone-only" : "shown",
      scrollLeft: region.scrollLeft,
    }).toEqual({ hint: "shown", scrollLeft: 158 });
  });

  it("표가 상자에 들어가면 안내는 폰(sm 미만)에서만이고 처음 자리는 그대로(오른쪽 끝 = 0)", () => {
    stubBox(898, 898);
    render(<WeightHeatmap dates={DATES} series={SERIES} />);
    expect(screen.getByText("← 표를 좌우로 넘겨 보세요").className.split(/\s+/)).toContain("sm:hidden");
    // 넘치지 않는 상자는 Tab 정지점·이름 있는 영역이 아닙니다(QA-939) — 표의 부모로 찾습니다.
    expect(screen.queryByRole("region", { name: "비중 히트맵 (좌우 스크롤)" })).toBeNull();
    expect((document.querySelector("table")?.parentElement as HTMLElement).scrollLeft).toBe(0);
  });

  it("범례·설명 글은 상자 왼쪽에 붙어(sticky left-0) 오른쪽 끝에서 시작해도 보인다", () => {
    stubBox(640, 482);
    render(<WeightHeatmap dates={DATES} series={SERIES} />);
    const legend = screen.getByRole("list", { name: "칸 색 단계" });
    expect(legend.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "left-0"]));
    expect((legend.nextElementSibling as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "left-0"]));
  });
});
