/**
 * 데모 열람(ADR 0013) — 읽기 전용 방문자에게 쓰기 버튼을 막고 "데모에서는 조회만 가능합니다"를 보인다.
 * 백엔드도 GET 밖은 403이지만, 눌러 봐야 403만 받는 버튼은 처음부터 막습니다.
 * 예외는 AI 리포트 생성 하나 — 방문자 전체가 하루 한도를 함께 씁니다(ADR 0014).
 * 계정 사용자(레이아웃 밖 = 사용자 모름 포함)는 지금과 같습니다.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGetShared: vi.fn(),
    UnauthorizedError,
    auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);

// 매 렌더마다 새 함수를 주면 useApi가 다시 읽기를 반복합니다 — 같은 값을 돌려줍니다.
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

import AccountPage from "../account/page";
import AiReportPage from "../ai/report/page";
import AlertsPage from "../alerts/page";

const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

const READS: Record<string, unknown> = {
  "/api/ai/engines": {
    enabled: true,
    engines: [
      { id: "auto", label: "자동", provider: "auto", model: null, description: "", available: true, unavailableReason: null },
    ],
  },
  "/api/ai/report-types": { types: ["종합 매크로 브리핑"] },
  "/api/snapshot/text": { text: "원본", generatedAtKst: "2026-10-11 10:00 KST", chars: 2 },
  "/api/alerts/inbox?limit=50": { items: [], unread: 0 },
  "/api/alerts/rules": { available: true, limit: 20, rules: [] },
  "/api/sec13f/institutions": { institutions: [] },
};

function renderAs(user: SessionUser | undefined, page: React.ReactNode) {
  return render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);
}

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path in READS ? Promise.resolve(READS[path]) : new Promise(() => {}),
  );
  router.replace.mockReset();
});

afterEach(() => cleanup());

/** 데모 열람이 받는 엔진 목록 — AWS 데모(Haiku만 허용)처럼 공용 하루 한도의 오늘 사용량이 함께 옵니다. */
const DEMO_ENGINES = {
  enabled: true,
  engines: [
    { id: "auto", label: "자동", provider: "auto", model: null, description: "", available: false, unavailableReason: "not_allowed" },
    { id: "anthropic_haiku", label: "Claude Haiku 5.5", provider: "anthropic", model: "claude-haiku-5-5", description: "",
      available: true, unavailableReason: null },
  ],
  quota: { used: 0, limit: 20, shared: true },
};

function readsAsDemo() {
  api.apiGetShared.mockImplementation((path: string) =>
    path === "/api/ai/engines"
      ? Promise.resolve(DEMO_ENGINES)
      : path in READS ? Promise.resolve(READS[path]) : new Promise(() => {}),
  );
}

describe("데모 열람 — 쓰기 버튼", () => {
  it("AI 리포트: 데모도 생성 버튼을 쓰고(쓸 수 있는 첫 엔진), 방문자 전체가 함께 쓰는 하루 한도를 안내한다", async () => {
    readsAsDemo();
    api.apiPost.mockResolvedValue({
      status: true, response: "데모 리포트 본문", reportType: "종합 매크로 브리핑", provider: "Claude", latencyMs: 1000,
      quota: { used: 1, limit: 20, shared: true },
    });
    renderAs(DEMO, <AiReportPage />);

    const generate = (await screen.findByRole("button", { name: "리포트 생성" })) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    expect(screen.getByText("데모 방문자 전체가 하루 20건을 함께 씁니다(오늘 0건 사용).")).toBeTruthy();
    expect(screen.queryByText("데모에서는 조회만 가능합니다")).toBeNull();

    fireEvent.click(generate);
    expect(api.apiPost).toHaveBeenCalledWith("/api/ai/report", {
      engineId: "anthropic_haiku", reportType: "종합 매크로 브리핑", extraInstruction: "",
    });
    expect(await screen.findByText("데모 리포트 본문")).toBeTruthy();
    expect(screen.getByText("데모 방문자 전체가 하루 20건을 함께 씁니다(오늘 1건 사용).")).toBeTruthy();
    expect(screen.getByText(/데모 전체 오늘 1\/20건/)).toBeTruthy();
  });

  it("AI 리포트: 공용 한도를 다 쓰면 서버 문구를 그대로 보인다", async () => {
    readsAsDemo();
    api.apiPost.mockResolvedValue({
      status: false, error: "데모의 오늘 AI 리포트 한도(20건)를 모두 썼습니다. 내일(KST 0시) 다시 시도해 주세요.",
      quota: { used: 20, limit: 20, shared: true },
    });
    renderAs(DEMO, <AiReportPage />);

    const generate = (await screen.findByRole("button", { name: "리포트 생성" })) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    fireEvent.click(generate);

    expect(await screen.findByText(/데모의 오늘 AI 리포트 한도\(20건\)를 모두 썼습니다/)).toBeTruthy();
    expect(screen.getByText("데모 방문자 전체가 하루 20건을 함께 씁니다(오늘 20건 사용).")).toBeTruthy();
  });

  it("AI 리포트: 계정 회원은 지금처럼 생성 버튼을 쓴다", async () => {
    renderAs(MEMBER, <AiReportPage />);

    const generate = (await screen.findByRole("button", { name: "리포트 생성" })) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    expect(screen.queryByText("데모에서는 조회만 가능합니다")).toBeNull();
  });

  it("알림: 규칙 만들기가 막히고 안내를 보인다", async () => {
    renderAs(DEMO, <AlertsPage />);

    const create = (await screen.findByRole("button", { name: "규칙 만들기" })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText("데모에서는 조회만 가능합니다")).toBeTruthy();
    fireEvent.click(create);
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("알림: 계정 회원은 지금처럼 규칙을 만들 수 있다", async () => {
    renderAs(MEMBER, <AlertsPage />);

    const create = (await screen.findByRole("button", { name: "규칙 만들기" })) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(screen.queryByText("데모에서는 조회만 가능합니다")).toBeNull();
  });
});

describe("데모 열람 — 내 계정", () => {
  it("계정이 없으므로 첫 화면(/)으로 보내고 계정 API를 부르지 않는다", async () => {
    renderAs(DEMO, <AccountPage />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("비밀번호 변경")).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });
});
