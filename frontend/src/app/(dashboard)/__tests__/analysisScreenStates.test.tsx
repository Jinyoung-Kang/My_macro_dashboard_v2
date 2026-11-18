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

describe("교집합 — 검사 칸(종목 이름 → 대화상자)", () => {
  it("교집합 줄의 이름을 누르면 대화상자에 속성·보유 기관 배지, 닫으면 그 이름 단추로 포커스가 돌아온다", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"], participantCount: 2, availableDates: [], reportDate: null, minHolders: 2,
          rows: [{ key: "issuer:000000", name: "SYNTHETIC HOLDER CO", cusip: "000000501", holders: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"],
            actions: [], holderCount: 2, totalValue: 2_000_000_000, avgWeight: 4.5, maxWeight: 6.25, buyCount: 1, sellCount: 1 }],
        });
      }
      if (path.startsWith("/api/macro/usdkrw")) return Promise.resolve({ available: true, rate: 1400, lastTs: "2026-11-04 20:19 KST" });
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const trigger = await screen.findByRole("button", { name: "SYNTHETIC HOLDER CO" });
    // 표에는 보유 기관 목록 열이 없습니다(검사 칸으로 옮김).
    const table = trigger.closest("table") as HTMLElement;
    expect(within(table).queryByText("보유 기관 목록")).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "SYNTHETIC HOLDER CO" });
    const value = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
    expect(value("증권 구분")).toBe("발행사 000000 · 보통주 합산");
    expect(value("보유 기관 수")).toBe("2곳");
    expect(value("동시 매수")).toContain("1곳");
    expect(value("동시 매도")).toContain("1곳");
    expect(value("최대 비중")).toBe("6.25%");
    expect(value("합산 평가액")).toBe("20.0억 달러");
    expect(value("원화 환산")).toContain("원/달러 1,400.00 기준");
    const holders = within(dialog).getByRole("region", { name: "보유 기관" });
    expect(within(holders).getAllByRole("listitem").map((item) => [item.textContent, item.getAttribute("title")])).toEqual([
      ["가상", "가상 자산운용 (Synthetic AM)"],
      ["가상", "가상 연기금"],
    ]);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe("교집합 — 분석 대상 거르기 목록(옛 기관 칩)", () => {
  const INSTITUTIONS = {
    institutions: [
      { key: "a", name: "🇺🇸 가상 자산운용 (Synthetic AM)", cik: "1", desc: "" },
      { key: "b", name: "가상 연기금", cik: "2", desc: "" },
      { key: "c", name: "가상 국부펀드", cik: "3", desc: "" },
    ],
  };

  it("처음엔 모두 켬(빈 고름 = 전체 — QA-003), 하나를 끄면 개수 'n곳 / 전체곳'이 줄고 마지막 하나까지 끄면 다시 전체", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/sec13f/institutions") ? Promise.resolve(INSTITUTIONS) : new Promise(() => {}));
    render(<ConsensusPage />);
    const group = await screen.findByRole("group", { name: "분석 대상 기관" });
    const pressed = () => within(group).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")]);
    await waitFor(() => expect(pressed()).toEqual([["가상 자산운용 (Synthetic AM)", "true"], ["가상 연기금", "true"], ["가상 국부펀드", "true"]]));
    const panel = group.closest("section") as HTMLElement;
    expect(within(panel).getByText("3곳 / 3곳")).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: "가상 연기금" }));
    expect(pressed()).toEqual([["가상 자산운용 (Synthetic AM)", "true"], ["가상 연기금", "false"], ["가상 국부펀드", "true"]]);
    expect(within(panel).getByText("2곳 / 3곳")).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: "가상 자산운용 (Synthetic AM)" }));
    fireEvent.click(within(group).getByRole("button", { name: "가상 국부펀드" }));
    expect(pressed().every(([, state]) => state === "true")).toBe(true);
    expect(within(panel).getByText("3곳 / 3곳")).toBeTruthy();
  });

  it("기관 목록을 읽는 동안은 자리표시, 읽지 못하면 오류와 '다시 시도'(누르면 목록만 한 번 더)", async () => {
    let fail = false;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return fail ? Promise.reject(new Error("기관 목록을 읽지 못했습니다.")) : new Promise(() => {});
      return new Promise(() => {});
    });
    const { unmount } = render(<ConsensusPage />);
    expect(await screen.findByRole("status", { name: "기관 목록 불러오는 중" })).toBeTruthy();
    unmount();

    fail = true;
    render(<ConsensusPage />);
    expect(await screen.findByText("기관 목록을 읽지 못했습니다.")).toBeTruthy();
    const institutionCalls = () => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/institutions")).length;
    const before = institutionCalls();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(institutionCalls()).toBe(before + 1));
  });
});

