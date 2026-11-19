/**
 * 정보 검색 범위 장치를 걷어 낸 뒤(작업대 P7 — 명세 §4 끝·§7 9행, ADR 0042 결정 2). 개편 전 이 화면만 늘 어둡게 그리던 장치(globals.css의
 * [data-scope="search"] 토큰 블록과 base 층 바탕·글자색, ui/Dialog의 scope prop·DialogScope 문맥, SearchScreen의 표지와 감쌈)는 P1 뒤 값이 :root와
 * 같아져 겉모습을 바꾸지 않는 짐이었습니다. 걷어 낸 뒤의 겉모습이 같다는 것은 두 빌드의 브라우저 캡처·계산 스타일 대조로 확인했고(커밋 본문), 여기서는
 *  - 제품 소스(시험 밖)에 data-scope·DialogScope 글이 없고,
 *  - 정보 검색 뿌리 상자가 base 층이 칠하던 바탕·글자색을 유틸리티(bg-bg text-text)로 칠하며,
 *  - 이 화면에서 연 대화상자(수집 글 원문 팝업)가 다른 화면에서 연 같은 대화상자와 속성·클래스가 같음(범위 표지 없음)을 봅니다.
 * 응답은 합성 값입니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { ReaderDialog } from "@/components/screens/info/ReaderDialog";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { readerOfFeedItem } from "@/lib/infoSearch";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const SRC = resolve(__dirname, "../../../..");
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const POST: SearchFeedItem = {
  id: "p1", kind: "post", title: "수집 글 하나", url: "https://blog.example/post", publisher: "합성 블로그", publisherDomain: null,
  publishedAt: "2026-11-12T01:00:00+00:00", timeBasis: "published", source: "info", lang: "ko", summary: null, readerId: "0123456789abcdef01234567",
};

let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

/** 제품 소스(.ts·.tsx·.css — __tests__·__checks__ 밖) 파일 목록. */
function productFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "__checks__" ? [] : productFiles(full);
    return /\.(?:tsx?|css)$/.test(name) ? [full] : [];
  });
}

beforeEach(() => {
  reads = {};
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => cleanup());

describe("정보 검색 범위 장치를 걷어 낸 뒤", () => {
  it("제품 소스에 data-scope·DialogScope 글이 없다(시험 밖)", () => {
    const found = productFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return /data-scope|DialogScope/.test(text) ? [relative(SRC, file)] : [];
    });
    expect(found).toEqual([]);
  });

  it("뿌리 상자는 바탕·글자색을 유틸리티로 칠한다(bg-bg text-text) — 범위 표지 없음", () => {
    setLocation("/search");
    const { container } = render(
      <SessionUserProvider user={OWNER}>
        <SearchScreen />
      </SessionUserProvider>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe("flex flex-col gap-4 rounded-card border border-border p-3 sm:p-4 lg:p-5 bg-bg text-text");
    expect(root.hasAttribute("data-scope")).toBe(false);
  });

  it("이 화면에서 연 원문 팝업은 다른 화면에서 연 같은 팝업과 속성·클래스가 같다(data-scope 없음)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: null };
    reads[endpoints.search.feed("us:NVDA", "posts")] = {
      available: true, entityKey: "us:NVDA", tab: "posts", items: [POST], sources: [], window: { from: "2024-11-14", to: "2026-11-14" },
      rangeCounts: { "7d": 1, "30d": 1, "1y": 1, "2y": 1 }, olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
    };
    reads[endpoints.info.item(POST.readerId as string)] = { found: true, item: { id: POST.readerId, body: "받아 둔 본문", summary: null } };
    setLocation("/search?e=us:NVDA&tab=posts");
    render(
      <SessionUserProvider user={OWNER}>
        <SearchScreen />
      </SessionUserProvider>,
    );
    fireEvent.click(await screen.findByRole("option", { name: /수집 글 하나/ }));
    fireEvent.click(screen.getByRole("button", { name: /본문 보기/ }));
    const inSearch = await screen.findByRole("dialog", { name: "수집 글 하나" });
    const searchAttrs = [...inSearch.attributes].map((attr) => attr.name).filter((name) => !/^(?:id|aria-describedby|aria-labelledby)$/.test(name)).sort();
    const searchClass = inSearch.className;
    expect(inSearch.hasAttribute("data-scope")).toBe(false);
    cleanup();

    // 같은 팝업을 정보 검색 화면 밖에서 엽니다(정보 수집 화면이 쓰는 그대로).
    render(<ReaderDialog entry={readerOfFeedItem(POST, "합성 블로그")} onClose={() => {}} />);
    const outside = await screen.findByRole("dialog", { name: "수집 글 하나" });
    const outsideAttrs = [...outside.attributes].map((attr) => attr.name).filter((name) => !/^(?:id|aria-describedby|aria-labelledby)$/.test(name)).sort();
    expect(searchAttrs).toEqual(outsideAttrs);
    expect(searchClass).toBe(outside.className);
  });
});
