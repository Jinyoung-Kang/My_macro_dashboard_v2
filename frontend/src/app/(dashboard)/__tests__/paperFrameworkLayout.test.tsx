/**
 * 모의 매매 — 프레임 탭 재배치(작업대 P6, 명세 §7-1 '프레임'): 목차(SectionIndex 2xl — 지금 판(하위 칸 = 렌더링 머리 절) · 제안 요청 · 제안 · 판 이력 · 두 판
 * 비교 · 직접 고치기), 렌더링 글을 펼친 본문(머리 절마다 닻 — 더 깊은 절은 그 닻 안), 제안 목록 기본 접힘(고른 제안만 검사 칸·대화상자), 주간 복기에서 연
 * 제안(focusProposalId)은 그 제안을 고르고 제안 절로 스크롤, 판 이력 검사 칸. 값은 모두 합성 값입니다.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { FrameworkSection } from "@/components/screens/paper/FrameworkSection";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

/** QA 스택 v1과 같은 꼴 — 제목(#) 하나, 절(##) 셋, 엔진 머리(###) 둘. */
const RENDERED = [
  "# 투자 OS — v2 (합성 판)",
  "",
  "## 원칙",
  "1. 패킷의 숫자에서 출발한다.",
  "## 엔진",
  "### E1. 시장관",
  "- E1-R1 세 축으로 노출을 정한다.",
  "### E2. 인과관계",
  "- E2-R1 원인과 결과를 나눈다.",
  "## 출력(고정)",
  "JSON 하나만 낸다.",
].join("\n");

const BODY = { schemaVersion: 1, title: "합성 판", status: "USER", principles: [{ id: "P1", text: "패킷의 숫자에서 출발한다." }], engines: [], guidance: "" };
const V2 = {
  version: 2, status: "USER", title: "합성 판", body: BODY, rendered: RENDERED, tokensEst: 3600, overBudget: false,
  changelog: "제안 #4 승인", createdAtKst: "2026-11-01 09:00 KST",
};
const VERSIONS = [
  { version: 2, title: "합성 판", changelog: "제안 #4 승인", createdAtKst: "2026-11-01 09:00 KST", sourceProposalId: 4, status: "USER", tokensEst: 3600 },
  { version: 1, title: "투자 OS", changelog: "OS 원문 옮김", createdAtKst: "2026-10-25 02:37 KST", sourceProposalId: null, status: "USER", tokensEst: 3552 },
];

function proposal(id: number, status: string, baseVersion: number) {
  return {
    id, status, noteId: 10, model: "claude-sonnet-5-5", summary: `제안 ${id}의 요약 첫 줄\n둘째 줄`, operations: [], assessment: [],
    beforeAfter: null, error: null, createdAtKst: "2026-11-01 08:00 KST", decidedAtKst: null, resultVersion: null, baseVersion,
  };
}

let reads: Record<string, () => Promise<unknown>> = {};
const calls = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);

beforeEach(() => {
  reads = {
    "/api/paper/framework": () => Promise.resolve({ available: true, current: V2, versions: VERSIONS }),
    "/api/paper/framework/proposals": () =>
      Promise.resolve({ available: true, proposals: [proposal(5, "PENDING", 2), proposal(4, "APPROVED", 0), proposal(3, "REJECTED", 0)] }),
    "/api/paper/settings": () => Promise.resolve({ available: true, version: 2, body: { frameworkTokenBudget: 50000 }, defaults: {}, keys: [] }),
    "/api/paper/notes?includeExpired=false": () => Promise.resolve({ available: true, notes: [] }),
    "/api/paper/notes?includeExpired=false&market=KR": () => Promise.resolve({ available: true, market: "KR", notes: [] }),
    "/api/paper/framework/versions/2": () => Promise.resolve({ available: true, version: V2 }),
    "/api/paper/framework/versions/1": () => Promise.resolve({ available: true, version: { ...V2, version: 1, title: "투자 OS", rendered: "# 투자 OS — v1" } }),
  };
  window.history.replaceState(null, "", "/paper/us/framework");
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (reads[path] ? reads[path]() : new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

describe("프레임 탭 재배치 — 목차·본문", () => {
  it("목차: 지금 판(하위 칸 = 두 번 이상 나오는 머리 단계 ##)·제안 요청·제안·판 이력·두 판 비교·직접 고치기, 더 깊은 절(###)은 그 ## 닻 안", async () => {
    render(<FrameworkSection />);
    const nav = await screen.findByRole("navigation", { name: "프레임 목차" });
    const [strip, column] = Array.from(nav.querySelectorAll<HTMLElement>(":scope > ul"));
    await waitFor(() => expect(within(strip).getByRole("link", { name: "제안 (3)" })).toBeTruthy());
    expect(within(strip).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "#paper-frame-current", "#paper-frame-request", "#paper-frame-proposals", "#paper-frame-versions", "#paper-frame-compare", "#paper-frame-edit",
    ]);
    expect(within(column).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["지금 판", "#paper-frame-current"],
      ["원칙", "#paper-frame-section-1"],
      ["엔진", "#paper-frame-section-2"],
      ["출력(고정)", "#paper-frame-section-5"],
      ["제안 요청", "#paper-frame-request"],
      ["제안 (3)3", "#paper-frame-proposals"],
      ["판 이력 (2)2", "#paper-frame-versions"],
      ["두 판 비교", "#paper-frame-compare"],
      ["직접 고치기", "#paper-frame-edit"],
    ]);
    // 엔진(##) 닻 안에 E1·E2(###) 제목, 제목(#)은 지금 판 닻 안 하위 닻 밖.
    const engine = document.getElementById("paper-frame-section-2") as HTMLElement;
    expect(within(engine).getAllByRole("heading").map((heading) => [heading.tagName, heading.textContent])).toEqual([
      ["H4", "엔진"], ["H5", "E1. 시장관"], ["H5", "E2. 인과관계"],
    ]);
    const title = screen.getByRole("heading", { level: 3, name: "투자 OS — v2 (합성 판)" });
    expect(title.closest("#paper-frame-current")).not.toBeNull();
    expect(title.closest("[id^='paper-frame-section-']")).toBeNull();
    // 본문은 긴 글 글자(running)·서버 글 그대로(줄바꿈 유지).
    expect(within(engine).getByText("- E1-R1 세 축으로 노출을 정한다.").className).toContain("text-running");
  });

  it("새로 고친 주소의 #절(렌더링 머리 절)로 맞춤", async () => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-section-5");
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    render(<FrameworkSection />);
    await waitFor(() => expect(scrolled).toContain("paper-frame-section-5"));
  });
});

