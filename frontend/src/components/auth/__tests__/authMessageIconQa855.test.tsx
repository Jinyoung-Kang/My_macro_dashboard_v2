/**
 * 인증 화면의 오류·성공 글에 아이콘이 없음 — QA-855(D1 결정 거리 `auth-error-message-no-icon`의 인증 화면 몫, 작업대 화면 언어 실행 명세
 * docs/specs/2026-11-15-v2-workbench-ui.md §0 W4 '상태·위험은 늘 아이콘 + 글').
 *
 * 인증 카드의 결과 상자(AuthMessage — 가입·재설정·메일 인증의 오류·성공), 로그인 화면의 오류 상자, 가입·재설정의 비밀번호 불일치 글이 색만 다른
 * 글이었습니다. 상태 글은 공용 상태 글(StatusText — 오류는 위험 톤 아이콘과 낭독기 머리말 '오류: ', 성공은 정상 톤 체크 아이콘)과 같은 꼴이어야 합니다.
 * 문구·요청(로그인·가입·재설정 확정)은 그대로이고, 글은 지금처럼 getByText로 찾힙니다(아이콘·머리말이 글 span에 섞이지 않음).
 * 수정 전(재현 커밋에서는 it.fails): 네 사례 모두 상자 안 아이콘이 없음('expected null not to be null' — 결과 상자 오류·로그인 오류·가입 불일치·재설정 불일치).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  auth: { session: vi.fn(), login: vi.fn(), signup: vi.fn(), requestReset: vi.fn(), confirmReset: vi.fn() },
}));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { AuthMessage } from "@/components/auth/AuthCard";
import LoginPage from "@/app/login/page";
import ResetPage from "@/app/reset/page";
import SignupPage from "@/app/signup/page";

beforeEach(() => {
  api.auth.session.mockReset();
  api.auth.login.mockReset();
  router.replace.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

/** 글을 담은 상태 상자(p)의 아이콘(장식 svg)과 낭독기 머리말. */
function statusParts(text: string) {
  const box = screen.getByText(text).closest("p");
  if (!box) throw new Error(`${text}: 글을 담은 p가 없습니다`);
  return {
    icon: box.querySelector('svg[aria-hidden="true"]'),
    prefix: box.querySelector(".sr-only")?.textContent ?? null,
  };
}

describe("인증 화면의 상태 글 — 아이콘 + 글(QA-855)", () => {
  it("결과 상자(AuthMessage) — 오류는 아이콘과 낭독기 머리말 '오류: ', 성공은 아이콘", () => {
    render(
      <>
        <AuthMessage tone="error">링크가 만료됐습니다.</AuthMessage>
        <AuthMessage tone="ok">메일을 보냈습니다.</AuthMessage>
      </>,
    );
    const error = statusParts("링크가 만료됐습니다.");
    expect(error.icon).not.toBeNull();
    expect(error.prefix).toBe("오류: ");
    expect(statusParts("메일을 보냈습니다.").icon).not.toBeNull();
  });

  it("로그인 오류 상자 — 아이콘과 낭독기 머리말(요청·문구 그대로)", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: false });
    api.auth.login.mockRejectedValue(new Error("이메일 또는 비밀번호가 맞지 않습니다."));
    render(<LoginPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => expect(screen.getByText("이메일 또는 비밀번호가 맞지 않습니다.")).toBeTruthy());
    expect(api.auth.login).toHaveBeenCalledWith("member@test.local", "pw");
    const parts = statusParts("이메일 또는 비밀번호가 맞지 않습니다.");
    expect(parts.icon).not.toBeNull();
    expect(parts.prefix).toBe("오류: ");
  });

  it("가입 — 비밀번호 불일치 글에 아이콘(가입 단추는 지금처럼 막힘)", () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "abcdefghik" } });
    expect(statusParts("비밀번호가 서로 다릅니다.").icon).not.toBeNull();
    expect((screen.getByRole("button", { name: "가입하고 확인 메일 받기" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("재설정(링크로 연 새 비밀번호) — 비밀번호 불일치 글에 아이콘", async () => {
    window.history.replaceState(null, "", "/reset?token=synthetic-token");
    render(<ResetPage />);
    fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: "abcdefghij" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "abcdefghik" } });
    expect(statusParts("비밀번호가 서로 다릅니다.").icon).not.toBeNull();
    expect((screen.getByRole("button", { name: "비밀번호 바꾸기" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
