/**
 * 지표 상세 — '같은 범주' 목록은 가운데 '개요' 탭의 AI 요약 아래, 오른쪽 칸은 연결·다른 곳에서 보기·출처만(2026-11-16 결정 6). 응답은 모두 합성 값입니다.
 *
 * 오른쪽 18rem 칸에서는 같은 범주 행이 값이 이름 아래로 내려가고 출처 줄이 2~4줄로 접혀 행마다 146~170px로 쌓였고, 오른쪽 칸이 가운데 칸의 약 2.5배가
 * 되어 연결·출처가 첫 화면 밖으로 밀렸습니다(코스피 1440 오른쪽 1,593px 대 가운데 629px). 종목·기관 상세의 오른쪽 칸과 같은 구성으로 맞춥니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "../IndicatorDetailScreen";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };
const SAME = "미국 주가지수 및 선물 — 같은 범주";

beforeEach(() => {
  const reads: Record<string, unknown> = { [endpoints.macro.overview(false)]: macroOverview(), "/api/calendar/kr-holidays": { available: true, years: {} } };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

async function renderSp500() {
  render(
    <SessionUserProvider user={PRO}>
      <IndicatorDetailScreen indicatorKey="sp500" />
    </SessionUserProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "S&P 500" });
}

/** 제목(h2)이 `name`인 패널(section). */
const panel = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;

describe("지표 상세 — 같은 범주 목록의 자리(결정 6)", () => {
  it("같은 범주 목록은 '개요' 탭 안 AI 요약 아래에 있고 링크는 그대로다", async () => {
    await renderSp500();
    const overview = screen.getByRole("tabpanel", { name: "개요" });
    const same = panel(SAME);
    expect(overview.contains(same)).toBe(true);
    // 차례: 가격 차트 패널 → AI 요약 → 같은 범주
    const summary = within(overview).getByRole("heading", { level: 2, name: "AI 요약" }).closest("section") as HTMLElement;
    expect(summary.compareDocumentPosition(same) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(same).getByRole("link", { name: /S&P 500 선물 \(ES\)/ }).getAttribute("href")).toBe("/markets/i/sp500_fut");
  });

  it("오른쪽 칸은 연결 · 다른 곳에서 보기 · 출처만(같은 범주 없음)", async () => {
    await renderSp500();
    const right = panel("연결").parentElement as HTMLElement;
    const titles = [...right.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(titles).toEqual(["연결", "다른 곳에서 보기", "출처"]);
    expect(right.contains(panel(SAME))).toBe(false);
  });

  it("뉴스 탭을 고르면 같은 범주 목록도 숨는다(개요 탭에 속함)", async () => {
    await renderSp500();
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    expect(screen.queryByRole("heading", { level: 2, name: SAME })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    expect(screen.getByRole("heading", { level: 2, name: SAME })).toBeTruthy();
  });
});
