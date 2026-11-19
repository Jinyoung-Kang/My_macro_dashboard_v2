/**
 * 정보 수집 출처 표(components/screens/info/SourceTable — 작업대 P7): 출처 = 열 수 있는 대상. 이름(줄 단추)을 누르면 검사 칸(좁은 화면은 위쪽 대화상자,
 * 넓은 화면·틀 52rem 이상은 옆 칸)에 catalog 응답의 값만 나옵니다(새 요청 없음).
 * 네 상태: 값 있음(속성·링크) / 모르는 값('—'와 '기록 없음' — 0이나 빈 칸을 만들지 않음) / 끊김(종류·시작 시각) / 기록 없음(상태 글).
 * 넓은 화면은 matchMedia 대역(WIDE_SHELL_MEDIA)과 틀 폭 대역(getBoundingClientRect·ResizeObserver)으로 흉내 냅니다(InspectorFrame.test와 같음).
 * 응답은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import type { CatalogSource } from "@/lib/info";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import InfoHub from "../InfoHub";
import { SourceTable } from "../SourceTable";

function source(index: number, over: Partial<CatalogSource> = {}): CatalogSource {
  return {
    task: `task_${index}`, key: `key_${index}`, label: `출처 ${index}`, tab: "global", kind: "data", siteUrl: null, origin: "합성 기관",
    access: "official", screen: null, speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-11 17:00 KST", lastDetail: null,
    politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "ok", ...over,
  };
}

const FULL = source(1, {
  task: "info_blog_synthetic", label: "합성 블로그", kind: "blog", access: "bypass", speed: "polite", siteUrl: "https://blog.example/",
  screen: "/info/news", lastOkAt: "2026-11-11 16:40 KST", lastRunAt: "2026-11-11 16:41 KST", nextDueAt: "2026-11-11 19:12 KST", items: 1234,
  lastDetail: "새 글 3편 · 본문 2편", politeStatus: "ok", streak: 4,
});
const UNKNOWN = source(2, { label: "기록 모르는 출처", speed: null, lastRunAt: null, lastStatus: null, tone: "neutral" });
const BROKEN = source(3, {
  label: "끊긴 출처", tone: "danger", politeStatus: "blocked", streak: 2, access: "bypass",
  incident: { key: "task_3|blocked", task: "task_3", label: "끊긴 출처", kind: "blocked", kindLabel: "차단됨 — 잠시 멈춤", reason: "403 Forbidden", since: "2026-11-11 15:00 KST" },
});

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

/** 틀(@container) 폭 — 옆 칸 배치(lg — 52rem 이상)가 되게 1200px. */
function stubFrameWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("@container")
      ? ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect)
      : original.call(this);
  });
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 검사 칸·대화상자의 속성 한 줄의 값(dd) 글. */
function property(scope: HTMLElement, label: string): string {
  const term = within(scope).getAllByText(label).find((element) => element.tagName === "DT");
  if (!term) throw new Error(`속성 '${label}' 없음`);
  return term.nextElementSibling?.textContent ?? "";
}

