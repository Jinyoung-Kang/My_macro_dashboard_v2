/**
 * 알림 규칙 표의 두 번 누름 — QA-898(D6 전 QA 스택 확인의 결정 거리 `alerts-rule-double-write` — 2026-11-20 결정(사용자 위임, 권장안): 고침, 개편 전부터).
 *
 * 규칙 표의 '켜짐 — 끄기'·'지우기'는 `disabled={demo}`뿐이라, 두 번 누르거나 Enter를 되풀이하면 같은 POST {enabled}·DELETE가 두 번 갔습니다 — 두 번째
 * DELETE는 서버 404라 지운 직후 '지우지 못했습니다' 꼴의 경고가 떴습니다(머리 없는 크롬 1440: 두 번 누름 DELETE 2건, Enter 세 번 DELETE 3건, '켜짐 — 끄기'
 * Enter 두 번 POST 2건 — QA 스택·고치기 전 빌드 같음). 지운 줄이 사라지면 포커스가 body로 떨어졌습니다.
 *
 * 기대: 켜짐 조건(`disabled={demo}`)은 그대로 두고, 그 줄의 쓰기(와 그 뒤 규칙 다시 읽기)가 끝날 때까지 같은 줄의 두 단추는 누름을 무시하며 aria-disabled로
 * 요청 중임을 알립니다(QA-887 꼴 — 진짜 disabled가 아니라 포커스가 남음). 다른 줄의 단추는 그대로 누를 수 있습니다. 경로·메서드·본문·확인 없음은 그대로
 * (moreWritesKeep). 성공·실패 뒤 포커스가 body로 떨어졌으면 그 줄의 같은 단추, 줄이 사라졌으면 다음 줄의 같은 단추, 다음 줄이 없으면 표(가로 스크롤 상자)로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫째·둘째 사례 'expected "vi.fn()" to be called 1 times, but got 2 times', 셋째 사례(실패 뒤 포커스는
 * 고치기 전에도 남음 — 지운 뒤) 'expected <body><div>…(1)</div></body> to be <button type="button" …(1)></button>', 넷째 사례
 * 'expected <body><div>…(1)</div></body> to be <div …(4)>…(1)</div>'.
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
import type { SessionUser } from "@/lib/types";
import AlertsPage from "../alerts/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

type Rule = { id: number; kind: string; params: Record<string, unknown>; enabled: boolean; description: string; createdAt: string };
let rules: Rule[] = [];
const rule = (id: number, description: string, enabled = true): Rule => ({ id, kind: "REGIME_CHANGE", params: {}, enabled, description, createdAt: "2026-11-01T00:00:00Z" });

/** 끝나지 않은 쓰기를 직접 끝냅니다 — 성공하면 서버처럼 규칙 목록을 바꿉니다. */
let finishDelete: (ok: boolean) => void = () => {};
let finishToggle: () => void = () => {};

beforeEach(() => {
  rules = [rule(3, "규칙 셋"), rule(4, "규칙 넷"), rule(5, "규칙 다섯", false)];
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === "/api/alerts/rules") return Promise.resolve({ available: true, limit: 20, rules: rules.map((row) => ({ ...row })) });
    if (path === "/api/alerts/inbox?limit=50") return Promise.resolve({ items: [], unread: 0 });
    if (path === "/api/sec13f/institutions") return Promise.resolve({ institutions: [] });
    return new Promise(() => {});
  });
  api.apiDelete.mockImplementation((path: string) => new Promise((resolve, reject) => {
    finishDelete = (ok) => {
      if (!ok) return reject(new Error("지우지 못했습니다(합성)."));
      const id = Number(path.split("/").pop());
      rules = rules.filter((row) => row.id !== id);
      resolve({ ok: true, message: "지웠습니다." });
    };
  }));
  api.apiPost.mockImplementation((path: string, body: { enabled?: boolean }) => new Promise((resolve) => {
    finishToggle = () => {
      const id = Number(path.split("/").pop());
      rules = rules.map((row) => (row.id === id ? { ...row, enabled: Boolean(body.enabled) } : row));
      resolve({ ok: true, message: "바꿨습니다." });
    };
  }));
});
afterEach(() => cleanup());

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

