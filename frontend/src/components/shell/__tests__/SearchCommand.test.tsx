/**
 * 통합 검색(⌘K) — 여닫기(단추·맥 ⌘K/그 밖 Ctrl+K·Esc), 열 때만 자료를 읽기, 범주별 결과와 "N개 더", 키보드(↑↓·Enter)와 누르기로 이동,
 * 운영자 화면은 운영자에게만, 유료 화면은 무료 회원에게 자물쇠 아이콘, 비어 있는 범주는 이유를 적기, 지표·기관·종목은 상세 화면으로,
 * 색인 밖 종목은 입력이 멈추면 외부 검색(종목 찾기)으로.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpoints } from "@/lib/endpoints";
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

import { resetRecentEntitiesForTest } from "@/hooks/useRecentEntities";
import { RECENT_STORAGE_KEY, serializeRecent } from "@/lib/palette";
import { SHELL_COMMAND_EVENT, WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
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
/** 결과 행이 읽어 주는 글 — 왼쪽 원(장식, aria-hidden — 종목 모노그램 글자)을 뺀 글. */
const spokenText = (element: HTMLElement) => {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());
  return copy.textContent ?? "";
};

/** 창 폭 — 넓은 화면(lg 이상)이면 명령 팔레트로 넓힌 범주(최근 연 대상·명령·도움말 안내)가 보입니다(팔레트를 열 때 셈). */
const stubWide = (wide: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: wide && query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);

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

