/**
 * 셸 단축키 판정(lib/shortcuts) — 팔레트 화음(맥 ⌘K·그 밖 Ctrl+K·물리 키 KeyK, 열린 메뉴 안 가리기), 한 글자 키(? · / · [)를 끄는 자리(입력칸·편집 영역·
 * combobox·대화상자/메뉴 안·수식키·키 반복·한글 조합 중), 거르기 칸 찾기(숨김·비활성 건너뜀), 닫힌 단축키 표, 목록 키(j/k·↑↓·Home/End·Esc — P4)와
 * 보이는 목록 찾기, 도움말 묶음.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  SHELL_FILTER_ATTR,
  SHELL_LIST_ATTR,
  SHORTCUTS,
  findScreenFilter,
  findScreenList,
  isInMenu,
  isInOverlay,
  isPaletteChord,
  isTypingTarget,
  listKeyAction,
  singleKeyShortcut,
  visibleShortcutGroups,
  visibleShortcuts,
  type KeyEventLike,
} from "../shortcuts";

const key = (init: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: document.body, ...init,
});

/** DOM 조각을 body에 그리고 id로 찾습니다. */
function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("팔레트 화음", () => {
  it("맥은 ⌘K만 — Ctrl+K·⌘Ctrl K·Shift·Alt가 섞인 것은 아니다", () => {
    expect(isPaletteChord(key({ key: "k", metaKey: true }), true)).toBe(true);
    expect(isPaletteChord(key({ key: "K", metaKey: true }), true)).toBe(true);
    expect(isPaletteChord(key({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ key: "k", metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ key: "K", metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ key: "k", metaKey: true, altKey: true }), true)).toBe(false);
  });

  it("그 밖은 Ctrl+K만 — ⌘(Windows 키)K·그냥 K는 아니다", () => {
    expect(isPaletteChord(key({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(isPaletteChord(key({ key: "k", metaKey: true }), false)).toBe(false);
    expect(isPaletteChord(key({ key: "k" }), false)).toBe(false);
  });

  it("한글 자판에서 K 자리가 'ㅏ'로 와도 물리 키(KeyK)로 받고, 다른 물리 키는 받지 않는다", () => {
    expect(isPaletteChord(key({ key: "ㅏ", code: "KeyK", ctrlKey: true }), false)).toBe(true);
    expect(isPaletteChord(key({ key: "ㅏ", code: "KeyL", ctrlKey: true }), false)).toBe(false);
  });

  it("열린 메뉴(role menu) 안인지 가린다 — 메뉴 안의 화음은 셸이 팔레트를 겹쳐 열지 않는 자리(대화상자·입력칸은 아님)", () => {
    const host = mount(`
      <div role="menu"><div id="in-menu" role="menuitem" tabindex="-1">가</div></div>
      <div role="dialog"><input id="in-dialog" /></div>
      <input id="plain" />
    `);
    const at = (id: string) => host.querySelector(`#${id}`) as HTMLElement;
    expect(isInMenu(at("in-menu"))).toBe(true);
    expect(isInMenu(at("in-dialog"))).toBe(false);
    expect(isInMenu(at("plain"))).toBe(false);
    expect(isInMenu(null)).toBe(false);
  });

  it("한글 조합 중(isComposing·keyCode 229)이면 받지 않는다 — 조합을 끝낸 뒤 연다", () => {
    expect(isPaletteChord(key({ key: "k", ctrlKey: true, isComposing: true }), false)).toBe(false);
    expect(isPaletteChord(key({ key: "Process", code: "KeyK", ctrlKey: true, keyCode: 229 }), false)).toBe(false);
    expect(isPaletteChord(key({ key: "k", metaKey: true, isComposing: true }), true)).toBe(false);
    expect(isPaletteChord(key({ key: "k", metaKey: true, keyCode: 229 }), true)).toBe(false);
  });
});

describe("한 글자 단축키", () => {
  it("본문에서 ?는 도움말, /는 거르기 칸, [는 왼쪽 메뉴 접기 — 다른 글자는 아니다", () => {
    expect(singleKeyShortcut(key({ key: "?", shiftKey: true }))).toBe("help");
    expect(singleKeyShortcut(key({ key: "/" }))).toBe("filter");
    expect(singleKeyShortcut(key({ key: "[" }))).toBe("toggleNav");
    expect(singleKeyShortcut(key({ key: "k" }))).toBeNull();
    expect(singleKeyShortcut(key({ key: "]" }))).toBeNull();
  });

  it("[는 물리 키(BracketLeft)로도 받는다 — Shift와 함께('{')면 아니다", () => {
    expect(singleKeyShortcut(key({ key: "Unidentified", code: "BracketLeft" }))).toBe("toggleNav");
    expect(singleKeyShortcut(key({ key: "{", code: "BracketLeft", shiftKey: true }))).toBeNull();
  });

  it("Ctrl·⌘·Alt와 함께, 키 반복, 한글 조합 중(isComposing·keyCode 229)이면 끈다", () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(singleKeyShortcut(key({ key: "?", ...init })), JSON.stringify(init)).toBeNull();
      expect(singleKeyShortcut(key({ key: "/", ...init })), JSON.stringify(init)).toBeNull();
      expect(singleKeyShortcut(key({ key: "[", ...init })), JSON.stringify(init)).toBeNull();
    }
  });

  it("글을 쓰는 자리(입력칸·글 상자·고르기 상자·편집 영역·role textbox/combobox/searchbox)에서는 글자로 들어간다", () => {
    const host = mount(`
      <input id="input" />
      <input id="search" type="search" />
      <textarea id="textarea"></textarea>
      <select id="select"><option>가</option></select>
      <div id="editable" contenteditable="true"></div>
      <div id="textbox" role="textbox" tabindex="0"></div>
      <div id="combobox" role="combobox" tabindex="0"></div>
      <div id="searchbox" role="searchbox" tabindex="0"></div>
      <button id="button" type="button">단추</button>
    `);
    const at = (id: string) => host.querySelector(`#${id}`) as HTMLElement;
    // jsdom은 isContentEditable을 계산하지 않습니다 — 브라우저처럼 참으로 둡니다.
    Object.defineProperty(at("editable"), "isContentEditable", { value: true });
    for (const id of ["input", "search", "textarea", "select", "editable", "textbox", "combobox", "searchbox"]) {
      expect(isTypingTarget(at(id)), id).toBe(true);
      expect(singleKeyShortcut(key({ key: "?", target: at(id) })), id).toBeNull();
      expect(singleKeyShortcut(key({ key: "/", target: at(id) })), id).toBeNull();
      expect(singleKeyShortcut(key({ key: "[", target: at(id) })), id).toBeNull();
    }
    expect(isTypingTarget(at("button"))).toBe(false);
    expect(singleKeyShortcut(key({ key: "?", target: at("button") }))).toBe("help");
    expect(isTypingTarget(null)).toBe(false);
  });

  it("대화상자·경고 대화상자·메뉴 안에서는 끈다 — 그 덮개가 키를 쓴다", () => {
    const host = mount(`
      <div role="dialog"><button id="in-dialog">가</button></div>
      <div role="alertdialog"><button id="in-alert">나</button></div>
      <div role="menu"><div id="in-menu" role="menuitem" tabindex="-1">다</div></div>
      <div role="region"><button id="outside">라</button></div>
    `);
    const at = (id: string) => host.querySelector(`#${id}`) as HTMLElement;
    for (const id of ["in-dialog", "in-alert", "in-menu"]) {
      expect(isInOverlay(at(id)), id).toBe(true);
      expect(singleKeyShortcut(key({ key: "?", target: at(id) })), id).toBeNull();
    }
    expect(isInOverlay(at("outside"))).toBe(false);
    expect(singleKeyShortcut(key({ key: "?", target: at("outside") }))).toBe("help");
  });
});

describe("거르기 칸 찾기('/' 규약)", () => {
  it("숨은 칸(자신·조상의 hidden·aria-hidden·inert)과 쓸 수 없는 칸(disabled·aria-disabled)을 건너뛰고 첫 번째 칸을 고른다", () => {
    const host = mount(`
      <main id="main">
        <div hidden><input ${SHELL_FILTER_ATTR} id="a" /></div>
        <div aria-hidden="true"><input ${SHELL_FILTER_ATTR} id="b" /></div>
        <div inert><input ${SHELL_FILTER_ATTR} id="c" /></div>
        <input ${SHELL_FILTER_ATTR} id="d" disabled />
        <input ${SHELL_FILTER_ATTR} id="e" aria-disabled="true" />
        <input ${SHELL_FILTER_ATTR} id="f" hidden />
        <input ${SHELL_FILTER_ATTR} id="g" aria-label="거르기" />
        <input ${SHELL_FILTER_ATTR} id="h" />
      </main>
    `);
    expect((findScreenFilter(host.querySelector("#main") as HTMLElement) as unknown as HTMLElement).id).toBe("g");
  });

  it("칸이 없거나 뿌리가 없으면 null — '/'는 브라우저 기본 그대로", () => {
    const host = mount(`<main id="main"><input aria-label="속성 없는 칸" /></main>`);
    expect(findScreenFilter(host.querySelector("#main") as HTMLElement)).toBeNull();
    expect(findScreenFilter(null)).toBeNull();
  });
});

describe("단축키 표", () => {
  it("닫힌 표 — 팔레트·도움말·거르기·메뉴 접기·닫기·결과 이동 다음에 '목록' 묶음 셋(목록 이동·처음/끝·닫기), 조건은 거르기(filter)·메뉴 접기(wide)·목록(list)에만, 한 글자 키 표지는 ?·/·[에만", () => {
    expect(SHORTCUTS.map((row) => row.id)).toEqual(["palette", "help", "filter", "toggleNav", "close", "move", "listMove", "listEdge", "listClose"]);
    expect(SHORTCUTS.filter((row) => row.when).map((row) => [row.id, row.when])).toEqual([
      ["filter", "filter"],
      ["toggleNav", "wide"],
      ["listMove", "list"],
      ["listEdge", "list"],
      ["listClose", "list"],
    ]);
    expect(SHORTCUTS.filter((row) => row.group).map((row) => [row.id, row.group])).toEqual([
      ["listMove", "목록"],
      ["listEdge", "목록"],
      ["listClose", "목록"],
    ]);
    // 입력칸에서는 글자로 들어가는 한 글자 셸 키 — 도움말 끝 문장이 보이는 줄 가운데 이 표지가 있는 줄만 적는다(QA-563). 목록 키에는 없다.
    expect(SHORTCUTS.filter((row) => row.typesInInput).map((row) => row.id)).toEqual(["help", "filter", "toggleNav"]);
    expect(SHORTCUTS.find((row) => row.id === "listMove")?.keys).toEqual({ mac: ["j", "k"], other: ["j", "k"] });
    expect(SHORTCUTS.find((row) => row.id === "listEdge")?.keys).toEqual({ mac: ["Home", "End"], other: ["Home", "End"] });
    const palette = SHORTCUTS[0];
    expect(palette.keys).toEqual({ mac: ["⌘K"], other: ["Ctrl K"] });
  });

  it("도움말에 보일 줄 — 거르기(/)는 칸이 있을 때만, 메뉴 접기([)는 넓은 화면에서만", () => {
    const ids = (wide: boolean, filter: boolean) => visibleShortcuts({ wide, filter }).map((row) => row.id);
    expect(ids(false, false)).toEqual(["palette", "help", "close", "move"]);
    expect(ids(true, false)).toEqual(["palette", "help", "toggleNav", "close", "move"]);
    expect(ids(false, true)).toEqual(["palette", "help", "filter", "close", "move"]);
    expect(ids(true, true)).toEqual(["palette", "help", "filter", "toggleNav", "close", "move"]);
  });
});

describe("단축키 표 — '목록' 묶음(P4)", () => {
  it("목록 줄은 list 조건이 참일 때만 — 빠지거나 거짓이면 지금 여섯 줄 그대로", () => {
    const ids = (list?: boolean) => visibleShortcuts({ wide: true, filter: true, list }).map((row) => row.id);
    expect(ids(undefined)).toEqual(["palette", "help", "filter", "toggleNav", "close", "move"]);
    expect(ids(false)).toEqual(["palette", "help", "filter", "toggleNav", "close", "move"]);
    expect(ids(true)).toEqual(["palette", "help", "filter", "toggleNav", "close", "move", "listMove", "listEdge", "listClose"]);
  });

  it("도움말 묶음 — 첫 묶음(셸) · '목록' 차례, 줄이 없는 묶음은 뺀다", () => {
    const shape = (list?: boolean) =>
      visibleShortcutGroups({ wide: false, filter: false, list }).map((entry) => [entry.group, entry.rows.map((row) => row.id)]);
    expect(shape(false)).toEqual([[null, ["palette", "help", "close", "move"]]]);
    expect(shape(true)).toEqual([
      [null, ["palette", "help", "close", "move"]],
      ["목록", ["listMove", "listEdge", "listClose"]],
    ]);
  });
});

describe("보이는 목록 찾기(목록 묶음 조건)", () => {
  it("숨은 목록(자신·조상의 hidden·aria-hidden·inert)은 세지 않고, 하나라도 보이면 참", () => {
    const host = mount(`
      <main id="main">
        <div hidden><ul ${SHELL_LIST_ATTR}></ul></div>
        <div aria-hidden="true"><ul ${SHELL_LIST_ATTR}></ul></div>
        <div inert><ul ${SHELL_LIST_ATTR}></ul></div>
        <ul ${SHELL_LIST_ATTR} hidden></ul>
      </main>
    `);
    const main = host.querySelector("#main") as HTMLElement;
    expect(findScreenList(main)).toBe(false);
    const visible = document.createElement("ul");
    visible.setAttribute(SHELL_LIST_ATTR, "");
    main.append(visible);
    expect(findScreenList(main)).toBe(true);
  });

  it("목록이 없거나 뿌리가 없으면 거짓", () => {
    const host = mount(`<main id="main"><ul aria-label="속성 없는 목록"></ul></main>`);
    expect(findScreenList(host.querySelector("#main") as HTMLElement)).toBe(false);
    expect(findScreenList(null)).toBe(false);
    expect(SHELL_LIST_ATTR).toBe("data-shell-list");
  });
});

describe("목록 키(listKeyAction)", () => {
  it("j·↓ → 다음, k·↑ → 앞, Home → 처음, End → 끝, Esc → 닫기 — 다른 키는 null", () => {
    const table: [string, string | null][] = [
      ["j", "next"],
      ["ArrowDown", "next"],
      ["k", "prev"],
      ["ArrowUp", "prev"],
      ["Home", "first"],
      ["End", "last"],
      ["Escape", "close"],
      ["Enter", null],
      [" ", null],
      ["ArrowLeft", null],
      ["l", null],
      ["/", null],
      ["?", null],
    ];
    for (const [name, action] of table) expect(listKeyAction(key({ key: name })), name).toBe(action);
  });

  it("대문자 J·K(Shift와 함께)는 아니다 — 화살표는 Shift와 함께여도 받는다", () => {
    expect(listKeyAction(key({ key: "J", shiftKey: true }))).toBeNull();
    expect(listKeyAction(key({ key: "K", shiftKey: true }))).toBeNull();
    expect(listKeyAction(key({ key: "J" }))).toBeNull();
    expect(listKeyAction(key({ key: "j", shiftKey: true }))).toBeNull();
    expect(listKeyAction(key({ key: "ArrowDown", shiftKey: true }))).toBe("next");
  });

  it("한글 조합 중(isComposing·keyCode 229)·Ctrl/⌘/Alt와 함께면 null, 키 반복은 받는다", () => {
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const name of ["j", "k", "ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
        expect(listKeyAction(key({ key: name, ...init })), `${name} ${JSON.stringify(init)}`).toBeNull();
      }
    }
    expect(listKeyAction(key({ key: "j", repeat: true }))).toBe("next");
    expect(listKeyAction(key({ key: "ArrowUp", repeat: true }))).toBe("prev");
  });

  it("글을 쓰는 자리(입력칸·role combobox 등)에서는 null — 단추·목록 줄에서는 받는다", () => {
    const host = mount(`
      <ul ${SHELL_LIST_ATTR}><li><button id="row" type="button">가</button></li></ul>
      <input id="input" />
      <div id="combobox" role="combobox" tabindex="0"></div>
    `);
    const at = (id: string) => host.querySelector(`#${id}`) as HTMLElement;
    expect(listKeyAction(key({ key: "j", target: at("input") }))).toBeNull();
    expect(listKeyAction(key({ key: "ArrowDown", target: at("combobox") }))).toBeNull();
    expect(listKeyAction(key({ key: "j", target: at("row") }))).toBe("next");
  });
});
