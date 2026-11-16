/**
 * 홈(/) 화면 — 고정 응답 이야기로 네 상태를 확인한다(설계서 §9 DoD "없음·일부 실패·추정·오래됨").
 *  - 값 있음: 국면 히어로(백엔드 라벨·문장·기준일·출처·고지·신호 네 타일), 모의매매 히어로(Claude 순자산·마지막 관측·출처·네 계좌·출발 줄),
 *    시장 행(장 상태 — 열린 장만 지연), 알림(지난 사건은 강조하지 않음), 저장소 상태(누락 데이터셋·수집기 연결)
 *  - 값 없음: 판정 불가(중립색) + 받지 못한 입력, 장부 없음 안내, 매크로 저장본 없음, "새 알림이 없습니다", 모르는 수는 "—"(읽어 주기 "값 없음")
 *  - 일부 실패: 한 경로가 실패해도 그 구역만 오류(role="alert", 다시 시도), 나머지는 그린다
 *  - 추정: isEstimated 카드에 '추정' 배지 / 오래됨: isStale 카드·가격 없는 보유 계좌·늦은 관측치에 '이전 값' + 사유
 *  - 회원(운영자 아님): /api/paper/*·/api/status*를 부르지 않고 그 구역이 없다
 *  - 맨 위 KPI 띠(오늘 요약): 타일마다 대상 화면 링크, 값·'—' + 사유·자리표시·변화 칩·수집 오류 아이콘 + 글, 모의매매 값 없음
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
/**
 * 저장소 상태 줄의 수 묶음(수 글 전체를 감싼 tabular-nums 상자 — 상태가 있으면 StatusText). 항목(이름 + 수)마다 줄 바꿈 없는
 * 덩어리라(QA-505) 수 글 전체는 getByText 한 번으로 찾을 수 없어 이 상자의 textContent로 봅니다.
 */
const storeCounts = (container: HTMLElement) => within(container).getByText(/^수집 태스크 오류/).closest(".tabular-nums") as HTMLElement;

/** 모의매매 히어로 구역 이름 — 불러오는 중·오류·읽은 뒤 모두 같습니다(큰 숫자가 무엇인지 제목이 먼저 말함). */
const PAPER_REGION = "모의매매 · Claude 계좌 순자산";

/** 모의매매 히어로(운영자, 장부를 읽은 뒤) — 같은 이름의 구역에 평가 시각 줄·계좌 행이 그려진 뒤. */
async function paperHero(): Promise<HTMLElement> {
  // 제목에도 "Claude 계좌 순자산"이 있어(불러오는 중에도) 평가 시각 줄로 기다립니다.
  await screen.findByText(/^Claude 계좌 순자산 · 마지막 관측/);
  return region(PAPER_REGION);
}

/**
 * 요소의 가로 간격 클래스(접두어 하나, 예: "p"·"px"·"-mx")를 px로 — 좁은 화면(기본)과 lg. lg 값이 없으면 기본 값을 물려받습니다.
 * 간격 단위 4px(p-6 → 24, p-2.5 → 10), 임의 값은 [20px]. 없으면 0.
 */
function inlineSpacing(element: Element, prefixes: string[]): { base: number; lg: number } {
  const px = (raw: string) => (raw.startsWith("[") ? Number.parseFloat(raw.slice(1)) : Number.parseFloat(raw) * 4);
  const find = (variant: string) => {
    for (const token of element.className.split(/\s+/)) {
      for (const prefix of prefixes) {
        if (token.startsWith(`${variant}${prefix}-`)) return px(token.slice(variant.length + prefix.length + 1));
      }
    }
    return null;
  };
  const base = find("") ?? 0;
  return { base, lg: find("lg:") ?? base };
}

/** 시장 행 한 줄(링크) — 시장 구역 안 이름 글자에서 가장 가까운 a(맨 위 KPI 띠에도 같은 이름이 있음). */
function marketRow(name: string): HTMLElement {
  return within(region("시장")).getByText(name).closest("a") as HTMLElement;
}

