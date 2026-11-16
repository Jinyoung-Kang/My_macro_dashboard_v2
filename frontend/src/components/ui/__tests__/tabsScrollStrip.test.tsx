/**
 * 공용 탭 줄(Tabs)이 폭보다 길 때 — 고른 탭과 키보드로 옮긴 탭을 줄 안으로 보이게(2026-11-16 사용자 결정 1의 (나), 하위 메뉴 줄 QA-510과 같은 훅).
 * 예전에는 줄의 scrollLeft를 옮기지 않아, 반 폭 홈 시장 패널에서 뒤쪽 탭을 고른 뒤 다시 그리거나 고른 탭이 줄 밖에 있으면 그대로 가려져 있었습니다
 * (P4 QA 스택 확인 'home-market-group-tabs-clipped' — 390·1024·1280에서 다섯째 '아시아 주요 주가지수'가 첫 화면에서 보이지 않음).
 *
 * jsdom은 배치를 계산하지 않으므로 줄과 탭의 크기를 정해 둡니다 — 줄(tablist) 보이는 폭 332px, 탭 폭 120px·줄 안 왼쪽 위치 120 × 순서.
 * 줄을 스크롤하는 값(scrollLeft)은 jsdom이 기억합니다. 창 세로 스크롤을 건드리지 않게 scrollIntoView가 아니라 줄의 scrollLeft만 바꾸는지도 봅니다.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tabs, tabId } from "@/components/ui";

const STRIP_WIDTH = 332;
const TAB_WIDTH = 120;

const ITEMS = [
  { key: "fx", label: "통화 및 환율" },
  { key: "rates", label: "미국 국채 수익률" },
  { key: "commodities", label: "원자재" },
  { key: "us", label: "미국 주가지수 및 선물" },
  { key: "asia", label: "아시아 주요 주가지수" },
] as const;
type Key = (typeof ITEMS)[number]["key"];

/** 탭이 줄에서 몇째인가 — 탭이 아니면 -1. */
function indexOf(element: Element): number {
  if (element.getAttribute("role") !== "tab" || !element.parentElement) return -1;
  return [...element.parentElement.children].indexOf(element);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    const index = indexOf(this);
    return index < 0 ? 0 : index * TAB_WIDTH;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return indexOf(this) < 0 ? 0 : TAB_WIDTH;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("role") === "tablist" ? STRIP_WIDTH : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 포커스가 키보드로 왔는지(:focus-visible) 정해 둡니다 — jsdom의 focus()는 :focus-visible을 거짓으로 돌려주므로(하위 메뉴 줄 시험과 같음) 키보드 경우를
 * 흉내 냅니다. 키보드면 포커스한 요소만 참, 손가락·마우스면 늘 거짓.
 */
function stubFocusVisible(by: "keyboard" | "pointer"): void {
  const original = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    if (selector !== ":focus-visible") return original.call(this, selector);
    return by === "keyboard" && this === document.activeElement;
  });
}

function Harness({ initial = "fx", wrap = false }: { initial?: Key; wrap?: boolean }) {
  const [value, setValue] = useState<Key>(initial);
  return (
    <>
      <Tabs label="시장 묶음" items={ITEMS} value={value} onChange={setValue} idPrefix="mk" panelId="mk-panel" wrap={wrap} />
      <div role="tabpanel" id="mk-panel" aria-labelledby={tabId("mk", value)}>
        패널
      </div>
    </>
  );
}

const strip = () => screen.getByRole("tablist", { name: "시장 묶음" });
const tab = (name: string) => screen.getByRole("tab", { name });

