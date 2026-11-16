/**
 * 종목 상세 '보유 기관' 탭 — 한 기관이 같은 회사의 다른 증권(A·C주)을 함께 든 두 줄의 검사 칸·대화상자 제목(QA-587, 기관 상세 보유 종목과 같은 원인).
 * 응답은 모두 합성 값입니다(실제 13F 자료에서는 버크셔·노르웨이 국부펀드가 'ALPHABET INC' 두 CUSIP(02079K305·02079K107)을 함께 듦).
 *
 * 목록-검사의 이름표(itemLabel)가 기관 이름뿐이라 같은 기관의 두 줄을 고르면 검사 칸 영역 이름('13F 보유 기관 — …')·제목·대화상자 제목이 똑같고,
 * 줄 내용도 비중·평가액만 달라(공시 이름·보고일이 같음) 목록에서 가를 수 없었습니다. 기관이 겹치는 줄에만 이름표에 ' · CUSIP …'를 붙이고 줄
 * 보조 글에 CUSIP을 적습니다(lib/detailEntity holderRowTells). 겹치지 않는 줄의 이름표·보조 글은 그대로입니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { DetailQuote, GuruHoldersResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUERY = "SYNTHETIC ALPHA";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNA", yahooSymbol: "SYNA", name: "Synthetic Alpha Inc.", exchange: "NasdaqGS", currency: "USD", kind: "EQUITY",
  price: 180, previousClose: 179, change: 1, changePct: 0.56, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNA" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

const row = (institution: string, cik: string, name: string, cusip: string, weight: number) => ({
  institution, cik, name, cusip, weight, value: weight * 1e9, reportDate: "2026-06-30",
});
const HOLDERS: GuruHoldersResponse = {
  available: true, query: QUERY, totalMatches: 4, truncated: false,
  rows: [
    row("합성 자산운용 (Synthetic Asset)", "0000000001", "SYNTHETIC ALPHA INC", "000000105", 9),
    row("가상 투자자문", "0000000002", "SYNTHETIC ALPHA INC CLASS A", "000000105", 4),
    row("합성 자산운용 (Synthetic Asset)", "0000000001", "SYNTHETIC ALPHA INC", "000000204", 3),
    row("예시 연기금", "0000000003", "SYNTHETIC ALPHA INC", "000000105", 2),
  ],
};

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.detail.quote("us", "SYNA")]: { available: true, quote: QUOTE },
    [endpoints.institution.guruHolders(QUERY)]: HOLDERS,
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openHolders() {
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market="us" code="SYNA" />
    </SessionUserProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
  return within(await screen.findByRole("list", { name: "13F 보유 기관" })).getAllByRole("button");
}

describe("종목 상세 보유 기관 — 같은 기관의 두 줄을 CUSIP으로 가름 (QA-587)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 1·3번 줄의 영역 이름이 둘 다 '13F 보유 기관 — 합성 자산운용 (Synthetic Asset)', 제목도 같았습니다.
  it.fails("넓은 화면 — 같은 기관 줄의 검사 칸 영역 이름과 제목에 ' · CUSIP …', 겹치지 않는 기관은 그대로", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    const rows = await openHolders();
    fireEvent.click(rows[0]);
    const first = screen.getByRole("region", { name: "13F 보유 기관 — 합성 자산운용 (Synthetic Asset) · CUSIP 000000105" });
    expect(within(first).getByRole("heading", { name: "합성 자산운용 (Synthetic Asset) · CUSIP 000000105" })).toBeTruthy();
    fireEvent.click(rows[2]);
    const third = screen.getByRole("region", { name: "13F 보유 기관 — 합성 자산운용 (Synthetic Asset) · CUSIP 000000204" });
    expect(within(third).getByRole("heading", { name: "합성 자산운용 (Synthetic Asset) · CUSIP 000000204" })).toBeTruthy();
    fireEvent.click(rows[1]);
    expect(screen.getByRole("region", { name: "13F 보유 기관 — 가상 투자자문" })).toBeTruthy();
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 3번 줄 대화상자 이름이 '합성 자산운용 (Synthetic Asset)'(1번 줄과 같음)이었습니다.
  it.fails("좁은 화면 — 같은 기관 줄의 대화상자 이름에 ' · CUSIP …'", async () => {
    const rows = await openHolders();
    fireEvent.click(rows[2]);
    expect(await screen.findByRole("dialog", { name: "합성 자산운용 (Synthetic Asset) · CUSIP 000000204" })).toBeTruthy();
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 1·3번 줄의 보조 글이 둘 다 'SYNTHETIC ALPHA INC · 2026-06-30'이었습니다.
  it.fails("목록 — 같은 기관 줄의 보조 글에 CUSIP, 겹치지 않는 기관 줄에는 없음", async () => {
    const rows = await openHolders();
    expect(rows[0].textContent).toContain("SYNTHETIC ALPHA INC · CUSIP 000000105 · 2026-06-30");
    expect(rows[2].textContent).toContain("SYNTHETIC ALPHA INC · CUSIP 000000204 · 2026-06-30");
    expect(rows[1].textContent).toContain("SYNTHETIC ALPHA INC CLASS A · 2026-06-30");
    expect(rows[1].textContent).not.toContain("CUSIP");
    expect(rows[3].textContent).not.toContain("CUSIP");
  });
});
