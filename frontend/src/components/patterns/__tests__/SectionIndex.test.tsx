/**
 * SectionIndex · SectionAnchor — 긴 화면 목차(작업대 실행 명세 §6, P5a — 처음 쓰는 곳 매크로).
 * 네 상태: 값 있음(이름 있는 내비 하나 + 가로 줄·세로 목록, 절 링크, 개수, 지금 칸 aria-current="location"·부모 굵게), 빈 목록(내비 없이 본문만),
 * 개수 모름(자리 없음 — 0으로 채우지 않음), 긴 글(낱말 사이 줄바꿈·말줄임 없음). 읽는 중·오류는 목차가 아니라 본문 절이 그립니다(닻은 늘 있음).
 * 배치는 클래스로 봅니다(jsdom은 크기 질의·display를 계산하지 않음) — columnFrom 세 벌(lg·xl·2xl)의 정적 클래스, 가로 줄 sticky·밑줄 탭 모양, 세로 목록 들여쓰기.
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

  it("개수는 숫자일 때만 — 12px tabular-nums 보조 글(천 단위 쉼표), 링크 이름에는 낭독기 전용 마디 하나로 '지표 (1,234)'", () => {
    renderIndex({ items: [{ id: "a", label: "지표", count: 1234 }, { id: "b", label: "환율 비교" }], activeId: null });
    const { column } = lists();
    const link = within(column).getByRole("link", { name: "지표 (1,234)" });
    // 보이는 숫자는 읽기에서 빠지고(aria-hidden), 이름은 낭독기 전용 마디 '(1,234)' 하나가 줍니다(QA-658 — 괄호를 둘로 나누지 않음).
    const digits = within(link).getByText("1,234");
    expect(digits.getAttribute("aria-hidden")).toBe("true");
    const count = digits.parentElement as HTMLElement;
    expect(tokens(count)).toEqual(expect.arrayContaining(["text-xs", "tabular-nums", "text-text-3"]));
    expect([...count.querySelectorAll(".sr-only")].map((node) => node.textContent)).toEqual(["(1,234)"]);
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

  // 2026-11-17 결정 7(사용자 위임 — 권장안 가): 매크로는 목차 세로 목록을 2xl(1536)부터 — 1280~1535는 가로 줄이라 지표 패널이 13rem + 24px 넓어져
  // 미리보기 검사 칸(lg 배치 — 틀 52rem부터 옆 칸)이 1280·1366(메뉴 220)에서도 옆에 섭니다. lg·xl 값은 그대로입니다.
  it("2xl — 2xl부터 왼쪽 칸 틀, 가로 줄은 2xl까지(lg~2xl은 30px 줄), 세로 목록은 2xl부터 — lg·xl 변형은 없다", () => {
    const { container } = renderIndex({ activeId: null, columnFrom: "2xl" });
    const frame = container.firstElementChild as HTMLElement;
    expect(tokens(frame)).toEqual(expect.arrayContaining(["min-w-0", "2xl:grid", "2xl:grid-cols-[13rem_minmax(0,1fr)]", "2xl:gap-6"]));
    expect(tokens(frame).some((token) => token.startsWith("lg:") || token.startsWith("xl:"))).toBe(false);
    expect(tokens(nav())).toEqual(expect.arrayContaining(["sticky", "top-0", "z-20", "bg-bg", "lg:mb-6", "2xl:top-4", "2xl:z-auto", "2xl:mb-0", "2xl:self-start", "2xl:bg-transparent"]));
    expect(tokens(nav()).some((token) => token.startsWith("xl:"))).toBe(false);
    expect(nav().getAttribute("data-section-index-bar")).toBe("2xl");
    const { strip, column } = lists();
    expect(tokens(strip)).toContain("2xl:hidden");
    expect(tokens(strip)).not.toContain("xl:hidden");
    expect(tokens(column)).toEqual(expect.arrayContaining(["hidden", "2xl:flex"]));
    expect(tokens(column)).not.toContain("xl:flex");
    cleanup();
    render(<SectionAnchor id="macro-risk" columnFrom="2xl">위험</SectionAnchor>);
    expect(tokens(document.getElementById("macro-risk") as HTMLElement)).toEqual(["min-w-0", "scroll-mt-3", "2xl:scroll-mt-4"]);
  });

  it("본문은 절 사이 16·24px 세로 묶음 — 절 닻은 id와 scroll-margin(가로 줄 폭은 줄 높이 여백(QA-643) 위 12px, 세로 목록 폭 16px)", () => {
    renderIndex({ activeId: null });
    const anchor = document.getElementById("macro-fx") as HTMLElement;
    expect(tokens(anchor)).toEqual(["min-w-0", "scroll-mt-3", "lg:scroll-mt-4"]);
    expect(tokens(anchor.parentElement as HTMLElement)).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-4", "lg:gap-6"]));
    cleanup();
    render(<SectionAnchor id="macro-risk" columnFrom="xl">위험</SectionAnchor>);
    expect(tokens(document.getElementById("macro-risk") as HTMLElement)).toEqual(["min-w-0", "scroll-mt-3", "xl:scroll-mt-4"]);
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

  it("하위 칸을 아직 모르면(pendingChildren) 세로 목록에 그만큼 글 없는 자리 줄 — 읽기에서 빠지고 링크·개수가 아니며, 가로 줄에는 없다", () => {
    render(
      <SectionIndex label="매크로 지표 목차" items={[{ id: "macro-indicators", label: "지표", pendingChildren: 5 }, { id: "macro-fx", label: "환율 비교" }]} activeId={null}>
        <SectionAnchor id="macro-indicators">지표</SectionAnchor>
        <SectionAnchor id="macro-fx">환율</SectionAnchor>
      </SectionIndex>,
    );
    const { strip, column } = lists();
    const pending = column.querySelector("[data-section-index-pending]") as HTMLElement;
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    expect(pending.querySelectorAll("li")).toHaveLength(5);
    expect(tokens(pending.querySelector("li") as HTMLElement)).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-8", "pl-6"]));
    expect(within(column).getAllByRole("link").map((link) => link.textContent)).toEqual(["지표", "환율 비교"]);
    expect(strip.querySelector("[data-section-index-pending]")).toBeNull();
    // 하위 칸이 오면 자리 줄 대신 하위 칸.
    cleanup();
    render(
      <SectionIndex label="매크로 지표 목차" items={[{ id: "macro-indicators", label: "지표", pendingChildren: 5, children: [{ id: "macro-cat-fx", label: "환율" }] }]} activeId={null}>
        <SectionAnchor id="macro-indicators">지표</SectionAnchor>
      </SectionIndex>,
    );
    expect(document.querySelector("[data-section-index-pending]")).toBeNull();
    expect(within(lists().column).getAllByRole("link").map((link) => link.textContent)).toEqual(["지표", "환율"]);
  });

  it("개수를 읽는 중(pendingCount)이면 두 목록 모두 개수 자리(숫자 두 자리 폭의 글 없는 막대 — 읽기에서 빠짐), 개수가 숫자면 자리 대신 개수", () => {
    render(
      <SectionIndex label="매크로 지표 목차" items={[{ id: "macro-indicators", label: "지표", count: null, pendingCount: true }, { id: "macro-fx", label: "환율 비교" }]} activeId={null}>
        <SectionAnchor id="macro-indicators">지표</SectionAnchor>
        <SectionAnchor id="macro-fx">환율</SectionAnchor>
      </SectionIndex>,
    );
    const { strip, column } = lists();
    for (const list of [strip, column]) {
      const link = within(list).getByRole("link", { name: "지표" });
      const slot = link.querySelector("[data-section-index-count-pending]") as HTMLElement;
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(tokens(slot)).toEqual(expect.arrayContaining(["inline-block", "h-3", "w-[2ch]", "text-xs", "shrink-0", "bg-control-fill", "forced-colors:border"]));
      expect(link.textContent).toBe("지표");
      expect(within(list).getByRole("link", { name: "환율 비교" }).querySelector("[data-section-index-count-pending]")).toBeNull();
    }
    cleanup();
    render(
      <SectionIndex label="매크로 지표 목차" items={[{ id: "macro-indicators", label: "지표", count: 21, pendingCount: true }]} activeId={null}>
        <SectionAnchor id="macro-indicators">지표</SectionAnchor>
      </SectionIndex>,
    );
    expect(document.querySelector("[data-section-index-count-pending]")).toBeNull();
    expect(within(lists().strip).getByRole("link", { name: "지표 (21)" })).toBeTruthy();
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
    // 이름으로 봅니다(보이는 숫자와 낭독기 전용 마디가 따로라 글 내용은 '라 (0)0' — QA-658). 개수 칸은 0 하나뿐.
    for (const name of ["가", "나", "다", "라 (0)"]) expect(within(column).getByRole("link", { name })).toBeTruthy();
    expect(column.querySelectorAll(".tabular-nums")).toHaveLength(1);
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
  it("내비가 가로 줄 표지(columnFrom)를 달고, 그 폭의 스크롤 상자에 줄 높이만큼 scroll-padding-top이 있다", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    renderIndex({ columnFrom: "xl" });
    expect(screen.getByRole("navigation", { name: "매크로 지표 목차" }).getAttribute("data-section-index-bar")).toBe("xl");
    const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");
    // 높이는 잰 줄 높이(--section-strip-h — QA-656), 재기 전에는 기본 45·31px.
    expect(css).toMatch(/@media \(width < 64rem\) \{\s*html:has\(\[data-section-index-bar\]\) \{\s*scroll-padding-top: var\(--section-strip-h, 45px\);/);
    expect(css).toMatch(/@media \(64rem <= width < 80rem\) \{\s*#main:has\(\[data-section-index-bar="xl"\]\) \{\s*scroll-padding-top: var\(--section-strip-h, 31px\);/);
    // 2xl(결정 7 — 매크로): 가로 줄이 lg~2xl(1024~1535)에 보이므로 그 폭 전체에 같은 여백.
    expect(css).toMatch(/@media \(64rem <= width < 96rem\) \{\s*#main:has\(\[data-section-index-bar="2xl"\]\) \{\s*scroll-padding-top: var\(--section-strip-h, 31px\);/);
  });
});

// QA-656: 스크롤 상자의 위쪽 여백(QA-643)을 줄 높이 상수(45·31px)로 두었는데, 고전 스크롤 막대를 그리는 브라우저에서 칸이 넘치면 가로 줄 안에 10px 막대가
// 서서 줄이 31→41px(좁은 화면 45→55px)이 되었습니다 — Shift+Tab으로 위로 옮긴 포커스가 줄 밑에 최대 10px 가려짐(P5a QA — 1024x768 메뉴 272 /macro).
// 이제 목차가 가로 줄의 잰 높이(offsetHeight — 아래 선·가로 막대 포함)를 문서 루트의 --section-strip-h로 적고, 전역 규칙이 그 값을 씁니다.
// 수정 전(재현 커밋에서는 it.fails)에는 변수를 적지 않아 ''이었습니다. jsdom은 배치를 하지 않아 줄 높이와 ResizeObserver를 대역으로 줍니다.
describe("QA-656 가로 줄의 잰 높이를 문서 루트 --section-strip-h로 적는다", () => {
  it("줄 높이가 41px(가로 막대가 섬)이 되어 ResizeObserver가 울리면 '41px', 화면을 떠나면 지운다", () => {
    let callback: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const root = document.documentElement;
    const { unmount } = renderIndex({ activeId: null });
    Object.defineProperty(lists().strip, "offsetHeight", { configurable: true, value: 41 });
    act(() => callback());
    expect(root.style.getPropertyValue("--section-strip-h")).toBe("41px");
    unmount();
    expect(root.style.getPropertyValue("--section-strip-h")).toBe("");
  });
});

// QA-658: 개수의 괄호를 숫자 앞뒤의 낭독기 전용 마디 둘('(' · ')')로 나눠 두었는데, Tailwind sr-only는 position:absolute라 크롬은 그 마디를 블록으로 보고
// 이름 계산에서 앞뒤에 빈칸을 넣어 링크 이름이 '지표 ( 21 )'이었습니다(P5a QA — QA 스택 390~1600 Accessibility 트리). jsdom은 Tailwind CSS를 읽지 않아
// sr-only가 인라인으로 남아 기존 시험은 '지표 (21)'로 통과했습니다 — 여기서는 크롬의 계산된 display(block)를 <style>로 흉내 내 같은 빈칸 규칙을 씁니다
// (dom-accessibility-api도 블록 마디 앞뒤에 빈칸을 넣음). 수정 전(재현 커밋에서는 it.fails)에는 이름이 '지표 ( 1,234 )'이었습니다.
describe("QA-658 개수가 붙은 칸의 이름은 '지표 (1,234)' — 낭독기 전용 마디가 블록이어도 빈칸이 끼지 않는다", () => {
  it("sr-only가 블록(크롬의 position:absolute 계산 값)이어도 가로 줄·세로 목록 모두 이름이 '지표 (1,234)'", () => {
    const style = document.createElement("style");
    style.textContent = ".sr-only{display:block}";
    document.head.appendChild(style);
    try {
      renderIndex({ items: [{ id: "a", label: "지표", count: 1234 }], activeId: null });
      const { strip, column } = lists();
      expect(within(strip).getByRole("link", { name: "지표 (1,234)" })).toBeTruthy();
      expect(within(column).getByRole("link", { name: "지표 (1,234)" })).toBeTruthy();
    } finally {
      style.remove();
    }
  });
});

// QA-659: 넓은 화면(lg 이상)은 본문(#main)이 스크롤 상자라, 목차로 옮긴 뒤 뒤로·앞으로 가기를 하면 크롬이 연속 기록 이동의 첫 번째 뒤로는 창(루트) 위치만
// 되돌려 주소의 해시만 바뀌고 본문 스크롤·지금 칸은 그대로였습니다(P5a QA — /macro 1440 둘째 뒤로 가기에서 절 위 끝 −1,708px). 이제 목차가 hashchange를
// 듣고 해시가 목차 칸이면 그 닻으로 옮깁니다. 수정 전(재현 커밋에서는 it.fails)에는 scrollIntoView를 부르지 않았습니다(0번).
describe("QA-659 뒤로·앞으로 가기로 해시가 목차 칸이 되면 그 절로 옮긴다", () => {
  it("hashchange에서 해시가 목차 칸이면 그 닻의 scrollIntoView를 한 번 — 목차 밖 해시(#main)는 부르지 않는다", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      render(
        <SectionIndex label="목차" items={[{ id: "a", label: "가" }, { id: "b", label: "나" }]} activeId={null}>
          <SectionAnchor id="a">가 절</SectionAnchor>
          <SectionAnchor id="b">나 절</SectionAnchor>
        </SectionIndex>,
      );
      window.history.pushState(null, "", "#b");
      act(() => {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(document.getElementById("b"));
      window.history.pushState(null, "", "#main");
      act(() => {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      scroll.mockRestore();
    }
  });
});

// QA-659 후속: 위 고침은 해시가 목차 칸일 때만 옮겨, 가장 흔한 길(목차로 한 번 옮김 → 뒤로 가기로 해시 없는 처음 기록)에서는 주소만 바뀌고 본문은 옮긴 절에
// 남았습니다(P5a 고침 검토 — 자기 빌드 /macro 1440 '환율 비교'로 옮긴 뒤 뒤로 가기: #main.scrollTop 2067 → 2067, 1024 2111 → 2111. 390은 창이 스크롤
// 상자라 브라우저가 되돌려 3829 → 0). 이제 목차 칸 해시에서 해시 없는 기록으로 돌아오면 닻을 담은 요소 스크롤 상자를 해시 없이 있던 마지막 자리로(모르면
// 맨 위) 되돌립니다. jsdom은 배치·스크롤을 계산하지 않으므로 본문 상자의 넘침(overflow-y auto·scrollHeight > clientHeight)과 scrollTop을 손으로 주고,
// 기록 이동은 pushState + hashchange(oldURL)로 흉내 냅니다. 수정 전(재현 커밋에서는 it.fails)에는 본문이 옮긴 자리(3,000·2,000)에 남았습니다.
describe("QA-659 목차 칸 해시에서 해시 없는 기록으로 돌아오면 본문 스크롤 상자를 해시 없이 있던 자리로", () => {
  const BASE_PATH = () => window.location.pathname + window.location.search;
  /** 본문 상자(#main 흉내) 안에 목차를 그립니다 — scrolls면 넘치는 요소 스크롤 상자(넓은 화면), 아니면 넘침 visible(좁은 화면 — 창이 스크롤). */
  function renderInBox(scrolls: boolean) {
    const box = document.createElement("main");
    box.id = "main";
    if (scrolls) {
      box.style.overflowY = "auto";
      Object.defineProperty(box, "scrollHeight", { configurable: true, value: 6000 });
      Object.defineProperty(box, "clientHeight", { configurable: true, value: 800 });
    }
    document.body.appendChild(box);
    const host = box.appendChild(document.createElement("div"));
    render(
      <SectionIndex label="목차" items={[{ id: "a", label: "가" }, { id: "b", label: "나" }]} activeId={null}>
        <SectionAnchor id="a">가 절</SectionAnchor>
        <SectionAnchor id="b">나 절</SectionAnchor>
      </SectionIndex>,
      { container: host },
    );
    return box;
  }
  /** 상자를 top까지 내리고 scroll 이벤트를 보냅니다(브라우저는 스크롤 뒤 다음 그리기 때 보냄). */
  const scrollBox = (box: HTMLElement, top: number) =>
    act(() => {
      box.scrollTop = top;
      box.dispatchEvent(new Event("scroll"));
    });
  /** 주소를 hash로 바꾸고(기록 이동 흉내) hashchange(oldURL = 바꾸기 전 주소)를 보냅니다. */
  const go = (hash: string) => {
    const oldURL = window.location.href;
    window.history.pushState(null, "", BASE_PATH() + hash);
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
    });
  };

  it("해시 없이 1,200px에서 목차로 옮긴 뒤(3,000px) 해시 없는 기록으로 돌아오면 1,200px — 옮긴 자리의 scroll은 적지 않는다", () => {
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    let box: HTMLElement | null = null;
    try {
      box = renderInBox(true);
      scrollBox(box, 1200);
      // 목차 칸 누르기 — 주소가 먼저 바뀌고(해시 b) 옮긴 스크롤의 scroll 이벤트가 뒤따름.
      window.history.pushState(null, "", BASE_PATH() + "#b");
      scrollBox(box, 3000);
      // 뒤로 가기 — 해시 없는 처음 기록.
      go("");
      expect(box.scrollTop).toBe(1200);
      // 앞으로 가기 — 다시 b의 닻으로(QA-659), 그 뒤 뒤로 가기도 1,200px.
      go("#b");
      expect(into.mock.contexts.at(-1)).toBe(document.getElementById("b"));
      scrollBox(box, 3000);
      go("");
      expect(box.scrollTop).toBe(1200);
    } finally {
      window.history.replaceState(null, "", BASE_PATH());
      box?.remove();
      into.mockRestore();
    }
  });

  it("해시 없이 스크롤한 적 없이 목차로 옮긴 자리(2,000px)에서 해시 없는 기록으로 돌아오면 맨 위(빈 해시가 가리키는 문서 맨 위)", () => {
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    let box: HTMLElement | null = null;
    try {
      box = renderInBox(true);
      go("#a");
      scrollBox(box, 2000);
      go("");
      expect(box.scrollTop).toBe(0);
    } finally {
      window.history.replaceState(null, "", BASE_PATH());
      box?.remove();
      into.mockRestore();
    }
  });

  it("창이 스크롤하는 폭(본문 넘침 visible)·목차 밖 해시(#main)에서 돌아오면 건드리지 않고, 그 자리(700px)를 해시 없는 기록의 자리로 적는다", () => {
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    let narrow: HTMLElement | null = null;
    try {
      // 좁은 화면 — 창이 스크롤 상자라 브라우저가 되돌린 자리를 그대로 둠(본문 상자의 scrollTop 500을 건드리지 않음).
      narrow = renderInBox(false);
      narrow.scrollTop = 500;
      go("#a");
      go("");
      expect(narrow.scrollTop).toBe(500);
    } finally {
      window.history.replaceState(null, "", BASE_PATH());
      narrow?.remove();
    }
    cleanup();
    let wide: HTMLElement | null = null;
    try {
      // 넓은 화면 — 목차 밖 해시(#main — 본문으로 건너뛰기)에서 700px까지 내린 뒤 돌아오면 그대로.
      wide = renderInBox(true);
      go("#main");
      scrollBox(wide, 700);
      go("");
      expect(wide.scrollTop).toBe(700);
      // 그 자리가 해시 없는 기록의 자리 — 목차로 옮긴 자리(2,000px)에서 돌아오면 700px.
      go("#a");
      scrollBox(wide, 2000);
      go("");
      expect(wide.scrollTop).toBe(700);
    } finally {
      window.history.replaceState(null, "", BASE_PATH());
      wide?.remove();
      into.mockRestore();
    }
  });
});

