/**
 * 장중 시세 카드(LiveValuationCard) — 고정하는 규칙
 *  - 계좌 표는 없고(계좌 숫자는 개요의 지금 값), 고른 계좌(bookCode — 없거나 응답에 없으면 첫 계좌)의 종목 장중가와 기준 시각
 *  - 서버가 새 시세를 요청한 응답이면(refreshRequested) 20초 뒤 한 번만 더 읽는다(되풀이 없음)
 *  - 간격 선택(끄기·5·10·30초·1분~3시간 — 실시간 시세 주기, lib/livePrices)은 이 브라우저에 기억되고(기본 1시간, 2026-11-03), 장 밖에서는 다시
 *    읽지 않는다. 계좌 숫자의 장중 저장본은 1분보다 짧게 다시 읽지 않는다(종목 가격만 실시간 시세 — SSE, 시험 환경에는 EventSource가 없음)
 *  - 새 장중 값(판이 바뀐 응답)을 받으면 onUpdated를 한 번 — 첫 응답·같은 판이면 부르지 않고, 부른다고 /live를 다시 읽지 않는다
 *  - 숨긴 탭에서는 '한 번 더'·'다음 개장' 깨우기가 읽지 않고, 다시 보일 때 한 번(QA-154). 숨긴 탭으로 열리면 처음 보일 때 읽는다(QA-156)
 *  - 미룬 '한 번 더'를 useApi의 탭 복귀 읽기에 넘기면 그 복귀 읽기는 보통 읽기 — 응답이 새 수집을 요청했으면 20초 뒤 한 번 더(QA-157), 간격이 끄기여도(QA-159)
 *  - 한 번 더 읽기가 실패해도 다음 응답의 새 수집 요청은 20초 뒤 한 번 더(QA-162) — 다른 읽기가 같은 문구로 먼저 실패했어도(QA-163)
 *  - 시계는 고정한다(QA-155) — 다음 개장 깨우기가 지금 시각으로 기다릴 시간을 정하므로, 진짜 시계면 돌린 때에 따라 결과가 달라진다
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

import { LiveValuationCard } from "@/components/screens/paper/LiveValuationCard";
import { resetLiveSecondsForTest } from "@/hooks/useLiveSeconds";

const SESSION = {
  phase: "REGULAR", sessionDate: "2026-10-30", openAtKst: "2026-10-30 22:30 KST", closeAtKst: "2026-10-31 05:00 KST",
  nextOpenAtKst: "2026-11-02 23:30 KST",
};

function live(over: Record<string, unknown> = {}) {
  return {
    available: true, market: "US", currency: "USD", nowKst: "2026-10-30 23:59 KST", session: SESSION, isEstimated: true,
    quotes: { source: "Yahoo(yfinance) 1분봉", collectedAtKst: "2026-10-30 23:58 KST", refreshRequested: false, missing: [], error: null },
    books: [{
      code: "claude", label: "Claude 계좌", status: "ACTIVE", initialCash: 100000, cash: 10000, nav: 100000, returnPct: 0,
      previousNav: 99000, previousTradingDate: "2026-10-29", dayChangePct: 1.01, basis: "LIVE", basisAtKst: "2026-10-30 23:58 KST",
      liveCount: 1, positionCount: 1,
      positions: [{ ticker: "AAA", qty: 100, avgCost: 400, price: 420, priceAtKst: "2026-10-30 23:58 KST", priceBasis: "LIVE",
        value: 42000, weightPct: 42, returnPct: 5, previousClose: 410, dayChangePct: 2.44 }],
    }],
    ...over,
  };
}

/** 고정 시계 — 고정 응답의 지금(nowKst 2026-10-30 23:59 KST). 다음 개장(2026-11-02 23:30 KST)까지 하루가 넘게 남아 장 밖에서는 깨어나지 않습니다. */
const NOW = Date.UTC(2026, 9, 30, 14, 59);