/** 스타일 화면 위험 응답(합성) — 위험 기여 하나는 음수(분산 효과로 포트폴리오 변동성을 줄이는 종목), VaR·ES는 손실이라 음수. */
function riskBody(over: Record<string, unknown> = {}) {
  return {
    available: true, cik: "0001067983", benchmark: "SPY", years: 1, collectedAtKst: "2026-11-04 19:40 KST", ageSeconds: 60, stale: false,
    coverage: { holdings: 30, totalHoldings: 40, weight: 78.1, totalWeight: 100, uncovered: [], uncoveredCount: 0 },
    metrics: { volatility: 14.2, var95: -1.13, var99: -1.92, es95: -1.63, es99: -2.27, maxDrawdown: 7.64, beta: 0.82, trackingError: 6.1, samples: 250,
      from: "2025-11-04", to: "2026-11-04" },
    contributions: [
      { ticker: "SYNA", name: "SYNTHETIC ALPHA CO", sector: "Technology", weight: 22.1, volatility: 24.0, marginal: 0.3, contribution: 4.1, share: 28.9 },
      { ticker: "SYNG", name: "SYNTHETIC GOLD CO", sector: "Materials", weight: 5.0, volatility: 18.0, marginal: -0.1, contribution: -0.42, share: -3.0 },
    ],
    sectors: [{ sector: "Technology", weight: 40.2 }],
    ...over,
  };
}

describe("스타일 — 종목별 위험 기여는 등락이 아니다(QA-704)", () => {
  // 수정 전 실패: 위험 기여 칸이 deltaColor로 양수 빨강(text-up)·음수 파랑(text-down)이고 음수 부호가 ASCII '-'('-0.42%p') — 기여는 오르내린 값이 아님.
  it("위험 기여·기여 비중 칸에 상승·하락 글자색이 없고 음수는 −(U+2212)", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/guru/risk") ? Promise.resolve(riskBody()) : new Promise(() => {})));
    render(<GuruPage />);
    const table = (await screen.findByText("SYNTHETIC GOLD CO")).closest("table") as HTMLElement;
    const tinted = [...table.querySelectorAll(".text-up, .text-down")].map((element) => `${element.className} '${element.textContent}'`);
    // 칸마다 봅니다(표 글 전체를 이으면 칸 경계가 사라져 앞 칸 끝 글자에 붙은 '-'를 놓침).
    const hyphen = [...table.querySelectorAll("td, th")].map((cell) => cell.textContent ?? "").filter((text) => /(^|\s)-\d/.test(text));
    expect({ tinted, hyphen }).toEqual({ tinted: [], hyphen: [] });
    expect(within(table).getByText("−0.42%p")).toBeTruthy();
    expect(within(table).getByText("−3.0%")).toBeTruthy();
  });
});