describe("출처 표 — 값 있음", () => {
  it("표 줄: 이름 단추·상태(연속 n회는 정상 판정이면 없음)·접근 태그·주기·실행 시각(KST 그대로); 분류 탭은 받은 글·기관 칸", () => {
    render(<SourceTable sources={[FULL]} variant="tab" caption="출처" pagerLabel="출처" emptyText="없음" />);
    const table = screen.getByRole("region", { name: "출처 (좌우 스크롤)" });
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getByRole("button", { name: "합성 블로그" })).toBeTruthy();
    expect(within(row).getByText("정상")).toBeTruthy();
    expect(within(row).getByText("차단 통과 수집(서버)")).toBeTruthy();
    expect(within(row).getByText("불규칙(출처마다 무작위)")).toBeTruthy();
    expect(within(row).getByText("2026-11-11 16:41 KST")).toBeTruthy();
    expect(within(row).getByText("2026-11-11 19:12 KST")).toBeTruthy();
    expect(within(row).getByText("1,234편")).toBeTruthy();
    expect(within(row).getByText("합성 기관")).toBeTruthy();
    expect(within(table).queryByText("새 글 3편 · 본문 2편")).toBeNull();      // 분류 탭의 사유는 검사 칸에
    expect(screen.getByText("1곳")).toBeTruthy();
  });

  it("이름을 누르면(좁은 화면) 대화상자에 catalog 값 — 상태·접근·기관·주기·수집 태스크(고정폭)·실행 시각 차례·받은 글·사유 전체·링크", async () => {
    render(<SourceTable sources={[FULL]} variant="tab" caption="출처" pagerLabel="출처" emptyText="없음" />);
    fireEvent.click(screen.getByRole("button", { name: "합성 블로그" }));
    const dialog = await screen.findByRole("dialog", { name: "합성 블로그" });
    expect(property(dialog, "상태")).toBe("정상");
    expect(property(dialog, "접근")).toBe("차단 통과 수집(서버)");
    expect(property(dialog, "기관")).toBe("합성 기관");
    expect(property(dialog, "주기")).toBe("불규칙(출처마다 무작위)");
    expect(property(dialog, "수집 태스크")).toBe("info_blog_synthetic");
    expect(within(dialog).getByText("info_blog_synthetic").className).toContain("font-mono");
    const order = within(dialog).getAllByRole("term").map((term) => term.textContent);
    expect(order.filter((label) => ["마지막 성공", "마지막 실행", "다음 실행"].includes(label ?? ""))).toEqual(["마지막 성공", "마지막 실행", "다음 실행"]);
    expect(property(dialog, "마지막 성공")).toBe("2026-11-11 16:40 KST");
    expect(property(dialog, "받은 글")).toBe("1,234편");
    expect(property(dialog, "사유·기록")).toBe("새 글 3편 · 본문 2편");
    expect(within(dialog).queryByText("끊김")).toBeNull();
    expect(within(dialog).getByRole("link", { name: "출처 사이트" }).getAttribute("href")).toBe("https://blog.example/");
    expect(within(dialog).getByRole("link", { name: "출처 사이트" }).getAttribute("target")).toBe("_blank");
    expect(within(dialog).getByRole("link", { name: "자료 보기" }).getAttribute("href")).toBe("/info/news");
  });
});