// QA-645: 지금 절 띠(뷰포트 위 96px 아래 ~ 34%)로만 고르면 마지막 절은 지금 칸이 되지 못했습니다 — 목차에서 마지막 절을 누르거나 끝까지 내려도 페이지가
// 더 내려가지 못해 그 절의 위 끝이 띠 아래(390 543px·1024 687px·1440 715px)에 남고, 띠에는 앞 절 꼬리만 걸려 aria-current가 앞 절에 남았습니다
// (P5a 검토 — 자기 빌드 /macro, 운영자 '경제 캘린더'·회원 '비공식 시세'). 스크롤 상자가 끝까지 내려가 있으면 위 끝이 화면 안에 있는 마지막 절이
// 지금 절이어야 합니다. jsdom은 배치를 계산하지 않으므로 스크롤 상자의 크기·위치와 닻의 위치를 대역으로 줍니다.
describe("QA-645 끝까지 내려가면 화면 안의 마지막 절이 지금 절", () => {
  it("띠에는 앞 절만 걸려도, 창이 끝까지 내려가 있으면 위 끝이 화면 안인 마지막 절(위험)이 지금 칸", () => {
    let callback: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderIndex();
    const current = () => lists().column.querySelector('[aria-current="location"]')?.getAttribute("href");
    act(() =>
      callback(
        [{ target: document.getElementById("macro-fx"), isIntersecting: true }] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(current()).toBe("#macro-fx");

    // 창(문서 스크롤 상자)이 끝까지 내려감 — 스크롤 9,832 / 최대 9,832(390 실측과 같은 꼴). 위험 절의 위 끝은 화면 안 543px, 환율 비교는 위로 지나감.
    const root = document.documentElement;
    const restore = [
      vi.spyOn(root, "scrollTop", "get").mockReturnValue(9832),
      vi.spyOn(root, "scrollHeight", "get").mockReturnValue(10676),
      vi.spyOn(root, "clientHeight", "get").mockReturnValue(844),
    ];
    const tops: Record<string, number> = { "macro-indicators": -9000, "macro-cat-rates": -8900, "macro-cat-fx": -8500, "macro-fx": -300, "macro-risk": 543 };
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = tops[this.id] ?? 0;
      return { top, bottom: top + 200, left: 0, right: 390, width: 390, height: 200, x: 0, y: top } as DOMRect;
    });
    vi.stubGlobal("innerHeight", 844);
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(current()).toBe("#macro-risk");
    rect.mockRestore();
    for (const spy of restore) spy.mockRestore();
  });
});
