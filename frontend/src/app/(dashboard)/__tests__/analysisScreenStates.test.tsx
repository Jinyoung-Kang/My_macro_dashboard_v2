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

describe("교집합 — 동시 매수·매도·새로 담은 기관 수는 개수라 등락색이 아니다(QA-703)", () => {
  // 수정 전 실패: 동시 매수 칸 'text-up'(빨강)·동시 매도 칸 'text-down'(파랑)·새로 담은 기관 칸 'text-up' — 개수(기관 몇 곳)가 오르내린 값처럼 칠해짐.
  it("교집합 표·공통 신규 매수 표의 개수 칸에 상승·하락 글자색이 없고, 개수 글은 그대로 보인다", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [reportDate], reportDate: null, minHolders: 2,
          rows: [{ key: "cusip:000000301", name: "SYNTHETIC COUNT CO", cusip: "000000301", holders: ["가상 연기금"], actions: [], holderCount: 3,
            totalValue: 1_000_000, avgWeight: 1.5, maxWeight: 2.5, buyCount: 2, sellCount: 1 }],
        });
      }
      if (path.startsWith("/api/sec13f/new-buys")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], minHolders: 3, note: "13F는 분기 공시입니다.",
          rows: [{ key: "cusip:000000302", name: "SYNTHETIC FRESH CO", cusip: "000000302", buyers: ["가상 연기금"], buyerCount: 3,
            totalValue: 100, avgWeight: 0.5, reportDate }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const both = (await screen.findByText("SYNTHETIC COUNT CO")).closest("table") as HTMLElement;
    const fresh = (await screen.findByText("SYNTHETIC FRESH CO")).closest("table") as HTMLElement;
    const tinted = [...both.querySelectorAll(".text-up, .text-down"), ...fresh.querySelectorAll(".text-up, .text-down")].map(
      (element) => `${element.className} '${element.textContent}'`,
    );
    expect(tinted).toEqual([]);
    expect(within(both).getByText("2")).toBeTruthy();
    expect(within(both).getByText("1")).toBeTruthy();
    expect(within(fresh).getByText("3곳")).toBeTruthy();
  });
});

describe("교집합 — 네 상태(읽는 중·오류·저장본 없음·모르는 값)", () => {
  const consensusOnly = (answer: () => Promise<unknown>) =>
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/sec13f/consensus") ? answer() : new Promise(() => {})));

  it("읽는 중이면 교집합 요약 자리에 같은 세 타일의 자리표시, 조건 고르기는 그대로", async () => {
    consensusOnly(() => new Promise(() => {}));
    render(<ConsensusPage />);
    const strip = await screen.findByRole("region", { name: "교집합 요약" });
    expect(within(strip).getAllByRole("status").map((status) => status.getAttribute("aria-label"))).toEqual([
      "참여 기관 불러오는 중",
      "교집합 종목 불러오는 중",
      "교집합 기준 분기 불러오는 중",
    ]);
    expect(screen.getByLabelText("기준 분기")).toBeTruthy();
    expect(screen.getByLabelText("최소 공통 보유 기관 수")).toBeTruthy();
  });

  it("읽지 못하면 오류와 '다시 시도' — 누르면 교집합을 한 번 더 읽는다", async () => {
    consensusOnly(() => Promise.reject(new Error("교집합을 읽지 못했습니다.")));
    render(<ConsensusPage />);
    expect(await screen.findByText("교집합을 읽지 못했습니다.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "교집합 요약" })).toBeNull();
    const before = api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/consensus")).length;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/consensus")).length).toBe(before + 1));
  });

  it("조건을 만족하는 종목이 없으면(저장본 없음) 그 안내만 — 요약 띠·표는 없다", async () => {
    consensusOnly(() => Promise.resolve({ available: false, participants: [], participantCount: 0, availableDates: [], reportDate: null, minHolders: 2, rows: [] }));
    render(<ConsensusPage />);
    expect(await screen.findByText(/조건을 만족하는 공통 보유 종목이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "교집합 요약" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("모르는 비중·평가액은 '—'(0으로 채우지 않음), 요약 띠는 값", async () => {
    consensusOnly(() => Promise.resolve({
      available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], reportDate: "2026-06-30", minHolders: 2,
      rows: [{ key: "cusip:000000401", name: "SYNTHETIC UNKNOWN CO", cusip: "000000401", holders: ["가상 연기금"], actions: [], holderCount: 2,
        totalValue: null, avgWeight: null, maxWeight: null, buyCount: 0, sellCount: 0 }],
    }));
    render(<ConsensusPage />);
    const table = (await screen.findByText("SYNTHETIC UNKNOWN CO")).closest("table") as HTMLElement;
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(within(table).queryByText("0.00%")).toBeNull();
    const strip = screen.getByRole("region", { name: "교집합 요약" });
    expect(within(strip).getByRole("group", { name: "교집합 기준 분기" }).textContent).toContain("2026-06-30");
    expect(within(strip).getByRole("group", { name: "참여 기관" }).textContent).toContain("1곳");
  });
});
