/**
 * 더보기 화면들(/status·/radar·/krx·/alerts·/ai/report·/connections·/admin/users·/account)의 요청과 쓰기 지킴 — 작업대 개편 P7(부분 재배치)이
 * 머리·표·검사 칸·목차를 다시 짜도 화면마다 읽는 경로·간격과 쓰기(경로·메서드·본문·확인 문구·켜짐 조건)가 그대로인지 봅니다.
 * 개편 전 코드에서 통과시켜 두고, 재배치 커밋들이 사례의 뜻을 바꾸지 않고 통과해야 합니다(조작을 찾는 도우미만 개편 뒤 조작도 함께 찾음).
 *
 * - 읽기: 처음 그린 뒤 부른 경로(정확히 일치) 집합과, 걸린 채 남은 1분 이상 간격의 타이머가 다시 읽는 경로(간격별).
 * - 쓰기: 누를 때만 — 열 때 POST·DELETE 0. 이미 다른 시험이 고정한 쓰기(다시 실행·교차 검증·AI 리포트 생성·AI 호출·토스 조회 — actions.test,
 *   운영자로 올리기·회원 만들기 실패 — stateHandling.test)는 여기서 본문만 한 번 더 봅니다.
 * - 에이전트 규칙: 이 시험은 모의 API만 부릅니다(실제 서버로 가는 쓰기 0).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGetShared: vi.fn(),
    UnauthorizedError,
    auth: { changePassword: vi.fn(), logoutOthers: vi.fn(), deleteAccount: vi.fn(), logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/status" }));
// jsdom에서는 차트를 재지 못해 그림은 뺍니다(요청만 봄).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineSeries: () => null,
  MultiLineSeries: () => null,
  HorizontalBars: () => null,
  SignedBars: () => null,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import AccountPage from "../account/page";
import AdminUsersPage from "../admin/users/page";
import AiReportPage from "../ai/report/page";
import AlertsPage from "../alerts/page";
import ConnectionsPage from "../connections/page";
import KrxPage from "../krx/page";
import RadarPage from "../radar/page";
import StatusPage from "../status/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

/** 경로(정확히 일치) → 응답. 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};
let setIntervals: ReturnType<typeof vi.spyOn>;
let clearIntervals: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reads = {};
  signal.token = 0;
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  for (const fn of Object.values(api.auth)) fn.mockReset();
  router.replace.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  setIntervals = vi.spyOn(globalThis, "setInterval");
  clearIntervals = vi.spyOn(globalThis, "clearInterval");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 곧바로 끝나는 응답과 그 뒤 effect를 끝까지 흘려보냅니다. */
async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

/** 부른 경로 목록(부른 차례 그대로). */
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
/** 부른 경로 집합(정렬). */
const pathSet = () => [...new Set(calledPaths())].sort();

/**
 * 걸린 채 남은(지우지 않은) 1분 이상 간격의 타이머를 하나씩 불러 다시 읽은 경로를 모읍니다 — 간격 → 그 간격의 타이머들이 읽은 경로 목록(정렬).
 * (paperRequests.test와 같은 도우미)
 */
async function refreshTimers(): Promise<Record<number, string[]>> {
  const cleared = new Set((clearIntervals.mock.calls as unknown as [unknown][]).map(([id]) => id));
  const calls = setIntervals.mock.calls as unknown as [() => void, number][];
  const results = setIntervals.mock.results as unknown as { value: unknown }[];
  const out: Record<number, string[]> = {};
  for (const [index, [callback, delay]] of calls.entries()) {
    if (typeof delay !== "number" || delay < 60_000 || cleared.has(results[index]?.value)) continue;
    const before = calledPaths().length;
    await act(async () => callback());
    const added = calledPaths().slice(before);
    if (added.length > 0) out[delay] = [...(out[delay] ?? []), ...added].sort();
  }
  return out;
}

/** 열 때 쓰기(POST·DELETE)가 없다. */
function expectNoWrites() {
  expect(api.apiPost).not.toHaveBeenCalled();
  expect(api.apiDelete).not.toHaveBeenCalled();
  for (const fn of Object.values(api.auth)) expect(fn).not.toHaveBeenCalled();
}

const renderAs = (user: SessionUser | undefined, page: ReactElement) => render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);

