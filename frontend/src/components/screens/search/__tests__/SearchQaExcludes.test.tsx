/**
 * 정보 검색 첫 화면 — 매체 제외 목록의 '지우기' 단추 포커스(QA-444 후속 — WCAG 2.4.3). 같은 패널 '더하기'의 고침(QA-444 검토 지적)과 같은 방식입니다.
 * 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchExcludeAdded, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const ROWS: SearchExcludeAdded[] = [
  { id: 1, kind: "domain", value: "first.example", note: null, createdAt: "2026-11-10T00:00:00+00:00" },
  { id: 2, kind: "domain", value: "second.example", note: "합성 메모", createdAt: "2026-11-11T00:00:00+00:00" },
  { id: 3, kind: "name", value: "Third Example Wire", note: null, createdAt: "2026-11-12T00:00:00+00:00" },
];

/** 경로 앞부분 → 응답(값이 함수면 부를 때마다 계산). 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = path in reads ? path : Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  if (!hit) return new Promise(() => {});
  const value = reads[hit];
  return Promise.resolve(typeof value === "function" ? (value as () => unknown)() : value);
}

/** 서버의 더한 매체 — 지우기가 성공하면 여기서 빠지고, 목록 다시 읽기가 그 값을 받습니다. */
let added: SearchExcludeAdded[];
/** 지우기 요청을 붙잡아 두는 자리 — 끝내기(release)·실패(fail)를 시험이 정합니다. */
let pending: { id: number; release: () => void; fail: (failure: Error) => void } | null;

beforeEach(() => {
  added = [...ROWS];
  pending = null;
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  reads[endpoints.search.watch] = { available: true, items: [], limits: { mine: 0, max: 10, serverUsed: 0, serverMax: 100 }, collecting: false };
  reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
  reads[endpoints.search.excludes] = () => ({ available: true, seed: [{ kind: "domain", value: "seed.example", group: "합성 묶음" }], added });
  api.apiDelete.mockImplementation((path: string) => {
    const id = ROWS.find((row) => path === endpoints.search.exclude(row.id))?.id ?? -1;
    return new Promise((resolve, reject) => {
      pending = {
        id,
        release: () => {
          added = added.filter((row) => row.id !== id);
          resolve({ ok: true });
        },
        fail: reject,
      };
    });
  });
});
afterEach(() => cleanup());

async function openList(rows: SearchExcludeAdded[] = ROWS) {
  added = [...rows];
  setLocation("/search");
  render(
    <SessionUserProvider user={OWNER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
  return screen.findByRole("list", { name: "더한 제외 매체" });
}

/** 줄의 '지우기'에 포커스를 두고 누릅니다 — 브라우저는 단추 위 Enter·Space를 click으로 바꿉니다. */
function pressRemove(value: string): HTMLButtonElement {
  const button = screen.getByRole("button", { name: `${value} 지우기` }) as HTMLButtonElement;
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  return button;
}

/** 요청 중의 단추 — 진짜 disabled가 아니라 aria-disabled·aria-busy, 보이는 흐림, 포커스는 그 단추에. */
function expectBusyButKeepsFocus(button: HTMLButtonElement) {
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.className).toContain("aria-disabled:opacity-50");
  expect(document.activeElement).toBe(button);
}

describe("QA-444 후속 — 매체 제외 '지우기'는 요청 중에도 포커스를 잃지 않고, 줄이 사라지면 논리적인 자리로 옮긴다", () => {
  // QA-444 후속: QA 스택 브라우저 확인(/search 첫 화면 → 매체 제외 목록)에서 더한 매체의 '지우기'를 Enter로 누르면 요청 동안 단추가 진짜
  // disabled(disabled={excludes.busy})가 되어 포커스가 body로 떨어졌고, 모의 500으로 실패해 줄이 남아도 포커스는 body였습니다. 성공해 줄이
  // 사라질 때도 포커스가 갈 곳이 없었습니다. jsdom은 disabled가 된 요소의 포커스를 body로 옮기지 않으므로 속성(disabled·aria-disabled)과
  // activeElement로 봅니다. 수정 전 실패: 요청 중 단추의 disabled가 true(aria-disabled·aria-busy 없음)(재현 커밋에서는 it.fails).
  // 고침: 요청 중 aria-disabled(모든 줄)·aria-busy(누른 줄)와 누름 가드, 성공하면 다음 줄 → 앞 줄 → 더하기 값 칸으로 포커스.
  it("요청 중에는 aria-disabled·aria-busy(진짜 disabled 아님)이고 두 번 눌러도 한 번만 보내며, 성공하면 다음 줄의 '지우기'로 포커스를 옮긴다", async () => {
    await openList();
    const button = pressRemove("first.example");
    expect(api.apiDelete).toHaveBeenCalledTimes(1);
    expect(api.apiDelete).toHaveBeenCalledWith(endpoints.search.exclude(1));
    expectBusyButKeepsFocus(button);
    // 요청 중에는 다른 줄의 '지우기'도 같은 쓰기 상태라 aria-disabled(누름은 무시), aria-busy는 누른 단추에만.
    const other = screen.getByRole("button", { name: "second.example 지우기" }) as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(other);
    expect(api.apiDelete).toHaveBeenCalledTimes(1);

    // 포커스를 받는 순간의 상태 — 화면 낭독기는 focus 때의 속성을 읽으므로 그때 이미 aria-disabled가 없어야 합니다(QA-444 검토 지적).
    const atFocus: (string | null)[] = [];
    other.addEventListener("focus", () => atFocus.push(other.getAttribute("aria-disabled")));
    await act(async () => pending!.release());
    await waitFor(() => expect(screen.queryByRole("button", { name: "first.example 지우기" })).toBeNull());
    const next = screen.getByRole("button", { name: "second.example 지우기" });
    expect(next).toBe(other);
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBeNull();
    expect(atFocus).toEqual([null]);
  });

  it("마지막 줄을 지우면 앞 줄의 '지우기'로, 하나 남은 줄을 지우면 더하기의 값 칸으로 포커스를 옮긴다", async () => {
    await openList(ROWS.slice(1));
    let button = pressRemove("Third Example Wire");
    expectBusyButKeepsFocus(button);
    const previous = screen.getByRole("button", { name: "second.example 지우기" });
    const atFocus: (string | null)[] = [];
    previous.addEventListener("focus", () => atFocus.push(previous.getAttribute("aria-disabled")));
    await act(async () => pending!.release());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Third Example Wire 지우기" })).toBeNull());
    expect(document.activeElement).toBe(previous);
    expect(atFocus).toEqual([null]);

    button = pressRemove("second.example");
    expectBusyButKeepsFocus(button);
    await act(async () => pending!.release());
    await screen.findByText("더한 매체가 없습니다.");
    const form = screen.getByRole("form", { name: "제외 매체 더하기" });
    expect(document.activeElement).toBe(within(form).getByLabelText("값"));
  });

  it("실패(500)로 끝나면 줄이 남고 같은 단추에 포커스가 남는다 — 사유는 role=alert 글, 그 단추로 바로 다시 누를 수 있다", async () => {
    await openList();
    const button = pressRemove("second.example");
    expectBusyButKeepsFocus(button);

    await act(async () => pending!.fail(Object.assign(new Error("합성 서버 오류"), { status: 500 })));
    expect((await screen.findByRole("alert")).textContent).toContain("합성 서버 오류");
    expect(screen.getByRole("button", { name: "second.example 지우기" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(button);
    expect(api.apiDelete).toHaveBeenCalledTimes(2);
  });
});
