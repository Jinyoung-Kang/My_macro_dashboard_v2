/**
 * 모의 매매 — 결정 로그 탭의 '주간 복기'(2단계 명세 §3 D1~D6). 서버 값을 그대로 보이고(판정 수·결정 날짜는 서버가 붙인 값), 모르는
 * 값은 "—".
 *
 *  - 결정 로그 → '주간 복기': 시각순 목록(주마다 한 줄 — 상태·창·판정 수·제안·남긴 시각) → 주를 고르면 그 주의 복기(판정 표·반복 오류·지킬 것·제안)를
 *    검사 칸에(jsdom은 좁은 배치 — 대화상자). 가장 최근 주는 화면을 열 때 읽어 둡니다(넓은 배치는 그 주가 고른 줄)
 *  - 제안 링크 → 프레임 탭으로 옮겨 그 제안을 강조(자동 반영 없음 — 승인은 프레임 탭)
 *  - 수동 실행은 확인 단계("Sonnet 5.5 호출 1회(… 최대 약 $0.9 …), 하루 호출 상한에 포함") → POST /api/paper/reviews/run → 결과 한 줄, 서버 400은 경고로
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  // 개요 히어로의 선 차트(히어로 곡선) — 이 시험은 그 그림을 보지 않습니다.
  LineChart: () => null,
  MultiLineSeries: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [],
  books: [book("rules", { kind: "RULES", label: "규칙 계좌" }), book("claude", { kind: "CLAUDE", label: "Claude 계좌" })],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
};

const REVIEWS = {
  available: true,
  latestWeekEnding: "2026-10-30",
  latestOpensAtKst: "2026-10-31 09:00",
  reviews: [
    {
      weekEnding: "2026-10-30", status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5",
      verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 }, proposalId: 12, proposalStatus: "PENDING",
      createdAtKst: "2026-10-31 09:05", error: null, retryCount: 0, retryable: false, frameworkVersion: 1,
    },
    {
      weekEnding: "2026-10-23", status: "SKIPPED", windowWeeks: 4, model: null, verdictCounts: null, proposalId: null,
      proposalStatus: null, createdAtKst: "2026-10-24 09:00", error: "창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다",
      retryCount: 0, retryable: false, frameworkVersion: 0,
    },
  ],
};

const DETAIL = {
  available: true,
  review: {
    weekEnding: "2026-10-30", status: "OK", windowWeeks: 4, trimmedReason: null, model: "claude-sonnet-5-5", frameworkVersion: 1,
    retryCount: 0, retryable: false, createdAtKst: "2026-10-31 09:05", error: null,
    verdictCounts: { 유지: 1, 반증: 1, 판단불가: 0 },
    verdicts: [
      { decisionId: 7, asOf: "2026-10-26", kind: "SCHEDULED", status: "OK", thesisHeld: "유지", note: "체결 뒤 +10.00%, 무효화 미충족" },
      { decisionId: 8, asOf: "2026-10-28", kind: "MANUAL", status: "NO_TRADE", thesisHeld: "반증", note: "관망 뒤 +4% 상승" },
    ],
    missingDecisionIds: [],
    recurringErrors: ["월 재량 상한 근처에서 신규 진입(#7·#8)"],
    keep: ["200일선 위 종목 우선"],
    proposal: { id: 12, status: "PENDING", summary: "월 상한 근처 진입 자제 규칙 추가", operationsCount: 1, baseVersion: 1,
      resultVersion: null, error: null },
    input: { weekEnding: "2026-10-30" }, response: { schemaVersion: 1 },
    usage: { inputTokens: 9000, inputTokensEst: 6100, outputTokens: 1200, estCostUsd: 0.0312, latencyMs: 41000 },
  },
};

const ENGINES = Array.from({ length: 8 }, (_, index) => ({
  id: `E${index + 1}`, name: `엔진 ${index + 1}`,
  rules: [{ id: `E${index + 1}-R1`, text: `규칙 ${index + 1}`, addedIn: 0, sourceNoteId: null }],
}));
const V1 = {
  version: 1, status: "USER", title: "투자 OS 2026-10",
  body: { schemaVersion: 1, title: "투자 OS 2026-10", status: "USER", principles: [{ id: "P1", text: "원칙" }], engines: ENGINES, guidance: "" },
  rendered: "# 투자 OS — v1 (투자 OS 2026-10)", tokensEst: 4000, overBudget: false, changelog: "OS 원문", createdAtKst: "2026-10-25 12:00",
};
const PROPOSAL = (id: number, reviewWeekEnding: string | null) => ({
  id, status: "PENDING", noteId: reviewWeekEnding ? null : 3, model: "claude-sonnet-5-5", summary: `제안 ${id} 요지`,
  operations: [{ op: "ADD_RULE", target: "E5", text: "월 상한의 80%를 넘으면 신규 진입을 미룬다.", why: "#7" }],
  assessment: [], beforeAfter: "전: 없음 / 후: E5-R2", error: null, createdAtKst: "2026-10-31 09:05", decidedAtKst: null,
  resultVersion: null, baseVersion: 1, reviewWeekEnding,
});

let reads: Record<string, () => Promise<unknown>> = {};

function serve(path: string, response: () => unknown) {
  reads[path] = () => Promise.resolve(response());
}

beforeEach(() => {
  reads = {};
  serve("/api/paper/overview", () => OVERVIEW);
  serve("/api/paper/decisions", () => ({ available: true, decisions: [] }));
  serve("/api/paper/reviews", () => REVIEWS);
  serve("/api/paper/reviews/2026-10-30", () => DETAIL);
  serve("/api/paper/settings", () => ({ available: true, version: 1, body: {}, defaults: {}, keys: [] }));
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rowsOf = (table: HTMLElement) =>
  within(table).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));

async function openReviews() {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "결정 로그" }));
  fireEvent.click(await screen.findByRole("button", { name: "주간 복기" }));
}

/** 복기 줄 — 시각순 목록('복기 기록')에서 시각 열이 그 주인 줄 단추. */
async function weekLine(week: string): Promise<HTMLElement> {
  const list = await screen.findByRole("list", { name: "복기 기록" });
  const line = within(list).getAllByRole("button").find((button) => button.querySelector("time")?.textContent === week);
  expect(line, `${week} 줄`).toBeTruthy();
  return line as HTMLElement;
}

