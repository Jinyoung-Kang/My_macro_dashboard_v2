/**
 * QA-1042(성능 개선 3차 작업 D): 좁은 화면(390폭)에서 종목 상세·기관 상세의 대상 머리가 응답 뒤에 자라(또는 줄었다 늘어) 그 아래 탭·차트를 밀었습니다 —
 * QA 합성 정상 시세·실시간 시세로 종목 상세 0.13(고친 뒤 0.002), 기관 상세 0.114(고친 뒤 0.001).
 *  - 종목 상세: 시세가 오면 이름 아래에 보조 글 한 줄(거래소 · 종류 · 통화)이 생김(+24px), 읽는 중 자리(104px)가 현재가 줄 + 배지 두 줄(102px)과 2px 어긋남,
 *    시세가 먼저 오고 실시간 시세가 뒤따라 오면 배지 줄이 한 줄(16px)이었다가 두 줄(38px)이 됨, 주기 고르기가 시세 뒤에 생기며 옆 링크를 밂,
 *    차트 칸의 제목이 '코드 시세'에서 '종목 이름 시세'로 길어지며 기간 단추가 아래 줄로 넘어감(+32px).
 *  - 기관 상세: 이름 'CIK …'가 '한글 (English)' 꼴의 긴 이름으로 바뀌며 이름이 두 줄로 꺾이고 태그가 다음 줄로 내려감(+52px).
 * 내용·차례·숫자는 그대로 두고 응답 전 자리의 크기만 맞춥니다(사용자 결정 D-5). 응답은 모두 합성 값입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 각 사례의 주석.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";
import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const QUOTE = {
  available: true,
  quote: {
    market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "가짜전자", exchange: "KOSPI", currency: "KRW", kind: "EQUITY", price: 70000,
    previousClose: 69000, change: 1000, changePct: 1.45, asOf: "2026-11-27T05:00:00+00:00", marketState: "REGULAR", stats: [], profile: null,
    consensus: null, research: [], source: { label: "네이버 증권", url: "https://example.invalid/q" }, error: null, fetchedAt: "2026-11-27T05:00:00+00:00",
  },
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

const tokens = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(cleanup);

function renderStock() {
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market="kr" code="005930" />
    </SessionUserProvider>,
  );
}

describe("QA-1042 종목 상세 대상 머리의 읽는 중 자리", () => {
  // 수정 전: 읽는 중에는 이름 아래에 보조 글 줄(p)이 없었습니다('expected null to be truthy').
  it("읽는 중에도 이름 아래 보조 글 한 줄의 자리가 있다(보이지 않는 글 — 낭독 제외)", async () => {
    renderStock();
    const head = (await screen.findByRole("heading", { level: 1, name: "005930" })).closest("header") as HTMLElement;
    const line = head.querySelector("p");
    expect(line).toBeTruthy();
    const slot = line?.querySelector('[aria-hidden="true"]');
    expect(tokens(slot)).toContain("invisible");
    expect(line?.textContent).toBe("005930");
  });

  // 수정 전: min-h-[104px] sm:min-h-20(보조 글 줄의 몫을 함께 어림한 값 — 390폭 2px·sm 이상 24px 어긋남).
  it("읽는 중 자리의 높이는 현재가 줄 + 배지 줄(390폭 102px · sm 이상 56px)", async () => {
    renderStock();
    const status = await screen.findByRole("status", { name: "시세를 불러오는 중" });
    const box = status.closest("div.min-h-\\[102px\\]") ?? status.parentElement;
    expect(tokens(box)).toEqual(expect.arrayContaining(["min-h-[102px]", "sm:min-h-14"]));
  });

  // 수정 전: 읽는 중에는 머리 동작 칸에 주기 고르기 자리가 없었습니다('expected undefined to be truthy').
  it("읽는 중 머리 동작 칸에 주기 고르기와 같은 꼴의 보이지 않는 자리 — 조작·낭독 없음", async () => {
    renderStock();
    const head = (await screen.findByRole("heading", { level: 1, name: "005930" })).closest("header") as HTMLElement;
    const slot = Array.from(head.querySelectorAll<HTMLElement>('[aria-hidden="true"].invisible')).find((element) => element.textContent?.includes("실시간 시세"));
    expect(slot).toBeTruthy();
    const select = slot?.querySelector("select");
    expect(select?.disabled).toBe(true);
    expect(select?.tabIndex).toBe(-1);
    // 이름 붙은 조작(주기 고르기)은 아직 없습니다 — 자리는 낭독 나무 밖.
    expect(screen.queryByRole("combobox", { name: "실시간 시세 주기" })).toBeNull();
  });

  // 수정 전: 배지 줄을 감싼 칸에 좁은 화면 두 줄 높이가 없었습니다('expected null to be truthy').
  it("시세가 온 뒤 배지 줄은 좁은 화면에서 두 줄 높이를 늘 둔다 — 실시간 시세가 뒤따라 와도 머리가 줄었다 늘지 않게", async () => {
    reads["/api/detail/quote"] = QUOTE;
    renderStock();
    const head = (await screen.findByRole("heading", { level: 1, name: "가짜전자" })).closest("header") as HTMLElement;
    const badge = within(head).getByText(/네이버 증권/).closest("div.min-h-\\[38px\\]");
    expect(badge).toBeTruthy();
    expect(tokens(badge)).toEqual(expect.arrayContaining(["min-h-[38px]", "sm:min-h-0", "content-start", "flex-wrap"]));
    // 보조 글은 받은 값 그대로(자리표시가 아님) · 주기 고르기는 진짜 조작.
    expect(within(head).getByText("KOSPI · 주식 · KRW")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "실시간 시세 주기" })).toBeTruthy();
  });

  // 수정 전: 차트 패널 머리의 동작 묶음에 좁은 화면 줄바꿈이 없었습니다('expected [ … ] to include "max-sm:basis-full"').
  it("차트 칸의 기간 단추는 좁은 화면에서 늘 제목 아래 줄 — 제목이 종목 이름으로 길어져도 차트를 밀지 않게", async () => {
    renderStock();
    const tabs = await screen.findByRole("tablist", { name: /차트 기간/ });
    const actions = tabs.closest("header")?.lastElementChild;
    expect(tokens(actions)).toContain("max-sm:basis-full");
  });
});

describe("QA-1042 기관 상세 대상 머리의 이름 줄 자리", () => {
  const CIK = "0001234567";
  function renderInstitution() {
    render(
      <SessionUserProvider user={MEMBER}>
        <InstitutionDetailScreen cik={CIK} />
      </SessionUserProvider>,
    );
  }

  // 수정 전: 이름 줄에 좁은 화면 높이가 없었습니다('expected [ … ] to include "max-sm:min-h-20"').
  it("이름을 받기 전('CIK …')에는 좁은 화면에서 두 줄 이름 + 태그 줄의 높이(80px)를 위로 붙여 잡는다", async () => {
    renderInstitution();
    const heading = await screen.findByRole("heading", { level: 1, name: `CIK ${CIK}` });
    expect(tokens(heading.parentElement)).toEqual(expect.arrayContaining(["max-sm:min-h-20", "max-sm:content-start"]));
  });

  it("이름을 받은 뒤에는 자리를 두지 않는다(받은 이름의 높이 그대로)", async () => {
    reads["/api/sec13f/portfolio"] = {
      available: true, cik: CIK, institution: { name: "가짜 연금 (QA Fake Pension Service)", cik: CIK }, quarters: [], latest: null,
      collectedAtKst: "2026-11-27 12:00", ageSeconds: 60,
    };
    renderInstitution();
    const heading = await screen.findByRole("heading", { level: 1, name: "가짜 연금 (QA Fake Pension Service)" });
    expect(tokens(heading.parentElement)).not.toContain("max-sm:min-h-20");
  });
});