// ------------------------------------------------------------------ 저장소 상태
const STATUS = {
  readMode: "auto", collectorReachable: true, lastRunStatus: "ok", timeseriesRows: 10, observationRows: 5, radarHistoryDates: ["2026-11-18"],
  taskSummary: [{ task: "macro_collected", speed: "fast", status: "ok", startedAt: "2026-11-18T00:00:00Z", durationMs: 1200, detail: "12건" }],
  snapshots: [{ name: "macro", status: "ok", ageSeconds: 60, stale: false, collectedAt: "2026-11-18T00:00:00Z" }],
  missingDatasets: [], keys: { fred: true },
};
const ISSUES = {
  generatedAt: "2026-11-18 09:00 KST", collectorReachable: true, lookbackHours: 24, lastRunStatus: "ok",
  counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: 0 }, current: [], recent: [], missing: [], text: "",
};

describe("저장소 상태 — 요청과 쓰기", () => {
  it("열 때 개요·오류 로그 둘을 읽고 60초마다 다시 읽는다(공공 API 진단은 누를 때만), 쓰기 0", async () => {
    reads = { [endpoints.status.overview]: STATUS, [endpoints.status.issues]: ISSUES };
    renderAs(OWNER, <StatusPage />);
    await screen.findByRole("heading", { name: "데이터 저장소 상태" });
    await settled();

    expect(pathSet()).toEqual(["/api/status", "/api/status/issues"]);
    expect(await refreshTimers()).toEqual({ 60_000: ["/api/status", "/api/status/issues"] });
    expectNoWrites();
  });

  it("'다시 실행'은 POST /api/status/run/{태스크}(본문 없음), '지금 교차 검증 실행'은 POST /api/verification(본문 없음)", async () => {
    reads = { [endpoints.status.overview]: STATUS, [endpoints.status.issues]: ISSUES };
    api.apiPost.mockReturnValue(new Promise(() => {}));
    renderAs(OWNER, <StatusPage />);

    fireEvent.click(await screen.findByRole("button", { name: "다시 실행" }));
    fireEvent.click(screen.getByRole("button", { name: "지금 교차 검증 실행" }));

    expect(api.apiPost.mock.calls).toEqual([["/api/status/run/macro_collected"], ["/api/verification"]]);
    expect(api.apiDelete).not.toHaveBeenCalled();
  });

  it("'진단 실행'을 누를 때만 공공 API 진단 GET 한 번", async () => {
    reads = { [endpoints.status.overview]: STATUS, [endpoints.status.issues]: ISSUES };
    renderAs(OWNER, <StatusPage />);
    await screen.findByRole("heading", { name: "데이터 저장소 상태" });
    await settled();
    expect(calledPaths().filter((path) => path.startsWith("/api/status/public-apis"))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "진단 실행" }));
    await settled();

    const diagnostics = calledPaths().filter((path) => path.startsWith("/api/status/public-apis"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^\/api\/status\/public-apis\?run=\d+$/);
    expectNoWrites();
  });
});

// ------------------------------------------------------------------ 수급 레이더
const RANKING_PATH = endpoints.positioning.radarRanking({ market: "KOSPI", investor: "외국인", tradeType: "순매수", intervalType: "TODAY", topN: "30" });
const CONSENSUS_PATH = endpoints.positioning.radarConsensus({ market: "KOSPI", tradeType: "순매수", intervalType: "TODAY", topN: "30" });
const HISTORY_PATH = endpoints.positioning.radarHistory({ market: "KOSPI", investor: "외국인", tradeType: "순매수", obsDate: "" });

function radarReads() {
  reads = {
    [endpoints.positioning.radarOptions]: {
      markets: ["KOSPI", "KOSDAQ"], investors: ["외국인", "기관"], tradeTypes: ["순매수", "순매도"], intervals: ["TODAY", "DAYS_5"],
    },
    [RANKING_PATH]: {
      available: true, market: "KOSPI", investor: "외국인", tradeType: "순매수", readMode: "auto", source: "합성 순위", sourceKind: "krx",
      isHistorical: false, historyDate: null, intervalType: "TODAY", dataDate: "2026-11-18",
      rows: [
        { rank: 1, code: "000002", name: "합성화학", price: 2000, changePct: -0.5, netAmountEok: -3.2 },
        { rank: 2, code: "000001", name: "합성전자", price: 1000, changePct: 1.2, netAmountEok: 10 },
      ],
    },
    [endpoints.positioning.investorFlows]: { markets: {} },
    [endpoints.positioning.stockFlows("000001,000002")]: { stocks: [] },
    [endpoints.publicData.fundamentals("000001,000002")]: { available: false, message: "합성 — 재무 없음" },
    [CONSENSUS_PATH]: { available: false, rows: [], message: "공통 종목이 없습니다." },
    [HISTORY_PATH]: { dates: [], note: "합성", rows: [] },
  };
}

