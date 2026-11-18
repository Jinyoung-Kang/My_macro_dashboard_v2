/**
 * 공통 보유(/consensus)·스타일(/style)·스코어카드(/scorecard) 화면 시험 — 공유 시험 파일에서 앞의 두 화면 사례만 옮겨 왔습니다(P5b 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - tinyWeightQa454.test.tsx: "13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)"의 '공통 보유 — 교집합·공통 신규 매수의 평균·최대 비중'·
 *    '스타일 화면 — 이 종목을 누가 들고 있나'
 * 모의·합성 응답·도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다(이 사례들이 쓰는 것만). P5b 두 화면 갈래(13F 포트폴리오 · 교집합·스타일·스코어카드)가
 * 화면을 바꿀 때 서로의 시험 파일을 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { GuruHoldersResponse } from "@/lib/types";
import ConsensusPage from "../consensus/page";
import GuruPage from "../style/page";

const TINY = "<0.01%";
const ZERO = "0.00%";

const QUERY = "SYNTHETIC TINY HOLDINGS";

let reportDate = "";
let reads: Record<string, unknown> = {};

/** 보유 줄 둘 — 큰 기관이 아주 작게 든 줄(0.0032%)과 보통 줄(1.25%). */
function holders(): GuruHoldersResponse {
  return {
    available: true, query: QUERY, totalMatches: 2, truncated: false,
    rows: [
      { institution: "합성 자산운용", cik: "0000000011", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 1.25, value: 50_000_000, reportDate },
      { institution: "가상 연기금", cik: "0000000012", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 0.0032, value: 320_000_000, reportDate },
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
  it("공통 보유 — 교집합·공통 신규 매수의 평균·최대 비중", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [reportDate], reportDate: null, minHolders: 2,
          rows: [{ key: "cusip:000000201", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", holders: ["가상 연기금"], actions: [], holderCount: 2,
            totalValue: 320_000_000, avgWeight: 0.003, maxWeight: 0.004, buyCount: 0, sellCount: 0 }],
        });
      }
      if (path.startsWith("/api/sec13f/new-buys")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], minHolders: 3, note: "13F는 분기 공시입니다.",
          rows: [{ key: "cusip:000000202", name: "SYNTHETIC NEW CO", cusip: "000000202", buyers: ["가상 연기금"], buyerCount: 3,
            totalValue: 100, avgWeight: 0.002, reportDate }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const both = (await screen.findByText("SYNTHETIC TINY HOLDINGS")).closest("table") as HTMLElement;
    expect(within(both).getAllByText(TINY)).toHaveLength(2);
    expect(within(both).queryByText(ZERO)).toBeNull();
    const fresh = (await screen.findByText("SYNTHETIC NEW CO")).closest("table") as HTMLElement;
    expectTiny(fresh);
  });

  it("스타일 화면 — 이 종목을 누가 들고 있나", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/holders") ? Promise.resolve(holders()) : new Promise(() => {}));
    render(<GuruPage />);
    fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: QUERY } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    await waitFor(() => expect(within(card).getByText("1.25%")).toBeTruthy());
    expectTiny(card);
  });
});
