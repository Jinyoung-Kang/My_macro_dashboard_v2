/**
 * 인증 화면의 주 단추가 요청 동안 진짜 disabled — QA-909(`busy-disabled-focus-body`의 인증 몫 — QA-268 무리, 작업대 P8 키보드 경로. 대시보드 화면 몫은
 * QA-899, 운영자로 올리기 대화상자는 app/(dashboard)/__tests__/adminPromoteBusyQa909.test.tsx).
 *
 * 로그인 '로그인'·가입 '가입하고 확인 메일 받기'·재설정 '재설정 메일 받기'·'비밀번호 바꾸기'는 `disabled={busy || …}`라 키보드로 누르면 그 순간 단추가
 * 꺼져 크롬이 포커스를 body로 보냈습니다(실패 뒤 Tab이 문서 처음부터).
 * 기대: 요청 동안 누른 단추는 disabled가 아니라 aria-disabled(꺼진 단추와 같은 모양 — 포커스가 남음), 다시 눌러도·폼을 다시 보내도(입력칸 Enter) 요청은
 * 한 번. 켜짐 조건(빈 입력·불일치·동의 안 함)의 disabled와 요청 글자(로그인 '확인 중…'·그 밖 '처리 중…')는 그대로.
 * jsdom은 disabled가 된 단추에서 포커스를 빼지 않으므로 요청 동안의 disabled 속성 자체를 봅니다(QA-899 시험과 같은 방법).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 모든 사례가 'expected true to be false'(요청 동안 disabled).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  auth: { session: vi.fn(), login: vi.fn(), signup: vi.fn(), requestReset: vi.fn(), confirmReset: vi.fn() },
}));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import LoginPage from "@/app/login/page";
import ResetPage from "@/app/reset/page";
import SignupPage from "@/app/signup/page";

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  for (const fn of Object.values(api.auth)) {
    fn.mockReset();
    fn.mockImplementation(never);
  }
  api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: false });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

/** 포커스를 둔 채 누르고, 요청 동안 진짜 disabled가 아니라 aria-disabled·포커스가 남고·다시 눌러도(폼을 다시 보내도) 요청이 한 번인지 봅니다. */
async function expectBusyKeepsFocus(control: HTMLElement, request: { mock: { calls: unknown[] } }, busyText: string) {
  const button = control as HTMLButtonElement;
  expect(button.disabled, "누르기 전 켜짐").toBe(false);
  button.focus();
  fireEvent.click(button);
  await act(async () => {});
  expect(request.mock.calls).toHaveLength(1);
  expect(button.textContent).toBe(busyText);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  if (button.form) fireEvent.submit(button.form);
  await act(async () => {});
  expect(request.mock.calls, "요청 중 다시 눌러도 그대로").toHaveLength(1);
}

describe("인증 화면 주 단추 — 요청 동안 포커스(QA-909)", () => {
  it.fails("로그인 '로그인' — 요청 글자 '확인 중…', 요청 그대로", async () => {
    render(<LoginPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw" } });
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "로그인" }), api.auth.login, "확인 중…");
    expect(api.auth.login.mock.calls).toEqual([["member@test.local", "pw"]]);
  });

  it.fails("가입 '가입하고 확인 메일 받기' — 요청 글자 '처리 중…', 본문 그대로", async () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "가입하고 확인 메일 받기" }), api.auth.signup, "처리 중…");
    expect(api.auth.signup.mock.calls).toEqual([["member@test.local", "abcdefghij", true]]);
  });

  it.fails("재설정 요청 '재설정 메일 받기'", async () => {
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("이메일"), { target: { value: "member@test.local" } });
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "재설정 메일 받기" }), api.auth.requestReset, "처리 중…");
    expect(api.auth.requestReset.mock.calls).toEqual([["member@test.local"]]);
  });

  it.fails("재설정(링크) '비밀번호 바꾸기'", async () => {
    window.history.replaceState(null, "", "/reset?token=synthetic-token");
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "abcdefghij" } });
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "비밀번호 바꾸기" }), api.auth.confirmReset, "처리 중…");
    expect(api.auth.confirmReset.mock.calls).toEqual([["synthetic-token", "abcdefghij"]]);
  });

  it("켜짐 조건의 disabled는 그대로 — 빈 입력(로그인)·동의 안 함(가입)·불일치(재설정)", async () => {
    render(<LoginPage />);
    await act(async () => {});
    expect((screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    expect((screen.getByRole("button", { name: "가입하고 확인 메일 받기" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    window.history.replaceState(null, "", "/reset?token=synthetic-token");
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "abcdefghik" } });
    expect((screen.getByRole("button", { name: "비밀번호 바꾸기" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
