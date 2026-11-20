/**
 * 알림함의 시각순 목록 + 거르기 + 검사 칸(작업대 P7 — 실행 명세 §7 7행 '알림: 타임라인과 필터 태그').
 *
 * - 줄: 발생일(<time>) · 종류 태그(중립) · 제목 + 읽지 않은 새 알림이면 굵은 제목과 '새 알림' 태그, 지난 사건이면 '지난 사건' 태그 — '●' 점 없음
 *   (D1 alerts-unread-dot-alone), 옛 15px 제목 없음.
 * - 거르기 둘(알림 종류 — 받은 종류만, 읽음 상태): 화면 안에서 거름 — 요청 수 그대로, 하나 고름 라디오(aria-checked).
 * - 넓은 화면: 왼쪽 목록 + 넓은 검사 칸, 첫 알림이 저절로 보임(요청 없음). 검사 칸: 발생일·받은 시각·상태·지난 사건, 본문, '읽음'(같은 POST {ids}).
 * - 읽은 알림·데모 열람에는 '읽음'이 없습니다.
 * - 알림 규칙(같은 커밋 묶음의 둘째): 공용 조밀 표·개수 줄, 표 안 켜기·끄기·지우기는 작은 단추(넓은 화면 24px), 규칙 만들기 폼 이름표는 공용 고르기 상자와 같은
 *   13px text-2이고 입력칸 폭 상한도 같음(22rem — form-label-styles-mixed).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const refresh = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => refresh }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/alerts" }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

function item(over: Record<string, unknown>) {
  return { id: 1, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title: "제목", body: "본문", late: false, createdAt: "2026-11-18T00:00:00Z", read: false, ...over };
}

const ITEMS = [
  item({ id: 1, kind: "REGIME_CHANGE", title: "국면 바뀜", body: "판정이 3일 이어졌습니다." }),
  item({ id: 2, kind: "FOREIGN_STREAK", title: "외국인 5일 연속", read: true }),
  item({ id: 3, kind: "REGIME_CHANGE", title: "지난 국면", late: true, occurredOn: "2026-11-10" }),
];

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/alerts/inbox?limit=50": { items: ITEMS, unread: 1 },
    "/api/alerts/rules": { available: true, limit: 20, rules: [] },
    "/api/sec13f/institutions": { institutions: [] },
  };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderAs = (user: SessionUser) => render(<SessionUserProvider user={user}><AlertsPage /></SessionUserProvider>);
const calls = () => api.apiGetShared.mock.calls.length;

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

/** 목록 줄(단추)의 글 — 시각·종류·요약. */
function rowTexts(): string[] {
  const list = screen.getByRole("list", { name: "알림함" });
  return within(list).getAllByRole("button").map((button) => button.textContent ?? "");
}

describe("알림함 — 시각순 목록", () => {
  it("줄은 발생일·종류 태그·제목, 새 알림은 굵은 제목 + '새 알림' 태그, 지난 사건은 '지난 사건' 태그 — '●' 점 없음", async () => {
    renderAs(MEMBER);
    await screen.findByText("국면 바뀜");
    expect(rowTexts()).toEqual([
      "2026-11-18국면 전환국면 바뀜새 알림",
      "2026-11-18연속 순매수외국인 5일 연속",
      "2026-11-10국면 전환지난 국면지난 사건",
    ]);
    expect(screen.getByText("국면 바뀜").className).toContain("font-semibold");
    expect(screen.getByText("외국인 5일 연속").className).not.toContain("font-semibold");
    expect(document.body.textContent).not.toContain("●");
    expect(screen.getByRole("list", { name: "알림함" }).querySelector("time")?.getAttribute("datetime")).toBe("2026-11-18");
  });

  it("거르기 둘(받은 종류만·읽음 상태)은 화면 안에서 거르고 요청 수는 그대로", async () => {
    renderAs(MEMBER);
    await screen.findByText("국면 바뀜");
    await act(async () => {});
    const before = calls();
    const kinds = screen.getByRole("radiogroup", { name: "알림 종류" });
    expect(within(kinds).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["전체", "국면 전환", "연속 순매수"]);
    expect(within(kinds).getByRole("radio", { name: "전체" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(kinds).getByRole("radio", { name: "국면 전환" }));
    expect(rowTexts()).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "읽지 않음" }));
    expect(rowTexts().map((text) => text.includes("국면 바뀜") || text.includes("지난 국면"))).toEqual([true, true]);
    fireEvent.click(within(kinds).getByRole("radio", { name: "연속 순매수" }));
    expect(screen.getByText("고른 조건에 맞는 알림이 없습니다.")).toBeTruthy();
    expect(calls()).toBe(before);
  });
});

