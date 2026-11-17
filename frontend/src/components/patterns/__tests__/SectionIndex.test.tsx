/**
 * SectionIndex · SectionAnchor — 긴 화면 목차(작업대 실행 명세 §6, P5a — 처음 쓰는 곳 매크로).
 * 네 상태: 값 있음(이름 있는 내비 하나 + 가로 줄·세로 목록, 절 링크, 개수, 지금 칸 aria-current="location"·부모 굵게), 빈 목록(내비 없이 본문만),
 * 개수 모름(자리 없음 — 0으로 채우지 않음), 긴 글(낱말 사이 줄바꿈·말줄임 없음). 읽는 중·오류는 목차가 아니라 본문 절이 그립니다(닻은 늘 있음).
 * 배치는 클래스로 봅니다(jsdom은 크기 질의·display를 계산하지 않음) — columnFrom 두 벌의 정적 클래스, 가로 줄 sticky·밑줄 탭 모양, 세로 목록 들여쓰기.
 * 누름 자리(lg 미만 44px — smallTargets), 고대비의 막대 테두리. 지금 절을 고르는 것(useSectionSpy)은 IntersectionObserver 대역으로 한 번 봅니다.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";

import { SectionAnchor, SectionIndex, type SectionIndexItem } from "../SectionIndex";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ITEMS: SectionIndexItem[] = [
  {
    id: "macro-indicators",
    label: "지표",
    count: 37,
    children: [
      { id: "macro-cat-rates", label: "금리" },
      { id: "macro-cat-fx", label: "환율" },
    ],
  },
  { id: "macro-fx", label: "환율 비교" },
  { id: "macro-risk", label: "신용·변동성", count: null },
];

function renderIndex(props: Partial<Parameters<typeof SectionIndex>[0]> = {}) {
  return render(
    <SectionIndex label="매크로 지표 목차" items={ITEMS} {...props}>
      <SectionAnchor id="macro-indicators">
        <section aria-label="지표 패널">
          <div id="macro-cat-rates">금리 표</div>
          <div id="macro-cat-fx">환율 표</div>
        </section>
      </SectionAnchor>
      <SectionAnchor id="macro-fx">환율 비교 패널</SectionAnchor>
      <SectionAnchor id="macro-risk">위험 패널</SectionAnchor>
    </SectionIndex>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "매크로 지표 목차" });
/** 내비 안 두 목록 — 첫째가 가로 줄(첫 단계만), 둘째가 세로 목록. */
const lists = () => {
  const [strip, column] = Array.from(nav().children) as HTMLElement[];
  return { strip, column };
};
const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

