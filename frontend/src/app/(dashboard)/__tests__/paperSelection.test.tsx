/**
 * 🧪 모의 매매 — 기관 선정 탭(13F 트랙레코드). 서버가 계산한 값을 그대로 보이고, 지어내지 않는다.
 *
 *  - 계산 전(computed:false)이면 수집 진행률만 — 후보 표·수익률 칸은 없다
 *  - 수집 중·자격 없음 행은 서버 사유를 그대로 보인다(순위 없음 "—")
 *  - 커버리지 칸이 수익률 칸보다 먼저(왼쪽) — 후보 표와 펼친 구간 표 둘 다
 *  - 숫자 null은 "—"(0.00으로 채우지 않음)
 *  - "지금 재계산"은 POST /api/paper/run/rerank → 경과 초 → 결과(선정은 그대로) + 표 다시 읽기
 *  - 그룹 B(D27): 같은 칸 + 출처(q30·q8)와 기존 메뉴 설명, complete=false를 "수집 중"으로 보지 않음, 한계에 "그룹 B는 2년 창 — 표본이 짧다"
 *  - 신호 풀: 기관 · 그룹 배지(A/B/AB) · 그룹 순위 · 기관 가중 %(서버 값 그대로)
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 개요 탭이 먼저 그려지므로 차트도 바꿔 끼웁니다(jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const OVERVIEW = { available: true, initialized: true, startDate: "2026-10-23", limits: [], books: [], jobs: [], pendingBackfill: [] };

const COLLECTION = { filers: 27, completeCount: 20, storedFilings: 700, targetFilings: 810, updatedAtKst: "2026-10-24 03:10" };

const SCION_REASON = "최신 분기(2026-06-30) 공시 없음";
const TUDOR_REASON = "수집 중(저장 분기 12/30)";

function candidate(cik: string, name: string, over: Record<string, unknown> = {}) {
  return {
    cik, name, style: "가치·집중", rank: null, eligible: false, ineligibleReason: null, collecting: false,
    cagrPct: 14.21, cumReturnPct: 152.3, spyCumReturnPct: 120.4, excessVsSpyPct: 31.9, volPct: 17.85, mddPct: -24.6, sharpe: 0.83,
    periodsUsed: 27, periodsTotal: 28, coverageMin: 0.613, coverageAvg: 0.874, firstFilingDate: "2019-11-14", lastFilingDate: "2026-08-14",
    storedQuarters: 30, complete: true, selected: false, periods: [], ...over,
  };
}

const COMPUTED = {
  available: true,
  computed: true,
  asOfDate: "2026-10-23",
  windowYears: 7,
  metric: "CAGR",
  criteria: { windowYears: 7, minPeriods: 24, minCoverage: 0.5, avgCoverage: 0.7 },
  candidates: [
    candidate("0001067983", "버크셔 해서웨이 (Berkshire Hathaway)", {
      rank: 1, eligible: true, selected: true,
      periods: [
        {
          filingDate: "2026-05-15", reportDate: "2026-03-31", start: "2026-05-18", end: "2026-08-17", returnPct: 3.42, spyReturnPct: 2.1,
          coverage: 0.912, coveredTickers: 38, holdings: 42,
        },
        {
          filingDate: "2026-08-14", reportDate: "2026-06-30", start: "2026-08-17", end: "2026-10-23", returnPct: null, spyReturnPct: 1.05,
          coverage: 0, coveredTickers: 0, holdings: 40,
        },
      ],
    }),
    candidate("0001649339", "사이언 (Scion Asset Management)", { ineligibleReason: SCION_REASON, lastFilingDate: "2025-11-14" }),
    // 30분기를 다 받지 못한 기관 — 수치는 전부 null(지어내지 않음)
    candidate("0000923093", "튜더 (Tudor Investment)", {
      style: "매크로", collecting: true, complete: false, storedQuarters: 12, ineligibleReason: TUDOR_REASON,
      cagrPct: null, cumReturnPct: null, spyCumReturnPct: null, excessVsSpyPct: null, volPct: null, mddPct: null, sharpe: null,
      periodsUsed: null, periodsTotal: null, coverageMin: null, coverageAvg: null, firstFilingDate: null, lastFilingDate: null,
    }),
  ],
  selected: ["0001067983"],
  selectionHistory: [{ asOfDate: "2026-10-23", selectedCiks: ["0001067983", "0009999999"] }],
  collection: COLLECTION,
  limits: [
    "트랙레코드는 공시일 다음 거래일부터 복제한 값이라 실제 기관 수익률이 아닙니다.",
    "후보 기관 목록은 오늘 알려진 운용사라 생존 편향이 있습니다.",
    "커버리지(티커 붙은 비중)가 100% 미만이면 '커버 보유분 기준'입니다.",
  ],
};

/** 그룹 B — 기존 13F 메뉴 기관(2년 창). 후보 수집이 없는 기관은 q8, complete는 늘 거짓. */
const GROUP_B = {
  computed: true,
  topN: 4,
  windowYears: 2,
  minPeriods: 6,
  metric: "CAGR",
  selected: ["0001536411"],
  candidates: [
    candidate("0001536411", "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)", {
      style: null, desc: "스탠리 드러켄밀러, 테크 트렌드 포착형 매크로 운용", source: "q30", storedQuarters: 30,
      rank: 1, eligible: true, selected: true, cagrPct: 26.8, periodsUsed: 8, periodsTotal: 8, complete: false,
      firstFilingDate: "2024-11-14", lastFilingDate: "2026-08-14",
      periods: [{
        filingDate: "2026-08-14", reportDate: "2026-06-30", start: "2026-08-17", end: "2026-10-23", returnPct: 4.2, spyReturnPct: 1.05,
        coverage: 0.95, coveredTickers: 40, holdings: 42,
      }],
    }),
    // 인덱스형 — 수익률이 높아도 커버리지 미달(서버 사유 그대로). q8이고 complete=false지만 "수집 중"이 아님
    candidate("0001374170", "🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)", {
      style: null, desc: "세계 최대 규모의 글로벌 국부펀드, 인덱스형 거인", source: "q8", storedQuarters: null, complete: false,
      cagrPct: 18.5, ineligibleReason: "평균 커버리지 57.0% < 70%", periodsUsed: 8, periodsTotal: 8,
    }),
  ],
};

