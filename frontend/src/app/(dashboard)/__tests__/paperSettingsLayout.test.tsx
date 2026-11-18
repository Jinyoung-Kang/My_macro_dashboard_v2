/**
 * 모의 매매 — 설정 탭 재배치(작업대 P6, 명세 §7-1 '설정'): 묶음 목차(SectionIndex xl — 바꿀 값 · 공용·미국 키 · 한국 키 · 바꾼 기록, 하위 칸 = 서버 묶음),
 * 줄 이름(설명 앞마디 + 키 고정폭 — 입력의 이름은 둘을 이음), 줄 끝 검사 단추가 여는 읽기만 하는 검사 칸(좁은 화면 대화상자·넓은 화면 옆 칸 — 설명·형·범위·
 * 기본값·규칙 계좌 영향·그 키의 바꾼 기록). 검사 칸은 새 요청이 없고(설정·이력 한 번씩 그대로) 쓰기도 없습니다. 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
};

const SETTINGS = {
  available: true,
  version: 3,
  body: { model: "claude-sonnet-5-5", slippageBp: 5, parkCashInShy: true, trackRecord: { windowYears: 5 }, kr: { slippageBp: 7 } },
  defaults: { model: "claude-sonnet-5-5", slippageBp: 5, parkCashInShy: true, trackRecord: { windowYears: 7 }, kr: { slippageBp: 5 } },
  keys: [
    {
      key: "model", type: "string", min: null, max: null, affectsRules: false, market: null,
      description: "Claude 계좌 모델(D5) — 거절·오류 때 다른 모델로 자동 전환하지 않음", options: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    },
    { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "체결 슬리피지(bp) — 미국 계좌 공통" },
    { key: "parkCashInShy", type: "boolean", min: null, max: null, affectsRules: true, market: "US", description: null },
    { key: "trackRecord.windowYears", type: "integer", min: 3, max: 10, affectsRules: true, market: "US", description: "트랙레코드 창(년)" },
    { key: "kr.slippageBp", type: "number", min: 0, max: 50, affectsRules: true, market: "KR", description: "한국 슬리피지(bp)" },
  ],
};

const HISTORY = {
  available: true,
  history: [
    { version: 3, changedKeys: ["trackRecord.windowYears"], createdAtKst: "2026-10-25 10:02", body: { trackRecord: { windowYears: 5 } } },
    { version: 2, changedKeys: ["slippageBp", "trackRecord.windowYears"], createdAtKst: "2026-10-24 21:00", body: { trackRecord: { windowYears: 6 } } },
    { version: 1, changedKeys: [], createdAtKst: "2026-10-24 09:00" },
  ],
};

let reads: Record<string, () => Promise<unknown>> = {};
const calls = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
const count = (path: string) => calls().filter((entry) => entry === path).length;

beforeEach(() => {
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve({ ...OVERVIEW, market: "KR" }),
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/paper/settings/history": () => Promise.resolve(HISTORY),
    "/api/paper/settings": () => Promise.resolve(SETTINGS),
  };
  window.history.replaceState(null, "", "/paper/us/settings");
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

/** 넓은 화면(lg 이상) — 틀 폭은 재지 못해(jsdom 0) 크기 질의 배치에 맡김 = 옆 검사 칸. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

async function openSettings(market: "US" | "KR" = "US") {
  render(<PaperPage market={market} initialTab="settings" />);
  await screen.findByLabelText(market === "KR" ? "kr.slippageBp" : "slippageBp");
  await waitFor(() => expect(count("/api/paper/settings/history")).toBe(1));
}

/** 목차 안 칸의 글(링크마다 — 보이는 숫자는 aria-hidden이라 이름은 '이름 (n)'). */
function navNames(list: HTMLElement): string[] {
  return within(list).getAllByRole("link").map((link) => link.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

describe("설정 탭 재배치 — 목차", () => {
  it("가로 줄은 바꿀 값 · 공용·미국 키 · 한국 키 · 바꾼 기록(개수), 세로 목록은 그 아래 서버 묶음(짧은 이름·개수)", async () => {
    await openSettings();
    const nav = screen.getByRole("navigation", { name: "설정 목차" });
    const [strip, column] = Array.from(nav.querySelectorAll<HTMLElement>(":scope > ul"));
    expect(within(strip).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "#paper-settings-pending", "#paper-settings-keys-shared", "#paper-settings-keys-kr", "#paper-settings-history",
    ]);
    expect(within(strip).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "바꿀 값 (0)0", "공용·미국 키 (4)4", "한국 키 (1)1", "바꾼 기록 (3)3",
    ]);
    // 세로 목록의 하위 칸 — 일반·기관 선정 / 한국 계좌 묶음은 시장 앞마디를 뺀 뒷마디.
    expect(navNames(column)).toEqual([
      "바꿀 값 (0)0",
      "공용·미국 키 (4)4", "일반 (3)3", "기관 선정 (1)1",
      "한국 키 (1)1", "비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각 (1)1",
      "바꾼 기록 (3)3",
    ]);
    // 닻은 목차 칸마다 하나 — 묶음 닻은 그 칸 닻 안.
    const shared = document.getElementById("paper-settings-keys-shared") as HTMLElement;
    expect(shared.querySelector("#paper-settings-general")).not.toBeNull();
    expect(shared.querySelector("#paper-settings-trackRecord")).not.toBeNull();
    expect(document.getElementById("paper-settings-keys-kr")?.querySelector("#paper-settings-kr")).not.toBeNull();
    // 묶음 제목은 패널 머리 그대로(긴 이름).
    expect(screen.getByRole("heading", { name: "기관 선정 — 트랙레코드(그룹 A)" })).toBeTruthy();
  });

  it("한국 화면 기본 보기('한국 + 공용')면 그 밖 칸 이름은 '공용 키' — 보이는 키 수만 셈", async () => {
    await openSettings("KR");
    const nav = screen.getByRole("navigation", { name: "설정 목차" });
    const strip = nav.querySelector<HTMLElement>(":scope > ul") as HTMLElement;
    expect(within(strip).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "바꿀 값 (0)0", "공용 키 (1)1", "한국 키 (1)1", "바꾼 기록 (3)3",
    ]);
  });

  it("새로 고친 주소의 #절로 맞춤 — 닻이 생긴 뒤 그 묶음으로 옮김(alignHashOnLoad)", async () => {
    window.history.replaceState(null, "", "/paper/us/settings#paper-settings-kr");
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    await openSettings();
    await waitFor(() => expect(scrolled).toContain("paper-settings-kr"));
  });
});

