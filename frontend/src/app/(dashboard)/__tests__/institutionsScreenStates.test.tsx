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

// ------------------------------------------------------------------ 보유 표 칸 — 비중 변화(QA-696)

/** 보유 표에서 이름이 `name`인 줄의 `header` 열 칸 — 머리 글로 열 자리를 찾습니다(열이 늘어도 같은 칸). */
function holdingCell(name: string, header: string): HTMLElement {
  const row = screen.getByText(name).closest("tr") as HTMLElement;
  const table = row.closest("table") as HTMLElement;
  const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
  const at = headers.findIndex((text) => text.trim() === header);
  expect(at).toBeGreaterThanOrEqual(0);
  return row.children[at] as HTMLElement;
}

function changePortfolio(): PortfolioResponse {
  return {
    available: true, cik: CIK,
    quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1000, holdingCount: 3 }],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1000 },
    holdings: [
      { name: "SYNTHETIC RISE CO", cusip: "000000401", class: "COM", value: 500, shares: 50, weight: 50, weightDiff: 1.5, sharesDiff: 5, action: "비중 확대 (Added)" },
      { name: "SYNTHETIC FALL CO", cusip: "000000402", class: "COM", value: 300, shares: 30, weight: 30, weightDiff: -0.29, sharesDiff: -3, action: "비중 축소 (Reduced)" },
      { name: "SYNTHETIC FIRST CO", cusip: "000000403", class: "COM", value: 200, shares: 20, weight: 20, weightDiff: null, sharesDiff: null, action: "신규 매수 (New)" },
    ],
  };
}

describe("보유 표 '비중 변화' — 색만으로 방향을 전하지 않는다(QA-696)", () => {
  // 수정 전(plain it으로 잼): 칸이 deltaColor 글자색과 숫자 글만으로 방향을 나름 — 내린 칸 <span class="text-down">-0.29%p</span>(ASCII '-'),
  // 오른 칸 <span class="text-up">1.50%p</span>('+' 없음), 둘 다 ▲▼·sr 방향 글 없음. 모르는 칸은 '—'(text-text-3)로 이미 맞음.
  it.fails("내린 값은 ▼·U+2212·sr '하락', 오른 값은 ▲·'+'·sr '상승', 모르면 '—'", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(changePortfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC FALL CO");

    const fall = holdingCell("SYNTHETIC FALL CO", "비중 변화");
    expect(fall.textContent).toContain("\u22120.29");
    expect(fall.textContent).not.toContain("-0.29");
    expect(fall.textContent).toContain("%p");
    expect(within(fall).getByText("▼").getAttribute("aria-hidden")).toBe("true");
    expect(within(fall).getByText("하락").className).toContain("sr-only");

    const rise = holdingCell("SYNTHETIC RISE CO", "비중 변화");
    expect(rise.textContent).toContain("+1.50");
    expect(within(rise).getByText("▲").getAttribute("aria-hidden")).toBe("true");
    expect(within(rise).getByText("상승").className).toContain("sr-only");

    const unknown = holdingCell("SYNTHETIC FIRST CO", "비중 변화");
    expect(unknown.textContent).toBe("—");
    expect(unknown.querySelector(".text-up, .text-down")).toBeNull();
  });
});
