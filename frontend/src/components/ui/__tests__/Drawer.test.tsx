/**
 * 서랍(ui/Drawer — 공용 대화상자의 오른쪽 세로 패널 배치, 작업대 P6 '이 장부의 한계').
 *
 *  - 닫혀 있으면 DOM에 없고, 열리면 role="dialog"의 이름이 제목·설명이 aria-describedby
 *  - Esc·바깥 누르기·닫기 단추로 닫히고(onOpenChange(false)), 여는 단추(trigger)로 포커스가 돌아온다(aria-haspopup="dialog"·aria-expanded)
 *  - 모양: 오른쪽 끝 화면 높이 패널, 좁은 화면 전체 폭(w-full)·넓은 화면 폭(md 28rem·lg 42rem), 덮개 3층·덮개 범위 표지(data-overlay)
 *  - 고대비(forced-colors): 그림자는 지워지므로 화면 쪽 가장자리를 경계선(border-l — 시스템 색으로 남음)이 가른다
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Drawer } from "../Drawer";

afterEach(() => cleanup());

function WithTrigger({ width }: { width?: "md" | "lg" }) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="이 장부의 한계"
      description="서버가 보낸 한계 문구 그대로입니다."
      width={width}
      trigger={<button type="button">이 장부의 한계 (2줄)</button>}
    >
      <ol>
        <li>모의 매매입니다.</li>
      </ol>
    </Drawer>
  );
}

const trigger = () => screen.getByRole("button", { name: "이 장부의 한계 (2줄)" });

describe("Drawer", () => {
  it("닫혀 있으면 DOM에 없고, 여는 단추는 aria-haspopup=dialog·aria-expanded=false", () => {
    render(<WithTrigger />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("모의 매매입니다.")).toBeNull();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("열면 이름 = 제목, 설명 = aria-describedby, 내용이 보인다", () => {
    render(<WithTrigger />);
    const opener = trigger();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "이 장부의 한계" });
    expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("서버가 보낸 한계 문구 그대로입니다.");
    expect(screen.getByText("모의 매매입니다.")).toBeTruthy();
    // 연 동안 뒤 화면은 보조 기술에서 가려지므로(aria-hidden) 여는 단추는 미리 잡아 둔 것으로 봅니다.
    expect(opener.getAttribute("aria-expanded")).toBe("true");
  });

  it("Esc로 닫히고 여는 단추로 포커스가 돌아온다", async () => {
    render(<WithTrigger />);
    trigger().focus();
    fireEvent.click(trigger());
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("바깥(덮개)을 누르면 onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="이 장부의 한계">
        내용
      </Drawer>,
    );
    // Radix는 바깥 누르기 듣기를 다음 차례(setTimeout 0)에 겁니다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 덮개(가림막)를 누름 — Radix는 왼쪽 단추의 바깥 누르기를 click까지 미뤄 판정합니다.
    const scrim = document.querySelector(".bg-scrim") as HTMLElement;
    fireEvent.pointerDown(scrim, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(scrim, { button: 0, pointerType: "mouse" });
    fireEvent.click(scrim, { button: 0 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("닫기 단추로 닫힌다", () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="이 장부의 한계">
        내용
      </Drawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("모양 — 오른쪽 끝 화면 높이, 좁은 화면 전체 폭·넓은 화면 md 28rem, 덮개 3층·data-overlay, 고대비에서도 남는 왼쪽 경계선", () => {
    render(<WithTrigger />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole("dialog");
    const box = (dialog.getAttribute("class") ?? "").split(/\s+/);
    expect(box).toEqual(
      expect.arrayContaining(["fixed", "inset-y-0", "right-0", "w-full", "sm:max-w-md", "bg-surface-2", "shadow-overlay", "border-l", "border-border-overlay"]),
    );
    expect(dialog.hasAttribute("data-overlay")).toBe(true);
  });

  it("width=\"lg\"면 넓은 화면 폭 42rem(sm:max-w-2xl)", () => {
    render(<WithTrigger width="lg" />);
    fireEvent.click(trigger());
    expect((screen.getByRole("dialog").getAttribute("class") ?? "").split(/\s+/)).toContain("sm:max-w-2xl");
  });
});
