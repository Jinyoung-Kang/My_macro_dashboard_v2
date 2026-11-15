/**
 * AI 리포트 목차(절이 셋 이상일 때 맨 위의 앵커 링크 묶음)의 누르는 자리 — 좁은 화면(lg 미만) 44px(작업대 실행 명세 §3-7, QA-458과 같은 기준).
 * jsdom은 배치를 재지 않아 높이는 클래스로 따집니다(lib/__tests__/touchTargetAudit).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import { ReportView } from "../ai/report/ReportView";

afterEach(() => cleanup());

const REPORT = `## 1. 핵심 요약
- 합성 요약 한 줄

## 2. 수급
- 합성 수급 한 줄

## 3. 데이터 신뢰도
- 합성 신뢰도 한 줄
`;

describe("AI 리포트 목차", () => {
  // QA-472: 목차 링크가 알약(px-2.5 py-1 text-xs — 높이 약 26px)이라 좁은 화면 누르는 자리 44px에 못 미침.
  it.fails("QA-472: 목차 링크는 좁은 화면에서 누르는 자리 44px", () => {
    render(<ReportView markdown={REPORT} />);
    const toc = screen.getByRole("navigation", { name: "리포트 목차" });
    expect(toc.querySelectorAll("a")).toHaveLength(3);
    expect(smallTargets(toc)).toEqual([]);
  });
});
