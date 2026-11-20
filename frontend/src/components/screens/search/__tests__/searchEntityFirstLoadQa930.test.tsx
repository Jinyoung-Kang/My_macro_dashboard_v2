/**
 * 정보 검색 대상 화면 첫 적재 자리 — QA-930(작업대 P8 U2에서 머리를 공용 패턴으로 옮기며 첫째·넷째 사례를 패턴의 줄 꼴로 고침)(결정 거리 `search-entity-first-load-cls` — D6 전 QA 스택 확인에서 감사·인증·정보 검색 갈래가 함께 냄, 개편 전부터).
 *
 * `/search?e=us:NVDA&tab=timeline&range=30d` 첫 적재 CLS 1024 0.3792·1440 0.136·390 0~0.51(응답 차례에 따라). 대상 머리(EntityParts EntityHeader)가 대상이
 * 풀리기 전에는 키 한 줄(`mt-1`·12px 글 16px)이다가 풀린 뒤 꼬리표 줄(`mt-2`·꼬리표 20px)과 '종목 상세' 바로가기(머리 오른쪽 묶음)를 그려 머리 아래 탭 줄·
 * 결과 패널을 밀었고, 결과(가운데 칸)는 읽는 중 한 줄(약 64px)에서 결과 목록으로 자라 그 아래(xl 미만은 속성 칸)를 밀었습니다.
 *
 * 기대(값이 온 뒤의 꼴로 자리 — QA-876·882·892와 같은 원칙): 대상이 풀리기 전 키 줄은 꼬리표 줄과 같은 위 여백·높이(`mt-2`·`min-h-5` = 꼬리표의
 * 글 16px + 위아래 1px + 테두리 2px), 키로 바로가기를 아는 대상(us:·kr: — 종목 상세, cik: — 기관 상세)은 대상 풀기 응답이 오기 전까지 머리 오른쪽 묶음에
 * 바로가기와 같은 꼴의 보이지 않는 자리(낭독·포커스 없음), 결과 읽는 중 자리는 화면 높이 이상(아래 칸을 첫 화면 밖에 — QA-892 순위와 같음).
 * 풀린 뒤의 겉모습·요청은 그대로입니다(넷째 사례 — 고치기 전에도 통과하는 지킴).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 'expected [ 'mt-1', … ] to include 'mt-2''(키 줄의 위 여백), 둘째 'expected null to be
 * truthy'(바로가기 자리 없음), 셋째 'expected [ 'min-w-0' ] to include 'min-h-dvh''(읽는 중 자리를 감싼 칸이 가운데 칸 그대로).
 */
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

import { TEXT_TARGET } from "@/components/ui/classes";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [],
  sources: ["sec", "wikidata"],
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
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

const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
/** 대상 머리 — 이름(h2)을 품은 header. */
const header = () => screen.getByRole("heading", { level: 2 }).closest("header") as HTMLElement;

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => cleanup());

describe("정보 검색 대상 화면 첫 적재 자리(QA-930)", () => {
  // 작업대 P8 U2 — 머리가 공용 패턴 EntityHeader라 식별자·별칭 태그는 이름 줄 안에 이어지고 따로 선 꼬리표 줄이 없습니다. 풀리기 전에는 이름 자리에
  // 키가 한 번만 보이고(예전의 키 줄 없음), 이름 줄 밖에 다른 줄이 없습니다(풀린 뒤에도 같음 — 넷째 사례).
  it("대상이 풀리기 전 키는 이름 자리에 한 번만 보이고 이름 줄 밖에 다른 줄이 없다", () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const heading = within(header()).getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("us:NVDA");
    expect(within(header()).getAllByText("us:NVDA")).toHaveLength(1);
    // 이름 줄(h2 + 종류 태그)이 글 칸의 유일한 줄.
    expect(heading.parentElement?.parentElement?.children).toHaveLength(1);
  });

  it("키로 바로가기를 아는 대상은 풀리기 전 머리 오른쪽에 바로가기와 같은 꼴의 보이지 않는 자리가 있다", () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const slot = within(header()).queryByText("종목 상세")?.closest("[aria-hidden='true']") ?? null;
    expect(slot).toBeTruthy();
    expect(tokens(slot)).toContain("invisible");
    // 링크와 같은 누름 자리 높이(좁은 화면 44px) — 링크가 아니므로 포커스·낭독 없음.
    for (const token of TEXT_TARGET.split(" ")) expect(tokens(slot)).toContain(token);
    expect(within(header()).queryByRole("link")).toBeNull();
    expect(within(header()).queryByRole("navigation")).toBeNull();
    // 기관(cik:)은 '기관 상세', 주제는 자리 없음.
    cleanup();
    renderScreen("/search?e=cik:0001067983&tab=timeline&range=30d");
    expect(within(header()).queryByText("기관 상세")?.closest("[aria-hidden='true']")).toBeTruthy();
    cleanup();
    renderScreen("/search?e=topic:%EA%B8%88%EB%A6%AC&tab=timeline&range=30d");
    expect(within(header()).queryByText(/상세/)).toBeNull();
  });

  it("결과를 받기 전 가운데 칸의 읽는 중 자리는 화면 높이 이상이다", () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const loading = screen.getByText(/결과를 모으는 중/).parentElement;
    expect(tokens(loading)).toContain("min-h-dvh");
  });

  it("풀린 뒤에는 이름 줄의 식별자 태그와 '종목 상세' 링크만 — 보이지 않는 자리가 남지 않는다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    await act(async () => {});
    await act(async () => {});
    const head = header();
    expect(within(head).getByRole("heading", { level: 2 }).textContent).toBe("엔비디아");
    // 식별자는 이름 줄 안의 고정폭 태그(패턴), 따로 선 꼬리표 줄 없음.
    const chip = within(head).getByText("NVDA · 미국");
    expect(tokens(chip)).toContain("font-mono");
    const heading = within(head).getByRole("heading", { level: 2 });
    expect(chip.closest(".flex-wrap")).toBe(heading.parentElement);
    expect(heading.parentElement?.parentElement?.children).toHaveLength(1);
    expect(within(head).queryByText("us:NVDA")).toBeNull();
    const nav = within(head).getByRole("navigation", { name: "바로가기" });
    expect(within(nav).getByRole("link", { name: "종목 상세" })).toBeTruthy();
    expect(head.querySelector("[aria-hidden='true'].invisible")).toBeNull();
  });
});
