/**
 * 정보 수집 뉴스·글 원문 검사 칸의 '한국어로 번역' 뒤 포커스 — QA-887(D6 전 QA 스택 확인에서 찾음, 작업대 P7 회귀).
 *
 * 넓은 틀(64rem 이상 — 옆 칸, 대화상자 아님)에서 원문의 '한국어로 번역'을 키보드로 누르면 요청 동안 단추가 진짜 disabled가 되어 크롬이 포커스를 body로
 * 보냈고, 응답 뒤에도 돌아오지 않았습니다(실패 뒤 Tab 한 번은 '다시 번역'을 건너뛰어 '원문 열기(새 창)'). 성공하면 번역 단추가 사라져(더 옮길 것이 없음)
 * 역시 body. D5에서는 원문이 모든 폭 대화상자라 Radix 포커스 가두기가 대화상자 틀로 되살렸지만, P7 옆 칸(InspectorFrame — 가두기 없음)에는 되살리는
 * 장치가 없습니다.
 *
 * 기대: 요청 동안 단추는 disabled가 아니라 aria-disabled(포커스를 잃지 않음 — 다시 눌러도 요청 한 번, QA-444·정보 검색 원문 팝업과 같은 꼴). 실패하면 포커스는
 * 같은 자리 '다시 번역'에 남고, 성공으로 번역 단추가 사라지면 '원문 보기' 전환 단추로 옮깁니다. 번역 POST의 경로·본문({itemId})은 그대로.
 * jsdom은 disabled가 된 단추에서 포커스를 빼지 않으므로 요청 동안의 disabled 속성 자체를 봅니다(크롬은 그 순간 body로 보냄 — 진행 기록의 측정).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected true to be false'(요청 동안 disabled), 둘째 사례 'expected <body>…(1)</body> to be
 * <button type="button" …(2)></button>'(성공 뒤 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import { NewsSection } from "../NewsSection";

const CATALOG = { checkedAt: "2026-11-14 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };
const ARTICLE = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article",
  url: "https://blog.example/2026/11/15/rates/", title: "Rates Spike", titleKo: null, author: "A. Writer",
  publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: "합성 요약", bodyStatus: "full",
  fetchTier: null, category: null,
};
// 둘째 사례는 다른 글 — 같은 번역 요청은 끝날 때까지 묶이므로(useTranslate, QA-410) 앞 사례가 끝나지 않은 채 실패하면 뒤 사례가 그 요청에 묶입니다.
const OTHER = { ...ARTICLE, id: "0123456789abcdef0123ffff" };
const OK = { ok: true, titleKo: "합성 금리 급등", textKo: "합성 본문의 번역", alreadyKorean: false, cached: false, truncated: false, model: "gemini-flash-lite-latest", error: null };

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  // 넓은 화면(lg 이상) + 틀 1200px — 원문은 옆 칸(대화상자 아님, 포커스 가두기 없음).
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("@container")
      ? ({ width: 1200, height: 0, top: 0, left: 0, right: 1200, bottom: 0, x: 0, y: 0 } as DOMRect)
      : original.call(this);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 글 하나의 목록·본문 응답을 두고 옆 칸을 열어 '한국어로 번역'에 포커스를 둔 채 누릅니다 → 옆 칸·단추. */
async function pressTranslate(article: typeof ARTICLE) {
  const map: Record<string, unknown> = {
    "/api/info/catalog": CATALOG,
    [`/api/info/items/${article.id}`]: { found: true, item: { ...article, body: "Synthetic body paragraph." } },
    "/api/info/items?kind=blog": { available: true, items: [article], page: 1, size: 10, total: 1, pages: 1 },
  };
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([prefix]) => path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
  render(<NewsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Rates Spike" }));
  const side = screen.getByRole("region", { name: "원문 — Rates Spike" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await within(side).findByText("Synthetic body paragraph.");
  const button = within(side).getByRole("button", { name: "한국어로 번역" });
  button.focus();
  fireEvent.click(button);
  return { side, button };
}

describe("원문 검사 칸(옆 칸) 번역 뒤 포커스(QA-887)", () => {
  it("요청 동안 단추는 disabled가 아니라 aria-disabled(포커스 유지, 다시 눌러도 한 번) — 실패하면 같은 자리 '다시 번역'에 포커스", async () => {
    let fail: (error: Error) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { side, button } = await pressTranslate(ARTICLE);
    const busy = await within(side).findByRole("button", { name: "번역 중…" });
    expect(busy).toBe(button);
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { itemId: ARTICLE.id }]]);
    await act(async () => fail(new Error("합성 실패")));
    const retry = await within(side).findByRole("button", { name: "다시 번역" });
    expect(retry.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(retry);
  });

  it("성공해 번역 단추가 사라지면 '원문 보기' 전환 단추로 포커스", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { side } = await pressTranslate(OTHER);
    await within(side).findByRole("button", { name: "번역 중…" });
    await act(async () => finish(OK));
    expect(await within(side).findByText("합성 본문의 번역")).toBeTruthy();
    expect(within(side).queryByRole("button", { name: /번역$/ })).toBeNull();
    const toggle = within(side).getByRole("button", { name: "원문 보기" });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { itemId: OTHER.id }]]);
  });
});