async function openTable(): Promise<HTMLElement> {
  render(<SessionUserProvider user={MEMBER}><AlertsPage /></SessionUserProvider>);
  const table = await screen.findByRole("region", { name: "알림 규칙 (좌우 스크롤)" });
  await settle();
  return table;
}
const row = (table: HTMLElement, text: string) => within(table).getByText(text).closest("tr") as HTMLElement;
const button = (table: HTMLElement, text: string, name: string | RegExp) => within(row(table, text)).getByRole("button", { name });

describe("알림 규칙 표 두 번 누름(QA-898)", () => {
  it.fails("'지우기'를 요청 중에 다시 누르면 무시 — 같은 줄 두 단추는 aria-disabled(진짜 disabled 아님), 다른 줄은 그대로", async () => {
    const table = await openTable();
    const remove = button(table, "규칙 셋", "지우기");
    fireEvent.click(remove);
    await act(async () => {});
    fireEvent.click(remove);
    fireEvent.click(button(table, "규칙 셋", "켜짐 — 끄기"));
    await act(async () => {});
    expect(api.apiDelete).toHaveBeenCalledTimes(1);
    expect(api.apiPost).not.toHaveBeenCalled();
    for (const name of ["지우기", "켜짐 — 끄기"]) {
      const control = button(table, "규칙 셋", name) as HTMLButtonElement;
      expect(control.getAttribute("aria-disabled"), name).toBe("true");
      expect(control.disabled, name).toBe(false);
    }
    // 다른 줄은 누를 수 있음(켜짐 조건 그대로).
    expect(button(table, "규칙 넷", "지우기").getAttribute("aria-disabled")).toBeNull();
    await act(async () => finishDelete(true));
    await settle();
    expect(api.apiDelete.mock.calls).toEqual([["/api/alerts/rules/3"]]);
  });

  it.fails("'켜짐 — 끄기'를 요청 중에 다시 누르면 무시 — 끝나면 다시 누를 수 있다", async () => {
    const table = await openTable();
    const toggle = button(table, "규칙 넷", "켜짐 — 끄기");
    fireEvent.click(toggle);
    await act(async () => {});
    fireEvent.click(toggle);
    await act(async () => {});
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    await act(async () => finishToggle());
    await settle();
    const again = button(table, "규칙 넷", "꺼짐 — 켜기");
    expect(again.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(again);
    await act(async () => {});
    expect(api.apiPost.mock.calls).toEqual([
      ["/api/alerts/rules/4", { enabled: false }],
      ["/api/alerts/rules/4", { enabled: true }],
    ]);
  });

  it.fails("지운 줄이 사라지면 포커스는 다음 줄의 '지우기'로, 실패하면 누른 단추에 남는다", async () => {
    const table = await openTable();
    const remove = button(table, "규칙 셋", "지우기");
    act(() => remove.focus());
    fireEvent.click(remove);
    await act(async () => finishDelete(false));
    await settle();
    expect(document.activeElement).toBe(button(table, "규칙 셋", "지우기"));
    expect(screen.getByText("지우지 못했습니다(합성).")).toBeTruthy();

    fireEvent.click(button(table, "규칙 셋", "지우기"));
    await act(async () => finishDelete(true));
    await settle();
    expect(within(table).queryByText("규칙 셋")).toBeNull();
    expect(document.activeElement).toBe(button(table, "규칙 넷", "지우기"));
  });

  it.fails("마지막 줄을 지우면 포커스는 표(가로 스크롤 상자)로", async () => {
    const table = await openTable();
    const remove = button(table, "규칙 다섯", "지우기");
    act(() => remove.focus());
    fireEvent.click(remove);
    await act(async () => finishDelete(true));
    await settle();
    expect(within(table).queryByText("규칙 다섯")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "알림 규칙 (좌우 스크롤)" }));
  });
});
