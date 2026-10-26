/**
 * 확인 창(ConfirmDialog).
 *
 *  - 확인은 onConfirm만 부르고 스스로 닫지 않는다(부르는 쪽이 결과가 나온 뒤 닫음)
 *  - Esc·취소는 onOpenChange(false)
 *  - busy면 확인·취소가 비활성이고 Esc로도 닫히지 않는다
 *  - requireText는 정확히 같은 글자에서만 확인을 연다(대소문자·공백까지), 다시 열면 친 글자는 비워진다
 *  - tone="danger"는 danger 토큰 바탕
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "../ConfirmDialog";

afterEach(() => cleanup());

type Props = ComponentProps<typeof ConfirmDialog>;

function renderConfirm(overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    title: "계좌 초기화",
    description: "보유·체결 기록을 지우고 출발 금액으로 되돌립니다.",
    confirmLabel: "초기화",
    onConfirm: vi.fn(),
    ...overrides,
  };
  const view = render(<ConfirmDialog {...props} />);
  return { props, view, rerender: (next: Partial<Props>) => view.rerender(<ConfirmDialog {...props} {...next} />) };
}

const confirmButton = () => screen.getByRole("button", { name: "초기화" }) as HTMLButtonElement;
const cancelButton = () => screen.getByRole("button", { name: "취소" }) as HTMLButtonElement;

describe("열림과 닫힘", () => {
  it("open={false}면 DOM에 없다", () => {
    renderConfirm({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("열리면 제목·설명·취소·확인 — 닫기(✕) 단추는 따로 두지 않는다", () => {
    renderConfirm();
    const dialog = screen.getByRole("dialog", { name: "계좌 초기화" });
    expect(document.getElementById(dialog.getAttribute("aria-describedby") as string)?.textContent).toBe(
      "보유·체결 기록을 지우고 출발 금액으로 되돌립니다.",
    );
    expect(cancelButton()).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
  });

  it("첫 포커스는 취소 단추(입력칸이 없을 때)", async () => {
    renderConfirm();
    await waitFor(() => expect(document.activeElement).toBe(cancelButton()));
  });

  it("cancelLabel로 취소 문구를 바꾼다", () => {
    renderConfirm({ cancelLabel: "그만두기" });
    expect(screen.getByRole("button", { name: "그만두기" })).toBeTruthy();
  });
});

describe("확인·취소·Esc", () => {
  it("확인은 onConfirm만 부르고 창을 닫지 않는다", () => {
    const { props } = renderConfirm();
    fireEvent.click(confirmButton());
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("취소와 Esc는 onOpenChange(false)", () => {
    const { props } = renderConfirm();
    fireEvent.click(cancelButton());
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);

    vi.mocked(props.onOpenChange).mockClear();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});

describe("처리 중(busy)", () => {
  it("확인·취소가 비활성이고 Esc로도 닫히지 않는다", () => {
    const { props } = renderConfirm({ busy: true });
    expect(confirmButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.submit(confirmButton().closest("form") as HTMLFormElement);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("busy가 풀리면 다시 누를 수 있다(실패 뒤 다시 시도)", () => {
    const { rerender } = renderConfirm({ busy: true });
    rerender({ busy: false });
    expect(confirmButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(false);
  });
});

describe("requireText", () => {
  it("정확히 같은 글자를 쳐야 확인이 열린다 — 대소문자·앞뒤 공백이 다르면 닫힘", () => {
    const { props } = renderConfirm({ tone: "danger", requireText: "RESET" });
    const input = screen.getByRole("textbox", { name: /확인하려면 다음 글자를 그대로 입력하세요: RESET/ });
    expect(confirmButton().disabled).toBe(true);

    for (const wrong of ["reset", "RESET ", " RESET", "RESE"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(confirmButton().disabled).toBe(true);
    }
    // 틀린 글자에서 Enter(제출)를 눌러도 부르지 않는다
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(props.onConfirm).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "RESET" } });
    expect(confirmButton().disabled).toBe(false);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("첫 포커스는 입력칸", async () => {
    renderConfirm({ requireText: "RESET" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")));
  });

  it("글자가 맞아도 busy면 비활성", () => {
    const { rerender } = renderConfirm({ requireText: "RESET" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "RESET" } });
    rerender({ busy: true });
    expect(confirmButton().disabled).toBe(true);
  });

  it("닫았다 다시 열면 친 글자가 비워진다", () => {
    const { rerender } = renderConfirm({ requireText: "RESET" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "RESET" } });
    expect(confirmButton().disabled).toBe(false);

    rerender({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender({ open: true });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(confirmButton().disabled).toBe(true);
  });

  it("빈 문자열이면 묻지 않는다", () => {
    renderConfirm({ requireText: "" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });
});

describe("tone", () => {
  it("danger는 danger 토큰, 기본은 accent(잉크) 바탕", () => {
    const { rerender } = renderConfirm({ tone: "danger" });
    expect(confirmButton().className).toContain("bg-danger");
    rerender({ tone: "default" });
    expect(confirmButton().className).toContain("bg-accent");
    expect(confirmButton().className).not.toContain("bg-danger");
  });
});
