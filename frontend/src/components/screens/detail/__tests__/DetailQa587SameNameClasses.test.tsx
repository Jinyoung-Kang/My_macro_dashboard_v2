/**
 * 기관 상세 보유 종목 — 같은 공시 이름의 다른 증권(ALPHABET INC CL A / CL C) 줄의 검사 칸·대화상자 제목(QA-587). 응답은 모두 합성 값입니다.
 *
 * 목록-검사의 이름표(itemLabel)는 검사 칸 영역 이름('상위 보유 종목 — …')·검사 칸 제목·대화상자 제목에 쓰이는데 공시 이름뿐이라, 이름이 같은 줄을
 * 고르면 세 자리가 똑같았습니다(줄 단추에는 클래스 보조 글이 있어 갈림). 이름이 겹치는 줄에만 ' · 클래스'를 붙입니다(lib/detailEntity
 * holdingItemLabels — 백엔드 lineLabels와 같은 규칙). 겹치지 않는 줄의 이름표·줄 내용·정보 검색 검색어는 그대로입니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { Holding, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999987";

const row = (name: string, cusip: string, klass: string, weight: number): Holding => ({
  name, cusip, class: klass, value: weight * 1e8, shares: 1000, weight, weightDiff: null, sharesDiff: null, action: "유지",
});
const HOLDINGS = [
  row("NVIDIA CORPORATION", "67066G104", "COM", 10),
  row("ALPHABET INC", "02079K305", "CAP STK CL A", 5),
  row("ALPHABET INC", "02079K107", "CAP STK CL C", 4),
];

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.portfolio(CIK, 8, 30)
      ? Promise.resolve({
          available: true, cik: CIK, institution: { name: "합성 연금 (Synthetic Pension)", desc: "" },
          quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 2e9, holdingCount: 3 }],
          latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 2e9 }, holdings: HOLDINGS,
        })
      : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openHoldings() {
  render(
    <SessionUserProvider user={MEMBER}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
  return within(await screen.findByRole("list", { name: "상위 보유 종목" })).getAllByRole("button");
}

describe("같은 이름의 다른 클래스 줄 — 검사 칸·대화상자 제목에 클래스 (QA-587)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 CL C 줄의 영역 이름이 '상위 보유 종목 — ALPHABET INC', 제목이 'ALPHABET INC'(CL A와 같음)였습니다.
  it.fails("넓은 화면 — 고른 줄의 검사 칸 영역 이름과 제목이 'ALPHABET INC · CAP STK CL C', 겹치지 않는 이름은 그대로", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    const rows = await openHoldings();
    expect(screen.getByRole("region", { name: "상위 보유 종목 — NVIDIA CORPORATION" })).toBeTruthy();
    fireEvent.click(rows[2]);
    const inspector = screen.getByRole("region", { name: "상위 보유 종목 — ALPHABET INC · CAP STK CL C" });
    expect(within(inspector).getByRole("heading", { name: "ALPHABET INC · CAP STK CL C" })).toBeTruthy();
    // 정보 검색 검색어는 공시 이름 그대로
    expect(within(inspector).getByRole("link", { name: "정보 검색에서 찾기" }).getAttribute("href")).toBe(`/search?q=${encodeURIComponent("ALPHABET INC")}`);
    fireEvent.click(rows[1]);
    expect(screen.getByRole("region", { name: "상위 보유 종목 — ALPHABET INC · CAP STK CL A" })).toBeTruthy();
  });

  it.fails("좁은 화면 — 대화상자 이름이 'ALPHABET INC · CAP STK CL C'", async () => {
    const rows = await openHoldings();
    fireEvent.click(rows[2]);
    expect(await screen.findByRole("dialog", { name: "ALPHABET INC · CAP STK CL C" })).toBeTruthy();
  });
});
