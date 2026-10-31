/**
 * 기관 화면의 '상위 종목 분기별 비중 추이 (선)'이 이름이 같은 서로 다른 줄을 서로 다른 이름표로 그린다(QA-120).
 *
 * 백엔드는 비중 추이를 증권 단위로 가르고(QA-112), 이름이 겹치는 줄의 series 키 뒤에 구분자(' · 클래스' 또는
 * ' · CUSIP …')를 붙입니다. 선 차트의 범례·툴팁은 그 키를 줄인 이름표를 씁니다. 이름표가 같아지면 같은 이름 아래
 * 다른 숫자 두 개가 보여 어느 선이 어느 증권인지 색으로만 짐작해야 합니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트 크기가 0이라 recharts가 범례를 그리지 않습니다 — 선 이름표(범례·툴팁에 쓰는 name)만 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  MultiLineSeries: ({ series }: { series: { key: string; name: string }[] }) => (
    <ul aria-label="선 이름표">
      {series.map((entry) => <li key={entry.key} data-key={entry.key}>{entry.name}</li>)}
    </ul>
  ),
  WeightHeatmap: () => null,
}));

import InstitutionsPage from "../institutions/page";

afterEach(() => cleanup());

/** 백엔드 lineLabels가 내려 주는 모양 그대로 — 커밋 테스트의 키와 국민연금 실데이터(백업)의 ALPHABET 키. */
const KEYS = [
  "WELLS FARGO & CO · COM",
  "WELLS FARGO & CO · PERP PFD CNV A",
  "ISHARES TR · CUSIP 464287200",
  "ISHARES TR · CUSIP 464287655",
  "ALPHABET INC · CAP STK CL A/ALPHABET INC/CAPSTKCLA",
  "ALPHABET INC · CAP STK CL C/ALPHABET INC/CAPSTKCLC",
];

function answer() {
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/sec13f/institutions")) {
      return Promise.resolve({ institutions: [{ key: "nps", name: "국민연금", cik: "0001067983", desc: "" }] });
    }
    if (path.startsWith("/api/sec13f/portfolio")) {
      return Promise.resolve({
        available: true, cik: "0001067983",
        quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 100, holdingCount: 6 }],
        latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 100 },
        holdings: [
          { name: "APPLE INC", cusip: "037833100", class: "COM", value: 60, weight: 60, shares: 100, action: "📉 비중 축소 (Reduced)" },
          { name: "NVIDIA CORP", cusip: "67066G104", class: "COM", value: 40, weight: 40, shares: 50, action: "신규 매수 (New)" },
        ],
        weightHistory: {
          dates: ["2026-03-31", "2026-06-30"],
          series: Object.fromEntries(KEYS.map((key, index) => [key, [index + 1, index + 2]])),
        },
      });
    }
    return new Promise(() => {});
  });
}

describe("QA-120 비중 추이 선 이름표", () => {
  // 수정 전에는 키를 앞 18자에서 잘라(`name.slice(0, 18) + '…'`) 구분자가 통째로 사라졌다 —
  // 'WELLS FARGO & CO ·…', 'ISHARES TR · CUSIP…', 'ALPHABET INC · CAP…'가 두 번씩 나왔다.
  it("이름이 같은 줄들의 이름표가 서로 다르고, 구분자(클래스·CUSIP)가 이름표에 남는다", async () => {
    answer();
    render(<InstitutionsPage />);
    const list = await screen.findByRole("list", { name: "선 이름표" });
    const items = within(list).getAllByRole("listitem");
    const labelOf = (key: string) => items.find((item) => item.dataset.key === key)?.textContent ?? "";
    const labels = items.map((item) => item.textContent ?? "");

    expect(labels).toHaveLength(KEYS.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labelOf("WELLS FARGO & CO · COM")).toMatch(/ · COM$/);
    expect(labelOf("WELLS FARGO & CO · PERP PFD CNV A")).toMatch(/ · PERP PFD CNV A$/);
    expect(labelOf("ISHARES TR · CUSIP 464287200")).toContain("464287200");
    expect(labelOf("ISHARES TR · CUSIP 464287655")).toContain("464287655");
  });
});

describe("직전 분기 대비 변화 배지", () => {
  it("글(신규 매수·비중 축소)이 뜻을 나르고 앞의 그림 문자는 장식 아이콘으로 — 상승·하락 색은 쓰지 않는다", async () => {
    answer();
    render(<InstitutionsPage />);

    const reduced = await screen.findByText("비중 축소 (Reduced)");
    expect(screen.getByText("신규 매수 (New)")).toBeTruthy();
    expect(reduced.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const row = reduced.closest("tr") as HTMLElement;
    expect(row.querySelector(".text-up, .text-down")).toBeNull();
    expect(row.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
