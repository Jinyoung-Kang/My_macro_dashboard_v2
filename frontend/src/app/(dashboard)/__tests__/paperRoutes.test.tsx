/**
 * 🧪 모의매매(미국) 경로 — /paper/us(개요)·/paper/us/[tab](여섯 탭)과 화면의 주소 맞추기.
 * 🧪 모의매매(한국) 경로 — /paper/kr·/paper/kr/[tab](미국과 같은 탭 키, 2단계 명세 §4-16): 같은 규칙, 일곱 탭 모두 한국 화면,
 *    selection 키의 이름은 '종목 선정',
 *    프레임·설정은 두 시장 공용 안내와 함께 그대로, 주소 맞추기는 그 시장 주소만
 *
 *  - [tab] 라우트: 여섯 키만 만들고(generateStaticParams), 그 탭을 처음 탭으로 넘긴다 — 모르는 조각·overview는 404(notFound)
 *  - 처음 탭(initialTab)으로 그 탭이 열린다(눌러 보지 않아도) — 7탭 마크업(role=tab·paper-tab-*·aria-controls)은 그대로
 *  - 탭을 누르면 주소만 그 탭의 것으로(history.replaceState — 기록을 쌓지 않음), 계좌 상세의 "보유·체결 탭에서 전체 보기"도 같다
 *  - 셸의 링크로 주소가 바뀌면(라우터의 usePathname) 그 주소의 탭으로 — 미리 고른 계좌는 지움. 라우터가 아직 옛 주소를 들고
 *    있는 동안(탭을 막 바꾼 직후)은 방금 고른 탭을 되돌리지 않는다
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
// 라우터가 들고 있는 주소(usePathname) — 테스트가 바꿉니다. null이면 라우터 밖(다른 모의매매 테스트와 같음).
const router = vi.hoisted(() => ({ pathname: null as string | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => router.pathname,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import PaperKrTabPage, {
  dynamicParams as krDynamicParams,
  generateStaticParams as krStaticParams,
} from "../paper/kr/[tab]/page";
import PaperKrPage from "../paper/kr/page";
import PaperUsTabPage, { dynamicParams, generateStaticParams } from "../paper/us/[tab]/page";
import PaperUsPage from "../paper/us/page";
import PaperScreen from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 200, nav: 100000, equityValue: 99800, exposurePct: 99.8, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌" }),
  book("claude", { kind: "CLAUDE", label: "Claude 계좌" }),
  book("bench_spy", { label: "SPY 계좌" }),
  book("bench_mix", { label: "60/40 계좌" }),
];

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], books: BOOKS, jobs: [], pendingBackfill: [],
  navSeries: { dates: [], books: {} }, quotes: null,
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  router.pathname = null;
  window.history.replaceState(null, "", "/paper/us");
  reads = {
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/paper/books/bench_mix/positions": () => Promise.resolve({ available: true, book: BOOKS[3], cash: 200, lockouts: [], positions: [] }),
    "/api/paper/books/bench_mix/fills": () => Promise.resolve({ available: true, fills: [] }),
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

describe("라우트 파일", () => {
  it("[tab]: 여섯 키만 만들고 그 탭을 처음 탭으로 — 탭마다 다른 화면(key)", async () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual([
      { tab: "selection" }, { tab: "holdings" }, { tab: "decisions" }, { tab: "framework" }, { tab: "notes" }, { tab: "settings" },
    ]);
    const element = await PaperUsTabPage({ params: Promise.resolve({ tab: "holdings" }) });
    expect(isValidElement(element) && element.type).toBe(PaperScreen);
    expect((element.props as { initialTab: string }).initialTab).toBe("holdings");
    expect(element.key).toBe("holdings");
  });

  it("[tab]: 모르는 조각·overview·대소문자가 다른 글자는 404(notFound)", async () => {
    for (const tab of ["overview", "reviews", "Holdings", ""]) {
      await expect(PaperUsTabPage({ params: Promise.resolve({ tab }) }), tab).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("/paper/us: 개요를 처음 탭으로", () => {
    const element = PaperUsPage();
    expect(element.type).toBe(PaperScreen);
    expect((element.props as { initialTab: string }).initialTab).toBe("overview");
  });
});

describe("처음 탭", () => {
  it("initialTab으로 그 탭이 열린다 — 7탭의 이름·순서·마크업은 그대로", async () => {
    window.history.replaceState(null, "", "/paper/us/holdings");
    render(<PaperScreen initialTab="holdings" />);

    const holdings = await screen.findByRole("tab", { name: "보유·체결" });
    expect(holdings.getAttribute("aria-selected")).toBe("true");
    expect(holdings.id).toBe("paper-tab-holdings");
    expect(holdings.getAttribute("aria-controls")).toBe("paper-tabpanel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "개요", "기관 선정", "보유·체결", "결정 로그", "프레임", "메모", "설정",
    ]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("paper-tab-holdings");
    expect(screen.getByLabelText("계좌 고르기")).toBeTruthy();
    // 처음 그릴 때는 주소를 바꾸지 않습니다.
    expect(window.location.pathname).toBe("/paper/us/holdings");
  });
});

describe("탭 → 주소(replaceState)", () => {
  it("탭을 누르면 그 탭의 주소로 바꾸고 기록은 쌓지 않는다 — 개요는 /paper/us", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    render(<PaperScreen />);

    fireEvent.click(await screen.findByRole("tab", { name: "결정 로그" }));
    expect(selectedTab()).toBe("결정 로그");
    expect(window.location.pathname).toBe("/paper/us/decisions");
    expect(replace).toHaveBeenLastCalledWith(null, "", "/paper/us/decisions");

    fireEvent.click(screen.getByRole("tab", { name: "설정" }));
    expect(window.location.pathname).toBe("/paper/us/settings");

    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    expect(window.location.pathname).toBe("/paper/us");
    expect(push).not.toHaveBeenCalled();

    // 이미 그 주소면 다시 부르지 않습니다.
    replace.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("계좌 상세의 '보유·체결 탭에서 전체 보기'도 주소를 그 탭으로 — 미리 고른 계좌와 초점은 그대로", async () => {
    render(<PaperScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /60\/40 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "60/40 계좌 상세" });

    fireEvent.click(within(panel).getByRole("button", { name: "보유·체결 탭에서 전체 보기" }));

    expect(window.location.pathname).toBe("/paper/us/holdings");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "보유·체결" }));
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("bench_mix");
  });
});

describe("주소 → 탭(셸의 링크로 주소가 바뀔 때)", () => {
  it("라우터 주소가 /paper/us로 바뀌면 개요로 — 미리 고른 계좌는 지운다", async () => {
    window.history.replaceState(null, "", "/paper/us/holdings");
    router.pathname = "/paper/us/holdings";
    const view = render(<PaperScreen initialTab="holdings" />);
    expect((await screen.findByRole("tab", { name: "보유·체결" })).getAttribute("aria-selected")).toBe("true");

    // 셸의 '모의매매' 탭(→ /paper/us)을 누른 것과 같은 상황 — 같은 화면이 그대로 남은 채 주소만 바뀝니다.
    window.history.pushState(null, "", "/paper/us");
    router.pathname = "/paper/us";
    view.rerender(<PaperScreen initialTab="holdings" />);
    expect(selectedTab()).toBe("개요");

    window.history.pushState(null, "", "/paper/us/notes");
    router.pathname = "/paper/us/notes";
    view.rerender(<PaperScreen initialTab="holdings" />);
    expect(selectedTab()).toBe("메모");
  });

  it("라우터가 아직 옛 주소를 들고 있는 동안(탭을 막 바꾼 직후)은 방금 고른 탭을 되돌리지 않는다", async () => {
    router.pathname = "/paper/us";
    render(<PaperScreen />);
    fireEvent.click(await screen.findByRole("tab", { name: "프레임" }));
    // 라우터 주소는 아직 /paper/us(개요)지만 브라우저 주소는 /paper/us/framework — 탭은 프레임에 남습니다.
    expect(window.location.pathname).toBe("/paper/us/framework");
    expect(selectedTab()).toBe("프레임");
  });

  it("모의매매(미국) 주소가 아니면(라우터 밖·옛 /paper·/paper/kr) 지금 탭을 그대로 둔다", async () => {
    window.history.replaceState(null, "", "/paper/kr");
    router.pathname = "/paper/kr";
    render(<PaperScreen initialTab="notes" />);
    expect((await screen.findByRole("tab", { name: "메모" })).getAttribute("aria-selected")).toBe("true");
  });
});

const KR_BOOKS = [
  book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_claude", { kind: "CLAUDE", label: "한국 Claude 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_bench_k200", { label: "KODEX 200 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
  book("kr_bench_mix", { label: "한국 60/40 계좌", initialCash: 100_000_000, nav: 100_000_000 }),
];

describe("한국 화면(/paper/kr)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/paper/kr");
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({
      ...OVERVIEW, market: "KR", currency: "KRW", dormantReason: null, startDate: "2026-10-29", books: KR_BOOKS,
    });
  });

  it("라우트 파일: [tab]은 미국과 같은 여섯 키·404 규칙, 개요·탭 모두 한국 화면(market KR)", async () => {
    expect(krDynamicParams).toBe(false);
    expect(krStaticParams()).toEqual(generateStaticParams());
    const element = await PaperKrTabPage({ params: Promise.resolve({ tab: "settings" }) });
    expect(isValidElement(element) && element.type).toBe(PaperScreen);
    expect(element.props as { initialTab: string; market: string }).toMatchObject({ initialTab: "settings", market: "KR" });
    expect(element.key).toBe("settings");
    for (const tab of ["overview", "reviews", "Settings", ""]) {
      await expect(PaperKrTabPage({ params: Promise.resolve({ tab }) }), tab).rejects.toThrow("NEXT_NOT_FOUND");
    }
    const root = PaperKrPage();
    expect(root.type).toBe(PaperScreen);
    expect(root.props as { initialTab: string; market: string }).toMatchObject({ initialTab: "overview", market: "KR" });
  });

  it("탭을 누르면 /paper/kr/<키>로(기록을 쌓지 않음) — 개요는 /paper/kr, 출발일·처음 현금은 머리글에", async () => {
    render(<PaperScreen market="KR" />);
    expect(await screen.findByText(/계좌마다 100,000,000원 · 출발 2026-10-29/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
    expect(window.location.pathname).toBe("/paper/kr/settings");
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    expect(window.location.pathname).toBe("/paper/kr");
  });

  it("일곱 탭 모두 한국 화면(준비 중 없음 — selection 키의 이름은 '종목 선정'), 프레임·설정은 두 시장 공용 안내와 함께", async () => {
    render(<PaperScreen market="KR" initialTab="notes" />);
    const notes = await screen.findByRole("tab", { name: "메모" });
    expect(notes.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "개요", "종목 선정", "보유·체결", "결정 로그", "프레임", "메모", "설정",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "설정" }));
    expect(screen.getByText(/설정은 두 시장이 한 행\(한 버전\)을 함께 씁니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "프레임" }));
    expect(screen.getByText(/두 시장 공용 프레임 — 미국·한국 Claude 계좌가 같은 판을 씁니다/)).toBeTruthy();
  });

  it("주소 맞추기는 그 시장 주소만 — 한국 화면에서 /paper/kr/notes는 메모로, /paper/us/…는 무시", async () => {
    window.history.replaceState(null, "", "/paper/kr/settings");
    router.pathname = "/paper/kr/settings";
    const view = render(<PaperScreen market="KR" initialTab="settings" />);
    expect((await screen.findByRole("tab", { name: "설정" })).getAttribute("aria-selected")).toBe("true");

    window.history.pushState(null, "", "/paper/kr/notes");
    router.pathname = "/paper/kr/notes";
    view.rerender(<PaperScreen market="KR" initialTab="settings" />);
    expect(selectedTab()).toBe("메모");

    window.history.pushState(null, "", "/paper/us/holdings");
    router.pathname = "/paper/us/holdings";
    view.rerender(<PaperScreen market="KR" initialTab="settings" />);
    expect(selectedTab()).toBe("메모");
  });
});
