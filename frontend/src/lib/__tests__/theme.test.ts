/**
 * 테마 규칙(lib/theme.ts) — 저장값 해석·저장·적용과 <head> 인라인 스크립트.
 *  - "light"·"dark"만 명시 선택, 나머지(없음·옛 값·이상한 값)는 시스템 따름
 *  - 시스템 따름은 저장 키와 data-theme 속성을 지운다(CSS 미디어 쿼리에 맡김)
 *  - 저장소가 막혀 있어도 던지지 않는다(사생활 보호 창)
 *  - 인라인 스크립트는 같은 키·같은 규칙으로 명시 선택만 붙인다
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  parseTheme,
  readStoredTheme,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_SCRIPT,
  THEME_STORAGE_KEY,
  writeStoredTheme,
  type ThemeStorage,
} from "../theme";

afterEach(() => {
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  window.localStorage.clear();
});

/** 메모리 저장소 — getItem이 없는 키에 null을 돌려주는 것까지 브라우저와 같게. */
function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

const blocked: ThemeStorage = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
  removeItem: () => { throw new Error("SecurityError"); },
};

describe("저장값 해석", () => {
  it("light·dark만 명시 선택이고, 없거나 모르는 값은 시스템 따름", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });

  it("고르는 순서는 시스템·라이트·다크, 저장 키는 theme", () => {
    expect(THEME_CHOICES).toEqual(["system", "light", "dark"]);
    expect(THEME_STORAGE_KEY).toBe("theme");
  });
});

describe("저장과 읽기", () => {
  it("명시 선택은 저장하고, 시스템 따름은 키를 지운다", () => {
    const storage = memoryStorage();
    expect(writeStoredTheme(storage, "dark")).toBe(true);
    expect(storage.data).toEqual({ theme: "dark" });
    expect(readStoredTheme(storage)).toBe("dark");

    expect(writeStoredTheme(storage, "system")).toBe(true);
    expect(storage.data).toEqual({});
    expect(readStoredTheme(storage)).toBe("system");
  });

  it("저장소가 없거나 막혀 있으면 읽기는 시스템 따름, 쓰기는 던지지 않고 false", () => {
    expect(readStoredTheme(null)).toBe("system");
    expect(readStoredTheme(blocked)).toBe("system");
    expect(writeStoredTheme(null, "dark")).toBe(false);
    expect(writeStoredTheme(blocked, "dark")).toBe(false);
    expect(writeStoredTheme(blocked, "system")).toBe(false);
  });
});

describe("적용", () => {
  it("명시 선택은 <html data-theme>를 붙이고, 시스템 따름은 지운다", () => {
    applyTheme(document, "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme(document, "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme(document, "system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("<head> 인라인 스크립트", () => {
  // 레이아웃이 문자열로 넣는 코드를 그대로 실행해 봅니다(브라우저가 하이드레이션 전에 하는 일).
  const runScript = () => new Function(THEME_SCRIPT)();

  it("저장된 light·dark를 첫 페인트 전에 붙인다", () => {
    for (const choice of ["light", "dark"] as const) {
      window.localStorage.setItem(THEME_STORAGE_KEY, choice);
      runScript();
      expect(document.documentElement.getAttribute("data-theme")).toBe(choice);
    }
  });

  it("저장값이 없거나 모르는 값이면 붙이지 않는다(시스템 따름) — parseTheme와 같은 규칙", () => {
    for (const raw of [null, "system", "sepia", ""]) {
      document.documentElement.removeAttribute(THEME_ATTRIBUTE);
      window.localStorage.clear();
      if (raw !== null) window.localStorage.setItem(THEME_STORAGE_KEY, raw);
      runScript();
      expect(document.documentElement.hasAttribute("data-theme")).toBe(parseTheme(raw) !== "system");
    }
  });

  it("localStorage 접근이 예외를 던져도 페이지를 깨뜨리지 않는다", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("SecurityError"); } });
    try {
      expect(runScript).not.toThrow();
      expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
