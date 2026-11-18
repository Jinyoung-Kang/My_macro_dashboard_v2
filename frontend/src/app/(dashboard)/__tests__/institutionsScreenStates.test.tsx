/**
 * 13F 포트폴리오(/institutions) 화면 시험 — 공유 시험 파일에서 이 화면 사례만 옮겨 왔습니다(P5b 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - tinyWeightQa454.test.tsx: "13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)"의 '13F 포트폴리오 화면 — 보유 종목 표'
 * 모의·합성 응답·도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다(이 사례가 쓰는 것만). P5b 두 화면 갈래(13F 포트폴리오 · 교집합·스타일·스코어카드)가
 * 화면을 바꿀 때 서로의 시험 파일을 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // 비중 추이 차트는 이름과 격자 여부만 둡니다(그림은 jsdom에서 재지 못함).
  MultiLineSeries: ({ ariaLabel, grid }: { ariaLabel?: string; grid?: boolean }) => <div role="img" aria-label={ariaLabel} data-grid={String(Boolean(grid))} />,
  WeightHeatmap: () => null,
  HorizontalBars: () => null,
}));

import { endpoints } from "@/lib/endpoints";
import { formatCurrency, formatKrw, formatUsd } from "@/lib/format";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { PortfolioResponse } from "@/lib/types";
import InstitutionsPage from "../institutions/page";

const TINY = "<0.01%";
const ZERO = "0.00%";

const CIK = "0009999998";

let reportDate = "";
let reads: Record<string, unknown> = {};

function portfolio(): PortfolioResponse {
  return {
    available: true, cik: CIK,
    institution: { name: "🇺🇸 가상 대형운용 (Fictional Mega Advisors)", desc: "" },
    quarters: [{ filingDate: "2026-08-14", reportDate, totalValue: 10_000_000_000_000, holdingCount: 2 }],
    latest: { reportDate, filingDate: "2026-08-14", totalValue: 10_000_000_000_000 },
    holdings: [
      { name: "SYNTHETIC LARGE CO", cusip: "000000301", class: "COM", value: 9_999_680_000_000, shares: 1_000, weight: 99.9968, weightDiff: null, sharesDiff: null, action: "유지" },
      { name: "SYNTHETIC SMALL CO", cusip: "000000302", class: "COM", value: 320_000_000, shares: 10, weight: 0.0032, weightDiff: null, sharesDiff: null, action: "신규" },
    ],
  };
}

beforeEach(() => {
  reportDate = rangeStart("30d", kstToday(Date.now()));
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** root 안에 아주 작은 비중이 '<0.01%'로 보이고 '0.00%'는 없는지. */
function expectTiny(root: HTMLElement) {
  expect(within(root).queryByText(ZERO)).toBeNull();
  expect(within(root).getAllByText(TINY).length).toBeGreaterThan(0);
}

describe("13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)", () => {
  it("13F 포트폴리오 화면 — 보유 종목 표", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(portfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    const cell = await screen.findByText("SYNTHETIC SMALL CO");
    const table = cell.closest("table") as HTMLElement;
    expectTiny(table);
  });
});

// ------------------------------------------------------------------ 보유 표 칸 — 비중 변화(QA-696)

/** 보유 표에서 이름이 `name`인 줄의 `header` 열 칸 — 머리 글로 열 자리를 찾습니다(열이 늘어도 같은 칸). */
function holdingCell(name: string, header: string): HTMLElement {
  const row = screen.getByText(name).closest("tr") as HTMLElement;
  const table = row.closest("table") as HTMLElement;
  const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
  const at = headers.findIndex((text) => text.trim() === header);
  expect(at).toBeGreaterThanOrEqual(0);
  return row.children[at] as HTMLElement;
}

function changePortfolio(): PortfolioResponse {
  return {
    available: true, cik: CIK,
    quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1000, holdingCount: 3 }],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1000 },
    holdings: [
      { name: "SYNTHETIC RISE CO", cusip: "000000401", class: "COM", value: 500, shares: 50, weight: 50, weightDiff: 1.5, sharesDiff: 5, action: "비중 확대 (Added)" },
      { name: "SYNTHETIC FALL CO", cusip: "000000402", class: "COM", value: 300, shares: 30, weight: 30, weightDiff: -0.29, sharesDiff: -3, action: "비중 축소 (Reduced)" },
      { name: "SYNTHETIC FIRST CO", cusip: "000000403", class: "COM", value: 200, shares: 20, weight: 20, weightDiff: null, sharesDiff: null, action: "신규 매수 (New)" },
    ],
  };
}

