/**
 * AI 리포트의 판정 기호(초록·빨강·흰 원)는 화면에서 글 배지 '우호'·'비우호'·'중립·보류'로 그린다(명세 D8 e).
 * ▲▼와 상승·하락 색은 값 변화에만 쓴다 — 'VIX 상승 → 비우호'가 하락(▼)으로 읽히지 않게. 원문(복사·다운로드)은 그대로.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportView } from "../ai/report/ReportView";

afterEach(() => cleanup());

const REPORT = `## 1. 핵심 요약
- **[변동성]** VIX 상승 → 🔴 위험 회피
- **[유동성]** 🟢 순유동성 증가

## 2. 수급
| 항목 | 판정 | 값 |
|---|---|---|
| 외국인 | 🟢 | 1,339.98 |
| 기관 | ⚪ | 102.34 |
`;

describe("AI 리포트 판정 배지", () => {
  it("기호 대신 글 배지 — 중립 바탕, 상승·하락 색과 ▲▼를 쓰지 않는다", () => {
    const { container } = render(<ReportView markdown={REPORT} />);

    expect(screen.getAllByText("비우호")).toHaveLength(1);
    expect(screen.getAllByText("우호")).toHaveLength(2);
    expect(screen.getByText("중립·보류")).toBeTruthy();
    const badge = screen.getAllByText("우호")[0];
    expect(badge.className).toContain("bg-surface-2");
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".text-up, .text-down")).toBeNull();
    expect(container.textContent).not.toMatch(/[▲▼]|\p{Extended_Pictographic}/u);
  });

  it("표 칸의 기호도 배지로 — 숫자 열 판정(오른쪽 정렬)은 원문 기준 그대로", () => {
    render(<ReportView markdown={REPORT} />);
    const table = screen.getByRole("table");
    const foreigner = within(table).getByText("외국인").closest("tr") as HTMLElement;
    expect(within(foreigner).getByText("우호")).toBeTruthy();
    expect(within(foreigner).getByText("1,339.98").closest("td")?.className).toContain("text-right");
  });
});