const POOL = [
  { cik: "0001067983", name: "버크셔 해서웨이 (Berkshire Hathaway)", groups: ["A"], rankA: 1, rankB: null, weight: 0.5 },
  { cik: "0001536411", name: "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)", groups: ["B"], rankA: null, rankB: 1, weight: 0.5 },
];

const BLENDED = { ...COMPUTED, selectedAsOfDate: "2026-10-23", groupB: GROUP_B, pool: POOL, groupWeightA: 0.5 };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = { "/api/paper/overview": () => Promise.resolve(OVERVIEW) };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

async function openSelectionTab() {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "기관 선정" }));
}

const headersOf = (container: HTMLElement) => within(container).getAllByRole("columnheader").map((th) => th.textContent);
const cellsOf = (name: string) => within(screen.getByRole("row", { name })).getAllByRole("cell").map((td) => td.textContent);

describe("계산 전(computed:false)", () => {
  it("수집 진행률만 보이고, 후보 표·수익률 칸은 그리지 않는다 — 다음 단계 안내도 없다", async () => {
    reads["/api/paper/track-record"] = () => Promise.resolve({ available: true, computed: false, collection: COLLECTION });

    await openSelectionTab();

    expect(await screen.findByText("후보 27곳 중 수집 완료 20곳 · 저장 공시 700/810건 · 마지막 수집 2026-10-24 03:10")).toBeTruthy();
    expect(screen.getByText(/트랙레코드를 아직 계산하지 않았습니다/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: /후보 기관 트랙레코드 표/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "CAGR" })).toBeNull();
    expect(screen.queryByText("선정 이력")).toBeNull();
    // 준비 중 자리 문구는 이제 없습니다.
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();
    expect(screen.getByRole("button", { name: "지금 재계산" })).toBeTruthy();
  });

  it("테이블이 없으면(available:false) 서버 문구 그대로", async () => {
    const message = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8)를 적용하면 생깁니다 — make up 후 다시 보세요.";
    reads["/api/paper/track-record"] = () => Promise.resolve({ available: false, message });

    await openSelectionTab();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "지금 재계산" })).toBeNull();
  });
});

