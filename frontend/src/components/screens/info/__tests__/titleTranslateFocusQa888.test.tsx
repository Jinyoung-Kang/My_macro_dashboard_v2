/**
 * 정보 수집 뉴스·글 목록의 제목 '번역' 뒤 포커스 — QA-888(D6 전 QA 스택 확인에서 찾음, 개편 전부터 — D5 기준 빌드도 같음).
 *
 * 목록 줄의 제목 '번역'(aria-label '제목 번역: …')을 키보드로 누르면 요청 동안 단추가 진짜 disabled가 되어 크롬이 포커스를 body로 보냈습니다. 성공하면
 * 단추 자리에 한국어 제목 글만 그려(단추가 사라짐) 역시 body, 실패해도 body에서 돌아오지 않았습니다(모든 폭).
 *
 * 기대: 요청 동안 단추는 aria-disabled(포커스 유지 — 다시 눌러도 요청 한 번). 실패하면 포커스는 그 '번역' 단추에 남고(옆에 사유), 성공하면 단추 자리의
 * 한국어 제목 글(tabIndex -1 — 낭독기가 번역을 읽음)로 옮깁니다. 번역 POST의 경로·본문({title})은 그대로.
 * jsdom은 disabled가 된 단추에서 포커스를 빼지 않으므로 요청 동안의 disabled 속성 자체를 봅니다(크롬은 그 순간 body로 보냄).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected true to be false'(요청 동안 disabled), 둘째 사례 'expected <body>…(1)</body> to be
 * <p …(2)></p>'(성공 뒤 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { NewsSection } from "../NewsSection";

const CATALOG = { checkedAt: "2026-11-14 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };

function article(id: string, title: string) {
  return {
    id, source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article", url: `https://blog.example/${id}/`, title, titleKo: null,
    author: null, publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: null, bodyStatus: "none", fetchTier: null, category: null,
  };
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
});
afterEach(() => cleanup());

/** 글 하나의 목록을 두고 그 제목의 '번역'에 포커스를 둔 채 누릅니다 → 단추. 같은 제목 요청은 끝날 때까지 묶이므로(QA-410) 사례마다 제목이 다릅니다. */
async function pressTitleTranslate(title: string) {
  const item = article(`0123456789abcdef0123${title.length.toString().padStart(4, "0")}`, title);
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/info/catalog")) return Promise.resolve(CATALOG);
    if (path.startsWith("/api/info/items?kind=blog")) return Promise.resolve({ available: true, items: [item], page: 1, size: 10, total: 1, pages: 1 });
    return new Promise(() => {});
  });
  render(<NewsSection />);
  const button = await screen.findByRole("button", { name: `제목 번역: ${title}` });
  button.focus();
  fireEvent.click(button);
  return button;
}

describe("목록 제목 '번역' 뒤 포커스(QA-888)", () => {
  it.fails("요청 동안 단추는 aria-disabled(포커스 유지, 다시 눌러도 한 번) — 실패하면 그 단추에 포커스, 옆에 사유", async () => {
    let fail: (error: Error) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const button = await pressTitleTranslate("Rates Spike");
    await waitFor(() => expect(button.textContent).toBe("번역 중…"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { title: "Rates Spike" }]]);
    await act(async () => fail(new Error("합성 실패")));
    expect(await screen.findByText("합성 실패")).toBeTruthy();
    const again = screen.getByRole("button", { name: "제목 번역: Rates Spike" });
    expect(again.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(again);
  });

  it.fails("성공하면 단추 자리의 한국어 제목 글로 포커스", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await pressTitleTranslate("Yields Fall Again");
    await act(async () => finish({ ok: true, titleKo: "합성 금리 다시 하락", textKo: null, alreadyKorean: false, cached: false, truncated: false, model: "합성", error: null }));
    const korean = await screen.findByText("합성 금리 다시 하락");
    expect(screen.queryByRole("button", { name: "제목 번역: Yields Fall Again" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(korean));
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { title: "Yields Fall Again" }]]);
  });
});
