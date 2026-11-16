/**
 * 목록-검사의 따로 선 링크가 누르는 자리(QA-582). 응답은 모두 합성 값입니다.
 *
 * 종목 상세 보유 기관의 '기관 상세 열기'와 기관 상세 보유 종목의 '정보 검색에서 찾기'는 검사 칸(넓은 화면)·대화상자(좁은 화면) 안의
 * `flex flex-col` 상자의 바로 아래 자식입니다. 링크 클래스(TEXT_TARGET — inline-flex)여도 flex 항목은 부모의 align-items 기본값(늘림)을 받아
 * 가로 폭 전체(214·324·638px)가 누르는 자리와 포커스 링이 됐습니다 — 글 오른쪽 빈 곳을 눌러도 이동했습니다. 링크가 자기 줄에서 글 폭만 쓰게
 * `self-start`를 둡니다(같은 화면 '연결' 패널 링크처럼). jsdom은 배치를 재지 않으므로 클래스로 대조하고, 실제 폭은 QA 스택 브라우저로 봅니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";
import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999993";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNL", yahooSymbol: "SYNL", name: "Synthetic Link Inc.", exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: null, marketState: null, stats: [], profile: null, consensus: null, research: [],
  source: null, error: null, fetchedAt: null,
};

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    [endpoints.detail.quote("us", "SYNL")]: { available: true, quote: QUOTE },
    [endpoints.institution.guruHolders("SYNTHETIC LINK")]: {
      available: true,
      query: "SYNTHETIC LINK",
      rows: [{ institution: "합성 연기금", cik: CIK, name: "SYNTHETIC LINK INC", cusip: "000000582", weight: 1.5, value: 4e9, reportDate: "2026-06-30" }],
    },
    [endpoints.institution.portfolio(CIK, 8, 30)]: {
      available: true, cik: CIK, institution: { name: "합성 연기금 (Synthetic Pension)", desc: "" },
      quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 5e9, holdingCount: 1 }],
      latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 5e9 },
      holdings: [{ name: "SYNTHETIC LINK INC", cusip: "000000582", class: "COM", value: 4e9, shares: 1000, weight: 80, weightDiff: null, sharesDiff: null, action: "유지" }],
    },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 넓은 화면(lg 이상) — 목록-검사가 대화상자 대신 옆 검사 칸을 씁니다. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

const renderAs = (page: ReactElement) => render(<SessionUserProvider user={MEMBER}>{page}</SessionUserProvider>);
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 링크가 검사 상자(flex-col)에서 늘어나지 않는다 — 링크 자신이 self-start(부모 align-items는 그대로 늘림 — 속성 목록이 폭을 다 씀). */
function expectTextWidth(link: HTMLElement) {
  expect(classes(link)).toContain("self-start");
  expect(classes(link.parentElement as HTMLElement)).toContain("flex-col");
}

describe("목록-검사의 따로 선 링크는 글 폭만 누르는 자리 (QA-582)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 두 링크 모두 self-start가 없어 대화상자 폭 전체로 늘어났습니다.
  it("좁은 화면 대화상자 — 종목 '기관 상세 열기'와 기관 '정보 검색에서 찾기'", async () => {
    renderAs(<StockDetailScreen market="us" code="SYNL" />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "13F 보유 기관" })).getByRole("button"));
    expectTextWidth(within(await screen.findByRole("dialog", { name: "합성 연기금" })).getByRole("link", { name: "기관 상세 열기" }));
    cleanup();

    renderAs(<InstitutionDetailScreen cik={CIK} />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "상위 보유 종목" })).getByRole("button"));
    expectTextWidth(within(await screen.findByRole("dialog", { name: "SYNTHETIC LINK INC" })).getByRole("link", { name: "정보 검색에서 찾기" }));
  });

  it("넓은 화면 옆 검사 칸 — 종목 '기관 상세 열기'와 기관 '정보 검색에서 찾기'", async () => {
    stubWide();
    renderAs(<StockDetailScreen market="us" code="SYNL" />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "13F 보유 기관" })).getByRole("button"));
    expectTextWidth(within(screen.getByRole("region", { name: "13F 보유 기관 — 합성 연기금" })).getByRole("link", { name: "기관 상세 열기" }));
    cleanup();

    renderAs(<InstitutionDetailScreen cik={CIK} />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
    const inspector = await screen.findByRole("region", { name: "상위 보유 종목 — SYNTHETIC LINK INC" });
    expectTextWidth(within(inspector).getByRole("link", { name: "정보 검색에서 찾기" }));
  });
});
