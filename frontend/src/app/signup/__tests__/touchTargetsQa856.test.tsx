/**
 * 가입 화면의 동의 체크 — 좁은 화면(lg 미만) 누르는 자리 44px(원칙 A8, 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-7) — QA-856
 * (D1 결정 거리 `touch-targets-lt-lg-missed-by-qa458`의 /signup 몫).
 *
 * '개인정보 수집·이용 … 동의합니다' 체크 상자(16px)와 그것을 감싼 label(글 두 줄 높이)이 44px에 못 미쳤습니다. 인증 화면 감사(QA-465 —
 * app/login/__tests__/touchTargetsQa465.test.tsx)는 로그인·재설정만 그렸습니다. 같은 검사기(lib/__tests__/touchTargetAudit — 체크 상자는 감싼 label로
 * 따짐, 문장 안 링크 '개인정보 수집·이용'은 WCAG 2.5.8 글 안 예외)로 봅니다. 동의 상태·가입 단추가 켜지는 조건은 그대로입니다.
 * 수정 전(재현 커밋에서는 첫 사례 it.fails): ['input[checkbox]「」 — lg 미만 44px 높이 클래스(min-h-11 등) 없음'] 1건.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ auth: { signup: vi.fn() } }));
vi.mock("@/lib/api", () => api);

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import SignupPage from "../page";

afterEach(() => cleanup());

describe("가입 화면의 좁은 화면 누르는 자리(QA-856)", () => {
  it.fails("동의 체크(감싼 label)까지 모든 누름 자리가 lg 미만 44px", () => {
    const { container } = render(<SignupPage />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
  });

  it("동의 label을 누르면 체크되고, 이메일·비밀번호·동의가 모두 있어야 가입 단추가 켜진다(지금 조건 그대로)", () => {
    render(<SignupPage />);
    const submit = screen.getByRole("button", { name: "가입하고 확인 메일 받기" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    expect(submit.disabled).toBe(true);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(checkbox.closest("label") as HTMLLabelElement);
    expect(checkbox.checked).toBe(true);
    expect(submit.disabled).toBe(false);
  });
});
