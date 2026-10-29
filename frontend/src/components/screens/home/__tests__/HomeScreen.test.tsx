/**
 * 홈(/) 화면 — 고정 응답 이야기로 네 상태를 확인한다(설계서 §9 DoD "없음·일부 실패·추정·오래됨").
 *  - 값 있음: 국면 히어로(백엔드 라벨·문장·기준일·출처·고지·신호 네 타일), 모의매매 히어로(Claude 순자산·마지막 관측·출처·네 계좌·출발 줄),
 *    시장 행(장 상태 — 열린 장만 지연), 알림(지난 사건은 강조하지 않음), 저장소 상태(누락 데이터셋·수집기 연결)
 *  - 값 없음: 판정 불가(중립색) + 받지 못한 입력, 장부 없음 안내, 매크로 저장본 없음, "새 알림이 없습니다", 모르는 수는 "—"(읽어 주기 "값 없음")
 *  - 일부 실패: 한 경로가 실패해도 그 구역만 오류(role="alert", 다시 시도), 나머지는 그린다
 *  - 추정: isEstimated 카드에 '추정' 배지 / 오래됨: isStale 카드·가격 없는 보유 계좌·늦은 관측치에 '이전 값' + 사유
 *  - 회원(운영자 아님): /api/paper/*·/api/status*를 부르지 않고 그 구역이 없다
 *
 * 보는 시각은 2026-10-26(월) 16:51 KST로 고정합니다(장 상태가 시각에 따라 바뀜) — 외환·CME 개장, 뉴욕 증시 마감, KRX 선물 휴식.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { COLLECTOR_UNREACHABLE_NOTE, PAPER_COMPARE_NOTE, PAPER_HREF, PAPER_KR_HREF } from "@/lib/home";
import { PAPER_SOURCES } from "@/lib/paper";
import { SOURCES } from "@/lib/sources";
import type { SessionUser } from "@/lib/types";
import {
  inbox,
  issues,
  macroItem,
  macroOverview,
  paperOverview,
  paperOverviewKr,
  paperOverviewKrDormant,
  paperStatus,
  paperStatusKr,
  regimeExpansion,
  regimeUnknown,
} from "@/lib/__tests__/homeFixtures";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import HomePage from "@/app/(dashboard)/page";
import HomeScreen from "../HomeScreen";

const REGIME = "/api/analytics/regime?years=5";
const PAPER_OVERVIEW = "/api/paper/overview";
const PAPER_STATUS = "/api/paper/status";
const PAPER_KR_OVERVIEW = "/api/paper/overview?market=KR";
const PAPER_KR_STATUS = "/api/paper/status?market=KR";
// live 없이 — live=true면 신선도 기준이 60초로 내려가 Yahoo 수집이 잦아집니다.
const MACRO = "/api/macro/overview";
const UNREAD = "/api/alerts/unread-count";
const INBOX = "/api/alerts/inbox?limit=3";
const ISSUES = "/api/status/issues";
// 장 상태(KRX 휴장) 판정에 보태는 한국 공휴일 — /macro와 같은 훅이 읽습니다(회원 경로).
const KR_HOLIDAYS = "/api/calendar/kr-holidays";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

/** 경로 → 응답. Error면 거절, 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

function happyReads(): Record<string, unknown> {
  return {
    [REGIME]: regimeExpansion(),
    [PAPER_OVERVIEW]: paperOverview(),
    [PAPER_STATUS]: paperStatus(false),
    [MACRO]: macroOverview(),
    [UNREAD]: { unread: 2 },
    [INBOX]: inbox(),
    [ISSUES]: issues(0, 0),
    [KR_HOLIDAYS]: { available: true, years: {} },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T07:51:00Z"));
  reads = {};
  signal.token = 0;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHome(user: SessionUser | undefined, page: ReactElement = <HomeScreen />) {
  return render(<SessionUserProvider user={user}>{page}</SessionUserProvider>);
}

const requested = () => api.apiGetShared.mock.calls.map(([path]) => path as string);
const region = (name: string | RegExp) => screen.getByRole("region", { name });

/** 모의매매 히어로 구역 이름 — 불러오는 중·오류·읽은 뒤 모두 같습니다(큰 숫자가 무엇인지 제목이 먼저 말함). */
const PAPER_REGION = "모의매매 · Claude 계좌 순자산";