describe("알림함 — 검사 칸", () => {
  it("넓은 화면: 첫 알림이 저절로 옆 칸에 — 속성·본문·'읽음'(같은 POST), 요청 없음", async () => {
    stubWide();
    api.apiPost.mockResolvedValue({ changed: 1 });
    renderAs(MEMBER);
    await screen.findAllByText("국면 바뀜");
    await act(async () => {});
    const before = calls();
    const panel = screen.getByRole("region", { name: /국면 바뀜/ });
    expect(within(panel).getByText("발생일", { selector: "dt" })).toBeTruthy();
    expect(within(panel).getByText("읽지 않음")).toBeTruthy();
    expect(within(panel).getByText("판정이 3일 이어졌습니다.").className).toContain("text-running");
    expect(calls()).toBe(before);

    fireEvent.click(within(panel).getByRole("button", { name: "읽음" }));
    await act(async () => {});
    expect(api.apiPost.mock.calls).toEqual([["/api/alerts/inbox/read", { ids: [1] }]]);
  });

  it("읽은 알림·데모 열람에는 '읽음'이 없다", async () => {
    renderAs(MEMBER);
    fireEvent.click(await screen.findByText("외국인 5일 연속"));
    const read = await screen.findByRole("dialog", { name: "외국인 5일 연속" });
    expect(within(read).queryByRole("button", { name: "읽음" })).toBeNull();
    expect(within(read).getByText("읽음", { selector: "dd *" })).toBeTruthy();
    cleanup();

    renderAs(DEMO);
    fireEvent.click(await screen.findByText("국면 바뀜"));
    const demo = await screen.findByRole("dialog", { name: "국면 바뀜" });
    expect(within(demo).queryByRole("button", { name: "읽음" })).toBeNull();
  });
});

describe("알림 규칙 — 표와 폼", () => {
  it("규칙 표는 조밀 표·개수 줄, 표 안 단추는 작은 단추 — 폼 이름표·폭은 공용 고르기 상자와 같음", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path === "/api/alerts/rules") {
        return Promise.resolve({ available: true, limit: 5, rules: [
          { id: 3, kind: "REGIME_CHANGE", params: {}, enabled: true, description: "국면 전환", createdAt: "2026-11-01T00:00:00Z" },
        ] });
      }
      if (path === "/api/alerts/inbox?limit=50") return Promise.resolve({ items: [], unread: 0 });
      return new Promise(() => {});
    });
    renderAs(MEMBER);
    const table = await screen.findByRole("region", { name: "알림 규칙 (좌우 스크롤)" });
    expect(within(table.closest("section") as HTMLElement).getByText("1건")).toBeTruthy();
    for (const name of ["켜짐 — 끄기", "지우기"]) {
      expect(within(table).getByRole("button", { name }).className, name).toContain("lg:min-h-6");
    }
    fireEvent.change(screen.getByLabelText("알림 종류"), { target: { value: "FOREIGN_STREAK" } });
    fireEvent.change(screen.getByLabelText("대상"), { target: { value: "STOCK" } });
    const code = screen.getByLabelText("종목코드(6자리)");
    const codeLabel = code.closest("label") as HTMLElement;
    const selectLabel = screen.getByLabelText("연속 일수").closest("label") as HTMLElement;
    for (const cls of ["text-[13px]", "text-text-2"]) {
      expect(codeLabel.className, cls).toContain(cls);
      expect(selectLabel.className, cls).toContain(cls);
    }
    expect(code.className).toContain("sm:max-w-[22rem]");
    expect((screen.getByLabelText("연속 일수").parentElement as HTMLElement).className).toContain("sm:max-w-[22rem]");
  });
});
