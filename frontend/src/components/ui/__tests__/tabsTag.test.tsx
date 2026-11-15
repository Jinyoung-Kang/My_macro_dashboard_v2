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