// 최근 연 대상(localStorage)은 사례마다 비웁니다 — 앞 사례가 고른 대상이 뒤 사례의 빈 검색어 결과로 남지 않게.
beforeEach(() => {
  window.localStorage.clear();
  resetRecentEntitiesForTest();
});

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

  it("한글 조합 중(isComposing·keyCode 229)의 Ctrl/⌘K는 열지 않는다 — 조합을 끝낸 뒤 누르면 연다", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    render(
      <>
        <input aria-label="메모" />
        <SearchCommand user={MEMBER} />
      </>,
    );
    const memo = screen.getByRole("textbox", { name: "메모" });
    memo.focus();
    expect(fireEvent.keyDown(memo, { key: "k", ctrlKey: true, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(memo, { key: "Process", code: "KeyK", ctrlKey: true, keyCode: 229 })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(memo, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
    cleanup();

    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<SearchCommand user={MEMBER} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true, keyCode: 229 });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
  });

  it("열면 포커스가 검색어 입력칸으로 간다 — 대화상자는 위쪽에 고정(결과 수가 바뀌어도 입력칸이 움직이지 않게 — 가운데 정렬 아님)", () => {
    const dialog = openSearch();
    expect(document.activeElement).toBe(input());
    expect(dialog.className).toContain("sm:top-[12dvh]");
    expect(dialog.className).not.toContain("top-1/2");
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
    expect(screen.getByText(/종목 이름·티커·국내 코드를 입력하세요/)).toBeTruthy();

    type("zzzz");
    expect(screen.getByText("‘zzzz’에 맞는 결과가 없습니다.")).toBeTruthy();
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
    expect(screen.getByText("‘aapl’에 맞는 결과가 아직 없습니다 — 일부 범주를 다 읽지 못했습니다(아래 안내).")).toBeTruthy();
  });

  it("범주별 묶음 — 지표·기관·종목은 그 상세 화면으로 간다고 적는다", async () => {
    openSearch();
    await act(async () => {});

    type("aapl");
    const group = screen.getByRole("group", { name: "종목" });
    const apple = within(group).getByRole("option");
    expect(spokenText(apple)).toBe("Apple Inc.AAPL · Technology→ 종목 상세");
    // 왼쪽 원은 장식(aria-hidden) — 종목은 티커 모노그램, 메뉴·지표·기관은 탭 아이콘(글 없음)
    expect(apple.querySelector("span[aria-hidden='true'].rounded-full")?.textContent).toBe("AAP");

    type("버크셔");
    expect(within(screen.getByRole("group", { name: "기관" })).getByRole("option").textContent).toContain("버크셔 해서웨이 (Berkshire Hathaway)");
    expect(within(screen.getByRole("group", { name: "기관" })).getByRole("option").textContent).toContain("→ 기관 상세");

    type("gspc");
    expect(within(screen.getByRole("group", { name: "지표" })).getByRole("option").textContent).toContain("→ 지표 상세");
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

  it("유료 화면은 무료 회원에게 잠금 아이콘 — 하위 메뉴·더보기와 같은 표시", async () => {
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
    const bar = (option: HTMLElement) => option.querySelector("span[aria-hidden='true'].bg-text");
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

  it("결과를 누르면 그 상세 화면으로 가고 닫힌다 — 종목 /s/us/<티커>, 지표 /markets/i/<키>, 기관 /institutions/<CIK>", async () => {
    openSearch();
    await act(async () => {});
    type("aapl");
    fireEvent.click(screen.getByRole("option", { name: /Apple Inc\./ }));
    expect(router.push).toHaveBeenLastCalledWith("/s/us/AAPL");
    expect(screen.queryByRole("dialog")).toBeNull();

    // 닫으면 자료를 놓으므로(열 때만 읽음) 다시 열고 읽기를 기다립니다.
    fireEvent.click(trigger());
    await act(async () => {});
    type("gspc");
    fireEvent.click(screen.getByRole("option", { name: /S&P 500/ }));
    expect(router.push).toHaveBeenLastCalledWith("/markets/i/sp500");

    fireEvent.click(trigger());
    await act(async () => {});
    type("버크셔");
    fireEvent.click(screen.getByRole("option", { name: /버크셔/ }));
    expect(router.push).toHaveBeenLastCalledWith("/institutions/0001067983");
  });

  it("색인 밖 종목은 입력이 멈춘 뒤 외부 검색(종목 찾기)으로 찾고, 누르면 종목 상세로 — 한 글자는 찾지 않는다", async () => {
    reads[endpoints.detail.symbols("삼성")] = {
      available: true,
      symbols: {
        items: [
          { market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자", exchange: "코스피", kind: "stock", source: "네이버 증권" },
        ],
      },
    };
    openSearch();
    await act(async () => {});
    type("삼");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(api.apiGetShared.mock.calls.some(([path]) => String(path).startsWith("/api/detail/symbols"))).toBe(false);

    type("삼성");
    const group = await screen.findByRole("group", { name: "종목 찾기 · Yahoo·네이버" });
    const option = within(group).getByRole("option");
    expect(spokenText(option)).toBe("삼성전자005930 · 코스피 · 주식 · 네이버 증권→ 종목 상세");
    fireEvent.click(option);
    expect(router.push).toHaveBeenCalledWith("/s/kr/005930");
  });

  // QA-256: 200 응답 안의 출처 실패(symbols.error·errors)도 자료 상태로 적는다.
  it("종목 찾기가 200 응답 안에서 출처 실패를 알리면 '맞는 결과가 없습니다'로 단정하지 않고 받지 못한 출처를 적는다(모두 실패·일부 실패)", async () => {
    reads[endpoints.detail.symbols("삼성전자")] = {
      available: true,
      symbols: {
        items: [],
        errors: { "네이버 증권": "ProxyError", "Yahoo Finance": "ConnectionError" },
        error: "네이버 증권: ProxyError; Yahoo Finance: ConnectionError",
      },
    };
    reads[endpoints.detail.symbols("삼성")] = {
      available: true,
      symbols: {
        items: [
          { market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자", exchange: "코스피", kind: "stock", source: "Yahoo Finance" },
        ],
        errors: { "네이버 증권": "ProxyError" },
        error: null,
      },
    };
    openSearch();
    await act(async () => {});
    type("삼성전자");
    const status = await screen.findByRole("list", { name: "검색 자료 상태" });
    expect(within(status).getByText("종목 찾기 · Yahoo·네이버: 출처를 받지 못했습니다(네이버 증권·Yahoo Finance)")).toBeTruthy();
    expect(screen.getByText("‘삼성전자’에 맞는 결과가 아직 없습니다 — 일부 범주를 다 읽지 못했습니다(아래 안내).")).toBeTruthy();

    type("삼성");
    await screen.findByRole("group", { name: "종목 찾기 · Yahoo·네이버" });
    expect(within(screen.getByRole("list", { name: "검색 자료 상태" }))
      .getByText("종목 찾기 · Yahoo·네이버: 일부 출처를 받지 못했습니다(네이버 증권)")).toBeTruthy();
  });
});

describe("정보 검색으로 넘기기(ADR 0041)", () => {
  it("검색어가 있으면 결과 맨 아래에 '‘검색어’ 정보 검색' 링크(/search?q=) — 결과가 없어도 있고, 결과 수·목록에는 세지 않는다", async () => {
    openSearch();
    await act(async () => {});
    expect(screen.queryByRole("link", { name: /정보 검색/ })).toBeNull();

    type("zzzz");
    const link = screen.getByRole("link", { name: "‘zzzz’ 정보 검색" });
    expect(link.getAttribute("href")).toBe("/search?q=zzzz");
    expect(screen.getByRole("status").textContent).toBe("결과 0건");
    expect(input().getAttribute("aria-expanded")).toBe("false");

    type("aapl");
    expect(screen.getByRole("link", { name: "‘aapl’ 정보 검색" }).closest("[role='listbox']")).toBeNull();
    expect(optionLabels().some((label) => label.includes("정보 검색"))).toBe(false);
  });
});

// QA-515: 입력칸(type=search)의 브라우저 기본 지우기 X가 어두운 color-scheme에서 굵은 흰색으로 그려져, 바로 옆 대화상자 닫기 X와 헷갈렸다
// (D1 QA 스택 확인 — search-input-native-clear-x, 개편 전부터). 고치기 전 입력칸 클래스는 8개
// ["h-12", "min-w-0", "flex-1", "bg-transparent", "text-[17px]", "text-text", "outline-none", "placeholder:text-text-3"]로 지우기 X를 숨기는 변형이 없었다.
describe("입력칸(QA-515)", () => {
  it("브라우저 기본 지우기 X를 숨긴다 — 휴대폰 자판의 검색 키를 위해 type=search는 그대로", () => {
    openSearch();
    expect(input().getAttribute("type")).toBe("search");
    expect(input().className.split(/\s+/)).toContain("[&::-webkit-search-cancel-button]:hidden");
  });
});

describe("크기(작업대 실행 명세 §3-7 — 좁은 화면 44px 이상, 넓은 화면 조작 30·40px)", () => {
  const classes = (element: Element) => element.className.split(/\s+/);

  it("여는 단추는 좁은 화면에서 상단바 남는 폭을 다 쓰는 44px, 넓은 화면은 30px에 폭 고정(176px·xl 256px)", () => {
    render(<SearchCommand user={MEMBER} />);
    expect(classes(trigger())).toEqual(expect.arrayContaining(["h-11", "flex-1", "min-w-0", "lg:h-[30px]", "lg:flex-none", "lg:w-44", "xl:w-64"]));
    expect(classes(trigger()).some((name) => name.startsWith("lg:basis-") || name.startsWith("lg:max-w-"))).toBe(false);
  });

  // QA-558: lg~xl(1024~1279px)의 여는 단추는 176px이라 글 칸이 78px뿐이어서 전체 글 '종목·기관·지표·메뉴 검색'(158px)이 '종목·기관…'으로 잘렸다.
  // 그 폭에서는 앞부분을 숨겨 '검색'만 보이고(lg 미만·xl 이상은 전체 글 — 앱 이름의 hidden xl:inline과 같은 꼴), 접근 이름(aria-label)은 그대로다.
  // 수정 전(재현 커밋에서는 it.fails)에는 글 span 하나에 전체 글만 있어 lg:hidden·xl:inline 안쪽 span이 없었다.
  it("넓은 화면 lg~xl의 여는 단추는 '검색'만 보이고 xl부터 전체 글 — 접근 이름·폭은 그대로(QA-558)", () => {
    render(<SearchCommand user={MEMBER} />);
    const label = trigger().querySelector("span.truncate") as HTMLElement;
    const lead = label.querySelector("span");
    expect(lead).not.toBeNull();
    expect(classes(lead as HTMLElement)).toEqual(expect.arrayContaining(["lg:hidden", "xl:inline"]));
    expect(lead?.textContent).toBe("종목·기관·지표·메뉴 ");
    expect(label.lastChild?.textContent).toBe("검색");
    expect(label.textContent).toBe("종목·기관·지표·메뉴 검색");
    expect(trigger().getAttribute("aria-label")).toBe("종목·기관·지표·메뉴 검색");
  });

  it("입력칸은 넓은 화면에서 경계 포함 40px·16px 글, 결과 줄은 40px·14px 이름 — 좁은 화면은 48px 줄·15px 그대로", async () => {
    openSearch();
    await act(async () => {});
    expect(classes(input())).toEqual(expect.arrayContaining(["h-12", "text-[17px]", "lg:h-[38px]", "lg:text-base"]));
    expect(classes(input().parentElement as HTMLElement)).toContain("border");

    type("aapl");
    const row = screen.getByRole("option", { name: /Apple Inc\./ });
    expect(classes(row)).toEqual(expect.arrayContaining(["min-h-12", "lg:min-h-10"]));
    expect(classes(within(row).getByText("Apple Inc."))).toEqual(expect.arrayContaining(["text-[15px]", "lg:text-sm"]));
    // 보조 글이 있는 두 줄 행도 40px — 이름(lg:text-sm 20px) + 보조(text-xs 16px) = 36px에 위아래 2px(lg:py-0.5). lg:py-1(4px)이면 44px였다
    // (QA 스택 1440·1024 실측). 좁은 화면은 py-2·min-h-12 그대로.
    expect(classes(row)).toEqual(expect.arrayContaining(["py-2", "lg:py-0.5"]));
    expect(classes(row)).not.toContain("lg:py-1");
    expect(classes(within(row).getByText("AAPL · Technology"))).toContain("text-xs");
    expect(classes(screen.getByRole("link", { name: "‘aapl’ 정보 검색" }))).toEqual(expect.arrayContaining(["min-h-12", "lg:min-h-10"]));
  });
});

describe("좁은 화면(lg 미만) — 지금 통합 검색 그대로(명세 §0 W2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("최근 연 대상·명령·도움말 안내 문장이 없다 — 빈 검색어의 Enter는 아무것도 하지 않는다", async () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([
      { kind: "ticker", label: "Apple Inc.", sub: "AAPL", href: "/s/us/AAPL", dest: "종목 상세" },
    ]));
    stubWide(false);
    openSearch();
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "최근 연 대상" })).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    const guide = screen.getByText(/종목 이름·티커·국내 코드를 입력하세요/);
    expect(guide.textContent).toMatch(/Yahoo·네이버에서 찾음\)\.$/);
    expect(guide.textContent).not.toContain("단축키 도움말");
    // 최근 연 대상 안내(QA-560)도 넓은 화면에만 — 좁은 화면 입력칸에는 설명이 없다.
    expect(input().getAttribute("aria-describedby")).toBeNull();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();

    for (const query of ["단축키", "?", "메뉴 접기", "["]) {
      type(query);
      expect(screen.queryByRole("group", { name: "명령" }), query).toBeNull();
    }
  });
});