beforeEach(() => {
  // Date까지 가짜로 두고 시각을 고정합니다(QA-155) — 카드의 다음 개장 깨우기가 진짜 벽시계를 읽지 않게.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  resetLiveSecondsForTest();
  api.apiGetShared.mockReset();
  // 끄기(0)의 실시간 시세 한 번 읽기(GET /api/live/prices) — 이 시험들은 장중 저장본 읽기(/api/paper/live)만 셉니다.
  api.apiGet.mockReset();
  api.apiGet.mockResolvedValue({ available: false, message: "시험" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 가짜 시계에서는 findBy가 기다리지 못합니다 — 시계를 조금 움직여 응답(약속)과 상태 갱신을 흘려보냅니다. */
async function settle(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const liveCalls = () => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/paper/live")).length;

describe("정규장", () => {
  it("'장중 시세 (추정)' — 계좌 표 없이 고른 계좌의 종목 장중가와 기준 시각", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    render(<LiveValuationCard bookCode="claude" />);

    await settle();
    expect(screen.getByRole("heading", { name: "장중 시세 (추정)" })).toBeTruthy();
    expect(screen.getByText(/정규장 — 장중 1분봉 시세로 다시 평가/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "계좌별 장중 평가" })).toBeNull();
    const positions = screen.getByRole("table", { name: "Claude 계좌 보유 종목 장중가" });
    expect(within(positions).getByText("AAA")).toBeTruthy();
    expect(within(positions).getByText("+2.44%")).toBeTruthy();
    expect(within(positions).getByText("장중 10-30 23:58")).toBeTruthy();
    expect(screen.getByText(/보유 종목 — 계좌 행을 누르면 그 계좌로 바뀝니다/)).toBeTruthy();
    expect(screen.getByText("정규장 동안 종목 가격은 1시간마다 서버가 보내 주고(실시간 시세), 계좌 숫자는 1시간마다 다시 읽습니다(이 화면을 보는 동안만)."))
      .toBeTruthy();
    // 기본 1시간 — 그 사이 매시 장부 관측이 돌아 지금 값이 대개 장부 단계라는 안내(미국)
    expect(screen.getByText(/^간격이 길면/)).toBeTruthy();
    // 종목을 누르면 화면 안 팝업 창(사용자 결정 2026-11-03) — 창 안에 상세 화면 링크
    fireEvent.click(within(positions).getByRole("button", { name: "AAA" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "AAA" });
    expect(within(dialog).getByRole("link", { name: "상세 화면 열기" }).getAttribute("href")).toBe("/s/us/AAA");
    expect(screen.getByText(/표시 전용 — 장부\(체결·순자산 줄·통계·결정\)는 이 시세를 쓰지 않음 · 계좌의 지금 값\(장중 추정\)은 이 시세로 평가한 값/))
      .toBeTruthy();
  });

  it("종목 표는 고른 계좌를 따른다 — 없거나 모르는 계좌면 첫 계좌, 현금뿐이면 빈 표 안내, 바꿔도 다시 읽지 않음", async () => {
    const claude = live().books[0];
    const rules = { ...claude, code: "rules", label: "규칙 계좌", liveCount: 0, positionCount: 0, positions: [] };
    api.apiGetShared.mockImplementation(() => Promise.resolve(live({ books: [claude, rules] })));
    const { rerender } = render(<LiveValuationCard bookCode="rules" />);

    await settle();
    const empty = screen.getByRole("table", { name: "규칙 계좌 보유 종목 장중가" });
    expect(within(empty).getByText("보유 종목이 없습니다(현금뿐).")).toBeTruthy();

    rerender(<LiveValuationCard bookCode={null} />);
    expect(screen.getByRole("table", { name: "Claude 계좌 보유 종목 장중가" })).toBeTruthy();
    rerender(<LiveValuationCard bookCode="gone" />);
    expect(screen.getByRole("table", { name: "Claude 계좌 보유 종목 장중가" })).toBeTruthy();
    expect(liveCalls()).toBe(1);
  });

  it("서버가 새 시세를 요청했으면 20초 뒤 한 번만 더 읽는다", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
    render(<LiveValuationCard />);
    await settle();
    expect(screen.getByText(/정규장 —/)).toBeTruthy();
    expect(liveCalls()).toBe(1);

    await settle(20_000);
    expect(liveCalls()).toBe(2);
    // 다시 읽은 응답도 refreshRequested지만 또 예약하지 않습니다.
    await settle(60_000);
    expect(liveCalls()).toBe(2);
  });

  it("간격을 바꾸면 기억하고 그 간격으로 다시 읽는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    render(<LiveValuationCard />);
    await settle();
    expect(screen.getByText(/정규장 —/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("새로고침 주기"), { target: { value: "60" } });
    expect(window.localStorage.getItem("live.priceRefreshSeconds")).toBe("60");
    await settle(60_000);
    expect(liveCalls()).toBe(2);
    // 5초를 골라도 장중 저장본(계좌 숫자)은 1분보다 짧게 다시 읽지 않습니다 — 종목 가격만 실시간 시세
    fireEvent.change(screen.getByLabelText("새로고침 주기"), { target: { value: "5" } });
    expect(screen.getByText(/종목 가격은 5초마다 서버가 보내 주고\(실시간 시세\), 계좌 숫자는 1분마다 다시 읽습니다/)).toBeTruthy();
    await settle(30_000);
    expect(liveCalls()).toBe(2);
    await settle(30_000);
    expect(liveCalls()).toBe(3);
  });

  it("1시간을 고르면 기억하고 한 시간마다 다시 읽는다 — 다시 열어도 1시간(저장된 3600이 살아남음)", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    const { unmount } = render(<LiveValuationCard />);
    await settle();
    const select = screen.getByLabelText("새로고침 주기") as HTMLSelectElement;
    // 공용 고르기 상자(NativeSelect — 브라우저 화살표 대신 공용 칸 모양과 화살표 아이콘).
    expect(select.className).toContain("appearance-none");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(
      ["끄기", "5초", "10초", "30초", "1분", "2분", "5분", "10분", "15분", "30분", "1시간", "3시간"]);

    fireEvent.change(select, { target: { value: "1800" } });
    fireEvent.change(select, { target: { value: "3600" } });
    expect(window.localStorage.getItem("live.priceRefreshSeconds")).toBe("3600");
    expect(screen.getByText("정규장 동안 종목 가격은 1시간마다 서버가 보내 주고(실시간 시세), 계좌 숫자는 1시간마다 다시 읽습니다(이 화면을 보는 동안만)."))
      .toBeTruthy();
    // 간격이 길면 그 사이 매시 장부 관측이 이겨 지금 값이 대개 장부 단계라고 알립니다(미국만).
    expect(screen.getByText(/^간격이 길면 그 사이 매시 장부 관측이 돌아 계좌의 지금 값이 대개 '장부' 단계입니다/)).toBeTruthy();
    await settle(59 * 60_000);
    expect(liveCalls()).toBe(1);
    await settle(60_000);
    expect(liveCalls()).toBe(2);

    unmount();
    render(<LiveValuationCard />);
    await settle();
    expect((screen.getByLabelText("새로고침 주기") as HTMLSelectElement).value).toBe("3600");
  });
});

describe("새 장중 값 알림(onUpdated)", () => {
  it("첫 응답과 같은 판이면 부르지 않고, 판이 바뀐 응답마다 한 번 — /live 읽기 수는 늘지 않는다", async () => {
    let reads = 0;
    const stamps = ["2026-10-30 23:58 KST", "2026-10-30 23:58 KST", "2026-10-31 00:28 KST"];
    api.apiGetShared.mockImplementation(() => {
      const stamp = stamps[Math.min(reads, stamps.length - 1)];
      reads += 1;
      return Promise.resolve(live({
        quotes: { source: null, collectedAtKst: stamp, refreshRequested: false, missing: [], error: null },
        books: [{ ...live().books[0], basisAtKst: stamp }],
      }));
    });
    const onUpdated = vi.fn();
    render(<LiveValuationCard onUpdated={onUpdated} />);
    await settle();
    expect(liveCalls()).toBe(1);
    expect(onUpdated).not.toHaveBeenCalled();

    // 같은 저장본을 다시 읽음(판이 같음) — 개요를 다시 읽을 까닭이 없습니다.
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 읽기" }));
    await settle();
    expect(liveCalls()).toBe(2);
    expect(onUpdated).not.toHaveBeenCalled();

    // 새 장중 값 — 한 번.
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 읽기" }));
    await settle();
    expect(liveCalls()).toBe(3);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(liveCalls()).toBe(3);
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });
});

describe("장 밖", () => {
  it("다시 읽지 않고 기준을 적는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED" } })));
    render(<LiveValuationCard />);

    await settle();
    expect(screen.getByText(/휴장 — 장부의 마지막 관측치 기준/)).toBeTruthy();
    expect(screen.getByText("장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다.")).toBeTruthy();
    await settle(31 * 60_000);
    expect(liveCalls()).toBe(1);
  });
});

