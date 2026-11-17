/**
 * 공용 탭 줄(Tabs)과 태그(Tag) — 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §6.
 *  - 탭: ARIA tabs(tablist 이름·tab·aria-selected·aria-controls·id), Tab 키로는 고른 탭 하나에만 들어옴, 화살표·Home·End는 포커스만 옮기고
 *    여는 것은 누르기(지나가며 onChange를 부르지 않음 — 주소를 바꾸는 화면이 있어서), 모양은 밑줄 탭 하나(지금 탭만 강조 파랑 2px 밑줄)
 *  - 태그: 4px·중립은 아이콘 없음, 의도 태그는 늘 장식 아이콘 + 글(주의·위험은 낭독기 '주의: '), 강조 파랑 없음(원칙 A1),
 *    지울 수 있는 태그의 지우기 단추는 이름이 있고 좁은 화면에서 44px
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tabs, Tag, tabId } from "@/components/ui";

afterEach(() => cleanup());

const ITEMS = [
  { key: "overview", label: "개요" },
  { key: "holdings", label: "보유" },
  { key: "decisions", label: "결정 로그", suffix: <span className="ml-1 text-xs text-text-3">(준비 중)</span> },
] as const;

type Key = (typeof ITEMS)[number]["key"];

function renderTabs(value: Key = "holdings", onChange = vi.fn()) {
  render(
    <>
      <Tabs label="모의 매매 화면" items={ITEMS} value={value} onChange={onChange} idPrefix="paper-tab" panelId="paper-tabpanel" />
      <div role="tabpanel" id="paper-tabpanel" aria-labelledby={tabId("paper-tab", value)}>
        패널
      </div>
    </>,
  );
  return onChange;
}

describe("Tabs", () => {
  it("tablist 이름과 탭마다 aria-selected·aria-controls·id, 패널은 고른 탭 이름으로 읽힌다", () => {
    renderTabs();
    const list = screen.getByRole("tablist", { name: "모의 매매 화면" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["개요", "보유", "결정 로그(준비 중)"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.every((tab) => tab.getAttribute("aria-controls") === "paper-tabpanel")).toBe(true);
    expect(tabs[1].id).toBe("paper-tab-holdings");
    expect(screen.getByRole("tabpanel", { name: "보유" })).toBeTruthy();
  });

  it("Tab 키로는 고른 탭 하나에만 들어온다(나머지 tabIndex -1)", () => {
    renderTabs();
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("화살표·Home·End는 포커스만 옮기고(끝에서 돎) onChange를 부르지 않는다 — 여는 것은 누르기", () => {
    const onChange = renderTabs();
    const [first, second, third] = screen.getAllByRole("tab");
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(third);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(third);
    expect(onChange).toHaveBeenCalledWith("decisions");
  });

  it("모양은 밑줄 탭 하나 — 지금 탭만 강조 파랑 2px 밑줄·굵은 글, 좁은 화면 44px", () => {
    renderTabs();
    const [idle, current] = screen.getAllByRole("tab").map((tab) => tab.className.split(/\s+/));
    expect(current).toEqual(expect.arrayContaining(["border-b-2", "border-accent", "font-semibold", "min-h-11"]));
    expect(idle).toEqual(expect.arrayContaining(["border-b-2", "border-transparent", "min-h-11"]));
    expect(idle).not.toContain("border-accent");
  });
});

describe("Tag", () => {
  it("중립 — 아이콘·낭독기 머리말 없이 글만, 4px·1px 경계·12px", () => {
    const { container } = render(<Tag>NVDA</Tag>);
    const tag = container.firstElementChild as HTMLElement;
    expect(tag.textContent).toBe("NVDA");
    expect(tag.querySelector("svg")).toBeNull();
    expect(tag.className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-control", "border", "text-xs"]));
    // 높이 20px — 글줄 16px(leading-4) + 위아래 1px + 경계. 표 칸 글줄(14/20)과 같고 글 흐름 안에서는 줄 위에 맞춰, 태그가 든 행도 32·28px 그대로(2026-11-16 결정).
    expect(tag.className.split(/\s+/)).toEqual(expect.arrayContaining(["leading-4", "py-px", "align-top"]));
    expect(tag.className.split(/\s+/)).not.toContain("py-0.5");
  });

  it.each([
    ["warn", "text-warn", "주의: "],
    ["danger", "text-danger", "주의: "],
    ["ok", "text-ok", ""],
  ] as const)("%s — 장식 아이콘 + 글(색만이 아님), 톤 글자색 %s, 머리말 '%s'", (tone, text, prefix) => {
    const { container } = render(<Tag tone={tone}>값</Tag>);
    const tag = container.firstElementChild as HTMLElement;
    expect(tag.className).toContain(text);
    expect(tag.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(tag.textContent).toBe(`${prefix}값`);
  });

  it("어느 톤도 강조 파랑을 쓰지 않는다(원칙 A1)", () => {
    const { container } = render(
      <>
        {(["neutral", "warn", "danger", "ok"] as const).map((tone) => (
          <Tag key={tone} tone={tone}>
            {tone}
          </Tag>
        ))}
      </>,
    );
    expect(container.innerHTML).not.toContain("accent");
  });

  it("지울 수 있는 태그 — 이름 있는 지우기 단추(좁은 화면 44px), 누르면 onRemove", () => {
    const onRemove = vi.fn();
    render(
      <Tag onRemove={onRemove}>
        삼성전자
      </Tag>,
    );
    const remove = screen.getByRole("button", { name: "삼성전자 지우기" });
    expect(remove.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-11", "min-w-11"]));
    // 넓은 화면은 작은 조작 24px(명세 §3-7), 위아래 음수 여백으로 줄 높이 16px만 차지해 태그 높이를 키우지 않는다(44 − 28, 24 − 8).
    expect(remove.className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:min-h-6", "lg:min-w-6", "-my-3.5", "lg:-my-1"]));
    expect(remove.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// QA-685(11-18 요청 QA 스택 확인, qa@06f93335): 탭 단추는 key=item.key로 그려, 포커스가 있던 탭이 다시 읽기에서 빠지면(경제 캘린더 날짜 띠의 지난날 등) 그
// 단추가 DOM에서 떨어지고 포커스가 body로 갔습니다 — 로빙 진입점(tabIndex 0)만 옮기고 포커스는 넘기지 않았습니다(포커스 링이 사라지고 낭독기는 자리를
// 잃음. 크롬의 다음 Tab·Shift+Tab은 사라진 자리 근처에서 이어짐 — jsdom은 그 시작점을 흉내 내지 않아 시험은 activeElement를 봅니다).
// 탭 줄 안 포커스가 그 탭과 함께 사라졌을 때만 지금 진입 탭(고른 탭)으로 옮기고, 포커스가 다른 곳이면 건드리지 않습니다(ExcludesPanel QA-444 되돌림과
// 같은 규칙 — activeElement가 body·null일 때만). 수정 전(재현 커밋에서는 it.fails) 포커스가 body였습니다.
describe("QA-685 포커스가 있던 탭이 사라지면 고른 탭으로", () => {
  const ABC = [
    { key: "a", label: "가" },
    { key: "b", label: "나" },
    { key: "c", label: "다" },
  ];

  function view(items: readonly { key: string; label: string }[], value: string) {
    return (
      <>
        <button type="button">바깥</button>
        <Tabs label="날짜" items={items} value={value} onChange={() => {}} idPrefix="day" panelId="day-panel" />
        <div role="tabpanel" id="day-panel" aria-labelledby={tabId("day", value)} />
      </>
    );
  }

  it("고르지 않은 탭에 포커스가 있다가 그 탭이 빠지면 고른 탭으로(스크롤 없이)", () => {
    const { rerender } = render(view(ABC, "b"));
    const third = screen.getByRole("tab", { name: "다" });
    third.focus();
    const selected = screen.getByRole("tab", { name: "나" });
    const focus = vi.spyOn(selected, "focus");
    rerender(view(ABC.slice(0, 2), "b"));
    expect(document.activeElement).toBe(selected);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("고른 탭에 포커스가 있다가 그 탭이 빠지면 새로 고른 탭(새 value)으로", () => {
    const { rerender } = render(view(ABC, "c"));
    screen.getByRole("tab", { name: "다" }).focus();
    rerender(view(ABC.slice(0, 2), "a"));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "가" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1]);
  });

  it("포커스가 줄 밖이거나 남는 탭에 있으면 건드리지 않는다 — 탭이 빠져도, 빠지지 않고 다시 그려도", () => {
    const { rerender } = render(view(ABC, "b"));
    const outside = screen.getByRole("button", { name: "바깥" });
    outside.focus();
    rerender(view(ABC.slice(0, 2), "b"));
    expect(document.activeElement).toBe(outside);

    rerender(view(ABC, "b"));
    const first = screen.getByRole("tab", { name: "가" });
    first.focus(); // 화살표로 옮긴 것처럼 고르지 않은 탭에 포커스
    rerender(view(ABC, "b"));
    expect(document.activeElement).toBe(first);
    rerender(view(ABC.filter((item) => item.key !== "c"), "b"));
    expect(document.activeElement).toBe(first);
  });

  // 지킴(검토 지적): 다시 그릴 때마다 새 ref 함수라 남는 단추도 null로 풀렸다 붙습니다. 풀릴 때 '그 단추가 activeElement였는가'를 보지 않으면 렌더마다
  // 표시가 서고, 아무 데도 포커스가 없는 화면(첫 읽기·빈 곳을 누른 뒤 — activeElement가 body)에서 경제 캘린더의 1분 시계·10분 다시 읽기마다 포커스가
  // 탭 줄로 끌려옵니다. 위 시험은 포커스가 단추에 있는 경우라 layout effect의 body 검사가 따로 막아 그 조건이 빠져도 통과합니다.
  it("포커스가 아무 데도 없으면(body) 다시 그려도·탭이 빠져도 탭 줄로 끌어오지 않는다", () => {
    const { rerender } = render(view(ABC, "b"));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const spies = screen.getAllByRole("tab").map((tab) => vi.spyOn(tab, "focus"));
    rerender(view(ABC, "b"));
    expect(document.activeElement).toBe(document.body);
    rerender(view(ABC.slice(0, 2), "b"));
    expect(document.activeElement).toBe(document.body);
    rerender(view(ABC.slice(0, 2), "a"));
    expect(document.activeElement).toBe(document.body);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  // 지킴(검토 지적): 탭이 빠지지 않고 차례만 바뀌면(key 재배열) React가 옮기는 단추는 DOM 안에서 떼었다 붙여지며 브라우저·jsdom 모두 그 순간 포커스를
  // body로 떨어뜨리지만, React가 바꾸기를 마친 직후(layout effect 앞) 아직 문서에 있는 앞 포커스 요소로 되돌립니다(react-dom 19 commit의 선택 복원 —
  // 인자 없는 focus()). 그래서 화살표로 가 있던 고르지 않은 탭이 그대로 포커스를 지니고 고른 탭으로 튀지 않습니다. [가,나,다] → [다,가,나]에서 React는
  // '다'를 두고 '가'·'나'를 옮기므로 옮겨지는 '가'에 포커스를 둡니다.
  it("차례만 바뀌면 포커스가 있던 탭이 그대로 지닌다 — 옮겨진 단추여도 고른 탭으로 튀지 않음", () => {
    const { rerender } = render(view(ABC, "b"));
    const first = screen.getByRole("tab", { name: "가" });
    first.focus(); // 화살표로 옮긴 것처럼 고르지 않은 탭에 포커스
    const restored = vi.spyOn(first, "focus");
    const selectedFocus = vi.spyOn(screen.getByRole("tab", { name: "나" }), "focus");
    rerender(view([ABC[2], ABC[0], ABC[1]], "b"));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["다", "가", "나"]);
    expect(restored).toHaveBeenCalled(); // 옮겨지며 포커스를 잃었다가 React가 되돌림 — 이 시험이 그 길을 지나는지
    expect(document.activeElement).toBe(first);
    expect(selectedFocus).not.toHaveBeenCalled();
  });
});
