/**
 * 홈 계좌 손익 표 '계좌' 칸 링크의 누르는 자리(QA-607). 응답은 모두 합성 값입니다.
 *
 * 계좌 이름 링크는 `span.flex.min-w-0.flex-col`(이름 링크 + 보조 줄 '종류 · 상태')의 바로 아래 자식입니다. 링크 클래스(TEXT_TARGET — inline-flex)여도
 * flex 항목은 부모의 align-items 기본값(늘림)을 받아, 링크 상자(누르는 자리·포커스 고리)가 이름 글이 아니라 열에서 넓은 쪽 — 보조 줄
 * '벤치마크 · 운용 중'(98px) — 까지 넓어졌습니다(QA 스택 1440 'SPY 계좌' 링크 98px · 글 60px, 글 오른쪽 빈 곳을 눌러도 이동). QA-582와 같은
 * 원인이라 같은 방법(링크 자신의 self-start)으로 고칩니다. jsdom은 배치를 재지 않으므로 클래스로 대조하고, 실제 폭은 브라우저로 잽니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";
import { book, paperOverview, paperStatus } from "@/lib/__tests__/homeFixtures";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { PaperPnlPanel } from "../PaperPnlPanel";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };

/** 운영과 같은 수의 미국 다섯 계좌(규칙 · Claude 둘 · 벤치마크 둘) — 줄마다 보조 줄(종류 · 상태)이 있습니다. */
function fiveBooks() {
  return {
    ...paperOverview(),
    books: [
      book({ code: "rules", kind: "RULES", label: "규칙 계좌" }),
      book({ code: "claude", kind: "CLAUDE", label: "Claude 계좌1", nav: 99967.28, returnPct: -0.03, positions: 9 }),
      book({ code: "claude2", kind: "CLAUDE", label: "Claude 계좌2", nav: 100012.5, returnPct: 0.01 }),
      book({ code: "bench_spy", kind: "BENCHMARK", label: "SPY 계좌", nav: 99950.22, benchmark: null }),
      book({ code: "bench_mix", kind: "BENCHMARK", label: "60/40 계좌", nav: 99950.39 }),
    ],
  };
}

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = { "/api/paper/overview": fiveBooks(), "/api/paper/status": paperStatus(false) };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("홈 계좌 손익 표의 계좌 이름 링크는 글 폭만 누르는 자리 (QA-607)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 다섯 링크 모두 self-start가 없어 보조 줄 폭까지 늘어났습니다.
  it.fails("다섯 계좌의 이름 링크마다 self-start — 감싼 열(flex-col)과 보조 줄은 그대로", async () => {
    render(
      <SessionUserProvider user={OWNER}>
        <PaperPnlPanel />
      </SessionUserProvider>,
    );
    const table = await screen.findByRole("table", { name: "모의매매 미국 계좌 손익" });
    const links = within(table).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["규칙 계좌", "Claude 계좌1", "Claude 계좌2", "SPY 계좌", "60/40 계좌"]);
    for (const link of links) {
      const column = link.parentElement as HTMLElement;
      expect(classes(column), link.textContent ?? "").toEqual(expect.arrayContaining(["flex", "flex-col"]));
      // 보조 줄(종류 · 상태)이 같은 열에 있어 링크가 늘어나면 그 폭이 됩니다.
      expect(column.children).toHaveLength(2);
      expect(classes(link), link.textContent ?? "").toContain("self-start");
    }
  });
});
