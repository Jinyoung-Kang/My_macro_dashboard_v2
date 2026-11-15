/**
 * 정보 검색 연결 탭 '목록' 보기의 QA 결함 재현·고정 시험(QA-422)과 좁은 칸의 연결 그림(QA-424 검토 지적). 표본은 모두 합성 값입니다(실제 법인·사람의
 * 자료를 쓰지 않음).
 * 배치를 재지 못하는 jsdom이라, 고침이 세우는 구조(클래스·title·요소의 자리)를 대조하고 실제 폭은 QA 스택 브라우저(390·1024·1440)로 확인합니다.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkGroups, type LinksView } from "@/lib/infoSearch";
import type { SearchLink } from "@/lib/types";
import { LinksGraph } from "../LinksGraph";
import { LinksPanel } from "../LinksPanel";

afterEach(cleanup);

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). SVG도 되게 class 속성으로 읽음. */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 앞머리가 같은 GLEIF 자회사 넷(키 없음 — '이름으로 찾기')과 Yahoo 내부자 하나. */
const SUBSIDIARIES: SearchLink[] = [1, 2, 3, 4].map((n) => ({
  relation: "subsidiary",
  key: null,
  name: `Example Subsidiary ${n} Ltd`,
  kind: "company",
  source: "gleif",
  detail: `US · LEI 0000EXAMPLE0000000${n}00`,
}));
const INSIDER: SearchLink = {
  relation: "insider",
  key: null,
  name: "Jordan Sample",
  kind: "person",
  source: "yahoo",
  detail: "Chief Example Officer · 최근 거래 2026-11-10 매도",
};

function renderList() {
  const view: LinksView = { groups: linkGroups([INSIDER, ...SUBSIDIARIES]), extra: null, sources: [], empty: null, entityNote: null };
  return render(<LinksPanel view={view} centerName="Example Corp" onTarget={() => {}} onRetry={() => {}} />);
}

describe("연결 탭 '목록' 보기 — 좁은 칸(390 화면·1024 화면의 가운데 칸)에서도 연결마다 이름을 읽고 가름(QA-422)", () => {
  // QA-422: 390에서 줄 오른쪽의 메타 칸('기업 · GLEIF · 이름으로 찾기' — shrink-0)이 폭을 먼저 차지해 이름 칸이 약 78px로 줄고, 이름·설명이
  // 한 줄 말줄임(truncate, title 없음)이라 'Example Subsidiary 1~4 Ltd'가 모두 'Example …'로 똑같이 보였습니다.
  // 수정 전 실패: 이름 span에 접두 없는 truncate가 있고 title이 없음, 메타 span이 이름 칸 밖의 shrink-0 칸(재현 커밋에서는 it.fails).
  // 검토 지적: 첫 고침은 화면 폭 lg(1024)부터 한 줄 배치로 돌아가, 가운데 칸이 390보다 좁은 1024~약 1160 화면(칸 안쪽 약 164px)에서 키 없는 줄의
  // 이름 칸이 0px로 눌렸습니다 — 전환 기준을 패널 폭(@container, 28rem = @md)으로 바꿨습니다.
  it("패널 폭이 28rem 미만이면 이름·설명을 줄바꿈하고(줄 수 제한·말줄임은 @md에서만, 잘릴 수 있는 글에는 title) 메타는 이름 칸 밑의 제 줄 — 줄 높이 44px 그대로", () => {
    const { container } = renderList();
    // 한 줄 배치를 가르는 것은 화면 폭(lg)이 아니라 이 패널의 폭(컨테이너 쿼리).
    expect(classes(container.firstElementChild!)).toContain("@container");
    for (const link of [...SUBSIDIARIES, INSIDER]) {
      const button = screen.getByRole("button", { name: new RegExp(link.name) });
      expect(classes(button)).toContain("min-h-11");
      // 줄 안의 글 묶음은 세로 가운데(한 줄 이름), 그 안에서 아이콘·꺾쇠는 이름 첫 줄에(아래 '넓은 패널' 시험 — 패널 폭과 상관없이).
      expect(classes(button)).toContain("items-center");
      expect(classes(button.firstElementChild!)).toContain("items-start");
      expect(button.className).not.toMatch(/(^|\s)lg:(items-center|flex-row|truncate|shrink-0|flex-1)(\s|$)/);

      const name = within(button).getByText(link.name);
      expect(classes(name)).not.toContain("truncate");
      expect(classes(name)).not.toContain("lg:truncate");
      expect(classes(name)).not.toContain("line-clamp-2");
      // 28rem 이상의 이름도 끝까지 줄바꿈(아래 '넓은 패널' 시험).
      expect(classes(name)).toContain("break-words");
      expect(classes(name).filter((word) => /line-clamp/.test(word))).toEqual([]);
      expect(name.getAttribute("title")).toBe(link.name);

      const detail = within(button).getByText(link.detail!);
      expect(classes(detail)).not.toContain("truncate");
      expect(classes(detail)).not.toContain("lg:truncate");
      expect(classes(detail)).toEqual(expect.arrayContaining(["break-words", "@md:truncate"]));
      expect(detail.getAttribute("title")).toBe(link.detail);

      const metaText = link.kind === "person" ? "사람 · Yahoo · 이름으로 찾기" : "기업 · GLEIF · 이름으로 찾기";
      const meta = within(button).getByText(metaText);
      // 좁은 패널에서는 줄어들지 않는 오른쪽 칸이 아니라 이름·설명과 같은 세로 칸 안의 제 줄 — 28rem 이상에서만 옆으로(오른쪽 칸).
      expect(classes(meta)).not.toContain("shrink-0");
      expect(classes(meta)).not.toContain("lg:shrink-0");
      expect(classes(meta)).toContain("@md:shrink-0");
      const stack = meta.parentElement!;
      expect(stack.contains(name)).toBe(true);
      expect(classes(stack)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "flex-col", "@md:flex-row"]));
      expect(classes(stack)).not.toContain("lg:flex-row");
      expect(classes(name.parentElement!)).toEqual(expect.arrayContaining(["min-w-0", "@md:flex-1"]));
    }
  });
});