describe("SectionIndex — 값 있음", () => {
  it("이름 있는 내비 하나 안에 가로 줄(첫 단계만)과 세로 목록(하위 칸 포함) — 칸은 같은 화면 절 링크", () => {
    renderIndex({ activeId: null });
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    const { strip, column } = lists();
    expect(strip.tagName).toBe("UL");
    expect(column.tagName).toBe("UL");
    expect(within(strip).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#macro-indicators", "#macro-fx", "#macro-risk"]);
    expect(within(column).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "#macro-indicators",
      "#macro-cat-rates",
      "#macro-cat-fx",
      "#macro-fx",
      "#macro-risk",
    ]);
    // 지금 칸이 없으면 aria-current도 없다
    expect(nav().querySelector("[aria-current]")).toBeNull();
  });

  it("개수는 숫자일 때만 — 12px tabular-nums 보조 글(천 단위 쉼표), 링크 이름에는 낭독기 전용 괄호로 '지표 (1,234)'", () => {
    renderIndex({ items: [{ id: "a", label: "지표", count: 1234 }, { id: "b", label: "환율 비교" }], activeId: null });
    const { column } = lists();
    const link = within(column).getByRole("link", { name: "지표 (1,234)" });
    const count = within(link).getByText("1,234");
    expect(tokens(count)).toEqual(expect.arrayContaining(["text-xs", "tabular-nums", "text-text-3"]));
    expect([...count.querySelectorAll(".sr-only")].map((node) => node.textContent)).toEqual(["(", ")"]);
    expect(within(column).getByRole("link", { name: "환율 비교" }).textContent).toBe("환율 비교");
  });

  it("activeId — 세로 목록의 그 칸이 aria-current='location'(굵게·막대), 하위 칸이 지금이면 부모는 굵게만, 가로 줄은 부모(첫 단계)가 지금 칸", () => {
    renderIndex({ activeId: "macro-cat-fx" });
    const { strip, column } = lists();
    const child = within(column).getByRole("link", { name: "환율" });
    expect(child.getAttribute("aria-current")).toBe("location");
    expect(tokens(child)).toEqual(expect.arrayContaining(["font-semibold", "text-text", "before:bg-accent", "before:w-[3px]"]));
    const parent = within(column).getByRole("link", { name: "지표 (37)" });
    expect(parent.getAttribute("aria-current")).toBeNull();
    expect(tokens(parent)).toEqual(expect.arrayContaining(["font-semibold", "text-text"]));
    expect(tokens(parent)).not.toContain("before:bg-accent");
    const rest = within(column).getByRole("link", { name: "환율 비교" });
    expect(tokens(rest)).toEqual(expect.arrayContaining(["font-medium", "text-text-2"]));
    // 가로 줄 — 첫 단계 '지표'가 지금 칸(밑줄 탭의 지금 모양)
    const top = within(strip).getByRole("link", { name: "지표 (37)" });
    expect(top.getAttribute("aria-current")).toBe("location");
    expect(tokens(top)).toEqual(expect.arrayContaining(["border-accent", "font-semibold"]));
    expect(within(strip).getByRole("link", { name: "환율 비교" }).getAttribute("aria-current")).toBeNull();
  });

  it("첫 단계 칸이 지금이면 두 목록 모두 그 칸", () => {
    renderIndex({ activeId: "macro-fx" });
    const { strip, column } = lists();
    expect(within(strip).getByRole("link", { name: "환율 비교" }).getAttribute("aria-current")).toBe("location");
    expect(within(column).getByRole("link", { name: "환율 비교" }).getAttribute("aria-current")).toBe("location");
    expect(nav().querySelectorAll("[aria-current]")).toHaveLength(2);
  });

  it("하위 칸은 세로 목록에서만 들여 쓰고(24px·13px), 첫 단계는 14px — 둘 다 좁은 화면 44px·넓은 화면 32px", () => {
    renderIndex({ activeId: null });
    const { column } = lists();
    const top = within(column).getByRole("link", { name: "환율 비교" });
    const child = within(column).getByRole("link", { name: "금리" });
    expect(tokens(top)).toEqual(expect.arrayContaining(["text-sm", "min-h-11", "lg:min-h-8"]));
    expect(tokens(child)).toEqual(expect.arrayContaining(["pl-6", "text-caption", "min-h-11", "lg:min-h-8"]));
  });
});

