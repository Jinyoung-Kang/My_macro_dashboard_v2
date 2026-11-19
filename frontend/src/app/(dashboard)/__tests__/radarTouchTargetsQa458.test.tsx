/**
 * 좁은 화면(lg 미만) 누르는 자리 44px — 운영 화면 조사(2026-11-15, 390px에서 요소 높이를 잼)가 짚은 곳(QA-458) 가운데 수급 레이더 몫. 응답은 모두 합성 값입니다.
 *
 * 조사에서 44px 미만이던 누름 자리: 수급 레이더 재무 표의 '원문'(20개 — 조사 측정 40px, 코드는 클래스 min-h-6 = 24px). 그린 DOM의 누름 자리마다
 * 클래스로 lg 미만 44px을 따집니다(lib/__tests__/touchTargetAudit — 문장 안의 링크는 WCAG 2.5.8 글 안 예외로 셈에서 뺌).
 *
 * 이 사례는 app/(dashboard)/__tests__/touchTargetsQa458.test.tsx에서 글자 그대로 옮겼습니다(작업대 화면 언어 P7 — 수급 레이더 화면을 고치는
 * 갈래가 이 파일만 고치게). 정보 수집 몫은 components/screens/info/__tests__/infoTouchTargetsQa458.test.tsx에 있습니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다(누름 자리는 차트 밖에 있음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  HorizontalBars: () => null,
  SignedBars: () => null,
  WeightHeatmap: () => null,
  ScatterPlot: () => null,
  DonutChart: () => null,
  LineSeries: () => null,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import type { SessionUser } from "@/lib/types";
import RadarPage from "../radar/page";

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };

/** 경로 앞부분 → 응답. 긴 앞부분부터 맞추고, 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(reads[key]);
  });
});
afterEach(() => cleanup());

const renderAs = (page: ReactElement) => render(<SessionUserProvider user={PRO}>{page}</SessionUserProvider>);

describe("좁은 화면 누르는 자리 44px — 조사가 짚은 화면(QA-458): 수급 레이더", () => {
  // 수정 전에는 아래 누름 자리가 걸렸다(재현 커밋에서는 it.fails). 지금은 레이더 '원문'이 min-h-11과 lg 변형.
  //  - 수급 레이더 재무 표: '원문'(클래스 min-h-6 = 24px, 조사 측정 40px)
  it("수급 레이더 재무 표 — '원문'", async () => {
    reads = {
      "/api/radar/ranking": {
        available: true, market: "KOSPI", investor: "외국인", tradeType: "순매수", readMode: "auto", source: "합성 순위", sourceKind: "krx",
        isHistorical: false, historyDate: null, intervalType: "TODAY", dataDate: "2026-11-14",
        rows: [{ rank: 1, code: "000001", name: "합성전자", price: 1000, changePct: 1.2, netAmountEok: 10 }],
      },
      [endpoints.publicData.fundamentals("000001")]: {
        available: true, priceDate: "2026-11-14", companies: [
          { code: "000001", available: true, name: "합성전자", bsnsYear: "2025", fsLabel: "연결", dartUrl: "https://dart.example/1", debtRatio: 50,
            roe: 10, operatingMargin: 5, revenueGrowth: 3, operatingIncomeGrowth: 4, marketCap: 1e12, per: 10, pbr: 1 },
        ],
      },
    };
    renderAs(<RadarPage />);
    const link = await screen.findByRole("link", { name: "원문" });
    const card = link.closest("section") as HTMLElement;
    expect(smallTargets(card)).toEqual([]);
  });
});