describe("프레임 탭 재배치 — 제안 기본 접힘", () => {
  it("넓은 화면: 처음은 목록 줄만('#번호 상태 요약 첫 줄') — 고르기 전에는 제안 상세·기준 판 읽기가 없고, 고르면 넓은 검사 칸에 그 제안", async () => {
    stubWide();
    render(<FrameworkSection />);
    const list = await screen.findByRole("list", { name: "제안 목록" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "#5 승인 대기 제안 5의 요약 첫 줄", "#4 승인 제안 4의 요약 첫 줄", "#3 거절 제안 3의 요약 첫 줄",
    ]);
    const panel = screen.getByRole("region", { name: "제안 목록 — 고른 줄 없음" });
    expect(within(panel).queryByRole("article")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    // 두 판 비교는 v2·v1을 읽고(예전 그대로), 결정된 제안의 기준 판 v0은 고를 때까지 읽지 않습니다.
    expect(calls().filter((path) => path === "/api/paper/framework/versions/0")).toHaveLength(0);

    act(() => within(list).getByRole("button", { name: /^#4 / }).click());
    const shown = screen.getByRole("region", { name: "제안 목록 — 제안 #4" });
    expect(within(shown).getByRole("heading", { name: "제안 #4" })).toBeTruthy();
    expect(within(shown).getByRole("article", { name: "제안 #4" })).toBeTruthy();
    // 제안 상자는 검사 칸 틀이 맡아 제 테두리·제목을 그리지 않습니다(같은 제목이 두 번 나오지 않게).
    expect(within(shown).getAllByRole("heading", { name: "제안 #4" })).toHaveLength(1);
    await waitFor(() => expect(calls().filter((path) => path === "/api/paper/framework/versions/0")).toHaveLength(1));
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("주간 복기에서 연 제안: 좁은 화면이면 그 제안의 대화상자를 열고(제목 포커스) '주간 복기에서 연 제안'·aria-current, 제안 절로 스크롤", async () => {
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    render(<FrameworkSection focusProposalId={4} />);
    const dialog = await screen.findByRole("dialog", { name: "제안 #4" });
    const article = within(dialog).getByRole("article", { name: "제안 #4" });
    expect(article.getAttribute("aria-current")).toBe("true");
    expect(within(article).getByText("주간 복기에서 연 제안")).toBeTruthy();
    // 잉크 2px 테두리는 지움(검사 칸·대화상자 틀이 맡음) — 뜻은 글과 aria-current.
    expect(article.className).not.toContain("ring-1");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("제안 #4"));
    await waitFor(() => expect(scrolled).toContain("paper-frame-proposals"));
  });

  it("주간 복기에서 연 제안: 넓은 화면이면 검사 칸에 그 제안(대화상자 없음)", async () => {
    stubWide();
    render(<FrameworkSection focusProposalId={3} />);
    const shown = await screen.findByRole("region", { name: "제안 목록 — 제안 #3" });
    expect(within(shown).getByText("주간 복기에서 연 제안")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("프레임 탭 재배치 — 판 이력", () => {
  it("넓은 화면: 판을 고르면 검사 칸에 판·제목·바꾼 내용·출처·만든 시각·토큰 — 새 요청 없음", async () => {
    stubWide();
    render(<FrameworkSection />);
    const history = await screen.findByRole("list", { name: "판 이력" });
    const before = calls().length;
    act(() => within(history).getAllByRole("button")[0].click());
    const shown = screen.getByRole("region", { name: "판 이력 — v2 — 합성 판" });
    const value = (label: string) => within(shown).getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent;
    expect(value("판")).toBe("v2 지금 판");
    expect(value("출처")).toBe("제안 #4 승인");
    expect(value("만든 시각")).toBe("2026-11-01 09:00");
    expect(value("렌더링 크기")).toBe("추정 3,600토큰");
    expect(calls().length).toBe(before);
  });
});
