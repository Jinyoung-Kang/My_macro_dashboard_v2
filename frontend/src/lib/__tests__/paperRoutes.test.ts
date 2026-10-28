/**
 * 모의매매(미국) 경로 ↔ 탭(lib/paperRoutes) — `[tab]` 라우트와 화면의 주소 맞추기가 같은 규칙을 쓴다.
 *
 *  - 개요는 /paper/us, 여섯 탭은 /paper/us/<키>(탭 순서 그대로) — generateStaticParams가 이 목록을 쓴다
 *  - 모르는 조각·"overview"·대소문자 다른 글자는 null(라우트가 404) — 비슷한 주소를 다른 탭으로 열지 않는다
 *  - 지금 주소 → 탭: /paper/us(끝 '/' 허용)는 개요, 옛 /paper·/paper/kr·더 깊은 경로는 null(지금 탭을 그대로 둠)
 *  - 한국(2단계 명세 §4-16, 사용자 결정 2026-10-29): /paper/kr 개요 + /paper/kr/<미국과 같은 탭 키>, 시장 인자 기본값은 미국 그대로
 */
import { describe, expect, it } from "vitest";

import { PAPER_TABS } from "../paper";
import {
  PAPER_KR_PATH,
  PAPER_TAB_SLUGS,
  PAPER_US_PATH,
  paperMarketPath,
  paperRouteFromPath,
  paperTabFromPath,
  paperTabFromSlug,
  paperTabPath,
} from "../paperRoutes";

describe("탭 주소", () => {
  it("개요 밖의 여섯 탭 — 탭 순서 그대로, 키가 곧 주소 조각", () => {
    expect(PAPER_TAB_SLUGS).toEqual(["selection", "holdings", "decisions", "framework", "notes", "settings"]);
    expect(PAPER_TAB_SLUGS).toEqual(PAPER_TABS.slice(1).map((tab) => tab.key));
  });

  it("탭 → 주소: 개요는 /paper/us, 나머지는 /paper/us/<키>", () => {
    expect(PAPER_US_PATH).toBe("/paper/us");
    expect(paperTabPath("overview")).toBe("/paper/us");
    expect(paperTabPath("holdings")).toBe("/paper/us/holdings");
    expect(paperTabPath("settings")).toBe("/paper/us/settings");
    expect(PAPER_TABS.map((tab) => paperTabPath(tab.key))).toEqual([
      "/paper/us", "/paper/us/selection", "/paper/us/holdings", "/paper/us/decisions",
      "/paper/us/framework", "/paper/us/notes", "/paper/us/settings",
    ]);
  });
});

describe("주소 조각 → 탭([tab] 라우트)", () => {
  it("여섯 키는 그 탭", () => {
    for (const slug of PAPER_TAB_SLUGS) expect(paperTabFromSlug(slug)).toBe(slug);
  });

  it("모르는 조각·overview·대소문자·공백이 다른 글자·빈 값은 null — 라우트가 404로 보낸다", () => {
    for (const slug of ["overview", "Holdings", " holdings", "holdings ", "reviews", "", "us", "holdings/x"]) {
      expect(paperTabFromSlug(slug), slug).toBeNull();
    }
    expect(paperTabFromSlug(null)).toBeNull();
    expect(paperTabFromSlug(undefined)).toBeNull();
  });
});

describe("지금 주소 → 탭(화면이 주소를 따라감)", () => {
  it("/paper/us는 개요(끝 '/' 하나 허용), /paper/us/<키>는 그 탭", () => {
    expect(paperTabFromPath("/paper/us")).toBe("overview");
    expect(paperTabFromPath("/paper/us/")).toBe("overview");
    expect(paperTabFromPath("/paper/us/decisions")).toBe("decisions");
    expect(paperTabFromPath("/paper/us/notes/")).toBe("notes");
    // 주소 → 탭 → 주소가 제자리로 돌아온다
    for (const tab of PAPER_TABS) expect(paperTabFromPath(paperTabPath(tab.key))).toBe(tab.key);
  });

  it("옛 /paper·2단계 /paper/kr·모르는 조각·더 깊은 경로·null은 null", () => {
    for (const path of ["/paper", "/paper/kr", "/paper/kr/holdings", "/paper/us/overview", "/paper/us/x", "/paper/us/holdings/1", "/paper/usa", "/"]) {
      expect(paperTabFromPath(path), path).toBeNull();
    }
    expect(paperTabFromPath(null)).toBeNull();
  });
});

describe("한국 화면 주소(/paper/kr)", () => {
  it("뿌리 경로와 탭 주소 — 미국과 같은 일곱 탭, 시장 인자 기본값은 미국", () => {
    expect(PAPER_KR_PATH).toBe("/paper/kr");
    expect(paperMarketPath("KR")).toBe("/paper/kr");
    expect(paperMarketPath("US")).toBe("/paper/us");
    expect(paperMarketPath()).toBe("/paper/us");
    expect(paperTabPath("overview", "KR")).toBe("/paper/kr");
    expect(paperTabPath("holdings", "KR")).toBe("/paper/kr/holdings");
    expect(PAPER_TABS.map((tab) => paperTabPath(tab.key, "KR"))).toEqual([
      "/paper/kr", "/paper/kr/selection", "/paper/kr/holdings", "/paper/kr/decisions",
      "/paper/kr/framework", "/paper/kr/notes", "/paper/kr/settings",
    ]);
  });

  it("주소 → 시장·탭: /paper/kr는 한국 개요, /paper/kr/<키>는 그 탭, /paper/us도 같은 규칙", () => {
    expect(paperRouteFromPath("/paper/kr")).toEqual({ market: "KR", tab: "overview" });
    expect(paperRouteFromPath("/paper/kr/")).toEqual({ market: "KR", tab: "overview" });
    expect(paperRouteFromPath("/paper/kr/holdings")).toEqual({ market: "KR", tab: "holdings" });
    expect(paperRouteFromPath("/paper/us/settings")).toEqual({ market: "US", tab: "settings" });
    for (const market of ["US", "KR"] as const) {
      for (const tab of PAPER_TABS) expect(paperRouteFromPath(paperTabPath(tab.key, market))).toEqual({ market, tab: tab.key });
    }
  });

  it("모르는 조각·overview·대소문자가 다른 시장·더 깊은 경로는 null", () => {
    for (const path of ["/paper", "/paper/kr/overview", "/paper/KR", "/paper/kr/Holdings", "/paper/kr/holdings/1", "/paper/krx", "/"]) {
      expect(paperRouteFromPath(path), path).toBeNull();
    }
    expect(paperRouteFromPath(null)).toBeNull();
  });

  it("그 시장 화면의 탭 — 다른 시장 주소는 null(미국 기본값의 뜻 그대로)", () => {
    expect(paperTabFromPath("/paper/kr/holdings", "KR")).toBe("holdings");
    expect(paperTabFromPath("/paper/kr", "KR")).toBe("overview");
    expect(paperTabFromPath("/paper/us/holdings", "KR")).toBeNull();
    expect(paperTabFromPath("/paper/kr/holdings")).toBeNull();
    expect(paperTabFromPath("/paper/kr/holdings", "US")).toBeNull();
  });
});