describe("계산된 트랙레코드", () => {
  beforeEach(() => {
    reads["/api/paper/track-record"] = () => Promise.resolve(COMPUTED);
  });

  it("커버리지 칸이 수익률 칸보다 먼저 — 기준·순위 기준을 제목 아래에", async () => {
    await openSelectionTab();

    const table = await screen.findByRole("region", { name: /후보 기관 트랙레코드 표/ });
    const headers = headersOf(table);
    expect(headers).toEqual([
      "순위", "기관", "자격", "선정", "수집", "구간", "커버리지 최소", "커버리지 평균",
      "CAGR", "누적", "SPY 누적", "초과(SPY 대비)", "변동성(연율)", "MDD", "샤프",
    ]);
    expect(headers.indexOf("커버리지 평균")).toBeLessThan(headers.indexOf("CAGR"));
    expect(screen.getByText(/2026-10-23 기준 · 순위 기준 연율 수익률\(CAGR\) · 자격: 창 7년 · 구간 ≥ 24개 · 최소 커버리지 ≥ 50% · 평균 커버리지 ≥ 70%/))
      .toBeTruthy();
  });

  it("자격 있는 기관은 순위·선정 배지와 서버 값 그대로, 커버리지는 % 표기", async () => {
    await openSelectionTab();

    await screen.findByRole("row", { name: "버크셔 해서웨이 (Berkshire Hathaway)" });
    const cells = cellsOf("버크셔 해서웨이 (Berkshire Hathaway)");
    expect(cells[0]).toBe("1");
    expect(cells[2]).toBe("자격");
    expect(cells[3]).toBe("선정");
    expect(cells[4]).toBe("30/30 · 완료");
    expect(cells[5]).toBe("27/282019-11-14 ~ 2026-08-14");
    expect(cells[6]).toBe("61.3%");
    expect(cells[7]).toBe("87.4%");
    expect(cells[8]).toBe("+14.21%");
    expect(cells[11]).toBe("+31.90%p");
    expect(cells[12]).toBe("17.85%");
    expect(cells[13]).toBe("-24.60%");
    expect(cells[14]).toBe("0.83");
  });

  it("자격 없음·수집 중인 행은 서버 사유를 보이고 순위는 —, 모르는 숫자는 전부 —", async () => {
    await openSelectionTab();

    await screen.findByRole("row", { name: "사이언 (Scion Asset Management)" });
    const scion = cellsOf("사이언 (Scion Asset Management)");
    expect(scion[0]).toBe("—");
    expect(scion[2]).toBe(`자격 없음${SCION_REASON}`);
    expect(scion[3]).toBe("—");

    const tudor = cellsOf("튜더 (Tudor Investment)");
    expect(tudor[0]).toBe("—");
    expect(tudor[2]).toBe(`수집 중${TUDOR_REASON}`);
    expect(tudor[4]).toBe("12/30 · 수집 중");
    expect(tudor.slice(6)).toEqual(Array(9).fill("—"));
    expect(within(screen.getByRole("row", { name: "튜더 (Tudor Investment)" })).queryByText(/0\.00/)).toBeNull();
  });

  it("행을 펼치면 구간 표 — 커버리지가 수익률보다 먼저, 수익률이 없는 구간은 —", async () => {
    await openSelectionTab();

    const row = await screen.findByRole("row", { name: "버크셔 해서웨이 (Berkshire Hathaway)" });
    const toggle = within(row).getByRole("button", { name: "구간 펼치기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    const periods = screen.getByRole("region", { name: "버크셔 해서웨이 (Berkshire Hathaway) 구간" });
    expect(headersOf(periods)).toEqual(["공시일", "보고 분기", "시작", "끝", "커버리지", "수익률", "SPY"]);
    const first = within(periods).getByText("2026-05-15").closest("tr") as HTMLElement;
    expect(within(first).getAllByRole("cell").map((td) => td.textContent))
      .toEqual(["2026-05-15", "2026-03-31", "2026-05-18", "2026-08-17", "91.2% (티커 38개 · 보유 42줄)", "+3.42%", "+2.10%"]);
    const last = within(periods).getByText("2026-08-14").closest("tr") as HTMLElement;
    const lastCells = within(last).getAllByRole("cell").map((td) => td.textContent);
    expect(lastCells[4]).toBe("0.0% (티커 0개 · 보유 40줄)");
    expect(lastCells[5]).toBe("—");

    // 다시 누르면 접습니다.
    fireEvent.click(within(row).getByRole("button", { name: "구간 접기" }));
    expect(screen.queryByRole("region", { name: "버크셔 해서웨이 (Berkshire Hathaway) 구간" })).toBeNull();
  });

  it("한계 문구 세 개, 선정 이력(후보에 없는 CIK는 그대로), 수집 진행률", async () => {
    await openSelectionTab();

    for (const limit of COMPUTED.limits) expect(await screen.findByText(limit)).toBeTruthy();
    expect(screen.getByText("버크셔 해서웨이 (Berkshire Hathaway), 0009999999")).toBeTruthy();
    expect(screen.getByText("후보 27곳 중 수집 완료 20곳 · 저장 공시 700/810건 · 마지막 수집 2026-10-24 03:10")).toBeTruthy();
  });
});

describe("두 기관 그룹(D27)", () => {
  beforeEach(() => {
    reads["/api/paper/track-record"] = () => Promise.resolve(BLENDED);
  });

  it("그룹 B 표 — 그룹 A와 같은 칸에 수집 대신 출처, 기준은 2년 창·구간 6개 + 그룹 A의 커버리지 기준", async () => {
    await openSelectionTab();

    const table = await screen.findByRole("region", { name: /그룹 B 기관 트랙레코드 표/ });
    expect(headersOf(table)).toEqual([
      "순위", "기관", "자격", "선정", "출처", "구간", "커버리지 최소", "커버리지 평균",
      "CAGR", "누적", "SPY 누적", "초과(SPY 대비)", "변동성(연율)", "MDD", "샤프",
    ]);
    expect(screen.getByText("그룹 B — 기존 13F 메뉴 기관 트랙레코드 (2년 창)")).toBeTruthy();
    expect(screen.getByText(
      "2026-10-23 기준 · 순위 기준 연율 수익률(CAGR) · 자격: 창 2년 · 구간 ≥ 6개 · 최소 커버리지 ≥ 50% · 평균 커버리지 ≥ 70% · 상위 4곳 선정",
    )).toBeTruthy();
    // 그룹 A 표는 그대로(제목만 그룹 A)
    expect(screen.getByText("그룹 A — 후보 기관 트랙레코드 (7년 창)")).toBeTruthy();
    expect(headersOf(screen.getByRole("region", { name: /후보 기관 트랙레코드 표/ }))[4]).toBe("수집");
  });

  it("그룹 B 행 — 기존 메뉴 설명·출처, q8·complete=false인 기관은 '수집 중'이 아니라 서버 사유 그대로", async () => {
    await openSelectionTab();

    const duquesneRow = "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office) (그룹 B)";
    await screen.findByRole("row", { name: duquesneRow });
    const duquesne = cellsOf(duquesneRow);
    expect(duquesne[0]).toBe("1");
    expect(duquesne[1]).toContain("스탠리 드러켄밀러, 테크 트렌드 포착형 매크로 운용 · CIK 0001536411");
    expect(duquesne[2]).toBe("자격");
    expect(duquesne[3]).toBe("선정");
    expect(duquesne[4]).toBe("q30 · 30분기");
    expect(duquesne[8]).toBe("+26.80%");

    const norges = cellsOf("🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG) (그룹 B)");
    expect(norges[0]).toBe("—");
    expect(norges[2]).toBe("자격 없음평균 커버리지 57.0% < 70%");
    expect(norges[4]).toBe("q8");
  });

  it("그룹 B 행을 펼치면 그 행의 구간 표만 — 2년 창 문구", async () => {
    await openSelectionTab();

    const row = await screen.findByRole("row", { name: "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office) (그룹 B)" });
    fireEvent.click(within(row).getByRole("button", { name: "구간 펼치기" }));

    const periods = screen.getByRole("region", { name: "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office) (그룹 B) 구간" });
    expect(within(periods).getByText(/첫 구간은 2년 창 시작으로/)).toBeTruthy();
    expect(within(periods).getByText("2026-08-14")).toBeTruthy();
    // 그룹 A 행은 펼쳐지지 않습니다.
    expect(screen.queryByRole("region", { name: "버크셔 해서웨이 (Berkshire Hathaway) 구간" })).toBeNull();
  });

  it("신호 풀 — 기관·그룹 배지·그룹 순위·기관 가중(서버 값), 그룹 A 몫", async () => {
    await openSelectionTab();

    const pool = await screen.findByRole("region", { name: "신호 풀 표" });
    expect(headersOf(pool)).toEqual(["기관", "그룹", "그룹 A 순위", "그룹 B 순위", "기관 가중"]);
    const rows = within(pool).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));
    expect(rows).toEqual([
      ["버크셔 해서웨이 (Berkshire Hathaway)CIK 0001067983", "A", "1위", "—", "50.0%"],
      ["🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)CIK 0001536411", "B", "—", "1위", "50.0%"],
    ]);
    expect(screen.getByText(/2026-10-23 선정 — 규칙 계좌가 이 기관들의 13F 변화를 신호로 씁니다/)).toBeTruthy();
    expect(screen.getByText(/그룹 A 50\.0% · 그룹 B 50\.0%/)).toBeTruthy();
  });

  it("한계에 '그룹 B는 2년 창 — 표본이 짧다'를 덧붙이고, 선정 이력은 그룹 B 이름도 찾는다", async () => {
    reads["/api/paper/track-record"] = () => Promise.resolve({
      ...BLENDED, selectionHistory: [{ asOfDate: "2026-10-23", selectedCiks: ["0001067983", "0001536411"] }],
    });
    await openSelectionTab();

    const limits = await screen.findByText("트랙레코드의 한계");
    const card = limits.closest("section") as HTMLElement;
    const items = within(card).getAllByRole("listitem").map((li) => li.textContent);
    expect(items.slice(0, 3)).toEqual(COMPUTED.limits);
    expect(items[3]).toContain("그룹 B는 2년 창 — 표본이 짧다");
    expect(screen.getByText("버크셔 해서웨이 (Berkshire Hathaway), 🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)")).toBeTruthy();
  });

  it("그룹 B를 아직 보내지 않는 백엔드 — 그룹 B 표·신호 풀 카드·그룹 B 한계 줄이 없다", async () => {
    reads["/api/paper/track-record"] = () => Promise.resolve(COMPUTED);
    await openSelectionTab();

    await screen.findByRole("region", { name: /후보 기관 트랙레코드 표/ });
    expect(screen.queryByRole("region", { name: /그룹 B 기관 트랙레코드 표/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "신호 풀 표" })).toBeNull();
    expect(screen.queryByText(/그룹 B는 2년 창/)).toBeNull();
  });
});

