/**
 * 홈(/) 화면 — 고정 응답 이야기로 네 상태를 확인한다(설계서 §9 DoD "없음·일부 실패·추정·오래됨").
 *  - 값 있음: 국면 패널(백엔드 라벨·문장·기준일·출처·고지·신호 넷), 계좌 손익 표(네 계좌 — 순자산·출발 대비·최근 변화·기준, 출처·출발 줄),
 *    시장 묶음 표(범주 탭, 장 상태 — 열린 장만 지연), 알림·끊긴 출처(지난 사건은 강조하지 않음, 끊긴 출처, 수집 상태 — 누락 데이터셋·수집기 연결)
 *  - 값 없음: 판정 불가(중립색) + 받지 못한 입력, 장부 없음 안내, 매크로 저장본 없음, "새 알림이 없습니다", 모르는 수는 "—"(읽어 주기 "값 없음")
 *  - 일부 실패: 한 경로가 실패해도 그 구역만 오류(role="alert", 다시 시도), 나머지는 그린다
 *  - 추정: isEstimated 카드에 '추정' 배지 / 오래됨: isStale 카드·가격 없는 보유 계좌·늦은 관측치에 '이전 값' + 사유
 *  - 회원(운영자 아님): /api/paper/*·/api/status*·/api/info/sources를 부르지 않고 그 구역·칸이 없다
 *  - 맨 위 KPI 띠(오늘 요약): 타일마다 대상 화면 링크, 값·'—' + 사유·자리표시·변화 칩·수집 오류 아이콘 + 글, 모의매매 값 없음
 *  - 배치: KPI 띠 + 패널(운영자 [국면][알림·끊긴 출처] / [계좌 두 칸] / [시장 두 칸] — 2026-11-16 결정 5, 회원 [국면][알림] / [시장 두 칸]),
 *    시장 묶음 탭 줄은 두 줄 허용(결정 1), 패널 안 누름 자리 44px,
 *    ▲▼는 모두 12px·em 크기 없음·읽어 주는 방향 글
 *
 * 보는 시각은 2026-10-26(월) 16:51 KST로 고정합니다(장 상태가 시각에 따라 바뀜) — 외환·CME 개장, 뉴욕 증시 마감, KRX 선물 휴식.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { COLLECTOR_UNREACHABLE_NOTE, PAPER_COMPARE_NOTE, PAPER_HREF, PAPER_KR_HREF } from "@/lib/home";
import { PAPER_SOURCES } from "@/lib/paper";
import { bookColor } from "../../paper/bookColors";
import { SOURCES } from "@/lib/sources";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import type { SessionUser } from "@/lib/types";
import {
  inbox,
  incident,
  infoSources,
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
// 끊긴 출처 — 셸의 수집 끊김 안내 띠와 같은 경로(운영자 전용).
const INFO_SOURCES = "/api/info/sources";
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
    [INFO_SOURCES]: infoSources(),
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

/** 알림 패널 이름 — 운영자는 끊긴 출처·수집 상태가 함께라 '알림·끊긴 출처', 회원·데모는 알림만이라 '알림'. */
const ALERTS_REGION = "알림·끊긴 출처";

/** 운영자 알림 패널 안 수집 상태 줄(상태 화면 링크) — 수를 읽은 뒤. */
async function storeLine(): Promise<HTMLElement> {
  return within(region(ALERTS_REGION)).findByRole("link", { name: /^수집 태스크 오류/ });
}

/** 알림 패널 머리의 '읽지 않음 N건'(이름과 수). */
const unreadCount = (name = ALERTS_REGION) => within(region(name)).getByText(/^읽지 않음/);

/** 운영자 알림 패널의 최근 알림 줄(이름 있는 목록 '최근 알림'의 줄 — 끊긴 출처 줄과 섞이지 않게). */
const alertItems = () => within(within(region(ALERTS_REGION)).getByRole("list", { name: "최근 알림" })).getAllByRole("listitem");

/** 계좌 손익 표 구역 이름 — 불러오는 중·오류·읽은 뒤 모두 같습니다. */
const PAPER_REGION = "모의매매 계좌";

/** 계좌 손익 표(운영자, 장부를 읽은 뒤) — 같은 이름의 구역에 계좌 줄이 그려진 뒤. `book`은 기다릴 계좌 이름(링크). */
async function paperPanel(book = "Claude 계좌"): Promise<HTMLElement> {
  await within(region(PAPER_REGION)).findByRole("link", { name: book });
  return region(PAPER_REGION);
}

/** 계좌 표의 한 줄(tr) — 계좌 이름 링크에서. */
function bookRow(panel: HTMLElement, book: string): HTMLElement {
  return within(panel).getByRole("link", { name: book }).closest("tr") as HTMLElement;
}

/** 표 한 줄의 칸 글(열 순서 — 계좌·순자산·출발 대비·최근 변화·기준). 읽어 주기 전용 글(sr-only)은 뺍니다. */
function cellTexts(row: HTMLElement): string[] {
  return Array.from(row.children, (cell) => {
    const copy = cell.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
    return copy.textContent ?? "";
  });
}

/** 시장 표 한 줄(tr) — 시장 구역 안 지표 이름 링크에서(맨 위 KPI 띠에도 비슷한 이름이 있음). 그 묶음 탭이 골라져 있어야 합니다. */
function marketRow(name: string): HTMLElement {
  return within(region("시장")).getByRole("link", { name }).closest("tr") as HTMLElement;
}

