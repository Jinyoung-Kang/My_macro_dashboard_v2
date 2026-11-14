/**
 * 맨 위로(TOP) 단추(사용자 요청 2026-11-03, 모의 매매 화면) — 고정하는 규칙
 *  - 맨 위에서는 없고, 창이나 본문(main#main — 넓은 화면의 스크롤 칸)이 400px 넘게 내려가면 나타남
 *  - 누르면 창과 본문을 모두 맨 위로(움직임을 줄이는 설정이면 바로)
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

describe("ScrollTopButton", () => {
  it("맨 위에서는 없고, 본문이 400px 넘게 내려가면 나타났다가 다시 올라가면 사라진다", () => {
    render(<ScrollTopButton />);
    expect(screen.queryByRole("button", { name: "맨 위로" })).toBeNull();
    scrollMain(401);
    expect(screen.getByRole("button", { name: "맨 위로" }).textContent).toContain("TOP");
    scrollMain(100);
    expect(screen.queryByRole("button", { name: "맨 위로" })).toBeNull();
  });

  it("창이 내려가도 나타나고, 누르면 창과 본문을 모두 맨 위로 부드럽게", () => {
    render(<ScrollTopButton />);
    act(() => {
      (window as { scrollY: number }).scrollY = 800;
      window.dispatchEvent(new Event("scroll"));
    });
    fireEvent.click(screen.getByRole("button", { name: "맨 위로" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("층(z-index)은 기본 z-40이고 화면이 낮출 수 있다 — 정보 검색은 휴대폰 미리보기 서랍(z-30) 아래", () => {
    const { unmount } = render(<ScrollTopButton />);
    scrollMain(500);
    expect(screen.getByRole("button", { name: "맨 위로" }).className).toContain("z-40");
    unmount();
    render(<ScrollTopButton layer="z-20" />);
    scrollMain(600);
    const lowered = screen.getByRole("button", { name: "맨 위로" }).className;
    expect(lowered).toContain("z-20");
    expect(lowered).not.toContain("z-40");
  });

  it("움직임을 줄이는 설정이면 바로 올린다", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    render(<ScrollTopButton />);
    scrollMain(500);
    fireEvent.click(screen.getByRole("button", { name: "맨 위로" }));
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});
