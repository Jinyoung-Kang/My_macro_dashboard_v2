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
  // QA-472: 목차 링크가 알약(px-2.5 py-1 text-xs — 높이 약 26px)이라 좁은 화면 누르는 자리 44px에 못 미쳤음. 고침: lg 미만 min-h-11.
  it("QA-472: 목차 링크는 좁은 화면에서 누르는 자리 44px", () => {
    render(<ReportView markdown={REPORT} />);
    const toc = screen.getByRole("navigation", { name: "리포트 목차" });
    expect(toc.querySelectorAll("a")).toHaveLength(3);
    expect(smallTargets(toc)).toEqual([]);
  });

  it("넓은 화면(lg 이상)은 기본 조작 높이 30px — 표 밖의 따로 선 링크(명세 §3-7, 상세 화면 '다른 곳에서 보기'와 같음)", () => {
    render(<ReportView markdown={REPORT} />);
    const links = Array.from(screen.getByRole("navigation", { name: "리포트 목차" }).querySelectorAll("a"));
    expect(links.map((link) => link.className.split(/\s+/).filter((name) => name.startsWith("lg:min-h-")))).toEqual([
      ["lg:min-h-[30px]"],
      ["lg:min-h-[30px]"],
      ["lg:min-h-[30px]"],
    ]);
  });
});
