/**
 * 교집합·공통 신규 매수가 CUSIP으로 갈라진 같은 이름의 행을 서로 구분해 보인다(QA-114).
 *
 * 백엔드는 공시 이름이 아니라 증권(CUSIP)으로 묶고(QA-083), 표시 이름은 겹칠 수 있습니다 — 클래스를 보통주 계열로 적은
 * 기관이 하나도 없어('CAPSTKCLA'만) ALPHABET A·C주가 두 행으로 남은 경우(QA-121), 'ISHARES TR' 한 이름 아래 서로 다른 ETF. 화면이
 * 이름만 그리면 같은 이름표에 다른 숫자가 붙어 어느 증권의 값인지 읽을 수 없습니다.
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
// jsdom에서는 차트 크기가 0이라 recharts가 이름표를 그리지 않습니다 — 막대 이름표만 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  HorizontalBars: ({ data }: { data: { name: string; value: number }[] }) => (
    <ul aria-label="막대 이름표">
      {data.map((bar, index) => <li key={index}>{bar.name}</li>)}
    </ul>
  ),
}));

import ConsensusPage from "../consensus/page";

afterEach(() => cleanup());

const row = (key: string, name: string, cusip: string, holderCount: number) => ({
  key, name, cusip, holders: ["국민연금"], actions: [], holderCount,
  totalValue: 1000, avgWeight: 1.0, maxWeight: 2.0, buyCount: 0, sellCount: 0,
});

function answer() {
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/sec13f/consensus")) {
      return Promise.resolve({
        available: true, participants: ["국민연금"], participantCount: 1, availableDates: ["2024-09-30"],
        reportDate: null, minHolders: 2,
        rows: [
          row("cusip:02079K305", "ALPHABET INC", "02079K305", 6),
          row("cusip:02079K107", "ALPHABET INC", "02079K107", 5),
          row("issuer:084670", "BERKSHIRE HATHAWAY INC DEL", "084670702", 4),
        ],
      });
    }
    if (path.startsWith("/api/sec13f/new-buys")) {
      return Promise.resolve({
        available: true, participants: ["국민연금"], participantCount: 1, availableDates: [], minHolders: 3,
        note: "13F는 분기 공시입니다.",
        rows: [
          { key: "cusip:464287200", name: "ISHARES TR", cusip: "464287200", buyers: ["국민연금"], buyerCount: 3,
            totalValue: 100, avgWeight: 1.0, reportDate: "2024-09-30" },
          { key: "cusip:464287655", name: "ISHARES TR", cusip: "464287655", buyers: ["국민연금"], buyerCount: 3,
            totalValue: 90, avgWeight: 0.5, reportDate: "2024-09-30" },
        ],
      });
    }
    return new Promise(() => {});
  });
}

describe("QA-114 같은 이름의 다른 증권", () => {
  // 수정 전에는 '종목' 칸이 row.name만 그려 두 'ALPHABET INC' 행·두 'ISHARES TR' 행을 가를 수 없었다.
  it("교집합·공통 신규 매수 표가 이름 아래 CUSIP(합친 행은 발행사)을 함께 적는다", async () => {
    answer();
    render(<ConsensusPage />);
    await screen.findAllByText("ALPHABET INC");
    await screen.findAllByText("ISHARES TR");

    expect(screen.getByText("CUSIP 02079K305")).toBeTruthy();
    expect(screen.getByText("CUSIP 02079K107")).toBeTruthy();
    expect(screen.getByText("발행사 084670 · 보통주 합산")).toBeTruthy();
    expect(screen.getByText("CUSIP 464287200")).toBeTruthy();
    expect(screen.getByText("CUSIP 464287655")).toBeTruthy();
  });

  // 수정 전에는 막대 이름표도 row.name이라 같은 이름표 두 개가 서로 다른 막대에 붙었다.
  it("'공통 보유 상위 종목' 막대는 이름이 겹치는 행에만 구분자를 붙인다", async () => {
    answer();
    render(<ConsensusPage />);
    const bars = await screen.findByRole("list", { name: "막대 이름표" });
    const labels = within(bars).getAllByRole("listitem").map((item) => item.textContent ?? "");

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toContain("02079K305");
    expect(labels[1]).toContain("02079K107");
    expect(labels[2]).toBe("BERKSHIRE HATHAW…");   // 겹치지 않는 이름은 예전처럼 16자에서 자른다
  });
});

describe("QA-122 합친 클래스가 없는 보통주 행", () => {
  // 백엔드가 실제로 클래스를 합친 행에만 issuer: 키를 줄 때, 화면은 그 행에만 '보통주 합산'을 적고 나머지는 CUSIP을 적는다.
  it("클래스가 하나뿐인 APPLE은 'CUSIP 037833100', A·C를 합친 ALPHABET만 '발행사 … · 보통주 합산'", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["국민연금"], participantCount: 1, availableDates: ["2026-06-30"],
          reportDate: null, minHolders: 2,
          rows: [
            row("cusip:037833100", "APPLE INC", "037833100", 7),
            row("issuer:02079K", "ALPHABET INC", "02079K305", 6),
          ],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    await screen.findAllByText("APPLE INC");

    expect(screen.getByText("CUSIP 037833100")).toBeTruthy();
    expect(screen.queryByText("발행사 037833 · 보통주 합산")).toBeNull();
    expect(screen.getByText("발행사 02079K · 보통주 합산")).toBeTruthy();
  });
});

describe("기관 이름의 국기", () => {
  // 예전에는 보유 기관 배지가 이름의 첫 낱말이라 국기가 붙은 이름에서는 국기만 남았다.
  it("기관 고르기·보유 기관 배지·참여 기관 줄은 국기를 뗀 이름 — 배지는 짧은 이름, 전체 이름은 마우스 설명", async () => {
    const flagged = "🇰🇷 국민연금 (National Pension Service)";
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) {
        return Promise.resolve({ institutions: [{ key: "nps", name: flagged, cik: "0001608046", desc: "" }] });
      }
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: [flagged], participantCount: 1, availableDates: ["2026-06-30"],
          reportDate: null, minHolders: 1,
          rows: [{ ...row("cusip:037833100", "APPLE INC", "037833100", 1), holders: [flagged] }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);

    expect(await screen.findByRole("button", { name: "국민연금 (National Pension Service)" })).toBeTruthy();
    const badge = await screen.findByText("국민연금");
    expect(badge.closest("[title]")?.getAttribute("title")).toBe("국민연금 (National Pension Service)");
    expect(screen.getByText("참여 기관: 국민연금 (National Pension Service)")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\p{Regional_Indicator}/u);
  });
});
