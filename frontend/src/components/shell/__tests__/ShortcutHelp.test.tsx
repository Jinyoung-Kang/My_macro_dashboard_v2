/**
 * 셸 단축키(?·/·[)와 단축키 도움말 창 — 명령 팔레트(SearchCommand)가 거는 창 keydown 처리기 하나가 받습니다.
 * ?는 도움말 창, /는 본문의 거르기 칸(data-shell-filter — 없으면 브라우저 기본 그대로), [는 넓은 화면에서만 셸 명령 toggle-nav.
 * 입력칸·한글 조합 중·수식키·대화상자 안에서는 글자로 들어갑니다. 도움말 창의 줄은 조건(넓은 화면·거르기 칸·보이는 목록)대로 보이고,
 * 목록 키는 따로 '목록' 표(P4)입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_COMMAND_EVENT, WIDE_SHELL_MEDIA, sendShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

import { SearchCommand } from "../SearchCommand";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "PRO" };

/** 셸 명령 신호를 받아 적습니다. */
let commands: string[];
const record = (event: Event) => commands.push(String((event as CustomEvent).detail));

function stubWide(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: wide && query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);
}

const helpDialog = () => screen.queryByRole("dialog", { name: "단축키" });
/** 도움말 표의 줄 — [키 글(읽는 글), 하는 일]. */
const rows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const [keys, action] = within(row).getAllByRole("cell");
      return [keys.textContent ?? "", action.textContent ?? ""];
    });

beforeEach(() => {
  commands = [];
  window.addEventListener(SHELL_COMMAND_EVENT, record);
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
});

afterEach(() => {
  window.removeEventListener(SHELL_COMMAND_EVENT, record);
  cleanup();
  vi.unstubAllGlobals();
});