/** 모의매매 히어로(운영자, 장부를 읽은 뒤) — 같은 이름의 구역에 평가 시각 줄·계좌 행이 그려진 뒤. */
async function paperHero(): Promise<HTMLElement> {
  // 제목에도 "Claude 계좌 순자산"이 있어(불러오는 중에도) 평가 시각 줄로 기다립니다.
  await screen.findByText(/^Claude 계좌 순자산 · 마지막 관측/);
  return region(PAPER_REGION);
}

/** 시장 행 한 줄(링크) — 이름 글자에서 가장 가까운 a. */
function marketRow(name: string): HTMLElement {
  return screen.getByText(name).closest("a") as HTMLElement;
}

describe("홈 — 값 있음(운영자)", () => {
  it("라우트 /는 홈 화면을 그린다(옛 /macro 리디렉션 대신)", async () => {
    reads = happyReads();
    renderHome(OWNER, <HomePage />);
    expect(await screen.findByRole("heading", { name: "오늘의 국면" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "홈" })).toBeTruthy();
  });

  it("오늘의 국면 — 백엔드 라벨·판정 문장·기준일(뜻 포함)·신호 네 타일·자세히 링크, '3일 확정'은 없다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const label = await screen.findByText("확장 (Expansion)");
    // 판정이 났으면 큰 글자 잉크 그대로(판정 불가만 중립색).
    expect(label.className).not.toContain("text-neutral");
    const hero = region("오늘의 국면");
    expect(within(hero).getByText(/위험자산에 우호적인 조합입니다/)).toBeTruthy();
    expect(within(hero).getByText("2026-10-16")).toBeTruthy();
    expect(within(hero).getByText(/네 입력 계열의 마지막 날짜 중 가장 이른 날/)).toBeTruthy();
    // 모든 숫자에 출처(PRINCIPLES) — 국면 판정의 입력 출처와 백엔드 고지(임계치는 참고치).
    expect(within(hero).getByText(SOURCES.regime)).toBeTruthy();
    expect(within(hero).getByText("임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.")).toBeTruthy();
    const tiles = within(hero).getAllByRole("group");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "장단기 금리차 10Y-3M", "시카고 연준 금융상황지수", "하이일드 스프레드", "연준 순유동성 4주 변화",
    ]);
    expect(tiles[0].textContent).toContain("+0.78%p");
    expect(tiles[0].textContent).toContain("정상 · 장기 금리가 단기보다 높습니다(정상 구조).");
    expect(tiles[3].textContent).toContain("+0.031조 달러");
    expect(within(hero).getByRole("link", { name: "국면 판정 자세히" }).getAttribute("href")).toBe("/regime");
    expect(screen.queryByText(/3일 확정/)).toBeNull();
  });

  it("모의매매 — Claude 계좌 순자산 히어로·출발 대비·마지막 관측·출처·네 계좌 행(링크)·출발 줄·정기 작업 꺼짐 안내, 쓰기 버튼은 없다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const hero = await paperHero();
    // 구역 이름은 불러오는 중·오류일 때와 같고, 큰 숫자가 무엇인지(Claude 계좌 순자산)를 숫자보다 먼저 말합니다.
    expect(within(hero).getByRole("heading", { level: 2 }).textContent).toBe(PAPER_REGION);
    // 히어로 값과 Claude 계좌 행이 같은 순자산을 적습니다.
    expect(within(hero).getAllByText("99,967.28")).toHaveLength(2);
    expect(within(hero).getByText("출발 대비")).toBeTruthy();   // 히어로 변화 칩 옆 — 일간 변화가 아님
    // 평가 시각은 정기 작업 켜짐·꺼짐과 상관없이 늘 보입니다.
    expect(within(hero).getByText(/^Claude 계좌 순자산 · 마지막 관측/).textContent).toBe("Claude 계좌 순자산 · 마지막 관측 2026-10-26 04:56");
    expect(within(hero).getByText(PAPER_SOURCES.ledger)).toBeTruthy();
    const rows = within(hero).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([PAPER_HREF, PAPER_HREF, PAPER_HREF, PAPER_HREF]);
    expect(within(rows[1]).getByText("Claude 계좌")).toBeTruthy();
    expect(within(rows[1]).getByText(/^Claude · 운용 중/)).toBeTruthy();
    expect(within(rows[1]).getByText("−0.03%")).toBeTruthy();
    expect(within(hero).getByText("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비")).toBeTruthy();
    expect(within(hero).getByText("정기 작업 꺼짐(PAPER_ENABLED=false) — 이 화면은 읽기 전용 사본")).toBeTruthy();

    // 미국 | 한국 — 라디오 묶음(화면 테마 전환과 같은 뜻): 미국이 골라져 있고, 한국은 고를 수 있습니다(2단계 명세 §4-16 — '준비 중' 해제).
    const switcher = within(hero).getByRole("radiogroup", { name: "모의매매 시장" });
    const us = within(switcher).getByRole("radio", { name: "미국" }) as HTMLInputElement;
    expect(us.checked).toBe(true);
    const korea = within(switcher).getByRole("radio", { name: "한국" }) as HTMLInputElement;
    expect(korea.disabled).toBe(false);
    expect(korea.checked).toBe(false);
    // 두 책을 견주지 않는다는 문구는 미국 탭에도(탭마다 — 2단계 명세 §3).
    expect(within(hero).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    // 한국을 고르기 전에는 한국 요청이 없습니다.
    expect(requested().filter((path) => path.includes("market=KR"))).toEqual([]);

    // 홈에는 쓰기 버튼(초기화·리스크 실행·시작 등)이 없습니다 — 버튼이 하나도 없습니다.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("시장 — 범주별 자산 행(링크 → /macro, 범주는 h3), 출처·장 상태·지연·시각 배지, 참고 시세, 저장본 수집 시각", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await screen.findByText("원/달러 (USD/KRW)");
    const market = region("시장");
    // "시장"만 h2, 범주는 그 아래 h3 — 범주는 영역(랜드마크)을 겹쳐 만들지 않습니다.
    expect(within(market).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["시장"]);
    expect(within(market).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent))
      .toEqual(["통화 및 환율", "미국 주가지수 및 선물", "아시아 주요 주가지수"]);
    expect(within(market).queryAllByRole("region")).toHaveLength(0);
    const usdkrw = marketRow("원/달러 (USD/KRW)");
    expect(usdkrw.getAttribute("href")).toBe("/macro");
    expect(within(usdkrw).getByText("1,322.28")).toBeTruthy();
    // 열린 장만 지연을 적습니다("개장 · 실시간", "개장 · 10분 지연" — /macro SessionBadge와 같은 규칙).
    expect(within(usdkrw).getByText("Yahoo Finance (KRW=X) · 개장 · 실시간 · 2026-10-26 16:51")).toBeTruthy();
    expect(within(marketRow("S&P 500 선물 (ES)")).getByText("Yahoo Finance (ES=F) · 개장 · 10분 지연 · 2026-10-26 16:41")).toBeTruthy();
    // 닫힌 장(뉴욕 증시, 토요일 04:59 종가)에는 '실시간'을 찍지 않고 '마감'만.
    const sp500 = marketRow("S&P 500");
    expect(within(sp500).getByText("Yahoo Finance (^GSPC) · 마감 · 2026-10-24 04:59")).toBeTruthy();
    expect(within(sp500).queryByText(/실시간|지연/)).toBeNull();
    // '장 밖' 야간선물 카드(20분 지연)도 장이 닫혀 있으면 지연을 적지 않습니다.
    const night = marketRow("코스피200 야간선물");
    expect(within(night).getByText(/^TradingView Scanner · 참고 시세 · 휴식 · 2026-10-26 16:51/)).toBeTruthy();
    expect(within(night).queryByText(/지연|실시간/)).toBeNull();
    // 직전 값이 없는 카드(delta·pct null, deltaStr "N/A")는 변화 칩을 생략합니다 — 0.00%를 만들지 않습니다.
    expect(within(night).queryByText(/%/)).toBeNull();
    expect(within(night).queryByText("N/A")).toBeNull();
    expect(within(market).getByText("2026-10-26 16:51", { selector: "span.tabular-nums" })).toBeTruthy();
    expect(within(market).getByRole("link", { name: "매크로 지표 전체 보기" }).getAttribute("href")).toBe("/macro");
    expect(requested()).toContain(MACRO);
    expect(requested().some((path) => path.includes("live="))).toBe(false);
  });

  it("시장 — 변화량은 수집기 자릿수 그대로(금리 −0.007, 변화율은 둘째 자리)", async () => {
    const overview = macroOverview();
    overview.categories[0].items.push(macroItem({
      key: "us10y", name: "미국채 10년물 수익률(%)", market: "ust", ticker: "^TNX", price: 4.992, priceStr: "4.992",
      delta: -0.007, pct: -0.14, deltaStr: "-0.007 (-0.14%)", lastTs: "2026-10-26 16:51 KST",
    }));
    reads = { ...happyReads(), [MACRO]: overview };
    renderHome(OWNER);
    const us10y = (await screen.findByText("미국채 10년물 수익률(%)")).closest("a") as HTMLElement;
    expect(within(us10y).getByText("4.992")).toBeTruthy();
    expect(within(us10y).getByText("−0.007")).toBeTruthy();
    expect(within(us10y).getByText("(−0.14%)")).toBeTruthy();
    expect(within(us10y).getByText("하락")).toBeTruthy();
  });

  it("알림 요약 — 읽지 않은 수·최근 세 건(제목·발생일·읽음)·알림함 링크 / 저장소 상태 한 줄(→ /status)", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await screen.findByText("[국면 전환] 후퇴 경계 → 확장");
    const alerts = region("알림");
    expect(within(alerts).getByText("2건")).toBeTruthy();
    expect(within(alerts).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "[국면 전환] 후퇴 경계 → 확장2026-10-25 · 안 읽음",
      "Berkshire 13F 신규 편입2026-10-20 · 읽음",
      "외국인 5일 연속 순매수2026-10-18 · 안 읽음",
    ]);
    expect(within(alerts).getByRole("link", { name: "알림 전체 보기" }).getAttribute("href")).toBe("/alerts");

    const status = region("데이터 저장소 상태");
    const line = within(status).getByRole("link");
    expect(line.getAttribute("href")).toBe("/status");
    expect(within(line).getByText("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개")).toBeTruthy();
    expect(within(line).getByText("확인 2026-10-26 16:54")).toBeTruthy();
    // 데이터 카드마다 출처 줄(PRINCIPLES) — 상태 화면의 수집 오류·경고 로그와 같은 출처.
    expect(within(line).getByText(SOURCES.collectorRuns)).toBeTruthy();
    expect(within(line).queryByText(COLLECTOR_UNREACHABLE_NOTE)).toBeNull();
  });

  it("알림 — 지난 사건(late)은 읽지 않은 수에 들지 않아 강조(점·굵은 글씨) 없이 '지난 사건'", async () => {
    const response = inbox();
    response.items[0] = { ...response.items[0], late: true, read: false };
    reads = { ...happyReads(), [UNREAD]: { unread: 1 }, [INBOX]: response };
    renderHome(OWNER);
    const title = await screen.findByText("[국면 전환] 후퇴 경계 → 확장");
    const [late, , unread] = within(region("알림")).getAllByRole("listitem");
    expect(late.textContent).toBe("[국면 전환] 후퇴 경계 → 확장2026-10-25 · 지난 사건");
    expect(title.className).not.toContain("font-semibold");
    expect(late.querySelector(".bg-accent")).toBeNull();
    // 읽지 않은 수에 드는 알림만 칠한 점과 굵은 글씨입니다.
    expect(unread.querySelector(".bg-accent")).not.toBeNull();
    expect(within(unread).getByText("외국인 5일 연속 순매수").className).toContain("font-semibold");
  });
});