describe("보유 표 '비중 변화' — 색만으로 방향을 전하지 않는다(QA-696)", () => {
  // 수정 전에는(재현 커밋에서는 it.fails) 칸이 deltaColor 글자색과 숫자 글만으로 방향을 나름 — 내린 칸 <span class="text-down">-0.29%p</span>(ASCII '-'),
  // 오른 칸 <span class="text-up">1.50%p</span>('+' 없음), 둘 다 ▲▼·sr 방향 글 없음. 모르는 칸은 '—'(text-text-3)로 이미 맞았음.
  it("내린 값은 ▼·U+2212·sr '하락', 오른 값은 ▲·'+'·sr '상승', 모르면 '—'", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(changePortfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC FALL CO");

    const fall = holdingCell("SYNTHETIC FALL CO", "비중 변화");
    expect(fall.textContent).toContain("\u22120.29");
    expect(fall.textContent).not.toContain("-0.29");
    expect(fall.textContent).toContain("%p");
    expect(within(fall).getByText("▼").getAttribute("aria-hidden")).toBe("true");
    expect(within(fall).getByText("하락").className).toContain("sr-only");

    const rise = holdingCell("SYNTHETIC RISE CO", "비중 변화");
    expect(rise.textContent).toContain("+1.50");
    expect(within(rise).getByText("▲").getAttribute("aria-hidden")).toBe("true");
    expect(within(rise).getByText("상승").className).toContain("sr-only");

    const unknown = holdingCell("SYNTHETIC FIRST CO", "비중 변화");
    // 공용 '—'(Empty — 눈에는 '—', 낭독은 sr '값 없음'), 숫자를 만들지 않음.
    expect(within(unknown).getByText("—")).toBeTruthy();
    expect(unknown.textContent).not.toMatch(/\d/);
    expect(unknown.querySelector(".text-up, .text-down")).toBeNull();
  });
});

// ------------------------------------------------------------------ 고른 기관 패널·요약 KPI 띠와 읽기 상태

const BERKSHIRE = "0001067983";
const INSTITUTIONS = endpoints.institution.institutions;
const PORTFOLIO = endpoints.institution.portfolio(BERKSHIRE, "8", "30");
const USDKRW = endpoints.macro.usdkrw;

/** 경로 → 응답(정확히 일치) — Error면 실패, 함수면 부를 때마다 그 결과. 없는 경로는 끝나지 않는 요청. */
let served: Record<string, unknown> = {};
function serve() {
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in served)) return new Promise(() => {});
    const body = served[path];
    if (typeof body === "function") return (body as () => Promise<unknown>)();
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
}
const portfolioCalls = () => api.apiGetShared.mock.calls.filter(([path]) => path === PORTFOLIO).length;

function summaryPortfolio(overrides: Partial<PortfolioResponse> = {}): PortfolioResponse {
  return {
    available: true, cik: BERKSHIRE,
    institution: { name: "가상 버크셔 (응답 이름)", desc: "" },
    collectedAtKst: "2026-11-18 06:00:00",
    quarters: [
      { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 90_000_000_000, holdingCount: 40 },
      { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 100_000_000_000, holdingCount: 41 },
    ],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 100_000_000_000 },
    holdings: [
      { name: "SYNTHETIC ALPHA CO", cusip: "000000501", class: "COM", value: 60_000_000_000, shares: 600, weight: 60, weightDiff: 1, sharesDiff: 10, action: "비중 확대 (Added)" },
    ],
    ...overrides,
  };
}

function berkshireList() {
  return { institutions: [{ key: "brk", name: "\u{1F1FA}\u{1F1F8} 가상 버크셔 (Fictional Berkshire)", cik: BERKSHIRE, desc: "합성 기관 설명 — 가치 투자" }] };
}

/** KPI 띠 안의 타일(이름 있는 묶음). */
function tile(name: string): HTMLElement {
  const strip = screen.getByRole("region", { name: "포트폴리오 요약" });
  return within(strip).getByRole("group", { name });
}