describe("설정 탭 재배치 — 편집 줄 이름", () => {
  it("이름은 설명 앞마디(한국어) + 키 고정폭 — 입력의 이름은 둘을 잇고, 설명 나머지는 입력의 설명", async () => {
    await openSettings();
    const slippage = screen.getByRole("textbox", { name: "체결 슬리피지(bp) slippageBp" });
    expect(slippage).toBe(screen.getByLabelText("slippageBp"));
    expect(slippage.getAttribute("aria-describedby")).toBe("paper-setting-slippageBp-description");
    expect(document.getElementById("paper-setting-slippageBp-description")?.textContent).toBe("미국 계좌 공통");
    // 키 label은 고정폭 보조 글, 이름은 본문 글자.
    const key = document.getElementById("paper-setting-slippageBp-key") as HTMLElement;
    expect(key.tagName).toBe("LABEL");
    expect(key.className).toContain("font-mono");
    expect(document.getElementById("paper-setting-slippageBp-name")?.className).toContain("text-sm");

    // ' — '가 없으면 설명 전체가 이름이고 설명 글은 따로 없음, 설명이 없으면 키가 이름.
    expect(screen.getByRole("textbox", { name: "트랙레코드 창(년) trackRecord.windowYears" }).getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "parkCashInShy" })).toBe(screen.getByLabelText("parkCashInShy"));
    expect(screen.getByRole("combobox", { name: "Claude 계좌 모델(D5) model" })).toBeTruthy();
  });
});

