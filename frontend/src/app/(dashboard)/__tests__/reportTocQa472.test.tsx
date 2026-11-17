/**
 * AI 리포트 목차(절이 셋 이상일 때 맨 위의 앵커 링크 묶음)의 누르는 자리 — 좁은 화면(lg 미만) 44px(작업대 실행 명세 §3-7, QA-458과 같은 기준).
 * jsdom은 배치를 재지 않아 높이는 클래스로 따집니다(lib/__tests__/touchTargetAudit).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// QA-680: 리포트 목차도 보통 링크(<a href="#section-n">)라 누르면 브라우저 기본 해시 이동이 상태 없는 기록(history.state null)을 쌓았고, Next 앱 라우터는
// 뒤로 가기에서 그 기록을 무시해 다른 화면으로 갔다가 돌아오면 주소만 /ai/report#section-n이고 화면은 다른 화면에 남았습니다(D3 전 QA 스택 qa@65caf1e8,
// 1440 — 한 번 더 뒤로 가야 리포트). 긴 화면 목차(SectionIndex)와 같은 원인·같은 고침입니다. 기본 동작이 막혔는지는 창까지 올라온 click에서 적고, 남은 기본
// 동작(jsdom의 해시 이동)은 거기서 막습니다. 수정 전(재현 커밋에서는 it.fails)에는 막지 않아 pushState를 부르지 않았습니다.
describe("QA-680 리포트 목차 누름은 기본 해시 이동 대신 pushState로 기록을 쌓고 그 절로 옮긴다", () => {
  it("수식키 없는 누름 — 기본 동작을 막고 pushState(null, '', '#절')로 기록 하나, 그 절로 scrollIntoView하고 절에 포커스 — 수식키 누름은 브라우저에 맡김", () => {
    const prevented: boolean[] = [];
    const listener = (event: MouseEvent) => {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener("click", listener);
    const push = vi.spyOn(window.history, "pushState");
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const base = window.location.pathname + window.location.search;
    try {
      render(<ReportView markdown={REPORT} />);
      const link = screen.getByRole("navigation", { name: "리포트 목차" }).querySelectorAll("a")[1];
      const href = link.getAttribute("href") as string;
      fireEvent.click(link);
      expect(prevented).toEqual([true]);
      expect(push.mock.calls).toEqual([[null, "", href]]);
      const section = document.getElementById(href.slice(1)) as HTMLElement;
      expect(section.tagName).toBe("SECTION");
      expect(into.mock.contexts).toEqual([section]);
      expect(document.activeElement).toBe(section);
      // 수식키 누름(새 탭 등)은 브라우저에 맡김
      fireEvent.click(link, { ctrlKey: true });
      expect(prevented).toEqual([true, false]);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", listener);
      window.history.replaceState(null, "", base);
      push.mockRestore();
      into.mockRestore();
    }
  });
});
