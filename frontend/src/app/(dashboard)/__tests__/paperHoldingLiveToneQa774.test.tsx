/**
 * QA-774 — 보유 검사 칸(작업대 P6 HoldingInspector)의 '실시간(표시 전용)' 속성이 등락색(상승 빨강·하락 파랑)을 값 글 전체('{가격} 원 · 평단 대비 +2.86%')에
 * 입혀, 오르내림 값이 아닌 실시간 가격까지 칠하던 결함(원칙: 상승·하락 색은 오르내린 값에만). 같은 값을 보이는 보유 표의 실시간 칸은 % 부분만 칠합니다.
 * 값은 합성 값입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HoldingInspector } from "@/components/screens/paper/HoldingInspector";
import type { LivePrice, PaperPosition } from "@/lib/types";

const POSITION = {
  ticker: "005930", qty: 10, avgCost: 70000, lastPrice: 71000, lastPriceAtKst: null, marketValue: 710000, weightPct: 2, unrealizedPct: 1.43,
  highWatermark: 72000, stopPrice: null, stopDistancePct: null, openedOn: "2026-10-23", holdingTradingDays: null, priceStale: false,
  splitNote: null, cashLike: false, backfilled: false,
} as unknown as PaperPosition;
const LIVE = { price: 72000, tradedAt: "2026-11-03T01:00:00Z", session: null, prevClose: null } as unknown as LivePrice;

afterEach(() => cleanup());

/** 글 조각을 담은 가장 안쪽 요소부터 위로 올라가며 등락색 클래스가 있는지. */
function painted(element: Element | null, stop: Element): boolean {
  for (let node = element; node !== null && node !== stop; node = node.parentElement) {
    if (/\btext-(up|down)\b/.test(node.getAttribute("class") ?? "")) return true;
  }
  return false;
}

describe("QA-774 — 실시간 속성은 평단 대비 %만 등락색", () => {
  it("가격 글은 본문색, '+2.86%'만 상승색", () => {
    render(<HoldingInspector position={POSITION} market="KR" live={LIVE} />);
    const term = screen.getByText("실시간(표시 전용)", { selector: "dt" });
    const value = term.parentElement?.querySelector("dd") as HTMLElement;
    expect(value.textContent).toMatch(/^72,000 원 · 평단 대비 \+2\.86%/);
    const pct = Array.from(value.querySelectorAll("*")).find((node) => node.textContent === "+2.86%") ?? null;
    expect(pct).not.toBeNull();
    expect(painted(pct, value)).toBe(true);
    // 가격 글 '72,000 원'을 담은 가장 안쪽 요소는 칠하지 않습니다.
    const priceHolder = Array.from(value.querySelectorAll("*"))
      .filter((node) => (node.textContent ?? "").includes("72,000 원"))
      .pop() ?? value;
    expect(painted(priceHolder, value)).toBe(false);
  });
});
