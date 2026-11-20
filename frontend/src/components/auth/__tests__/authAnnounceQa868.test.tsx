/**
 * 인증 다섯 화면의 오류·결과 글 낭독과 입력칸 연결 — QA-868(작업대 P8, 내 계정 몫은 QA-867).
 *
 * 로그인·가입·재설정(요청·새 비밀번호)·메일 인증의 결과 상자(AuthMessage)와 불일치 글(AuthFieldError)에 role·aria-live가 없어 낭독되지 않았고, 불일치
 * 입력칸이 불일치 글과 이어지지 않았으며, 가입·재설정 성공 뒤 폼이 사라져 포커스가 body로, 메일 인증 결과는 조용히 바뀌었습니다.
 *
 * 기대(보이는 글·요청 경로·본문·리디렉트 그대로):
 * - 오류 상자는 처음부터 늘 DOM에 있는 role="alert" 영역 안에 그립니다(붙자마자 글이 든 영역은 낭독기가 놓침 — 영역을 먼저 두고 글만 바꿈).
 * - 불일치면 확인 입력칸이 aria-invalid="true"이고 불일치 글로 aria-describedby — 맞추면 둘 다 풀림.
 * - 서버 오류면 폼의 글 입력칸이 오류 글로 aria-describedby(로그인이 받지 않은 401이면 두 칸 모두 aria-invalid도 — 화면이 아는 입력 탓).
 * - 가입·재설정 성공·메일 인증 결과는 결과 글(tabIndex -1)로 포커스.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 로그인·가입 오류·재설정 요청 오류는 'Unable to find an accessible element with the role "alert"'
 * (오류 전 영역 없음), 불일치 둘은 "expected null to be 'true'"(확인 입력칸 aria-invalid 없음), 성공·인증 결과 넷은
 * 'expected <body>…</body> to be <p …>…</p>'(포커스 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  auth: { session: vi.fn(), login: vi.fn(), signup: vi.fn(), requestReset: vi.fn(), confirmReset: vi.fn(), verify: vi.fn() },
}));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import LoginPage from "@/app/login/page";
import ResetPage from "@/app/reset/page";
import SignupPage from "@/app/signup/page";
import VerifyPage from "@/app/verify/page";

beforeEach(() => {
  for (const fn of Object.values(api.auth)) fn.mockReset();
  router.replace.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

/** 글을 담은 결과 상자(p). */
function box(text: string): HTMLElement {
  const found = screen.getByText(text).closest("p");
  if (!found) throw new Error(`${text}: 글을 담은 p가 없습니다`);
  return found;
}

/** 입력칸이 가리키는 설명 요소들의 글. */
function described(input: HTMLElement): string {
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `(없는 id ${id})`).join(" | ");
}

/** 포커스를 둔 채 누릅니다(키보드로 누른 것처럼). */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

