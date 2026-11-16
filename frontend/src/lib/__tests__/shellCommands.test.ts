/**
 * 셸 명령 신호(lib/shellCommands) — 보낸 명령은 그 이름을 듣는 쪽에만 닿고, 그만 들으면 닿지 않으며, 넓은 화면 판정은 matchMedia를 따른다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_COMMANDS, WIDE_SHELL_MEDIA, isShellCommand, isWideShell, onShellCommand, sendShellCommand } from "../shellCommands";

afterEach(() => vi.unstubAllGlobals());

describe("셸 명령 신호", () => {
  it("보낸 명령은 그 이름을 듣는 쪽에만 닿고, 그만 들으면 닿지 않는다", () => {
    const toggle = vi.fn();
    const help = vi.fn();
    const stopToggle = onShellCommand("toggle-nav", toggle);
    const stopHelp = onShellCommand("open-shortcut-help", help);
    sendShellCommand("toggle-nav");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(help).not.toHaveBeenCalled();
    stopToggle();
    sendShellCommand("toggle-nav");
    expect(toggle).toHaveBeenCalledTimes(1);
    stopHelp();
  });

  it("명령 목록은 닫혀 있고 화면 상태만 바꾸는 두 가지다 — 서버를 부르는 명령이 없다", () => {
    expect(SHELL_COMMANDS).toEqual(["toggle-nav", "open-shortcut-help"]);
    expect(isShellCommand("toggle-nav")).toBe(true);
    expect(isShellCommand("refresh")).toBe(false);
    expect(isShellCommand(undefined)).toBe(false);
  });

  it("넓은 화면 판정은 lg(64rem) 미디어 쿼리를 따른다", () => {
    expect(isWideShell()).toBe(false);
    const matchMedia = vi.fn((query: string) => ({ matches: query === WIDE_SHELL_MEDIA }) as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMedia);
    expect(isWideShell()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(min-width: 64rem)");
  });
});
