/**
 * AI 요약·AI 리포트 결과의 오늘 사용량 꼬리 — 하루 상한이 없을 때(운영자, quota.limit = null)의 글(QA-456). 응답은 모두 합성 값입니다(가상 종목).
 *
 * 상한이 없으면 'used/limit건' 꼴에 '무제한'을 끼워 '오늘 1/무제한건'이 되었습니다(종목 상세 AI 요약 카드 — 운영 화면 확인). 같은 꼴을 쓰는 AI 리포트
 * 결과 카드(lib/aiEngines quotaLabel)도 같은 글이었습니다. 두 곳 모두 '오늘 N건(상한 없음)'으로, 상한이 있으면 그대로 'N/M건'입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { quotaLabel } from "@/lib/aiEngines";
import { endpoints } from "@/lib/endpoints";
import type { DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { StockDetailScreen } from "../StockDetailScreen";

const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const QUOTE: DetailQuote = {
  market: "us", code: "SYNQ", yahooSymbol: "SYNQ", name: "Synthetic Quota Labs", exchange: "NYSE", currency: "USD", kind: "ETF",
  price: 10, previousClose: 10, change: 0, changePct: 0, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNQ" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

let quota: { used: number; limit: number | null } = { used: 1, limit: null };

beforeEach(() => {
  quota = { used: 1, limit: null };
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.detail.quote("us", "SYNQ") ? Promise.resolve({ available: true, quote: QUOTE }) : new Promise(() => {}),
  );
  api.apiPost.mockImplementation(() =>
    Promise.resolve({ status: true, summary: "한 줄 요약: 합성 요약", model: "test-model", generatedAtKst: "2026-11-15 09:00 KST", cached: false, sources: [], quota, error: null }),
  );
});
afterEach(cleanup);

async function footer(): Promise<string> {
  render(
    <SessionUserProvider user={OWNER}>
      <StockDetailScreen market="us" code="SYNQ" />
    </SessionUserProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Synthetic Quota Labs" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "AI 요약 만들기" }));
  });
  const card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
  return within(card).getByText(/^test-model · /).textContent ?? "";
}

describe("오늘 사용량 꼬리 — 하루 상한이 없을 때(QA-456)", () => {
  // QA-456: quota.limit이 null이면 `오늘 ${used}/${limit ?? "무제한"}건`이 '오늘 1/무제한건'이 되었습니다.
  // 수정 전 실패: 꼬리가 '… · 오늘 1/무제한건'(재현 커밋에서는 it.fails).
  it.fails("종목 상세 AI 요약 카드 — '오늘 1건(상한 없음)', 상한이 있으면 '오늘 2/20건'", async () => {
    expect(await footer()).toBe("test-model · 2026-11-15 09:00 KST · 오늘 1건(상한 없음)");
    cleanup();
    quota = { used: 2, limit: 20 };
    expect(await footer()).toBe("test-model · 2026-11-15 09:00 KST · 오늘 2/20건");
  });

  // 수정 전 실패: quotaLabel({ used: 9, limit: null })이 '오늘 9/무제한건'(재현 커밋에서는 it.fails).
  it.fails("AI 리포트 결과 카드의 사용량(quotaLabel)도 같은 글 — 데모 공용 한도의 '데모 전체'는 그대로", () => {
    expect(quotaLabel({ used: 9, limit: null })).toBe("오늘 9건(상한 없음)");
    expect(quotaLabel({ used: 4, limit: 20 })).toBe("오늘 4/20건");
    expect(quotaLabel({ used: 4, limit: 20, shared: true })).toBe("데모 전체 오늘 4/20건");
  });
});
