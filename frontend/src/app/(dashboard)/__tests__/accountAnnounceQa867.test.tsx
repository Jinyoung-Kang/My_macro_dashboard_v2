/**
 * 내 계정 — 오류·결과 글의 낭독과 입력칸 연결 — QA-867(작업대 P7 검토에서 찾음, 개편 전부터).
 *
 * 비밀번호 변경의 '새 비밀번호가 서로 다릅니다.'는 일반 글(<p>)이라 확인 입력칸과 이어지지 않았고(aria-invalid·aria-describedby 없음), 서버 오류(지금 비밀번호
 * 틀림 등)와 성공 결과·다른 기기 로그아웃 결과·계정 지우기 결과는 role·aria-live 없는 안내 상자라 낭독기에 알려지지 않았습니다. 계정 지우기가 성공하면
 * 폼째(포커스가 있던 '계정 지우기' 단추 포함) 결과 상자로 바뀌어 포커스가 <body>로 떨어졌습니다. QA-849는 아이콘과 낭독 머리말만 더했습니다.
 *
 * 기대(문구·요청·켜짐 조건·확인 창 그대로): 불일치면 확인 입력칸 aria-invalid="true" + aria-describedby → 불일치 글. 서버 오류는 role="alert" 안.
 * 성공 결과는 늘 있는 조용한 알림 영역(role="status")이 같은 글로 읽고, 계정 지우기 성공은 결과 상자로 포커스를 옮김.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 "expected null to be 'true'"(확인 입력칸 aria-invalid 없음), 둘째 사례 'expected null not to be null'
 * (오류 상자를 감싼 role=alert 없음), 셋째 사례 'Unable to find an accessible element with the role "status"'(알림 영역 없음), 넷째 사례
 * 'expected <body><div>…(1)</div></body> to be null'(계정 지우기 뒤 activeElement BODY, 포커스 받을 결과 상자 없음).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGetShared: vi.fn(), UnauthorizedError, auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn() } };
});
vi.mock("@/lib/api", () => api);
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/account" }));

import AccountPage from "../account/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/auth/session": { authenticated: true, readMode: "auto", noLogin: false, user: MEMBER },
    "/api/auth/sessions": { sessions: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  for (const fn of [api.auth.changePassword, api.auth.logoutOthers, api.auth.deleteAccount]) fn.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function rendered() {
  render(<SessionUserProvider user={MEMBER}><AccountPage /></SessionUserProvider>);
  await screen.findByLabelText("새 비밀번호");
}

async function submitPassword() {
  fireEvent.change(screen.getByLabelText("지금 비밀번호"), { target: { value: "current pass word" } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "next pass word 1" } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "next pass word 1" } });
  fireEvent.click(screen.getByRole("button", { name: "비밀번호 바꾸기" }));
  for (let round = 0; round < 4; round += 1) await act(async () => {});
}

describe("내 계정 — 오류·결과 글의 낭독과 입력칸 연결(QA-867)", () => {
  it("불일치: 확인 입력칸이 aria-invalid이고 불일치 글로 aria-describedby — 고치면 둘 다 풀림", async () => {
    await rendered();
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "first pass word" } });
    const confirm = screen.getByLabelText("새 비밀번호 확인");
    fireEvent.change(confirm, { target: { value: "second pass word" } });
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    const described = document.getElementById(confirm.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("오류: 새 비밀번호가 서로 다릅니다.");
    fireEvent.change(confirm, { target: { value: "first pass word" } });
    expect(confirm.getAttribute("aria-invalid")).toBeNull();
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
  });

  it("서버 오류(비밀번호 변경)는 role=alert 안 — 문구 그대로", async () => {
    api.auth.changePassword.mockRejectedValue(new Error("지금 비밀번호가 맞지 않습니다."));
    await rendered();
    await submitPassword();
    expect(api.auth.changePassword.mock.calls).toEqual([["current pass word", "next pass word 1"]]);
    const message = screen.getByText("지금 비밀번호가 맞지 않습니다.");
    expect(message.closest('[role="alert"]')).not.toBeNull();
  });

  it("성공 결과는 늘 있는 조용한 알림 영역(role=status)이 같은 글로 읽는다 — 비밀번호 변경·다른 기기 로그아웃", async () => {
    api.auth.changePassword.mockResolvedValue({ ok: true, message: "비밀번호를 바꿨습니다." });
    api.auth.logoutOthers.mockResolvedValue({ ok: true, revoked: 2 });
    await rendered();
    const passwordPanel = screen.getByRole("button", { name: "비밀번호 바꾸기" }).closest("section") as HTMLElement;
    const passwordStatus = within(passwordPanel).getByRole("status");
    expect(passwordStatus.textContent).toBe("");
    await submitPassword();
    expect(within(passwordPanel).getByRole("status").textContent).toBe("비밀번호를 바꿨습니다.");
    expect(within(passwordPanel).getByRole("status")).toBe(passwordStatus);

    const othersButton = screen.getByRole("button", { name: "다른 기기 모두 로그아웃" });
    const devicesPanel = othersButton.closest("section") as HTMLElement;
    fireEvent.click(othersButton);
    for (let round = 0; round < 4; round += 1) await act(async () => {});
    expect(within(devicesPanel).getByRole("status").textContent).toBe("다른 기기 2곳의 로그인을 끊었습니다.");
  });

  it("계정 지우기 성공: 폼이 결과 상자로 바뀌면 포커스가 결과 상자로 — 확인 창 문구 그대로", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    api.auth.deleteAccount.mockResolvedValue({ ok: true, message: "계정을 지웠습니다." });
    await rendered();
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "pass word" } });
    const submit = screen.getByRole("button", { name: "계정 지우기" });
    submit.focus();
    fireEvent.click(submit);
    expect(confirmSpy).toHaveBeenCalledWith("계정을 지울까요? 되돌릴 수 없습니다.");
    await waitFor(() => expect(screen.getByText("계정을 지웠습니다.")).toBeTruthy());
    for (let round = 0; round < 3; round += 1) await act(async () => {});
    expect(api.auth.deleteAccount.mock.calls).toEqual([["pass word"]]);
    const result = screen.getByText("계정을 지웠습니다.").closest("[tabindex]") as HTMLElement | null;
    expect(document.activeElement).toBe(result);
  });
});