describe("인증 화면 — 오류·결과 글의 낭독과 입력칸 연결(QA-868)", () => {
  it("로그인 실패(401): 처음부터 있던 role=alert 영역 안에 오류 글, 두 입력칸이 aria-invalid이고 오류 글로 설명됨 — 요청 그대로", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: false });
    api.auth.login.mockRejectedValue(Object.assign(new Error("이메일 또는 비밀번호가 올바르지 않습니다."), { status: 401 }));
    render(<LoginPage />);
    await act(async () => {});
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    const email = screen.getByLabelText("이메일");
    const password = screen.getByLabelText("비밀번호");
    expect(email.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(email, { target: { value: "member@test.local" } });
    fireEvent.change(password, { target: { value: "pw" } });
    press(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => expect(region.textContent).toContain("이메일 또는 비밀번호가 올바르지 않습니다."));
    expect(api.auth.login).toHaveBeenCalledWith("member@test.local", "pw");
    expect(router.replace).not.toHaveBeenCalled();
    for (const input of [email, password]) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(described(input)).toContain("이메일 또는 비밀번호가 올바르지 않습니다.");
    }
  });

  it("로그인 연결 실패(상태 없음): 오류 글로 설명되지만 aria-invalid는 아님(입력 탓이 아님)", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: false });
    api.auth.login.mockRejectedValue(new Error("백엔드 API에 연결하지 못했습니다"));
    render(<LoginPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw" } });
    press(screen.getByRole("button", { name: "로그인" }));
    await screen.findByText("백엔드 API에 연결하지 못했습니다");
    expect(screen.getByLabelText("비밀번호").getAttribute("aria-invalid")).toBeNull();
  });

  it("가입 불일치: 확인 입력칸이 aria-invalid이고 불일치 글로 설명됨 — 맞추면 둘 다 풀림", () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    const confirm = screen.getByLabelText("비밀번호 확인");
    fireEvent.change(confirm, { target: { value: "abcdefghik" } });
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(described(confirm)).toBe("오류: 비밀번호가 서로 다릅니다.");
    expect(screen.getByLabelText("비밀번호").getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(confirm, { target: { value: "abcdefghij" } });
    expect(confirm.getAttribute("aria-invalid")).toBeNull();
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
  });

  it("가입 서버 오류: 처음부터 있던 role=alert 안, 입력칸이 오류 글로 설명됨 — 본문 그대로", async () => {
    api.auth.signup.mockRejectedValue(new Error("가입하지 못했습니다 — 잠시 뒤 다시 시도하세요."));
    render(<SignupPage />);
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.click(screen.getByRole("checkbox"));
    press(screen.getByRole("button", { name: "가입하고 확인 메일 받기" }));

    await waitFor(() => expect(region.textContent).toContain("가입하지 못했습니다 — 잠시 뒤 다시 시도하세요."));
    expect(api.auth.signup).toHaveBeenCalledWith("member@test.local", "abcdefghij", true);
    expect(described(screen.getByLabelText("이메일"))).toContain("가입하지 못했습니다");
  });

  it("가입 성공: 폼이 결과 글로 바뀌면 포커스가 결과 글로", async () => {
    api.auth.signup.mockResolvedValue({ ok: true, message: "확인 메일을 보냈습니다." });
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.click(screen.getByRole("checkbox"));
    press(screen.getByRole("button", { name: "가입하고 확인 메일 받기" }));

    await screen.findByText("확인 메일을 보냈습니다.");
    await waitFor(() => expect(document.activeElement).toBe(box("확인 메일을 보냈습니다.")));
  });

  it("재설정(링크) 불일치: 확인 입력칸이 aria-invalid이고 불일치 글로 설명됨", async () => {
    window.history.replaceState(null, "", "/reset?token=synthetic-token");
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "abcdefghij" } });
    const confirm = screen.getByLabelText("새 비밀번호 확인");
    fireEvent.change(confirm, { target: { value: "abcdefghik" } });
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(described(confirm)).toBe("오류: 비밀번호가 서로 다릅니다.");
  });

  it("재설정(링크) 성공: 폼이 사라지면 포커스가 결과 글로 — 본문 그대로", async () => {
    window.history.replaceState(null, "", "/reset?token=synthetic-token");
    api.auth.confirmReset.mockResolvedValue({ ok: true, message: "비밀번호를 바꿨습니다." });
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "abcdefghij" } });
    press(screen.getByRole("button", { name: "비밀번호 바꾸기" }));

    await screen.findByText("비밀번호를 바꿨습니다.");
    expect(api.auth.confirmReset).toHaveBeenCalledWith("synthetic-token", "abcdefghij");
    await waitFor(() => expect(document.activeElement).toBe(box("비밀번호를 바꿨습니다.")));
  });

  it("재설정 요청 오류: 처음부터 있던 role=alert 안, 이메일 입력칸이 오류 글로 설명됨 — 성공하면 결과 글로 포커스", async () => {
    api.auth.requestReset.mockRejectedValueOnce(new Error("처리하지 못했습니다."));
    api.auth.requestReset.mockResolvedValueOnce({ ok: true, message: "메일을 보냈습니다." });
    render(<ResetPage />);
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    const email = await screen.findByLabelText("이메일");
    fireEvent.change(email, { target: { value: "member@test.local" } });
    press(screen.getByRole("button", { name: "재설정 메일 받기" }));

    await waitFor(() => expect(region.textContent).toContain("처리하지 못했습니다."));
    expect(described(email)).toContain("처리하지 못했습니다.");

    press(screen.getByRole("button", { name: "재설정 메일 받기" }));
    await screen.findByText("메일을 보냈습니다.");
    expect(api.auth.requestReset.mock.calls).toEqual([["member@test.local"], ["member@test.local"]]);
    await waitFor(() => expect(document.activeElement).toBe(box("메일을 보냈습니다.")));
  });

  it("메일 인증 결과(성공·실패): 결과 글로 포커스 — 토큰을 한 번 넘김", async () => {
    window.history.replaceState(null, "", "/verify?token=synthetic-token");
    api.auth.verify.mockResolvedValue({ ok: true, message: "메일 주소를 확인했습니다." });
    render(<VerifyPage />);
    await screen.findByText("메일 주소를 확인했습니다.");
    expect(api.auth.verify.mock.calls).toEqual([["synthetic-token"]]);
    await waitFor(() => expect(document.activeElement).toBe(box("메일 주소를 확인했습니다.")));
    cleanup();

    api.auth.verify.mockRejectedValue(new Error("링크가 올바르지 않습니다."));
    render(<VerifyPage />);
    await screen.findByText("링크가 올바르지 않습니다.");
    await waitFor(() => expect(document.activeElement).toBe(box("링크가 올바르지 않습니다.")));
  });
});
