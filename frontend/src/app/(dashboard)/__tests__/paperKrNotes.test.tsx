/**
 * 🧪 모의매매(한국) 메모 탭(/paper/kr/notes, 2단계 명세 §4-16 F1b) — 네 상태 이야기와 한국 쓰기.
 *
 *  - 불러오는 중: 메모 목록이 오기 전에는 읽는 중 표시
 *  - 빈 상태: 한국 메모가 없다고(만료 메모 보기 안내) — 목록은 `?market=KR`
 *  - 오류: 목록을 못 읽으면 오류 + 다시 시도
 *  - 자료: 한국 메모 목록·KRX 기준일 안내, 저장 본문에 market:"KR", 달력이 모르는 해(referenceDateReason)는 사유와 '유효 여부 모름',
 *    쉬는 한국 문구(쉬어도 메모는 받음)
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const OVERVIEW = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-10-29", books: [], navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
  claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
};

const NOTE = {
  id: 21, kind: "MARKET", asOfDate: "2026-10-28", expiresOn: "2026-11-02", title: "외국인 반도체 매수", body: "삼성전자·하이닉스 순매수 지속",
  archived: false, active: true, createdAtKst: "2026-10-28 21:10 KST",
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve(OVERVIEW),
    "/api/paper/settings": () => Promise.resolve({ available: true, version: 4, body: { notesDefaultExpiryTradingDays: 3 }, keys: [] }),
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (reads[path]
    ? reads[path]()
    : Promise.reject(new Error(`예상하지 않은 경로 ${path}`))));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderNotes = () => render(<PaperPage market="KR" initialTab="notes" />);
const LIST = "/api/paper/notes?includeExpired=false&market=KR";

describe("한국 메모 탭", () => {
  it("불러오는 중: 목록이 오기 전에는 읽는 중 표시 — 탭은 '준비 중'이 아님", async () => {
    reads[LIST] = () => new Promise(() => {});
    renderNotes();
    expect(await screen.findByText("메모를 읽는 중…")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "메모" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();
  });

  it("빈 상태: 한국 메모가 없음 — 목록은 ?market=KR, 미국 목록은 읽지 않음", async () => {
    reads[LIST] = () => Promise.resolve({ available: true, market: "KR", dormantReason: null, referenceDate: "2026-10-28", notes: [] });
    renderNotes();
    expect(await screen.findByText(/유효한 메모가 없습니다/)).toBeTruthy();
    expect(screen.getByText(/한국 시황 메모\(MARKET\)는 기준일~만료일 사이 한국 Claude 계좌 결정 패킷\(섹션 11\)에만/)).toBeTruthy();
    expect(screen.getByText(/유효 여부는 2026-10-28 기준/)).toBeTruthy();
    const paths = api.apiGetShared.mock.calls.map(([path]) => path);
    expect(paths).toContain(LIST);
    expect(paths).not.toContain("/api/paper/notes?includeExpired=false");
  });

  it("오류: 목록을 못 읽으면 오류 + 다시 시도", async () => {
    let fail = true;
    reads[LIST] = () => (fail
      ? Promise.reject(new Error("메모 응답 500"))
      : Promise.resolve({ available: true, market: "KR", referenceDate: "2026-10-28", notes: [NOTE] }));
    renderNotes();
    expect(await screen.findByText("메모 응답 500")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("외국인 반도체 매수")).toBeTruthy();
  });

  it("자료: 한국 메모 목록·KRX 기준일·만료 안내, 저장 본문에 market:\"KR\"", async () => {
    reads[LIST] = () => Promise.resolve({ available: true, market: "KR", dormantReason: null, referenceDate: "2026-10-28", notes: [NOTE] });
    api.apiPost.mockResolvedValue({
      ok: true, market: "KR", dormantReason: null,
      note: { ...NOTE, id: 22, title: "환율", body: "원/달러 1,420", asOfDate: "2026-10-28", expiresOn: "2026-11-02" },
    });
    renderNotes();
    expect(await screen.findByText("외국인 반도체 매수")).toBeTruthy();
    expect(screen.getByText("유효 — 패킷에 실음")).toBeTruthy();
    // 제목·본문 칸의 최소 폭 — 390px에서 다른 칸(줄바꿈 없음)에 눌려 제목이 한 글자씩 세로로 쌓이지 않게(jsdom에는 배치가 없어 칸 정의로 확인).
    expect(screen.getByRole("columnheader", { name: "제목·본문" }).className).toContain("min-w-[12rem]");

    const form = screen.getByRole("form", { name: "메모 쓰기" });
    expect(within(form).getByText(
      "비우면 2026-10-28(마지막으로 끝난 한국 세션 — KRX 달력). 오늘(KST) 날짜를 고르면 오늘 밤 결정(기준 거래일 = 오늘 세션)부터 실립니다. "
        + "오늘보다 뒤 날짜는 서버가 거절합니다.",
    )).toBeTruthy();
    expect(await within(form).findByText("비우면 기본 +3 KRX 거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays, 두 책 공용)")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("제목"), { target: { value: "환율" } });
    fireEvent.change(within(form).getByLabelText("본문"), { target: { value: "원/달러 1,420" } });
    fireEvent.click(within(form).getByRole("button", { name: "메모 저장" }));
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/notes", { kind: "MARKET", title: "환율", body: "원/달러 1,420", market: "KR" });
    expect(await within(form).findByText(/시황 메모\(#22\)를 저장했습니다 — 기준일 2026-10-28 · 만료 2026-11-02/)).toBeTruthy();
  });

  it("달력이 모르는 해: 기준일 대신 사유 — 목록의 시황 메모는 '유효 여부 모름'(패킷 밖으로 읽지 않음)", async () => {
    reads[LIST] = () => Promise.resolve({
      available: true, market: "KR", dormantReason: null, referenceDate: null,
      referenceDateReason: "KRX 달력에 2027년 휴장일이 없음(공휴일 저장본 없음)", notes: [{ ...NOTE, active: null }],
    });
    renderNotes();
    expect(await screen.findByText(/KRX 달력에 2027년 휴장일이 없음/)).toBeTruthy();
    expect(screen.getByText(/새 메모는 서버가 거절합니다\(400\)/)).toBeTruthy();
    expect(screen.getByText("유효 여부 모름")).toBeTruthy();
    expect(screen.queryByText("패킷 밖 — 만료·기준일 전")).toBeNull();
    expect(screen.getByText(/^비우면 마지막으로 끝난 한국 세션\(KRX 달력\)/)).toBeTruthy();
  });

  it("쉬는 한국: 쉬어도 메모는 쓸 수 있다는 한 줄과 사유", async () => {
    const reason = "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다";
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...OVERVIEW, dormantReason: reason, startDate: null, initialized: false });
    reads[LIST] = () => Promise.resolve({ available: true, market: "KR", dormantReason: reason, referenceDate: "2026-10-28", notes: [] });
    renderNotes();
    expect(await screen.findByText(/한국 책이 쉬는 동안에도 메모는 쓸 수 있습니다/)).toBeTruthy();
    // 사유는 화면 맨 위 배너 한 곳(메모 카드에서 되풀이하지 않음).
    await waitFor(() => expect(screen.getAllByText(new RegExp("PAPER_KR_START_DATE"))).toHaveLength(1));
    // 출발일이 없으면 날짜 없이 '출발 결정도 같은 규칙'.
    expect(screen.getByText(/\(출발 결정도 같은 규칙\)/)).toBeTruthy();
  });
});