/** 그 주 줄을 눌러 복기 한 건을 엽니다(좁은 배치 — 위쪽 대화상자) — 영역 '{주} 주 복기'. */
async function openWeek(week: string): Promise<HTMLElement> {
  fireEvent.click(await weekLine(week));
  return screen.findByRole("region", { name: `${week} 주 복기` });
}

/** 공용 표·속성 목록의 모르는 값 — '—'와 낭독용 '값 없음'(patterns Empty). */
const NONE = "—값 없음";

describe("결정 로그 — 주간 복기", () => {
  it("목록(서버 값 그대로, 판정 수가 없으면 —)과 가장 최근 주의 판정 표·반복 오류·지킬 것·제안", async () => {
    await openReviews();

    expect(await screen.findByText(/가장 최근 복기 주 2026-10-30 · 정기 복기 2026-10-31 09:00 — 이미 남김\(복기 완료\)/)).toBeTruthy();
    // 줄마다 복기 주·종류 태그·상태·창·판정 수·제안·남긴 시각(모르는 판정 수·제안은 '—', 서버 오류 문구는 줄 아래).
    const latest = await weekLine("2026-10-30");
    expect(within(latest).getByText("주간 복기")).toBeTruthy();
    expect(within(latest).getByText("복기 완료")).toBeTruthy();
    expect(within(latest).getByText("창 4주")).toBeTruthy();
    expect(within(latest).getByText("판정 유지 1 · 반증 1 · 판단불가 0")).toBeTruthy();
    expect(latest.textContent).toContain("제안 #12 · 승인 대기 · 남긴 시각 2026-10-31 09:05");
    const skipped = await weekLine("2026-10-23");
    expect(within(skipped).getByText("건너뜀 · 결정 없음")).toBeTruthy();
    expect(within(skipped).getByText("판정 —")).toBeTruthy();
    expect(skipped.textContent).toContain("제안 — · 남긴 시각 2026-10-24 09:00");
    expect(within(skipped).getByText("창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다")).toBeTruthy();
    // 가장 최근 주는 화면을 열 때 읽어 둡니다(줄을 누르면 바로 보임).
    await waitFor(() => expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/reviews/2026-10-30", 0));

    const body = await openWeek("2026-10-30");
    const verdicts = within(body).getAllByRole("table")[0];
    expect(rowsOf(verdicts)).toEqual([
      ["#7", "—", "2026-10-26", "정기", "유지", "체결 뒤 +10.00%, 무효화 미충족"],
      // 반증은 주의 태그 — 낭독기에 '주의: '를 먼저 읽힙니다.
      ["#8", "—", "2026-10-28", "수동", "주의: 반증", "관망 뒤 +4% 상승"],
    ]);
    expect(within(body).getByText("월 재량 상한 근처에서 신규 진입(#7·#8)")).toBeTruthy();
    expect(within(body).getByText("200일선 위 종목 우선")).toBeTruthy();
    expect(within(body).getByText("제안 #12 · 승인 대기")).toBeTruthy();
    expect(within(body).getByText("변경 1건 · 기준 판 v1")).toBeTruthy();
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("목록이 갱신돼 펼친 주의 행이 바뀌면(정기 재시도가 API 오류 → OK·제안) 상세도 다시 읽는다", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const failedRow = { ...REVIEWS.reviews[0], status: "API_ERROR", verdictCounts: null, proposalId: null, proposalStatus: null,
      error: "[HTTP] 500", retryable: true, createdAtKst: "2026-10-31 09:05" };
    const failedDetail = { available: true, review: { ...DETAIL.review, status: "API_ERROR", error: "[HTTP] 500", retryable: true,
      verdicts: [], verdictCounts: null, recurringErrors: [], keep: [], proposal: null, response: null } };
    let state: { list: unknown; detail: unknown } = { list: { ...REVIEWS, reviews: [failedRow, REVIEWS.reviews[1]] }, detail: failedDetail };
    serve("/api/paper/reviews", () => state.list);
    serve("/api/paper/reviews/2026-10-30", () => state.detail);
    await openReviews();
    await openWeek("2026-10-30");
    const region = () => screen.getByRole("region", { name: "2026-10-30 주 복기" });
    expect(await screen.findByText(/API 오류로 끝났습니다/)).toBeTruthy();

    // 09:35 정기 재시도가 OK와 제안 #12를 남김 — 목록만 주기 갱신(탭으로 돌아와 다시 읽기)되고, 상세는 그 변화를 보고 다시 읽음.
    state = { list: { ...REVIEWS, reviews: [{ ...REVIEWS.reviews[0], retryCount: 1, createdAtKst: "2026-10-31 09:35" },
      REVIEWS.reviews[1]] }, detail: DETAIL };
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(within(region()).getByText("제안 #12 · 승인 대기")).toBeTruthy());
    expect(within(region()).queryByText(/API 오류로 끝났습니다/)).toBeNull();
    expect(rowsOf(within(region()).getAllByRole("table")[0])[0]).toEqual(["#7", "—", "2026-10-26", "정기", "유지", "체결 뒤 +10.00%, 무효화 미충족"]);
  });

  it("다른 주를 고르면 그 주를 읽는다 — 건너뜀은 서버 문구 그대로", async () => {
    serve("/api/paper/reviews/2026-10-23", () => ({
      available: true,
      review: { ...DETAIL.review, weekEnding: "2026-10-23", status: "SKIPPED", verdicts: [], verdictCounts: null,
        recurringErrors: [], keep: [], proposal: null, usage: null, model: null,
        error: "창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다" },
    }));
    await openReviews();
    const body = await openWeek("2026-10-23");
    await waitFor(() => expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/reviews/2026-10-23", 0));
    expect(await within(body).findByText("창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다")).toBeTruthy();
    const head = body.querySelector("dl") as HTMLElement;
    expect(within(head).getByText("판정").nextElementSibling?.textContent).toBe(NONE);
    expect(within(body).queryByText(/제안 없음/)).toBeNull();
  });

  it("제안 링크를 누르면 프레임 탭으로 옮겨 그 제안을 강조한다(승인은 프레임 탭에서만)", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [PROPOSAL(13, null), PROPOSAL(12, "2026-10-30")] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [] }));
    const scroll = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll;
    try {
      await openReviews();
      const body = await openWeek("2026-10-30");
      fireEvent.click(within(body).getByRole("button", { name: "프레임 탭에서 이 제안 보기" }));

      expect((await screen.findByRole("tab", { name: "프레임" })).getAttribute("aria-selected")).toBe("true");
      // 주소도 프레임 탭의 것으로(기록을 쌓지 않는 replaceState — lib/paperRoutes).
      expect(window.location.pathname).toBe("/paper/us/framework");
      const focused = await screen.findByText("주간 복기에서 연 제안");
      const article = focused.closest("article") as HTMLElement;
      expect(article.id).toBe("paper-proposal-12");
      expect(article.getAttribute("aria-current")).toBe("true");
      expect(within(article).getByText("주간 복기 2026-10-30")).toBeTruthy();
      expect(document.getElementById("paper-proposal-13")?.getAttribute("aria-current")).toBeNull();
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll).toHaveBeenLastCalledWith({ block: "start", behavior: "smooth" });
      expect(api.apiPost).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("움직임 줄이기(prefers-reduced-motion)를 켰으면 그 제안으로 부드럽게가 아니라 바로 옮긴다", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [PROPOSAL(12, "2026-10-30")] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [] }));
    const scroll = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      await openReviews();
      const body = await openWeek("2026-10-30");
      fireEvent.click(within(body).getByRole("button", { name: "프레임 탭에서 이 제안 보기" }));
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll).toHaveBeenLastCalledWith({ block: "start", behavior: "auto" });
    } finally {
      vi.unstubAllGlobals();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("목록 줄에는 제안 글만(줄 단추 안), 링크는 그 주의 복기 — 찾는 제안이 최근 목록에 없으면 그렇다고", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [PROPOSAL(13, null)] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [] }));
    await openReviews();
    const line = await weekLine("2026-10-30");
    expect(within(line).queryByRole("button")).toBeNull();
    const body = await openWeek("2026-10-30");
    fireEvent.click(within(body).getByRole("button", { name: "프레임 탭에서 이 제안 보기" }));
    expect(await screen.findByText(/제안 #12가 최근 제안 목록\(50건\)에 없습니다/)).toBeTruthy();
  });

  it("수동 실행은 확인(비용·하루 상한) 뒤 POST /api/paper/reviews/run, 결과 한 줄 — 취소하면 부르지 않음, 서버 400은 경고로", async () => {
    await openReviews();
    fireEvent.click(await screen.findByRole("button", { name: "지금 복기 실행" }));
    expect(screen.getByText(/Sonnet 5\.5 호출 1회\(.*최대 약 \$0\.9.*\), 하루 호출 상한에 포함/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(api.apiPost).not.toHaveBeenCalled();

    api.apiPost.mockResolvedValueOnce({ ok: true, outcome: "ALREADY_REVIEWED", review: DETAIL.review });
    fireEvent.click(screen.getByRole("button", { name: "지금 복기 실행" }));
    fireEvent.click(screen.getByRole("button", { name: "복기 실행 확인" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/reviews/run"));
    expect(await screen.findByText("2026-10-30 주 복기가 이미 있습니다(복기 완료) — Claude를 부르지 않았습니다.")).toBeTruthy();

    api.apiPost.mockRejectedValueOnce(new Error("2026-10-30 확정 종가가 아직 없습니다"));
    fireEvent.click(screen.getByRole("button", { name: "지금 복기 실행" }));
    fireEvent.click(screen.getByRole("button", { name: "복기 실행 확인" }));
    expect(await screen.findByText("2026-10-30 확정 종가가 아직 없습니다")).toBeTruthy();
  });

  it("넓은 화면: 가장 최근 주가 고른 줄로 목록 옆 검사 칸에 — 다른 주를 고르면 그 주를 한 번 읽어 그 칸에", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    serve("/api/paper/reviews/2026-10-23", () => ({
      available: true,
      review: { ...DETAIL.review, weekEnding: "2026-10-23", status: "SKIPPED", verdicts: [], verdictCounts: null, recurringErrors: [], keep: [],
        proposal: null, usage: null, model: null, error: "창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다" },
    }));
    await openReviews();

    const inspector = await screen.findByRole("region", { name: "복기 기록 — 2026-10-30 주 복기" });
    expect(await within(inspector).findByRole("region", { name: "2026-10-30 주 복기" })).toBeTruthy();
    expect((await weekLine("2026-10-30")).getAttribute("aria-current")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(await weekLine("2026-10-23"));
    const next = await screen.findByRole("region", { name: "복기 기록 — 2026-10-23 주 복기" });
    expect(await within(next).findByText("창 안에 복기할 Claude 결정이 없어 Claude를 부르지 않았습니다")).toBeTruthy();
    expect(api.apiGetShared.mock.calls.filter(([path]) => path === "/api/paper/reviews/2026-10-23")).toHaveLength(1);
    expect(api.apiGetShared.mock.calls.filter(([path]) => path === "/api/paper/reviews/2026-10-30")).toHaveLength(1);
  });

  it("복기 테이블이 아직 없으면(available:false) 서버 문구 그대로", async () => {
    serve("/api/paper/reviews", () => ({ available: false, message: "모의 매매 테이블이 아직 없습니다 — make up" }));
    await openReviews();
    expect(await screen.findByText("모의 매매 테이블이 아직 없습니다 — make up")).toBeTruthy();
  });
});
