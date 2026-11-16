/**
 * QA-568 검토: 공용 글 부품에 낱말 단위 줄바꿈(break-keep)을 둔 수정이 같은 공용 상세 부품의 뉴스 카드(NewsCard) 본문 글을 빠뜨렸습니다 — 출처를 모두
 * 받지 못했을 때 사유를 적는 본문(QA-572 뒤로는 사유가 이 한 곳에만 나옴)·뉴스를 조회하지 않는 까닭·부를 수 없는 까닭(idleText)·일부 출처 실패 줄이
 * 세 상세 화면의 뉴스 탭에서 한글 낱말 가운데서 끊겼습니다(QA 스택 fcbb4861 /markets/i/us10y 1280 '막았습|니다'·'회사망·보|안'·'설|정 확인',
 * 1024 '보안 프로|그램', /s/kr/005930 390 '막았습|니다'·'설정 확|인' — 모두 뉴스 본문 p).
 *
 * 고친 뒤: 그 네 글이 낱말 사이에서만 줄을 바꾸고(break-keep), 사유에 섞이는 공백 없는 긴 영문 토큰('ProxyError' 등)만 칸 안에서 꺾습니다
 * (wrap-break-word — 출처 줄·배지와 같은 비상 꺾기). jsdom은 배치를 재지 못하므로 클래스를 대조하고, 실제 줄바꿈은 브라우저 하네스로 잽니다.
 * 응답은 모두 합성 값입니다.
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
const REASON = "ProxyError — 프록시가 연결을 막았습니다. 회사망·보안 프로그램의 설정 확인이 필요합니다(합성)";
let body: unknown = null;

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path === PATH ? Promise.resolve(body) : new Promise(() => {})));
});
afterEach(cleanup);

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 글 요소에서 문단(p)까지 올라가며 cls가 있는지 — word-break·overflow-wrap은 상속되므로 문단이나 그 안 어디에 있어도 됩니다. */
function paragraphHas(text: Element, cls: string): boolean {
  for (let node: Element | null = text; node; node = node.parentElement) {
    if (tokens(node).includes(cls)) return true;
    if (node.tagName === "P") break;
  }
  return false;
}

/** 네 상태를 차례로 그려 자리 이름 → 한글 글 요소의 [break-keep, wrap-break-word] 여부. */
async function places(): Promise<Record<string, [boolean, boolean]>> {
  const found: Record<string, [boolean, boolean]> = {};
  const check = (name: string, text: Element) => {
    found[name] = [paragraphHas(text, "break-keep"), paragraphHas(text, "wrap-break-word")];
  };

  const idle = render(<NewsCard path={null} idleText="검색어로 쓸 회사 이름을 받지 못해 뉴스를 부르지 않습니다." />);
  check("부를 수 없는 까닭(idleText)", screen.getByText("검색어로 쓸 회사 이름을 받지 못해 뉴스를 부르지 않습니다."));
  idle.unmount();

  body = { available: false, message: "store_only 모드에서는 뉴스를 조회하지 않습니다(합성).", news: null };
  const unavailable = render(<NewsCard path={PATH} />);
  check("조회하지 않는 까닭(!available)", await screen.findByText("store_only 모드에서는 뉴스를 조회하지 않습니다(합성)."));
  unavailable.unmount();

  body = {
    available: true,
    news: { items: [], errors: { 연합인포맥스: REASON, "Google News": REASON }, error: `연합인포맥스: ${REASON}; Google News: ${REASON}`, fetchedAt: null },
  };
  const allFailed = render(<NewsCard path={PATH} />);
  check("모두 실패한 사유(본문)", await screen.findByText(`연합인포맥스: ${REASON}; Google News: ${REASON}`));
  allFailed.unmount();

  body = {
    available: true,
    news: {
      items: [{ title: "합성 기사", url: "https://news.example/a", publisher: "Example Wire", publishedAt: null, source: "Google News" }],
      errors: { "네이버 증권": REASON },
      error: null,
      fetchedAt: null,
    },
  };
  render(<NewsCard path={PATH} />);
  check("일부 출처 실패 줄", await screen.findByText(`일부 출처를 받지 못했습니다 — 네이버 증권: ${REASON}`));
  return found;
}

describe("QA-568 검토 — 뉴스 카드 본문 글도 한글은 낱말 사이에서만 줄바꿈", () => {
  // 수정 전 실패: 네 자리 모두 [false, false](재현 커밋에서는 it.fails).
  it("부를 수 없는 까닭·조회하지 않는 까닭·모두 실패한 사유·일부 출처 실패 줄이 break-keep과 wrap-break-word를 가진다", async () => {
    const found = await places();
    expect(found).toEqual({
      "부를 수 없는 까닭(idleText)": [true, true],
      "조회하지 않는 까닭(!available)": [true, true],
      "모두 실패한 사유(본문)": [true, true],
      "일부 출처 실패 줄": [true, true],
    });
  });
});