/** 국면 구역 안의 글 — 맨 위 KPI 띠의 국면 타일에도 같은 판정 라벨이 있어 구역으로 좁힙니다. */
const inRegime = () => within(region("오늘의 국면"));

/** 국면 패널의 신호 줄(속성 목록의 이름·값 한 줄 — dt를 감싼 줄). */
const signalRows = (panel: HTMLElement) => Array.from(panel.querySelectorAll("dl > div")) as HTMLElement[];

describe("홈 — 값 있음(운영자)", () => {
  it("라우트 /는 홈 화면을 그린다(옛 /macro 리디렉션 대신)", async () => {
    reads = happyReads();
    renderHome(OWNER, <HomePage />);
    expect(await screen.findByRole("heading", { name: "오늘의 국면" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "홈" })).toBeTruthy();
  });

  it("오늘의 국면 — 백엔드 라벨·판정 문장·기준일(뜻 포함)·신호 넷(속성 목록)·자세히 링크, '3일 확정'은 없다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const label = await inRegime().findByText("확장 (Expansion)");
    // 판정이 났으면 큰 글자 잉크 그대로(판정 불가만 중립색).
    expect(label.className).not.toContain("text-neutral");
    const hero = region("오늘의 국면");
    expect(within(hero).getByText(/위험자산에 우호적인 조합입니다/)).toBeTruthy();
    expect(within(hero).getByText("2026-10-16")).toBeTruthy();
    expect(within(hero).getByText(/네 입력 계열의 마지막 날짜 중 가장 이른 날/)).toBeTruthy();
    // 모든 숫자에 출처(PRINCIPLES) — 국면 판정의 입력 출처와 백엔드 고지(임계치는 참고치).
    expect(within(hero).getByText(SOURCES.regime)).toBeTruthy();
    expect(within(hero).getByText("임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.")).toBeTruthy();
    // 신호 넷은 속성 목록(이름 — 값+단위, 상태·해석 글) — 백엔드 순서와 상관없이 금리차·NFCI·하이일드·순유동성 자리.
    const signals = signalRows(hero);
    expect(signals.map((row) => row.querySelector("dt")?.textContent)).toEqual([
      "장단기 금리차 10Y-3M", "시카고 연준 금융상황지수", "하이일드 스프레드", "연준 순유동성 4주 변화",
    ]);
    expect(signals[0].querySelector("dd")?.textContent).toContain("+0.78%p");
    expect(signals[0].querySelector("dd")?.textContent).toContain("정상 · 장기 금리가 단기보다 높습니다(정상 구조).");
    expect(signals[3].querySelector("dd")?.textContent).toContain("+0.031조 달러");
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
    // 계좌 행 아바타(약칭)와 모의매매 개요 곡선과 같은 계좌 색 고리(Claude = 주황) — 장식이라 링크 이름에 섞이지 않음
    const avatar = rows[1].querySelector('[aria-hidden="true"].rounded-full') as HTMLElement;
    expect(avatar.textContent).toBe("C1");
    expect(avatar.style.getPropertyValue("--avatar-ring")).toBe("#d95926");
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

  it("모의매매 — 계좌 행 구분선은 히어로 가장자리까지(음수 여백 = 히어로 안쪽 여백), 행 글자는 히어로 글과 같은 세로줄", async () => {
    // 계좌 목록의 음수 여백·줄 여백은 패턴 Hero·AssetRow의 안쪽 여백에 묶여 있습니다. 그쪽 여백만 바뀌면 구분선이 카드 밖으로 삐져나가고
    // 행 글자가 히어로 글의 세로줄에서 어긋나는데, 시험은 그대로 통과했습니다(검토 지적 — 작업대 P2의 갈래를 합칠 때).
    reads = happyReads();
    renderHome(OWNER);
    const hero = await paperHero();
    const list = hero.querySelector("ul") as HTMLElement;
    const item = list.querySelector("li") as HTMLElement;
    const row = item.firstElementChild as HTMLElement;
    const frame = inlineSpacing(hero, ["p", "px"]);
    const bleed = inlineSpacing(list, ["-mx"]);
    const gutter = inlineSpacing(item, ["px", "p"]);
    const inset = inlineSpacing(row, ["px", "p"]);
    expect(frame.base).toBeGreaterThan(0);
    expect(bleed).toEqual(frame);
    expect({ base: gutter.base + inset.base, lg: gutter.lg + inset.lg }).toEqual(frame);
  });

  it("시장 — 범주별 자산 행(링크 → 지표 상세 /markets/i/<키>, 범주는 h3), 출처·장 상태·지연·시각 배지, 참고 시세, 저장본 수집 시각", async () => {
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
    expect(usdkrw.getAttribute("href")).toBe("/markets/i/usdkrw");
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
    const us10y = (await within(region("시장")).findByText("미국채 10년물 수익률(%)")).closest("a") as HTMLElement;
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
    expect(storeCounts(line).textContent).toBe("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개");
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
    expect(late.querySelector(".border-4")).toBeNull();
    // 읽지 않은 수에 드는 알림만 칠한 점(잉크 — 강조 파랑 아님)과 굵은 글씨입니다.
    expect(unread.querySelector(".border-4.border-text")).not.toBeNull();
    expect(unread.querySelector("[class*='accent']")).toBeNull();
    expect(within(unread).getByText("외국인 5일 연속 순매수").className).toContain("font-semibold");
  });
});

describe("홈 — 맨 위 KPI 띠(오늘 요약)", () => {
  /** KPI 띠의 타일(링크) — 이름(첫 줄 글)으로 찾습니다. */
  const kpi = (label: string) => {
    const strip = region("오늘 요약");
    const tile = within(strip).getAllByRole("link").find((link) => link.firstElementChild?.textContent === label);
    if (!tile) throw new Error(`KPI 타일 없음: ${label}`);
    return tile;
  };

  it("운영자 — 국면·시장 넷·읽지 않은 알림·수집 오류, 타일마다 대상 화면 링크 · 모의매매 값은 없다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await inRegime().findByText("확장 (Expansion)");
    await within(region("시장")).findByText("원/달러 (USD/KRW)");
    await within(region("알림")).findByText("[국면 전환] 후퇴 경계 → 확장");
    await within(region("데이터 저장소 상태")).findByRole("link");
    const strip = region("오늘 요약");
    expect(within(strip).getAllByRole("link").map((link) => [link.firstElementChild?.textContent, link.getAttribute("href")])).toEqual([
      ["국면", "/regime"],
      ["S&P 500", "/markets/i/sp500"],
      ["코스피", "/markets/i/kospi"],
      ["원/달러", "/markets/i/usdkrw"],
      ["미국채 10년물", "/markets/i/us10y"],
      ["읽지 않은 알림", "/alerts"],
      ["수집 오류", "/status"],
    ]);
    // 국면 — 백엔드 라벨(판정이 났으면 중립색이 아님)과 기준일
    expect(within(kpi("국면")).getByText("확장 (Expansion)").className).not.toContain("text-neutral");
    expect(within(kpi("국면")).getByText("기준일 2026-10-16")).toBeTruthy();
    // 시장 — 값은 수집기 priceStr, 변화 칩(▲▼·− 부호·읽어 주는 방향), 시각
    const sp500 = kpi("S&P 500");
    expect(within(sp500).getByText("7,622.99")).toBeTruthy();
    expect(within(sp500).getByText("하락")).toBeTruthy();
    expect(within(sp500).getByText("−40.46")).toBeTruthy();
    expect(within(sp500).getByText("2026-10-24 04:59")).toBeTruthy();
    expect(within(kpi("원/달러")).getByText("1,322.28")).toBeTruthy();
    expect(within(kpi("원/달러")).getByText("원")).toBeTruthy();
    // 저장본에 그 카드가 없으면 '—'(읽어 주기 '값 없음') + 사유 — 0으로 적지 않습니다.
    for (const label of ["코스피", "미국채 10년물"]) {
      expect(within(kpi(label)).getByText("값 없음")).toBeTruthy();
      expect(within(kpi(label)).getByText("저장본에 없음")).toBeTruthy();
    }
    expect(kpi("읽지 않은 알림").textContent).toBe("읽지 않은 알림2건");
    // 오류·경고·누락이 모두 0이면 상태 글(아이콘)이 없습니다.
    expect(kpi("수집 오류").textContent).toBe("수집 오류0건");
    expect(kpi("수집 오류").querySelector("svg")).toBeNull();
    // KPI 띠에는 모의매매 값이 없습니다(모의 자료는 계좌 구역 하나만).
    expect(strip.textContent).not.toMatch(/Claude|계좌|99,967/);
  });

  it("수집 오류 — 오류가 있으면 위험 아이콘 + 글(경고·누락 수), 경고만 있으면 주의 아이콘 + 글 · 색만으로 전하지 않음", async () => {
    for (const [response, tone, text] of [[issues(3, 19), "text-danger", "경고 19건 · 누락 0개"], [issues(0, 19), "text-warn", "경고 19건 · 누락 0개"]] as const) {
      reads = { ...happyReads(), [ISSUES]: response };
      const { unmount } = renderHome(OWNER);
      await within(region("데이터 저장소 상태")).findByRole("link");
      const tile = kpi("수집 오류");
      const status = within(tile).getByText(text).closest(`.${tone}`) as HTMLElement;
      expect(status, tone).not.toBeNull();
      expect(Array.from(status.querySelectorAll("svg")).map((icon) => icon.getAttribute("aria-hidden"))).toEqual(["true"]);
      // 아이콘 옆 읽어 주는 머리말(위험·주의)도 있습니다.
      expect(status.querySelector(".sr-only")?.textContent).toBeTruthy();
      unmount();
    }
  });

  it("읽는 중이면 타일마다 자리표시, 읽지 못한 경로의 타일은 '—' + '읽지 못함'(오류 글·다시 시도는 그 구역에만)", async () => {
    reads = { ...happyReads(), [MACRO]: new Error("요청 실패 (HTTP 500)") };
    renderHome(OWNER);
    await within(region("시장")).findByText("요청 실패 (HTTP 500)");
    for (const label of ["S&P 500", "코스피", "원/달러", "미국채 10년물"]) {
      expect(within(kpi(label)).getByText("값 없음")).toBeTruthy();
      expect(within(kpi(label)).getByText("읽지 못함")).toBeTruthy();
    }
    // 실패 알림(role=alert)과 다시 시도는 시장 구역 하나에만 — KPI 띠는 같은 실패를 다시 알리지 않습니다.
    expect(within(region("오늘 요약")).queryAllByRole("alert")).toHaveLength(0);
    expect(within(region("오늘 요약")).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("판정 불가 — 국면 타일은 중립색, 기준일을 모르면 그 줄이 없다", async () => {
    reads = { ...happyReads(), [REGIME]: regimeUnknown() };
    renderHome(OWNER);
    await inRegime().findByText("판정 불가");
    const tile = kpi("국면");
    expect(within(tile).getByText("판정 불가").className).toContain("text-neutral");
    expect(within(tile).queryByText(/기준일/)).toBeNull();
  });
});

describe("홈 — 불러오는 중·값 없음", () => {
  it("응답 전에는 구역마다 자리표시(Skeleton) — 한 구역이 화면 전체를 막지 않는다", () => {
    renderHome(OWNER);
    const labels = screen.getAllByRole("status").map((node) => node.getAttribute("aria-label"));
    expect(labels).toEqual([
      // 맨 위 KPI 띠 — 타일마다(읽는 경로가 다른 타일이 서로를 기다리지 않음)
      "국면 불러오는 중",
      "S&P 500 불러오는 중",
      "코스피 불러오는 중",
      "원/달러 불러오는 중",
      "미국채 10년물 불러오는 중",
      "읽지 않은 알림 불러오는 중",
      "수집 오류 불러오는 중",
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

  it("국면·모의매매 구역은 불러오는 중에도 읽은 뒤와 같은 틀 — 값이 와도 틀 여백이 바뀌지 않는다", async () => {
    // 예전에는 불러오는 중·오류를 다른 틀(다른 안쪽 여백)로 그려, 값이 오는 순간 제목·본문이 lg에서 16px 튀었습니다(검토 지적).
    renderHome(OWNER);
    const loading = [region("오늘의 국면").className, region(PAPER_REGION).className];
    cleanup();
    reads = happyReads();
    renderHome(OWNER);
    await paperHero();
    await inRegime().findByText("확장 (Expansion)");
    expect([region("오늘의 국면").className, region(PAPER_REGION).className]).toEqual(loading);
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

    const unknown = await inRegime().findByText("판정 불가");
    // 판정 불가는 판정 난 라벨과 같은 잉크로 그리지 않습니다(중립색).
    expect(unknown.className).toContain("text-neutral");
    const hero = unknown.closest("section") as HTMLElement;
    expect(within(hero).getByText(/입력 지표가 빠져 국면을 판정하지 않습니다/)).toBeTruthy();
    expect(within(hero).getByText(/받지 못한 입력: 하이일드 스프레드 \(HY OAS\)/)).toBeTruthy();
    const hyOas = signalRows(hero).find((row) => row.querySelector("dt")?.textContent === "하이일드 스프레드") as HTMLElement;
    expect(within(hyOas).getByText("—")).toBeTruthy();
    expect(within(hyOas).getByText("값 없음")).toBeTruthy();
    expect(within(hyOas).getByText("받지 못함")).toBeTruthy();
    expect(hyOas.textContent).not.toContain("%p");
    expect(signalRows(hero)).toHaveLength(4);
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

  it("저장소 상태 — 수집기에 닿지 못하면 '연결 안 됨 — DB 기록만'(주의 아이콘 + 주의색), 누락 데이터셋은 모름 · 누락이 있으면 그 수", async () => {
    const down = { ...issues(0, 0), collectorReachable: false };
    down.counts = { ...down.counts, missingDatasets: null };
    reads = { ...happyReads(), [ISSUES]: down };
    const { unmount } = renderHome(OWNER);
    let line = await within(region("데이터 저장소 상태")).findByRole("link");
    expect(within(line).getByText(COLLECTOR_UNREACHABLE_NOTE)).toBeTruthy();
    expect(line.textContent).toContain("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 —값 없음");
    // 주의는 안내 한 곳(주의 아이콘 + 주의색)이 나르고, 오류·경고가 없는 수 묶음은 중립입니다(QA-505).
    expect(within(line).getByText(COLLECTOR_UNREACHABLE_NOTE).closest(".text-warn")).not.toBeNull();
    expect(storeCounts(line).closest(".text-warn")).toBeNull();
    unmount();

    const missing = issues(0, 0);
    missing.counts.missingDatasets = 3;
    reads = { ...happyReads(), [ISSUES]: missing };
    renderHome(OWNER);
    line = await within(region("데이터 저장소 상태")).findByRole("link");
    expect(storeCounts(line).textContent).toBe("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 3개");
    expect(storeCounts(line).closest(".text-warn")).not.toBeNull();
    expect(within(line).queryByText(COLLECTOR_UNREACHABLE_NOTE)).toBeNull();
  });

  // QA-505: 저장소 상태 줄의 수 묶음은 오류면 위험색(text-danger), 경고·누락이면 주의색(text-warn)으로 글만 칠하고 아이콘이 없었습니다.
  // 위험색 #e76a6e는 상승 빨강 #ff6b6b와 ΔE 4.4로 거의 같은 색이라(W4) 시장 행의 상승 값과 같은 뜻으로 읽힙니다 — 명세 §3-2·ADR 0042
  // 결정 3 '상태·위험은 늘 아이콘 + 글'. 글에 이미 '오류'·'경고'가 있어 아이콘은 장식(aria-hidden)이고, 모두 0이면 상태가 아니라 아이콘이 없습니다.
  it("QA-505: 오류가 있으면 수 묶음 앞에 아이콘 + 위험색, 경고만 있으면 아이콘 + 주의색, 모두 0이면 아이콘 없음", async () => {
    const countGroup = async (response: ReturnType<typeof issues>, toneClass: string) => {
      reads = { ...happyReads(), [ISSUES]: response };
      const { unmount } = renderHome(OWNER);
      const line = await within(region("데이터 저장소 상태")).findByRole("link");
      const text = within(line).getByText(/^수집 태스크 오류/);
      const group = text.closest(`.${toneClass}`) as HTMLElement | null;
      expect(group, `${toneClass} 수 묶음`).not.toBeNull();
      const icons = Array.from((group as HTMLElement).querySelectorAll("svg"));
      // 아이콘이 수 글 앞에 서는지(문서 순서).
      const iconFirst = icons.length > 0 && Boolean(icons[0].compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING);
      unmount();
      return { hidden: icons.map((icon) => icon.getAttribute("aria-hidden")), iconFirst };
    };

    for (const [response, toneClass] of [[issues(3, 19), "text-danger"], [issues(0, 19), "text-warn"]] as const) {
      const { hidden, iconFirst } = await countGroup(response, toneClass);
      expect(hidden, `${toneClass} 수 묶음의 아이콘`).toEqual(["true"]);
      expect(iconFirst, `${toneClass} 아이콘이 수 글 앞`).toBe(true);
    }
    expect((await countGroup(issues(0, 0), "tabular-nums")).hidden).toEqual([]);
  });

  // QA-505 후속(검토): 수 묶음 앞에 아이콘(14px + 간격 6px)이 붙자 390px에서 한 줄이던 수 글이 두 줄이 되며 '… · 누락 데이터셋' / '1개'로,
  // 360px에서는 '… · 누락 데이' / '터셋 1개'로 이름과 수가 다른 줄에 갈라졌습니다(QA 스택 실측 0/19/1). 항목(이름 + 수)마다 줄 바꿈 없는
  // 덩어리로 두어 줄은 ' · ' 자리에서만 바뀝니다. 수를 모르는 칸('—' + 읽어 주는 '값 없음')도 같은 덩어리입니다.
  it("QA-505: 수 묶음의 항목(이름 + 수)마다 줄 바꿈 없는 덩어리 — 좁은 화면에서 이름과 수가 다른 줄로 갈라지지 않는다", async () => {
    const warn = issues(0, 19);
    warn.counts.missingDatasets = 1;
    const cases = [
      [warn, ["수집 태스크 오류 0건", "경고 19건", "누락 데이터셋 1개"]],
      [issues(0, 0), ["수집 태스크 오류 0건", "경고 0건", "누락 데이터셋 0개"]],
      [{ ...issues(), counts: undefined }, ["수집 태스크 오류 —값 없음", "경고 —값 없음", "누락 데이터셋 —값 없음"]],
    ] as const;
    for (const [response, expected] of cases) {
      reads = { ...happyReads(), [ISSUES]: response };
      const { unmount } = renderHome(OWNER);
      const line = await within(region("데이터 저장소 상태")).findByRole("link");
      const items = Array.from(storeCounts(line).querySelectorAll(".whitespace-nowrap"), (node) => node.textContent);
      expect(items, expected[2]).toEqual(expected);
      unmount();
    }
  });

  // QA-505 후속(검토): 수집기에 닿지 못하면 모델 톤이 warn이라 수 묶음 앞에 주의 아이콘(14px)이 붙고, 바로 옆 안내 '수집기 연결 안 됨 — DB
  // 기록만'에도 주의 아이콘(12px)이 있어 한 링크 안에 같은 아이콘이 크기만 달리 두 번 섰습니다. 첫 아이콘은 '오류 0건' 앞이라 0건이 경고처럼
  // 읽힙니다. 상태 화면은 이때 수를 중립으로 두고 주의를 배너 한 곳에 둡니다(QA-102). 오류·경고·누락이 없으면 수 묶음은 중립(아이콘 없음),
  // 주의 아이콘은 안내 한 곳입니다. 경고가 있으면 수 묶음의 아이콘은 그 경고의 것이라 그대로입니다.
  it("QA-505: 수집기 연결 안 됨만이면 주의 아이콘은 안내 한 곳 — 수 묶음은 중립, 경고가 있으면 수 묶음도 주의", async () => {
    const iconsOf = async (warnings: number) => {
      const down = { ...issues(0, warnings), collectorReachable: false };
      down.counts = { ...down.counts, missingDatasets: null };
      reads = { ...happyReads(), [ISSUES]: down };
      const { unmount } = renderHome(OWNER);
      const line = await within(region("데이터 저장소 상태")).findByRole("link");
      const counts = storeCounts(line);
      const notice = within(line).getByText(COLLECTOR_UNREACHABLE_NOTE).closest(".text-warn") as HTMLElement;
      const result = {
        counts: counts.querySelectorAll("svg").length,
        countsWarn: counts.closest(".text-warn") !== null,
        notice: notice.querySelectorAll("svg").length,
      };
      unmount();
      return result;
    };
    expect(await iconsOf(0), "연결 안 됨 · 오류 0건 · 경고 0건").toEqual({ counts: 0, countsWarn: false, notice: 1 });
    expect(await iconsOf(19), "연결 안 됨 · 경고 19건").toEqual({ counts: 1, countsWarn: true, notice: 1 });
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
    expect(inRegime().getByText("확장 (Expansion)")).toBeTruthy();
    expect(await paperHero()).toBeTruthy();
    expect(screen.getByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
    expect(storeCounts(region("데이터 저장소 상태")).textContent).toBe("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개");

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
    expect(inRegime().getByText("확장 (Expansion)")).toBeTruthy();
  });

  it("자동 갱신이 실패하면 앞서 받은 시장 행을 두고 '새로 읽지 못함'(QA-067)", async () => {
    reads = happyReads();
    const { rerender } = renderHome(OWNER);
    await screen.findByText("원/달러 (USD/KRW)");
    expect(within(region("시장")).queryByText("새로 읽지 못함")).toBeNull();

    reads[MACRO] = new Error("백엔드 API에 연결하지 못했습니다");
    signal.token += 1;
    await act(async () => rerender(<SessionUserProvider user={OWNER}><HomeScreen /></SessionUserProvider>));
    await waitFor(() => expect(requested().filter((path) => path === MACRO)).toHaveLength(2));

    const market = region("시장");
    expect(await within(market).findByText("새로 읽지 못함")).toBeTruthy();
    expect(within(market).getByText("원/달러 (USD/KRW)")).toBeTruthy();
  });
});

describe("홈 — 추정·오래됨 배지", () => {
  it("추정 카드(isEstimated)에는 '추정' 배지가 반드시 보인다", async () => {
    const overview = macroOverview();
    overview.categories[2].items[0].isEstimated = true;
    reads = { ...happyReads(), [MACRO]: overview };
    renderHome(OWNER);

    const night = (await within(region("시장")).findByText("코스피200 야간선물")).closest("a") as HTMLElement;
    expect(within(night).getByText("추정")).toBeTruthy();
    expect(within(marketRow("원/달러 (USD/KRW)")).queryByText("추정")).toBeNull();
  });

  it("이어받은 카드(isStale)·가격 없는 보유 계좌에는 '이전 값' + 사유, 이어받은 카드에는 열린 장이어도 '실시간'을 붙이지 않는다", async () => {
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

    const usdkrw = (await within(region("시장")).findByText("원/달러 (USD/KRW)")).closest("a") as HTMLElement;
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

  it("지금 값(current) — 히어로는 개요와 같은 단계 표기·추정 배지·변화 한 줄, Claude 행도 같은 지금 값", async () => {
    const overview = paperOverview();
    overview.liveSession = { phase: "REGULAR", sessionDate: "2026-10-26" };
    overview.books![1] = {
      ...overview.books![1],
      current: {
        nav: 100123.45, returnPct: 0.12, exposurePct: 97.5, dayChangePct: 0.3, previousTradingDate: "2026-10-23", previousNavFinal: false,
        basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-26", atKst: "2026-10-26 23:58 KST", isEstimated: true, livePriced: 9,
        positionCount: 9, pendingOrders: 0, neutral: false, note: null,
      },
    };
    reads = { ...happyReads(), [PAPER_OVERVIEW]: overview };
    renderHome(OWNER);

    // 곧바로 resolve하는 목 응답을 끝까지 반영합니다(QA-147·148 — 벽시계 한도가 있는 findBy 대신).
    await act(async () => {});

    // 값의 기준 줄 — 계좌 이름 뒤에 단계 표기(개요와 같은 함수), 옛 응답의 '마지막 관측' 대신.
    const stage = screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "Claude 계좌 순자산 · 장중 추정 23:58");
    expect(stage).toBeTruthy();
    const hero = region(PAPER_REGION);
    // 히어로 값과 Claude 계좌 행이 같은 지금 값을 적습니다(한 카드에 두 숫자가 보이지 않음).
    expect(within(hero).getAllByText("100,123.45")).toHaveLength(2);
    expect(within(hero).getAllByText("추정")).toHaveLength(2);
    expect(within(hero).getByText("출발 대비")).toBeTruthy();
    expect(within(hero).getByText("· 10-23 잠정 대비")).toBeTruthy();
    expect(within(hero).getByText("오늘")).toBeTruthy();
    const claude = within(hero).getByText("Claude 계좌").closest("a") as HTMLElement;
    expect(within(claude).getByText("장중 추정 23:58 · 오늘 +0.30% · 10-23 잠정 대비")).toBeTruthy();
    expect(within(hero).queryByText(/· 마지막 관측/)).toBeNull();
  });

  it("장부 관측치 저장본이 늦으면(백엔드 quotes.stale) 네 계좌 모두 '이전 값'(모의매매 개요와 같은 사유)", async () => {
    const ledger = paperOverview();
    ledger.quotes!.stale = true;
    reads = { ...happyReads(), [PAPER_OVERVIEW]: ledger };
    renderHome(OWNER);

    const paper = await paperHero();
    // 네 행은 사유에 마지막 관측 시각, 히어로는 그 시각을 값의 기준 줄('… · 마지막 관측 2026-10-26 04:56')에 이미 적어 사유에서 뺌
    expect(within(paper).getAllByText("· 관측치 저장본이 늦음 · 마지막 관측 2026-10-26 04:56")).toHaveLength(4);
    expect(within(paper).getAllByText("· 관측치 저장본이 늦음")).toHaveLength(1);
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

  // 예전에는 한국을 고르면 읽는 중 카드(히어로와 다른 틀)에 라디오가 다시 그려져 초점이 body로 빠지고, 미국을 갔다 오면 한국 값을
  // 지워 다시 자리표시였습니다.
  it("키보드로 시장을 고르면 초점이 그 라디오에 남는다 — 읽는 중·읽은 뒤 모두, 미국 → 한국을 다시 골라도 자리표시 없이", async () => {
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
    const reason = "한국 계좌 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다";
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: paperOverviewKrDormant(reason), [PAPER_KR_STATUS]: { ...paperStatusKr(false), dormantReason: reason } };
    renderHome(OWNER);
    await pickKorea();
    expect(await screen.findByText(`한국 계좌가 쉬고 있습니다 — ${reason}`)).toBeTruthy();
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

      expect(await inRegime().findByText("확장 (Expansion)")).toBeTruthy();
      expect(await screen.findByText("원/달러 (USD/KRW)")).toBeTruthy();
      expect(await screen.findByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
      expect(requested().some((path) => path.startsWith("/api/paper") || path.startsWith("/api/status"))).toBe(false);
      expect(requested().sort()).toEqual([INBOX, KR_HOLIDAYS, MACRO, REGIME, UNREAD].sort());
      expect(screen.queryByRole("heading", { name: /모의매매/ })).toBeNull();
      expect(screen.queryByRole("region", { name: "데이터 저장소 상태" })).toBeNull();
      expect(screen.queryByText(/수집 태스크 오류/)).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "모의매매 시장" })).toBeNull();
      // KPI 띠에도 수집 오류(운영자) 타일이 없습니다.
      expect(within(region("오늘 요약")).getAllByRole("link").map((link) => link.getAttribute("href")))
        .toEqual(["/regime", "/markets/i/sp500", "/markets/i/kospi", "/markets/i/usdkrw", "/markets/i/us10y", "/alerts"]);
    });
  }
});