/**
 * 진짜 벽시계(Date) — 이 파일이 가짜 타이머를 걸기 전에 잡아 둡니다. QA-155 재현은 이것의 now만 바꿔 '벽시계가 그 시각인 날 이 파일을 돌린 것'을
 * 흉내 냅니다(카드가 읽는 Date가 이 진짜 Date면 그 시각을 받음).
 */
const WallClock = Date;
/** 2026-11-02 23:10 KST — 고정 응답의 다음 개장(2026-11-02 23:30 KST) 20분 전. */
const WALL_IN_OPEN_WINDOW = Date.UTC(2026, 10, 2, 14, 10);

describe("QA-155 장 밖 시험이 벽시계에 기대지 않는다(시험 흔들림)", () => {
  // 카드의 다음 개장 깨우기는 msUntilNextOpen(session, Date.now())로 기다릴 시간을 정합니다. 수정 전 이 파일은 Date를 가짜로 두지 않아(setTimeout·
  // setInterval만) 진짜 벽시계를 읽었고, 고정 응답의 다음 개장까지 31분이 안 남은 때(2026-11-02 23:00~23:31 KST) 돌리면 '장 밖' 시험이 31분을
  // 흘리는 동안 깨우기가 불려 두 번째 읽기가 나가 졌습니다. 벽시계의 now만 그 창 안으로 옮겨 같은 몸체를 돌립니다(재현 커밋에서는 it.fails).
  // 이제 이 파일은 Date도 가짜 시계(고정 NOW)라 진짜 벽시계가 어디 있든 같은 결과입니다.
  beforeEach(() => {
    vi.spyOn(WallClock, "now").mockReturnValue(WALL_IN_OPEN_WINDOW);
  });

  it("다음 개장 31분 안의 벽시계에서도 — 장 밖이면 31분 동안 다시 읽지 않는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED" } })));
    render(<LiveValuationCard />);

    await settle();
    expect(screen.getByText("장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다.")).toBeTruthy();
    await settle(31 * 60_000);
    expect(liveCalls()).toBe(1);
  });
});