describe("고른 기관 패널 — 제목·설명·기관 상세 링크와 요약 KPI 띠", () => {
  beforeEach(() => {
    served = {};
    serve();
  });

  it("제목은 목록 이름(국기 뗌), 부제는 목록의 설명, 머리 동작은 기관 상세 링크 — 요약 셋은 KPI 타일(첫 타일만 출처 줄)", async () => {
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = summaryPortfolio();
    served[USDKRW] = { available: true, rate: 1400, lastTs: "2026-11-18 09:00" };
    render(<InstitutionsPage />);

    const heading = await screen.findByRole("heading", { level: 2, name: "가상 버크셔 (Fictional Berkshire)" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText("합성 기관 설명 — 가치 투자")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "기관 상세 열기" }).getAttribute("href")).toBe(`/institutions/${BERKSHIRE}`);

    await screen.findByRole("region", { name: "포트폴리오 요약" });
    const date = tile("최신 공시 기준일");
    expect(date.textContent).toContain("2026-06-30");
    expect(date.textContent).toContain("제출일 2026-08-14");
    expect(date.textContent).toContain("SEC EDGAR 13F");

    const total = tile("포트폴리오 총액");
    // 값 글은 조·억 숫자, 통화는 단위 칸(값의 마지막 글자와 한 묶음) — formatCurrency와 같은 글자('1,000억 달러').
    expect(total.textContent).toContain(formatCurrency(100_000_000_000).replace(" 달러", "달러"));
    expect(within(total).getByText("달러").className).toContain("text-text-3");
    await waitFor(() => expect(total.textContent).toContain(`약 ${formatKrw(140_000_000_000_000)} · 원/달러 1,400.00 기준 · 2026-11-18 09:00`));
    expect(total.textContent).not.toContain("출처");

    const quarters = tile("수집된 분기");
    expect(quarters.textContent).toContain("2개");
    expect(quarters.textContent).toContain("2026-03-31, 2026-06-30");
  });

  it("총액을 모르면 '—'(0으로 채우지 않음), 환율을 모르면 환산 없이 그 사실 한 줄", async () => {
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = summaryPortfolio({ latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: null } });
    served[USDKRW] = { available: false };
    render(<InstitutionsPage />);

    await screen.findByRole("region", { name: "포트폴리오 요약" });
    const total = tile("포트폴리오 총액");
    expect(within(total).getByText("—")).toBeTruthy();
    expect(total.textContent).not.toMatch(/\d/);
    expect(total.textContent).toContain("원/달러 값이 없어 원화 환산은 생략했습니다.");
  });

  it("기관 목록을 아직 못 받으면 제목·부제는 포트폴리오 응답의 기관 이름·설명(같은 백엔드 글)", async () => {
    served[PORTFOLIO] = summaryPortfolio({ institution: { name: "가상 버크셔 (응답 이름)", desc: "응답의 기관 설명" } });
    render(<InstitutionsPage />);
    const heading = await screen.findByRole("heading", { level: 2, name: "가상 버크셔 (응답 이름)" });
    expect(within(heading.closest("section") as HTMLElement).getByText("응답의 기관 설명")).toBeTruthy();
    expect(screen.queryByText("합성 기관 설명 — 가치 투자")).toBeNull();
  });
});

