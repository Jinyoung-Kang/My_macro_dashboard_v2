/**
 * 정보 검색 대상 화면의 빵부스러기 대상 칸 — QA-861(P3 QA '넘긴 것': `/search?e=…`의 빵부스러기가 '정보 검색' 한 칸뿐, 명세 §5 '메뉴 › 하위 화면 › 대상').
 *
 * 넓은 화면 상단바의 빵부스러기(lib/breadcrumbs — 주소의 경로만 봄)는 대상을 연 정보 검색에서도 '정보 검색' 한 칸이었고, 브라우저 탭 제목에도 대상 이름이
 * 없었습니다(상세 세 화면은 P4부터 '… › 이름'·'이름 · 메뉴 · 앱'). 기대: 대상 화면이 대상 이름을 읽은 뒤(GET /api/search/entity — 이미 부르는 요청)
 * 빵부스러기가 '정보 검색(→ /search) › 엔비디아'가 되고(마지막 칸은 지금 화면), 탭 제목 앞 이름도 같습니다(entityCrumbLabel). 대상을 떠나면(후보 보기·
 * 첫 화면) 칸이 사라집니다. 셸 레이아웃·빵부스러기는 주소 쿼리(useSearchParams)를 읽지 않습니다 — 모든 화면의 정적 그리기를 바꾸지 않게 대상 화면이
 * 이름을 넘깁니다(hooks/useEntityCrumb, 주소는 '/search'). lib/nav.ts는 그대로입니다. 응답은 합성 값입니다.
 * 수정 전(재현 커밋에서는 앞 두 사례 it.fails): 함수 "expected [ { label: '정보 검색', href: '/search' } ] to deeply equal [ { label: '정보 검색', …(1) }, …(1) ]",
 * 화면 "expected [ '정보 검색' ] to deeply equal [ '정보 검색', '엔비디아' ]". 셋째 사례(쿼리를 읽지 않음)는 그때도 통과합니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { Breadcrumbs } from "@/components/shell/Breadcrumbs";
import { resetEntityCrumbForTest, useEntityCrumbLabel } from "@/hooks/useEntityCrumb";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { breadcrumbs, entityCrumbLabel } from "@/lib/breadcrumbs";
import { endpoints } from "@/lib/endpoints";
import { documentTitle } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: [], description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null }, links: [], sources: ["sec"],
};
const SRC = resolve(__dirname, "../../../..");

let entity: { resolve: (body: unknown) => void } | null = null;
beforeEach(() => {
  entity = null;
  for (const fn of [api.apiGet, api.apiGetShared]) {
    fn.mockReset();
    fn.mockImplementation((path: string) =>
      path === endpoints.search.entity("us:NVDA") ? new Promise((resolve) => (entity = { resolve })) : new Promise(() => {}),
    );
  }
});
afterEach(() => {
  cleanup();
  act(() => resetEntityCrumbForTest());
});

/** 셸이 탭 제목에 쓰는 글 — 레이아웃(useDocumentTitle)과 같은 계산. */
function TitleProbe() {
  const crumb = useEntityCrumbLabel();
  return <output aria-label="탭 제목">{documentTitle("/search", entityCrumbLabel("/search", crumb))}</output>;
}

const crumbTexts = () =>
  within(screen.getByRole("navigation", { name: "현재 위치" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent?.replace("›", "").trim());

describe("정보 검색 대상 화면의 빵부스러기 대상 칸(QA-861)", () => {
  it.fails("빵부스러기 함수 — 정보 검색에서 넘겨받은 이름('/search')이 마지막 칸, 첫 칸 '정보 검색'은 첫 화면 링크. 이름이 없거나 다른 주소면 한 칸", () => {
    expect(breadcrumbs("/search", MEMBER, { href: "/search", label: " 엔비디아 " })).toEqual([
      { label: "정보 검색", href: "/search" },
      { label: "엔비디아", href: null },
    ]);
    expect(entityCrumbLabel("/search", { href: "/search", label: "엔비디아" })).toBe("엔비디아");
    for (const other of [null, undefined, { href: "/s/us/NVDA", label: "엔비디아" }, { href: "/search", label: "  " }]) {
      expect(breadcrumbs("/search", MEMBER, other)).toEqual([{ label: "정보 검색", href: "/search" }]);
      expect(entityCrumbLabel("/search", other)).toBeNull();
    }
  });

  it.fails("대상 이름을 읽으면 '정보 검색 › 엔비디아'·탭 제목 앞 이름, 대상을 떠나면 칸이 사라진다", async () => {
    setLocation("/search?e=us:NVDA");
    render(
      <SessionUserProvider user={MEMBER}>
        <Breadcrumbs pathname="/search" user={MEMBER} />
        <TitleProbe />
        <SearchScreen />
      </SessionUserProvider>,
    );
    // 이름을 받기 전에는 '정보 검색' 한 칸(지금 화면).
    expect(crumbTexts()).toEqual(["정보 검색"]);
    await act(async () => entity?.resolve({ available: true, entity: NVIDIA, errors: {} }));
    expect(crumbTexts()).toEqual(["정보 검색", "엔비디아"]);
    const nav = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(nav).getByRole("link", { name: "정보 검색" }).getAttribute("href")).toBe("/search");
    expect(within(nav).getByText("엔비디아").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("status", { name: "탭 제목" }).textContent).toBe("엔비디아 · 정보 검색 · 매크로 대시보드");

    // 대상을 떠나 후보 보기로(주소 바꾸기) — 대상 칸이 사라집니다.
    await act(async () => window.history.pushState(null, "", "/search?q=NVIDIA"));
    expect(crumbTexts()).toEqual(["정보 검색"]);
    expect(screen.getByRole("status", { name: "탭 제목" }).textContent).toBe("정보 검색 · 매크로 대시보드");
  });

  it("셸 레이아웃·빵부스러기는 주소 쿼리를 읽지 않는다(useSearchParams 없음)", () => {
    for (const file of ["app/(dashboard)/layout.tsx", "components/shell/Breadcrumbs.tsx", "lib/breadcrumbs.ts"]) {
      expect(readFileSync(resolve(SRC, file), "utf8"), file).not.toMatch(/useSearchParams/);
    }
  });
});
