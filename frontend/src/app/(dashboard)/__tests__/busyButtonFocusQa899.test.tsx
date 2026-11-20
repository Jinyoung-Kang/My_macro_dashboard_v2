/**
 * 요청 동안 진짜 disabled가 되는 쓰기 단추 — QA-899(`busy-disabled-focus-body`, QA-268 무리 — D6 전 QA 확인의 결정 거리 2, 작업대 P8 키보드 경로).
 *
 * 공용 `Button`에 `disabled={…busy…}`로 요청 중을 알리던 단추(저장소 상태 '다시 실행'·'지금 교차 검증 실행', 알림 '규칙 만들기'·'모두 읽음', AI 리포트
 * '리포트 생성', 연결 테스트 '선택 모델 호출'·토스 조회, 내 계정 '비밀번호 바꾸기'·'계정 지우기'·'다른 기기 모두 로그아웃', 사용자 관리 '회원 만들기')는
 * 키보드로 누르면 그 순간 단추가 꺼져 크롬이 포커스를 body로 보냈습니다 — 응답 뒤 Tab은 문서 처음부터 다시 시작했습니다(D5와 같은 값).
 *
 * 기대: 요청 동안 누른 단추는 disabled가 아니라 aria-disabled(꺼진 단추와 같은 모양 — 포커스가 남음)이고, 다시 눌러도(폼은 Enter로 다시 보내도) 요청은
 * 늘지 않습니다(누름 가드). 켜짐 조건(빈 입력·데모·엔진 없음 등)의 disabled는 그대로입니다. 경로·메서드·본문·확인 문구는 그대로(moreWritesKeep).
 * jsdom은 disabled가 된 단추에서 포커스를 빼지 않으므로 요청 동안의 disabled 속성 자체를 봅니다(QA-887 시험과 같은 방법).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 모든 사례가 'expected true to be false'(요청 동안 disabled).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGetShared: vi.fn(),
    UnauthorizedError,
    auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn(), logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/status" }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineSeries: () => null,
  MultiLineSeries: () => null,
  HorizontalBars: () => null,
  SignedBars: () => null,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import AccountPage from "../account/page";
import AdminUsersPage from "../admin/users/page";
import AiReportPage from "../ai/report/page";
import AlertsPage from "../alerts/page";
import { AiEngineSection } from "../connections/AiEngineSection";
import { TossSection } from "../connections/TossSection";
import StatusPage from "../status/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const ENGINES = {
  enabled: true,
  engines: [{ id: "auto", label: "자동", provider: "auto", model: null, description: "", available: true, unavailableReason: null }],
  keys: {},
};

const STATUS = {
  readMode: "auto", collectorReachable: true,
  taskSummary: [{ task: "macro_collected", speed: "fast", status: "ok", startedAt: null, durationMs: null, detail: null }],
};

let reads: Record<string, unknown> = {};
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared, ...Object.values(api.auth)]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : never()));
  api.apiPost.mockImplementation(never);
  api.apiGet.mockImplementation(never);
  for (const fn of Object.values(api.auth)) fn.mockImplementation(never);
});
afterEach(() => cleanup());

async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}
const renderAs = (user: SessionUser, page: ReactElement) => render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);
const writes = () => api.apiPost.mock.calls.length + api.apiGet.mock.calls.length + Object.values(api.auth).reduce((sum, fn) => sum + fn.mock.calls.length, 0);

/**
 * 키보드로 누른 것처럼 포커스를 둔 채 누르고, 요청 동안: 진짜 disabled가 아니라 aria-disabled, 포커스가 그 단추에 남고, 다시 눌러도(그리고 폼이면 다시
 * 보내도) 요청이 늘지 않는지 봅니다.
 */
async function expectBusyKeepsFocus(control: HTMLElement) {
  const button = control as HTMLButtonElement;
  expect(button.disabled, "누르기 전 켜짐").toBe(false);
  button.focus();
  fireEvent.click(button);
  await act(async () => {});
  const sent = writes();
  expect(sent, "한 번 보냄").toBeGreaterThan(0);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  if (button.form) fireEvent.submit(button.form);
  await act(async () => {});
  expect(writes(), "요청 중 다시 눌러도 그대로").toBe(sent);
}