describe("설정 탭 재배치 — 검사 칸(읽기만)", () => {
  it("좁은 화면: 줄 끝 단추가 위쪽 대화상자를 열고 제목에 포커스 — 속성·그 키의 바꾼 기록, 새 요청·쓰기 없음, 닫으면 단추로", async () => {
    await openSettings();
    const trigger = screen.getByRole("button", { name: "trackRecord.windowYears 자세히" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "트랙레코드 창(년) · trackRecord.windowYears" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("트랙레코드 창(년) · trackRecord.windowYears"));
    const value = (label: string) => within(dialog).getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent;
    expect(value("설명")).toBe("트랙레코드 창(년)");
    expect(value("키")).toBe("trackRecord.windowYears");
    expect(value("형")).toBe("integer");
    expect(value("범위")).toBe("3~10");
    expect(value("고를 수 있는 값")).toContain("고르는 키가 아님");
    expect(value("시장")).toBe("미국 계좌");
    expect(value("지금 값")).toBe("5");
    expect(value("기본값")).toBe("7");
    expect(value("기본값과 같은가")).toBe("다름");
    expect(value("규칙 계좌 영향")).toBe("주의: 규칙 계좌 영향");
    expect(value("설정 행")).toBe("있음(설정 v3)");
    const history = within(dialog).getByRole("region", { name: "바꾼 기록(최근 100판 안)" });
    expect(within(history).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "v32026-10-25 10:025", "v22026-10-24 21:006",
    ]);
    // 값 입력은 가운데 줄에만 — 검사 칸에는 입력·쓰기 단추가 없습니다.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("spinbutton")).toBeNull();
    expect(within(dialog).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["닫기"]);

    expect(count("/api/paper/settings")).toBe(1);
    expect(count("/api/paper/settings/history")).toBe(1);
    expect(api.apiPost).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("바꾼 판이 없는 키·설명이 없는 키 — '최근 100판 안에 …없습니다', 설명 '—'와 까닭", async () => {
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "parkCashInShy 자세히" }));
    const dialog = await screen.findByRole("dialog", { name: "parkCashInShy" });
    expect(within(dialog).getByText("최근 100판 안에 이 키를 바꾼 판이 없습니다.")).toBeTruthy();
    const description = within(dialog).getByText("설명", { selector: "dt" }).parentElement?.querySelector("dd") as HTMLElement;
    expect(description.textContent).toContain("—");
    expect(description.textContent).toContain("서버가 설명을 보내지 않음");
  });

  it("넓은 화면: 옆 검사 칸 — 처음은 안내, 줄 끝 단추로 고르면 그 줄에 막대·aria-current, 고른 키의 속성", async () => {
    stubWide();
    await openSettings();
    const panel = screen.getByRole("region", { name: "설정 키 자세히 — 고른 줄 없음" });
    expect(panel.textContent).toContain("줄 끝 단추를 누르면 그 키의 설명·범위·기본값·바꾼 기록이 이 칸에 나옵니다");

    const trigger = screen.getByRole("button", { name: "kr.slippageBp 자세히" });
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    act(() => trigger.click());
    const shown = screen.getByRole("region", { name: "설정 키 자세히 — 한국 슬리피지(bp) · kr.slippageBp" });
    expect(within(shown).getByText("한국 규칙 계좌 영향")).toBeTruthy();
    expect(trigger.getAttribute("aria-current")).toBe("true");
    const row = trigger.closest("[data-setting-key]") as HTMLElement;
    expect(row.getAttribute("data-setting-key")).toBe("kr.slippageBp");
    expect(row.className).toContain("bg-surface-2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