describe("최근 연 대상(이 브라우저에만, 8개 — 넓은 화면)", () => {
  const recentGroup = () => screen.queryByRole("group", { name: "최근 연 대상" });
  beforeEach(() => stubWide(true));
  afterEach(() => vi.unstubAllGlobals());

  it("대상을 고르면 다시 열 때 빈 검색어에 '최근 연 대상'(최신 순)이 보이고, Enter로 맨 위 대상에 간다", async () => {
    openSearch();
    await act(async () => {});
    expect(recentGroup()).toBeNull();
    type("gspc");
    fireEvent.click(screen.getByRole("option", { name: /S&P 500/ }));
    fireEvent.click(trigger());
    await act(async () => {});
    type("aapl");
    fireEvent.click(screen.getByRole("option", { name: /Apple Inc\./ }));
    expect(router.push).toHaveBeenLastCalledWith("/s/us/AAPL");

    fireEvent.click(trigger());
    const group = recentGroup() as HTMLElement;
    expect(group).toBeTruthy();
    const options = within(group).getAllByRole("option");
    expect(options.map(spokenText)).toEqual(["Apple Inc.AAPL · Technology→ 종목 상세", "S&P 500주가지수 · ^GSPC→ 지표 상세"]);
    expect(options[0].querySelector("span[aria-hidden='true'].rounded-full")?.textContent).toBe("AAP");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    // 검색어가 비면 결과 수 안내는 읽지 않는다(지금처럼).
    expect(screen.getByRole("status").textContent).toBe("");
    // 저장소에는 대상의 이름·주소만.
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "null").items.map((item: { href: string }) => item.href))
      .toEqual(["/s/us/AAPL", "/markets/i/sp500"]);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(router.push).toHaveBeenLastCalledWith("/markets/i/sp500");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // QA-560: 빈 검색어에 최근 연 대상이 펼쳐지면(aria-expanded true, 빈 Enter는 맨 위 대상으로 감) 화면 읽기 사용자도 목록이 있다는 것을 듣는다.
  // role=status는 결과 수 전용 그대로이고(빈 검색어는 ""), 입력칸 설명(aria-describedby — 포커스를 받을 때 함께 읽힘)으로 알린다.
  // 수정 전(재현 커밋에서는 it.fails)에는 status가 ""이고 입력칸에 aria-describedby가 없어(null) 아무 안내도 없었다.
  it("빈 검색어에 최근 연 대상이 있으면 입력칸 설명이 'N건 — ↑↓로 고르고 Enter' — 검색어를 치면 설명이 없다(QA-560)", async () => {
    openSearch();
    await act(async () => {});
    expect(input().getAttribute("aria-describedby")).toBeNull();
    type("gspc");
    fireEvent.click(screen.getByRole("option", { name: /S&P 500/ }));
    fireEvent.click(trigger());
    await act(async () => {});
    type("aapl");
    fireEvent.click(screen.getByRole("option", { name: /Apple Inc\./ }));

    fireEvent.click(trigger());
    expect(within(recentGroup() as HTMLElement).getAllByRole("option")).toHaveLength(2);
    const describedBy = input().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy ?? "");
    expect(hint?.textContent).toBe("최근 연 대상 2건 — ↑↓로 고르고 Enter로 갑니다");
    expect(screen.getByRole("dialog", { name: "통합 검색" }).contains(hint)).toBe(true);
    expect(hint?.className.split(/\s+/)).toContain("sr-only");
    expect(screen.getByRole("status").textContent).toBe("");

    type("10");
    expect(input().getAttribute("aria-describedby")).toBeNull();
  });

  it("검색어를 치면 최근 묶음은 빠지고 지금 범주만 보인다", async () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([
      { kind: "ticker", label: "Apple Inc.", sub: "AAPL", href: "/s/us/AAPL", dest: "종목 상세" },
    ]));
    openSearch();
    await act(async () => {});
    expect(recentGroup()).toBeTruthy();
    type("aapl");
    expect(recentGroup()).toBeNull();
    expect(screen.getByRole("group", { name: "종목" })).toBeTruthy();
  });

  // QA-559: 빈 검색어 안내 문단과 결과 없음 문단은 목록 상자(mt-3)처럼 위에 12px을 둔다 — 대화상자 본문은 형제 사이 간격을 각 요소의 margin이 정한다.
  // 수정 전(재현 커밋에서는 it.fails)에는 두 문단이 'px-3 text-sm text-text-2'뿐이라 최근 연 대상 목록 바로 아래 안내가 0px로 붙었다(QA 스택 1440·1024
  // listbox bottom 333 = 문단 top 333, 마지막 보조 글과 안내 글 사이 7px). 결과 없음 문단도 입력칸 아래 경계에 0px로 붙었다.
  it("빈 검색어 안내와 결과 없음 문단은 위에 12px(mt-3)을 둔다 — 최근 연 대상 목록 아래·입력칸 아래에 붙지 않게(QA-559)", async () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([
      { kind: "ticker", label: "Apple Inc.", sub: "AAPL", href: "/s/us/AAPL", dest: "종목 상세" },
    ]));
    openSearch();
    await act(async () => {});
    expect(recentGroup()).toBeTruthy();
    expect(screen.getByText(/메뉴 이름, 매크로 지표 이름/).className.split(/\s+/)).toContain("mt-3");

    type("zzqqxx");
    expect(screen.getByText(/^‘zzqqxx’.+맞는 결과가/).className.split(/\s+/)).toContain("mt-3");
  });

  it("메뉴를 고르면 최근 연 대상에 넣지 않는다", async () => {
    openSearch();
    await act(async () => {});
    type("순유");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(router.push).toHaveBeenLastCalledWith("/liquidity");

    fireEvent.click(trigger());
    expect(recentGroup()).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });

  it("저장소가 비거나 못 읽으면(던짐) 지금처럼 결과 0건·안내만 — 고르기와 이동은 그대로", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    openSearch();
    await act(async () => {});
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/종목 이름·티커·국내 코드를 입력하세요/)).toBeTruthy();
    type("aapl");
    fireEvent.click(screen.getByRole("option", { name: /Apple Inc\./ }));
    expect(router.push).toHaveBeenLastCalledWith("/s/us/AAPL");
  });

  it("최근 연 대상이 있어도 닫혀 있는 동안 검색 자료(API)는 읽지 않는다", () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([
      { kind: "indicator", label: "S&P 500", sub: null, href: "/markets/i/sp500", dest: "지표 상세" },
    ]));
    render(<SearchCommand user={MEMBER} />);
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });
});