describe("고른 기관 패널 — 포트폴리오 읽기 상태", () => {
  beforeEach(() => {
    served = {};
    serve();
  });

  it("처음 읽는 중이면 값 꼴의 KPI 자리(세 타일 '… 불러오는 중', 첫 타일 출처 줄) — 제목은 CIK(목록·응답 모두 없음), 부제 한 줄은 비워 둠, 기관 상세 링크는 그대로", async () => {
    render(<InstitutionsPage />);
    const heading = await screen.findByRole("heading", { level: 2, name: `CIK ${BERKSHIRE}` });
    const panel = heading.closest("section") as HTMLElement;
    const pending = within(panel).getByRole("region", { name: "포트폴리오 요약 불러오는 중" });
    expect(within(pending).getAllByRole("status").map((node) => node.getAttribute("aria-label"))).toEqual([
      "최신 공시 기준일 불러오는 중",
      "포트폴리오 총액 불러오는 중",
      "수집된 분기 불러오는 중",
    ]);
    expect(pending.textContent).toContain("SEC EDGAR 13F");
    // 값 글(날짜·금액·개수)은 없음 — 출처 글의 '13F'만 숫자.
    expect(pending.textContent?.replace("SEC EDGAR 13F", "")).not.toMatch(/\d/);
    expect(within(panel).queryByText("13F 공시를 불러오는 중…")).toBeNull();
    // 부제 자리 — 글 없는 한 줄(읽기에서 뺌). 늦게 온 설명이 끼어들며 아래를 밀지 않게.
    const reserved = heading.parentElement?.parentElement?.querySelector("p");
    expect(reserved?.textContent).toBe("\u00a0");
    expect(reserved?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(within(panel).getByRole("link", { name: "기관 상세 열기" }).getAttribute("href")).toBe(`/institutions/${BERKSHIRE}`);
    expect(screen.queryByRole("region", { name: "포트폴리오 요약" })).toBeNull();
  });

  it("실패 뒤 다시 읽는 동안은 값 꼴 자리가 아니라 '불러오는 중' 한 줄(QA-655와 같은 규칙)", async () => {
    let calls = 0;
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("백엔드 API에 연결하지 못했습니다")) : new Promise(() => {});
    };
    render(<InstitutionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("13F 공시를 불러오는 중…")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "포트폴리오 요약 불러오는 중" })).toBeNull();
  });

  it("읽기가 실패하면 그 문구와 다시 시도 — 누르면 같은 경로를 한 번 더 읽고, 값이 오면 KPI 띠", async () => {
    let fail = true;
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = () => (fail ? Promise.reject(new Error("백엔드 API에 연결하지 못했습니다")) : Promise.resolve(summaryPortfolio()));
    render(<InstitutionsPage />);

    const message = await screen.findByText("백엔드 API에 연결하지 못했습니다");
    const panel = message.closest("section") as HTMLElement;
    expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe("가상 버크셔 (Fictional Berkshire)");
    expect(portfolioCalls()).toBe(1);

    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("region", { name: "포트폴리오 요약" });
    expect(portfolioCalls()).toBe(2);
    expect(screen.queryByText("백엔드 API에 연결하지 못했습니다")).toBeNull();
  });

  it("저장본이 없으면(available:false) 응답 글을 주의 안내로 — 히트맵·추이·보유 표 패널은 없음", async () => {
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = { available: false, cik: BERKSHIRE, message: "13F 저장본이 아직 없습니다(합성 안내).", quarters: [], holdings: [] };
    render(<InstitutionsPage />);

    const message = await screen.findByText("13F 저장본이 아직 없습니다(합성 안내).");
    expect(message.closest("section")?.querySelector("h2")?.textContent).toBe("가상 버크셔 (Fictional Berkshire)");
    expect(screen.getByText("주의:")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "포트폴리오 요약" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "상위 종목 분기별 비중 히트맵" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^보유 종목 상세/ })).toBeNull();
  });

  it("값이 있는 채로 다시 읽기가 실패하면 머리 신선도에 '새로 읽지 못함' — 값은 그대로", async () => {
    let calls = 0;
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(summaryPortfolio()) : Promise.reject(new Error("백엔드 API에 연결하지 못했습니다"));
    };
    const { rerender } = render(<InstitutionsPage />);
    await screen.findByRole("region", { name: "포트폴리오 요약" });

    signal.token += 1;
    await act(async () => rerender(<InstitutionsPage />));
    await waitFor(() => expect(portfolioCalls()).toBe(2));
    expect(await screen.findByText("새로 읽지 못함")).toBeTruthy();
    expect(screen.getByRole("region", { name: "포트폴리오 요약" })).toBeTruthy();
    signal.token = 0;
  });
});

// ------------------------------------------------------------------ 보유 표 — 동작 배지와 행 바탕(QA-697)

/** 요소의 바탕 클래스 토큰(변형 접두어 'hover:' 등을 뗀 'bg-…'). `prefix`가 있으면 그 변형만. */
function bgTokens(element: Element, prefix = ""): string[] {
  return [...element.classList].filter((name) => name.startsWith(`${prefix}bg-`)).map((name) => name.slice(prefix.length));
}