describe("SectionIndex — 배치(columnFrom)", () => {
  it("기본 lg — lg부터 왼쪽 13rem 칸 틀, 가로 줄은 lg에서 숨고 세로 목록은 lg부터, 내비는 lg 미만 sticky top-0 줄·lg 이상 위쪽에 붙는 칸", () => {
    const { container } = renderIndex({ activeId: null });
    const frame = container.firstElementChild as HTMLElement;
    expect(tokens(frame)).toEqual(expect.arrayContaining(["min-w-0", "lg:grid", "lg:grid-cols-[13rem_minmax(0,1fr)]", "lg:gap-6"]));
    expect(tokens(nav())).toEqual(expect.arrayContaining(["sticky", "top-0", "z-20", "bg-bg", "lg:top-4", "lg:self-start"]));
    const { strip, column } = lists();
    expect(tokens(strip)).toEqual(expect.arrayContaining(["relative", "flex", "overflow-x-auto", "border-b", "lg:hidden"]));
    expect(tokens(column)).toEqual(expect.arrayContaining(["hidden", "lg:flex", "flex-col"]));
    // 가로 줄 칸은 화면 안 밑줄 탭 모양(sm — 좁은 화면 44px, 넓은 화면 30px)
    expect(tokens(within(strip).getByRole("link", { name: "환율 비교" }))).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-[30px]", "whitespace-nowrap"]));
  });

  it("xl — xl부터 왼쪽 칸 틀, 가로 줄은 xl까지(lg~xl은 30px 줄), 세로 목록은 xl부터", () => {
    const { container } = renderIndex({ activeId: null, columnFrom: "xl" });
    const frame = container.firstElementChild as HTMLElement;
    expect(tokens(frame)).toEqual(expect.arrayContaining(["min-w-0", "xl:grid", "xl:grid-cols-[13rem_minmax(0,1fr)]", "xl:gap-6"]));
    expect(tokens(frame).some((token) => token.startsWith("lg:"))).toBe(false);
    expect(tokens(nav())).toEqual(expect.arrayContaining(["sticky", "top-0", "xl:top-4", "xl:self-start"]));
    const { strip, column } = lists();
    expect(tokens(strip)).toContain("xl:hidden");
    expect(tokens(strip)).not.toContain("lg:hidden");
    expect(tokens(column)).toEqual(expect.arrayContaining(["hidden", "xl:flex"]));
    expect(tokens(column)).not.toContain("lg:flex");
  });

  it("본문은 절 사이 16·24px 세로 묶음 — 절 닻은 id와 scroll-margin(가로 줄 밑 56px, 세로 목록 폭 16px)", () => {
    renderIndex({ activeId: null });
    const anchor = document.getElementById("macro-fx") as HTMLElement;
    expect(tokens(anchor)).toEqual(["min-w-0", "scroll-mt-14", "lg:scroll-mt-4"]);
    expect(tokens(anchor.parentElement as HTMLElement)).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-4", "lg:gap-6"]));
    cleanup();
    render(<SectionAnchor id="macro-risk" columnFrom="xl">위험</SectionAnchor>);
    expect(tokens(document.getElementById("macro-risk") as HTMLElement)).toEqual(["min-w-0", "scroll-mt-14", "xl:scroll-mt-4"]);
  });
});

describe("SectionIndex — 빈 목록·개수 모름·긴 글", () => {
  it("목차 칸이 없으면 내비 없이 본문(절 닻)만", () => {
    render(
      <SectionIndex label="목차" items={[]}>
        <SectionAnchor id="only">본문</SectionAnchor>
      </SectionIndex>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("본문").id).toBe("only");
  });

  it("개수를 모르면(null·없음·NaN) 자리를 그리지 않는다 — '0'을 만들지 않음, 0은 값", () => {
    renderIndex({
      items: [
        { id: "a", label: "가", count: null },
        { id: "b", label: "나" },
        { id: "c", label: "다", count: Number.NaN },
        { id: "d", label: "라", count: 0 },
      ],
      activeId: null,
    });
    const { column } = lists();
    expect(within(column).getAllByRole("link").map((link) => link.textContent)).toEqual(["가", "나", "다", "라 (0)"]);
  });

  it("긴 글은 세로 목록에서 낱말 사이에서 꺾고(break-keep·wrap-anywhere) 말줄임이 없다", () => {
    const long = "아주 긴 절 이름 — 신용 리스크, 은행권 및 시장 변동성과 대리 지표의 한계";
    renderIndex({ items: [{ id: "long", label: long }], activeId: null });
    const label = within(lists().column).getByText(long);
    expect(tokens(label)).toEqual(expect.arrayContaining(["break-keep", "wrap-anywhere", "min-w-0"]));
    for (const element of [label, label.parentElement as HTMLElement]) {
      expect(tokens(element).some((token) => token === "truncate" || token.startsWith("line-clamp"))).toBe(false);
    }
  });
});

