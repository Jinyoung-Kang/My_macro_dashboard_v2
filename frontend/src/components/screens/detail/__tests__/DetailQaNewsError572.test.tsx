/**
 * QA-572: 상세 화면 '뉴스' 탭(공용 NewsCard)에서 출처가 모두 실패하면 같은 오류 문장이 두 번 나왔습니다 — 본문이 수집기의 news.error(출처별 사유를 '; '로
 * 이은 글)를 적고, 그 아래 실패 줄이 같은 errors를 '일부 출처를 받지 못했습니다 — …'로 또 적었습니다. 모두 실패했는데 '일부'라고 쓰기도 했습니다
 * (QA 스택 /markets/i/us10y 1440 — 연합인포맥스·Google News 모두 ProxyError, /s/kr/005930 390 — 네이버 증권). 응답은 모두 합성 값입니다.
 *
 * 고친 뒤: 항목이 0건이라 본문이 news.error를 적었으면 실패 줄을 생략합니다(사유는 본문에 한 번). 일부만 실패하고 항목이 있으면 실패 줄은 그대로입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { NewsCard } from "../DetailParts";

const PATH = "/api/detail/news?q=synthetic";
let body: unknown = null;

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path === PATH ? Promise.resolve(body) : new Promise(() => {})));
});
afterEach(cleanup);

describe("QA-572 뉴스 — 출처가 모두 실패하면 사유를 한 번만", () => {
  // 수정 전 실패: '연합인포맥스: ProxyError — 합성'이 본문과 실패 줄에 두 번(2), '일부 출처를 받지 못했습니다' 줄이 있음(재현 커밋에서는 it.fails).
  it("항목 0건 + 출처 둘 다 실패 — 본문에 출처 이름이 붙은 사유가 한 번, '일부 출처' 줄은 없다", async () => {
    body = {
      available: true,
      news: {
        items: [],
        errors: { 연합인포맥스: "ProxyError — 합성", "Google News": "ProxyError — 합성" },
        error: "연합인포맥스: ProxyError — 합성; Google News: ProxyError — 합성",
        fetchedAt: "2026-11-15T00:00:00Z",
      },
    };
    render(<NewsCard path={PATH} />);
    expect(await screen.findByText("연합인포맥스: ProxyError — 합성; Google News: ProxyError — 합성")).toBeTruthy();
    expect(screen.getAllByText(/연합인포맥스: ProxyError — 합성/)).toHaveLength(1);
    expect(screen.queryByText(/일부 출처를 받지 못했습니다/)).toBeNull();
  });

  it("일부만 실패하고 항목이 있으면 실패 줄은 그대로 — '일부 출처를 받지 못했습니다 — 출처: 사유'", async () => {
    body = {
      available: true,
      news: {
        items: [{ title: "합성 기사", url: "https://news.example/a", publisher: "Example Wire", publishedAt: null, source: "Google News" }],
        errors: { "네이버 증권": "HTTP 503" },
        error: null,
        fetchedAt: "2026-11-15T00:00:00Z",
      },
    };
    render(<NewsCard path={PATH} />);
    expect(await screen.findByRole("link", { name: /합성 기사/ })).toBeTruthy();
    expect(screen.getByText("일부 출처를 받지 못했습니다 — 네이버 증권: HTTP 503")).toBeTruthy();
  });

  it("항목 0건인데 실패가 없으면(출처는 됐지만 기사가 없음) 기본 글만", async () => {
    body = { available: true, news: { items: [], errors: {}, error: null, fetchedAt: "2026-11-15T00:00:00Z" } };
    render(<NewsCard path={PATH} />);
    expect(await screen.findByText("최근 뉴스를 찾지 못했습니다.")).toBeTruthy();
    expect(screen.queryByText(/일부 출처를 받지 못했습니다/)).toBeNull();
  });
});
