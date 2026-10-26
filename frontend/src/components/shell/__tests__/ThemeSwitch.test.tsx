/**
 * 테마 전환 — 시스템(기본)·라이트·다크 라디오 묶음. 고르면 <html data-theme>와 저장값이 바뀌고, 한 화면에 둘이 있어도 함께 바뀐다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSwitch } from "../ThemeSwitch";

const html = () => document.documentElement;

afterEach(() => {
  cleanup();
  html().removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("테마 전환", () => {
  it("radiogroup 하나에 시스템·라이트·다크 순서, 기본은 시스템", () => {
    render(<ThemeSwitch />);
    const group = screen.getByRole("radiogroup", { name: "화면 테마" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual(["시스템", "라이트", "다크"]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(html().hasAttribute("data-theme")).toBe(false);
  });

  it("다크를 고르면 <html data-theme=dark>·저장, 시스템으로 돌리면 둘 다 지운다", () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole("radio", { name: "다크" }));
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect((screen.getByRole("radio", { name: "다크" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "시스템" }));
    expect(html().hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("theme")).toBeNull();
  });

  it("한 화면의 두 전환 단추(왼쪽 내비·더보기)는 묶음이 따로이면서 같은 선택을 보인다", () => {
    render(
      <>
        <ThemeSwitch />
        <ThemeSwitch />
      </>,
    );
    const [first, second] = screen.getAllByRole("radiogroup", { name: "화면 테마" });
    const nameOf = (group: HTMLElement) => (within(group).getAllByRole("radio")[0] as HTMLInputElement).name;
    expect(nameOf(first)).not.toBe(nameOf(second));

    fireEvent.click(within(first).getByRole("radio", { name: "라이트" }));
    expect((within(second).getByRole("radio", { name: "라이트" }) as HTMLInputElement).checked).toBe(true);
  });
});
