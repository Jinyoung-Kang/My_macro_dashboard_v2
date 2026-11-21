/**
 * 공용 Button의 요청 중(busy — QA-899)과 낭독 이름·설명(ariaLabel·describedBy — QA-900).
 *
 * - busy: 진짜 disabled가 아니라 aria-disabled, 누름 무시(submit이면 폼 보내기도 막음), 꺼진 단추와 같은 흐림·커서.
 * - busy·ariaLabel·describedBy를 주지 않은 단추는 속성·클래스 글이 예전과 같습니다(다른 화면의 DOM 그대로).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, buttonClasses } from "@/components/ui";

afterEach(() => cleanup());

describe("Button busy·ariaLabel·describedBy", () => {
  it("아무것도 주지 않으면 예전 그대로 — aria-disabled·aria-label·aria-describedby 없음, 클래스 글은 buttonClasses 그대로", () => {
    render(<Button onClick={() => {}}>저장</Button>);
    const button = screen.getByRole("button", { name: "저장" });
    for (const name of ["aria-disabled", "aria-label", "aria-describedby", "disabled"]) expect(button.hasAttribute(name), name).toBe(false);
    expect(button.className).toBe(buttonClasses("default", "md"));
  });

  it("busy면 aria-disabled(진짜 disabled 아님)·누름 무시·꺼진 단추와 같은 흐림, 끝나면 다시 누름", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick} busy>저장 중…</Button>);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.className).toContain("aria-disabled:opacity-50");
    expect(button.className).toContain("aria-disabled:cursor-not-allowed");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>저장</Button>);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.className).toBe(buttonClasses("default", "md"));
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("busy인 submit 단추는 폼을 보내지 않는다", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <Button type="submit" busy>
          보내는 중…
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ariaLabel은 낭독 이름, describedBy는 보이는 글·이름을 그대로 둔 채 가리킨 요소를 설명으로", () => {
    render(
      <>
        <span id="row-name">macro_collected</span>
        <Button describedBy="row-name">다시 실행</Button>
        <Button ariaLabel="닫기 — 원문">×</Button>
      </>,
    );
    const run = screen.getByRole("button", { name: "다시 실행" });
    expect(run.getAttribute("aria-describedby")).toBe("row-name");
    expect(run.textContent).toBe("다시 실행");
    expect(screen.getByRole("button", { name: "닫기 — 원문" }).textContent).toBe("×");
  });
});