/** 시장 묶음 탭을 고릅니다(처음은 첫 범주 — 고른 묶음의 표만 그림). */
function showGroup(title: string) {
  fireEvent.click(within(region("시장")).getByRole("tab", { name: title }));
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

  // QA-600: 국면 패널 신호 값의 음수가 ASCII 하이픈('-0.496')이라 같은 화면 변화 칩·KPI의 −(U+2212)와 섞였습니다.
  // 수정 전(재현 커밋에서는 it.fails) NFCI 줄은 '-0.496완화적 · …'이었습니다.
  it("오늘의 국면 — 신호 값의 음수는 −(U+2212), 숫자 앞 ASCII 하이픈이 없다 (QA-600)", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await inRegime().findByText("확장 (Expansion)");
    const signals = signalRows(region("오늘의 국면"));
    expect(signals[1].querySelector("dd")?.textContent).toContain("\u22120.496");
    // 숫자 앞(글 마디의 처음·공백·'(' 뒤) 하이픈 — '10Y-3M'·'2026-10-16'의 하이픈은 숫자 앞이 아닙니다. 구역 글 전체(textContent)로 보면
    // 신호 이름(dt) 바로 뒤에 값이 이어 붙어 '…지수-0.496'이 되어 걸리지 않으므로 글 마디마다 봅니다.
    const walker = document.createTreeWalker(region("오늘의 국면"), NodeFilter.SHOW_TEXT);
    const hyphenated: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/(^|[\s(])-(?=[\d.])/.test(node.textContent ?? "")) hyphenated.push(node.textContent ?? "");
    }
    expect(hyphenated).toEqual([]);
  });

  it("계좌 손익 표 — 네 계좌(이름은 모의매매 화면 링크·종류·상태·계좌 색 견본)·순자산·출발 대비·기준·출처·출발 줄·정기 작업 꺼짐 안내, 쓰기 버튼은 없다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const panel = await paperPanel();
    expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe(PAPER_REGION);
    // 머리 개수 — 계좌 수
    expect(within(panel).getByText("4개")).toBeTruthy();
    const table = within(panel).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["계좌", "순자산", "출발 대비", "최근 변화", "기준"]);
    const links = within(table).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["규칙 계좌", PAPER_HREF], ["Claude 계좌", PAPER_HREF], ["SPY 계좌", PAPER_HREF], ["60/40 계좌", PAPER_HREF],
    ]);
    // 줄마다 칸: 계좌(이름·종류·상태) · 순자산(달러) · 출발 대비(−0.03%) · 최근 변화(옛 응답이라 모름 '—') · 기준(마지막 관측)
    const claude = bookRow(panel, "Claude 계좌");
    expect(cellTexts(claude)).toEqual(["Claude 계좌Claude · 운용 중", "99,967.28달러", "▼−0.03%", "—", "마지막 관측 2026-10-26 04:56"]);
    expect(within(claude).getByText("하락")).toBeTruthy();
    expect(within(claude).getByText("값 없음")).toBeTruthy();
    // 계좌 행 이름 칸은 행 머리(th scope=row) — 낭독기가 칸을 옮길 때 계좌 이름을 함께 읽음
    expect(claude.querySelector("th[scope=row]")?.textContent).toContain("Claude 계좌");
    // 계좌 색 견본(장식)은 모의매매 개요 곡선과 같은 색(Claude = 주황) — 링크 이름에 섞이지 않음
    const swatch = claude.querySelector('[aria-hidden="true"][style]') as HTMLElement;
    expect(swatch.style.getPropertyValue("--book-color")).toBe(bookColor("claude", 1));
    expect(within(panel).getByText(PAPER_SOURCES.ledger)).toBeTruthy();
    expect(within(panel).getByText("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비")).toBeTruthy();
    expect(within(panel).getByText("정기 작업 꺼짐(PAPER_ENABLED=false) — 이 화면은 읽기 전용 사본")).toBeTruthy();

    // 미국 | 한국 — 라디오 묶음: 미국이 골라져 있고, 한국은 고를 수 있습니다(2단계 명세 §4-16 — '준비 중' 해제).
    const switcher = within(panel).getByRole("radiogroup", { name: "모의매매 시장" });
    const us = within(switcher).getByRole("radio", { name: "미국" }) as HTMLInputElement;
    expect(us.checked).toBe(true);
    const korea = within(switcher).getByRole("radio", { name: "한국" }) as HTMLInputElement;
    expect(korea.disabled).toBe(false);
    expect(korea.checked).toBe(false);
    // 두 책을 견주지 않는다는 문구는 미국 탭에도(탭마다 — 2단계 명세 §3).
    expect(within(panel).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    // 한국을 고르기 전에는 한국 요청이 없습니다.
    expect(requested().filter((path) => path.includes("market=KR"))).toEqual([]);

    // 홈에는 쓰기 버튼(초기화·리스크 실행·시작 등)이 없습니다 — 버튼이 하나도 없습니다.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("시장 — 범주 탭(처음은 첫 범주)·고른 묶음의 표(이름은 지표 상세 /markets/i/<키> 링크), 출처·장 상태·지연·시각, 참고 시세, 저장본 수집 시각", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await within(region("시장")).findByRole("link", { name: "원/달러 (USD/KRW)" });
    const market = region("시장");
    // 범주는 탭(이름 있는 탭 줄) — 범주마다 제목이나 영역을 겹쳐 만들지 않습니다(표의 가로 스크롤 상자 하나만 영역).
    expect(within(market).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["시장"]);
    const tabs = within(within(market).getByRole("tablist", { name: "시장 묶음" })).getAllByRole("tab");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["통화 및 환율", "true"], ["미국 주가지수 및 선물", "false"], ["아시아 주요 주가지수", "false"],
    ]);
    const panel = within(market).getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(within(panel).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["지표", "값", "변화", "기준"]);
    // 머리 개수 — 고른 묶음의 지표 수
    expect(within(market).getByText("1개")).toBeTruthy();
    const usdkrw = marketRow("원/달러 (USD/KRW)");
    expect(within(usdkrw).getByRole("link").getAttribute("href")).toBe("/markets/i/usdkrw");
    expect(within(usdkrw).getByText("1,322.28")).toBeTruthy();
    // 열린 장만 지연을 적습니다("개장 · 실시간", "개장 · 10분 지연" — /macro SessionBadge와 같은 규칙).
    expect(within(usdkrw).getByText("Yahoo Finance (KRW=X) · 개장 · 실시간 · 2026-10-26 16:51")).toBeTruthy();

    showGroup("미국 주가지수 및 선물");
    expect(within(market).getByRole("tab", { name: "미국 주가지수 및 선물" }).getAttribute("aria-selected")).toBe("true");
    expect(within(market).queryByRole("link", { name: "원/달러 (USD/KRW)" })).toBeNull();
    expect(within(market).getByText("2개")).toBeTruthy();
    expect(within(marketRow("S&P 500 선물 (ES)")).getByText("Yahoo Finance (ES=F) · 개장 · 10분 지연 · 2026-10-26 16:41")).toBeTruthy();
    // 닫힌 장(뉴욕 증시, 토요일 04:59 종가)에는 '실시간'을 찍지 않고 '마감'만.
    const sp500 = marketRow("S&P 500");
    expect(within(sp500).getByRole("link").getAttribute("href")).toBe("/markets/i/sp500");
    expect(within(sp500).getByText("Yahoo Finance (^GSPC) · 마감 · 2026-10-24 04:59")).toBeTruthy();
    expect(within(sp500).queryByText(/실시간|지연/)).toBeNull();

    showGroup("아시아 주요 주가지수");
    // '장 밖' 야간선물 카드(20분 지연)도 장이 닫혀 있으면 지연을 적지 않습니다.
    const night = marketRow("코스피200 야간선물");
    expect(within(night).getByText(/^TradingView Scanner · 참고 시세 · 휴식 · 2026-10-26 16:51/)).toBeTruthy();
    expect(within(night).queryByText(/지연|실시간/)).toBeNull();
    // 직전 값이 없는 카드(delta·pct null, deltaStr "N/A")는 변화 칩 대신 '—' — 0.00%를 만들지 않습니다.
    expect(within(night).queryByText(/%/)).toBeNull();
    expect(within(night).queryByText("N/A")).toBeNull();
    expect(within(night).getByText("값 없음")).toBeTruthy();
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
    await within(region("시장")).findByRole("link", { name: "미국채 10년물 수익률(%)" });
    const us10y = marketRow("미국채 10년물 수익률(%)");
    expect(within(us10y).getByText("4.992")).toBeTruthy();
    expect(within(us10y).getByText("−0.007")).toBeTruthy();
    expect(within(us10y).getByText("(−0.14%)")).toBeTruthy();
    expect(within(us10y).getByText("하락")).toBeTruthy();
  });

  it("알림·끊긴 출처 — 읽지 않은 수·최근 세 건(제목·발생일·읽음)·알림함 링크 / 끊긴 출처 없음 / 수집 상태 한 줄(→ /status)", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await screen.findByText("[국면 전환] 후퇴 경계 → 확장");
    const alerts = region(ALERTS_REGION);
    expect(unreadCount().textContent).toBe("읽지 않음 2건");
    // 패널 안 작은 제목 셋(운영자) — 최근 알림 · 끊긴 출처 · 수집 상태
    expect(within(alerts).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["최근 알림", "끊긴 출처", "수집 상태"]);
    expect(alertItems().map((item) => item.textContent)).toEqual([
      "[국면 전환] 후퇴 경계 → 확장2026-10-25 · 안 읽음",
      "Berkshire 13F 신규 편입2026-10-20 · 읽음",
      "외국인 5일 연속 순매수2026-10-18 · 안 읽음",
    ]);
    expect(within(alerts).getByRole("link", { name: "알림 전체 보기" }).getAttribute("href")).toBe("/alerts");
    expect(await within(alerts).findByText("끊긴 출처가 없습니다")).toBeTruthy();
    expect(within(alerts).getByRole("link", { name: "출처 상태 보기" }).getAttribute("href")).toBe("/info/status");

    const line = await storeLine();
    expect(line.getAttribute("href")).toBe("/status");
    expect(storeCounts(line).textContent).toBe("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개");
    expect(within(line).getByText("확인 2026-10-26 16:54")).toBeTruthy();
    // 데이터 카드마다 출처 줄(PRINCIPLES) — 상태 화면의 수집 오류·경고 로그와 같은 출처.
    expect(within(line).getByText(SOURCES.collectorRuns)).toBeTruthy();
    expect(within(line).queryByText(COLLECTOR_UNREACHABLE_NOTE)).toBeNull();
    // 끊긴 출처는 셸 안내 띠와 같은 경로를 한 번 읽습니다.
    expect(requested().filter((path) => path === INFO_SOURCES)).toHaveLength(1);
  });

  it("끊긴 출처 — 서버 순서대로 이름 · 끊긴 종류(주의 아이콘 + 글) · 사유 · 끊긴 시각, 판정 기록이 없으면 '없다'고 적지 않는다", async () => {
    reads = {
      ...happyReads(),
      [INFO_SOURCES]: infoSources([
        incident({ key: "wolf|blocked", label: "Wolf Street" }),
        incident({ key: "waedge|format", label: "waedge 시장", kind: "format", kindLabel: "형식 바뀜", reason: null, since: null }),
      ]),
    };
    const { unmount } = renderHome(OWNER);
    const alerts = region(ALERTS_REGION);
    const list = await within(alerts).findByRole("list", { name: "끊긴 출처" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.replace(/주의: /, ""))).toEqual([
      "Wolf Street차단됨 — 잠시 멈춤HTTP 403 · 2026-10-26 15:10부터",
      "waedge 시장형식 바뀜",
    ]);
    // 끊긴 종류는 색만이 아니라 아이콘(장식) + 읽어 주는 머리말 + 글
    const kind = within(rows[0]).getByText("차단됨 — 잠시 멈춤").closest(".text-warn") as HTMLElement;
    expect(kind.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(alerts).queryByText("끊긴 출처가 없습니다")).toBeNull();
    // 최근 알림 줄과 섞이지 않습니다.
    expect(alertItems()).toHaveLength(3);
    unmount();

    reads = { ...happyReads(), [INFO_SOURCES]: { ...infoSources(), recorded: false } };
    renderHome(OWNER);
    expect(await within(region(ALERTS_REGION)).findByText("출처 판정 기록이 없습니다 — 판정은 운영 서버에서만 합니다")).toBeTruthy();
    expect(within(region(ALERTS_REGION)).queryByText("끊긴 출처가 없습니다")).toBeNull();
  });

  // QA-605: 패널 머리의 읽지 않은 수는 읽는 중에도 실패에도 같은 '—'(읽어 주기 '값 없음')라 둘이 갈리지 않았습니다. 같은 수를 그리는 KPI 띠는
  // 읽는 중 자리표시(role=status) · 실패 '— 읽지 못함'(P4 '정한 것' 11)이라 한 화면에서 두 규칙이었습니다.
  // 수정 전(재현 커밋에서는 it.fails) 읽는 중 머리는 '읽지 않음 —값 없음'(role=status 없음), 실패도 '읽지 않음 —값 없음'이었습니다.
  it("알림 패널 머리의 읽지 않은 수 — 읽는 중은 '—'(값 없음)가 아니라 자리표시(role=status) (QA-605)", async () => {
    // unread-count 응답만 오지 않습니다(나머지 경로는 값).
    reads = happyReads();
    delete reads[UNREAD];
    renderHome(OWNER);
    await within(region(ALERTS_REGION)).findByText("[국면 전환] 후퇴 경계 → 확장");
    expect(within(unreadCount()).queryByText("값 없음")).toBeNull();
    expect(within(unreadCount()).getByRole("status", { name: "읽지 않은 수 불러오는 중" })).toBeTruthy();
  });

  it("알림 패널 머리의 읽지 않은 수 — 실패는 '— 읽지 못함'(KPI 띠와 같은 사유, 오류 글·다시 시도는 두지 않음) (QA-605)", async () => {
    reads = { ...happyReads(), [UNREAD]: new Error("요청 실패 (HTTP 500)") };
    renderHome(OWNER);
    await within(region(ALERTS_REGION)).findByText("[국면 전환] 후퇴 경계 → 확장");
    await waitFor(() => expect(unreadCount().textContent).toContain("읽지 못함"));
    expect(within(unreadCount()).queryByRole("status")).toBeNull();
    expect(within(region(ALERTS_REGION)).queryAllByRole("alert")).toHaveLength(0);
  });

  // QA-606: 최근 알림 제목은 한 줄 말줄임(truncate)에 title이 없어, 반 칸(390 312px · 1024 308px · 1280)에서 13F 알림의 기관 이름 뒷부분과 종목 수가
  // 가려지고 링크가 아닌 종류는 홈에서 전체 제목을 볼 길이 없었습니다(알림 전체 보기로 가야 함). QA-418(관심 대상 이름)과 같은 무늬로 고칩니다.
  // 수정 전(재현 커밋에서는 it.fails) 두 제목 모두 title이 null, 클래스는 truncate(line-clamp-2 없음)였습니다.
  it("최근 알림 제목은 두 줄까지(line-clamp-2·낱말 단위 줄바꿈)와 전체 제목 title — 링크가 아닌 13F 알림·관심 대상 링크 모두 (QA-606)", async () => {
    // 13F 알림 제목은 백엔드 AlertText.institutionNew의 꼴('[13F 신규 편입] {기관 이름} — N종목')에 실제 기관 이름을 넣은 것입니다.
    const institutionTitle = "[13F 신규 편입] 사우디 국부펀드 (Public Investment Fund - PIF) — 12종목";
    const watchTitle = "관심 대상 '합성 반도체 지주회사 (Synthetic Semiconductor Holdings Corporation)' 새 글 12건";
    const response = inbox();
    response.items = [
      { ...response.items[0], id: 21, kind: "INSTITUTION_NEW", title: institutionTitle },
      { ...response.items[1], id: 20, kind: "SEARCH_WATCH", title: watchTitle, payload: { href: "/search?e=us:SYNT&tab=timeline" } },
    ];
    reads = { ...happyReads(), [INBOX]: response };
    renderHome(OWNER);
    const plain = await within(region(ALERTS_REGION)).findByText(institutionTitle);
    const link = within(region(ALERTS_REGION)).getByRole("link", { name: watchTitle });
    expect(plain.tagName).toBe("SPAN");
    for (const [node, title] of [[plain, institutionTitle], [link, watchTitle]] as const) {
      const classes = node.className.split(/\s+/);
      expect(node.getAttribute("title"), title).toBe(title);
      expect(classes, title).toEqual(expect.arrayContaining(["line-clamp-2", "break-keep", "wrap-anywhere"]));
      expect(classes, title).not.toContain("truncate");
    }
    // 링크는 줄 전체가 누르는 자리(after:absolute inset-0 — 줄 li가 기준)이고 포커스 고리도 그대로입니다.
    expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0", "focus-visible:outline-2"]));
    expect(link.closest("li")?.className.split(/\s+/)).toContain("relative");
  });

  it("알림 — 지난 사건(late)은 읽지 않은 수에 들지 않아 강조(점·굵은 글씨) 없이 '지난 사건'", async () => {
    const response = inbox();
    response.items[0] = { ...response.items[0], late: true, read: false };
    reads = { ...happyReads(), [UNREAD]: { unread: 1 }, [INBOX]: response };
    renderHome(OWNER);
    const title = await screen.findByText("[국면 전환] 후퇴 경계 → 확장");
    const [late, , unread] = alertItems();
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
    await within(region(ALERTS_REGION)).findByText("[국면 전환] 후퇴 경계 → 확장");
    await storeLine();
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
    // 시장 — 값은 수집기 priceStr, 변화 칩(▲▼·− 부호·읽어 주는 방향)과 캡션, 출처 줄(출처·장 상태·시각 — 시장 표의 '기준' 칸과 같은 규칙, 읽어 주는 머리말 '출처:')
    const sp500 = kpi("S&P 500");
    expect(within(sp500).getByText("7,622.99")).toBeTruthy();
    expect(within(sp500).getByText("하락")).toBeTruthy();
    expect(within(sp500).getByText("−40.46")).toBeTruthy();
    // 변화의 기준(캡션) — 지표 상세 대상 머리와 같은 말
    expect(within(sp500).getByText("전일 대비").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3"]));
    const provenance = within(sp500).getByText(/^Yahoo Finance \(\^GSPC\) · .*2026-10-24 04:59$/);
    expect(within(provenance).getByText("출처:").className).toContain("sr-only");
    // 단위는 값의 마지막 글자와 한 묶음(QA-599)이라 글 마디가 나뉩니다 — 값 글 전체로 봅니다.
    expect(within(kpi("원/달러")).getByText("원").closest(".tabular-nums")?.textContent).toBe("1,322.28원");
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

  it("수집 오류 — 경고·누락이 있으면 주의 아이콘 + 글(경고·누락 수) · 색만으로 전하지 않음, 오류만 있으면 값뿐(위험 표지를 0 건수에 붙이지 않음)", async () => {
    for (const [response, tone, text] of [[issues(3, 19), "text-warn", "경고 19건 · 누락 0개"], [issues(0, 19), "text-warn", "경고 19건 · 누락 0개"]] as const) {
      reads = { ...happyReads(), [ISSUES]: response };
      const { unmount } = renderHome(OWNER);
      await storeLine();
      const tile = kpi("수집 오류");
      const status = within(tile).getByText(text).closest(`.${tone}`) as HTMLElement;
      expect(status, tone).not.toBeNull();
      expect(Array.from(status.querySelectorAll("svg")).map((icon) => icon.getAttribute("aria-hidden"))).toEqual(["true"]);
      // 아이콘 옆 읽어 주는 머리말(주의)도 있습니다.
      expect(status.querySelector(".sr-only")?.textContent?.trim()).toBe("주의:");
      unmount();
    }
    reads = { ...happyReads(), [ISSUES]: issues(1, 0) };
    renderHome(OWNER);
    await storeLine();
    expect(kpi("수집 오류").textContent).toBe("수집 오류1건");
    expect(kpi("수집 오류").querySelector("svg")).toBeNull();
    expect(kpi("수집 오류").querySelector(".text-danger")).toBeNull();
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
      // 패널은 화면 차례(국면 → 알림·끊긴 출처 → 계좌 → 시장 — 결정 5)
      "오늘의 국면을 불러오는 중",
      // 알림 패널 머리의 읽지 않은 수(QA-605 — KPI 타일과 같은 규칙)
      "읽지 않은 수 불러오는 중",
      "알림을 불러오는 중",
      "끊긴 출처를 불러오는 중",
      "수집 상태를 불러오는 중",
      "모의매매 계좌를 불러오는 중",
      "시장 시세를 불러오는 중",
    ]);
    // 계좌 구역은 불러오는 중에도 읽은 뒤와 같은 이름입니다.
    expect(within(region(PAPER_REGION)).getByRole("status").getAttribute("aria-label")).toBe("모의매매 계좌를 불러오는 중");
    // 읽지 않은 수를 읽는 중이면 자리표시 — '—'(값 없음, 실패와 같은 표시)도 0건도 적지 않습니다(QA-605).
    expect(within(unreadCount()).getByRole("status", { name: "읽지 않은 수 불러오는 중" })).toBeTruthy();
    expect(within(unreadCount()).queryByText("값 없음")).toBeNull();
    expect(screen.queryByText("0건")).toBeNull();
  });

  // QA-598: 자리표시가 읽은 뒤보다 훨씬 낮아(KPI 타일 64→208px, 국면 패널 189→582px, 계좌 181→509~680px, 시장 309→414px) 값이 오는 동안
  // 화면이 아래로 밀렸습니다(QA 스택 /api/* 1.5초 지연 CLS 390 0.63·1024 0.37·1440 0.24 — QA-283의 홈 몫 + P4 새 KPI 띠).
  // 수정 전(재현 커밋에서는 it.fails) 타일 막대는 모두 1개, 세 패널 자리표시는 높이 없는 줄(lines 5·5·6)이었습니다.
  it("읽는 중 자리는 읽은 뒤 높이에 가깝다 — 시장 KPI 타일은 자리 줄 막대, 국면·계좌·시장 패널 자리표시는 높이를 가진 블록 (QA-598)", () => {
    renderHome(OWNER);
    const strip = region("오늘 요약");
    const bars = (label: string) => within(strip).getByRole("status", { name: `${label} 불러오는 중` }).closest("li")?.querySelectorAll(".bg-control-fill").length;
    // 수집 오류 타일은 상태 글 한 줄 자리(두 칸·세 칸에서 마지막 줄에 혼자 남음 — lib/home KPI_ERRORS_PENDING_LINES).
    expect(["국면", "S&P 500", "코스피", "원/달러", "미국채 10년물", "읽지 않은 알림", "수집 오류"].map(bars)).toEqual([1, 6, 6, 6, 6, 1, 2]);
    const blockHeight = (name: string) => {
      const block = within(region(name)).getByRole("status").querySelector<HTMLElement>("[style]");
      return block ? Number.parseFloat(block.style.height) : null;
    };
    // 자리표시 블록 + 87px(패널 머리·안쪽 여백) = 읽는 중 패널 높이. 블록 높이는 결정 5 배치(아래 시험)에서 다음 패널이 첫 화면에 드는 xl 이상의 읽은 뒤
    // 높이에 맞춥니다 — 범위와 잰 값은 아래 '결정 5 배치의 읽은 뒤 높이' 시험.
    const regime = blockHeight("오늘의 국면");
    const paper = blockHeight(PAPER_REGION);
    const market = blockHeight("시장");
    expect(regime !== null && regime >= 370 && regime <= 420, `국면 ${regime}`).toBe(true);
    expect(paper !== null && paper >= 290 && paper <= 345, `계좌 ${paper}`).toBe(true);
    expect(market !== null && market >= 190 && market <= 215, `시장 ${market}`).toBe(true);
  });

  // 2026-11-16 결정 5(운영자 배치 [국면][알림·끊긴 출처] / [계좌 두 칸] / [시장 두 칸]) 뒤 읽은 뒤 패널 높이(루프백 빌드 — QA API 응답, 합성 응답은
  // 알림 세 건 + 끊긴 출처 둘 · 미국 다섯 계좌): 첫 줄 1280 478 · 1440·1920 461px(QA) / 504px(합성 — 알림이 높은 쪽), 계좌 1280·1440 381(네 계좌) /
  // 429px(다섯 계좌), 시장 1280 301 · 1440·1920 281px. 예전 자리표시(국면 490 · 계좌 430 · 시장 359 — 반 폭 2×2에 맞춘 값)로는 1440에서 첫 줄이
  // 116px 높아 그 아래 계좌 패널이 첫 화면 끝(781 → 897px)에 밀려 있다가 값이 오면 올라왔습니다. 1024(첫 줄 584px)·390은 그 아래가 첫 화면 밖이라 xl 이상에 맞춥니다.
  // 바꾸기 전(국면 490 · 계좌 430 · 시장 359)에는 실패합니다.
  it("결정 5 배치의 읽은 뒤 높이에 맞춘 자리표시 — 첫 줄 패널 461~504px · 계좌 381~429px · 시장 281~301px 안 (블록 + 87px)", () => {
    renderHome(OWNER);
    const panelAt = (name: string) => {
      const block = within(region(name)).getByRole("status").querySelector<HTMLElement>("[style]");
      return block ? Number.parseFloat(block.style.height) + 87 : null;
    };
    const within2 = (value: number | null, low: number, high: number) => value !== null && value >= low && value <= high;
    expect(within2(panelAt("오늘의 국면"), 461, 504), `국면 ${panelAt("오늘의 국면")}`).toBe(true);
    expect(within2(panelAt(PAPER_REGION), 381, 429), `계좌 ${panelAt(PAPER_REGION)}`).toBe(true);
    expect(within2(panelAt("시장"), 281, 301), `시장 ${panelAt("시장")}`).toBe(true);
  });

  it("국면·모의매매 구역은 불러오는 중에도 읽은 뒤와 같은 틀 — 값이 와도 틀 여백이 바뀌지 않는다", async () => {
    // 예전에는 불러오는 중·오류를 다른 틀(다른 안쪽 여백)로 그려, 값이 오는 순간 제목·본문이 lg에서 16px 튀었습니다(검토 지적).
    renderHome(OWNER);
    const loading = [region("오늘의 국면").className, region(PAPER_REGION).className];
    cleanup();
    reads = happyReads();
    renderHome(OWNER);
    await paperPanel();
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
    expect(paper).toBe(region(PAPER_REGION));
    // 장부를 읽을 수 없으면 표·계좌 링크·개수 없이 서버 안내만 — 순자산을 짓지 않습니다.
    expect(within(paper).queryByRole("table")).toBeNull();
    expect(within(paper).queryByRole("link")).toBeNull();
    expect(within(paper).queryByText(/\d개$/)).toBeNull();
    expect(within(paper).queryByText(/정기 작업 꺼짐/)).toBeNull();

    expect(within(region("시장")).getByText("매크로 저장본이 아직 없습니다 — 수집 전")).toBeTruthy();
    expect(await within(region(ALERTS_REGION)).findByText("새 알림이 없습니다")).toBeTruthy();
    expect(within(unreadCount()).getByRole("status", { name: "읽지 않은 수 불러오는 중" })).toBeTruthy();   // 읽지 않은 수 응답 전(QA-605)
    const line = await storeLine();
    expect(line.textContent).toContain("수집 태스크 오류 —값 없음 · 경고 —값 없음 · 누락 데이터셋 —값 없음");
    expect(within(line).getAllByText("값 없음")).toHaveLength(3);
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });

  it("저장소 상태 — 수집기에 닿지 못하면 '연결 안 됨 — DB 기록만'(주의 아이콘 + 주의색), 누락 데이터셋은 모름 · 누락이 있으면 그 수", async () => {
    const down = { ...issues(0, 0), collectorReachable: false };
    down.counts = { ...down.counts, missingDatasets: null };
    reads = { ...happyReads(), [ISSUES]: down };
    const { unmount } = renderHome(OWNER);
    let line = await storeLine();
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
    line = await storeLine();
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
      const line = await storeLine();
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
      const line = await storeLine();
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
      const line = await storeLine();
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
    expect(await paperPanel()).toBeTruthy();
    expect(screen.getByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
    expect(storeCounts(await storeLine()).textContent).toBe("수집 태스크 오류 0건 · 경고 0건 · 누락 데이터셋 0개");

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
    const paper = await paperPanel();
    expect(await within(paper).findByText("정기 작업 상태를 확인하지 못했습니다 — 요청 실패 (HTTP 503)")).toBeTruthy();
    expect(within(paper).queryByText(/정기 작업 꺼짐/)).toBeNull();
    // 처음 현금은 상태 응답 대신 계좌들의 같은 값으로 적습니다.
    expect(within(paper).getByText("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비")).toBeTruthy();
  });

  it("장부 개요가 실패하면 모의매매 구역은 제목·시장 고르기와 오류, 수집 상태·끊긴 출처가 실패하면 그 칸만 오류(알림은 그대로)", async () => {
    reads = {
      ...happyReads(),
      [PAPER_OVERVIEW]: new Error("요청 실패 (HTTP 500)"),
      [ISSUES]: new Error("요청 실패 (HTTP 502)"),
      [INFO_SOURCES]: new Error("요청 실패 (HTTP 504)"),
    };
    renderHome(OWNER);

    expect(await within(region(PAPER_REGION)).findByText("요청 실패 (HTTP 500)")).toBeTruthy();
    const alerts = region(ALERTS_REGION);
    expect(await within(alerts).findByText("요청 실패 (HTTP 502)")).toBeTruthy();
    expect(await within(alerts).findByText("요청 실패 (HTTP 504)")).toBeTruthy();
    expect(within(region(PAPER_REGION)).getByRole("alert")).toBeTruthy();
    // 미국을 못 읽어도 한국으로 갈 수 있게 고르기는 남습니다(QA-608) — 표·계좌 링크·개수는 없습니다.
    expect(within(region(PAPER_REGION)).getByRole("radiogroup", { name: "모의매매 시장" })).toBeTruthy();
    expect(within(region(PAPER_REGION)).queryByRole("table")).toBeNull();
    expect(within(region(PAPER_REGION)).queryByText(/\d개$/)).toBeNull();
    expect(within(alerts).getAllByRole("alert").map((node) => node.textContent)).toEqual([
      expect.stringContaining("요청 실패 (HTTP 504)"),
      expect.stringContaining("요청 실패 (HTTP 502)"),
    ]);
    expect(within(alerts).getAllByRole("button", { name: "다시 시도" })).toHaveLength(2);
    expect(screen.queryByText(/수집 태스크 오류/)).toBeNull();
    expect(await within(alerts).findByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
    expect(inRegime().getByText("확장 (Expansion)")).toBeTruthy();

    reads[INFO_SOURCES] = infoSources();
    fireEvent.click(within(alerts).getAllByRole("button", { name: "다시 시도" })[0]);
    expect(await within(alerts).findByText("끊긴 출처가 없습니다")).toBeTruthy();
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

    await within(region("시장")).findByRole("link", { name: "원/달러 (USD/KRW)" });
    expect(within(marketRow("원/달러 (USD/KRW)")).queryByText("추정")).toBeNull();
    showGroup("아시아 주요 주가지수");
    expect(within(marketRow("코스피200 야간선물")).getByText("추정")).toBeTruthy();
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

    await within(region("시장")).findByRole("link", { name: "원/달러 (USD/KRW)" });
    const usdkrw = marketRow("원/달러 (USD/KRW)");
    expect(within(usdkrw).getByText("이전 값")).toBeTruthy();
    expect(within(usdkrw).getByText("· Yahoo 429 — 직전 저장본 값")).toBeTruthy();
    expect(within(usdkrw).getByText("Yahoo Finance (KRW=X) · 개장 · 2026-10-26 16:51")).toBeTruthy();
    expect(within(usdkrw).getByText("1,322.28")).toBeTruthy();   // 값은 그대로 두고 배지로 알립니다

    const paper = await paperPanel();
    const claude = bookRow(paper, "Claude 계좌");
    expect(within(claude).getByText("이전 값")).toBeTruthy();
    expect(within(claude).getByText("· 가격 없음 2종목 — 지난 값으로 평가")).toBeTruthy();
    // 값은 그대로 두고 배지로 알립니다(같은 사유가 표에 한 번).
    expect(within(claude).getByText("99,967.28")).toBeTruthy();
    expect(within(paper).getAllByText("· 가격 없음 2종목 — 지난 값으로 평가")).toHaveLength(1);
    expect(within(bookRow(paper, "규칙 계좌")).queryByText("이전 값")).toBeNull();
  });

  it("지금 값(current) — Claude 줄은 개요와 같은 지금 값·단계 표기·추정 배지, 최근 변화는 서버 값과 그 기준", async () => {
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

    // Claude 줄 — 지금 값(순자산·출발 대비), 최근 변화(서버 dayChangePct — '오늘'과 그 기준), 기준(단계 표기) + 추정 배지.
    const panel = region(PAPER_REGION);
    const claude = bookRow(panel, "Claude 계좌");
    expect(cellTexts(claude)).toEqual([
      "Claude 계좌Claude · 운용 중", "100,123.45달러", "▲+0.12%", "오늘▲+0.30%10-23 잠정 대비", "장중 추정 23:58추정",
    ]);
    expect(within(claude).getAllByText("상승")).toHaveLength(2);
    // 기준 글은 추정 배지보다 앞(눈에도 낭독에도 '추정 장중 추정'으로 겹치지 않게).
    const stage = within(claude).getByText("장중 추정 23:58");
    const badge = within(claude).getByText("추정");
    expect(Boolean(stage.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // 장중 추정인 줄이 있으면 출처에 장중 시세로 다시 평가했다는 말을 붙입니다.
    expect(within(panel).getByText(/보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정/)).toBeTruthy();
    // current가 없는 다른 계좌는 장부 값 그대로, 최근 변화는 모름('—')
    expect(cellTexts(bookRow(panel, "규칙 계좌")).slice(1, 4)).toEqual(["99,951.00달러", "▼−0.05%", "—"]);
  });

  it("장부 관측치 저장본이 늦으면(백엔드 quotes.stale) 네 계좌 모두 '이전 값'(모의매매 개요와 같은 사유)", async () => {
    const ledger = paperOverview();
    ledger.quotes!.stale = true;
    reads = { ...happyReads(), [PAPER_OVERVIEW]: ledger };
    renderHome(OWNER);

    const paper = await paperPanel();
    // 네 줄 모두 이전 값 — 마지막 관측 시각은 기준 칸이 이미 적어 사유에서 뺍니다(같은 시각을 한 줄에 두 번 적지 않음).
    expect(within(paper).getAllByText("· 관측치 저장본이 늦음")).toHaveLength(4);
    expect(within(paper).getAllByText("마지막 관측 2026-10-26 04:56")).toHaveLength(4);
    expect(within(paper).queryByText(/관측치 저장본이 늦음 · 마지막 관측/)).toBeNull();
  });
});

describe("홈 — 모의매매 한국 탭", () => {
  /** 미국 계좌 표가 그려진 뒤 한국을 고릅니다. */
  async function pickKorea() {
    const panel = await paperPanel();
    fireEvent.click(within(panel).getByRole("radio", { name: "한국" }));
  }

  it("불러오는 중: 한국을 고르면 그때 ?market=KR을 읽고 자리표시 — 탭은 남아 미국으로 돌아갈 수 있다", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await pickKorea();
    expect(await screen.findByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(requested()).toEqual(expect.arrayContaining([PAPER_KR_OVERVIEW, PAPER_KR_STATUS]));
    const card = region(PAPER_REGION);
    fireEvent.click(within(card).getByRole("radio", { name: "미국" }));
    expect(await paperPanel("Claude 계좌")).toBeTruthy();
  });

  // 예전에는 한국을 고르면 읽는 중 카드(값을 그린 틀과 다른 틀)에 라디오가 다시 그려져 초점이 body로 빠지고, 미국을 갔다 오면 한국 값을
  // 지워 다시 자리표시였습니다.
  it("키보드로 시장을 고르면 초점이 그 라디오에 남는다 — 읽는 중·읽은 뒤 모두, 미국 → 한국을 다시 골라도 자리표시 없이", async () => {
    let resolveKr: (body: unknown) => void = () => {};
    const krOverview = new Promise((resolve) => { resolveKr = resolve; });
    reads = { ...happyReads(), [PAPER_KR_STATUS]: paperStatusKr(false) };
    const base = api.apiGetShared.getMockImplementation();
    api.apiGetShared.mockImplementation((path: string) => (path === PAPER_KR_OVERVIEW ? krOverview : base?.(path)));
    renderHome(OWNER);
    const panel = await paperPanel();
    const korea = within(panel).getByRole("radio", { name: "한국" }) as HTMLInputElement;
    korea.focus();
    fireEvent.click(korea);
    expect(await screen.findByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(korea.checked).toBe(true);
    expect(document.activeElement).toBe(korea);

    await act(async () => resolveKr(paperOverviewKr()));
    await paperPanel("한국 Claude 계좌");
    expect(document.activeElement).toBe(korea);

    const us = within(region(PAPER_REGION)).getByRole("radio", { name: "미국" }) as HTMLInputElement;
    us.focus();
    fireEvent.click(us);
    await paperPanel("Claude 계좌");
    expect(document.activeElement).toBe(us);
    korea.focus();
    fireEvent.click(korea);
    // 한 번 읽은 한국 값은 남아 있어 자리표시 없이 바로 그립니다.
    expect(screen.queryByRole("status", { name: "한국 모의매매 계좌를 불러오는 중" })).toBeNull();
    expect(within(region(PAPER_REGION)).getByRole("link", { name: "한국 Claude 계좌" })).toBeTruthy();
    expect(document.activeElement).toBe(korea);
  });

  it("쉬는 한국: 계좌 없이 그 사유, 두 책 비교하지 않음 문구", async () => {
    const reason = "한국 계좌 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다";
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: paperOverviewKrDormant(reason), [PAPER_KR_STATUS]: { ...paperStatusKr(false), dormantReason: reason } };
    renderHome(OWNER);
    await pickKorea();
    expect(await screen.findByText(`한국 계좌가 쉬고 있습니다 — ${reason}`)).toBeTruthy();
    const panel = region(PAPER_REGION);
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel).queryByRole("table")).toBeNull();
    expect(within(panel).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    expect((within(panel).getByRole("radio", { name: "한국" }) as HTMLInputElement).checked).toBe(true);
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

  // QA-608: 미국 개요를 처음 읽다 실패하면 머리에 미국|한국 고르기가 없어(switchShown = korea || 미국 값 있음) 홈 패널에서 한국 계좌로 갈 수
  // 없었습니다. 고치는 조건은 오류(error)가 아니라 실패 시각(failedAt) — useApi는 다시 읽기를 시작할 때 error를 비우므로 error로 정하면 다시 시도·
  // 60초 자동 갱신 때마다 고르기가 사라졌다 다시 마운트되어 키보드 초점을 잃습니다(failedAt은 다시 읽는 동안에도 남음).
  // 수정 전(재현 커밋에서는 it.fails) 미국 개요 실패 때 모의매매 구역에 radiogroup이 없었습니다(글: '모의매매 계좌 요청 실패 (HTTP 500) 다시 시도').
  it("미국 개요를 처음 읽다 실패해도 고르기가 남아 한국으로 갈 수 있고, 미국으로 돌아오면 오류와 고르기 (QA-608)", async () => {
    reads = { ...happyReads(), [PAPER_OVERVIEW]: new Error("요청 실패 (HTTP 500)"), [PAPER_KR_OVERVIEW]: paperOverviewKr(), [PAPER_KR_STATUS]: paperStatusKr(false) };
    renderHome(OWNER);
    const panel = region(PAPER_REGION);
    expect(within(await within(panel).findByRole("alert")).getByText("요청 실패 (HTTP 500)")).toBeTruthy();
    const switcher = within(panel).getByRole("radiogroup", { name: "모의매매 시장" });
    expect((within(switcher).getByRole("radio", { name: "미국" }) as HTMLInputElement).checked).toBe(true);
    expect(requested()).not.toContain(PAPER_KR_OVERVIEW);

    fireEvent.click(within(switcher).getByRole("radio", { name: "한국" }));
    expect(await paperPanel("한국 Claude 계좌")).toBe(panel);
    expect(requested()).toEqual(expect.arrayContaining([PAPER_KR_OVERVIEW, PAPER_KR_STATUS]));
    expect(within(panel).queryByRole("alert")).toBeNull();

    fireEvent.click(within(panel).getByRole("radio", { name: "미국" }));
    expect(within(within(panel).getByRole("alert")).getByText("요청 실패 (HTTP 500)")).toBeTruthy();
    expect(within(panel).getByRole("radiogroup", { name: "모의매매 시장" })).toBe(switcher);
    expect((within(switcher).getByRole("radio", { name: "미국" }) as HTMLInputElement).checked).toBe(true);
  });

  it("미국 개요 실패 뒤 다시 읽는 동안에도 고르기는 같은 노드로 남아 초점을 잃지 않는다 — 처음 읽는 동안만 고르기가 없다 (QA-608)", async () => {
    reads = happyReads();
    let rejectFirst: (error: Error) => void = () => {};
    let resolveRetry: (body: unknown) => void = () => {};
    const first = new Promise((_, reject) => { rejectFirst = reject; });
    const retry = new Promise((resolve) => { resolveRetry = resolve; });
    let overviewCalls = 0;
    const base = api.apiGetShared.getMockImplementation();
    api.apiGetShared.mockImplementation((path: string) => {
      if (path !== PAPER_OVERVIEW) return base?.(path);
      overviewCalls += 1;
      return overviewCalls === 1 ? first : retry;
    });
    renderHome(OWNER);
    const panel = region(PAPER_REGION);
    // 처음 읽는 동안은 고를 것이 없어 고르기를 두지 않습니다(그대로).
    expect(within(panel).getByRole("status", { name: "모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(within(panel).queryByRole("radiogroup")).toBeNull();

    await act(async () => rejectFirst(new Error("요청 실패 (HTTP 500)")));
    const switcher = within(panel).getByRole("radiogroup", { name: "모의매매 시장" });
    const us = within(switcher).getByRole("radio", { name: "미국" }) as HTMLInputElement;
    us.focus();
    fireEvent.click(within(panel).getByRole("button", { name: "다시 시도" }));
    // 다시 읽는 동안(error는 비었고 값은 아직 없음) — 자리표시와 고르기가 함께, 고르기는 다시 마운트되지 않습니다.
    expect(await within(panel).findByRole("status", { name: "모의매매 계좌를 불러오는 중" })).toBeTruthy();
    expect(overviewCalls).toBe(2);
    expect(within(panel).getByRole("radiogroup", { name: "모의매매 시장" })).toBe(switcher);
    expect(document.activeElement).toBe(us);

    await act(async () => resolveRetry(paperOverview()));
    expect(await paperPanel("Claude 계좌")).toBe(panel);
    expect(within(panel).getByRole("radiogroup", { name: "모의매매 시장" })).toBe(switcher);
    expect(document.activeElement).toBe(us);
  });

  it("자료: 한국 네 계좌(원 정수, 링크 /paper/kr)·출발 대비·출발 줄(원)·비교하지 않음 문구·한국 출처", async () => {
    reads = { ...happyReads(), [PAPER_KR_OVERVIEW]: paperOverviewKr(), [PAPER_KR_STATUS]: paperStatusKr(false) };
    renderHome(OWNER);
    await pickKorea();
    const panel = await paperPanel("한국 Claude 계좌");
    const table = within(panel).getByRole("table");
    const rows = within(table).getAllByRole("link");
    expect(rows.map((row) => [row.textContent, row.getAttribute("href")])).toEqual([
      ["한국 규칙 계좌", PAPER_KR_HREF], ["한국 Claude 계좌", PAPER_KR_HREF], ["KODEX 200 계좌", PAPER_KR_HREF], ["한국 60/40 계좌", PAPER_KR_HREF],
    ]);
    expect(PAPER_KR_HREF).toBe("/paper/kr");
    // 순자산은 원 단위 정수(소수 없음), 기준은 그 계좌의 마지막 관측
    expect(cellTexts(bookRow(panel, "한국 Claude 계좌")).slice(1, 3)).toEqual(["100,312,450원", "▲+0.31%"]);
    expect(cellTexts(bookRow(panel, "KODEX 200 계좌"))[1]).toBe("100,528,900원");
    expect(cellTexts(bookRow(panel, "한국 Claude 계좌"))[4]).toBe("마지막 관측 2026-11-03 21:57");
    expect(within(panel).getByText("출발 2026-10-29 · 처음 현금 100,000,000원 · 변화율은 출발 대비")).toBeTruthy();
    expect(within(panel).getByText(PAPER_COMPARE_NOTE)).toBeTruthy();
    expect(within(panel).getByText(PAPER_SOURCES.krLedger)).toBeTruthy();
    // 사후 체결 대기 경고는 한국에 없습니다(네 계좌가 S+1 시가에 함께 출발).
    expect(within(panel).queryByText(/출발일 종가 대기/)).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("홈 — 배치(KPI 띠 + 패널 — 결정 5)", () => {
  /** 화면의 이름 있는 구역(KPI 띠·패널) — 표의 가로 스크롤 상자(… (좌우 스크롤))는 뺍니다. */
  const sections = () =>
    screen.getAllByRole("region").map((node) => node.getAttribute("aria-label") ?? node.querySelector("h2")?.textContent).filter((name) => !name?.endsWith("(좌우 스크롤)"));

  // 2026-11-16 결정 5: 예전 운영자 배치(2×2 — [국면][계좌] / [시장][알림·끊긴 출처])는 두 표(최소 640px)가 반 폭(1024 328 · 1440 536 · 1920 566px)에서
  // 74~312px 넘쳐 '기준' 칸 배지가 가려졌습니다. 표 둘을 두 칸 폭 줄로 내려 1024~1920 넘침 0(루프백 빌드 측정). DOM 차례 = 화면 차례(읽기·Tab).
  // 바꾸기 전에는 차례가 [국면, 계좌, 시장, 알림]이고 두 칸 패널이 없어 실패합니다.
  it("운영자 — KPI 띠, [국면][알림·끊긴 출처] / [계좌 손익 표 — 두 칸] / [시장 — 두 칸], lg 두 칸·그 아래 한 칸(같은 차례)", async () => {
    reads = happyReads();
    renderHome(OWNER);
    await paperPanel();
    expect(sections()).toEqual(["오늘 요약", "오늘의 국면", "알림·끊긴 출처", "모의매매 계좌", "시장"]);
    const grid = region("오늘의 국면").parentElement as HTMLElement;
    expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid", "min-w-0", "gap-3", "lg:grid-cols-2", "lg:gap-4"]));
    expect(Array.from(grid.children).map((child) => child.className.split(/\s+/).includes("lg:col-span-2"))).toEqual([false, false, true, true]);
    // 제목 구조는 그대로 — 패널마다 h2(영역 이름).
    expect(Array.from(grid.children).map((child) => child.querySelector("h2")?.textContent)).toEqual(["오늘의 국면", "알림·끊긴 출처", "모의매매 계좌", "시장"]);
  });

  it("운영자 — 읽는 중·오류에도 계좌 패널은 두 칸 폭(틀이 바뀌지 않음)", async () => {
    renderHome(OWNER);
    expect(region(PAPER_REGION).className.split(/\s+/)).toContain("lg:col-span-2");
    cleanup();
    reads = { ...happyReads(), [PAPER_OVERVIEW]: new Error("요청 실패 (HTTP 500)") };
    renderHome(OWNER);
    await within(region(PAPER_REGION)).findByText("요청 실패 (HTTP 500)");
    expect(region(PAPER_REGION).className.split(/\s+/)).toContain("lg:col-span-2");
  });

  // 2026-11-16 결정 1(가): 묶음 탭 다섯(617px)이 좁은 화면(390 — 줄 332px)에서 들어가지 않아 넷째·다섯째가 가려졌습니다. 홈 시장 탭 줄만 두 줄을 허용합니다.
  // 바꾸기 전에는 줄이 한 줄 + 가로 스크롤(overflow-x-auto)이라 실패합니다.
  it("시장 묶음 탭 줄은 두 줄 허용(flex-wrap — 가로 스크롤 상자 아님) — 탭마다 제 줄 바닥선, 고른 탭은 2px 강조 파랑", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const list = await within(region("시장")).findByRole("tablist", { name: "시장 묶음" });
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    expect(list.className.split(/\s+/)).not.toContain("overflow-x-auto");
    const tabs = within(list).getAllByRole("tab");
    const selected = tabs.find((node) => node.getAttribute("aria-selected") === "true") as HTMLElement;
    expect(selected.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-b-2", "border-accent"]));
    for (const node of tabs.filter((node) => node !== selected)) {
      expect(node.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-b", "border-border"]));
    }
  });

  it("회원 — [국면][알림] / [시장 — 두 칸을 다 씀], 운영자 전용 구역은 없다", async () => {
    reads = happyReads();
    renderHome(MEMBER);
    await within(region("시장")).findByRole("link", { name: "원/달러 (USD/KRW)" });
    expect(sections()).toEqual(["오늘 요약", "오늘의 국면", "알림", "시장"]);
    const grid = region("오늘의 국면").parentElement as HTMLElement;
    expect(Array.from(grid.children).map((child) => child.className.split(/\s+/).includes("lg:col-span-2"))).toEqual([false, false, true]);
  });

  it("KPI 띠와 패널 안 누르는 자리는 좁은 화면에서 44px(타일 링크·링크·탭·고르기·다시 시도)", async () => {
    reads = { ...happyReads(), [INFO_SOURCES]: new Error("요청 실패 (HTTP 504)") };
    renderHome(OWNER);
    await paperPanel();
    await storeLine();
    await within(region(ALERTS_REGION)).findByText("요청 실패 (HTTP 504)");
    // KPI 띠의 타일 링크는 높이를 내용(이름 18 + 값 28 + 위아래 20 = 66px 이상)이 정하고, 클래스로도 44px 하한(min-h-11)을 둡니다.
    for (const name of ["오늘 요약", "오늘의 국면", PAPER_REGION, "시장", ALERTS_REGION]) {
      expect(smallTargets(region(name)), name).toEqual([]);
    }
  });
});

describe("홈 — 등락 표시(▲▼ 12px · 읽어 주는 방향)", () => {
  it("화면의 ▲·▼는 모두 12px(text-xs)이고 em 크기가 없으며, 등락 자리마다 읽어 주는 '상승'·'하락'이 있다", async () => {
    const ledger = paperOverview();
    ledger.books![1].returnPct = 0.12;
    reads = { ...happyReads(), [PAPER_OVERVIEW]: ledger };
    const { container } = renderHome(OWNER);
    await paperPanel();
    await within(region("시장")).findByRole("link", { name: "원/달러 (USD/KRW)" });
    // 상승도 보이게 미국 주가지수 묶음(선물 +14.25)을 엽니다.
    showGroup("미국 주가지수 및 선물");
    const arrows = Array.from(container.querySelectorAll("span")).filter((node) => node.textContent === "▲" || node.textContent === "▼");
    expect(arrows.filter((node) => node.textContent === "▲").length).toBeGreaterThan(0);
    expect(arrows.filter((node) => node.textContent === "▼").length).toBeGreaterThan(0);
    for (const arrow of arrows) {
      expect(arrow.getAttribute("aria-hidden"), "화살표는 읽어 주기에서 뺌").toBe("true");
      expect(arrow.className.split(" "), "12px").toContain("text-xs");
      expect(arrow.className, "부모 크기에 기대는 em 크기 없음").not.toMatch(/text-\[[\d.]+em\]/);
      const spoken = arrow.parentElement?.querySelector(":scope > .sr-only")?.textContent;
      expect(spoken, "읽어 주는 방향").toBe(arrow.textContent === "▲" ? "상승" : "하락");
    }
    // 음수 부호는 −(U+2212) — ASCII 하이픈으로 찍은 등락이 없습니다.
    for (const arrow of arrows.filter((node) => node.textContent === "▼")) {
      expect(arrow.parentElement?.textContent).not.toMatch(/-\d/);
      expect(arrow.parentElement?.textContent).toMatch(/−\d/);
    }
  });
});

/** 칸 안의 변화 칩(바깥 상자) — 읽어 주는 방향 글에서 올라가 tabular-nums 상자를 찾습니다(칸 td는 span이 아니라 걸리지 않음). */
const chipIn = (cell: HTMLElement, direction: "상승" | "하락") => within(cell).getByText(direction).closest("span.tabular-nums") as HTMLElement;

// QA-595: 표 자동 배치가 칩 칸에 최소 내용 폭(숫자 하나)만 주면 flex-wrap 칩이 꺾여, 계좌 표의 '▼'가 숫자와 다른 줄에 홀로 남고
// 시장 표의 변화량과 변화율이 두 줄로 갈렸습니다(QA 스택 390~1920 모든 폭, 표가 넘치지 않는 768에서도).
// 수정 전(재현 커밋에서는 it.fails) 세 칩 모두 'inline-flex flex-wrap …'이었습니다.
describe("홈 — 표 칸 안의 변화 칩 (QA-595)", () => {
  it("계좌 손익 표의 출발 대비·최근 변화와 시장 표의 변화 칩은 칸 안에서 꺾이지 않는다(flex-nowrap)", async () => {
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
    await act(async () => {});

    // 계좌 표 — 칸 순서: 계좌·순자산·출발 대비·최근 변화·기준
    const cells = Array.from(bookRow(region(PAPER_REGION), "Claude 계좌").children) as HTMLElement[];
    // 시장 표 — 칸 순서: 지표·값·변화·기준(원/달러 ▼ −1.38 (−0.10%))
    const marketCells = Array.from(marketRow("원/달러 (USD/KRW)").children) as HTMLElement[];
    for (const [name, chip] of [
      ["출발 대비", chipIn(cells[2], "상승")],
      ["최근 변화", chipIn(cells[3], "상승")],
      ["시장 변화", chipIn(marketCells[2], "하락")],
    ] as const) {
      expect(chip.className.split(/\s+/), name).toContain("flex-nowrap");
      expect(chip.className.split(/\s+/), name).not.toContain("flex-wrap");
    }
  });
});

// 국면 패널 본문·고지와 계좌 패널 각주 문장이 좁은 칸에서 '판단의 근거|가 아닙'·'출발 대|비'·'집행·통화|가 달라'처럼 낱말 안에서 꺾였습니다
// (QA 스택 1024~1920 — 개편 전부터, 공용 키트 고침과 같은 규칙). jsdom은 줄을 재지 않아 클래스로 봅니다.
describe("홈 — 문장 글의 낱말 단위 줄바꿈", () => {
  it("국면 패널 문장·기준일·고지와 계좌 패널 출발 줄·비교하지 않음 문구는 break-keep(+ 긴 낱말은 wrap-break-word)", async () => {
    reads = happyReads();
    renderHome(OWNER);
    const panel = await paperPanel();
    const hero = region("오늘의 국면");
    const texts = [
      within(hero).getByText(/위험자산에 우호적인 조합입니다/),
      within(hero).getByText(/네 입력 계열의 마지막 날짜 중 가장 이른 날/),
      within(hero).getByText("임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다."),
      within(panel).getByText("출발 2026-10-23 · 처음 현금 100,000 달러 · 변화율은 출발 대비"),
      within(panel).getByText(PAPER_COMPARE_NOTE),
    ];
    for (const node of texts) {
      expect(node.className.split(/\s+/), node.textContent ?? "").toEqual(expect.arrayContaining(["break-keep", "wrap-break-word"]));
    }
  });
});

describe("홈 — 운영자가 아닌 사용자", () => {
  for (const [name, user] of [["회원", MEMBER], ["데모 열람", DEMO], ["사용자 모름(레이아웃 밖)", undefined]] as const) {
    it(`${name}: 모의매매·저장소 상태·끊긴 출처를 요청하지 않고 그 구역이 없다 — 국면·시장·알림은 그린다`, async () => {
      reads = happyReads();
      renderHome(user);

      expect(await inRegime().findByText("확장 (Expansion)")).toBeTruthy();
      expect(await screen.findByText("원/달러 (USD/KRW)")).toBeTruthy();
      expect(await screen.findByText("[국면 전환] 후퇴 경계 → 확장")).toBeTruthy();
      expect(requested().some((path) => path.startsWith("/api/paper") || path.startsWith("/api/status") || path.startsWith("/api/info"))).toBe(false);
      expect(requested().sort()).toEqual([INBOX, KR_HOLIDAYS, MACRO, REGIME, UNREAD].sort());
      expect(screen.queryByRole("heading", { name: /모의매매/ })).toBeNull();
      // 알림 패널은 알림만(제목도 '알림') — 끊긴 출처·수집 상태 칸이 없습니다.
      const alerts = region("알림");
      expect(within(alerts).queryAllByRole("heading", { level: 3 })).toHaveLength(0);
      expect(within(alerts).getAllByRole("listitem")).toHaveLength(3);
      expect(screen.queryByRole("region", { name: ALERTS_REGION })).toBeNull();
      expect(screen.queryByText("끊긴 출처")).toBeNull();
      expect(screen.queryByText(/수집 태스크 오류/)).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "모의매매 시장" })).toBeNull();
      // KPI 띠에도 수집 오류(운영자) 타일이 없습니다.
      expect(within(region("오늘 요약")).getAllByRole("link").map((link) => link.getAttribute("href")))
        .toEqual(["/regime", "/markets/i/sp500", "/markets/i/kospi", "/markets/i/usdkrw", "/markets/i/us10y", "/alerts"]);
    });
  }
});
