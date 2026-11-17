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
    expect(screen.queryByRole("button", { name: "TOP 맨 위로" })).toBeNull();
    scrollMain(401);
    expect(screen.getByRole("button", { name: "TOP 맨 위로" }).textContent).toContain("TOP");
    scrollMain(100);
    expect(screen.queryByRole("button", { name: "TOP 맨 위로" })).toBeNull();
  });

  it("창이 내려가도 나타나고, 누르면 창과 본문을 모두 맨 위로 부드럽게", () => {
    render(<ScrollTopButton />);
    act(() => {
      (window as { scrollY: number }).scrollY = 800;
      window.dispatchEvent(new Event("scroll"));
    });
    fireEvent.click(screen.getByRole("button", { name: "TOP 맨 위로" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("층(z-index)은 기본 z-40이고 화면이 낮출 수 있다 — 정보 검색은 휴대폰 미리보기 서랍(z-30) 아래", () => {
    const { unmount } = render(<ScrollTopButton />);
    scrollMain(500);
    expect(screen.getByRole("button", { name: "TOP 맨 위로" }).className).toContain("z-40");
    unmount();
    render(<ScrollTopButton layer="z-20" />);
    scrollMain(600);
    const lowered = screen.getByRole("button", { name: "TOP 맨 위로" }).className;
    expect(lowered).toContain("z-20");
    expect(lowered).not.toContain("z-40");
  });

  it("떠 있는 덮개 모양 — 4px 모서리·surface-2 바탕·안쪽 밝은 경계·덮개 그림자, hover는 덮개 안 hover 면(작업대 실행 명세 §3-3·§3-8)", () => {
    render(<ScrollTopButton />);
    scrollMain(500);
    const classes = screen.getByRole("button", { name: "TOP 맨 위로" }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["rounded-control", "bg-surface-2", "border-border-overlay", "shadow-overlay", "hover:bg-surface-3"]));
    expect(classes).not.toContain("rounded-full");
  });

  it("움직임을 줄이는 설정이면 바로 올린다", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    render(<ScrollTopButton />);
    scrollMain(500);
    fireEvent.click(screen.getByRole("button", { name: "TOP 맨 위로" }));
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});

// QA-686(11-18 요청 QA 스택 확인, qa@06f93335): 셸 본문(main)의 아래 여백은 아래 탭 막대와의 틈만 두는데(lg 미만 64px + 16px, lg 24px) TOP 단추가 같은
// 자리에서 위로 44px(lg 30px) 솟아, 맨 아래까지 내려도 본문 마지막 글(390 /macro 경제 캘린더 안내 두 줄 — /paper·/info도 같은 구조)의 오른쪽 끝을 가렸습니다.
// 단추가 있는 화면은 단추를 그리기 전에도(마운트 때 — 보일 때 세우면 스크롤 중 본문 높이가 바뀜) 문서 루트에 단추 자리(단추 높이 + 틈 8px —
// lg 미만 44 + 8, lg 30 + 8)를 세우고 셸 본문의 아래 여백이 그만큼 더합니다(Shell.test). 수정 전(재현 커밋에서는 it.fails) 변수가 없었습니다.
describe("QA-686 TOP 단추가 있는 화면은 본문 끝에 단추 자리를 둔다", () => {
  const rootStyle = () => document.documentElement.style;

  it("마운트하면(단추가 아직 없어도) 문서 루트에 단추 자리 — lg 미만 52px·lg 38px, 보였다 사라져도 그대로, 언마운트하면 지운다", () => {
    const { unmount } = render(<ScrollTopButton />);
    expect(screen.queryByRole("button", { name: "TOP 맨 위로" })).toBeNull();
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("52px");
    expect(rootStyle().getPropertyValue("--scroll-top-reserve-lg")).toBe("38px");
    scrollMain(500);
    scrollMain(0);
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("52px");
    unmount();
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("");
    expect(rootStyle().getPropertyValue("--scroll-top-reserve-lg")).toBe("");
  });

  // 보강(검토 지적): 단추 높이는 rem이라(lg 미만 min-h-11 = 2.75rem, lg는 min-h-[30px]와 내용 높이 — text-xs 줄 높이 1rem + py-1 0.5rem + 경계 2px
  // 가운데 큰 것) 브라우저 기본 글자 크기를 키우면 함께 자라는데(루트 글자 크기를 고정하지 않음), 단추 자리는 px 상수(52·38px)라 sm 미만에서 20px이면 3px,
  // 24px이면 14px 다시 가렸습니다(lg는 24px에서 틈 8px가 0). 단추 자리를 단추와 같은 단위의 식으로 적어 기본 16px에서는 전과 같은 52·38px이고
  // 글자 크기를 키우면 따라 자랍니다. 식이 기대는 단추 클래스도 함께 묶어 둡니다(한쪽만 바꾸면 이 시험이 막음). 수정 전(재현 커밋에서는 it.fails) '52px'였습니다.
  it.fails("단추 자리는 단추 높이와 같은 단위 — lg 미만 calc(2.75rem + 8px)·lg calc(max(30px, 1.5rem + 2px) + 8px), 단추 클래스가 그 식의 바탕", () => {
    render(<ScrollTopButton />);
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("calc(2.75rem + 8px)");
    expect(rootStyle().getPropertyValue("--scroll-top-reserve-lg")).toBe("calc(max(30px, 1.5rem + 2px) + 8px)");
    scrollMain(500);
    const classes = screen.getByRole("button", { name: "TOP 맨 위로" }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["min-h-11", "py-2", "text-xs", "border", "lg:min-h-[30px]", "lg:py-1"]));
  });

  it("화면이 바뀌는 사이 둘이 겹쳐 마운트돼도 마지막 하나가 떠날 때만 지운다", () => {
    const first = render(<ScrollTopButton />);
    const second = render(<ScrollTopButton layer="z-20" />);
    first.unmount();
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("52px");
    second.unmount();
    expect(rootStyle().getPropertyValue("--scroll-top-reserve")).toBe("");
  });
});