describe("보유 표 '직전 분기 대비' 배지 — 행 바탕에 묻히지 않고 한 줄(QA-697)", () => {
  // 공용 표 행이 마우스를 올리거나 고르면 칠하는 바탕과 배지 바탕이 같은 토큰이면(테두리 없는 배지) 그때 배지 상자가 사라집니다(1.00:1). 배지는 칸 안에서
  // 줄을 바꾸지 않아야 합니다(좁은 칸에서 '비중 축소 / (Reduced)' 두 줄로 접힘). jsdom이라 그리지 않고 클래스로 셉니다.
  // 수정 전에는(재현 커밋에서는 it.fails) 옛 ui Table 행 'hover:bg-surface-2'와 SourceBadge 'bg-surface-2'(테두리 없음)가 같았음 — same = ['bg-surface-2'],
  // 배지 칸 'break-keep px-3 py-1.5 tabular-nums text-left'(whitespace-nowrap 없음).
  // 행 바탕은 넓은 화면 옆 칸 배치에서 봅니다 — 검사 칸 틀이 처음에 첫 줄을 고르고 공용 표가 그 행을 칠합니다(bg-surface-2). 좁은 배치에는 고른 행이 없고 공용 표의
  // 누를 수 없는 행에는 hover 바탕도 없어, 그 배치로 보면 행 바탕이 늘 비어 배지를 테두리 없는 SourceBadge로 되돌려도 통과했습니다(P5b 검토 지적 —
  // 이 꼴로 바꾼 뒤 HoldingActionTag를 개편 전 SourceBadge 꼴로 되돌려 plain it으로 돌리면 { rowPainted: true, bordered: false, same: ["bg-surface-2"] }로 실패).
  it("고른 행(넓은 화면 옆 칸 배치의 첫 줄) 바탕과 같은 바탕의 테두리 없는 배지가 없고, 배지는 줄바꿈 없는 칸 안", async () => {
    stubWide();
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) return Promise.resolve(changePortfolio());
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    await screen.findByRole("region", { name: "보유 종목 자세히 — SYNTHETIC RISE CO" });
    // 옆 검사 칸의 '동작' 줄에도 같은 글이 있어 표 안에서 찾습니다.
    const table = screen.getByRole("region", { name: "보유 종목 상세 (좌우 스크롤)" });
    const badge = within(table).getByText("비중 확대 (Added)");
    const row = badge.closest("tr") as HTMLElement;
    expect(row.getAttribute("aria-current")).toBe("true");
    // 배지 상자 = '직전 분기 대비' 칸의 첫 자식(공용 표는 칸 내용을 그대로 넣음).
    const cell = badge.closest("td, th") as HTMLElement;
    const box = cell.firstElementChild as HTMLElement;
    const rowBackgrounds = [...bgTokens(row), ...bgTokens(row, "hover:")];
    const bordered = box.classList.contains("border");
    expect({
      rowPainted: rowBackgrounds.includes("bg-surface-2"),
      bordered,
      same: bordered ? [] : rowBackgrounds.filter((token) => bgTokens(box).includes(token)),
    }).toEqual({ rowPainted: true, bordered: true, same: [] });

    const nowrap = badge.closest(".whitespace-nowrap");
    expect(nowrap !== null && cell.contains(nowrap)).toBe(true);
  });
});

describe("보유 표 '평가액' — 모르면 공용 '—'", () => {
  it("평가액이 null이면 칸은 공용 표의 '—'(보조 글자색·낭독 '값 없음') — 0으로 채우지 않음", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return Promise.resolve({ institutions: [{ key: "mega", name: "가상 대형운용", cik: CIK, desc: "" }] });
      if (path.startsWith("/api/sec13f/portfolio")) {
        const body = changePortfolio();
        return Promise.resolve({ ...body, holdings: body.holdings.map((holding, index) => (index === 1 ? { ...holding, value: null } : holding)) });
      }
      return new Promise(() => {});
    });
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC FALL CO");
    const cell = holdingCell("SYNTHETIC FALL CO", "평가액");
    expect(cell.textContent).toBe("—값 없음");
    expect(cell.querySelector(".text-text-3")).not.toBeNull();
  });
});

// ------------------------------------------------------------------ 보유 표 검사 칸