describe("홈 — 불러오는 중·값 없음", () => {
  it("응답 전에는 구역마다 자리표시(Skeleton) — 한 구역이 화면 전체를 막지 않는다", () => {
    renderHome(OWNER);
    const labels = screen.getAllByRole("status").map((node) => node.getAttribute("aria-label"));
    expect(labels).toEqual([
      "오늘의 국면을 불러오는 중",
      "모의매매 계좌를 불러오는 중",
      "시장 시세를 불러오는 중",
      "알림을 불러오는 중",
      "데이터 저장소 상태를 불러오는 중",
    ]);
    // 모의매매 구역은 불러오는 중에도 읽은 뒤와 같은 이름 — 무엇을 불러오는지(Claude 계좌 순자산) 제목이 말합니다.
    expect(within(region(PAPER_REGION)).getByRole("status").getAttribute("aria-label")).toBe("모의매매 계좌를 불러오는 중");
    // 읽지 않은 수를 모르면 "—"(읽어 주기 "값 없음") — 0건으로 적지 않습니다.
    expect(within(region("알림")).getByText("값 없음")).toBeTruthy();
    expect(screen.queryByText("0건")).toBeNull();
  });

  it("판정 불가 + 받지 못한 입력, 빠진 신호는 '—'(받지 못함), 장부·매크로 없음 안내, 새 알림 없음", async () => {
    reads = {
      [REGIME]: regimeUnknown(),
      [PAPER_OVERVIEW]: { available: false, message: "모의 매매 테이블이 아직 없습니다" },
      [PAPER_STATUS]: { available: false, enabled: true },
      [MACRO]: { available: false, readMode: "auto", categories: [], message: "매크로 저장본이 아직 없습니다 — 수집 전" },
      [INBOX]: { items: [], unread: 0 },
      [ISSUES]: { ...issues(), counts: undefined },
    };
    renderHome(OWNER);

    const unknown = await screen.findByText("판정 불가");
    // 판정 불가는 판정 난 라벨과 같은 잉크로 그리지 않습니다(중립색).
    expect(unknown.className).toContain("text-neutral");
    const hero = unknown.closest("section") as HTMLElement;
    expect(within(hero).getByText(/입력 지표가 빠져 국면을 판정하지 않습니다/)).toBeTruthy();
    expect(within(hero).getByText(/받지 못한 입력: 하이일드 스프레드 \(HY OAS\)/)).toBeTruthy();
    const hyOas = within(hero).getByRole("group", { name: "하이일드 스프레드" });
    expect(within(hyOas).getByText("—")).toBeTruthy();
    expect(within(hyOas).getByText("받지 못함")).toBeTruthy();
    expect(hyOas.textContent).not.toContain("%p");
    // 기준일 모름 — "—"(읽어 주기 "값 없음")
    expect(within(hero).getByText(/^기준일/).textContent).toBe("기준일 —값 없음 · 네 입력 계열의 마지막 날짜 중 가장 이른 날");

    const paper = (await screen.findByText("모의 매매 테이블이 아직 없습니다")).closest("section") as HTMLElement;
    // 순자산과 마지막 관측 둘 다 모름
    expect(within(paper).getAllByText("값 없음")).toHaveLength(2);
    expect(within(paper).queryByRole("link")).toBeNull();
    expect(within(paper).queryByText(/정기 작업 꺼짐/)).toBeNull();

    expect(within(region("시장")).getByText("매크로 저장본이 아직 없습니다 — 수집 전")).toBeTruthy();
    expect(await within(region("알림")).findByText("새 알림이 없습니다")).toBeTruthy();
    expect(within(region("알림")).getByText("값 없음")).toBeTruthy();   // 읽지 않은 수 응답 전
    const line = await within(region("데이터 저장소 상태")).findByRole("link");
    expect(line.textContent).toContain("수집 태스크 오류 —값 없음 · 경고 —값 없음 · 누락 데이터셋 —값 없음");
    expect(within(line).getAllByText("값 없음")).toHaveLength(3);
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });

  it("저장소 상태 — 수집기에 닿지 못하면 '연결 안 됨 — DB 기록만'(경고색), 누락 데이터셋은 모름 · 누락이 있으면 그 수", async () => {
    const down = { ...issues(0, 0), collectorReachable: false };
    down.counts = { ...down.counts, missingDatasets: null };
    reads = { ...happyReads(), [ISSUES]: down };
    const { unmount } = renderHome(OWNER);
    let line = await within(region("데이터 저장소 상태")).findByRole("link");
    expect(within(line).getByText(COLLECTOR_UNREACHABLE_NOTE)).toBeTruthy();
    expect(line.textContent).toContain("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 —값 없음");
    expect(within(line).getByText(/^수집 태스크 오류/).className).toContain("text-warn");
    unmount();

    const missing = issues(0, 0);
    missing.counts.missingDatasets = 3;
    reads = { ...happyReads(), [ISSUES]: missing };
    renderHome(OWNER);
    line = await within(region("데이터 저장소 상태")).findByRole("link");
    expect(within(line).getByText("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 3개").className).toContain("text-warn");
    expect(within(line).queryByText(COLLECTOR_UNREACHABLE_NOTE)).toBeNull();
  });
});

