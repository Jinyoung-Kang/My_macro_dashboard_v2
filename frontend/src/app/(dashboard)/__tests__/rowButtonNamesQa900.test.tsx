/**
 * 행마다 같은 이름의 쓰기 단추 — QA-900(P7 검토 '행마다 같은 이름의 쓰기 단추'(낮음, 개편 전부터) — 작업대 P8).
 *
 * 저장소 상태 태스크 표의 '다시 실행'과 알림 규칙 표의 '켜짐 — 끄기'(꺼짐 — 켜기)·'지우기'는 줄마다 이름이 같아, 낭독기의 단추 목록이나 Tab 이동에서
 * 어느 줄의 단추인지 알 수 없었습니다(태스크 표는 행 머리도 없음).
 *
 * 기대: 보이는 글·낭독 이름은 그대로 두고(쓰기 시험들이 이름으로 찾음), 낭독 설명(aria-describedby)으로 그 줄의 이름(태스크 이름·규칙 설명)을 붙입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 두 사례 모두 'expected [ '', '' ] to deeply equal [ 'macro_collected', 'cot_history' ]' 꼴(설명 없음).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/status" }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import AlertsPage from "../alerts/page";
import StatusPage from "../status/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

let reads: Record<string, unknown> = {};
beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

/** 낭독 설명 — aria-describedby가 가리키는 요소들의 글(숨은 요소도 셈 — 접근성 설명 계산과 같음). */
function description(element: HTMLElement): string {
  const ids = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
}

describe("행마다 같은 이름의 쓰기 단추에 줄 이름(QA-900)", () => {
  it("저장소 상태 태스크 표 '다시 실행' — 이름은 그대로, 설명은 태스크 이름", async () => {
    reads = {
      [endpoints.status.overview]: {
        readMode: "auto", collectorReachable: true,
        taskSummary: [
          { task: "macro_collected", speed: "fast", status: "ok", startedAt: null, durationMs: null, detail: null },
          { task: "cot_history", speed: "slow", status: "ok", startedAt: null, durationMs: null, detail: null },
        ],
      },
    };
    render(<SessionUserProvider user={OWNER}><StatusPage /></SessionUserProvider>);
    const buttons = await screen.findAllByRole("button", { name: "다시 실행" });
    expect(buttons).toHaveLength(2);
    expect(buttons.map(description)).toEqual(["macro_collected", "cot_history"]);
    expect(buttons.map((button) => button.textContent)).toEqual(["다시 실행", "다시 실행"]);
  });

  it("알림 규칙 표 '켜짐 — 끄기'·'꺼짐 — 켜기'·'지우기' — 이름은 그대로, 설명은 규칙 설명", async () => {
    reads = {
      [endpoints.alerts.inbox(50)]: { available: true, unread: 0, items: [] },
      [endpoints.alerts.rules]: {
        available: true, limit: 5,
        rules: [
          { id: 3, kind: "REGIME_CHANGE", params: {}, enabled: true, description: "국면 전환", createdAt: "2026-11-01" },
          { id: 4, kind: "REGIME_CHANGE", params: {}, enabled: false, description: "외국인 5일 연속 순매수 — 코스피", createdAt: "2026-11-02" },
        ],
      },
      [endpoints.institution.institutions]: { institutions: [] },
    };
    render(<SessionUserProvider user={OWNER}><AlertsPage /></SessionUserProvider>);
    const table = await screen.findByRole("region", { name: "알림 규칙 (좌우 스크롤)" });
    await settled();
    const removes = within(table).getAllByRole("button", { name: "지우기" });
    expect(removes.map(description)).toEqual(["국면 전환", "외국인 5일 연속 순매수 — 코스피"]);
    expect(description(within(table).getByRole("button", { name: "켜짐 — 끄기" }))).toBe("국면 전환");
    expect(description(within(table).getByRole("button", { name: "꺼짐 — 켜기" }))).toBe("외국인 5일 연속 순매수 — 코스피");
  });
});