describe("QA-154 숨긴 탭에서는 깨우지 않는다", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  /** 탭을 숨기거나 다시 보이게 합니다(브라우저처럼 visibilitychange를 냄). */
  async function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  // 카드의 '다음 개장 깨우기'·'20초 뒤 한 번 더'는 setTimeout으로 useApi의 reload를 부릅니다. reload(load)는 탭이 보이는지 보지 않아, 수정 전에는
  // 숨긴 탭에서도 /live 요청이 나갔습니다 — 정규장이면 서버가 그 요청으로 수집을 깨웁니다(시세는 화면을 볼 때만 받기로 한 결정과 어긋남).
  // 이제 타이머는 useVisibleWake로 부릅니다 — 숨긴 탭이면 미루고 다시 보일 때 한 번(재현 커밋에서는 it.fails).
  it("장 밖 — 다음 개장 깨우기는 숨긴 탭이면 읽지 않고, 다시 보이면 한 번 읽는다", async () => {
    // 고정 시계(10-30 23:59 KST)에서 다음 개장이 10-31 00:10 KST → 깨우기는 12분 뒤(개장 + 1분).
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED", nextOpenAtKst: "2026-10-31 00:10 KST" } })));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(13 * 60_000);
    expect(liveCalls()).toBe(1);

    // 장 밖에는 자동 갱신 주기가 0이라 useApi가 탭 복귀 때 읽지 않습니다 — 미뤄 둔 깨우기를 카드가 한 번 읽습니다.
    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
  });

  it("정규장 — 20초 뒤 한 번 더는 숨긴 탭이면 읽지 않고, 돌아오면 useApi의 복귀 읽기 한 번뿐(셋이 아님)", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(20_000);
    expect(liveCalls()).toBe(1);

    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
    // 그 뒤(복귀 읽기의 응답이 새 수집을 요청했을 때의 한 번 더)는 아래 QA-157이 봅니다.
  });
});