describe("연결 탭 '목록' 보기 — 넓은 패널(28rem 이상)에서 끝만 다른 긴 이름도 가름(QA 재확인 개선 제안)", () => {
  // 1440 화면(패널 570px)에서 이름 칸(약 351px)이 한 줄 말줄임(@md:truncate)이라, 약 50자를 넘고 끝만 다른 GLEIF 법인명 둘이
  // 'Example Subsidiary International Holdings Asia Pacific …'로 똑같이 보였습니다(전체 이름은 title, 설명 줄의 LEI만 달랐음).
  // 첫 고침은 28rem 이상에서 두 줄까지(@md:line-clamp-2)였는데, 이름 칸이 약 340px 미만(1366 화면 패널 496, lg 약 1030~1140 화면 패널 448~약 540)이면
  // 이 110자 이름이 세 줄 이상이라 둘째 줄 끝에서 똑같이 잘렸습니다(검토 지적). 이제 28rem 이상에서도 좁은 패널처럼 끝까지 줄바꿈하고(줄 수 제한 없음),
  // 오른쪽 메타 칸·title·설명 한 줄·줄 높이는 그대로입니다. jsdom은 줄 수를 재지 못하므로 클래스를 대조합니다(Chromium에서 같은 마크업으로 잰 값 —
  // 커밋 글). 바꾸기 전 실패: 이름 span의 넓은 패널 클래스가 '@md:line-clamp-2'(두 줄 제한).
  const LONG: SearchLink[] = [1, 2].map((n) => ({
    relation: "subsidiary",
    key: null,
    name: `Example Subsidiary International Holdings Asia Pacific Regional Operations Limited Partnership Number ${n}`,
    kind: "company",
    source: "gleif",
    detail: `SG · LEI 0000EXAMPLE00000000L0${n}`,
  }));

  it("이름은 끝까지 줄바꿈(줄 수 제한·말줄임 없음)·전체 이름은 title, 설명은 한 줄, 메타는 오른쪽 칸, 줄 높이 lg 미만 44px", () => {
    const view: LinksView = { groups: linkGroups([...LONG, INSIDER]), extra: null, sources: [], empty: null, entityNote: null };
    render(<LinksPanel view={view} centerName="Example Corp" onTarget={() => {}} onRetry={() => {}} />);
    for (const link of [...LONG, INSIDER]) {
      const button = screen.getByRole("button", { name: new RegExp(link.name) });
      expect(classes(button)).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-8"]));

      const name = within(button).getByText(link.name);
      expect(classes(name)).toContain("break-words");
      expect(classes(name).filter((word) => /truncate|line-clamp/.test(word))).toEqual([]);
      expect(name.getAttribute("title")).toBe(link.name);

      const detail = within(button).getByText(link.detail!);
      expect(classes(detail)).toContain("@md:truncate");
      expect(detail.getAttribute("title")).toBe(link.detail);

      // 오른쪽 메타 칸(28rem 이상에서 줄어들지 않음)과 이름·설명 칸의 가로 배치는 그대로.
      const meta = within(button).getByText(link.kind === "person" ? "사람 · Yahoo · 이름으로 찾기" : "기업 · GLEIF · 이름으로 찾기");
      expect(classes(meta)).toContain("@md:shrink-0");
      expect(classes(meta.parentElement!)).toEqual(expect.arrayContaining(["@md:flex-row", "@md:items-baseline"]));
      expect(classes(name.parentElement!)).toEqual(expect.arrayContaining(["min-w-0", "@md:flex-1"]));
    }
  });

  it("넓은 패널에서도 아이콘·꺾쇠는 이름의 첫 줄, 메타는 이름 첫 줄의 글자 밑선에 — 여러 줄 이름의 세로 가운데로 내려가지 않음(2차 검토 지적)", () => {
    // 2차 검토 지적: 28rem 이상에서도 이름이 여러 줄이 되면서(3b7283a0·1a6aa5c6), 줄 단추와 가운데 칸의 '@md:items-center' 때문에 종류 아이콘·꺾쇠·메타가
    // 여러 줄 이름의 세로 가운데로 내려갔습니다 — Chromium에서 패널 470(1100 화면)의 110자 이름(4줄)이 아이콘·꺾쇠 38px·메타 40px 아래, 496에서 28px,
    // 570에서 18px(좁은 패널 296·410·442는 0px). 이제 줄 단추는 글 묶음 전체만 세로 가운데에 두고(한 줄 이름은 지금처럼 가운데), 묶음 안에서 아이콘·꺾쇠는
    // 첫 줄(20px 칸), 메타는 첫 줄의 글자 밑선(items-baseline)에 맞춥니다 — 같은 마크업을 Chromium에서 재면 패널 296~570 모두 아이콘·꺾쇠 0px, 넓은
    // 패널의 메타 3px(12px 글자의 밑선이 14px 글자의 밑선과 같음), 줄 높이는 그대로(커밋 글).
    // 바꾸기 전 실패: 줄 단추와 가운데 칸에 '@md:items-center'.
    const view: LinksView = { groups: linkGroups([...LONG, INSIDER]), extra: null, sources: [], empty: null, entityNote: null };
    render(<LinksPanel view={view} centerName="Example Corp" onTarget={() => {}} onRetry={() => {}} />);
    for (const link of [...LONG, INSIDER]) {
      const button = screen.getByRole("button", { name: new RegExp(link.name) });
      const row = button.firstElementChild!;
      expect([...button.querySelectorAll("*"), button].filter((element) => classes(element).includes("@md:items-center"))).toEqual([]);
      expect(classes(row)).toEqual(expect.arrayContaining(["flex", "items-start"]));
      const name = within(button).getByText(link.name);
      const [icon, middle, chevron] = [...row.children];
      expect(middle.contains(name)).toBe(true);
      for (const box of [icon, chevron]) expect(classes(box)).toEqual(expect.arrayContaining(["h-5", "items-center", "shrink-0"]));
      expect(classes(middle)).toEqual(expect.arrayContaining(["@md:flex-row", "@md:items-baseline"]));
    }
  });
});