describe("? — 단축키 도움말", () => {
  it("본문에서 ?를 누르면 '단축키' 대화상자가 열리고, Esc로 닫으면 누르기 전 포커스로 돌아간다 — 검색 자료는 읽지 않는다", async () => {
    render(
      <>
        <button type="button">앞 단추</button>
        <SearchCommand user={MEMBER} />
      </>,
    );
    const before = screen.getByRole("button", { name: "앞 단추" });
    before.focus();
    expect(fireEvent.keyDown(before, { key: "?", shiftKey: true })).toBe(false);
    const dialog = helpDialog();
    expect(dialog).toBeTruthy();
    expect(within(dialog as HTMLElement).getByRole("columnheader", { name: "키" })).toBeTruthy();
    expect(within(dialog as HTMLElement).getByRole("columnheader", { name: "하는 일" })).toBeTruthy();
    expect(api.apiGetShared).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog as HTMLElement, { key: "Escape" });
    expect(helpDialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("입력칸·글 상자 안, 한글 조합 중, Ctrl·⌘·Alt와 함께, 키 반복, 대화상자 안에서는 열리지 않고 글자로 들어간다", () => {
    render(
      <>
        <input aria-label="메모" />
        <textarea aria-label="긴 메모" />
        <div role="dialog" aria-label="다른 창">
          <button type="button">창 안 단추</button>
        </div>
        <SearchCommand user={MEMBER} />
      </>,
    );
    const memo = screen.getByRole("textbox", { name: "메모" });
    const long = screen.getByRole("textbox", { name: "긴 메모" });
    const inDialog = screen.getByRole("button", { name: "창 안 단추" });
    expect(fireEvent.keyDown(memo, { key: "?", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(long, { key: "?", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(inDialog, { key: "?", shiftKey: true })).toBe(true);
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      expect(fireEvent.keyDown(document.body, { key: "?", shiftKey: true, ...init }), JSON.stringify(init)).toBe(true);
    }
    expect(helpDialog()).toBeNull();
  });

  it("셸 명령 open-shortcut-help(계정 메뉴의 '단축키 도움말')로도 열린다", () => {
    render(<SearchCommand user={MEMBER} />);
    act(() => sendShellCommand("open-shortcut-help"));
    expect(helpDialog()).toBeTruthy();
  });

  it("명령 팔레트가 열려 있으면 ?는 검색어 입력칸에 글자로 들어간다(도움말이 열리지 않음)", () => {
    render(<SearchCommand user={MEMBER} />);
    fireEvent.click(screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" }));
    const input = screen.getByRole("combobox", { name: "검색어" });
    expect(fireEvent.keyDown(input, { key: "?", shiftKey: true })).toBe(true);
    expect(helpDialog()).toBeNull();
  });
});

describe("도움말 표 — 줄은 조건대로", () => {
  it("좁은 화면·거르기 칸 없음: 팔레트·도움말·닫기·결과 이동만 — 메뉴 접기([)와 거르기(/)는 빠진다", () => {
    render(<SearchCommand user={MEMBER} />);
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(rows()).toEqual([
      ["Ctrl K", "명령 팔레트(통합 검색) 열기"],
      ["?", "단축키 도움말"],
      ["Esc", "열린 창·메뉴 닫기"],
      ["↑↓Enter위·아래 화살표와 Enter", "팔레트 결과 고르기·열기"],
    ]);
    // 기호 조각(화살표)은 장식으로 감추고 이름을 읽어 준다.
    const move = within(screen.getByRole("table")).getAllByRole("row")[4];
    expect(move.querySelector("[aria-hidden='true']")?.textContent).toBe("↑↓Enter");
    expect(move.querySelector(".sr-only")?.textContent).toBe("위·아래 화살표와 Enter");
    expect(screen.getByText("입력칸에 글을 쓰는 중이거나 한글을 조합하는 중에는 ?·/·[가 글자로 들어갑니다.")).toBeTruthy();
  });

  it("넓은 화면·거르기 칸 있음: 여섯 줄 모두, 맥이면 ⌘K — 키는 kbd 조각", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    stubWide(true);
    render(
      <>
        <main id="main">
          <input data-shell-filter="" aria-label="거르기" />
        </main>
        <SearchCommand user={MEMBER} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(rows().map(([keys]) => keys)).toEqual(["⌘K", "?", "/", "[", "Esc", "↑↓Enter위·아래 화살표와 Enter"]);
    const kbd = within(screen.getByRole("table")).getAllByRole("row")[1].querySelector("kbd");
    expect(kbd?.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-border-strong", "font-mono", "text-xs", "text-text-2"]));
  });
});

describe("도움말 표 — '목록' 묶음(P4)", () => {
  /** 표 하나의 줄 — [키 글, 하는 일]. */
  const rowsOf = (table: HTMLElement) =>
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => {
        const [keys, action] = within(row).getAllByRole("cell");
        return [keys.textContent ?? "", action.textContent ?? ""];
      });

  it("본문에 보이는 목록(data-shell-list)이 있으면 둘째 표 '목록'(보이는 caption)에 j/k·Home/End·Esc 줄이 나온다", () => {
    render(
      <>
        <main id="main">
          <ul data-shell-list="" aria-label="상위 보유 종목">
            <li>
              <button type="button">Apple</button>
            </li>
          </ul>
        </main>
        <SearchCommand user={MEMBER} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const tables = within(helpDialog() as HTMLElement).getAllByRole("table");
    expect(tables).toHaveLength(2);
    expect(rowsOf(tables[0]).map(([keys]) => keys)).toEqual(["Ctrl K", "?", "Esc", "↑↓Enter위·아래 화살표와 Enter"]);
    const list = screen.getByRole("table", { name: "목록 — 목록에 포커스가 있을 때" });
    expect(list).toBe(tables[1]);
    expect(list.querySelector("caption")?.className).not.toContain("sr-only");
    expect(rowsOf(list)).toEqual([
      ["jk", "목록의 다음·앞 항목(↓·↑도 같음)"],
      ["HomeEnd", "목록의 처음·끝 항목"],
      ["Esc", "고른 항목 닫기(넓은 화면의 검사 칸)"],
    ]);
  });

  it("목록이 숨어 있으면(hidden 조상) '목록' 표가 없다 — 표 하나", () => {
    render(
      <>
        <main id="main">
          <div hidden>
            <ul data-shell-list="" aria-label="숨은 목록" />
          </div>
        </main>
        <SearchCommand user={MEMBER} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(within(helpDialog() as HTMLElement).getAllByRole("table")).toHaveLength(1);
    expect(screen.queryByRole("table", { name: "목록 — 목록에 포커스가 있을 때" })).toBeNull();
  });
});

describe("/ — 화면의 거르기 칸", () => {
  it("본문(main#main)에 data-shell-filter 칸이 있으면 그 칸으로 포커스하고 글을 고르며 기본 동작을 막는다", () => {
    render(
      <>
        <main id="main">
          <input data-shell-filter="" aria-label="거르기" defaultValue="삼성" />
        </main>
        <SearchCommand user={MEMBER} />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "거르기" }) as HTMLInputElement;
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 2]);
  });

  it("칸이 없으면 아무것도 하지 않는다 — 브라우저 기본 그대로", () => {
    render(
      <>
        <main id="main">
          <input aria-label="속성 없는 칸" />
        </main>
        <SearchCommand user={MEMBER} />
      </>,
    );
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("[ — 왼쪽 메뉴 접기 신호", () => {
  it("넓은 화면(64rem 이상)에서만 셸 명령 toggle-nav를 보낸다 — 좁은 화면이면 아무것도 하지 않는다", () => {
    render(<SearchCommand user={MEMBER} />);
    expect(fireEvent.keyDown(document.body, { key: "[" })).toBe(true);
    expect(commands).toEqual([]);

    stubWide(true);
    expect(fireEvent.keyDown(document.body, { key: "[" })).toBe(false);
    expect(commands).toEqual(["toggle-nav"]);
    // 단추(입력칸이 아님)에 포커스가 있어도 보낸다 — 물리 키(BracketLeft)로도.
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" }), { key: "[", code: "BracketLeft" })).toBe(false);
    expect(commands).toEqual(["toggle-nav", "toggle-nav"]);
  });

  it("입력칸 안·한글 조합 중이면 넓은 화면에서도 보내지 않는다", () => {
    stubWide(true);
    render(
      <>
        <input aria-label="메모" />
        <SearchCommand user={MEMBER} />
      </>,
    );
    expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "메모" }), { key: "[" })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "[", isComposing: true })).toBe(true);
    expect(commands).toEqual([]);
  });
});
