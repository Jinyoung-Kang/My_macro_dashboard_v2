/**
 * 정보 검색 대상 화면에서 누른 단추가 사라질 때의 포커스(QA-430 — WCAG 2.4.3). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * 미리 보기는 창 폭마다 자리(xl 미만은 아래 시트, xl은 오른쪽 칸)만 다르고 닫는 동작은 같으므로 jsdom에서 한 번에 봅니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [],
  sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline",
  items: [row({ id: "r1", title: "첫째 기사" }), row({ id: "r2", title: "둘째 기사", publishedAt: "2026-11-13T10:00:00+00:00" })],
  sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 2, dropped: null, message: null }],
  window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 2, "30d": 2, "1y": 2, "2y": 2 },
  olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

function renderScreen(path: string) {
  setLocation(path);
  return render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

beforeEach(() => {
  reads = {};
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
});
afterEach(() => cleanup());

/** 결과 목록에 포커스를 두고 Home으로 첫 줄을 골라 미리 보기를 엽니다(QA 확인의 순서). */
async function openFirstPreview() {
  renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
  const list = await screen.findByRole("listbox", { name: "결과" });
  list.focus();
  fireEvent.keyDown(list, { key: "Home" });
  const first = within(list).getAllByRole("option")[0];
  expect(first.getAttribute("aria-selected")).toBe("true");
  const preview = screen.getByRole("region", { name: "미리 보기" });
  return { list, first, preview };
}

describe("QA-430 — 미리 보기 닫기 단추로 닫으면 포커스가 결과 목록으로 간다(Escape와 같은 자리)", () => {
  // QA-430: 정보 검색 QA 스택 브라우저 확인(1024·390 아래 시트, 1440 오른쪽 칸)에서 '미리 보기 닫기'를 키보드(Enter)·마우스로 누르면 단추가
  // 미리 보기째 DOM에서 사라지고 document.activeElement가 BODY가 됐습니다. 다음 Tab은 같은 자리에 새로 생긴 속성 칸의 '별칭 편집'으로 갔고,
  // Escape로 닫으면 포커스가 결과 목록에 남아 두 닫기의 결과가 달랐습니다(WCAG 2.4.3). 브라우저는 단추 위 Enter·Space를 click으로 바꾸고
  // 마우스로 누르면 단추에 포커스가 먼저 가므로, 포커스를 둔 뒤 click으로 누릅니다. 목록은 페이지가 튀지 않게 preventScroll로 받습니다.
  // 수정 전 실패: document.activeElement가 결과 목록이 아니라 body.
  it("닫기 단추를 누르면 미리 보기가 닫히고 포커스는 결과 목록(preventScroll) — ↓가 그 목록에서 이어 간다", async () => {
    const { list, preview } = await openFirstPreview();
    const focus = vi.spyOn(list, "focus");
    const close = within(preview).getByRole("button", { name: "미리 보기 닫기" });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    // 포커스가 목록에 있으므로 ↓가 곧바로 첫 줄을 다시 고릅니다(Escape로 닫은 뒤와 같음).
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Escape로 닫아도 포커스는 결과 목록에 그대로 — 두 닫기의 자리가 같다", async () => {
    const { list } = await openFirstPreview();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
  });
});
