/**
 * QA-736 — 좁은 화면(390)에서 모의 개요 순자산 곡선의 판 경계 이름표('프레임 v2'·'프레임 v3')가 서로 겹쳐 읽히지 않음(진행 기록 넘긴 항목
 * frame-boundary-labels-overlap-390). 공용 MultiLineSeries의 세로 표시선 이름표는 선마다 그 선 옆에 그려, 이웃 선과의 간격이 이름표 폭보다
 * 좁으면 글자가 겹쳤습니다. 겹치는 뒤 이름표는 그리지 않고(선은 남음) — 판은 차트 아래 글 줄(frameworkBoundaryView text)이 모두 적습니다.
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(wrappers.test와 같음).
 * 390 화면의 패널 본문 폭(390 − 좌우 여백 32 − 패널 안쪽 24 ≈ 334px)을 그림 너비로 둡니다.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MultiLineSeries, SERIES_COLORS } from "@/components/charts";
import { axisLabelWidth } from "@/lib/lineChart";

function observeAs(width: number, height: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 거래일 열넷(10-23 ~ 11-11, 주말 뺌) — 출발 3주 뒤 모의 장부와 같은 길이. */
const DATES = [
  "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02",
  "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11",
];
const ROWS = DATES.map((date, index) => ({ date, a: 100000 + index * 100 }));
/** 판 경계 — v2·v3는 이웃한 두 거래일(그림 너비 약 260px ÷ 13칸 = 20px 간격 < 이름표 폭 약 50px). */
const MARKERS = [
  { x: "2026-10-26", label: "프레임 v1" },
  { x: "2026-11-04", label: "프레임 v2" },
  { x: "2026-11-05", label: "프레임 v3" },
];

/** 그린 이름표 글마다 [왼쪽, 오른쪽] x 범위(글 기준점 x와 정렬, 폭은 축 글 폭 어림 — lib/lineChart axisLabelWidth). */
function labelExtents(container: HTMLElement): { text: string; left: number; right: number }[] {
  return [...container.querySelectorAll("text.recharts-label")].map((node) => {
    const text = node.textContent ?? "";
    const x = Number(node.getAttribute("x"));
    const width = axisLabelWidth(text, 12);
    const anchor = node.getAttribute("text-anchor");
    const left = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
    return { text, left, right: left + width };
  });
}

describe("QA-736 — 판 경계 이름표가 좁은 그림에서 겹치지 않는다", () => {
  it("390 그림(334px): 그린 이름표끼리 x 범위가 겹치지 않고, 세로선은 셋 모두 남는다", () => {
    observeAs(334, 300);
    const { container } = render(
      <MultiLineSeries data={ROWS} series={[{ key: "a", name: "규칙 계좌", color: SERIES_COLORS.blue }]} markers={MARKERS} />,
    );
    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(3);
    const extents = labelExtents(container).sort((a, b) => a.left - b.left);
    expect(extents.length).toBeGreaterThan(0);
    for (let index = 1; index < extents.length; index += 1) {
      expect(extents[index].left, `${extents[index - 1].text} / ${extents[index].text}`).toBeGreaterThanOrEqual(extents[index - 1].right);
    }
  });

  it("넓은 그림(1100px)에서는 이름표 셋이 모두 보인다(간격이 이름표 폭보다 넓음)", () => {
    observeAs(1100, 300);
    const { container } = render(
      <MultiLineSeries data={ROWS} series={[{ key: "a", name: "규칙 계좌", color: SERIES_COLORS.blue }]} markers={MARKERS} />,
    );
    expect(labelExtents(container).map((entry) => entry.text)).toEqual(["프레임 v1", "프레임 v2", "프레임 v3"]);
  });
});

/**
 * QA-777 — QA-736 고침이 이름표 폭을 축 글 폭 어림(axisLabelWidth — 한글 한 자를 라틴 두 칸 × 0.6em = 1.2em)으로 셈해, 겹치지 않는 이름표까지 숨겼습니다.
 * '프레임 v4'는 그 어림으로 64.8px이지만 브라우저가 그린 폭은 52px였습니다(검토 자기 빌드 390 — v2 이름표 끝과 22px 떨어진 v4 이름표가 숨음).
 * 이웃 두 선의 간격이 64px이면 실제 이름표(52px)는 4px 넘게 떨어지는데, 예전 어림(64.8 + 4)으로는 겹친다고 보았습니다. 왼쪽 축 폭을 고정(axisWidth)해 그림
 * 너비 256px(5행 — 행 사이 64px)로 둡니다.
 */
describe("QA-777 — 겹치지 않는 판 경계 이름표는 숨기지 않는다", () => {
  const rows = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"].map((date, index) => ({ date, a: 100000 + index * 100 }));
  it.fails("행 사이 64px의 이웃 두 선(오른쪽 이름표) — '프레임 v2'·'프레임 v3' 둘 다 그린다", () => {
    observeAs(60 + 256 + 8, 300);
    const { container } = render(
      <MultiLineSeries
        data={rows}
        series={[{ key: "a", name: "규칙 계좌", color: SERIES_COLORS.blue }]}
        axisWidth={60}
        markers={[{ x: "2026-11-12", label: "프레임 v2" }, { x: "2026-11-13", label: "프레임 v3" }]}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(2);
    expect([...container.querySelectorAll("text.recharts-label")].map((node) => node.textContent)).toEqual(["프레임 v2", "프레임 v3"]);
  });
});

