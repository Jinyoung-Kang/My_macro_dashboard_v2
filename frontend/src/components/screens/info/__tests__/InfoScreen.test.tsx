/**
 * 정보 수집 화면(/paper/info, ADR 0035) — 탭마다 저장본을 읽어 그리고, 원문 링크를 늘 보이며, 없는 값은 '—'(네이버 장중 추정 금액),
 * 본문은 펼칠 때 한 편씩 읽는다. 표본은 합성 응답입니다.
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

import InfoScreen from "../InfoScreen";

const SOURCES = {
  checkedAt: "2026-11-11 18:00:00 KST",
  available: true,
  recorded: false,
  incidents: [],
  sources: [
    { task: "info_blog_wolfstreet", key: "blog.wolfstreet", label: "Wolf Street", category: "blog", siteUrl: "https://wolfstreet.com/",
      status: null, streak: null, reason: null, lastOkAt: null, lastRunAt: null, items: 1, latestItemAt: null, incident: null },
    { task: "info_naver_flows", key: "naver.flows", label: "네이버 투자자별 매매동향·매매상위", category: "naver",
      siteUrl: "https://stock.naver.com/market/stock/kr/trend/trader", status: null, streak: null, reason: null, lastOkAt: null,
      lastRunAt: null, items: 0, latestItemAt: null, incident: null },
  ],
};

const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.wolfstreet", sourceLabel: "Wolf Street", kind: "article",
  url: "https://wolfstreet.com/2026/11/10/rates-spike/", title: "Rates Spike", titleKo: "금리 급등", author: "Wolf Richter",
  publishedAt: "2026-11-10 19:21:57 KST", firstSeenAt: "2026-11-11 01:00:00 KST", summary: "요약 글", bodyStatus: "full",
  fetchTier: "impersonate", category: null,
};

const FLOWS = {
  available: true, collectedAtKst: "2026-11-11 16:50 KST", ageSeconds: 60, source: "네이버 증권 투자자별 매매동향·매매상위",
  fetchTier: "impersonate", unit: "억원", failed: [],
  sourceUrls: { trader: "https://stock.naver.com/market/stock/kr/trend/trader", foreigner: "https://stock.naver.com/market/stock/kr/trend/foreigner",
    organization: "https://stock.naver.com/market/stock/kr/trend/organization" },
  trend: { KOSPI: { rows: [{ date: "2026-11-10", individual: -900, foreign: 1000, institution: 30, financial: -40, insurance: null,
    trust: 20, bank: 20, otherFinancial: 0, pension: 100, otherCorp: 50 }] } },
  rankings: { FOREIGNER: { KOSPI: { estimated: true, rankedAt: "2026-11-11T16:44:10+09:00", period: { from: "2026-11-11", to: "2026-11-11" },
    buy: [{ rank: 1, code: "000001", name: "가나다", price: 7210, changePct: -1.1, netVolume: 873324, netAmountEok: null }], sell: [] } } },
};

function routes(map: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([prefix]) => path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  window.history.replaceState(null, "", "/paper/info");
});
afterEach(() => cleanup());

describe("정보 수집 화면", () => {
  it("해외 블로그: 한국어 제목을 위에, 원문 링크와 함께, 본문은 펼칠 때 읽는다", async () => {
    routes({
      "/api/info/sources": SOURCES,
      "/api/info/items/0123456789abcdef01234567": { found: true, item: { ...ITEM, body: "본문 첫 문단" } },
      "/api/info/items?category=blog": { available: true, items: [ITEM], next: null },
    });
    render(<InfoScreen />);

    const title = await screen.findByRole("link", { name: "금리 급등" });
    expect(title.getAttribute("href")).toBe(ITEM.url);
    expect(screen.getByText("Rates Spike")).toBeTruthy();
    expect(api.apiGetShared.mock.calls.some(([path]) => String(path).startsWith("/api/info/items/"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "본문 보기" }));
    expect(await screen.findByText("본문 첫 문단")).toBeTruthy();
  });

  it("네이버 수급: 장중 추정 순위의 금액은 '—'이고 주식 수만", async () => {
    routes({ "/api/info/sources": SOURCES, "/api/info/flows": FLOWS });
    render(<InfoScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "네이버 수급" }));

    const table = await screen.findByRole("region", { name: /외국인 순매수 상위 · 코스피/ });
    const row = within(table).getByText("가나다").closest("tr") as HTMLElement;
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).getByText("+873,324주")).toBeTruthy();
    expect(screen.getByText(/장중 추정 — 금액 없음/)).toBeTruthy();
  });

  it("주소의 ?tab=sources로 출처 상태를 열고, 로컬(기록 없음)이면 서버에서만 수집한다고 적는다", async () => {
    window.history.replaceState(null, "", "/paper/info?tab=sources");
    routes({ "/api/info/sources": SOURCES });
    render(<InfoScreen />);

    expect(await screen.findByText(/운영 서버에서만 돌기 때문에/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Wolf Street" }).getAttribute("href")).toBe("https://wolfstreet.com/");
    expect(screen.getAllByText("기록 없음").length).toBe(2);
  });
});
