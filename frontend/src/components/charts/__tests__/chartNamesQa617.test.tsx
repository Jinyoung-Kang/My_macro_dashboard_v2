/**
 * QA-617 — 막대(HorizontalBars·SignedBars)와 여러 선(MultiLineSeries) 차트의 Tab 정지점 그림(svg[role=application])에 이름이 없던 것
 * (D1 넘김 'chart-application-role-unnamed' — 이름 없는 그림 14곳 가운데 차트 래퍼의 기본값으로 고칠 몫).
 *
 * Recharts 3.10.1 접근성 층(기본 켬)이 그림(svg)에 role="application"·tabindex=0을 달아 키보드로 닿는데, 이름을 넘기지 않으면 화면 낭독기가 이름 없는
 * '응용 프로그램'만 읽습니다(WCAG 4.1.2). 선 차트(LineChart·LineSeries)는 이미 기본 이름('선 차트: 계열 · 첫 날짜 ~ 마지막 날짜')을 달고, 도넛은 이름이
 * 필수입니다. 여기서는 부르는 쪽이 이름을 넘기지 않아도 막대·여러 선 차트의 그림에 빈 이름이 없는지 봅니다(화면 단계가 더 구체적인 이름을 넘김).
 *
 * jsdom에는 크기가 없어 ResponsiveContainer가 너비를 모릅니다 — 관찰을 시작하면 정한 크기를 바로 알려 주는 가짜를 씁니다(wrappers.test와 같음).
 */
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HorizontalBars, LineSeries, MultiLineSeries, SERIES_COLORS, SignedBars } from "@/components/charts";

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

const BARS = [{ name: "1월", value: 3 }, { name: "2월", value: -2 }];
const ROWS = [
  { date: "2026-10-01", a: 100, b: 98 },
  { date: "2026-10-02", a: 101, b: 99 },
];

/** 그린 Tab 정지점 그림(svg[role=application])의 이름 — 그림이 없으면 오류. */
function surfaceName(chart: ReactElement): string | null {
  const { container } = render(chart);
  const surface = container.querySelector("svg.recharts-surface");
  if (!surface) throw new Error("그림이 그려지지 않았습니다");
  expect(surface.getAttribute("role")).toBe("application");
  return surface.getAttribute("aria-label");
}

describe("QA-617 막대·여러 선 차트 그림의 이름", () => {
  // 고치기 전: 세 그림 모두 aria-label이 없음(null) — 재현 커밋에서는 it.fails.
  it.each<[string, () => ReactElement]>([
    ["HorizontalBars", () => <HorizontalBars data={BARS} />],
    ["SignedBars", () => <SignedBars data={BARS} />],
    ["MultiLineSeries", () => (
      <MultiLineSeries
        data={ROWS}
        series={[{ key: "a", name: "종가", color: SERIES_COLORS.blue }, { key: "b", name: "기준선", color: SERIES_COLORS.orange }]}
      />
    )],
  ])("%s — 이름을 넘기지 않아도 그림에 빈 이름이 없다", (_name, chart) => {
    observeAs(600, 320);
    expect(surfaceName(chart())?.trim() ?? "").not.toBe("");
  });

  it("기본 이름 — 막대는 '막대 차트: {값 이름}', 여러 선은 선 차트와 같은 꼴 '선 차트: 계열들 · 첫 ~ 마지막 날짜'(꼬리 계열은 뺌)", () => {
    observeAs(600, 320);
    expect(surfaceName(<HorizontalBars data={BARS} valueName="수익률" />)).toBe("막대 차트: 수익률");
    cleanup();
    expect(surfaceName(<SignedBars data={BARS} />)).toBe("막대 차트: 순매수");
    cleanup();
    const tailRows = [...ROWS, { date: "2026-10-03", a: null, b: 99, t: 102 }];
    expect(
      surfaceName(
        <MultiLineSeries
          data={tailRows}
          series={[
            { key: "a", name: "종가", color: SERIES_COLORS.blue },
            { key: "b", name: "기준선", color: SERIES_COLORS.orange },
            { key: "t", name: "종가 · 추정 14:05", color: SERIES_COLORS.blue, tailOf: "a" },
          ]}
        />,
      ),
    ).toBe("선 차트: 종가, 기준선 · 2026-10-01 ~ 2026-10-03");
  });

  it("이름을 넘기면 그 이름 — 막대 둘·여러 선·단일 선(LineSeries) 모두", () => {
    observeAs(600, 320);
    expect(surfaceName(<HorizontalBars data={BARS} ariaLabel="섹터 1M 수익률" />)).toBe("섹터 1M 수익률");
    cleanup();
    expect(surfaceName(<SignedBars data={BARS} ariaLabel="외국인 순매수 (20거래일)" />)).toBe("외국인 순매수 (20거래일)");
    cleanup();
    expect(surfaceName(<MultiLineSeries data={ROWS} series={[{ key: "a", name: "종가", color: SERIES_COLORS.blue }]} ariaLabel="S&P 500 순포지션 추이" />)).toBe(
      "S&P 500 순포지션 추이",
    );
    cleanup();
    const points = [{ date: "2026-10-01", value: 5.9 }, { date: "2026-10-08", value: 6.0 }];
    expect(surfaceName(<LineSeries data={points} ariaLabel="순유동성 추이 (조 달러)" />)).toBe("순유동성 추이 (조 달러)");
    cleanup();
    // 넘기지 않으면 선 차트의 기본 이름 그대로(예전과 같음)
    expect(surfaceName(<LineSeries data={points} />)).toBe("선 차트: 값 · 2026-10-01 ~ 2026-10-08");
  });
});