describe("명령(셸 명령만 — 서버를 부르지 않음, 넓은 화면)", () => {
  let commands: string[];
  const record = (event: Event) => commands.push(String((event as CustomEvent).detail));
  const commandGroup = () => screen.queryByRole("group", { name: "명령" });

  beforeEach(() => {
    commands = [];
    window.addEventListener(SHELL_COMMAND_EVENT, record);
    stubWide(true);
  });
  afterEach(() => {
    window.removeEventListener(SHELL_COMMAND_EVENT, record);
    vi.unstubAllGlobals();
  });

  it("빈 검색어에는 명령이 없다 — 안내 끝에 단축키 도움말 여는 법", async () => {
    openSearch();
    await act(async () => {});
    expect(commandGroup()).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/\?를 치고 Enter를 누르면 단축키 도움말을 봅니다\.$/)).toBeTruthy();
  });

  it("'단축키'를 치면 '명령' 묶음의 '단축키 도움말' — Enter로 팔레트가 닫히고 도움말 창이 열리며, 닫으면 팔레트 여는 단추로 포커스가 돌아온다", async () => {
    openSearch();
    await act(async () => {});
    type("단축키");
    const group = commandGroup() as HTMLElement;
    expect(group).toBeTruthy();
    const option = within(group).getByRole("option");
    expect(spokenText(option)).toBe("단축키 도움말단축키 ?");
    expect(screen.getByRole("status").textContent).toBe("결과 1건");

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "통합 검색" })).toBeNull();
    const help = await screen.findByRole("dialog", { name: "단축키" });
    await waitFor(() => expect(help.contains(document.activeElement)).toBe(true));
    expect(router.push).not.toHaveBeenCalled();
    expect(commands).toEqual([]);

    fireEvent.keyDown(help, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("기호 ?를 치면 '단축키 도움말' 명령이 나온다 — 메뉴·대상 뒤 마지막 묶음", async () => {
    openSearch();
    await act(async () => {});
    type("?");
    expect(within(commandGroup() as HTMLElement).getByRole("option", { name: /단축키 도움말/ })).toBeTruthy();

    // 다른 범주와 함께 맞으면 명령 묶음이 맨 뒤 — 결과 수 안내에 명령 수가 들어간다.
    type("도움");
    const groups = screen.getAllByRole("group").map((element) => element.getAttribute("aria-labelledby"));
    expect(document.getElementById(groups[groups.length - 1] ?? "")?.textContent).toContain("명령");
    expect(screen.getByRole("status").textContent).toMatch(/^결과 \d+건/);
  });

  // QA-557: 외부 종목 찾기(350ms 미룸 뒤 응답)는 명령 묶음보다 늦게 와서 그 앞에 끼어든다. 고른 줄은 결과 id로 들어 묶음이 바뀌어도 같은 줄이다.
  // 수정 전(재현 커밋에서는 it.fails)에는 고른 줄을 순번으로만 셌다 — 'help'의 '단축키 도움말'(순번 0)을 고른 채 종목 찾기 응답이 오면 순번 0이
  // 합성 종목(Synthetic Alpha)이 됐고 aria-activedescendant 값(option-0)은 그대로였으며, Enter가 router.push('/s/us/ZZQA')로 갔다.
  const LATE_SYMBOLS = {
    available: true,
    symbols: {
      items: [
        { market: "us", code: "ZZQA", yahooSymbol: "ZZQA", name: "Synthetic Alpha", exchange: "NASDAQ", kind: "stock", source: "Yahoo Finance" },
        { market: "us", code: "ZZQB", yahooSymbol: "ZZQB", name: "Synthetic Beta", exchange: "NASDAQ", kind: "stock", source: "Yahoo Finance" },
      ],
    },
  };
  const groupNames = () => screen.getAllByRole("group").map((group) => group.querySelector("[role='presentation'] > span")?.textContent);
  const helpOption = () => screen.getByRole("option", { name: /단축키 도움말/ });

  it("늦게 온 종목 찾기 묶음이 명령 앞에 끼어도 고른 줄은 '단축키 도움말' 그대로 — aria-activedescendant가 따라가고 Enter는 명령을 실행한다(QA-557)", async () => {
    reads[endpoints.detail.symbols("help")] = LATE_SYMBOLS;
    openSearch();
    await act(async () => {});
    type("help");
    expect(groupNames()).toEqual(["명령"]);
    expect(helpOption().getAttribute("aria-selected")).toBe("true");

    await screen.findByRole("group", { name: "종목 찾기 · Yahoo·네이버" });
    // 묶음 순서는 그대로(색인 범주 → 종목 찾기 → 명령) — 고른 줄만 id로 남는다.
    expect(groupNames()).toEqual(["종목 찾기 · Yahoo·네이버", "명령"]);
    expect(helpOption().getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(helpOption().id);
    expect(screen.getByRole("option", { name: /Synthetic Alpha/ }).getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "단축키" })).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("색인 결과와 명령이 함께 맞을 때 ↑로 고른 명령은 늦게 온 종목 찾기 묶음 뒤에도 고른 줄이다(QA-557)", async () => {
    reads[endpoints.detail.symbols("ㄷㅇ")] = LATE_SYMBOLS;
    openSearch();
    await act(async () => {});
    type("ㄷㅇ");   // 메뉴 'AI 종합 분석'(초성 ㄷㅇ — 더보기)과 명령 '단축키 도움말'
    expect(groupNames()).toEqual(["메뉴", "명령"]);
    fireEvent.keyDown(input(), { key: "ArrowUp" });   // 맨 위에서 위로 → 맨 아래(명령)
    expect(helpOption().getAttribute("aria-selected")).toBe("true");

    await screen.findByRole("group", { name: "종목 찾기 · Yahoo·네이버" });
    expect(groupNames()).toEqual(["메뉴", "종목 찾기 · Yahoo·네이버", "명령"]);
    expect(helpOption().getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(helpOption().id);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "단축키" })).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  // QA-557 후속: 늦게 온 묶음이 고른 줄 앞에 끼면 고른 줄은 같아도 순번이 밀려 목록 상자(max-h 448px)의 보이는 영역 밖으로 나갈 수 있다 —
  // 그때 그 줄을 block 'nearest'로 보이게 스크롤한다. 마우스로 가리켜 고른 줄(순번은 그대로, 고른 줄만 바뀜)은 스크롤하지 않는다.
  // 수정 전(재현 커밋에서는 it.fails)에는 스크롤을 ↑↓(moveTo)에서만 맞춰 응답 뒤에는 scrollIntoView를 부르지 않았고(scrolled = []), 운영 빌드
  // 1440·1024에서 'he'+↑에 종목 찾기 2건이 오면 목록 181~629 밖의 고른 줄(657~697)이 보이지 않은 채 Enter가 그 줄을 실행했다.
  it("늦게 온 묶음에 밀린 고른 줄은 보이게 스크롤하고, 마우스로 가리켜 고른 줄은 스크롤하지 않는다(QA-557)", async () => {
    reads[endpoints.detail.symbols("ㄷㅇ")] = LATE_SYMBOLS;
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    openSearch();
    await act(async () => {});
    type("ㄷㅇ");
    fireEvent.keyDown(input(), { key: "ArrowUp" });   // 맨 위에서 위로 → 맨 아래(명령) — ↑↓는 지금처럼 moveTo가 스크롤
    expect(helpOption().getAttribute("aria-selected")).toBe("true");
    expect(scrolled.at(-1)).toBe(helpOption());
    scroll.mockClear();
    scrolled.length = 0;

    await screen.findByRole("group", { name: "종목 찾기 · Yahoo·네이버" });
    expect(helpOption().getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual([helpOption()]);
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });

    scroll.mockClear();
    scrolled.length = 0;
    const alpha = screen.getByRole("option", { name: /Synthetic Alpha/ });
    fireEvent.mouseMove(alpha);
    expect(alpha.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual([]);
  });

  it("왼쪽 메뉴 접기·펼치기는 넓은 화면에서만 보이고, 고르면 팔레트를 닫은 뒤 셸 명령 toggle-nav를 보낸다", async () => {
    stubWide(false);
    openSearch();
    await act(async () => {});
    type("메뉴 접기");
    expect(commandGroup()).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    stubWide(true);
    fireEvent.click(trigger());
    await act(async () => {});
    type("메뉴 접기");
    const option = within(commandGroup() as HTMLElement).getByRole("option", { name: /왼쪽 메뉴 접기·펼치기/ });
    expect(spokenText(option)).toBe("왼쪽 메뉴 접기·펼치기단축키 [");
    fireEvent.click(option);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(commands).toEqual(["toggle-nav"]));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "단축키" })).toBeNull();
  });
});
