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
  it("수식키 없는 누름 — 기본 동작을 막고 pushState(null, '', '#절')로 기록 하나, 그 절로 scrollIntoView하고 절 제목에 포커스 — 수식키 누름은 브라우저에 맡김", () => {
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
      // 포커스는 절이 아니라 절 제목(아래 QA-680 보강 시험).
      expect(document.activeElement).toBe(section.querySelector("h3"));
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

  // QA-680 보강: 고침이 포커스를 절(section, 이름 없음 — generic)에 두어 크롬이 접근 이름을 절 내용 전체로 계산했습니다(머리 없는 크롬 CDP — '핵심 요약 요약
  // 본문', nameSources contents). 낭독기가 목차를 누를 때마다 절 전체를 읽으므로 포커스는 절 제목(h3)에 둡니다(옮기기는 그대로 절). 수정 전(재현 커밋에서는
  // it.fails)에는 포커스가 section이었습니다. 고침: lib/hashLink followHashLink가 닻 안 첫 제목에 포커스(제목이 없으면 닻).
  it("포커스는 절 제목(h3 — 접근 이름 = 목차 칸 글)에, 옮기기는 절", () => {
    const listener = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("click", listener);
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const base = window.location.pathname + window.location.search;
    try {
      render(<ReportView markdown={REPORT} />);
      const link = screen.getByRole("navigation", { name: "리포트 목차" }).querySelectorAll("a")[1];
      fireEvent.click(link);
      const section = document.getElementById((link.getAttribute("href") as string).slice(1)) as HTMLElement;
      expect(into.mock.contexts).toEqual([section]);
      const title = screen.getByRole("heading", { name: link.textContent as string, level: 3 });
      expect(section.contains(title)).toBe(true);
      expect(document.activeElement).toBe(title);
    } finally {
      window.removeEventListener("click", listener);
      window.history.replaceState(null, "", base);
      into.mockRestore();
    }
  });
});

// QA-688: QA-680 고침(058ddf83)이 리포트 절(section)에 tabIndex -1을 늘 붙였습니다. 크롬은 뒤로·앞으로 가기(기록 이동)의 조각 처리에서 해시가 가리키는 절이
// 포커스를 받을 수 있으면 그 절에 포커스를 두어(QA 스택 qa@2d111589 1440·390 /ai/report), 이름 없는 section(generic)의 접근 이름을 절 내용 전체(합성 리포트
// 821~1,526자, nameSources contents)로 읽었습니다. 절에는 늘 tabindex를 두지 않고, 제목이 포커스를 받지 못할 때만(숨은 제목) 그때 붙였다가 떠나면 뗍니다.
// jsdom은 기록 이동의 조각 처리를 재현하지 못해 tabindex 속성과 대체 길(제목 포커스 실패 — focus를 막아 흉내)을 봅니다. 수정 전(재현 커밋에서는 it.fails)에는
// 절에 tabindex -1이 늘 있었습니다.
describe("QA-688 리포트 절은 늘 포커스를 받는 자리가 아니다 — 뒤로·앞으로 가기가 절에 포커스를 두지 않게", () => {
  it.fails("리포트 절에는 tabindex가 없다", () => {
    render(<ReportView markdown={REPORT} />);
    const sections = Array.from(document.querySelectorAll("section"));
    expect(sections).toHaveLength(3);
    // 결함을 직접 보는 단언(수정 전에는 tabindex -1 — 크롬 기록 이동이 그 절에 포커스).
    expect(sections.map((section) => section.getAttribute("tabindex"))).toEqual([null, null, null]);
  });

  it.fails("절 제목이 포커스를 받지 못하면 그때만 절에 tabindex -1을 붙여 포커스하고, 포커스가 떠나면 뗀다", () => {
    const listener = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("click", listener);
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    // 숨은 제목처럼 h3는 포커스를 받지 못하게 합니다.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.tagName !== "H3") focus.call(this, options);
    });
    const base = window.location.pathname + window.location.search;
    try {
      render(<ReportView markdown={REPORT} />);
      const links = screen.getByRole("navigation", { name: "리포트 목차" }).querySelectorAll("a");
      const section = (link: Element) => document.getElementById((link.getAttribute("href") as string).slice(1)) as HTMLElement;
      fireEvent.click(links[1]);
      const second = section(links[1]);
      expect(document.activeElement).toBe(second);
      expect(second.getAttribute("tabindex")).toBe("-1");
      // 제목에 붙였다가 포커스를 받지 못한 tabindex는 바로 뗀다.
      expect(second.querySelector("h3")?.hasAttribute("tabindex")).toBe(false);
      fireEvent.click(links[2]);
      expect(document.activeElement).toBe(section(links[2]));
      // 결함을 직접 보는 단언(수정 전에는 떠난 절에도 tabindex -1이 남음).
      expect(second.hasAttribute("tabindex")).toBe(false);
    } finally {
      window.removeEventListener("click", listener);
      window.history.replaceState(null, "", base);
      into.mockRestore();
    }
  });
});
