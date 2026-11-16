/**
 * 최근 연 대상 저장소(hooks/useRecentEntities) — localStorage에만 두고, 못 읽거나 못 쓰면(던짐) 빈 목록·이 창 안에서만 기억하며 화면은 그대로,
 * 다른 탭의 변경(storage 이벤트)을 따라오고, 저장값은 읽을 때 형식 검사를 거친다.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECENT_STORAGE_KEY, serializeRecent, type RecentEntity } from "@/lib/palette";
import { rememberRecentEntity, resetRecentEntitiesForTest, useRecentEntities } from "../useRecentEntities";

const APPLE: RecentEntity = { kind: "ticker", label: "Apple Inc.", sub: "AAPL · Technology", href: "/s/us/AAPL", dest: "종목 상세" };
const SP500: RecentEntity = { kind: "indicator", label: "S&P 500", sub: "주가지수 · ^GSPC", href: "/markets/i/sp500", dest: "지표 상세" };

beforeEach(() => {
  window.localStorage.clear();
  resetRecentEntitiesForTest();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useRecentEntities", () => {
  it("저장값이 없으면 빈 목록, 있으면 형식 검사를 거친 목록", () => {
    expect(renderHook(() => useRecentEntities()).result.current).toEqual([]);

    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify({ v: 1, items: [APPLE, { ...SP500, href: "javascript:alert(1)" }] }));
    resetRecentEntitiesForTest();
    expect(renderHook(() => useRecentEntities()).result.current).toEqual([APPLE]);
  });

  it("rememberRecentEntity — 맨 앞에 넣고 저장하며 그린 화면이 따라온다", () => {
    const { result } = renderHook(() => useRecentEntities());
    act(() => rememberRecentEntity(APPLE));
    act(() => rememberRecentEntity(SP500));
    act(() => rememberRecentEntity(APPLE));
    expect(result.current.map((entity) => entity.label)).toEqual(["Apple Inc.", "S&P 500"]);
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "null")).toEqual({ v: 1, items: [APPLE, SP500] });
  });

  it("저장소를 읽을 때 던지면(막힌 사이트 자료) 빈 목록으로 그린다", () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([APPLE]));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { result } = renderHook(() => useRecentEntities());
    expect(result.current).toEqual([]);
  });

  it("저장소에 쓸 때 던지면(사생활 보호 창·용량) 이 창 안에서만 기억한다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { result } = renderHook(() => useRecentEntities());
    expect(() => act(() => rememberRecentEntity(APPLE))).not.toThrow();
    expect(result.current).toEqual([APPLE]);
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });

  it("다른 탭에서 바꾸면(storage 이벤트) 따라온다 — 다른 키의 변경은 무시하고, 저장소를 비우면(key null) 빈 목록", () => {
    const { result } = renderHook(() => useRecentEntities());
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([SP500]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "other.key" }));
    });
    expect(result.current).toEqual([]);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: RECENT_STORAGE_KEY }));
    });
    expect(result.current).toEqual([SP500]);
    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toEqual([]);
  });
});
