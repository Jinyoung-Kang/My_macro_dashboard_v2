/**
 * 복사 단추 — 눌렀을 때 무슨 일이 일어났는지 알린다. 실패 글은 위험색 글만이 아니라 아이콘·'오류:' 머리말과 함께(상승 빨강과 색으로 갈리지
 * 않음 — 작업대 실행 명세 §3-1·§3-2-1).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "@/components/CopyButton";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

afterEach(() => cleanup());

describe("CopyButton", () => {
  it("복사할 내용이 없으면 오류 — 아이콘(장식) + sr-only '오류:' + 글, 위험색", async () => {
    render(<CopyButton text={null} label="원본 데이터 복사" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "원본 데이터 복사" }));
    });
    const message = screen.getByText("복사할 내용이 아직 없습니다.");
    const status = message.parentElement as HTMLElement;
    expect(status.className).toContain("text-danger");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("오류:").className).toContain("sr-only");
  });

  it("복사하면 '복사됨' 글로 바뀐다", async () => {
    render(<CopyButton text="본문" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(screen.getByRole("button", { name: "복사됨 ✓" })).toBeTruthy();
  });
});