describe("QA-157 탭 복귀 읽기의 응답도 한 번 더 읽기를 예약한다", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  async function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  // QA-154 수정 뒤의 회귀: 숨긴 사이 '20초 뒤 한 번 더'가 미뤄지고 정규장 간격이 있으면 탭 복귀 때 useApi가 다시 읽는데(미룬 깨우기는 그 읽기에
  // 넘김), 카드가 타이머를 걸 때 세운 '한 번 더 읽는 중' 표시가 남아 복귀 읽기의 응답을 '한 번 더 읽기의 응답'으로 소모했습니다 — 그 응답이 새
  // 수집을 요청했어도 카드는 다음 간격(기본 30분, 1·3시간이면 그만큼)까지 읽지 않아 종목 표의 장중가가 개요의 지금 값보다 옛 시각으로 남았습니다
  // (재현 커밋에서는 it.fails). 이제 '한 번 더 읽는 중'은 한 번 더 읽기가 실제로 나갈 때만 섭니다.
  it("정규장 — 숨긴 사이 미룬 '한 번 더'를 넘긴 복귀 읽기가 새 수집을 요청했으면 20초 뒤 한 번 더, 그 뒤 되풀이 없음", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(20_000);
    expect(liveCalls()).toBe(1);

    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
    await settle(20_000);
    expect(liveCalls()).toBe(3);
    // 한 번 더 읽은 응답도 새 수집을 요청했지만 또 예약하지 않습니다.
    await settle(60_000);
    expect(liveCalls()).toBe(3);
  });
});

describe("QA-159 간격이 끄기여도 탭 복귀 읽기는 보통 읽기", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    window.localStorage.setItem("paper.liveRefreshMinutes", "0");
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
  });

  async function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  it("보이는 탭 — 끄기여도 새 수집을 요청한 응답이면 20초 뒤 한 번만 더(되풀이 없음)", async () => {
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);
    await settle(20_000);
    expect(liveCalls()).toBe(2);
    await settle(60_000);
    expect(liveCalls()).toBe(2);
  });

  // QA-157 수정은 간격이 있을 때만 덮었습니다: 간격이 끄기(0)면 숨긴 사이 미룬 '한 번 더'를 탭 복귀 때 카드 훅이 '한 번 더 읽기'로 읽어, 그 복귀
  // 읽기가 새 수집을 깨웠어도(복귀가 늦어 저장본이 60초보다 오래됨) 응답을 '한 번 더'의 응답으로 소모했습니다 — 카드는 다시 읽을 길이 없고(끄기·정규장),
  // 개요는 60초 폴링으로 새 저장본을 읽어 종목 표의 장중가만 옛 시각으로 남았습니다(재현 커밋에서는 it.fails).
  it("숨긴 탭 — 미룬 '한 번 더'의 복귀 읽기가 새 수집을 요청했으면 20초 뒤 한 번 더, 그 뒤 되풀이 없음", async () => {
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(20_000);
    expect(liveCalls()).toBe(1);

    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
    await settle(20_000);
    expect(liveCalls()).toBe(3);
    await settle(60_000);
    expect(liveCalls()).toBe(3);
  });
});

