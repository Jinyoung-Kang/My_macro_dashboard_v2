/**
 * 통합 검색(⌘K) — 여닫기(단추·맥 ⌘K/그 밖 Ctrl+K·Esc), 열 때만 자료를 읽기, 범주별 결과와 "N개 더", 키보드(↑↓·Enter)와 누르기로 이동,
 * 운영자 화면은 운영자에게만, 유료 화면은 무료 회원에게 🔒, 비어 있는 범주는 이유를 적기.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: () => {}, collecting: false, message: null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { SearchCommand } from "../SearchCommand";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "PRO" };
const MEMBER_FREE: SessionUser = { email: "f@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO", local: true };

const OVERVIEW = "/api/macro/overview";
const INSTITUTIONS = "/api/sec13f/institutions";
const UNIVERSE = "/api/stock/universe";

/** 경로별 응답. 없는 경로는 끝나지 않습니다(읽는 중). Error면 실패. */
let reads: Record<string, unknown>;

function serve(path: string): Promise<unknown> {
  if (!(path in reads)) return new Promise(() => {});
  const value = reads[path];
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

const trigger = () => screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" });
const input = () => screen.getByRole("combobox", { name: "검색어" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const optionLabels = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");

function openSearch(user: SessionUser = MEMBER) {
  render(<SearchCommand user={user} />);
  fireEvent.click(trigger());
  return screen.getByRole("dialog", { name: "통합 검색" });
}

beforeEach(() => {
  reads = {
    [OVERVIEW]: {
      available: true, readMode: "auto",
      categories: [{ id: "index", title: "주가지수", items: [{ key: "sp500", name: "S&P 500", ticker: "^GSPC", status: "ok" }] }],
    },
    [INSTITUTIONS]: { institutions: [{ key: "berkshire", name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", cik: "0001067983", desc: "" }] },
    [UNIVERSE]: { available: true, rows: [{ ticker: "AAPL", name: "Apple Inc.", sector: "Technology" }] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  router.push.mockReset();
});

afterEach(() => cleanup());

describe("여닫기", () => {
  it("닫혀 있으면 대화상자도 없고 검색 자료도 읽지 않는다", () => {
    render(<SearchCommand user={MEMBER} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });

  it("맥이 아니면 Ctrl+K로 어디서든 열리고, 그냥 K·Shift가 섞인 것·⌘(Windows 키)K는 열지 않는다", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    render(<SearchCommand user={MEMBER} />);
    expect(trigger().getAttribute("aria-keyshortcuts")).toBe("Control+K");
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "K", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
    cleanup();

    // 한글 자판: K 자리가 "ㅏ"로 와도 물리 키(KeyK)로 엽니다.
    render(<SearchCommand user={MEMBER} />);
    fireEvent.keyDown(window, { key: "ㅏ", code: "KeyK", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
  });

  // 맥의 Ctrl+K는 입력칸의 기본 편집 명령(줄 끝까지 지우기)이다. 가로채면 모의매매 메모·알림 규칙 입력칸에서 그 명령이 사라졌다.
  it("맥에서는 ⌘K로만 열고, 입력칸 안의 Ctrl+K는 가로채지 않는다", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(
      <>
        <textarea aria-label="메모" />
        <SearchCommand user={MEMBER} />
      </>,
    );
    expect(trigger().getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(trigger().textContent).toContain("⌘K");

    const memo = screen.getByRole("textbox", { name: "메모" });
    memo.focus();
    const notPrevented = fireEvent.keyDown(memo, { key: "k", ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(memo, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
  });

  it("열면 포커스가 검색어 입력칸으로 간다", () => {
    openSearch();
    expect(document.activeElement).toBe(input());
  });

  it("Esc로 닫고, 다시 열면 검색어가 비어 있다", () => {
    const dialog = openSearch();
    type("순유");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    expect((input() as HTMLInputElement).value).toBe("");
  });
});

describe("자료 읽기", () => {
  it("열면 회원 경로 셋만 읽는다 — 매크로 개요는 live 없이, 운영자 전용 자료(/api/status·/api/paper)는 읽지 않는다", async () => {
    openSearch(OWNER);
    await act(async () => {});
    const paths = api.apiGetShared.mock.calls.map(([path]) => path).sort();
    expect(paths).toEqual([INSTITUTIONS, OVERVIEW, UNIVERSE].sort());
  });

  it("범주를 아직 못 읽었거나 실패했거나 저장본이 없으면 그 이유를 적는다(조용히 비우지 않음)", async () => {
    delete reads[OVERVIEW];   // 끝나지 않음
    reads[INSTITUTIONS] = new Error("백엔드 API에 연결하지 못했습니다");
    reads[UNIVERSE] = { available: false, message: "종목 가격 저장본이 없습니다.", rows: [] };
    openSearch();

    const status = await screen.findByRole("list", { name: "검색 자료 상태" });
    await waitFor(() => expect(within(status).getAllByRole("listitem")).toHaveLength(3));
    expect(within(status).getByText("지표: 불러오는 중…")).toBeTruthy();
    expect(within(status).getByText("기관: 불러오지 못했습니다 — 백엔드 API에 연결하지 못했습니다")).toBeTruthy();
    expect(within(status).getByText("종목: 종목 가격 저장본이 없습니다.")).toBeTruthy();
  });

  it("모두 읽으면 자료 상태 줄이 없다", async () => {
    openSearch();
    await act(async () => {});
    expect(screen.queryByRole("list", { name: "검색 자료 상태" })).toBeNull();
  });
});

describe("결과", () => {
  it("검색어가 비면 안내만, 맞는 것이 없으면 그렇게 말한다", async () => {
    openSearch();
    await act(async () => {});
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/종목 이름·티커를 입력하세요/)).toBeTruthy();

    type("zzzz");
    expect(screen.getByText("‘zzzz’와 맞는 결과가 없습니다.")).toBeTruthy();
    // 결과가 없으면 빈 목록 상자도 없다(입력칸은 접힘) — 결과 없음은 status가 읽는다.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("결과 0건");

    type("aapl");
    expect(screen.getByRole("listbox", { name: "검색 결과" })).toBeTruthy();
  });

  it("범주를 아직 다 읽지 못했으면 '결과 0건'·'맞는 결과가 없습니다'로 단정하지 않는다", async () => {
    delete reads[UNIVERSE]; // 종목 목록은 끝나지 않음(읽는 중)
    reads[INSTITUTIONS] = new Error("백엔드 API에 연결하지 못했습니다");
    openSearch();

    type("aapl");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "결과 0건 — 기관: 불러오지 못했습니다 — 백엔드 API에 연결하지 못했습니다 · 종목: 불러오는 중…",
      ),
    );
    expect(screen.getByText("‘aapl’와 맞는 결과가 아직 없습니다 — 일부 범주를 다 읽지 못했습니다(아래 안내).")).toBeTruthy();
  });

  it("범주별 묶음 — 지표·기관·종목은 그 값을 고르는 화면으로 간다고 적는다", async () => {
    openSearch();
    await act(async () => {});

    type("aapl");
    const group = screen.getByRole("group", { name: "종목" });
    expect(within(group).getByRole("option").textContent).toBe("Apple Inc.AAPL · Technology→ 종목 스코어카드");

    type("버크셔");
    expect(within(screen.getByRole("group", { name: "기관" })).getByRole("option").textContent).toContain("버크셔 해서웨이 (Berkshire Hathaway)");

    type("gspc");
    expect(within(screen.getByRole("group", { name: "지표" })).getByRole("option").textContent).toContain("→ 매크로 지표");
  });

  it("운영자 화면은 운영자에게만 — 회원이 '저장소'를 쳐도 데이터 저장소 상태가 나오지 않는다", async () => {
    openSearch(MEMBER);
    type("저장소");
    expect(optionLabels()).toEqual([]);
    cleanup();

    openSearch(OWNER);
    type("저장소");
    expect(optionLabels()).toEqual(["데이터 저장소 상태더보기"]);
  });

  it("범주마다 상한까지만 보이고 넘친 수를 범주 제목에 적는다", async () => {
    reads[UNIVERSE] = {
      available: true,
      rows: Array.from({ length: 10 }, (_, at) => ({ ticker: `ALP${at}`, name: `Alpha ${at}`, sector: null })),
    };
    openSearch();
    await act(async () => {});
    type("alpha");

    const group = screen.getByRole("group", { name: /종목/ });
    expect(within(group).getAllByRole("option")).toHaveLength(6);
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("6개 표시 · 4개 더 — 검색어를 더 입력하세요")).toBeTruthy();
    // 화면 읽기 안내도 맞은 수(10)를 말한다 — 보이는 수(6)만 말하지 않는다.
    expect(screen.getByRole("status").textContent).toBe("결과 10건 중 6건 표시");
  });

  it("유료 화면은 무료 회원에게 🔒 — 하위 메뉴·더보기와 같은 표시", async () => {
    openSearch(MEMBER_FREE);
    type("AI 종합");
    const ai = screen.getByRole("option", { name: /AI 종합 분석/ });
    expect(within(ai).getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
    cleanup();

    openSearch(MEMBER);
    type("AI 종합");
    expect(within(screen.getByRole("option", { name: /AI 종합 분석/ })).queryByRole("img")).toBeNull();
  });
});

describe("이동", () => {
  it("↑↓로 고르고 Enter로 그 화면에 간다 — 고른 결과는 aria-activedescendant·aria-selected", async () => {
    openSearch();
    await act(async () => {});
    type("시장");   // 시장 탭의 화면 여섯(매크로 지표·순유동성…)

    const box = input();
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0].id);

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1].id);
    // 눈으로도 구분된다 — 고른 결과에만 왼쪽 잉크 막대(바탕색 차이만으로는 대비가 모자람).
    const bar = (option: HTMLElement) => option.querySelector("span[aria-hidden='true'].bg-accent");
    expect(bar(options[1])).toBeTruthy();
    expect(bar(options[0])).toBeNull();
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });   // 맨 위에서 위로 → 맨 아래
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(box, { key: "ArrowDown" });   // 맨 아래에서 아래로 → 맨 위
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(router.push).toHaveBeenCalledWith("/liquidity");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("한글 입력 중(조합 중)의 Enter는 이동하지 않는다 — 마지막 글자를 확정하는 키", async () => {
    openSearch();
    type("순유");
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("결과를 누르면 그 화면으로 가고 닫힌다", async () => {
    openSearch();
    await act(async () => {});
    type("aapl");
    fireEvent.click(screen.getByRole("option", { name: /Apple Inc\./ }));
    expect(router.push).toHaveBeenCalledWith("/scorecard");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