describe("수급 레이더 — 요청", () => {
  it("열 때 일곱 경로(조건·순위·시장 전체·지속성·재무·공통·이력), 순위·공통 60초·시장 전체·지속성 300초, 진단은 읽지 않음, 쓰기 0", async () => {
    radarReads();
    renderAs(OWNER, <RadarPage />);
    await screen.findByText("합성전자");
    await settled();

    expect(pathSet()).toEqual([...new Set([
      CONSENSUS_PATH, HISTORY_PATH, endpoints.positioning.investorFlows, endpoints.positioning.stockFlows("000001,000002"),
      endpoints.publicData.fundamentals("000001,000002"), endpoints.positioning.radarOptions, RANKING_PATH,
    ])].sort());
    expect(await refreshTimers()).toEqual({
      60_000: [CONSENSUS_PATH, RANKING_PATH].sort(),
      300_000: [endpoints.positioning.investorFlows, endpoints.positioning.stockFlows("000001,000002")].sort(),
    });
    expectNoWrites();
  });

  it("운영자가 '데이터 소스 연결 테스트'를 열 때만 진단 GET 한 번(회원에게는 단추가 없음)", async () => {
    radarReads();
    renderAs(OWNER, <RadarPage />);
    await screen.findByText("합성전자");
    await settled();
    expect(calledPaths()).not.toContain(endpoints.positioning.radarDiagnostics);

    fireEvent.click(screen.getByRole("button", { name: "데이터 소스 연결 테스트" }));
    await settled();
    expect(calledPaths().filter((path) => path === endpoints.positioning.radarDiagnostics)).toHaveLength(1);
    cleanup();

    radarReads();
    renderAs(MEMBER, <RadarPage />);
    await screen.findByText("합성전자");
    expect(screen.queryByRole("button", { name: "데이터 소스 연결 테스트" })).toBeNull();
    expectNoWrites();
  });
});

// ------------------------------------------------------------------ 국내 파생
describe("국내 파생(KRX) — 요청", () => {
  it("열 때 다섯 경로, 선물·투자주체·현물선물 300초·장중 60초(증시 규모는 한 번), 쓰기 0", async () => {
    reads = {
      [endpoints.positioning.krxFutures(60)]: { available: false, message: "합성" },
      [endpoints.positioning.krxInvestorTrend]: { available: false },
      [endpoints.positioning.krxIntraday(30)]: { available: false, skipped: true, message: "장 시간이 아닙니다" },
      [endpoints.positioning.krxSpotFutures]: { available: false },
      [endpoints.publicData.marketTotals(180)]: { available: false, message: "합성" },
    };
    renderAs(OWNER, <KrxPage />);
    await screen.findByRole("heading", { name: "국내 파생 & 투기세력 (KRX)" });
    await settled();

    expect(pathSet()).toEqual([
      endpoints.positioning.krxFutures(60), endpoints.positioning.krxInvestorTrend, endpoints.positioning.krxIntraday(30),
      endpoints.positioning.krxSpotFutures, endpoints.publicData.marketTotals(180),
    ].sort());
    expect(await refreshTimers()).toEqual({
      60_000: [endpoints.positioning.krxIntraday(30)],
      300_000: [endpoints.positioning.krxFutures(60), endpoints.positioning.krxInvestorTrend, endpoints.positioning.krxSpotFutures].sort(),
    });
    expectNoWrites();
  });
});

// ------------------------------------------------------------------ 알림
const RULE = { id: 3, kind: "REGIME_CHANGE", params: {}, enabled: true, description: "국면 전환", createdAt: "2026-11-01" };
const INBOX_ITEM = { id: 7, kind: "REGIME_CHANGE", occurredOn: "2026-11-18", title: "[국면 전환] 확장", body: "본문", late: false, createdAt: "2026-11-18", read: false };

function alertsReads(items: unknown[] = [INBOX_ITEM]) {
  reads = {
    [endpoints.alerts.inbox(50)]: { available: true, unread: items.length, items },
    [endpoints.alerts.rules]: { available: true, limit: 5, rules: [RULE] },
    [endpoints.institution.institutions]: { institutions: [{ cik: "0001067983", name: "버크셔 해서웨이" }] },
  };
}