/** 넓은 화면(lg 이상 — 셸의 왼쪽 메뉴가 보이는 폭)으로 흉내 냅니다. 틀 폭은 jsdom에서 0이라 크기 질의 배치(옆 칸)에 맡깁니다. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

function twoHoldings(): PortfolioResponse {
  return summaryPortfolio({
    holdings: [
      { name: "SYNTHETIC ALPHA CO", cusip: "000000501", class: "COM", value: 60_000_000_000, shares: 600, weight: 60, weightDiff: 1, sharesDiff: 10, action: "비중 확대 (Added)" },
      { name: "SYNTHETIC BETA CO", cusip: "000000502", class: "CL B", value: 40_000_000_000, shares: null, weight: 40, weightDiff: null, sharesDiff: null, action: "비교 불가 (주식 수 없음)" },
    ],
  });
}

/** 속성 목록에서 이름이 `label`인 줄의 값 칸(dd). */
function propertyValue(root: HTMLElement, label: string): HTMLElement {
  const term = within(root).getByText(label, { selector: "dt" });
  return term.parentElement?.querySelector("dd") as HTMLElement;
}

describe("보유 표 검사 칸 — 맨 앞 아이콘 줄 단추", () => {
  beforeEach(() => {
    served = {};
    serve();
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = twoHoldings();
    served[USDKRW] = { available: true, rate: 1400, lastTs: "2026-11-18 09:00" };
  });

  it("좁은 화면은 대화상자 — 이름 = 줄 이름표, 기관 상세와 같은 속성 + 원화 환산(환율 글), 주식 수는 표가 아니라 여기, 닫으면 연 단추로", async () => {
    render(<InstitutionsPage />);
    const open = await screen.findByRole("button", { name: "SYNTHETIC ALPHA CO 13F 줄 자세히" });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(open.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // 보유 주식수 열은 없음 — 검사 칸의 '주식 수'로 옮김.
    const table = open.closest("table") as HTMLElement;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["자세히", "종목", "비중", "비중 변화", "평가액", "직전 분기 대비"]);

    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "SYNTHETIC ALPHA CO" });
    expect(propertyValue(dialog, "공시 이름").textContent).toBe("SYNTHETIC ALPHA CO");
    expect(propertyValue(dialog, "클래스").textContent).toBe("COM");
    expect(within(propertyValue(dialog, "CUSIP")).getByText("000000501").className).toContain("font-mono");
    expect(propertyValue(dialog, "비중").textContent).toBe("60.00%");
    expect(propertyValue(dialog, "평가액").textContent).toBe(formatUsd(60_000_000_000));
    const krw = propertyValue(dialog, "원화 환산");
    expect(krw.textContent).toContain(`약 ${formatKrw(84_000_000_000_000)}`);
    expect(krw.textContent).toContain("원/달러 1,400.00 기준 · 2026-11-18 09:00");
    expect(propertyValue(dialog, "주식 수").textContent).toBe("600주");
    expect(propertyValue(dialog, "주식 수 변화").textContent).toBe("+10주");
    expect(propertyValue(dialog, "비중 변화").textContent).toBe("+1.00%p");
    expect(propertyValue(dialog, "동작").textContent).toBe("비중 확대 (Added)");
    expect(within(dialog).getByRole("link", { name: "정보 검색에서 찾기" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("SYNTHETIC ALPHA CO")}`);

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("모르는 주식 수·변화는 '—'(0으로 채우지 않음)", async () => {
    render(<InstitutionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "SYNTHETIC BETA CO 13F 줄 자세히" }));
    const dialog = await screen.findByRole("dialog", { name: "SYNTHETIC BETA CO" });
    for (const label of ["주식 수", "주식 수 변화", "비중 변화"]) {
      const value = propertyValue(dialog, label);
      expect(within(value).getByText("—")).toBeTruthy();
      expect(value.textContent).not.toMatch(/\d/);
    }
  });

  it("넓은 화면은 표 옆 검사 칸 — 처음은 첫 줄, 다른 줄 단추를 누르면 그 줄(고른 행 aria-current·단추 aria-controls)", async () => {
    stubWide();
    render(<InstitutionsPage />);
    const first = await screen.findByRole("region", { name: "보유 종목 자세히 — SYNTHETIC ALPHA CO" });
    expect(within(first).getByRole("heading", { level: 3, name: "SYNTHETIC ALPHA CO" })).toBeTruthy();
    expect(screen.getByText("SYNTHETIC ALPHA CO", { selector: "button" }).closest("tr")?.getAttribute("aria-current")).toBe("true");

    const beta = screen.getByRole("button", { name: "SYNTHETIC BETA CO 13F 줄 자세히" });
    expect(beta.getAttribute("aria-controls")).toBe(first.id);
    fireEvent.click(beta);
    const shown = await screen.findByRole("region", { name: "보유 종목 자세히 — SYNTHETIC BETA CO" });
    expect(propertyValue(shown, "클래스").textContent).toBe("CL B");
    expect(beta.closest("tr")?.getAttribute("aria-current")).toBe("true");
    expect(beta.getAttribute("aria-current")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("옆 칸 배치의 표는 칸 좌우 여백을 줄이고(8px) 이름 칸은 긴 낱말도 비상으로 꺾음 — 최소 폭·넘김 안내 없음, 대화상자 배치는 공용 표 그대로", async () => {
    stubWide();
    render(<InstitutionsPage />);
    await screen.findByRole("region", { name: "보유 종목 자세히 — SYNTHETIC ALPHA CO" });
    const region = screen.getByRole("region", { name: "보유 종목 상세 (좌우 스크롤)" });
    const table = region.querySelector("table") as HTMLElement;
    expect(table.className).not.toContain("min-w-[640px]");
    expect(screen.queryByText("← 표를 좌우로 넘겨 보세요")).toBeNull();
    // 감싼 상자(공용 표의 개수 줄·스크롤 상자를 담음)의 자손 선택자 클래스.
    expect(region.parentElement?.className).toBe("[&_td]:px-2 [&_th]:px-2");
    const name = screen.getByText("SYNTHETIC ALPHA CO", { selector: "button" });
    expect(name.closest(".wrap-anywhere")).not.toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    render(<InstitutionsPage />);
    await screen.findByRole("button", { name: "SYNTHETIC ALPHA CO 13F 줄 자세히" });
    const narrowRegion = screen.getByRole("region", { name: "보유 종목 상세 (좌우 스크롤)" });
    expect(narrowRegion.querySelector("table")?.className).toContain("min-w-[640px]");
    expect(narrowRegion.parentElement?.className ?? "").not.toContain("[&_td]:px-2");
    expect(screen.getByText("SYNTHETIC ALPHA CO", { selector: "button" }).closest(".wrap-anywhere")).toBeNull();
  });
});

// ------------------------------------------------------------------ 비중 히트맵 패널 부제

describe("비중 히트맵 패널 부제 — 순차 범례와 같은 말", () => {
  it("'칸이 밝을수록 비중이 큽니다'(범례 '밝은 단계일수록 큼') — 예전 '색이 진할수록'은 없음", async () => {
    served = {};
    serve();
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = summaryPortfolio({ weightHistory: { dates: ["2026-06-30"], series: { "SYNTHETIC ALPHA CO": [60] } } });
    render(<InstitutionsPage />);
    const heading = await screen.findByRole("heading", { level: 2, name: "상위 종목 분기별 비중 히트맵" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText("칸이 밝을수록 비중이 큽니다. 어느 칸이 밝아지는지만 보면 흐름이 읽힙니다.")).toBeTruthy();
    expect(panel.textContent).not.toContain("진할수록");
  });
});

// ------------------------------------------------------------------ 왼쪽 칸 — 기관 목록·조회 조건

const NPS = "0001608046";

function twoInstitutions() {
  return {
    institutions: [
      { key: "brk", name: "\u{1F1FA}\u{1F1F8} 가상 버크셔 (Fictional Berkshire)", cik: BERKSHIRE, desc: "합성 기관 설명 — 가치 투자" },
      { key: "nps", name: "\u{1F1F0}\u{1F1F7} 가상 연기금 (Fictional Pension)", cik: NPS, desc: "합성 기관 설명 — 연기금" },
    ],
  };
}

describe("왼쪽 칸 — 기관 목록(하나 고름)과 조회 조건", () => {
  beforeEach(() => {
    served = {};
    serve();
  });

  it("기관 목록은 이름 있는 라디오 묶음 '분석할 기관'의 radio(이름 = 국기 뗀 기관 이름, aria-checked — QA-711) — 기본은 버크셔, 고르면 그 기관의 패널·포트폴리오", async () => {
    served[INSTITUTIONS] = twoInstitutions();
    served[PORTFOLIO] = summaryPortfolio();
    served[endpoints.institution.portfolio(NPS, "8", "30")] = summaryPortfolio({ cik: NPS, institution: { name: "가상 연기금 (응답 이름)" } });
    render(<InstitutionsPage />);

    const group = await screen.findByRole("radiogroup", { name: "분석할 기관" });
    const berkshire = within(group).getByRole("radio", { name: "가상 버크셔 (Fictional Berkshire)" });
    const pension = within(group).getByRole("radio", { name: "가상 연기금 (Fictional Pension)" });
    expect(berkshire.getAttribute("aria-checked")).toBe("true");
    expect(pension.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("heading", { level: 2, name: "기관" }).parentElement?.textContent).toContain("2곳");

    fireEvent.click(pension);
    expect(pension.getAttribute("aria-checked")).toBe("true");
    expect(berkshire.getAttribute("aria-checked")).toBe("false");
    const heading = await screen.findByRole("heading", { level: 2, name: "가상 연기금 (Fictional Pension)" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText("합성 기관 설명 — 연기금")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "기관 상세 열기" }).getAttribute("href")).toBe(`/institutions/${NPS}`);
    await within(panel).findByRole("region", { name: "포트폴리오 요약" });

    // 고른 줄을 다시 눌러도 고름이 풀리거나 다시 읽지 않습니다(하나 고름).
    const before = api.apiGetShared.mock.calls.length;
    fireEvent.click(pension);
    await act(async () => {});
    expect(pension.getAttribute("aria-checked")).toBe("true");
    expect(api.apiGetShared.mock.calls.length).toBe(before);
  });

  it("조회 조건은 왼쪽 칸의 고르기 둘(이름·선택지·기본 그대로) — '분석할 기관' 고르기 상자는 없음", async () => {
    served[INSTITUTIONS] = twoInstitutions();
    render(<InstitutionsPage />);
    const conditions = (await screen.findByRole("heading", { level: 2, name: "조회 조건" })).closest("section") as HTMLElement;
    const quarters = within(conditions).getByLabelText("조회 분기 수") as HTMLSelectElement;
    const topN = within(conditions).getByLabelText("표시 종목 수") as HTMLSelectElement;
    expect(quarters.value).toBe("8");
    expect([...quarters.options].map((option) => option.textContent)).toEqual(["최근 1개 분기", "최근 2개 분기", "최근 4개 분기", "최근 8개 분기"]);
    expect(topN.value).toBe("30");
    expect([...topN.options].map((option) => option.textContent)).toEqual(["상위 10개", "상위 20개", "상위 30개", "상위 50개"]);
    expect(screen.queryByRole("combobox", { name: "분석할 기관" })).toBeNull();
  });

  it("기관 목록을 읽는 동안은 자리표시, 읽지 못하면 그 문구와 다시 시도 — 누를 때만 목록을 한 번 더 읽음", async () => {
    let fail = true;
    served[INSTITUTIONS] = () => (fail ? Promise.reject(new Error("기관 목록 연결 실패(합성)")) : Promise.resolve(twoInstitutions()));
    render(<InstitutionsPage />);
    const group = screen.getByRole("group", { name: "분석할 기관" });
    expect(within(group).getByRole("status", { name: "기관 목록을 불러오는 중" })).toBeTruthy();

    expect(await within(group).findByText("기관 목록 연결 실패(합성)")).toBeTruthy();
    const listCalls = () => api.apiGetShared.mock.calls.filter(([path]) => path === INSTITUTIONS).length;
    expect(listCalls()).toBe(1);
    fail = false;
    fireEvent.click(within(group).getByRole("button", { name: "다시 시도" }));
    expect(await within(group).findByRole("radio", { name: "가상 버크셔 (Fictional Berkshire)" })).toBeTruthy();
    expect(listCalls()).toBe(2);
  });
});

describe("비중 추이 차트 — 격자·구체 이름", () => {
  it("기관 이름을 담은 차트 이름 '{기관} 상위 종목 분기별 비중 추이'", async () => {
    served = {};
    serve();
    served[INSTITUTIONS] = berkshireList();
    served[PORTFOLIO] = summaryPortfolio({ weightHistory: { dates: ["2026-06-30"], series: { "SYNTHETIC ALPHA CO": [60] } } });
    render(<InstitutionsPage />);
    const chart = await screen.findByRole("img", { name: "가상 버크셔 (Fictional Berkshire) 상위 종목 분기별 비중 추이" });
    expect(chart.dataset.grid).toBe("true");
  });
});
