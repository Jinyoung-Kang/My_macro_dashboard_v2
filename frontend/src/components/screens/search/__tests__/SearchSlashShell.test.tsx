/**
 * 정보 검색 화면의 '/' — 셸 단축키 하나로(작업대 실행 명세 §5 '단축키', 진행 기록 §P3 '정한 것' 7을 P7 정보 검색 정리에서 합침).
 *
 * 검색창은 셸의 거르기 칸 표지(data-shell-filter)를 달고, '/'는 셸 처리기(hooks/useShellShortcuts — 판정 lib/shortcuts singleKeyShortcut)가 본문
 * (main#main)의 그 칸에 포커스하고 글을 고릅니다. 이 화면이 따로 '/'를 받던 처리(hooks/useInfoSearch useSlashShortcut·lib/infoSearch isSlashShortcut)는
 * 지웠고, 그 시험(다른 입력칸에서 친 '/'는 글자, 열린 메뉴 안·키 반복이면 그대로 — QA-562)을 셸 경로의 사례로 옮겼습니다. 응답은 합성 값입니다.
 */
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

import { useShellShortcuts } from "@/hooks/useShellShortcuts";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

/** 셸 단축키 처리기 — 셸(SearchCommand)이 한 번 거는 것과 같은 훅. */
function ShellKeys() {
  useShellShortcuts({ isMac: false, onPalette: () => {}, onHelp: () => {} });
  return null;
}

/** 정보 검색 화면을 본문(main#main) 안에 그립니다. shell이 false면 셸 처리기 없이. */
function renderSearch({ shell = true, path = "/search?q=%EC%97%94%EB%B9%84%EB%94%94%EC%95%84" } = {}) {
  setLocation(path);
  return render(
    <>
      {shell ? <ShellKeys /> : null}
      <main id="main">
        <SessionUserProvider user={MEMBER}>
          <SearchScreen />
        </SessionUserProvider>
        <textarea aria-label="메모" />
        <div role="menu" tabIndex={-1} aria-label="계정 메뉴">
          <div role="menuitem" tabIndex={-1}>
            단축키 도움말
          </div>
        </div>
      </main>
    </>,
  );
}

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  // 응답은 끝나지 않습니다(읽는 중) — 이 시험은 키만 봅니다.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  api.apiGet.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => cleanup());

describe("정보 검색 화면의 '/' — 셸 경로 하나", () => {
  it("'/'를 누르면 셸이 검색창에 포커스하고 글을 고른다(기본 동작을 막음)", () => {
    renderSearch();
    const input = screen.getByRole("combobox", { name: "대상 검색" }) as HTMLInputElement;
    expect(input.value).toBe("엔비디아");
    const prevented = !fireEvent.keyDown(document.body, { key: "/", code: "Slash" });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "엔비디아".length]);
  });

  it("다른 입력칸에서 친 '/'는 그대로 글자 — 포커스를 옮기지 않는다", () => {
    renderSearch();
    const memo = screen.getByLabelText("메모");
    memo.focus();
    expect(fireEvent.keyDown(memo, { key: "/", code: "Slash" })).toBe(true);
    expect(document.activeElement).toBe(memo);
  });

  // QA-562(옮긴 사례): 열린 메뉴(role menu) 안의 '/'와 키 반복은 셸 판정이 끕니다 — 기본 동작을 막지 않고 포커스도 옮기지 않습니다.
  it("열린 메뉴 안·키 반복·한글 조합 중·수식키와 함께 친 '/'는 그대로 둔다(QA-562)", () => {
    renderSearch();
    const menu = screen.getByRole("menu", { name: "계정 메뉴" });
    menu.focus();
    expect(fireEvent.keyDown(menu, { key: "/", code: "Slash" })).toBe(true);
    expect(document.activeElement).toBe(menu);

    menu.blur();
    for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(fireEvent.keyDown(document.body, { key: "/", code: "Slash", ...extra }), JSON.stringify(extra)).toBe(true);
      expect(document.activeElement, JSON.stringify(extra)).toBe(document.body);
    }
  });

  it("이 화면은 따로 '/'를 받지 않는다 — 셸 처리기가 없으면 '/'는 브라우저 기본 그대로(처리기가 둘이 아님)", () => {
    renderSearch({ shell: false });
    expect(fireEvent.keyDown(document.body, { key: "/", code: "Slash" })).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});
