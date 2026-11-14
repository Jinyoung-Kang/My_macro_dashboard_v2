/**
 * 정보 수집 > 뉴스·글의 세 번째 헤드라인 보기 '보도자료·경제지'(정보 검색 계약 §6-1 — 새 피드 묶음, 백엔드 headlines의 set=world).
 * 사건 뉴스(미국·한국 — 모의 매매 패킷의 재료)와 다른 묶음이라 패킷에 들어가지 않는다고 적고, 시각 칸이 없는 피드는 처음 받은 시각에 '받은 시각'.
 * 표본은 모두 합성 응답입니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
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
afterEach(() => cleanup());

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

    const views = screen.getByRole("group", { name: "글 종류" });
    const labels = within(views).getAllByRole("button").map((button) => button.textContent);
    expect(labels.slice(labels.indexOf("사건 뉴스(미국)"))).toEqual(["사건 뉴스(미국)", "사건 뉴스(한국)", "보도자료·경제지"]);

    fireEvent.click(within(views).getByRole("button", { name: "보도자료·경제지" }));
    expect(await screen.findByRole("button", { name: "ECB keeps rates unchanged" })).toBeTruthy();
    expect(called("/api/info/headlines")).toEqual([endpoints.info.headlines({ set: "world", page: 1, size: 10 })]);
    expect(screen.getByText(/모의 매매 패킷에는 들어가지 않습니다/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "보도자료·경제지" }));
    expect(await screen.findByText(/받은 제목이 없습니다\(보관 90일\)/)).toBeTruthy();
  });
});
