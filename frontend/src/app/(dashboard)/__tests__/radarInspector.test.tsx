/**
 * 수급 레이더 순위의 조밀 표 + 검사 칸(작업대 P7 — 실행 명세 §7 7행 '레이더: 조밀 표와 검사').
 *
 * - 검사 칸의 값은 화면이 이미 읽은 응답 셋(수급 지속성 stock-flows·재무 fundamentals·공통 consensus)에서만 옵니다 — 검사를 열어도 새 요청 0.
 * - 응답에 그 종목이 없으면 '—'·까닭(수집 전·재무 없음·공통 목록에 없음) — 0으로 채우지 않습니다.
 * - 표: 등락률은 공용 변화 칸(▲▼·sr 글), 순매수대금은 본문 잉크 + −(U+2212)(오르내린 값이 아님 — 등락색을 쓰지 않음), 고정폭 코드.
 * - 넓은 화면(옆 칸 배치)은 첫 줄을 처음에 보입니다(새 요청 없음). 좁은 화면은 대화상자.
 * - 링크: 종목 상세 /s/kr/{코드}, 공시 원문(DART — 새 창).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ HorizontalBars: () => null, SignedBars: () => null }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import RadarPage from "../radar/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const RANKING_PATH = endpoints.positioning.radarRanking({ market: "KOSPI", investor: "외국인", tradeType: "순매수", intervalType: "TODAY", topN: "30" });
const CONSENSUS_PATH = endpoints.positioning.radarConsensus({ market: "KOSPI", tradeType: "순매수", intervalType: "TODAY", topN: "30" });
const window20 = (sum: number, days = 20) => ({ sum, days, window: 20 });

const READS: Record<string, unknown> = {
  [RANKING_PATH]: {
    available: true, market: "KOSPI", investor: "외국인", tradeType: "순매수", readMode: "auto", source: "합성 순위 출처", sourceKind: "krx",
    isHistorical: false, historyDate: null, intervalType: "TODAY", dataDate: "2026-11-18",
    rows: [
      { rank: 1, code: "000001", name: "합성전자", price: 71000, changePct: 1.2, netAmountEok: 10 },
      { rank: 2, code: "000002", name: "합성화학", price: 2000, changePct: -0.5, netAmountEok: -3.2 },
    ],
  },
  [endpoints.positioning.stockFlows("000001,000002")]: {
    available: true, source: "합성 토스 출처", stocks: [{
      code: "000001", available: true, records: 20, latestDate: "2026-11-18", provisional: false,
      investors: [
        { key: "foreigner", label: "외국인", latest: 1, net5: { sum: 292000, days: 5, window: 5 }, net20: window20(-12500, 18), streak: 3 },
        { key: "institution", label: "기관", latest: 1, net5: { sum: 1, days: 5, window: 5 }, net20: window20(5000), streak: -2 },
      ],
      breakdown: [{ key: "pensionFund", label: "연기금", latest: 1, net5: { sum: 1, days: 5, window: 5 }, net20: window20(800) }],
      foreignerHolding: { ratePct: 51.23, date: "2026-11-18", changePp: -0.12, fromDate: "2026-10-21" },
    }],
  },
  [endpoints.publicData.fundamentals("000001,000002")]: {
    available: true, priceDate: "2026-11-18", companies: [
      { code: "000001", available: true, name: "합성전자", bsnsYear: "2025", fsLabel: "연결", dartUrl: "https://dart.example/1", debtRatio: 50, roe: 10.4,
        operatingMargin: 5, revenueGrowth: 3.2, operatingIncomeGrowth: null, operatingTurn: "흑자전환", marketCap: 1e12, per: 10, pbr: 1.2 },
    ],
  },
  [CONSENSUS_PATH]: {
    available: true, market: "KOSPI", tradeType: "순매수", intervalType: "TODAY", topN: 30, foreignCount: 30, institutionCount: 30, sources: ["합성"],
    rows: [{ code: "000001", name: "합성전자", price: 71000, changePct: 1.2, foreignEok: 10, institutionEok: -2.5, totalEok: 7.5, foreignRank: 1, institutionRank: 12 }],
  },
};

const calls = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in READS ? Promise.resolve(READS[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function rendered() {
  render(<SessionUserProvider user={MEMBER}><RadarPage /></SessionUserProvider>);
  await screen.findByRole("button", { name: "합성전자" });
  await settled();
}

/** 속성 목록 한 줄의 값 칸(dd). */
function valueOf(scope: HTMLElement, label: string): HTMLElement {
  return within(scope).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

describe("수급 레이더 순위 — 조밀 표", () => {
  it("등락률은 변화 칸(▲▼·sr 글), 순매수대금은 본문 잉크 + −, 코드는 고정폭", async () => {
    await rendered();
    const table = screen.getByRole("region", { name: "순위 상세 (좌우 스크롤)" });
    const row = within(table).getByRole("button", { name: "합성화학" }).closest("tr") as HTMLTableRowElement;
    const change = row.cells[3];
    expect(within(change).getByText("하락")).toBeTruthy();
    expect(change.textContent).toContain("−0.50%");
    const net = row.cells[4];
    expect(net.textContent).toBe("−3.2");
    expect(net.innerHTML).not.toMatch(/text-(up|down)/);
    expect(within(row.cells[1]).getByText("000002").className).toContain("font-mono");
    expect(within(screen.getByRole("region", { name: "순위 상세 (좌우 스크롤)" }).parentElement as HTMLElement).getByText("2건")).toBeTruthy();
  });
});

describe("수급 레이더 순위 — 검사 칸(이미 읽은 응답만)", () => {
  it("좁은 화면: 이름을 누르면 대화상자 — 순위·지속성·재무·공통 값, 새 요청 0", async () => {
    await rendered();
    const before = calls().length;

    fireEvent.click(screen.getByRole("button", { name: "합성전자" }));
    const dialog = await screen.findByRole("dialog", { name: "합성전자" });
    await settled();
    expect(calls().length).toBe(before);

    expect(valueOf(dialog, "종목코드").textContent).toBe("000001");
    expect(valueOf(dialog, "순매수대금").textContent).toBe("+10.0억 원");
    expect(valueOf(dialog, "외국인 5일").textContent).toBe("+29.2만 주");
    expect(valueOf(dialog, "외국인 20일").textContent).toBe("−1.3만 주 (18일)");
    expect(valueOf(dialog, "외국인 연속").textContent).toBe("3일 순매수");
    expect(valueOf(dialog, "기관 연속").textContent).toBe("2일 순매도");
    expect(valueOf(dialog, "연기금 20일").textContent).toBe("+800 주");
    expect(valueOf(dialog, "외국인 보유율").textContent).toContain("51.23%");
    expect(within(valueOf(dialog, "외국인 보유율")).getByText("하락")).toBeTruthy();
    expect(valueOf(dialog, "부채비율").textContent).toBe("50.0%");
    expect(valueOf(dialog, "영업이익 증가").textContent).toBe("흑자전환");
    expect(within(valueOf(dialog, "매출 증가")).getByText("상승")).toBeTruthy();
    expect(valueOf(dialog, "PBR").textContent).toBe("1.2배");
    expect(valueOf(dialog, "기관").textContent).toBe("−2.5억 원12위");
    expect(within(dialog).getByRole("link", { name: "종목 상세" }).getAttribute("href")).toBe("/s/kr/000001");
    const dart = within(dialog).getByRole("link", { name: /공시 원문/ });
    expect(dart.getAttribute("href")).toBe("https://dart.example/1");
    expect(dart.getAttribute("target")).toBe("_blank");
  });

  it("응답에 그 종목이 없으면 '—'·까닭 — 지속성 수집 전, 재무 없음, 공통 목록에 없음(0으로 채우지 않음)", async () => {
    await rendered();
    fireEvent.click(screen.getByRole("button", { name: "합성화학" }));
    const dialog = await screen.findByRole("dialog", { name: "합성화학" });

    expect(within(dialog).getByText(/투자자별 매매동향이 아직 수집되지 않았습니다/)).toBeTruthy();
    expect(within(dialog).getByText(/DART 재무가 없습니다/)).toBeTruthy();
    expect(within(dialog).getByText(/공통 순매수 목록\(두 상위 목록의 교집합\)에 없습니다/)).toBeTruthy();
    expect(within(dialog).queryByRole("link", { name: /공시 원문/ })).toBeNull();
    expect(dialog.textContent).not.toMatch(/(^|[^\d.])0\.0(%|배|억)/);
  });

  it("넓은 화면: 옆 검사 칸이 첫 줄을 처음에 보이고(새 요청 없음), 다른 이름을 고르면 그 줄 — 고른 행 표시", async () => {
    stubWide();
    await rendered();
    const before = calls().length;
    const panel = screen.getByRole("region", { name: "순위 종목 — 합성전자" });
    expect(within(panel).getByRole("heading", { name: "합성전자" })).toBeTruthy();
    expect(valueOf(panel, "외국인 5일").textContent).toBe("+29.2만 주");

    fireEvent.click(screen.getByRole("button", { name: "합성화학" }));
    const next = screen.getByRole("region", { name: "순위 종목 — 합성화학" });
    expect(valueOf(next, "순매수대금").textContent).toBe("−3.2억 원");
    expect(screen.getByRole("button", { name: "합성화학" }).closest("tr")?.getAttribute("aria-current")).toBe("true");
    await settled();
    expect(calls().length).toBe(before);
  });
});