/** 알림 한 줄의 '읽음' 단추 — 개편 전은 줄 안, 개편 뒤는 줄을 고른 검사 칸(넓은 화면 옆 칸·좁은 화면 대화상자) 안. */
async function inboxReadButton(title: string): Promise<HTMLElement> {
  await screen.findAllByText(title);
  const inline = screen.queryByRole("button", { name: "읽음" });
  if (inline) return inline;
  fireEvent.click(screen.getAllByText(title)[0]);
  return screen.findByRole("button", { name: "읽음" });
}

describe("알림 — 요청과 쓰기", () => {
  it("열 때 알림함(50건, 300초)·규칙·기관 목록, 쓰기 0", async () => {
    alertsReads();
    renderAs(MEMBER, <AlertsPage />);
    await screen.findAllByText("[국면 전환] 확장");
    await settled();

    expect(pathSet()).toEqual([endpoints.alerts.inbox(50), endpoints.alerts.rules, endpoints.institution.institutions].sort());
    expect(await refreshTimers()).toEqual({ 300_000: [endpoints.alerts.inbox(50)] });
    expectNoWrites();
  });

  it("'모두 읽음'은 {all:true}, 줄 '읽음'은 {ids:[id]} — 같은 경로 POST", async () => {
    alertsReads();
    api.apiPost.mockResolvedValue({ changed: 1 });
    renderAs(MEMBER, <AlertsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "모두 읽음" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    fireEvent.click(await inboxReadButton("[국면 전환] 확장"));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(2));

    expect(api.apiPost.mock.calls).toEqual([
      ["/api/alerts/inbox/read", { all: true }],
      ["/api/alerts/inbox/read", { ids: [7] }],
    ]);
  });

  it("규칙: 만들기 {kind, params}(종류마다), 켜기·끄기 POST {enabled}, 지우기 DELETE(확인 없음)", async () => {
    alertsReads([]);
    api.apiPost.mockResolvedValue({ ok: true, message: "됐습니다." });
    api.apiDelete.mockResolvedValue({ ok: true, message: "지웠습니다." });
    const confirm = vi.spyOn(window, "confirm");
    renderAs(MEMBER, <AlertsPage />);
    const create = await screen.findByRole("button", { name: "규칙 만들기" });
    await settled();

    // 국면 전환 — 변수 없음.
    fireEvent.click(create);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    // 외국인 연속 순매수 — 시장 전체(코스피), 5일.
    fireEvent.change(screen.getByLabelText("알림 종류"), { target: { value: "FOREIGN_STREAK" } });
    fireEvent.click(screen.getByRole("button", { name: "규칙 만들기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(2));
    // 관심 종목 — 코드가 여섯 자리일 때만 켜짐.
    fireEvent.change(screen.getByLabelText("대상"), { target: { value: "STOCK" } });
    expect((screen.getByRole("button", { name: "규칙 만들기" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("종목코드(6자리)"), { target: { value: "005930" } });
    fireEvent.change(screen.getByLabelText("연속 일수"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "규칙 만들기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(3));
    // 13F 신규 — 기관을 고를 때만 켜짐.
    fireEvent.change(screen.getByLabelText("알림 종류"), { target: { value: "INSTITUTION_NEW" } });
    expect((screen.getByRole("button", { name: "규칙 만들기" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("관심 기관"), { target: { value: "0001067983" } });
    fireEvent.click(screen.getByRole("button", { name: "규칙 만들기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(4));

    fireEvent.click(screen.getByRole("button", { name: "켜짐 — 끄기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(5));
    fireEvent.click(screen.getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledTimes(1));

    expect(api.apiPost.mock.calls).toEqual([
      ["/api/alerts/rules", { kind: "REGIME_CHANGE", params: {} }],
      ["/api/alerts/rules", { kind: "FOREIGN_STREAK", params: { target: "KOSPI", n: 5 } }],
      ["/api/alerts/rules", { kind: "FOREIGN_STREAK", params: { target: "STOCK", n: 10, code: "005930" } }],
      ["/api/alerts/rules", { kind: "INSTITUTION_NEW", params: { cik: "0001067983" } }],
      ["/api/alerts/rules/3", { enabled: false }],
    ]);
    expect(api.apiDelete.mock.calls).toEqual([["/api/alerts/rules/3"]]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ AI 리포트·연결 테스트
const ENGINES = {
  enabled: true,
  engines: [{ id: "auto", label: "자동", provider: "auto", model: null, description: "", available: true, unavailableReason: null }],
  keys: {},
};

describe("AI 리포트 — 요청과 쓰기", () => {
  it("열 때 엔진·리포트 종류·원본 텍스트(한 번씩, 자동 갱신 없음), 생성은 {engineId, reportType, extraInstruction} — 열 때 쓰기 0", async () => {
    reads = {
      [endpoints.ai.engines]: ENGINES,
      [endpoints.ai.reportTypes]: { types: ["종합 매크로 브리핑"] },
      [endpoints.snapshot.text]: { text: "원본", generatedAtKst: "2026-11-18 09:00 KST", chars: 2 },
    };
    api.apiPost.mockReturnValue(new Promise(() => {}));
    renderAs(MEMBER, <AiReportPage />);
    const generate = (await screen.findByRole("button", { name: "리포트 생성" })) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    await settled();

    expect(pathSet()).toEqual([endpoints.ai.engines, endpoints.ai.reportTypes, endpoints.snapshot.text].sort());
    expect(await refreshTimers()).toEqual({});
    expectNoWrites();

    fireEvent.change(screen.getByLabelText(/추가 지시/), { target: { value: "선물에 집중" } });
    fireEvent.click(generate);
    expect(api.apiPost.mock.calls).toEqual([["/api/ai/report", { engineId: "auto", reportType: "종합 매크로 브리핑", extraInstruction: "선물에 집중" }]]);
  });
});

describe("연결 테스트 — 요청과 쓰기", () => {
  it("열 때 엔진 목록 한 번(토스 진단은 누를 때만), 호출은 POST /api/ai/test?engineId=&prompt=(본문 없음), 토스 조회는 GET", async () => {
    reads = { [endpoints.ai.engines]: ENGINES };
    api.apiPost.mockReturnValue(new Promise(() => {}));
    api.apiGet.mockReturnValue(new Promise(() => {}));
    renderAs(OWNER, <ConnectionsPage />);
    const call = (await screen.findByRole("button", { name: "선택 모델 호출" })) as HTMLButtonElement;
    await waitFor(() => expect(call.disabled).toBe(false));
    await settled();

    expect(pathSet()).toEqual([endpoints.ai.engines]);
    expect(await refreshTimers()).toEqual({});
    expectNoWrites();

    fireEvent.click(call);
    expect(api.apiPost.mock.calls).toEqual([[endpoints.ai.test("auto", "한국어로 한 문장만 답하십시오: 지금 연결이 정상인지 알려 주세요.")]]);

    fireEvent.click(screen.getByRole("button", { name: "진단 실행" }));
    await settled();
    expect(calledPaths().filter((path) => path.startsWith("/api/ai/toss/diagnostics"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "환율 조회 (USD → KRW)" }));
    expect(api.apiGet.mock.calls).toEqual([[endpoints.toss.exchangeRate("USD", "KRW")]]);
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ 사용자 관리
const MEMBER_ROW = { id: 7, email: "m@test.local", role: "MEMBER", tier: "FREE", verified: true, createdAt: "2026-10-01T00:00:00Z" };

describe("사용자 관리 — 요청과 쓰기", () => {
  it("열 때 사용자·감사(100건) 한 번씩, 쓰기 0", async () => {
    reads = { [endpoints.admin.users]: { users: [MEMBER_ROW] }, [endpoints.admin.audit(100)]: { entries: [] } };
    renderAs(OWNER, <AdminUsersPage />);
    await screen.findAllByText("m@test.local");
    await settled();

    expect(pathSet()).toEqual([endpoints.admin.audit(100), endpoints.admin.users].sort());
    expect(await refreshTimers()).toEqual({});
    expectNoWrites();
  });

  it("등급 바꾸기 {role, tier}, 운영자로 올리기는 대화상자(문구·닫기 단추 없음) 뒤 {role, tier, password}, 회원 만들기 {email, password, tier}", async () => {
    reads = { [endpoints.admin.users]: { users: [MEMBER_ROW] }, [endpoints.admin.audit(100)]: { entries: [] } };
    api.apiPost.mockResolvedValue({ ok: true, message: "됐습니다." });
    renderAs(OWNER, <AdminUsersPage />);

    fireEvent.change(await screen.findByLabelText("m@test.local 등급"), { target: { value: "PRO" } });
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByLabelText("m@test.local 역할") as HTMLSelectElement).disabled).toBe(false));

    fireEvent.change(screen.getByLabelText("m@test.local 역할"), { target: { value: "OWNER" } });
    const dialog = await screen.findByRole("dialog", { name: "운영자로 올리기" });
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText(/회원을 운영자로 올립니다\. 운영자는 모든 설정과 실제 매매/).textContent).toBe(
      "m@test.local 회원을 운영자로 올립니다. 운영자는 모든 설정과 실제 매매 화면을 쓸 수 있습니다. 계속하려면 지금 운영자 계정의 비밀번호를 입력하세요(로그인 없이 연 화면에서는 첫 운영자 계정의 비밀번호).",
    );
    // 닫기(×) 단추가 없고, 단추는 취소·운영자로 올리기 둘뿐입니다.
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["취소", "운영자로 올리기"]);
    fireEvent.change(within(dialog).getByLabelText("운영자 비밀번호"), { target: { value: "owner pass" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "운영자로 올리기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "new@test.local" } });
    fireEvent.change(screen.getByLabelText("처음 비밀번호(10자 이상)"), { target: { value: "Abcdefgh1234!" } });
    fireEvent.change(screen.getByLabelText("등급"), { target: { value: "PRO" } });
    fireEvent.click(screen.getByRole("button", { name: "회원 만들기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(3));

    expect(api.apiPost.mock.calls).toEqual([
      ["/api/admin/users/7", { role: "MEMBER", tier: "PRO" }],
      ["/api/admin/users/7", { role: "OWNER", tier: "FREE", password: "owner pass" }],
      ["/api/admin/users", { email: "new@test.local", password: "Abcdefgh1234!", tier: "PRO" }],
    ]);
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ 내 계정
describe("내 계정 — 요청과 쓰기", () => {
  const session = (user: SessionUser) => ({ authenticated: true, readMode: "auto", noLogin: false, user });

  it("열 때 세션·기기 목록 한 번씩(자동 갱신 없음), 쓰기 0", async () => {
    reads = {
      [endpoints.auth.session]: session(MEMBER),
      [endpoints.auth.sessions]: { sessions: [] },
    };
    renderAs(MEMBER, <AccountPage />);
    await screen.findByText("비밀번호 변경");
    await settled();

    expect(pathSet()).toEqual([endpoints.auth.session, endpoints.auth.sessions].sort());
    expect(await refreshTimers()).toEqual({});
    expectNoWrites();
  });

  it("비밀번호 변경(지금·새 — 확인이 다르면 꺼짐), 다른 기기 모두 로그아웃, 계정 지우기(확인 창 문구 그대로 — 취소하면 보내지 않음)", async () => {
    reads = {
      [endpoints.auth.session]: session(MEMBER),
      [endpoints.auth.sessions]: { sessions: [] },
    };
    api.auth.changePassword.mockResolvedValue({ ok: true, message: "바꿨습니다." });
    api.auth.logoutOthers.mockResolvedValue({ ok: true, revoked: 2 });
    api.auth.deleteAccount.mockResolvedValue({ ok: true, message: "지웠습니다." });
    const confirm = vi.spyOn(window, "confirm");
    renderAs(MEMBER, <AccountPage />);
    await screen.findByText("비밀번호 변경");

    fireEvent.change(screen.getByLabelText("지금 비밀번호"), { target: { value: "old pass word" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "new pass word 1" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "new pass word 2" } });
    const submit = screen.getByRole("button", { name: "비밀번호 바꾸기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "new pass word 1" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(api.auth.changePassword).toHaveBeenCalledTimes(1));
    expect(api.auth.changePassword.mock.calls[0]).toEqual(["old pass word", "new pass word 1"]);

    fireEvent.click(screen.getByRole("button", { name: "다른 기기 모두 로그아웃" }));
    await waitFor(() => expect(api.auth.logoutOthers).toHaveBeenCalledTimes(1));
    expect(api.auth.logoutOthers.mock.calls[0]).toEqual([]);

    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "delete pass" } });
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "계정 지우기" }));
    expect(confirm.mock.calls).toEqual([["계정을 지울까요? 되돌릴 수 없습니다."]]);
    expect(api.auth.deleteAccount).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "계정 지우기" }));
    await waitFor(() => expect(api.auth.deleteAccount).toHaveBeenCalledTimes(1));
    expect(api.auth.deleteAccount.mock.calls[0]).toEqual(["delete pass"]);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
  });
});
