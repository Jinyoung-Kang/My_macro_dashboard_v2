/**
 * 대화상자(Dialog) — Radix Dialog를 감싼 것.
 *
 *  - 닫혀 있으면 내용이 DOM에 없고, 열리면 role="dialog"에 제목이 이름으로, 설명이 aria-describedby로 붙는다
 *  - 제목을 숨겨도(hideTitle) 이름은 남는다
 *  - Esc·닫기 단추는 onOpenChange(false) — dismissible=false면 둘 다 막힌다(처리 중)
 *  - Trigger 없이 연 창도 닫으면 연 단추로 포커스가 돌아간다
 *  - 움직임은 motion-safe: 안에만(움직임 줄이기면 없음)
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "../Dialog";

afterEach(() => cleanup());

describe("열림과 닫힘", () => {
  it("닫혀 있으면 대화상자가 DOM에 없다", () => {
    render(<Dialog open={false} onOpenChange={() => {}} title="계좌 초기화">내용</Dialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("내용")).toBeNull();
  });

  it("열리면 제목이 이름, 설명이 aria-describedby — 닫기 단추는 한국어 이름", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="계좌 초기화" description={<p>되돌릴 수 없습니다.</p>}>
        <p>내용</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "계좌 초기화" });
    const described = dialog.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe("되돌릴 수 없습니다.");
    expect(screen.getByText("내용")).toBeTruthy();
    expect(screen.getByRole("button", { name: "닫기" })).toBeTruthy();
  });

  it("설명이 없으면 aria-describedby도 없다", () => {
    render(<Dialog open onOpenChange={() => {}} title="검색">내용</Dialog>);
    expect(screen.getByRole("dialog", { name: "검색" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("hideTitle이면 제목은 화면에서 숨지만 이름은 남는다", () => {
    render(<Dialog open onOpenChange={() => {}} title="통합 검색" hideTitle>내용</Dialog>);
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "통합 검색" });
    expect(heading.style.position).toBe("absolute");
    expect(heading.style.width).toBe("1px");
  });

  it("showClose={false}면 닫기 단추가 없다", () => {
    render(<Dialog open onOpenChange={() => {}} title="확인" showClose={false}>내용</Dialog>);
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
  });
});

describe("닫기", () => {
  it("Esc와 닫기 단추는 onOpenChange(false)를 부른다", () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="계좌 초기화">내용</Dialog>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissible={false}(처리 중)면 Esc로 닫히지 않고 닫기 단추는 비활성", () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="계좌 초기화" dismissible={false}>내용</Dialog>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const close = screen.getByRole("button", { name: "닫기" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>초기화</button>
      <Dialog open={open} onOpenChange={setOpen} title="계좌 초기화">
        <button type="button">안쪽 단추</button>
      </Dialog>
    </>
  );
}

describe("포커스", () => {
  it("열면 포커스가 안으로 들어가고, 닫으면 연 단추로 돌아온다(Trigger 없이 연 창도)", async () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "초기화" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "계좌 초기화" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // 닫기 단추는 DOM 맨 끝 — 첫 포커스는 내용 쪽
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "안쪽 단추" }));

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("trigger를 넘기면 aria-haspopup=dialog·aria-expanded가 붙는다", () => {
    function WithTrigger() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog open={open} onOpenChange={setOpen} title="통합 검색" trigger={<button type="button">검색</button>}>
          내용
        </Dialog>
      );
    }
    render(<WithTrigger />);
    const trigger = screen.getByRole("button", { name: "검색" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("움직임 줄이기", () => {
  it("전환·애니메이션 클래스는 전부 motion-safe: 안에만 있다", () => {
    render(<Dialog open onOpenChange={() => {}} title="계좌 초기화">내용</Dialog>);
    const classes = Array.from(document.body.querySelectorAll("[class]")).flatMap((el) => el.getAttribute("class")?.split(/\s+/) ?? []);
    const moving = classes.filter((name) => /(^|:)(transition|duration-|animate-|starting:)/.test(name));
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.filter((name) => !name.startsWith("motion-safe:"))).toEqual([]);
  });
});
