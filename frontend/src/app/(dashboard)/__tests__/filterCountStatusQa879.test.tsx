/**
 * 화면 안 거르기의 결과 개수 알림 — QA-879(작업대 P7 검토에서 찾음).
 *
 * 알림함(알림 종류·읽음 상태)과 정보 수집 출처 상태(분류·상태)의 거르기를 바꾸면 목록·표와 개수 줄이 조용히 바뀌어, 낭독기 사용자는 몇 건이 남았는지 듣지
 * 못했습니다(개수 줄은 보통 글 — WCAG 4.1.3 상태 메시지). 공용 거르기 목록에는 이 일을 하는 `status`(눈에 보이지 않는 알림 영역)가 있고 교집합 화면이 씁니다.
 *
 * 기대: 거르기를 바꾸면 알림 영역(role=status)이 거른 뒤의 개수('고른 조건의 알림 n건'·'고른 조건의 출처 n곳')를 읽음 — 거르기가 둘이라 같은 글을 두 번 읽지
 * 않게 영역은 하나. 요청 수는 그대로.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 "expected [] to deeply equal [ '고른 조건의 알림 3건' ]", 둘째 사례 "expected [] to deeply equal [ '고른 조건의 출처 4곳' ]"
 * (알림 영역 없음).
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

import { StatusSection } from "@/components/screens/info/StatusSection";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { CatalogSource } from "@/lib/info";
import type { SessionUser } from "@/lib/types";
import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

function item(id: number, kind: string, read: boolean) {
  return { id, kind, occurredOn: "2026-11-18", title: `알림 ${id}`, body: "본문", late: false, createdAt: "2026-11-18T00:00:00Z", read };
}

function source(index: number, over: Partial<CatalogSource>): CatalogSource {
  return {
    task: `task_${index}`, key: `key_${index}`, label: `출처 ${index}`, tab: "global", kind: "data", siteUrl: null, origin: "합성 기관",
    access: "official", screen: null, speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-11 17:00 KST", lastDetail: null,
    politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "ok", ...over,
  };
}

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/alerts/inbox?limit=50": { items: [item(1, "REGIME_CHANGE", false), item(2, "FOREIGN_STREAK", true), item(3, "REGIME_CHANGE", true)], unread: 1 },
    "/api/alerts/rules": { available: true, limit: 20, rules: [] },
    "/api/sec13f/institutions": { institutions: [] },
    [endpoints.info.catalog]: {
      checkedAt: "2026-11-14 10:00 KST", collectorReachable: true, incidents: [],
      tabs: [{ key: "global", label: "해외", sources: 4, tones: { ok: 3, warn: 1, danger: 0, neutral: 0 } }],
      sources: [source(1, {}), source(2, {}), source(3, { tone: "warn" }), source(4, {})],
    },
  };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const statusTexts = (scope: HTMLElement) =>
  [...scope.querySelectorAll('[role="status"]')].map((element) => element.textContent ?? "").filter((text) => /^고른 조건의/.test(text));

describe("화면 안 거르기의 결과 개수 알림(QA-879)", () => {
  it.fails("알림함: 거르기를 바꾸면 알림 영역 하나가 거른 뒤의 개수를 읽는다 — 요청 수 그대로", async () => {
    render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
    await screen.findAllByText("알림 1");
    await act(async () => {});
    const before = api.apiGetShared.mock.calls.length;
    const inbox = screen.getByRole("radiogroup", { name: "알림 종류" }).closest("section") as HTMLElement;
    expect(statusTexts(inbox)).toEqual(["고른 조건의 알림 3건"]);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "알림 종류" })).getByRole("radio", { name: "국면 전환" }));
    expect(statusTexts(inbox)).toEqual(["고른 조건의 알림 2건"]);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "읽음 상태" })).getByRole("radio", { name: "읽지 않음" }));
    expect(statusTexts(inbox)).toEqual(["고른 조건의 알림 1건"]);
    expect(api.apiGetShared.mock.calls.length).toBe(before);
  });

  it.fails("정보 수집 출처 상태: 거르기를 바꾸면 알림 영역 하나가 거른 뒤의 출처 수를 읽는다", async () => {
    render(<StatusSection />);
    const tones = await screen.findByRole("radiogroup", { name: "상태" });
    const card = tones.closest("section") as HTMLElement;
    expect(statusTexts(card)).toEqual(["고른 조건의 출처 4곳"]);
    fireEvent.click(within(tones).getByRole("radio", { name: "주의" }));
    expect(statusTexts(card)).toEqual(["고른 조건의 출처 1곳"]);
  });
});
