/**
 * 정보 검색 대상 머리 — 관심 대상 등록·해제 단추의 포커스(QA-444 — WCAG 2.4.3)와 긴 이름 옆 종류 꼬리표(QA-446 — ADR 0041 결정 11).
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
import type { SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [],
  sources: ["sec", "wikidata"],
};

const WATCH_NVDA = { id: 7, key: "us:NVDA", kind: "company", name: "엔비디아", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: "2026-11-13T00:00:00+00:00", newCount: 0 };

function watchList(items: unknown[]) {
  return { available: true, items, limits: { mine: items.length, max: 10, serverUsed: 5, serverMax: 100 }, collecting: false };
}

/** 경로 앞부분 → 응답(값이 함수면 부를 때마다 계산). 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = path in reads ? path : Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  if (!hit) return new Promise(() => {});
  const value = reads[hit];
  return Promise.resolve(typeof value === "function" ? (value as () => unknown)() : value);
}

function renderScreen(path: string, user: SessionUser = MEMBER) {
  setLocation(path);
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
});
afterEach(() => cleanup());

/** 다 풀린 뒤(대표 키를 앎) 이름의 단추를 찾아 포커스를 둡니다 — 브라우저는 단추 위 Enter·Space를 click으로 바꾸므로 포커스를 둔 뒤 click으로 누릅니다. */
async function focusedWatchButton(name: string): Promise<HTMLButtonElement> {
  const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  expect(document.activeElement).toBe(button);
  return button;
}

/** 요청 중의 단추 — 진짜 disabled가 아니라 aria-disabled·aria-busy, 보이는 진행 표시(흐림·도는 아이콘), 포커스는 그 단추에. */
function expectBusyButKeepsFocus(button: HTMLButtonElement) {
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.className).toContain("aria-disabled:opacity-50");
  expect(button.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
  expect(document.activeElement).toBe(button);
}