describe("연결 그림 — 칸이 그림의 가장 작은 폭(280)보다 좁으면 줄여 그리지 않고 가로로 넘김(QA-424 검토 지적)", () => {
  // 검토 지적: 칸이 280px보다 좁으면(지금은 폭 약 374px 미만의 좁은 휴대폰 — QA-420 전에는 세 칸이던 1024~약 1140 화면의 가운데 칸이 1024에서 안쪽 약 164px) linkGraphSize가 폭을 280으로 올려, width="100%"인 SVG가 뷰박스 280을
  // 칸 폭에 맞춰 줄여 그렸습니다 — 노드·관계 글 12px이 1024에서 약 7px(164/280)로 보여 글자 하한(ADR 0041 결정 11)을 어겼습니다.
  // jsdom은 배치를 재지 못하므로 칸 폭(clientWidth)을 정해 두고 SVG의 폭 속성·클래스와 감싼 칸의 넘김을 대조합니다.
  const renderGraph = (width: number) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    render(<LinksGraph groups={linkGroups([INSIDER, ...SUBSIDIARIES])} centerName="Example Corp" onTarget={() => {}} onShowList={() => {}} />);
    const svg = screen.getByRole("group", { name: /Example Corp의 연결 그림/ });
    return { svg, box: svg.parentElement! };
  };

  it("칸 164px — 그림은 뷰박스와 같은 폭 280px 그대로(글자 12px), 감싼 칸에서 가로로 넘기고 처음에는 가운데로 넘겨 둠", () => {
    const { svg, box } = renderGraph(164);
    expect(svg.getAttribute("viewBox")).toMatch(/^0 \d+ 280 \d+$/);
    expect(svg.getAttribute("width")).toBe("280");
    expect(classes(svg)).toContain("max-w-none");
    expect(classes(svg)).not.toContain("max-w-full");
    expect(classes(box)).toContain("overflow-x-auto");
    expect(box.scrollLeft).toBe((280 - 164) / 2);
  });

  it("칸 296px(390 화면)·570px(1440 화면) — 뷰박스가 칸 폭과 같아 지금처럼 칸에 맞춤(넘기지 않음)", () => {
    for (const width of [296, 570]) {
      const { svg, box } = renderGraph(width);
      expect(svg.getAttribute("viewBox")).toMatch(new RegExp(`^0 \\d+ ${width} \\d+$`));
      expect(svg.getAttribute("width")).toBe("100%");
      expect(classes(svg)).toContain("max-w-full");
      expect(classes(box)).not.toContain("overflow-x-auto");
      cleanup();
    }
  });
});