describe("스타일 — 위험 지표 VaR·ES의 음수 부호(QA-709)", () => {
  // 수정 전 실패: VaR·ES 값이 formatWithUnit 글 그대로라 '-1.13%'·'-1.92%'·'-1.63%'·'-2.27%'(ASCII 하이픈) — 화면의 다른 음수는 −(U+2212).
  it("VaR(95·99%)·ES(95·99%)의 음수 값은 −(U+2212)로 적는다", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/guru/risk") ? Promise.resolve(riskBody()) : new Promise(() => {})));
    render(<GuruPage />);
    await screen.findByText("SYNTHETIC GOLD CO");
    const shown = ["VaR (95%)", "VaR (99%)", "ES (95%)", "ES (99%)"].map((label) => {
      // 이름 글의 부모(지표 칸·KPI 타일) 안의 글 — 이름·값·보조 글.
      const tile = screen.getByText(label).parentElement as HTMLElement;
      return `${label}: ${(tile.textContent ?? "").replace(label, "")}`;
    });
    expect(shown.filter((text) => /-\d/.test(text))).toEqual([]);
    expect(shown.map((text) => text.match(/−\d[\d.]*%/)?.[0] ?? null)).toEqual(["−1.13%", "−1.92%", "−1.63%", "−2.27%"]);
  });
});

/** 스타일 화면 유사도 응답(합성 — 기관 셋, 이름은 백엔드처럼 국기 + 괄호 영문). */
const SIMILARITY_BODY = {
  available: true, note: "겹침 비중·코사인 — 최신 분기 기준",
  institutions: [
    { cik: "0000000021", key: "a", name: "🇺🇸 가상 자산운용 (Synthetic Asset Management)", reportDate: "2026-06-30" },
    { cik: "0000000022", key: "b", name: "🇳🇴 가상 국부펀드 (Synthetic Sovereign Fund)", reportDate: "2026-06-30" },
    { cik: "0000000023", key: "c", name: "🇰🇷 가상 연기금 (Synthetic Pension)", reportDate: "2026-06-30" },
  ],
  overlap: [[100, 42.5, 12.25], [42.5, 100, 0], [12.25, 0, 100]],
  cosine: [[1, 0.81, 0.2], [0.81, 1, 0.05], [0.2, 0.05, 1]],
  topPairs: [],
};

/** '가장 닮은 짝' 표 — 그 제목(h3) 다음에 오는 첫 표(뒤의 유사도 행렬보다 앞). */
async function pairsTable(): Promise<HTMLTableElement> {
  const heading = await screen.findByText(/^가장 닮은 짝/, { selector: "h3" });
  return heading.parentElement?.querySelector("table") as HTMLTableElement;
}

describe("스타일 — '가장 닮은 짝' 표가 좁은 화면에서 패널 밖으로 넘친다(QA-706)", () => {
  // 수정 전 실패(D1 QA — 390에서 값 끝이 잘리고 막대가 0폭, 가로 스크롤 없음)의 구조: 표가 가로 스크롤 상자 밖, 열 넷(#·기관 A·기관 B·값),
  // 두 이름 칸이 줄바꿈 금지(whitespace-nowrap)라 표가 패널 폭보다 넓어짐.
  it.fails("짝 표는 가로 스크롤 상자 안의 세 칸 표(#·짝·값)이고 이름 칸은 줄을 바꿀 수 있다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/similarity") ? Promise.resolve(SIMILARITY_BODY) : new Promise(() => {}));
    render(<GuruPage />);
    const table = await pairsTable();
    const region = table.closest('[role="region"]');
    const nowrapNames = [...table.querySelectorAll("tbody .whitespace-nowrap")]
      .map((cell) => cell.textContent ?? "")
      .filter((text) => /[가-힣A-Za-z]/.test(text));
    expect({
      region: region?.getAttribute("aria-label") ?? null,
      headers: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
      nowrapNames,
    }).toEqual({
      region: "가장 닮은 짝 — 겹침 비중 순 상위 3 (좌우 스크롤)",
      headers: ["#", "짝", "겹침 비중 (%)"],
      nowrapNames: [],
    });
  });
});
