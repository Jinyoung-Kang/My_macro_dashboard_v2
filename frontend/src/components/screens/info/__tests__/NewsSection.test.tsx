/**
 * 정보 수집 > 뉴스·글의 세 번째 헤드라인 보기 '보도자료·경제지'(정보 검색 계약 §6-1 — 새 피드 묶음, 백엔드 headlines의 set=world).
 * 사건 뉴스(미국·한국 — 모의 매매 패킷의 재료)와 다른 묶음이라 패킷에 들어가지 않는다고 적고, 시각 칸이 없는 피드는 처음 받은 시각에 '받은 시각'.
 * 표본은 모두 합성 응답입니다.
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

import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import { NewsSection } from "../NewsSection";

function routes(map: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([prefix]) => path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}
const called = (prefix: string) => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));

const CATALOG = { checkedAt: "2026-11-14 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("뉴스·글 — 보도자료·경제지 보기", () => {
  it("사건 뉴스 두 보기 옆에 세 번째 보기 — set=world로 읽고, 패킷에 들어가지 않는다고 적고, 받은 시각을 표시한다", async () => {
    routes({
      "/api/info/catalog": CATALOG,
      "/api/info/items?kind=blog": { available: true, items: [], page: 1, size: 10, total: 0, pages: 1 },
      "/api/info/headlines?set=world": {
        available: true, page: 1, size: 10, total: 2, pages: 1,
        items: [
          { set: "world", title: "ECB keeps rates unchanged", summary: "The Governing Council decided.", link: null, url: "https://www.ecb.europa.eu/x",
            source: null, publisher: "European Central Bank", feed: "ecb_press", publishedAt: "2026-11-14 09:30:00 KST",
            fetchedAt: "2026-11-14T00:40:00+00:00", timeBasis: "published" },
          { set: "world", title: "Asia markets wrap", summary: null, link: "https://asia.nikkei.com/y", source: "Nikkei Asia", feed: "nikkei_asia",
            publishedAt: null, fetchedAt: "2026-11-14T01:00:00+00:00", timeBasis: "fetched" },
        ],
      },
    });
    render(<NewsSection />);

    // 보기 고르기는 하나만 고르는 라디오 묶음(작업대 P7 — 공용 FilterList, 예전 aria-pressed 칩과 같은 뜻).
    const views = screen.getByRole("radiogroup", { name: "글 종류" });
    const labels = within(views).getAllByRole("radio").map((button) => button.textContent);
    expect(labels.slice(labels.indexOf("사건 뉴스(미국)"))).toEqual(["사건 뉴스(미국)", "사건 뉴스(한국)", "보도자료·경제지"]);

    fireEvent.click(within(views).getByRole("radio", { name: "보도자료·경제지" }));
    expect(await screen.findByRole("button", { name: "ECB keeps rates unchanged" })).toBeTruthy();
    expect(called("/api/info/headlines")).toEqual([endpoints.info.headlines({ set: "world", page: 1, size: 10 })]);
    expect(screen.getByText(/모의 매매 패킷에는 들어가지 않습니다/)).toBeTruthy();
    // 보관 기간은 목록이 있을 때도 안내 글에(빈 목록 안내에만 두지 않음)
    expect(screen.getByText(/보관 90일/)).toBeTruthy();
    expect(screen.queryByText(/11b_events/)).toBeNull();
    expect(screen.getByText(/European Central Bank/)).toBeTruthy();
    expect(screen.getByText("2026-11-14 09:30 KST")).toBeTruthy();
    expect(screen.getByText("2026-11-14 10:00 KST (받은 시각)")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "원문 열기" }).map((link) => link.getAttribute("href"));
    expect(links).toEqual(["https://www.ecb.europa.eu/x", "https://asia.nikkei.com/y"]);
    expect(screen.getByLabelText("검색(제목)")).toBeTruthy();
  });

  it("받은 제목이 없으면 그 묶음의 보관 기간과 함께", async () => {
    routes({
      "/api/info/catalog": CATALOG,
      "/api/info/items?kind=blog": { available: true, items: [], page: 1, size: 10, total: 0, pages: 1 },
      "/api/info/headlines?set=world": { available: true, page: 1, size: 10, total: 0, pages: 0, items: [] },
    });
    render(<NewsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "보도자료·경제지" }));
    expect(await screen.findByText(/받은 제목이 없습니다\(보관 90일\)/)).toBeTruthy();
  });
});

// ------------------------------------------------------------------ 작업대 P7: 목록 + 원문 검사 칸
const ARTICLE = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article",
  url: "https://blog.example/2026/11/15/rates/", title: "Synthetic rates outlook", titleKo: null, author: "A. Writer",
  publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: "합성 요약", bodyStatus: "full",
  fetchTier: null, category: null,
};
const SECOND = { ...ARTICLE, id: "0123456789abcdef0123ffff", title: "Second synthetic post" };
const OK = { ok: true, titleKo: "합성 금리 전망", textKo: "합성 본문의 번역", alreadyKorean: false, cached: false, truncated: false, model: "gemini-flash-lite-latest", error: null };

function articleRoutes() {
  routes({
    "/api/info/catalog": CATALOG,
    [`/api/info/items/${ARTICLE.id}`]: { found: true, item: { ...ARTICLE, body: "Synthetic body paragraph." } },
    "/api/info/items?kind=blog": { available: true, items: [ARTICLE, SECOND], page: 1, size: 10, total: 12, pages: 2 },
  });
}

/** 넓은 화면(lg 이상)과 틀 폭(@container — 원문 칸 배치 wide의 기준 64rem) 대역. */
function stubWide(frameWidth: number) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("@container")
      ? ({ width: frameWidth, height: 0, top: 0, left: 0, right: frameWidth, bottom: 0, x: 0, y: 0 } as DOMRect)
      : original.call(this);
  });
}

