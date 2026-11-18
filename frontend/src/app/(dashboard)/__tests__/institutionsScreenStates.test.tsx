/**
 * 13F 포트폴리오(/institutions) 화면 시험 — 공유 시험 파일에서 이 화면 사례만 옮겨 왔습니다(P5b 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - tinyWeightQa454.test.tsx: "13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)"의 '13F 포트폴리오 화면 — 보유 종목 표'
 * 모의·합성 응답·도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다(이 사례가 쓰는 것만). P5b 두 화면 갈래(13F 포트폴리오 · 교집합·스타일·스코어카드)가
 * 화면을 바꿀 때 서로의 시험 파일을 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다(비중 글은 표·목록에 있음).
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
  HorizontalBars: () => null,
}));

import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { PortfolioResponse } from "@/lib/types";
import InstitutionsPage from "../institutions/page";

const TINY = "<0.01%";
const ZERO = "0.00%";

const CIK = "0009999998";

let reportDate = "";
let reads: Record<string, unknown> = {};

function portfolio(): PortfolioResponse {
  return {
    available: true, cik: CIK,
    institution: { name: "🇺🇸 가상 대형운용 (Fictional Mega Advisors)", desc: "" },
    quarters: [{ filingDate: "2026-08-14", reportDate, totalValue: 10_000_000_000_000, holdingCount: 2 }],
    latest: { reportDate, filingDate: "2026-08-14", totalValue: 10_000_000_000_000 },
    holdings: [
      { name: "SYNTHETIC LARGE CO", cusip: "000000301", class: "COM", value: 9_999_680_000_000, shares: 1_000, weight: 99.9968, weightDiff: null, sharesDiff: null, action: "유지" },
      { name: "SYNTHETIC SMALL CO", cusip: "000000302", class: "COM", value: 320_000_000, shares: 10, weight: 0.0032, weightDiff: null, sharesDiff: null, action: "신규" },
    ],
  };
}

beforeEach(() => {
  reportDate = rangeStart("30d", kstToday(Date.now()));
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

/** root 안에 아주 작은 비중이 '<0.01%'로 보이고 '0.00%'는 없는지. */
function expectTiny(root: HTMLElement) {
  expect(within(root).queryByText(ZERO)).toBeNull();
  expect(within(root).getAllByText(TINY).length).toBeGreaterThan(0);
}

describe("13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)", () => {
  it("13F 포트폴리오 화면 — 보유 종목 표", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(portfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    const cell = await screen.findByText("SYNTHETIC SMALL CO");
    const table = cell.closest("table") as HTMLElement;
    expectTiny(table);
  });
});