describe("QA-444 — 관심 대상 등록·해제 단추는 요청 중에도 포커스를 잃지 않는다", () => {
  // QA-444: 정보 검색 QA 스택 브라우저 확인(390·1440, /search?e=kr:005930)에서 '관심 대상 등록'에 포커스를 두고 Enter를 누르면 요청 동안
  // 단추에 진짜 disabled가 붙어(WatchButton의 disabled={!ready || watch.busy}) 브라우저가 포커스를 body로 보냈고(응답 뒤 activeElement BODY),
  // 다음 Tab은 페이지 맨 처음부터였습니다(WCAG 2.4.3). 같은 화면의 알림 단추·'요약'·별칭 '저장'은 aria-disabled와 누름 가드로 피합니다.
  // jsdom은 disabled가 된 요소의 포커스를 body로 옮기지 않으므로 속성(disabled·aria-disabled)과 단추 노드가 그대로인지로 봅니다.
  // 수정 전 실패: 요청 중 단추의 disabled가 true(aria-disabled·aria-busy 없음)(재현 커밋에서는 it.fails).
  it("등록 — 요청 중에는 aria-disabled(진짜 disabled 아님)이고 두 번 눌러도 한 번만 보내며, 끝나면 같은 단추가 '해제'로 바뀌어 포커스를 지닌다", async () => {
    let registered = false;
    let release: () => void = () => {};
    reads[endpoints.search.watch] = () => watchList(registered ? [WATCH_NVDA] : []);
    api.apiPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            registered = true;
            resolve({ ok: true });
          };
        }),
    );
    renderScreen("/search?e=us:NVDA");
    const button = await focusedWatchButton("관심 대상 등록");

    fireEvent.click(button);
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expectBusyButKeepsFocus(button);
    fireEvent.click(button);
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    await act(async () => release());
    const after = await screen.findByRole("button", { name: "관심 대상 해제" });
    expect(after).toBe(button);
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.disabled).toBe(false);
  });

  it("해제 — 요청 중에는 aria-disabled이고, 끝나면 같은 단추가 '등록'으로 바뀌어 포커스를 지닌다", async () => {
    let removed = false;
    let release: () => void = () => {};
    reads[endpoints.search.watch] = () => watchList(removed ? [] : [WATCH_NVDA]);
    api.apiDelete.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            removed = true;
            resolve({ ok: true });
          };
        }),
    );
    renderScreen("/search?e=us:NVDA");
    const button = await focusedWatchButton("관심 대상 해제");

    fireEvent.click(button);
    expect(api.apiDelete).toHaveBeenCalledTimes(1);
    expect(api.apiDelete).toHaveBeenCalledWith(endpoints.search.watchItem(7));
    expectBusyButKeepsFocus(button);
    fireEvent.click(button);
    expect(api.apiDelete).toHaveBeenCalledTimes(1);

    await act(async () => release());
    const after = await screen.findByRole("button", { name: "관심 대상 등록" });
    expect(after).toBe(button);
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
  });

  it("실패(상한 409)로 끝나도 같은 단추에 포커스가 남고 사유는 role=alert 글 — 그 단추로 바로 다시 누를 수 있다", async () => {
    let reject: (failure: Error) => void = () => {};
    reads[endpoints.search.watch] = () => watchList([]);
    api.apiPost.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    renderScreen("/search?e=us:NVDA");
    const button = await focusedWatchButton("관심 대상 등록");

    fireEvent.click(button);
    expectBusyButKeepsFocus(button);

    await act(async () => reject(Object.assign(new Error("관심 대상은 회원 10개까지입니다 — 하나를 지운 뒤 다시 등록하세요"), { status: 409 })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("관심 대상은 회원 10개까지입니다");
    expect(screen.getByRole("button", { name: "관심 대상 등록" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(api.apiPost).toHaveBeenCalledTimes(2);
  });
});

describe("QA-446 — 긴 영문 이름 옆의 종류 꼬리표는 한 줄로 남고 이름이 남은 폭을 쓴다", () => {
  // QA-446: 정보 검색 QA 스택 브라우저 확인(390, 이름을 긴 합성 영문 법인명으로 둔 대상)에서 대상 머리의 h2가 232px로 말줄임되고(title 없음)
  // 옆 종류 꼬리표 '기업'이 42x38px로 눌려 '기'·'업'이 두 줄로 쪼개졌습니다. 머리 줄(flex)에서 꼬리표에 shrink-0·whitespace-nowrap이 없어
  // 이름과 함께 줄어들고, 한글은 음절 사이에서 줄을 바꿀 수 있어서입니다(같은 화면의 다른 꼬리표·표지는 whitespace-nowrap).
  // jsdom은 배치를 재지 않으므로 클래스 약속(꼬리표·아이콘은 줄지 않음, 이름은 min-w-0 truncate로 남은 폭을 씀)과 이름 전체의 title로 봅니다.
  // 수정 전 실패: 꼬리표 className에 shrink-0·whitespace-nowrap이 없음(재현 커밋에서는 it.fails).
  const LONG_NAME = "Fictional Universal Financial Holdings Group, Inc.";

  it("꼬리표는 줄지 않고 한 줄(shrink-0·whitespace-nowrap), 이름은 남은 폭에서 말줄임하고 title에 이름 전체", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: { ...NVIDIA, name: LONG_NAME, nameKo: null, nameEn: LONG_NAME }, errors: {} };
    reads[endpoints.search.watch] = watchList([]);
    renderScreen("/search?e=us:NVDA");
    const heading = await screen.findByRole("heading", { level: 2, name: LONG_NAME });
    const row = heading.parentElement as HTMLElement;
    expect(row.className).toContain("flex");

    const badge = within(row).getByText("기업");
    expect(badge.className.split(/\s+/)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    for (const child of Array.from(row.children)) {
      if (child !== heading) expect(child.className.split(/\s+/)).toContain("shrink-0");
    }
    expect(heading.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(heading.getAttribute("title")).toBe(LONG_NAME);
  });
});