const bodyReads = () => called("/api/info/items/");

describe("뉴스·글 — 목록 + 원문 검사 칸(작업대 P7)", () => {
  it("넓은 화면·넓은 틀: 처음에는 안내 글만(본문을 읽지 않음), 제목을 고르면 옆 칸에 원문 — 본문 GET 한 번, 고른 줄 표시, 번역 본문 {itemId}", async () => {
    stubWide(1200);
    articleRoutes();
    api.apiPost.mockResolvedValue(OK);
    render(<NewsSection />);
    await screen.findByRole("button", { name: "Synthetic rates outlook" });
    const empty = screen.getByRole("region", { name: "원문 — 고른 줄 없음" });
    expect(within(empty).getByText("제목을 고르면 이 칸에 받아 둔 원문이 열립니다.")).toBeTruthy();
    expect(bodyReads()).toEqual([]);

    const title = screen.getByRole("button", { name: "Synthetic rates outlook" });
    expect(title.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(title);
    const side = screen.getByRole("region", { name: "원문 — Synthetic rates outlook" });
    expect(await within(side).findByText("Synthetic body paragraph.")).toBeTruthy();
    expect(within(side).getByText("2026-11-15 09:00 KST")).toBeTruthy();       // 옆 칸 맨 위 '출처 · 시각'
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bodyReads()).toEqual([endpoints.info.item(ARTICLE.id)]);
    expect(title.getAttribute("aria-current")).toBe("true");
    expect(title.closest("li")?.className).toContain("bg-surface-2");

    // '본문 보기'는 같은 글 — 다시 읽지 않습니다.
    fireEvent.click(within(title.closest("li") as HTMLElement).getByRole("button", { name: "본문 보기" }));
    expect(bodyReads()).toHaveLength(1);

    fireEvent.click(within(side).getByRole("button", { name: "한국어로 번역" }));
    expect(await within(side).findByText("합성 본문의 번역")).toBeTruthy();
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { itemId: ARTICLE.id }]]);
  });

  it("넓은 화면: 쪽을 옮기면 고름을 푼다(보이지 않는 줄의 원문을 남기지 않음)", async () => {
    stubWide(1200);
    articleRoutes();
    render(<NewsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic rates outlook" }));
    expect(screen.getByRole("region", { name: "원문 — Synthetic rates outlook" })).toBeTruthy();
    act(() => {
      fireEvent.click(within(screen.getByRole("navigation", { name: "글 목록 쪽" })).getByRole("button", { name: "2" }));
    });
    await waitFor(() => expect(called("/api/info/items?kind=blog").some((path) => path.includes("page=2"))).toBe(true));
    expect(screen.getByRole("region", { name: "원문 — 고른 줄 없음" })).toBeTruthy();
  });

  // 틀 폭으로 배치가 갈리는지를 한 사례에서 봅니다 — 대화상자만 보면 개편 전(모든 폭 원문 팝업)에서도 통과했습니다(P7 검토).
  it("넓은 화면이라도 틀이 64rem보다 좁으면(1280·1024) 같은 누름이 대화상자 — 64rem 이상이면 옆 칸(대화상자 없음)", async () => {
    stubWide(1200);
    articleRoutes();
    const wide = render(<NewsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic rates outlook" }));
    expect(screen.getByRole("region", { name: "원문 — Synthetic rates outlook" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    wide.unmount();
    vi.restoreAllMocks();

    stubWide(900);
    render(<NewsSection />);
    const title = await screen.findByRole("button", { name: "Synthetic rates outlook" });
    expect(screen.queryByRole("region", { name: /^원문 — / })).toBeNull();
    expect(title.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(title);
    const dialog = await screen.findByRole("dialog", { name: "Synthetic rates outlook" });
    const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Synthetic Blog · 2026-11-15 09:00 KST");
    // 검사 칸 틀의 대화상자 — 첫 포커스는 제목(QA-871).
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Synthetic rates outlook" }));
  });

  it("좁은 화면: 대화상자 — 이름은 제목, 설명은 '출처 · 시각'(예전 원문 팝업과 같은 꼴), Esc로 닫으면 제목 단추로 포커스", async () => {
    articleRoutes();
    render(<NewsSection />);
    const title = await screen.findByRole("button", { name: "Synthetic rates outlook" });
    fireEvent.click(title);
    const dialog = await screen.findByRole("dialog", { name: "Synthetic rates outlook" });
    const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Synthetic Blog · 2026-11-15 09:00 KST");
    expect(await within(dialog).findByText("Synthetic body paragraph.")).toBeTruthy();
    expect(bodyReads()).toEqual([endpoints.info.item(ARTICLE.id)]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Synthetic rates outlook" })));
  });

  it("검색어 칸은 셸 거르기 칸 표지(data-shell-filter)를 달고, 찾으면 첫 쪽 q=로 묻는다", async () => {
    articleRoutes();
    render(<NewsSection />);
    await screen.findByRole("button", { name: "Synthetic rates outlook" });
    const input = screen.getByLabelText("검색(제목·요약)");
    expect(input.hasAttribute("data-shell-filter")).toBe(true);
    fireEvent.change(input, { target: { value: "rates" } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    await waitFor(() => expect(called("/api/info/items?kind=blog")).toContain(endpoints.info.items({ kind: "blog", q: "rates", page: 1, size: 10 })));
  });
});
