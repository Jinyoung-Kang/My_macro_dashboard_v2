/**
 * 맨 위로(TOP) 단추 — 정보 검색 QA(2026-11-15, QA 스택 브라우저 확인)에서 나온 결함의 재현.
 * 공용 단추라(정보 검색 z-20 · 모의 매매 · 정보 수집 기본 z-40) 두 층 모두 같은 규칙을 지키는지 봅니다.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  // QA-426: 키보드로 누르면 맨 위에 닿아 단추가 사라지고(400px 아래면 그리지 않음) 포커스가 body로 떨어짐 — 다음 Tab이 화면 끝의 아래
  // 탭 막대로 감(WCAG 2.4.3). 넓은 화면(본문 main#main이 스크롤)과 휴대폰(창이 스크롤) 둘 다. 본문은 셸에서 tabIndex=-1(건너뛰기 링크의
  // 대상)이라 여기서도 그렇게 둡니다. 브라우저는 단추 위 Enter·Space를 click으로 바꾸므로 포커스를 둔 뒤 click으로 누릅니다.
  // 수정 전 실패: document.activeElement가 main이 아니라 body.
  it("키보드로 누르면 단추가 사라지므로 포커스를 본문 시작(main#main)으로 옮긴다 — 본문·창 스크롤 모두(WCAG 2.4.3)", () => {
    main.tabIndex = -1;
    const focus = vi.spyOn(main, "focus");
    const scrollWindow = (top: number) =>
      act(() => {
        (window as { scrollY: number }).scrollY = top;
        window.dispatchEvent(new Event("scroll"));
      });
    for (const scroll of [scrollMain, scrollWindow]) {
      const { unmount } = render(<ScrollTopButton layer="z-20" />);
      scroll(1500);
      const button = screen.getByRole("button", { name: "맨 위로" });
      button.focus();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      scroll(0); // 맨 위에 닿아 단추가 사라짐
      expect(screen.queryByRole("button", { name: "맨 위로" })).toBeNull();
      expect(document.activeElement).toBe(main);
      // 포커스가 본문을 끌어당겨 부드러운 스크롤을 끊거나 창을 본문 머리로 옮기지 않게.
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      unmount();
      main.blur();
      focus.mockClear();
    }
  });

  it("본문(main#main)이 없는 화면에서도 누르면 창을 올리고 깨지지 않는다(QA-426 고침의 바깥 경우)", () => {
    main.remove();
    render(<ScrollTopButton />);
    act(() => {
      (window as { scrollY: number }).scrollY = 900;
      window.dispatchEvent(new Event("scroll"));
    });
    fireEvent.click(screen.getByRole("button", { name: "맨 위로" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