describe("출처 표 — 모르는 값", () => {
  it("실행 시각·주기를 모르면 표 칸은 '—', 검사 칸은 '—'와 '기록 없음'(0이나 빈 칸이 아님), 링크가 없으면 링크 줄도 없음", async () => {
    render(<SourceTable sources={[UNKNOWN]} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="없음" />);
    const row = within(screen.getByRole("region", { name: "출처 상태 (좌우 스크롤)" })).getAllByRole("row")[1];
    // 주기·마지막 실행·다음 실행·사유 네 칸
    expect(within(row).getAllByText("—")).toHaveLength(4);
    fireEvent.click(within(row).getByRole("button", { name: "기록 모르는 출처" }));
    const dialog = await screen.findByRole("dialog", { name: "기록 모르는 출처" });
    for (const label of ["주기", "마지막 성공", "마지막 실행", "다음 실행", "받은 글", "사유·기록"]) {
      expect(property(dialog, label), label).toContain("—");
      expect(property(dialog, label), label).toContain("기록 없음");
    }
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("거른 결과가 없으면 머리는 두고 안내 한 줄, 개수는 0곳", () => {
    render(<SourceTable sources={[]} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="고른 조건에 맞는 출처가 없습니다." />);
    expect(screen.getByText("고른 조건에 맞는 출처가 없습니다.")).toBeTruthy();
    expect(screen.getByText("0곳")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("출처 표 — 끊김·기록 없음", () => {
  it("끊긴 출처: 상태는 끊김 종류(연속 n회), 검사 칸에 끊김 줄과 끊김 시작 — 마지막 성공 다음, 마지막 실행 앞", async () => {
    render(<SourceTable sources={[BROKEN]} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="없음" />);
    const row = within(screen.getByRole("region", { name: "출처 상태 (좌우 스크롤)" })).getAllByRole("row")[1];
    expect(within(row).getByText("차단됨 — 잠시 멈춤 (연속 2회)")).toBeTruthy();
    expect(within(row).getByText("403 Forbidden")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "끊긴 출처" }));
    const dialog = await screen.findByRole("dialog", { name: "끊긴 출처" });
    expect(property(dialog, "끊김")).toBe("차단됨 — 잠시 멈춤");
    expect(property(dialog, "끊김 시작")).toBe("2026-11-11 15:00 KST");
    const order = within(dialog).getAllByRole("term").map((term) => term.textContent);
    expect(order.indexOf("끊김 시작")).toBe(order.indexOf("마지막 성공") + 1);
    expect(order.indexOf("마지막 실행")).toBe(order.indexOf("끊김 시작") + 1);
  });

  it("기록이 없는 출처: 상태 글 '기록 없음'(중립 아이콘 + 글)", () => {
    render(<SourceTable sources={[source(4, { lastStatus: null, tone: "neutral" })]} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="없음" />);
    const row = within(screen.getByRole("region", { name: "출처 상태 (좌우 스크롤)" })).getAllByRole("row")[1];
    const status = within(row).getByText("기록 없음");
    expect(status.closest("span.inline-flex")?.className).toContain("text-text-3");
  });
});

describe("출처 표 — 배치·쪽·누름 자리", () => {
  it("짧은 칸(상태·접근·실행 시각)은 꺾지 않고, 주기는 낱말 사이에서만, 사유·기록은 20rem 이상·자르지 않음", () => {
    render(<SourceTable sources={[BROKEN]} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="없음" />);
    const headers = screen.getAllByRole("columnheader");
    const cls = (name: string) => headers.find((header) => header.textContent === name)?.className ?? "";
    for (const name of ["상태", "접근", "마지막 실행", "다음 실행"]) expect(cls(name), name).toContain("whitespace-nowrap");
    expect(cls("주기")).toContain("break-keep");
    expect(cls("사유·기록")).toContain("min-w-[20rem]");
    const reason = screen.getByText("403 Forbidden");
    expect(reason.className).not.toMatch(/line-clamp|truncate/);
    expect(reason.className).toContain("wrap-anywhere");
  });

  it("넓은 화면·넓은 틀: 옆 검사 칸에 고른 출처, 고른 행 표시 — 쪽을 옮기면 고름을 푼다", () => {
    stubWide();
    stubFrameWidth(1200);
    const many = Array.from({ length: 12 }, (_, i) => source(i + 10));
    render(<SourceTable sources={many} variant="status" caption="출처 상태" pagerLabel="출처 상태" emptyText="없음" />);
    expect(screen.getByRole("region", { name: "출처 상세 — 고른 줄 없음" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "출처 12" }));
    const side = screen.getByRole("region", { name: "출처 상세 — 출처 12" });
    expect(property(side, "수집 태스크")).toBe("task_12");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "출처 12" }).getAttribute("aria-current")).toBe("true");

    act(() => {
      fireEvent.click(within(screen.getByRole("navigation", { name: "출처 상태 쪽" })).getByRole("button", { name: "2" }));
    });
    expect(screen.getByRole("region", { name: "출처 상세 — 고른 줄 없음" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "출처 20" })).toBeTruthy();
  });

  it("좁은 화면: 이름 단추·링크·쪽 단추 모두 44px 누름 자리(클래스로 셈)", async () => {
    render(<SourceTable sources={Array.from({ length: 12 }, (_, i) => source(i, { siteUrl: "https://x.example/", screen: "/macro" }))} variant="tab" caption="출처" pagerLabel="출처" emptyText="없음" />);
    const { body } = document;
    expect(smallTargets(body)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "출처 0" }));
    await screen.findByRole("dialog", { name: "출처 0" });
    expect(smallTargets(screen.getByRole("dialog", { name: "출처 0" }))).toEqual([]);
  });
});

describe("출처 표 — 요청", () => {
  it("검사 칸을 열어도 새 요청이 없다(catalog 값만)", async () => {
    const catalog = { checkedAt: "2026-11-11 18:00 KST", collectorReachable: true, tabs: [], sources: [FULL, UNKNOWN, BROKEN], incidents: [] };
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/info/catalog") ? Promise.resolve(catalog) : new Promise(() => {})));
    render(<InfoHub tab="status" />);
    fireEvent.click(await screen.findByRole("button", { name: "합성 블로그" }));
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "합성 블로그" }), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "합성 블로그" })));      // 닫으면 연 단추로
    fireEvent.click(screen.getByRole("radio", { name: "위험" }));
    expect(screen.getByRole("button", { name: "끊긴 출처" })).toBeTruthy();
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).toEqual(["/api/info/catalog"]);
  });
});