describe("홈 — 일부 실패", () => {
  it("매크로 개요가 실패하면 시장 구역만 오류(다시 시도), 국면·모의매매·알림·상태는 그린다", async () => {
    reads = { ...happyReads(), [MACRO]: new Error("요청 실패 (HTTP 500)") };
    renderHome(OWNER);

    const market = region("시장");
    expect(await within(market).findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    // 실패는 알림(role="alert")으로 보조 기술에 알립니다 — 자리표시(role="status")가 사라지기만 하면 실패를 모릅니다.
    expect(within(market).getByRole("alert").textContent).toContain("요청 실패 (HTTP 500)");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("확장 (Expansion)")).toBeTruthy();
    expect(await paperHero()).toBeTruthy();
    expect(screen.getByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
    expect(screen.getByText("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개")).toBeTruthy();

    reads[MACRO] = macroOverview();
    fireEvent.click(within(market).getByRole("button", { name: "다시 시도" }));
    expect(await within(market).findByText("원/달러 (USD/KRW)")).toBeTruthy();
    expect(requested().filter((path) => path === MACRO)).toHaveLength(2);
  });

  it("국면·장부가 실패해도 시장·알림은 그리고, 정기 작업 상태를 못 읽으면 '확인하지 못했습니다'(꺼짐/켜짐을 지어내지 않음)", async () => {
    reads = {
      ...happyReads(),
      [REGIME]: new Error("백엔드 API에 연결하지 못했습니다"),
      [PAPER_STATUS]: new Error("요청 실패 (HTTP 503)"),
    };
    renderHome(OWNER);

    expect(await within(region("오늘의 국면")).findByText("백엔드 API에 연결하지 못했습니다")).toBeTruthy();
    expect(await screen.findByText("원/달러 (USD/KRW)")).toBeTruthy();
    const paper = await paperHero();
    expect(await within(paper).findByText("정기 작업 상태를 확인하지 못했습니다 — 요청 실패 (HTTP 503)")).toBeTruthy();
    expect(within(paper).queryByText(/정기 작업 꺼짐/)).toBeNull();
    // 처음 현금은 상태 응답 대신 계좌들의 같은 값으로 적습니다.
    expect(within(paper).getByText("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비")).toBeTruthy();
  });

  it("장부 개요가 실패하면 모의매매 구역은 제목과 오류만, 저장소 상태가 실패하면 그 줄만 오류", async () => {
    reads = { ...happyReads(), [PAPER_OVERVIEW]: new Error("요청 실패 (HTTP 500)"), [ISSUES]: new Error("요청 실패 (HTTP 502)") };
    renderHome(OWNER);

    expect(await within(region(PAPER_REGION)).findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    expect(await within(region("데이터 저장소 상태")).findByText("요청 실패 (HTTP 502)")).toBeTruthy();
    expect(within(region(PAPER_REGION)).getByRole("alert")).toBeTruthy();
    expect(within(region("데이터 저장소 상태")).getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/수집 태스크 오류/)).toBeNull();
    expect(screen.getByText("확장 (Expansion)")).toBeTruthy();
  });

  it("자동 갱신이 실패하면 앞서 받은 시장 행을 두고 '⚠️ 새로 읽지 못함'(QA-067)", async () => {
    reads = happyReads();
    const { rerender } = renderHome(OWNER);
    await screen.findByText("원/달러 (USD/KRW)");
    expect(within(region("시장")).queryByText("⚠️ 새로 읽지 못함")).toBeNull();

    reads[MACRO] = new Error("백엔드 API에 연결하지 못했습니다");
    signal.token += 1;
    await act(async () => rerender(<SessionUserProvider user={OWNER}><HomeScreen /></SessionUserProvider>));
    await waitFor(() => expect(requested().filter((path) => path === MACRO)).toHaveLength(2));

    const market = region("시장");
    expect(await within(market).findByText("⚠️ 새로 읽지 못함")).toBeTruthy();
    expect(within(market).getByText("원/달러 (USD/KRW)")).toBeTruthy();
  });
});

describe("홈 — 추정·오래됨 배지", () => {
  it("추정 카드(isEstimated)에는 '추정' 배지가 반드시 보인다", async () => {
    const overview = macroOverview();
    overview.categories[2].items[0].isEstimated = true;
    reads = { ...happyReads(), [MACRO]: overview };
    renderHome(OWNER);

    const night = (await screen.findByText("코스피200 야간선물")).closest("a") as HTMLElement;
    expect(within(night).getByText("추정")).toBeTruthy();
    expect(within(marketRow("원/달러 (USD/KRW)")).queryByText("추정")).toBeNull();
  });

  it("이어받은 카드(isStale)·가격 없는 보유 계좌에는 '⚠️ 이전 값' + 사유, 이어받은 카드에는 열린 장이어도 '실시간'을 붙이지 않는다", async () => {
    const overview = macroOverview();
    overview.categories[0].items[0] = macroItem({
      ...overview.categories[0].items[0],
      isStale: true,
      staleReason: "Yahoo 429 — 직전 저장본 값",
    });
    const ledger = paperOverview();
    ledger.books![1].staleCount = 2;
    reads = { ...happyReads(), [MACRO]: overview, [PAPER_OVERVIEW]: ledger };
    renderHome(OWNER);

    const usdkrw = (await screen.findByText("원/달러 (USD/KRW)")).closest("a") as HTMLElement;
    expect(within(usdkrw).getByText("이전 값")).toBeTruthy();
    expect(within(usdkrw).getByText("· Yahoo 429 — 직전 저장본 값")).toBeTruthy();
    expect(within(usdkrw).getByText("Yahoo Finance (KRW=X) · 개장 · 2026-10-26 16:51")).toBeTruthy();
    expect(within(usdkrw).getByText("1,322.28")).toBeTruthy();   // 값은 그대로 두고 배지로 알립니다

    const paper = await paperHero();
    const claude = within(paper).getByText("Claude 계좌").closest("a") as HTMLElement;
    expect(within(claude).getByText("이전 값")).toBeTruthy();
    expect(within(claude).getByText("· 가격 없음 2종목 — 지난 값으로 평가")).toBeTruthy();
    // 히어로(Claude 계좌 순자산)에도 같은 배지가 붙습니다.
    expect(within(paper).getAllByText("· 가격 없음 2종목 — 지난 값으로 평가")).toHaveLength(2);
    const rules = within(paper).getByText("규칙 계좌").closest("a") as HTMLElement;
    expect(within(rules).queryByText("이전 값")).toBeNull();
  });

  it("장부 관측치 저장본이 늦으면(백엔드 quotes.stale) 네 계좌 모두 '이전 값'(모의매매 개요와 같은 사유)", async () => {
    const ledger = paperOverview();
    ledger.quotes!.stale = true;
    reads = { ...happyReads(), [PAPER_OVERVIEW]: ledger };
    renderHome(OWNER);

    const paper = await paperHero();
    // 네 행 + 히어로
    expect(within(paper).getAllByText("· 관측치 저장본이 늦음 · 마지막 관측 2026-10-26 04:56")).toHaveLength(5);
  });
});

describe("홈 — 모의매매 한국 탭", () => {
  /** 미국 히어로가 그려진 뒤 한국을 고릅니다. */
  async function pickKorea() {
    const hero = await paperHero();
    fireEvent.click(within(hero).getByRole("radio", { name: "한국" }));
  }

  it("불러오는 중: 한국을 고르면 그때 ?market=KR을 읽고 자리표시 — 탭은 남아 미국으로 돌아갈 수 있다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await pickKorea();
    expect(await screen.findByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(requested()).toEqual(expect.arrayContaining([PAPER_KR_OVERVIEW, PAPER_KR_STATUS]));
    const card = region(PAPER_REGION);
    fireEvent.click(within(card).getByRole("radio", { name: "미국" }));
    expect(await screen.findByText(/^Claude 계좌 순자산 · 마지막 관측/)).toBeTruthy();
  });

  // 수정 전에는 한국을 고르면 읽는 중 카드(히어로와 다른 틀)에 라디오가 다시 그려져 초점이 body로 빠지고, 미국을 갔다 오면 한국 값을
  // 지워 다시 자리표시였습니다(it.fails).
  it.fails("키보드로 시장을 고르면 초점이 그 라디오에 남는다 — 읽는 중·읽은 뒤 모두, 미국 → 한국을 다시 골라도 자리표시 없이", async () => {
    let resolveKr: (body: unknown) => void = () => {};
    const krOverview = new Promise((resolve) => { resolveKr = resolve; });
    reads = { ...happyReads(), [PAPER_KR_STATUS]: paperStatusKr(false) };
    const base = api.apiGetShared.getMockImplementation();
    api.apiGetShared.mockImplementation((path: string) => (path === PAPER_KR_OVERVIEW ? krOverview : base?.(path)));
    renderHome(OWNER);
    const hero = await paperHero();
    const korea = within(hero).getByRole("radio", { name: "한국" }) as HTMLInputElement;
    korea.focus();
    fireEvent.click(korea);
    expect(await screen.findByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(korea.checked).toBe(true);
    expect(document.activeElement).toBe(korea);

    await act(async () => resolveKr(paperOverviewKr()));
    await screen.findByText(/^한국 Claude 계좌 순자산 · 마지막 관측/);
    expect(document.activeElement).toBe(korea);

    const us = within(region(PAPER_REGION)).getByRole("radio", { name: "미국" }) as HTMLInputElement;
    us.focus();
    fireEvent.click(us);
    await screen.findByText(/^Claude 계좌 순자산 · 마지막 관측/);
    expect(document.activeElement).toBe(us);
    korea.focus();
    fireEvent.click(korea);
    // 한 번 읽은 한국 값은 남아 있어 자리표시 없이 바로 그립니다.
    expect(screen.queryByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeNull();
    expect(screen.getByText(/^한국 Claude 계좌 순자산 · 마지막 관측/)).toBeTruthy();
    expect(document.activeElement).toBe(korea);
  });

  it("쉬는 한국: 계좌 없이 그 사유, 두 책 비교하지 않음 문구", async () => {
    const reason = "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다";
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: paperOverviewKrDormant(reason), [PAPER_KR_STATUS]: { ...paperStatusKr(false), dormantReason: reason } };
    renderHome(OWNER);
    await pickKorea();
    expect(await screen.findByText(`한국 책이 쉬고 있습니다 — ${reason}`)).toBeTruthy();
    const hero = region(PAPER_REGION);
    expect(within(hero).queryAllByRole("link")).toHaveLength(0);
    expect(within(hero).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    expect((within(hero).getByRole("radio", { name: "한국" }) as HTMLInputElement).checked).toBe(true);
  });

  it("오류: 한국 개요를 못 읽으면 그 구역만 오류 + 다시 시도, 탭은 남는다", async () => {
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: new Error("한국 개요 응답 500"), [PAPER_KR_STATUS]: paperStatusKr(false) };
    renderHome(OWNER);
    await pickKorea();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("한국 개요 응답 500")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(within(region(PAPER_REGION)).getByRole("radiogroup", { name: "모의매매 시장" })).toBeTruthy();
  });

  it("자료: 한국 Claude 계좌 순자산(원 정수)·출발 대비·네 계좌 행(원, 링크 /paper/kr)·출발 줄(원)·비교하지 않음 문구·한국 출처", async () => {
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: paperOverviewKr(), [PAPER_KR_STATUS]: paperStatusKr(false) };
    renderHome(OWNER);
    await pickKorea();
    await screen.findByText(/^한국 Claude 계좌 순자산 · 마지막 관측/);
    const hero = region(PAPER_REGION);
    // 히어로 값과 한국 Claude 계좌 행이 같은 원 단위 정수를 적습니다(소수 없음).
    expect(within(hero).getAllByText("100,312,450")).toHaveLength(2);
    expect(within(hero).getAllByText("원").length).toBeGreaterThan(0);
    expect(within(hero).getByText(/^한국 Claude 계좌 순자산 · 마지막 관측/).textContent).toBe("한국 Claude 계좌 순자산 · 마지막 관측 2026-11-03 21:57");
    const rows = within(hero).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([PAPER_KR_HREF, PAPER_KR_HREF, PAPER_KR_HREF, PAPER_KR_HREF]);
    expect(PAPER_KR_HREF).toBe("/paper/kr");
    expect(within(rows[2]).getByText("KODEX 200 계좌")).toBeTruthy();
    expect(within(rows[2]).getByText("100,528,900")).toBeTruthy();
    expect(within(hero).getByText("출발 2026-10-29 · 처음 현금 100,000,000원 · 변화율은 출발 대비")).toBeTruthy();
    expect(within(hero).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    expect(within(hero).getByText(PAPER_SOURCES.krLedger)).toBeTruthy();
    // 사후 체결 대기 경고는 한국에 없습니다(네 계좌가 S+1 시가에 함께 출발).
    expect(within(hero).queryByText(/출발일 종가 대기/)).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("홈 — 운영자가 아닌 사용자", () => {
  for (const [name, user] of [["회원", MEMBER], ["데모 열람", DEMO], ["사용자 모름(레이아웃 밖)", undefined]] as const) {
    it(`${name}: 모의매매·저장소 상태를 요청하지 않고 그 구역이 없다 — 국면·시장·알림은 그린다`, async () => {
      reads = happyReads();
      renderHome(user);

      expect(await screen.findByText("확장 (Expansion)")).toBeTruthy();
      expect(await screen.findByText("원/달러 (USD/KRW)")).toBeTruthy();
      expect(await screen.findByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
      expect(requested().some((path) => path.startsWith("/api/paper") || path.startsWith("/api/status"))).toBe(false);
      expect(requested().sort()).toEqual([INBOX, KR_HOLIDAYS, MACRO, REGIME, UNREAD].sort());
      expect(screen.queryByRole("heading", { name: /모의매매/ })).toBeNull();
      expect(screen.queryByRole("region", { name: "데이터 저장소 상태" })).toBeNull();
      expect(screen.queryByText(/수집 태스크 오류/)).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "모의매매 시장" })).toBeNull();
    });
  }
});