describe("SectionIndex — 누름 자리·고대비", () => {
  it("모든 칸이 좁은 화면 44px(누름 자리 감사 통과)", () => {
    renderIndex({ activeId: "macro-cat-rates" });
    expect(smallTargets(nav())).toEqual([]);
  });

  it("지금 칸 막대는 고대비(forced-colors)에서 같은 폭의 왼쪽 테두리 — 나머지 칸에는 테두리가 없다", () => {
    renderIndex({ activeId: "macro-risk" });
    const { column } = lists();
    expect(tokens(within(column).getByRole("link", { name: "신용·변동성" }))).toContain("forced-colors:before:border-l-[3px]");
    expect(tokens(within(column).getByRole("link", { name: "환율 비교" })).some((token) => token.startsWith("forced-colors:"))).toBe(false);
  });
});

describe("SectionIndex — 지금 절(useSectionSpy)", () => {
  it("activeId를 주지 않으면 화면 위쪽 띠에 걸친 절로 — 하위 칸이 걸치면 하위 칸, 걸친 것이 없으면 앞 값 그대로", () => {
    let callback: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe(element: Element) {
          observed.push(element);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    renderIndex();
    expect(observed.map((element) => element.id)).toEqual(["macro-cat-rates", "macro-cat-fx", "macro-indicators", "macro-fx", "macro-risk"]);
    const fire = (entries: [string, boolean][]) =>
      act(() =>
        callback(
          entries.map(([id, isIntersecting]) => ({ target: document.getElementById(id), isIntersecting }) as unknown as IntersectionObserverEntry),
          {} as IntersectionObserver,
        ),
      );
    const current = () => lists().column.querySelector('[aria-current="location"]')?.getAttribute("href");

    fire([["macro-indicators", true], ["macro-cat-rates", true]]);
    expect(current()).toBe("#macro-cat-rates");
    fire([["macro-cat-rates", false], ["macro-indicators", false], ["macro-fx", true]]);
    expect(current()).toBe("#macro-fx");
    fire([["macro-fx", false]]);
    expect(current()).toBe("#macro-fx");
  });
});

// QA-643: 가로 줄(columnFrom 미만 — 좁은 화면 44px + 아래 선 1px, lg~xl 30px + 1px)은 본문 위에 불투명하게 붙어 따라오는데, 스크롤 상자(lg 미만 html,
// lg 이상 #main)에 그만큼의 위쪽 스크롤 여백(scroll-padding-top)이 없었습니다. Shift+Tab 등으로 포커스가 위로 옮겨 가 상자 위 끝에 맞춰지면 포커스된
// 요소가 줄 밑에 가려졌습니다(WCAG 2.2 2.4.11 — 아래 탭 바는 scroll-padding-bottom으로 이미 막아 둠, P5a 검토). 절 닻의 scroll-margin은 목차 링크로 옮길
// 때만 쓰이고 Tab 포커스 스크롤에는 쓰이지 않습니다. jsdom은 스크롤을 계산하지 않으므로 내비의 표지와 전역 CSS 규칙(소스)으로 봅니다.
describe("QA-643 가로 줄이 덮는 만큼 스크롤 상자에 위쪽 스크롤 여백", () => {
  it.fails("내비가 가로 줄 표지(columnFrom)를 달고, 그 폭의 스크롤 상자에 줄 높이만큼 scroll-padding-top이 있다", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    renderIndex({ columnFrom: "xl" });
    expect(screen.getByRole("navigation", { name: "매크로 지표 목차" }).getAttribute("data-section-index-bar")).toBe("xl");
    const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");
    expect(css).toMatch(/@media \(width < 64rem\) \{\s*html:has\(\[data-section-index-bar\]\) \{\s*scroll-padding-top: 45px;/);
    expect(css).toMatch(/@media \(64rem <= width < 80rem\) \{\s*#main:has\(\[data-section-index-bar="xl"\]\) \{\s*scroll-padding-top: 31px;/);
  });
});
