/**
 * 없앤 테마 선택의 남은 값 지우기(ADR 0042 결정 2) — 첫 페인트 전 인라인 스크립트를 실제로 돌려 봅니다.
 *  - localStorage["theme"]를 지우고 다른 키는 그대로 둔다
 *  - 저장소 접근이 예외를 던져도(막힌 브라우저) 스크립트가 던지지 않는다
 *  - `<html>`에 data-theme 같은 속성을 붙이지 않는다(어두운 한 벌 하나)
 */
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_THEME_CLEANUP_SCRIPT, LEGACY_THEME_KEY } from "@/lib/legacyTheme";

const run = (win: unknown) => new Function("window", LEGACY_THEME_CLEANUP_SCRIPT)(win);

afterEach(() => window.localStorage.clear());

describe("옛 테마 선택 지우기", () => {
  it("남은 theme 값을 지우고 다른 키는 그대로 둔다 — <html>에는 아무 속성도 붙이지 않는다", () => {
    window.localStorage.setItem(LEGACY_THEME_KEY, "light");
    window.localStorage.setItem("other", "kept");
    run(window);
    expect(window.localStorage.getItem(LEGACY_THEME_KEY)).toBeNull();
    expect(window.localStorage.getItem("other")).toBe("kept");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("값이 없어도, 저장소 접근이 예외를 던져도 조용히 넘어간다", () => {
    expect(() => run(window)).not.toThrow();
    const blocked = {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    };
    expect(() => run(blocked)).not.toThrow();
    expect(() => run({ localStorage: { removeItem: () => { throw new Error("QuotaExceeded"); } } })).not.toThrow();
  });

  it("옛 키 이름은 theme(2026-11-15까지 테마 전환이 쓰던 값)", () => {
    expect(LEGACY_THEME_KEY).toBe("theme");
    expect(LEGACY_THEME_CLEANUP_SCRIPT).toContain('removeItem("theme")');
    expect(LEGACY_THEME_CLEANUP_SCRIPT).not.toContain("getItem");
  });
});
