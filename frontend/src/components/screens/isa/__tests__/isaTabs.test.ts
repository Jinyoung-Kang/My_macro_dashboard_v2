/**
 * 'ISA 계좌' 탭의 시장 제한(ADR 0029, 명세 §8) — lib/paper의 시장 제한 칸(markets)과 탭 줄 고르기.
 *
 *  - PAPER_TABS 맨 끝(실제 계좌 다음)에 isa — 한국만(markets ["KR"]), 다른 탭은 제한 없음(두 시장 그대로)
 *  - 한국 탭 줄 = 아홉 탭(끝이 실제 계좌·ISA 계좌), 미국 탭 줄 = 예전 여덟 탭 그대로
 *  - 주소 조각은 두 시장 모두 있음(/paper/us/isa는 404가 아니라 화면이 개요로 엶 — 경로 규칙 lib/paperRoutes 그대로)
 */
import { describe, expect, it } from "vitest";
import { PAPER_TABS, paperTabInMarket, paperTabsFor } from "@/lib/paper";
import { paperRouteFromPath, paperTabFromSlug, paperTabPath } from "@/lib/paperRoutes";

describe("ISA 계좌 탭 — 한국만", () => {
  it("PAPER_TABS 맨 끝, 실제 계좌 다음 — 한국만 제한, 나머지는 제한 없음", () => {
    const last = PAPER_TABS[PAPER_TABS.length - 1];
    expect(last).toEqual({ key: "isa", label: "ISA 계좌", opensIn: null, upcoming: null, markets: ["KR"] });
    expect(PAPER_TABS[PAPER_TABS.length - 2].key).toBe("real");
    expect(PAPER_TABS.filter((tab) => "markets" in tab).map((tab) => tab.key)).toEqual(["isa"]);
  });

  it("그 시장의 탭인가 — isa는 한국만, 다른 탭은 두 시장 모두", () => {
    expect(paperTabInMarket("isa", "KR")).toBe(true);
    expect(paperTabInMarket("isa", "US")).toBe(false);
    for (const tab of PAPER_TABS.filter((entry) => entry.key !== "isa")) {
      expect(paperTabInMarket(tab.key, "US"), tab.key).toBe(true);
      expect(paperTabInMarket(tab.key, "KR"), tab.key).toBe(true);
    }
  });

  it("탭 줄 — 한국은 끝에 ISA 계좌, 미국은 예전 여덟 탭 그대로", () => {
    expect(paperTabsFor("KR").map((tab) => tab.key)).toEqual([
      "overview", "selection", "holdings", "decisions", "framework", "notes", "settings", "real", "isa",
    ]);
    expect(paperTabsFor("US").map((tab) => tab.key)).toEqual([
      "overview", "selection", "holdings", "decisions", "framework", "notes", "settings", "real",
    ]);
  });

  it("주소 — /paper/kr/isa는 한국 ISA 탭, /paper/us/isa도 있는 주소(화면이 개요로 엶)", () => {
    expect(paperTabPath("isa", "KR")).toBe("/paper/kr/isa");
    expect(paperTabFromSlug("isa")).toBe("isa");
    expect(paperRouteFromPath("/paper/kr/isa")).toEqual({ market: "KR", tab: "isa" });
    expect(paperRouteFromPath("/paper/us/isa")).toEqual({ market: "US", tab: "isa" });
    expect(paperTabFromSlug("ISA")).toBeNull();
  });
});