describe("공용 탭 줄 — 넘칠 때 고른 탭·키보드로 옮긴 탭을 줄 안에 보이게 (결정 1 나)", () => {
  // 바꾸기 전에는 scrollLeft 0 그대로 — 고른 넷째 탭(360 ~ 480px)이 332px 줄 밖에 가려진 채 그려짐.
  it("처음 그릴 때 고른 탭이 줄 밖이면 그 탭이 오른쪽 여백 16px까지 보이게 줄을 옮겨 둔다", () => {
    render(<Harness initial="us" />);
    // 360 + 120 + 16 − 332
    expect(strip().scrollLeft).toBe(164);
  });

  // 바꾸기 전에는 scrollLeft 0 그대로 — 고른 다섯째 탭(480 ~ 600px)이 줄 밖.
  it("고른 탭이 바뀌면(누르기) 그 탭을 보이게 하고, 다 보이는 탭을 고르면 그대로 둔다", () => {
    render(<Harness />);
    expect(strip().scrollLeft).toBe(0);
    fireEvent.click(tab("원자재"));
    // 셋째 탭(240 ~ 360px)은 오른쪽이 28px 잘림 — 360 + 16 − 332
    expect(strip().scrollLeft).toBe(44);
    fireEvent.click(tab("아시아 주요 주가지수"));
    // 480 + 120 + 16 − 332
    expect(strip().scrollLeft).toBe(284);
    fireEvent.click(tab("미국 주가지수 및 선물"));
    // 넷째(360 ~ 480px)는 284 ~ 616 안에 다 보임 — 움직이지 않음
    expect(strip().scrollLeft).toBe(284);
  });

  // 바꾸기 전에는 화살표·End로 옮긴 탭에서도 줄이 움직이지 않음(jsdom — 브라우저는 focus()의 기본 스크롤이 창까지 움직일 수 있음).
  it("키보드로 옮긴 탭(화살표·End·Home)은 포커스가 들어올 때 보이게 한다 — 고르기 전에도", () => {
    stubFocusVisible("keyboard");
    render(<Harness />);
    act(() => tab("통화 및 환율").focus());
    fireEvent.keyDown(tab("통화 및 환율"), { key: "End" });
    expect(document.activeElement).toBe(tab("아시아 주요 주가지수"));
    expect(strip().scrollLeft).toBe(284);
    fireEvent.keyDown(tab("아시아 주요 주가지수"), { key: "Home" });
    expect(document.activeElement).toBe(tab("통화 및 환율"));
    // 왼쪽이 잘린 첫 탭 — 그 탭 왼쪽 16px 앞(0 미만은 0)
    expect(strip().scrollLeft).toBe(0);
    expect(tab("통화 및 환율").getAttribute("aria-selected")).toBe("true");
  });

  it("손가락·마우스로 누른 탭의 포커스로는 누르는 도중 줄을 움직이지 않는다 — 고른 뒤에 보인다", () => {
    stubFocusVisible("pointer");
    render(<Harness />);
    act(() => tab("아시아 주요 주가지수").focus());
    expect(strip().scrollLeft).toBe(0);
    fireEvent.click(tab("아시아 주요 주가지수"));
    expect(strip().scrollLeft).toBe(284);
  });

  it("창 세로 스크롤을 건드리는 scrollIntoView는 쓰지 않는다 — 줄은 위치 기준(relative)이라 탭의 offsetLeft가 줄 안 좌표", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    stubFocusVisible("keyboard");
    render(<Harness initial="asia" />);
    act(() => tab("통화 및 환율").focus());
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(strip().className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "flex", "overflow-x-auto"]));
  });
});

describe("공용 탭 줄 — 두 줄 허용(wrap, 결정 1 가)", () => {
  // 바꾸기 전에는 wrap이 없어 줄이 늘 한 줄 + 가로 스크롤이었습니다.
  it("wrap이면 줄을 바꾸고(flex-wrap) 가로 스크롤 상자가 아니다 — 탭마다 제 줄의 바닥선(나머지 1px · 고른 탭 2px 강조 파랑)", () => {
    render(<Harness wrap initial="rates" />);
    const list = strip().className.split(/\s+/);
    expect(list).toEqual(expect.arrayContaining(["relative", "flex", "flex-wrap", "border-b", "border-border"]));
    expect(list).not.toContain("overflow-x-auto");
    const selected = tab("미국 국채 수익률").className.split(/\s+/);
    const idle = tab("통화 및 환율").className.split(/\s+/);
    expect(selected).toEqual(expect.arrayContaining(["border-b-2", "border-accent", "font-semibold", "-mb-px"]));
    expect(idle).toEqual(expect.arrayContaining(["border-b", "border-border", "pb-px", "-mb-px"]));
    expect(idle).not.toContain("border-transparent");
  });

  it("wrap이 없으면 지금 그대로 — 한 줄 + 가로 스크롤, 나머지 탭은 투명 밑줄", () => {
    render(<Harness />);
    const list = strip().className.split(/\s+/);
    expect(list).toContain("overflow-x-auto");
    expect(list).not.toContain("flex-wrap");
    expect(tab("미국 국채 수익률").className.split(/\s+/)).toEqual(expect.arrayContaining(["border-b-2", "border-transparent"]));
    expect(tab("미국 국채 수익률").className.split(/\s+/)).not.toContain("-mb-px");
  });
});
