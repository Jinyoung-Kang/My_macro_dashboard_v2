/**
 * 기관 상세(/institutions/<CIK>) — 기관 이름을 받기 전의 주요 뉴스·AI 요약(QA-453). 응답은 모두 합성 값입니다(가상 기관 이름·CIK).
 *
 * 기관 이름은 13F 포트폴리오 응답(GET /api/sec13f/portfolio의 institution.name)에만 있습니다. 화면이 그 응답 전에 자리표시 이름('CIK …')으로
 * 뉴스(GET /api/detail/news?q=)를 부르면 쓸모없는 검색이 한 번 더 나가고, 그 사이 AI 요약을 누르면 요약 대상(q)도 'CIK …'가 됩니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { PortfolioResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };
const CIK = "0009999999";
const PORTFOLIO = endpoints.institution.portfolio(CIK, 8, 30);
const ENGLISH = "Fictional Asset Partners";

const BODY: PortfolioResponse = {
  available: true,
  cik: CIK,
  institution: { name: `🇺🇸 가상 자산운용 (${ENGLISH})`, desc: "합성 기관 소개" },
  collectedAtKst: "2026-11-15 09:00 KST",
  ageSeconds: 60,
  quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1_000_000_000, holdingCount: 1 }],
  latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1_000_000_000 },
  holdings: [{ name: "SYNTHETIC CO", cusip: "000000001", class: "COM", value: 1_000_000_000, shares: 1_000, weight: 100, weightDiff: null, sharesDiff: null, action: "유지" }],
};

const NEWS = {
  available: true,
  news: {
    items: [{ title: "합성 기사 — 가상 자산운용 분기 보고", url: "https://news.example/fap-1", publisher: "Example Wire", publishedAt: "2026-11-14T20:00:00+00:00", source: "Google News" }],
    errors: {}, error: null, fetchedAt: "2026-11-15T00:00:00+00:00",
  },
};

let portfolio: { resolve: (body: unknown) => void; reject: (error: Error) => void } | null = null;

const newsQueries = () =>
  api.apiGetShared.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.startsWith("/api/detail/news"))
    .map((path) => new URL(path, "http://test.local").searchParams.get("q"));

beforeEach(() => {
  portfolio = null;
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === PORTFOLIO) return new Promise((resolve, reject) => (portfolio = { resolve, reject }));
    if (path.startsWith("/api/detail/news")) return Promise.resolve(NEWS);
    return new Promise(() => {});
  });
  api.apiPost.mockResolvedValue({ status: true, summary: "한 줄 요약: 합성 요약", model: "test", generatedAtKst: null, cached: false, sources: [], quota: null, error: null });
});
afterEach(cleanup);

function renderScreen() {
  return render(
    <SessionUserProvider user={PRO}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
}

const summarySection = () => screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
const summaryButton = () => within(summarySection()).getByRole("button") as HTMLButtonElement;

describe("기관 상세 — 이름을 받기 전에는 뉴스·AI 요약을 부르지 않는다(QA-453)", () => {
  // QA-453: 화면이 institutionNames(data?.institution?.name ?? `CIK ${cik}`)로 이름을 만들어, 포트폴리오가 오기 전에 GET /api/detail/news?q=CIK …를
  // 한 번 부르고 이름을 받은 뒤 다시 불렀습니다. 그 사이 AI 요약 단추도 눌리고 q가 'CIK …'였습니다.
  // 수정 전 실패: 포트폴리오를 기다리는 동안 뉴스 요청의 q가 'CIK 0009999999'이고 AI 요약 단추가 눌림(재현 커밋에서는 it.fails).
  it("포트폴리오를 기다리는 동안 뉴스를 부르지 않고 요약 단추는 잠김 — 이름을 받으면 영문 이름으로 한 번", async () => {
    renderScreen();
    // 제목은 이름을 받기 전까지 자리표시('CIK …')로 둡니다.
    expect(await screen.findByRole("heading", { level: 1, name: `CIK ${CIK}` })).toBeTruthy();
    await act(async () => {});
    expect(newsQueries()).toEqual([]);
    expect(summaryButton().disabled).toBe(true);
    // 잠긴 단추를 누르라는 글을 적지 않습니다(검토 지적) — 이름을 받으면 그때 안내가 바뀝니다.
    expect(within(summarySection()).getByText("요약할 대상을 불러오는 중입니다.")).toBeTruthy();
    expect(within(summarySection()).queryByText(/단추를 누르면 요약합니다/)).toBeNull();

    await act(async () => portfolio?.resolve(BODY));
    expect(await screen.findByRole("heading", { level: 1, name: `가상 자산운용 (${ENGLISH})` })).toBeTruthy();
    await waitFor(() => expect(newsQueries()).toEqual([ENGLISH]));
    // 뉴스는 가운데 '뉴스' 탭(대상 문법 — P4) — 요청은 탭과 상관없이 이름을 받은 뒤 한 번, 기사는 탭을 열면 보입니다.
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    expect(await screen.findByRole("link", { name: /합성 기사/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));

    expect(summaryButton().disabled).toBe(false);
    expect(within(summarySection()).getByText(/단추를 누르면 요약합니다/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(summaryButton());
    });
    expect(api.apiPost).toHaveBeenCalledWith("/api/detail/summary", { q: ENGLISH, label: `가상 자산운용 (${ENGLISH})` });
  });

  // 수정 전 실패: 포트폴리오를 읽지 못해도 'CIK 0009999999'로 뉴스를 불렀음(재현 커밋에서는 it.fails).
  it("포트폴리오를 읽지 못해 이름을 모르면 뉴스·요약을 부르지 않고 그 까닭을 적는다", async () => {
    renderScreen();
    await act(async () => portfolio?.reject(new Error("13F 저장본을 읽지 못했습니다.")));
    await waitFor(() => expect(screen.getAllByText("13F 저장본을 읽지 못했습니다.").length).toBeGreaterThan(0));
    expect(newsQueries()).toEqual([]);

    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    const news = screen.getByRole("heading", { name: "주요 뉴스" }).closest("section") as HTMLElement;
    expect(within(news).queryByRole("status", { name: "뉴스를 불러오는 중" })).toBeNull();
    expect(within(news).getByText("기관 이름을 받지 못해 뉴스를 찾지 않습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));

    expect(summaryButton().disabled).toBe(true);
    expect(within(summarySection()).getByText("기관 이름을 받지 못해 요약하지 않습니다.")).toBeTruthy();
  });
});
