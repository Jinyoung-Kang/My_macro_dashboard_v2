/**
 * 정보 수집 뉴스·글 원문 대화상자의 첫 포커스 — QA-871(작업대 P7 검토에서 찾음, 개편 전부터).
 *
 * 좁은 배치(좁은 화면·틀 64rem 미만)에서 원문 대화상자를 열면 첫 포커스가 내용의 첫 조작인 '한국어로 번역'(유료 번역 POST)에 갔습니다 — 연 직후 Enter·Space
 * 한 번이면 번역이 요청되고, 낭독기는 본문이 아니라 번역 단추부터 읽었습니다. 옛 원문 팝업(ReaderDialog)도 공용 대화상자 기본(content)이라 같았습니다. 같은 P7의
 * 알림 검사 칸은 첫 포커스를 제목에 둡니다(dialogFocus="title").
 *
 * 기대: 첫 포커스는 대화상자 제목(h2 — 원문 제목). 번역 단추의 동작·문구·켜짐 조건은 그대로이고 열기만으로는 번역을 요청하지 않습니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례(블로그 글 — 본문을 읽는 동안 열려 조작이 없음) 'expected <button type="button" …(2)>…(1)</button> to be <h2 …>'
 * (activeElement가 닫기 단추), 둘째 사례(헤드라인 — 번역 단추가 바로 있음) activeElement가 '한국어로 번역' 단추.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const ARTICLE = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article",
  url: "https://blog.example/2026/11/15/rates/", title: "Synthetic rates outlook", titleKo: null, author: "A. Writer",
  publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: "합성 요약", bodyStatus: "full",
  fetchTier: null, category: null,
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  const map: Record<string, unknown> = {
    "/api/info/catalog": CATALOG,
    [`/api/info/items/${ARTICLE.id}`]: { found: true, item: { ...ARTICLE, body: "Synthetic body paragraph." } },
    "/api/info/items?kind=blog": { available: true, items: [ARTICLE], page: 1, size: 10, total: 1, pages: 1 },
    "/api/info/headlines?set=world": {
      available: true, page: 1, size: 10, total: 1, pages: 1,
      items: [{ set: "world", title: "ECB keeps rates unchanged", summary: "The Governing Council decided.", link: null, url: "https://www.ecb.europa.eu/x",
        source: null, publisher: "European Central Bank", feed: "ecb_press", publishedAt: "2026-11-14 09:30:00 KST",
        fetchedAt: "2026-11-14T00:40:00+00:00", timeBasis: "published" }],
    },
  };
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([prefix]) => path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
});
afterEach(() => cleanup());

describe("원문 대화상자의 첫 포커스(QA-871)", () => {
  it("좁은 화면: 대화상자를 열면 첫 포커스는 제목 — 번역 단추가 아님, 열기만으로 번역 POST 없음", async () => {
    render(<NewsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic rates outlook" }));
    const dialog = await screen.findByRole("dialog", { name: "Synthetic rates outlook" });
    expect(await within(dialog).findByText("Synthetic body paragraph.")).toBeTruthy();
    await act(async () => {});
    expect(within(dialog).getByRole("button", { name: "한국어로 번역" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Synthetic rates outlook" }));
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("좁은 화면 · 보도자료·경제지 헤드라인(본문을 따로 읽지 않아 번역 단추가 바로 있음): 첫 포커스는 제목, Enter 한 번으로 번역 POST 없음", async () => {
    render(<NewsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "보도자료·경제지" }));
    fireEvent.click(await screen.findByRole("button", { name: "ECB keeps rates unchanged" }));
    const dialog = await screen.findByRole("dialog", { name: "ECB keeps rates unchanged" });
    await act(async () => {});
    expect(within(dialog).getByRole("button", { name: "한국어로 번역" })).toBeTruthy();
    const heading = within(dialog).getByRole("heading", { name: "ECB keeps rates unchanged" });
    expect(document.activeElement).toBe(heading);
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
