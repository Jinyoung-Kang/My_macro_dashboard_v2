/**
 * 정보 검색 연결 탭 '목록' 보기의 QA 결함 재현·고정 시험(QA-422)과 좁은 칸의 연결 그림(QA-424 검토 지적). 표본은 모두 합성 값입니다(실제 법인·사람의
 * 자료를 쓰지 않음).
 * 배치를 재지 못하는 jsdom이라, 고침이 세우는 구조(클래스·title·요소의 자리)를 대조하고 실제 폭은 QA 스택 브라우저(390·1024·1440)로 확인합니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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
  it("패널 폭이 28rem 미만이면 이름·설명을 줄바꿈하고(말줄임은 @md에서만, 잘릴 수 있는 글에는 title) 메타는 이름 칸 밑의 제 줄 — 줄 높이 44px 그대로", () => {
    const { container } = renderList();
    // 한 줄 배치를 가르는 것은 화면 폭(lg)이 아니라 이 패널의 폭(컨테이너 쿼리).
    expect(classes(container.firstElementChild!)).toContain("@container");
    for (const link of [...SUBSIDIARIES, INSIDER]) {
      const button = screen.getByRole("button", { name: new RegExp(link.name) });
      expect(classes(button)).toContain("min-h-11");
      expect(classes(button)).toEqual(expect.arrayContaining(["items-start", "@md:items-center"]));
      expect(button.className).not.toMatch(/(^|\s)lg:(items-center|flex-row|truncate|shrink-0|flex-1)(\s|$)/);

      const name = within(button).getByText(link.name);
      expect(classes(name)).not.toContain("truncate");
      expect(classes(name)).not.toContain("lg:truncate");
      expect(classes(name)).toEqual(expect.arrayContaining(["break-words", "@md:truncate"]));
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

describe("연결 그림 — 칸이 그림의 가장 작은 폭(280)보다 좁으면 줄여 그리지 않고 가로로 넘김(QA-424 검토 지적)", () => {
  // 검토 지적: 1024~약 1140 화면의 가운데 칸(1024에서 안쪽 약 164px)은 linkGraphSize가 폭을 280으로 올려, width="100%"인 SVG가 뷰박스 280을
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
