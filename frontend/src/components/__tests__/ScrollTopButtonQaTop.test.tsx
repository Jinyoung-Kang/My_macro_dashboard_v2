/**
 * 맨 위로(TOP) 단추 — 정보 검색 QA(2026-11-15, QA 스택 브라우저 확인)에서 나온 결함의 재현.
 * 공용 단추라(정보 검색 z-20 · 모의 매매 · 정보 수집 기본 z-40) 두 층 모두 같은 규칙을 지키는지 봅니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollTopButton } from "@/components/ScrollTopButton";

let main: HTMLElement;

beforeEach(() => {
  main = document.createElement("main");
  main.id = "main";
  document.body.appendChild(main);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  main.scrollTo = vi.fn() as unknown as typeof main.scrollTo;
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  main.remove();
});

function scrollMain(top: number) {
  act(() => {
    main.scrollTop = top;
    main.dispatchEvent(new Event("scroll"));
  });
}

/** 클래스 이름 하나가 공백으로 나뉜 낱말로 들어 있는가(`lg:min-h-11` 같은 접두 붙은 이름과 헷갈리지 않게). */
function hasClass(className: string, name: string): boolean {
  return className.split(/\s+/).includes(name);
}

describe("ScrollTopButton — 정보 검색 QA", () => {
  // QA-425: lg 미만 누름 자리가 44px에 못 미침(py-2 16 + text-xs 줄 높이 16 + 테두리 2 = 34px, 390에서 68x34 측정).
  // ADR 0041 결정 11 'lg 미만 누름 자리 44px'. jsdom은 레이아웃을 재지 못하므로 고친 뒤의 클래스 약속(lg 미만 최소 높이 44px =
  // min-h-11, 넓은 화면은 지금 모양 그대로 lg:min-h-0, 글은 세로 가운데, 아래 탭 막대 위 자리 그대로)을 봅니다.
  // 수정 전 실패: 클래스에 min-h-11이 없음.
  it("lg 미만 누름 자리 44px(min-h-11), 넓은 화면은 지금 모양 — 두 층 모두(ADR 0041 결정 11)", () => {
    for (const layer of [undefined, "z-20"]) {
      const { unmount } = render(layer ? <ScrollTopButton layer={layer} /> : <ScrollTopButton />);
      scrollMain(500);
      const className = screen.getByRole("button", { name: "맨 위로" }).className;
      expect(hasClass(className, "min-h-11")).toBe(true);
      expect(hasClass(className, "lg:min-h-0")).toBe(true);
      expect(hasClass(className, "items-center")).toBe(true);
      expect(hasClass(className, "bottom-[calc(64px+1rem+env(safe-area-inset-bottom))]")).toBe(true);
      expect(hasClass(className, "lg:bottom-6")).toBe(true);
      unmount();
      scrollMain(0);
    }
  });
});
