/**
 * 버튼 동작 뒤의 화면 상태(QA-051) — 실패를 삼키지 않고, 늦은 응답으로 바꾼 값을 되돌리지 않고, 읽음 처리가 배지에 닿는다.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError,
    auth: { logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: () => {}, collecting: false, message: null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/alerts", useRouter: () => router }));

import { AccountBox } from "@/components/shell/AccountBox";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import AdminUsersPage from "../admin/users/page";
import AlertsPage from "../alerts/page";

let reads: Record<string, () => Promise<unknown>> = {};
beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
  api.apiPost.mockReset();
  api.auth.logout.mockReset();
  router.push.mockReset();
});
afterEach(() => cleanup());

describe("QA-051", () => {
  // 수정 전에는 run이 성공·실패를 돌려주지 않아, 비밀번호 변경이 실패해도 화면이 입력 세 칸을 지웠다.
  it("버튼 동작(run)은 실패하면 false를 돌려준다 — 실패한 비밀번호 변경이 입력을 지우지 않게", async () => {
    const { result } = renderHook(() => useAsyncAction(() => Promise.reject(new Error("지금 비밀번호가 올바르지 않습니다.")), "실패"));
    let ok: unknown;
    await act(async () => {
      ok = await result.current.run();
    });
    expect(ok).toBe(false);
  });

  // 수정 전에는 로그아웃 요청이 실패하면 처리되지 않은 rejection만 남고 화면에 아무 반응이 없었다.
  // (그 rejection이 테스트 러너 전체를 실패시켜, 수정 전에는 it.skip으로 두었습니다 — 백엔드의 @Disabled와 같음)
  it("로그아웃이 실패하면 화면에 알린다", async () => {
    api.auth.logout.mockRejectedValue(new Error("백엔드 API에 연결하지 못했습니다"));
    render(<AccountBox user={{ email: "m@test.local", role: "MEMBER", tier: "PRO", demo: false }} />);

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/로그아웃하지 못했습니다 — 백엔드 API에 연결하지 못했습니다/);
    expect(router.push).not.toHaveBeenCalled();
  });

  // 수정 전에는 알림함만 다시 읽고 사이드바(지금은 알림 벨)·탭 제목의 읽지 않은 수는 최대 5분 그대로였다.
  it("모두 읽음을 누르면 읽지 않은 수를 다시 읽으라는 신호를 보낸다", async () => {
    reads["/api/alerts/rules"] = () => Promise.resolve({ available: true, rules: [] });
    reads["/api/alerts/inbox"] = () => Promise.resolve({ available: true, unread: 2, items: [] });
    api.apiPost.mockResolvedValue({ changed: 2 });
    const heard = vi.fn();
    window.addEventListener("macrodash:alerts-read", heard);

    render(<AlertsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "모두 읽음" }));

    await waitFor(() => expect(heard).toHaveBeenCalled());
    window.removeEventListener("macrodash:alerts-read", heard);
  });

  // 수정 전에는 역할을 바꾼 응답·목록 갱신 전에 등급을 바꾸면, 옛 역할을 함께 보내 첫 변경을 되돌렸다.
  it("사용자 관리: 저장하고 목록을 다시 읽는 동안에는 그 행의 선택 상자를 막는다", async () => {
    reads["/api/admin/users"] = () => Promise.resolve({ users: [
      { id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" }] });
    api.apiPost.mockReturnValue(new Promise(() => {}));   // 저장이 끝나지 않음

    // 등급을 바꿉니다 — 운영자로 올리는 선택은 QA-338 뒤로 바로 저장하지 않고 비밀번호 창을 엽니다(아래 묶음).
    render(<AdminUsersPage />);
    const tier = (await screen.findByLabelText("m@test.local 등급")) as HTMLSelectElement;
    fireEvent.change(tier, { target: { value: "PRO" } });

    expect((screen.getByLabelText("m@test.local 역할") as HTMLSelectElement).disabled).toBe(true);
    expect(api.apiPost).toHaveBeenCalledWith("/api/admin/users/7", { role: "MEMBER", tier: "PRO" });
  });
});

describe("QA-338 사용자 관리 — 운영자로 올리기", () => {
  const member = { id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" };

  async function choosePromotion() {
    reads["/api/admin/users"] = () => Promise.resolve({ users: [member] });
    reads["/api/admin/audit"] = () => Promise.resolve({ entries: [] });
    render(<AdminUsersPage />);
    fireEvent.change(await screen.findByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
    return within(await screen.findByRole("dialog", { name: "운영자로 올리기" }));
  }

  // 수정 전에는 선택하자마자 {role: "OWNER"}를 보내 비밀번호 확인 없이 운영자가 됐다.
  it("회원을 운영자로 올리는 선택은 바로 보내지 않고 비밀번호 창을 열고, 요청자 비밀번호와 함께 보낸다", async () => {
    api.apiPost.mockResolvedValue({ ok: true, message: "바꿨습니다. 그 사용자의 다음 요청부터 반영됩니다." });
    const dialog = await choosePromotion();

    expect(api.apiPost).not.toHaveBeenCalled();
    const submit = dialog.getByRole("button", { name: "운영자로 올리기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);     // 비밀번호가 비면 보낼 수 없음

    fireEvent.change(dialog.getByLabelText("운영자 비밀번호"), { target: { value: "owner passphrase" } });
    fireEvent.click(submit);

    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/admin/users/7", { role: "OWNER", tier: "FREE", password: "owner passphrase" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("비밀번호가 틀리면 창을 둔 채 서버 글을 보이고 입력을 비운다 — 취소하면 아무것도 보내지 않는다", async () => {
    api.apiPost.mockRejectedValue(new Error("운영자 비밀번호가 올바르지 않습니다 — 역할을 바꾸지 않았습니다."));
    const dialog = await choosePromotion();
    fireEvent.change(dialog.getByLabelText("운영자 비밀번호"), { target: { value: "wrong guess" } });
    fireEvent.click(dialog.getByRole("button", { name: "운영자로 올리기" }));

    expect(await dialog.findByText("운영자 비밀번호가 올바르지 않습니다 — 역할을 바꾸지 않았습니다.")).toBeTruthy();
    expect((dialog.getByLabelText("운영자 비밀번호") as HTMLInputElement).value).toBe("");

    fireEvent.click(dialog.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.apiPost).toHaveBeenCalledTimes(1);
  });
});

describe("QA-105 사용자 관리 — 회원 만들기", () => {
  async function submitNewMember() {
    reads["/api/admin/users"] = () => Promise.resolve({ users: [] });
    reads["/api/admin/audit"] = () => Promise.resolve({ entries: [] });
    render(<AdminUsersPage />);
    fireEvent.change(await screen.findByLabelText("이메일"), { target: { value: "m@test.local" } });
    fireEvent.change(screen.getByLabelText("처음 비밀번호(10자 이상)"), { target: { value: "Abcdefgh1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "회원 만들기" }));
  }

  // 수정 전에는 결과와 상관없이 비밀번호 칸을 비워, 메일 중복·형식 오류·연결 실패를 고쳐 다시 보내려면 처음부터 다시 쳐야 했다.
  it("실패하면 처음 비밀번호 입력을 남긴다", async () => {
    api.apiPost.mockRejectedValue(new Error("이미 있는 메일 주소입니다."));
    await submitNewMember();

    expect(await screen.findByText("이미 있는 메일 주소입니다.")).toBeTruthy();
    expect((screen.getByLabelText("처음 비밀번호(10자 이상)") as HTMLInputElement).value).toBe("Abcdefgh1234!");
  });

  it("성공하면 처음 비밀번호 입력을 지운다", async () => {
    api.apiPost.mockResolvedValue({ ok: true, message: "회원을 만들었습니다." });
    await submitNewMember();

    expect(await screen.findByText("회원을 만들었습니다.")).toBeTruthy();
    expect((screen.getByLabelText("처음 비밀번호(10자 이상)") as HTMLInputElement).value).toBe("");
  });
});

describe("알림함의 서버 글 — 예전 알림의 그림 문자", () => {
  it("제목·본문·규칙 설명의 국기·나침반은 화면에서 뗀다(줄바꿈은 그대로)", async () => {
    reads["/api/alerts/rules"] = () => Promise.resolve({ available: true, limit: 5, rules: [
      { id: 1, kind: "INSTITUTION_NEW", params: { cik: "0001067983" }, enabled: true, description: "13F 신규 편입 — 🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", createdAt: "2026-10-01" },
    ] });
    reads["/api/alerts/inbox"] = () => Promise.resolve({ available: true, unread: 1, items: [
      { id: 7, kind: "REGIME_CHANGE", occurredOn: "2026-10-25", title: "[국면 전환] 후퇴 경계 → 확장 (🧭 시장 국면)",
        body: "판정이 3일 이어졌습니다.\n🇺🇸 버크셔 해서웨이가 편입", late: false, createdAt: "2026-10-25", read: false },
    ] });

    render(<AlertsPage />);

    expect(await screen.findByText("[국면 전환] 후퇴 경계 → 확장 (시장 국면)")).toBeTruthy();
    expect(screen.getByText((_, element) => element?.textContent === "판정이 3일 이어졌습니다.\n버크셔 해서웨이가 편입")).toBeTruthy();
    expect(await screen.findByText("13F 신규 편입 — 버크셔 해서웨이 (Berkshire Hathaway)")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}|\p{Regional_Indicator}/u);
  });

  it("규칙 만들기의 관심 기관 고르기도 국기를 뗀 이름 — 이름이 그림 문자뿐이면 CIK", async () => {
    reads["/api/alerts/rules"] = () => Promise.resolve({ available: true, limit: 5, rules: [] });
    reads["/api/alerts/inbox"] = () => Promise.resolve({ available: true, unread: 0, items: [] });
    reads["/api/sec13f/institutions"] = () => Promise.resolve({ institutions: [
      { cik: "0001608046", name: "🇰🇷 국민연금 (National Pension Service)" },
      { cik: "0001067983", name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)" },
      { cik: "0000000001", name: "🇯🇵" },
    ] });

    render(<AlertsPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("알림 종류"), { target: { value: "INSTITUTION_NEW" } });

    const options = within(screen.getByLabelText("관심 기관")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["기관을 고르세요", "국민연금 (National Pension Service)", "버크셔 해서웨이 (Berkshire Hathaway)", "CIK 0000000001"]);
    expect(options.join("")).not.toMatch(/\p{Extended_Pictographic}|\p{Regional_Indicator}/u);
  });
});
