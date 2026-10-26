/**
 * 로그인 화면 — 데모 열람(ADR 0013)이면 로그인 칸 대신 대시보드 첫 화면(/)으로 보낸다.
 * 로그인 없이 연 로컬 운영자(ADR 0016)도 같다. 그 밖에는 지금처럼 로그인 칸을 보인다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ auth: { session: vi.fn(), login: vi.fn() } }));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import LoginPage from "../page";

beforeEach(() => {
  api.auth.session.mockReset();
  api.auth.login.mockReset();
  router.replace.mockReset();
});

afterEach(() => cleanup());

describe("로그인 화면", () => {
  it("데모 열람 세션이면 첫 화면(/)으로 보내고 로그인 칸을 숨긴다", async () => {
    api.auth.session.mockResolvedValue({
      authenticated: true,
      mailAvailable: false,
      readMode: "store_only",
      user: { email: null, role: "MEMBER", tier: "PRO", demo: true },
    });

    render(<LoginPage />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    expect(screen.queryByRole("button", { name: "로그인" })).toBeNull();
  });

  it("로그인하지 않았으면(데모 열람 꺼짐) 지금처럼 로그인 칸을 보이고 이동하지 않는다", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: true });

    render(<LoginPage />);

    expect(await screen.findByRole("link", { name: "가입하기" })).toBeTruthy();
    expect(screen.getByLabelText("이메일")).toBeTruthy();
    expect(screen.getByRole("button", { name: "로그인" })).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("로그인 없는 로컬 실행에서 로컬 운영자로 풀린 세션이면 첫 화면(/)으로 보내고 로그인 칸을 숨긴다", async () => {
    api.auth.session.mockResolvedValue({
      authenticated: true,
      noLogin: true,
      mailAvailable: false,
      readMode: "auto",
      user: { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true },
    });

    render(<LoginPage />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    expect(screen.queryByRole("button", { name: "로그인" })).toBeNull();
  });

  it("로그인 모드에서 쿠키 세션으로 로그인돼 있어도(local 아님) 지금처럼 로그인 칸을 보이고 이동하지 않는다", async () => {
    api.auth.session.mockResolvedValue({
      authenticated: true,
      noLogin: false,
      mailAvailable: true,
      readMode: "auto",
      user: { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false },
    });

    render(<LoginPage />);

    expect(await screen.findByRole("link", { name: "가입하기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "로그인" })).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("로그인 없는 로컬 실행이라도 운영자로 풀리지 않았으면(localhost가 아닌 주소) 로그인 칸을 보인다", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, noLogin: true, mailAvailable: false });

    render(<LoginPage />);

    await act(async () => {});   // 세션 응답까지 처리한 뒤에 봅니다
    expect(api.auth.session).toHaveBeenCalled();
    expect(screen.getByLabelText("이메일")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // v2부터 첫 화면은 홈(/)입니다 — 예전에는 /가 /macro로 리디렉션돼, 로그인 뒤에도 /macro로 바로 보냈습니다.
  it("로그인에 성공하면 첫 화면인 홈(/)으로 보낸다", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: false });
    api.auth.login.mockResolvedValue(undefined);

    render(<LoginPage />);
    await act(async () => {});   // 세션 응답까지 처리한 뒤에 입력합니다
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "member@test.local" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(api.auth.login).toHaveBeenCalledWith("member@test.local", "pw");
    expect(router.replace).not.toHaveBeenCalledWith("/macro");
  });
});