describe("연결 그림 — 가로로 넘기는 칸에서 Tab으로 간 노드의 고리·이름이 칸 안에 다 보이게 그 칸만 넘김(QA 재확인 개선 제안)", () => {
  // 320 화면(칸 226 < 그림 280)에서 처음 가운데로 넘긴 자리(scrollLeft 27)의 양끝 노드 이름이 칸 밖으로 18~19px 잘렸고, Tab으로 그 노드에 닿아도
  // 칸이 넘겨지지 않았습니다(포커스 고리만 칸 안). 이제 포커스가 간 노드의 고리와 이름(그린 글의 폭 — jsdom은 재지 못해 어림 폭)이 칸 가장자리 4px
  // 안쪽에 들게 그 칸만 가장 적게 넘깁니다(페이지는 넘기지 않음, 움직임 줄이기면 바로).
  // 바꾸기 전 실패: 노드에 포커스해도 칸의 scrollLeft가 27 그대로이고 scrollTo를 부르지 않음.
  const WIDE_CHAR = /[ᄀ-ᇿ…⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
  const estimate = (text: string) =>
    Array.from(text).reduce((sum, char) => sum + (WIDE_CHAR.test(char) || /[MW]/.test(char) ? 12 : /\p{Lu}/u.test(char) ? 9 : 7.5), 0);
  const WIKIDATA: SearchLink[] = [
    ["owner_of", "Sample Owned Subsidiary Holdings"],
    ["owned_by", "Sample Owner Investment Fund One"],
    ["founded_by", "Sample Founder Alexander Example"],
    ["founded_by", "Sample Founder Benjamin Example"],
    ["employer", "Sample Employer Corporation"],
    ["ceo", "Sample Chief Executive Person"],
    ["parent", "Sample Parent Holdings Group"],
    ["subsidiary", "Sample Subsidiary One"],
  ].map(([relation, name], at) => ({ relation, key: `wd:Q${700 + at}`, name, kind: "company", source: "wikidata", detail: null }));

  const renderGraph = (width: number) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    render(<LinksGraph groups={linkGroups(WIKIDATA)} centerName="Sample Center Co." onTarget={() => {}} onShowList={() => {}} />);
    const svg = screen.getByRole("group", { name: /Sample Center Co\.의 연결 그림/ });
    const nodes = within(svg).getAllByRole("button");
    return { box: svg.parentElement!, nodes };
  };
  /** 노드의 가로 범위(그림 좌표 = 칸 좌표, 넘길 때 그림은 뷰박스와 같은 px 폭) — 포커스 고리(r 11 + 테두리 1)와 이름(어림 폭). */
  const extentOf = (node: HTMLElement) => {
    const x = Number(node.querySelector("circle")!.getAttribute("cx"));
    const text = node.querySelector("text")!;
    const labelX = Number(text.getAttribute("x"));
    const width = estimate(text.textContent ?? "");
    return text.getAttribute("text-anchor") === "start"
      ? { left: x - 12, right: Math.max(x + 12, labelX + width) }
      : { left: Math.min(x - 12, labelX - width), right: x + 12 };
  };
  const withScrollTo = (run: (scrollTo: ReturnType<typeof vi.fn>) => void) => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    try {
      run(scrollTo);
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  };

  it("칸 226px — 노드마다 Tab으로 가면 그 노드의 고리·이름이 칸 안(가장자리 4px 안쪽), 처음 자리에서 잘린 노드가 있었음", () => {
    const { box, nodes } = renderGraph(226);
    expect(box.scrollLeft).toBe(27);
    const clippedAtStart = nodes.filter((node) => {
      const { left, right } = extentOf(node);
      return left < 27 || right > 27 + 226;
    });
    expect(clippedAtStart.length).toBeGreaterThan(0);
    for (const node of nodes) {
      act(() => node.focus());
      expect(document.activeElement).toBe(node);
      const { left, right } = extentOf(node);
      const label = node.querySelector("text")!.textContent;
      expect([label, left - 4 >= box.scrollLeft - 1e-9, right + 4 <= box.scrollLeft + 226 + 1e-9]).toEqual([label, true, true]);
      expect(box.scrollLeft).toBeGreaterThanOrEqual(0);
      expect(box.scrollLeft).toBeLessThanOrEqual(280 - 226);
    }
  });

  it("칸의 scrollTo로 부드럽게(움직임 줄이기면 바로) — 페이지(window)는 넘기지 않고, 이미 다 보이는 노드·넘기지 않는 칸에서는 부르지 않음", () => {
    withScrollTo((scrollTo) => {
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const { box, nodes } = renderGraph(226);
      const clipped = nodes.find((node) => extentOf(node).right > 27 + 226)!;
      act(() => clipped.focus());
      expect(scrollTo).toHaveBeenCalledTimes(1);
      const [{ left, behavior }] = scrollTo.mock.calls[0] as [{ left: number; behavior: string }];
      expect(behavior).toBe("smooth");
      expect(left).toBeCloseTo(Math.min(280 - 226, extentOf(clipped).right + 4 - 226), 6);
      expect(scrollTo.mock.instances[0]).toBe(box);
      expect(windowScroll).not.toHaveBeenCalled();

      // 넘긴 뒤(가짜 scrollTo라 자리를 직접 옮김) 그 노드에 다시 오면 이미 다 보여 부르지 않음.
      box.scrollLeft = left;
      act(() => clipped.blur());
      act(() => clipped.focus());
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // 움직임 줄이기 — 바로 옮김.
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList);
      const leftClipped = nodes.find((node) => extentOf(node).left < 27)!;
      act(() => leftClipped.focus());
      expect(scrollTo).toHaveBeenCalledTimes(2);
      expect((scrollTo.mock.calls[1] as [{ behavior: string }])[0].behavior).toBe("auto");
      cleanup();

      // 칸이 그림보다 넓으면(넘기지 않음) 부르지 않음.
      scrollTo.mockClear();
      const wide = renderGraph(570);
      for (const node of wide.nodes) act(() => node.focus());
      expect(scrollTo).not.toHaveBeenCalled();
      expect(windowScroll).not.toHaveBeenCalled();
    });
  });

  it("앞 노드로 가는 부드러운 넘김이 끝나기 전에 다른 노드로 가면, 넘김이 멈출 자리에서도 그 노드가 다 보이게 목표를 다시 정함(2차 검토 지적)", () => {
    // 2차 검토 지적: 넘김을 지금의 scrollLeft로만 판정해, 앞 노드로 가는 부드러운 넘김(scrollTo smooth)이 진행 중일 때 다른 노드로 가면 지금 자리에서는
    // '다 보임'이라 아무것도 하지 않았고, 넘김이 앞 노드의 목표까지 가서 방금 포커스한 노드의 이름이 칸 밖으로 잘렸습니다(빠른 Tab·Shift+Tab — 칸 226에서
    // scrollLeft 51.7에 'Sa…Emp…'로 가 22.5로 넘기는 동안 'Sa…Ben…'으로 돌아오면 22.5에서 이름 오른쪽 14.5px가 잘림). 가짜 scrollTo는 자리를 옮기지 않아
    // (넘김이 막 시작한 상태) scrollLeft가 그 자리 그대로입니다.
    // 바꾸기 전 실패: 둘째 노드에서 scrollTo를 부르지 않아 마지막 목표(첫 노드의 목표)에서 둘째 노드가 칸 밖.
    withScrollTo((scrollTo) => {
      const { box, nodes } = renderGraph(226);
      const visibleAt = (node: HTMLElement, scrollLeft: number) => {
        const { left, right } = extentOf(node);
        return left - 4 >= scrollLeft - 1e-9 && right + 4 <= scrollLeft + 226 + 1e-9;
      };
      /** from에서 그 노드로 갈 때의 목표(칸 밖에 걸친 쪽만 맞춤). */
      const target = (node: HTMLElement, from: number) => {
        const { left, right } = extentOf(node);
        return Math.min(280 - 226, Math.max(0, left - 4 < from ? left - 4 : right + 4 - 226));
      };
      const starts = [...new Set(nodes.map((node) => target(node, 27)))];
      const cases = starts.flatMap((from) =>
        nodes.flatMap((first) =>
          visibleAt(first, from)
            ? []
            : nodes.filter((second) => visibleAt(second, from) && !visibleAt(second, target(first, from))).map((second) => ({ from, first, second })),
        ),
      );
      expect(cases.length).toBeGreaterThan(0);
      for (const { from, first, second } of cases) {
        act(() => (document.activeElement as HTMLElement | null)?.blur());
        box.scrollLeft = from;
        act(() => box.dispatchEvent(new Event("scroll")));
        scrollTo.mockClear();
        act(() => first.focus());
        expect(scrollTo).toHaveBeenCalledTimes(1);
        act(() => second.focus());
        const calls = scrollTo.mock.calls as [{ left: number }][];
        const end = calls[calls.length - 1][0].left;
        const label = second.querySelector("text")!.textContent;
        expect([from, label, visibleAt(second, end)]).toEqual([from, label, true]);
        // 넘김이 끝나면(그 자리에 닿아 scroll 사건) 다시 지금 자리에서 판정 — 다 보이는 노드에 다시 와도 부르지 않음.
        box.scrollLeft = end;
        act(() => box.dispatchEvent(new Event("scroll")));
        scrollTo.mockClear();
        act(() => second.blur());
        act(() => second.focus());
        expect(scrollTo).not.toHaveBeenCalled();
      }
    });
  });
});