describe("지금 재계산", () => {
  it("POST /api/paper/run/rerank → 경과 초 → 결과(선정은 그대로)와 표 다시 읽기", async () => {
    let trackReads = 0;
    reads["/api/paper/track-record"] = () => {
      trackReads += 1;
      return Promise.resolve(COMPUTED);
    };
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));

    await openSelectionTab();
    fireEvent.click(await screen.findByRole("button", { name: "지금 재계산" }));

    const busy = await screen.findByRole("button", { name: /계산 중… \d+초/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/rerank", {});

    finish({ ok: true, asOfDate: "2026-10-23", computed: 27, selectedUnchanged: true });

    expect(await screen.findByText(/2026-10-23 기준으로 다시 계산했습니다 · 후보 27곳 — 선정은 바꾸지 않았습니다/)).toBeTruthy();
    await waitFor(() => expect(trackReads).toBeGreaterThanOrEqual(2));
    expect((screen.getByRole("button", { name: "지금 재계산" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("실패하면 서버 문구를 보이고 다시 누를 수 있다", async () => {
    reads["/api/paper/track-record"] = () => Promise.resolve({ available: true, computed: false, collection: COLLECTION });
    api.apiPost.mockRejectedValue(new Error("2026-10-23 SPY 이력이 없습니다."));

    await openSelectionTab();
    fireEvent.click(await screen.findByRole("button", { name: "지금 재계산" }));

    expect(await screen.findByText("2026-10-23 SPY 이력이 없습니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "지금 재계산" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
