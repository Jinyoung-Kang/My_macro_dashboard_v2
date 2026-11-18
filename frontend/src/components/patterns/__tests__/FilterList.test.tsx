/**
 * FilterList — 거르기 목록(작업대 실행 명세 §7 4행, P5b — 교집합 기관 칩 12개 → 거르기 목록, 13F 포트폴리오 기관 목록, P6·P7 거르기).
 * 네 상태: 고름 있음(줄마다 aria-pressed 단추·개수 줄), 빈 목록(emptyText), 읽는 중·오류(placeholder — 목록 대신, 개수 줄 없음), 긴 이름(말줄임 없이 낱말 사이 줄바꿈).
 * 여럿·하나 고름의 누르기(하나는 고른 줄을 다시 눌러도 그대로), Enter·Space(브라우저 단추 기본 동작), 단추 이름에 체크·개수·설명이 섞이지 않음,
 * 좁은 화면 누름 자리 44px, 넓은 화면 32px 줄, 고대비 켠 줄 2px 테두리, 강조 파랑 없음. jsdom은 배치를 계산하지 않으므로 폭별 모양은 클래스로 봅니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorState } from "@/components/ui";
import { SELECTED_BAR } from "@/components/ui/classes";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";

import { FilterList, type FilterListItem } from "../FilterList";
import { Skeleton } from "../Skeleton";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const ITEMS: FilterListItem[] = [
  { key: "a", label: "가상 갑 자산운용", note: "30종목", title: "가상 갑 자산운용 (Fictional Alpha Advisors)" },
  { key: "b", label: "가상 을 연기금" },
  { key: "c", label: "가상 병 투자회사", note: null },
];

/** 단추의 설명 글(aria-describedby가 가리키는 요소들의 글). */
function descriptionOf(button: HTMLElement): string {
  return (button.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

describe("FilterList — 네 상태", () => {
  it("고름 있음(여럿): 이름 있는 묶음, 줄마다 aria-pressed 단추(이름 = label 그대로), 개수 줄", () => {
    render(<FilterList label="분석 대상 기관" items={ITEMS} selected={["a", "c"]} onToggle={() => {}} count />);
    const group = screen.getByRole("group", { name: "분석 대상 기관" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "true"]);
    expect(screen.getByRole("button", { name: "가상 갑 자산운용" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "가상 을 연기금" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(group).getByText("2개 고름 · 전체 3개")).toBeTruthy();
    // 목록(ul) 안 줄(li)마다 단추 하나
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
  });

  it("빈 목록: emptyText(기본 '고를 항목이 없습니다.')만 — 단추·목록 없음", () => {
    const { unmount } = render(<FilterList label="기관" items={[]} selected={[]} onToggle={() => {}} />);
    expect(screen.getByText("고를 항목이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    unmount();
    render(<FilterList label="기관" items={[]} selected={[]} onToggle={() => {}} emptyText="추적하는 기관이 없습니다." count />);
    expect(screen.getByText("추적하는 기관이 없습니다.")).toBeTruthy();
    expect(screen.getByText("0개 고름 · 전체 0개")).toBeTruthy();
  });

  it("읽는 중·오류: placeholder가 목록 대신 — 개수 줄도 없음", () => {
    const retry = vi.fn();
    const { unmount } = render(
      <FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} count placeholder={<Skeleton lines={3} label="기관 목록 불러오는 중" />} />,
    );
    expect(screen.getByRole("status", { name: "기관 목록 불러오는 중" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/개 고름/)).toBeNull();
    unmount();
    render(
      <FilterList
        label="기관"
        items={[]}
        selected={[]}
        onToggle={() => {}}
        placeholder={<ErrorState message="기관 목록을 불러오지 못했습니다." onRetry={retry} />}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("고를 항목이 없습니다.")).toBeNull();
  });

  it("긴 이름: 말줄임 없이 낱말 사이 줄바꿈(break-keep wrap-anywhere), 이름 칸은 남은 폭을 씀", () => {
    const long = "가상 아주 긴 이름의 국제 분산 투자 자산운용 주식회사 (Fictional Very Long Global Diversified Investment Advisors Incorporated)";
    render(<FilterList label="기관" items={[{ key: "x", label: long }]} selected={[]} onToggle={() => {}} />);
    const name = screen.getByText(long);
    expect(tokens(name)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "break-keep", "wrap-anywhere"]));
    expect(tokens(name)).not.toContain("truncate");
    expect(tokens(screen.getByRole("button", { name: long }))).not.toContain("truncate");
  });
});

describe("FilterList — 누르기·이름", () => {
  it("여럿: 누르면 그 키로 onToggle(켠 줄·끈 줄 모두), aria-pressed는 받은 selected대로", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "가상 을 연기금" }));
    fireEvent.click(screen.getByRole("button", { name: "가상 갑 자산운용" }));
    expect(onToggle.mock.calls).toEqual([["b"], ["a"]]);
    rerender(<FilterList label="기관" items={ITEMS} selected={["b"]} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "가상 갑 자산운용" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "가상 을 연기금" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("하나: 다른 줄을 누르면 onToggle, 고른 줄을 다시 누르면 부르지 않음(고름을 비우지 않음)", () => {
    const onToggle = vi.fn();
    render(<FilterList label="분석할 기관" items={ITEMS} selected={["b"]} onToggle={onToggle} selection="single" count />);
    fireEvent.click(screen.getByRole("button", { name: "가상 을 연기금" }));
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "가상 병 투자회사" }));
    expect(onToggle.mock.calls).toEqual([["c"]]);
    expect(screen.getByText("전체 3개")).toBeTruthy();
  });

  it("Enter·Space는 브라우저 단추 기본 동작 — 줄은 type=button 단추이고 키 기본 동작을 막지 않는다", () => {
    render(<FilterList label="기관" items={ITEMS} selected={[]} onToggle={() => {}} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      // fireEvent는 기본 동작을 막으면 false를 돌려줌
      expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    }
  });

  it("단추 이름에 체크 표시·개수·설명이 섞이지 않음 — 체크 상자는 장식, note는 단추 설명(aria-describedby), title은 마우스 설명", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} count={(chosen, total) => `${chosen}/${total}곳`} />);
    const first = screen.getByRole("button", { name: "가상 갑 자산운용" });
    expect(descriptionOf(first)).toBe("30종목");
    expect(first.getAttribute("title")).toBe("가상 갑 자산운용 (Fictional Alpha Advisors)");
    // 체크 상자(켠 줄은 체크 아이콘 포함)는 장식
    const box = first.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(box.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("1/3곳")).toBeTruthy();
    // note가 없거나 null이면 설명 연결도 없음
    expect(screen.getByRole("button", { name: "가상 을 연기금" }).hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByRole("button", { name: "가상 병 투자회사" }).hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("FilterList — 모양(클래스)", () => {
  it("좁은 화면 누름 자리 44px — wrap·list 모두, 여럿·하나 모두 걸리는 것이 없다", () => {
    const { container, unmount } = render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} />);
    expect(smallTargets(container)).toEqual([]);
    unmount();
    const list = render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} narrow="list" selection="single" />);
    expect(smallTargets(list.container)).toEqual([]);
  });

  it("wrap(기본): 좁은 화면은 태그 줄바꿈(4px·1px 경계), 넓은 화면은 세로 목록 32px 줄(마지막 줄은 구분선 없이 위아래 6px)", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} />);
    const list = screen.getByRole("list");
    expect(tokens(list)).toEqual(expect.arrayContaining(["flex", "flex-wrap", "gap-2", "lg:flex-col", "lg:flex-nowrap", "lg:gap-0"]));
    const [first, , last] = screen.getAllByRole("button");
    expect(tokens(first)).toEqual(
      expect.arrayContaining(["min-h-11", "max-lg:inline-flex", "max-lg:rounded-control", "max-lg:border", "lg:w-full", "lg:min-h-0", "lg:pt-1.5", "lg:pb-[5px]", "lg:border-b"]),
    );
    expect(tokens(last)).toEqual(expect.arrayContaining(["lg:py-1.5"]));
    expect(tokens(last)).not.toContain("lg:border-b");
    // 끈 태그는 좁은 화면에서 옅은 경계·보조 글자색, 켠 태그는 진한 경계·surface-2·굵게
    expect(tokens(screen.getByRole("button", { name: "가상 을 연기금" }))).toEqual(
      expect.arrayContaining(["max-lg:border-border", "max-lg:text-text-2", "font-normal"]),
    );
    expect(tokens(first)).toEqual(expect.arrayContaining(["max-lg:border-border-strong", "max-lg:bg-surface-2", "font-semibold", "text-text"]));
  });

  it("list: 모든 폭에서 세로 목록(줄바꿈 태그 모양 없음)", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} narrow="list" />);
    const list = screen.getByRole("list");
    expect(tokens(list)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    expect(tokens(list)).not.toContain("flex-wrap");
    for (const button of screen.getAllByRole("button")) {
      expect(tokens(button)).toContain("w-full");
      expect(tokens(button).some((token) => token.startsWith("max-lg:"))).toBe(false);
    }
  });

  it("여럿: 켠 줄은 잉크 체크 상자(bg-text + 체크)·굵게, 끈 줄은 빈 상자(border-strong — wrap이면 좁은 화면 태그에서는 숨김)", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} />);
    const on = screen.getByRole("button", { name: "가상 갑 자산운용" }).querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(tokens(on)).toEqual(expect.arrayContaining(["size-4", "bg-text", "text-bg", "border-text"]));
    const off = screen.getByRole("button", { name: "가상 을 연기금" }).querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(tokens(off)).toEqual(expect.arrayContaining(["size-4", "border-border-strong", "max-lg:hidden"]));
    expect(off.querySelector("svg")).toBeNull();
    expect(tokens(off)).not.toContain("bg-text");
  });

  it("하나: 고른 줄은 잉크 막대(SELECTED_BAR — wrap이면 넓은 화면만)·굵게·중립 바탕, 체크 상자 없음", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["b"]} onToggle={() => {}} selection="single" />);
    const on = screen.getByRole("button", { name: "가상 을 연기금" });
    const bar = on.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(tokens(bar)).toEqual(expect.arrayContaining([...SELECTED_BAR.split(" "), "max-lg:hidden"]));
    expect(tokens(on)).toEqual(expect.arrayContaining(["relative", "bg-surface-2", "font-semibold"]));
    const off = screen.getByRole("button", { name: "가상 갑 자산운용" });
    expect(off.querySelectorAll("span[aria-hidden='true']")).toHaveLength(1); // note 칸만(막대·상자 없음)
    expect(tokens(off)).not.toContain("bg-surface-2");
  });

  it("고대비: 켠 줄은 2px 테두리(바탕이 지워져도 남음), 끈 줄은 없음", () => {
    render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} />);
    expect(tokens(screen.getByRole("button", { name: "가상 갑 자산운용" }))).toContain("forced-colors:border-2");
    expect(tokens(screen.getByRole("button", { name: "가상 을 연기금" }))).not.toContain("forced-colors:border-2");
  });

  it("강조 파랑을 쓰지 않는다(데이터 영역 안의 고름 — 잉크·중립 바탕)", () => {
    const { container } = render(<FilterList label="기관" items={ITEMS} selected={["a"]} onToggle={() => {}} count />);
    const classes = [...container.querySelectorAll("[class]")].flatMap((element) => tokens(element));
    expect(classes.filter((token) => /accent/.test(token))).toEqual([]);
  });
});