describe("요청 동안 누른 단추의 포커스(QA-899)", () => {
  it.fails("저장소 상태 '다시 실행'", async () => {
    reads = { [endpoints.status.overview]: STATUS };
    renderAs(OWNER, <StatusPage />);
    await expectBusyKeepsFocus(await screen.findByRole("button", { name: "다시 실행" }));
  });

  it.fails("저장소 상태 '지금 교차 검증 실행'", async () => {
    reads = { [endpoints.status.overview]: STATUS };
    renderAs(OWNER, <StatusPage />);
    await expectBusyKeepsFocus(await screen.findByRole("button", { name: "지금 교차 검증 실행" }));
  });

  it.fails("알림 '규칙 만들기'(폼 — 다시 보내도 한 번)", async () => {
    reads = {
      [endpoints.alerts.inbox(50)]: { available: true, unread: 0, items: [] },
      [endpoints.alerts.rules]: { available: true, limit: 5, rules: [] },
      [endpoints.institution.institutions]: { institutions: [] },
    };
    renderAs(MEMBER, <AlertsPage />);
    const create = await screen.findByRole("button", { name: "규칙 만들기" });
    await settled();
    await expectBusyKeepsFocus(create);
  });

  it.fails("알림 '모두 읽음'", async () => {
    reads = {
      [endpoints.alerts.inbox(50)]: {
        available: true, unread: 1,
        items: [{ id: 7, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title: "[국면 전환] 확장", body: "본문", late: false, createdAt: "2026-11-18", read: false }],
      },
      [endpoints.alerts.rules]: { available: true, limit: 5, rules: [] },
      [endpoints.institution.institutions]: { institutions: [] },
    };
    renderAs(MEMBER, <AlertsPage />);
    await screen.findAllByText("[국면 전환] 확장");
    await settled();
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "모두 읽음" }));
  });

  it.fails("AI 리포트 '리포트 생성'", async () => {
    reads = {
      [endpoints.ai.engines]: ENGINES,
      [endpoints.ai.reportTypes]: { types: ["종합 매크로 브리핑"] },
      [endpoints.snapshot.text]: { text: "원본", generatedAtKst: "2026-11-18 09:00 KST", chars: 2 },
    };
    renderAs(MEMBER, <AiReportPage />);
    await screen.findByRole("button", { name: "리포트 생성" });
    await settled();
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "리포트 생성" }));
  });

  it.fails("연결 테스트 '선택 모델 호출'", async () => {
    reads = { [endpoints.ai.engines]: ENGINES };
    renderAs(OWNER, <AiEngineSection />);
    await screen.findByRole("button", { name: "선택 모델 호출" });
    await settled();
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "선택 모델 호출" }));
  });

  it.fails("연결 테스트 토스 '환율 조회' — 옆 '지수 시세 조회'도 요청 동안 누름 무시", async () => {
    renderAs(OWNER, <TossSection />);
    await expectBusyKeepsFocus(await screen.findByRole("button", { name: "환율 조회 (USD → KRW)" }));
    const other = screen.getByRole("button", { name: "지수 시세 조회" });
    expect(other.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(other);
    expect(api.apiGet).toHaveBeenCalledTimes(1);
  });

  it.fails("내 계정 '비밀번호 바꾸기'(폼)·'계정 지우기'(폼)·'다른 기기 모두 로그아웃'", async () => {
    reads = {
      [endpoints.auth.session]: { authenticated: true, readMode: "auto", noLogin: false, user: MEMBER },
      [endpoints.auth.sessions]: { sessions: [] },
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAs(MEMBER, <AccountPage />);
    await screen.findByText("비밀번호 변경");
    await settled();

    fireEvent.change(screen.getByLabelText("지금 비밀번호"), { target: { value: "old pass word" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "new pass word 1" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "new pass word 1" } });
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "비밀번호 바꾸기" }));

    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "delete pass" } });
    await expectBusyKeepsFocus(screen.getByRole("button", { name: "계정 지우기" }));

    await expectBusyKeepsFocus(screen.getByRole("button", { name: "다른 기기 모두 로그아웃" }));
    expect(api.auth.changePassword).toHaveBeenCalledTimes(1);
    expect(api.auth.deleteAccount).toHaveBeenCalledTimes(1);
    expect(api.auth.logoutOthers).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it.fails("사용자 관리 '회원 만들기'(폼)", async () => {
    reads = {
      [endpoints.admin.users]: { users: [{ id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" }] },
      [endpoints.admin.audit(100)]: { entries: [] },
    };
    renderAs(OWNER, <AdminUsersPage />);
    const panel = (await screen.findByRole("heading", { name: "회원 만들기" })).closest("section") as HTMLElement;
    fireEvent.change(within(panel).getByLabelText("이메일"), { target: { value: "new@test.local" } });
    fireEvent.change(within(panel).getByLabelText("처음 비밀번호(10자 이상)"), { target: { value: "Abcdefgh1234!" } });
    await expectBusyKeepsFocus(within(panel).getByRole("button", { name: "회원 만들기" }));
  });
});