describe("QA-162 실패한 한 번 더 읽기가 다음 한 번 더를 삼키지 않는다", () => {
  // '한 번 더 읽는 중' 표시는 한 번 더 읽기가 나갈 때 서고 그 응답(새 data)을 받을 때 내립니다. 그 읽기가 실패하면 useApi가 data를 그대로 두어
  // 표시가 남았고, 다음 응답(30분 간격 읽기·'지금 새로 읽기')이 새 수집을 요청해도 그 응답을 한 번 더의 응답으로 소모했습니다 — 카드 종목 표만 다음
  // 간격까지 옛 시각으로 남았습니다(재현 커밋에서는 it.fails).
  it("정규장 30분 — 한 번 더가 실패한 뒤 간격 읽기가 새 수집을 요청했으면 20초 뒤 한 번 더, 그 뒤 되풀이 없음", async () => {
    window.localStorage.setItem("live.priceRefreshSeconds", "1800");
    let calls = 0;
    api.apiGetShared.mockImplementation(() => {
      calls += 1;
      return calls === 2
        ? Promise.reject(new Error("백엔드 API에 연결하지 못했습니다"))
        : Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } }));
    });
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);
    await settle(20_000);
    expect(liveCalls()).toBe(2);   // 한 번 더 — 실패

    await settle(30 * 60_000 - 19_000);
    expect(liveCalls()).toBe(3);   // 30분 간격 읽기 — 새 수집 요청
    await settle(20_000);
    expect(liveCalls()).toBe(4);
    await settle(60_000);
    expect(liveCalls()).toBe(4);
  });
});

describe("QA-163 같은 문구로 연달아 실패해도 한 번 더 표시를 내린다", () => {
  // QA-162 수정은 refreshError가 바뀔 때 표시를 내렸는데, 20초 안에 다른 읽기('지금 새로 읽기'·탭 복귀·셸 새로고침)가 먼저 실패하면 refreshError가
  // 이미 차 있어 같은 문구의 한 번 더 실패가 변화로 오지 않았습니다 — 표시가 남아 다음 응답의 새 수집 요청을 소모했습니다(재현 커밋에서는 it.fails).
  it("성공 → '지금 새로 읽기' 실패 → 한 번 더도 같은 문구로 실패 → 30분 간격 읽기가 새 수집을 요청했으면 20초 뒤 한 번 더", async () => {
    window.localStorage.setItem("live.priceRefreshSeconds", "1800");
    let calls = 0;
    api.apiGetShared.mockImplementation(() => {
      calls += 1;
      return calls === 2 || calls === 3
        ? Promise.reject(new Error("백엔드 API에 연결하지 못했습니다"))
        : Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } }));
    });
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);
    await settle(5_000);
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 읽기" }));
    await settle();
    expect(liveCalls()).toBe(2);   // '지금 새로 읽기' — 실패
    await settle(16_000);
    expect(liveCalls()).toBe(3);   // 한 번 더 — 같은 문구로 실패

    await settle(30 * 60_000 - 20_000);
    expect(liveCalls()).toBe(4);   // 30분 간격 읽기 — 새 수집 요청
    await settle(20_000);
    expect(liveCalls()).toBe(5);
    await settle(60_000);
    expect(liveCalls()).toBe(5);
  });
});

describe("QA-156 숨긴 탭으로 열면 보일 때까지 읽지 않는다", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  // 개요를 백그라운드 탭으로 열면(새 탭으로 열기·브라우저가 탭을 되살림) 카드가 마운트되며 /live를 읽었습니다 — useApi의 첫 읽기는 탭이
  // 보이는지 보지 않아, 정규장이면 아무도 보지 않는데 서버가 수집을 깨웠습니다(재현 커밋에서는 it.fails). 이제 카드는 탭이 처음 보일 때까지
  // 경로를 주지 않습니다(useShownOnce).
  it("숨긴 탭에서 마운트되면 /live를 읽지 않고, 처음 보일 때 읽는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(0);

    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(liveCalls()).toBe(1);
    expect(screen.getByText(/정규장 — 장중 1분봉 시세로 다시 평가/)).toBeTruthy();
  });
});