describe("FilterList — 하나 고름은 라디오 묶음(QA-711)", () => {
  /** 부르는 쪽처럼 고름을 상태로 들고 있는 감싸개 — 키로 고르면 다시 그립니다. */
  function Single({ onToggle }: { onToggle: (key: string) => void }) {
    const [chosen, setChosen] = useState("b");
    return (
      <FilterList
        label="분석할 기관"
        items={ITEMS}
        selected={[chosen]}
        onToggle={(key) => {
          onToggle(key);
          setChosen(key);
        }}
        selection="single"
      />
    );
  }

  // 수정 전 실패(plain it): { radiogroup: false, checked: [], tabStops: ["가상 갑 자산운용30종목", "가상 을 연기금", "가상 병 투자회사"], pressed: 3 } — 하나 고름도
  // 여럿 고름과 같은 aria-pressed 토글 단추라, 고른 줄은 '눌림'으로 읽히는데 다시 눌러도 풀리지 않고 줄마다 Tab 정지점(13F 기관 12줄 = 12개 — 개편 전 고르기 상자는 1개).
  it.fails("radiogroup 안의 radio(aria-checked) — 고른 줄만 Tab 정지점, 위·아래·Home·End로 옮기며 고름, 고른 줄을 다시 눌러도 그대로", () => {
    const onToggle = vi.fn();
    const { container } = render(<Single onToggle={onToggle} />);
    const group = screen.queryByRole("radiogroup", { name: "분석할 기관" });
    const radios = group ? within(group).getAllByRole("radio") : [];
    expect({
      radiogroup: group !== null,
      checked: radios.map((radio) => radio.getAttribute("aria-checked")),
      tabStops: [...container.querySelectorAll("button")].filter((button) => button.tabIndex >= 0).map((button) => button.textContent),
      pressed: container.querySelectorAll("[aria-pressed]").length,
    }).toEqual({ radiogroup: true, checked: ["false", "true", "false"], tabStops: ["가상 을 연기금"], pressed: 0 });

    // 아래 화살표 — 다음 줄로 포커스를 옮기며 고름(라디오 묶음의 키 규칙). 끝에서는 처음으로 돌아갑니다.
    radios[1].focus();
    fireEvent.keyDown(radios[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[2]);
    expect(onToggle.mock.calls).toEqual([["c"]]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(radios[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    expect(onToggle.mock.calls).toEqual([["c"], ["a"], ["c"], ["a"], ["c"]]);

    // 고른 줄을 다시 누르면 아무 일 없음(고름을 비우지 않음 — 라디오는 풀리지 않음).
    fireEvent.click(radios[2]);
    expect(onToggle).toHaveBeenCalledTimes(5);
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
  });
});
