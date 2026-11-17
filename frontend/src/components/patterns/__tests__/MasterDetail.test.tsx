/**
 * MasterDetail — 목록-검사(작업대 실행 명세 §6, P4 — 상세 화면 보유 탭).
 * 네 상태: 불러오는 중(placeholder Skeleton), 빈 값(줄 없음 → emptyText), 오류(placeholder 글), 값 있음(줄 + 검사 칸 / 대화상자).
 * 좁은 화면(기본 — jsdom의 matchMedia는 늘 거짓): 누르기 → 대화상자(이름 = 줄 이름), Esc → 닫히고 그 줄로 포커스, 목록 키는 포커스만 옮김.
 * 넓은 화면(matchMedia 대역 참): 고름이 포커스를 따라감(aria-current·검사 칸 제목), Esc → 안내 글, autoSelectFirst. 목록 표지 data-shell-list, 고른 줄 막대.
 * jsdom은 크기 질의를 계산하지 않으므로 검사 칸 자리(@lg 옆)는 클래스로만 봅니다(실제 폭은 D2 전 브라우저 확인). 넓은 화면의 좁은 틀(32rem 미만 — 검사 칸이
 * 아래로 쌓이던 폭)은 틀 폭(getBoundingClientRect)과 ResizeObserver 대역으로 흉내 내어, 대화상자로 여는지·폭이 바뀌면 따라가는지 봅니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

import { MasterDetail } from "../MasterDetail";
import { PropertyList } from "../PropertyList";
import { Skeleton } from "../Skeleton";

type Holding = { cusip: string; name: string; weight: string };

const HOLDINGS: Holding[] = [
  { cusip: "037833100", name: "Apple Inc.", weight: "22.1%" },
  { cusip: "060505104", name: "Bank of America", weight: "11.4%" },
  { cusip: "025816109", name: "American Express", weight: "9.8%" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

function renderList(props: Partial<Parameters<typeof MasterDetail<Holding>>[0]> = {}) {
  return render(
    <MasterDetail<Holding>
      label="상위 보유 종목"
      items={HOLDINGS}
      itemKey={(row) => row.cusip}
      itemLabel={(row) => row.name}
      renderItem={(row) => (
        <span className="flex justify-between gap-2">
          <span>{row.name}</span>
          <span className="tabular-nums">{row.weight}</span>
        </span>
      )}
      renderDetail={(row) => <PropertyList items={[{ label: "CUSIP", value: row.cusip, mono: true }, { label: "비중", value: row.weight }]} />}
      {...props}
    />,
  );
}

const list = () => screen.getByRole("list", { name: "상위 보유 종목" });
const rows = () => within(list()).getAllByRole("button");
const row = (name: string) => within(list()).getByRole("button", { name: new RegExp(name) });

describe("MasterDetail — 공통", () => {
  it("목록은 이름 있는 ul[data-shell-list] > li > button(type=button), Tab 정지점은 하나(첫 줄)", () => {
    renderList();
    expect(list().tagName).toBe("UL");
    expect(list().hasAttribute("data-shell-list")).toBe(true);
    expect(rows()).toHaveLength(3);
    expect(rows().every((button) => button.getAttribute("type") === "button" && button.parentElement?.tagName === "LI")).toBe(true);
    expect(rows().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  });

  it("줄은 좁은 화면 44px(min-h-11)·넓은 화면 32px 여백, hover 중립 바탕·포커스 링 — 강조 파랑 클래스가 없다", () => {
    const { container } = renderList();
    const first = rows()[0].className.split(/\s+/);
    expect(first).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-0", "lg:pt-1.5", "lg:pb-[5px]", "border-b", "border-border-subtle", "hover:bg-surface-2"]));
    expect(first).toEqual(expect.arrayContaining(["focus-visible:outline-focus"]));
    expect(rows()[2].className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:py-1.5"]));
    expect(rows()[2].className).not.toContain("border-b");
    const accent = [...container.querySelectorAll("[class]")].flatMap((element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter((token) => token.includes("accent")),
    );
    expect(accent).toEqual([]);
  });

  it("count — 목록 위 개수 줄('3건', 함수면 그 글)", () => {
    renderList({ count: true });
    expect(screen.getByText("3건").className).toContain("tabular-nums");
    cleanup();
    renderList({ count: (n) => `${n}종목 가운데 비중 상위` });
    expect(screen.getByText("3종목 가운데 비중 상위")).toBeTruthy();
  });
});

describe("MasterDetail — 좁은 화면(대화상자)", () => {
  it("줄을 누르면 그 줄 이름의 대화상자에 검사 내용이 열리고, 줄 단추는 aria-haspopup=dialog·aria-expanded", () => {
    renderList();
    const target = row("Bank of America");
    expect(target.getAttribute("aria-haspopup")).toBe("dialog");
    expect(target.getAttribute("aria-expanded")).toBe("false");
    expect(target.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    fireEvent.click(target);
    const dialog = screen.getByRole("dialog", { name: "Bank of America" });
    expect(within(dialog).getByText("060505104").className).toContain("font-mono");
    // 열린 동안 뒤 화면은 Radix가 aria-hidden으로 가려 역할로 찾지 않고 같은 단추를 봅니다.
    expect(target.getAttribute("aria-expanded")).toBe("true");
  });

  it("Esc로 닫으면 대화상자가 사라지고 그 줄로 포커스가 돌아간다", async () => {
    renderList();
    const target = row("American Express");
    target.focus();
    fireEvent.click(target);
    const dialog = screen.getByRole("dialog", { name: "American Express" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row("American Express")));
  });

  it("j/k·↑↓·Home·End는 포커스만 옮긴다 — 대화상자는 열리지 않고 고른 줄도 없다, 처리한 키는 기본 동작을 막는다", () => {
    renderList();
    const [first, second, third] = rows();
    first.focus();
    expect(fireEvent.keyDown(first, { key: "j" })).toBe(false);
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "j" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "k" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rows().some((button) => button.hasAttribute("aria-current"))).toBe(false);
    // Tab 정지점이 포커스를 따라간다(roving tabindex)
    expect(rows().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
    // 좁은 화면의 Esc는 목록이 쓰지 않는다(대화상자가 없으면 기본 그대로)
    expect(fireEvent.keyDown(second, { key: "Escape" })).toBe(true);
  });

  it("한글 조합 중·Ctrl/⌘/Alt와 함께·대문자 J는 무시한다 — 포커스 그대로, 기본 동작도 그대로", () => {
    renderList();
    const [first] = rows();
    first.focus();
    for (const init of [{ key: "j", isComposing: true }, { key: "Process", keyCode: 229 }, { key: "j", ctrlKey: true }, { key: "j", metaKey: true }, { key: "ArrowDown", altKey: true }, { key: "J", shiftKey: true }]) {
      expect(fireEvent.keyDown(first, init), JSON.stringify(init)).toBe(true);
      expect(document.activeElement, JSON.stringify(init)).toBe(first);
    }
  });

  // QA-590 뒤: 닫히면서 대화상자로 본 줄을 고릅니다(그 전에는 '고른 줄 없음' 안내 글).
  it("대화상자가 열린 채 넓은 화면으로 바뀌면 닫히고 그 줄을 고르며, 다시 좁아져도 저절로 다시 열리지 않는다", () => {
    let wide = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: wide && query === WIDE_SHELL_MEDIA,
          media: query,
          addEventListener: (_: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
        }) as unknown as MediaQueryList,
    );
    const resize = (next: boolean) =>
      act(() => {
        wide = next;
        for (const listener of [...listeners]) listener();
      });
    renderList();
    fireEvent.click(row("Apple"));
    expect(screen.getByRole("dialog", { name: "Apple Inc." })).toBeTruthy();
    resize(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "상위 보유 종목 — Apple Inc." })).toBeTruthy();
    expect(row("Apple").getAttribute("aria-current")).toBe("true");
    resize(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("autoSelectFirst여도 좁은 화면에서는 아무것도 고르지 않는다 — 대화상자가 저절로 열리지 않음", () => {
    renderList({ autoSelectFirst: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rows().some((button) => button.hasAttribute("aria-current"))).toBe(false);
  });
});

describe("MasterDetail — 넓은 화면(검사 칸)", () => {
  it("고른 줄이 없으면 검사 칸에 안내 글, 줄을 누르면 aria-current와 검사 칸(영역 이름 = 목록 이름 — 줄 이름, 제목 h3 = 줄 이름)", () => {
    stubWide();
    renderList();
    const inspector = screen.getByRole("region", { name: "상위 보유 종목 — 고른 줄 없음" });
    expect(within(inspector).getByText("줄을 고르면 이 칸에 자세한 값이 나옵니다(j/k·↑↓로 옮김).")).toBeTruthy();
    expect(rows().every((button) => button.getAttribute("aria-controls") === inspector.id)).toBe(true);
    expect(rows()[0].getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(row("Bank of America"));
    expect(row("Bank of America").getAttribute("aria-current")).toBe("true");
    // 영역 이름은 목록 이름 + 고른 줄 이름(무엇을 위한 칸인지 — 낭독기 영역 목록), 제목 h3은 줄 이름
    const region = screen.getByRole("region", { name: "상위 보유 종목 — Bank of America" });
    expect(within(region).getByRole("heading", { level: 3, name: "Bank of America" })).toBeTruthy();
    expect(within(region).getByText("060505104")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("j/k가 포커스와 고름(aria-current)을 함께 옮기고 검사 칸 제목이 바뀐다 — 고른 줄에 잉크 막대·중립 바탕", () => {
    stubWide();
    const onChange = vi.fn();
    renderList({ onSelectedKeyChange: onChange });
    const [first, second] = rows();
    first.focus();
    fireEvent.keyDown(first, { key: "j" });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(first.getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Bank of America" })).toBeTruthy();
    expect(second.className.split(/\s+/)).toContain("bg-surface-2");
    const bar = second.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(bar.className).toContain("bg-text");
    expect(bar.className).toContain("w-[3px]");
    fireEvent.keyDown(second, { key: "End" });
    expect(screen.getByRole("heading", { level: 3, name: "American Express" })).toBeTruthy();
    expect(onChange.mock.calls.map(([key]) => key)).toEqual(["060505104", "025816109"]);
  });

  it("headingLevel로 검사 칸 제목 단계를 바꾼다 — 기본 h3, 2면 h2(글자 단계는 그대로)", () => {
    stubWide();
    renderList({ autoSelectFirst: true, headingLevel: 2 });
    const heading = screen.getByRole("heading", { level: 2, name: "Apple Inc." });
    expect(heading.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-heading-sm", "text-text"]));
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("Esc는 고른 줄이 있을 때만 고름을 풀고(안내 글) 기본 동작을 막는다 — 없으면 그대로", () => {
    stubWide();
    renderList();
    fireEvent.click(row("Apple"));
    expect(fireEvent.keyDown(row("Apple"), { key: "Escape" })).toBe(false);
    expect(row("Apple").getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("줄을 고르면 이 칸에 자세한 값이 나옵니다(j/k·↑↓로 옮김).")).toBeTruthy();
    expect(fireEvent.keyDown(row("Apple"), { key: "Escape" })).toBe(true);
  });

  it("autoSelectFirst — 처음에 첫 줄을 보이고, Esc로 닫은 뒤에는 다시 저절로 고르지 않는다", () => {
    stubWide();
    const onChange = vi.fn();
    renderList({ autoSelectFirst: true, onSelectedKeyChange: onChange });
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(rows().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole("heading", { level: 3, name: "Apple Inc." })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(rows()[0], { key: "Escape" });
    expect(rows().some((button) => button.hasAttribute("aria-current"))).toBe(false);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("selectedKey를 주면 부르는 쪽이 쥔다 — 바꾸면 그 줄", () => {
    stubWide();
    const { rerender } = renderList({ selectedKey: "025816109" });
    expect(row("American Express").getAttribute("aria-current")).toBe("true");
    act(() => {
      rerender(
        <MasterDetail<Holding>
          label="상위 보유 종목"
          items={HOLDINGS}
          itemKey={(item) => item.cusip}
          itemLabel={(item) => item.name}
          renderItem={(item) => item.name}
          renderDetail={(item) => item.weight}
          selectedKey="037833100"
        />,
      );
    });
    expect(row("Apple").getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { level: 3, name: "Apple Inc." })).toBeTruthy();
  });

  it("검사 칸은 칸 폭 32rem 이상이면 목록 옆(15rem) — 크기 질의 클래스, 옆에서는 스크롤 영역 위쪽에 붙어 따라온다(sticky)", () => {
    stubWide();
    const { container } = renderList();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain("@container");
    const grid = list().parentElement as HTMLElement;
    expect(grid.className.split(/\s+/)).toEqual(expect.arrayContaining(["grid", "gap-3", "@lg:grid-cols-[minmax(0,1fr)_15rem]"]));
    // 긴 화면 목차의 가로 줄이 보이면 그 줄 아래 16px(--section-strip-h — 없으면 0이라 16px, QA-657).
    expect(screen.getByRole("region").className.split(/\s+/)).toEqual(
      expect.arrayContaining(["self-start", "@lg:sticky", "@lg:top-[calc(var(--section-strip-h,0px)+1rem)]"]),
    );
  });
});

describe("MasterDetail — 넓은 화면의 좁은 틀(32rem 미만)", () => {
  /** 틀(@container) 폭을 흉내 냅니다 — width를 바꾸고 resize()를 부르면 ResizeObserver 콜백이 돕니다. */
  function stubFrameWidth(initial: number) {
    const frame = { width: initial };
    const callbacks = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          callbacks.add(this.callback);
        }
        unobserve() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
      },
    );
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("@container") ? ({ width: frame.width, height: 0, top: 0, left: 0, right: frame.width, bottom: 0, x: 0, y: 0 } as DOMRect) : original.call(this);
    });
    return {
      resize: (width: number) =>
        act(() => {
          frame.width = width;
          for (const callback of [...callbacks]) callback();
        }),
    };
  }

  it("틀 폭이 32rem(512px) 미만이면 검사 칸을 목록 아래에 두지 않고 대화상자로 연다 — 키는 포커스만 옮기고 autoSelectFirst도 고르지 않는다", () => {
    stubWide();
    stubFrameWidth(482);
    renderList({ autoSelectFirst: true });
    expect(screen.queryByRole("region")).toBeNull();
    expect(rows().some((button) => button.hasAttribute("aria-current"))).toBe(false);
    expect(rows()[0].getAttribute("aria-haspopup")).toBe("dialog");
    const [first, second] = rows();
    first.focus();
    fireEvent.keyDown(first, { key: "j" });
    expect(document.activeElement).toBe(second);
    expect(second.hasAttribute("aria-current")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(second);
    expect(screen.getByRole("dialog", { name: "Bank of America" })).toBeTruthy();
  });

  // QA-590 뒤: 다시 넓어지면 대화상자로 본 줄(Apple)을 고르고 포커스도 그 줄입니다(그 전에는 앞서 고른 Bank of America를 다시 보였음 — 포커스와 갈라짐).
  it("틀 폭이 바뀌면 동작이 따라간다 — 옆 → 좁은 틀이면 검사 칸이 빠지고, 다시 넓어지면 열린 대화상자를 닫고 대화상자로 본 줄을 고른다", async () => {
    stubWide();
    const frame = stubFrameWidth(600);
    renderList();
    fireEvent.click(row("Bank of America"));
    expect(screen.getByRole("heading", { level: 3, name: "Bank of America" })).toBeTruthy();
    frame.resize(434);
    expect(screen.queryByRole("region")).toBeNull();
    expect(row("Bank of America").hasAttribute("aria-current")).toBe(false);
    fireEvent.click(row("Apple"));
    expect(screen.getByRole("dialog", { name: "Apple Inc." })).toBeTruthy();
    frame.resize(594);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row("Apple").getAttribute("aria-current")).toBe("true");
    expect(row("Bank of America").hasAttribute("aria-current")).toBe(false);
    expect(screen.getByRole("heading", { level: 3, name: "Apple Inc." })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(row("Apple")));
    expect(rows().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  });

  // QA-590: 대화상자 배치(좁은 틀)에서 키로 포커스를 옮기거나 대화상자로 줄을 본 뒤 옆 칸 배치로 넓어지면, 고른 줄이 그 줄을 따라가지 않고 예전 고름이나
  // autoSelectFirst의 첫 줄로 돌아갔습니다 — 포커스 링(7번 줄)과 고른 막대·검사 칸(0번 줄)이 갈라지고, Tab 정지점이 포커스 줄이 아닌 고른 줄이라 Shift+Tab이
  // 같은 목록의 다른 줄로 갔습니다(QA 스택 /institutions/0001608046 보유 종목 — 1280에서 메뉴 접기, 1440 → 1280 → 1440).
  // 수정 전(재현 커밋에서는 it.fails)에는 셋째 줄에 포커스가 있어도 첫 줄(Apple)이 aria-current·tabIndex 0이었습니다. 이제 바뀌는 그리기에서 그 줄을 고릅니다.
  it("좁은 틀에서 키로 옮긴 줄은 넓어지면 고른 줄이 된다 — 포커스·aria-current·Tab 정지점·검사 칸이 한 줄 (QA-590)", () => {
    stubWide();
    const frame = stubFrameWidth(600);
    renderList({ autoSelectFirst: true });
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    frame.resize(434);
    const [first, second, third] = rows();
    first.focus();
    fireEvent.keyDown(first, { key: "j" });
    fireEvent.keyDown(second, { key: "j" });
    expect(document.activeElement).toBe(third);
    frame.resize(594);
    expect(document.activeElement).toBe(row("American Express"));
    expect(rows().map((button) => button.getAttribute("aria-current"))).toEqual([null, null, "true"]);
    expect(rows().map((button) => button.tabIndex)).toEqual([-1, -1, 0]);
    expect(screen.getByRole("heading", { level: 3, name: "American Express" })).toBeTruthy();
  });

  // QA-590: 앞서 옆 칸에서 고른 줄이 있으면 그 줄이 남아 Tab 정지점이 되고, 포커스가 있는 줄은 tabIndex -1이었습니다(정지점 하나가 깨짐).
  // 수정 전(재현 커밋에서는 it.fails)에는 Tab 정지점이 Bank of America(앞서 고른 줄), 포커스는 American Express였습니다.
  it("앞서 고른 줄이 있어도 좁은 틀에서 포커스를 옮긴 줄이 넓어진 뒤의 고른 줄이자 하나뿐인 Tab 정지점이다 (QA-590)", () => {
    stubWide();
    const frame = stubFrameWidth(600);
    const onChange = vi.fn();
    renderList({ onSelectedKeyChange: onChange });
    fireEvent.click(row("Bank of America"));
    frame.resize(434);
    const boa = row("Bank of America");
    boa.focus();
    fireEvent.keyDown(boa, { key: "j" });
    expect(document.activeElement).toBe(row("American Express"));
    frame.resize(594);
    const stops = rows().filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(document.activeElement);
    expect(stops[0]).toBe(row("American Express"));
    expect(row("American Express").getAttribute("aria-current")).toBe("true");
    expect(onChange.mock.calls.map(([key]) => key)).toEqual(["060505104", "025816109"]);
  });

  // QA-590 후속(검토): 넓어질 때 포커스 줄을 무조건 골라, 옆 칸에서 Esc로 일부러 고름을 푼 뒤(포커스는 그 줄에 남음) 목록을 건드리지 않고 폭만 좁혔다
  // 넓혀도 그 줄이 다시 골라지고 onSelectedKeyChange도 다시 불렸습니다. 수정 전(이 커밋에서는 it.fails) aria-current [null, null, 'true'], 검사 칸
  // '상위 보유 종목 — American Express', 호출 [060505104, 025816109, null, 025816109]. 이제 고른 줄이 없고 대화상자 배치 동안 목록을 건드리지 않았으면
  // 고르지 않습니다.
  it("옆 칸에서 Esc로 고름을 푼 뒤 목록을 건드리지 않고 좁혔다 넓히면 고른 줄 없음 그대로 — 다시 고르지 않고 onSelectedKeyChange도 부르지 않는다 (QA-590)", () => {
    stubWide();
    const frame = stubFrameWidth(600);
    const onChange = vi.fn();
    renderList({ onSelectedKeyChange: onChange });
    const [first] = rows();
    first.focus();
    fireEvent.keyDown(first, { key: "j" });
    fireEvent.keyDown(row("Bank of America"), { key: "j" });
    fireEvent.keyDown(row("American Express"), { key: "Escape" });
    expect(document.activeElement).toBe(row("American Express"));
    frame.resize(434);
    frame.resize(594);
    expect(rows().map((button) => button.getAttribute("aria-current"))).toEqual([null, null, null]);
    expect(screen.getByRole("region", { name: "상위 보유 종목 — 고른 줄 없음" })).toBeTruthy();
    expect(onChange.mock.calls.map(([key]) => key)).toEqual(["060505104", "025816109", null]);
    // 포커스 줄이 하나뿐인 Tab 정지점(고른 줄이 없으니 갈라지지 않음)
    expect(rows().map((button) => button.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("Esc로 푼 뒤라도 좁은 틀에서 포커스를 옮기거나 대화상자로 줄을 보았으면 넓어질 때 그 줄을 고른다 (QA-590)", async () => {
    stubWide();
    const frame = stubFrameWidth(600);
    const onChange = vi.fn();
    renderList({ onSelectedKeyChange: onChange });
    fireEvent.click(row("Bank of America"));
    fireEvent.keyDown(row("Bank of America"), { key: "Escape" });
    frame.resize(434);
    // 키로 옮김 → 넓히면 옮긴 줄
    fireEvent.keyDown(row("Bank of America"), { key: "j" });
    expect(document.activeElement).toBe(row("American Express"));
    frame.resize(594);
    expect(rows().map((button) => button.getAttribute("aria-current"))).toEqual([null, null, "true"]);
    // 다시 Esc로 풀고 좁힌 뒤 같은 줄을 대화상자로 열었다 닫음 → 넓히면 그 줄
    fireEvent.keyDown(row("American Express"), { key: "Escape" });
    frame.resize(434);
    fireEvent.click(row("American Express"));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "American Express" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row("American Express")));
    frame.resize(594);
    expect(row("American Express").getAttribute("aria-current")).toBe("true");
    expect(onChange.mock.calls.map(([key]) => key)).toEqual(["060505104", null, "025816109", null, "025816109"]);
  });

  it("포커스가 목록 밖이면 넓어져도 앞서 고른 줄(없으면 autoSelectFirst의 첫 줄)을 그대로 보인다 (QA-590)", () => {
    stubWide();
    const frame = stubFrameWidth(600);
    renderList();
    fireEvent.click(row("Bank of America"));
    frame.resize(434);
    (document.activeElement as HTMLElement).blur();
    frame.resize(594);
    expect(row("Bank of America").getAttribute("aria-current")).toBe("true");
    cleanup();

    const again = stubFrameWidth(600);
    renderList({ autoSelectFirst: true });
    again.resize(434);
    again.resize(594);
    expect(rows().map((button) => button.getAttribute("aria-current"))).toEqual(["true", null, null]);
  });

  it("폭을 모르면(0 — 숨긴 탭 안·배치 없는 대역) 크기 질의 배치에 맡겨 옆 검사 칸 동작 그대로", () => {
    stubWide();
    stubFrameWidth(0);
    renderList();
    expect(screen.getByRole("region")).toBeTruthy();
    expect(rows()[0].getAttribute("aria-haspopup")).toBeNull();
  });
});

describe("MasterDetail — 빈 값·불러오는 중·오류", () => {
  it("줄이 없으면 emptyText — 목록·검사 칸이 없다", () => {
    stubWide();
    renderList({ items: [], emptyText: <p role="status">보유 종목이 없습니다.</p> });
    expect(screen.getByRole("status").textContent).toBe("보유 종목이 없습니다.");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("기본 emptyText는 '표시할 항목이 없습니다.'", () => {
    renderList({ items: [] });
    expect(screen.getByText("표시할 항목이 없습니다.")).toBeTruthy();
  });

  it("불러오는 중이면 placeholder(Skeleton role=status) — 목록·개수 줄 없음", () => {
    renderList({ count: true, placeholder: <Skeleton lines={3} label="보유 종목 불러오는 중" /> });
    expect(screen.getByRole("status", { name: "보유 종목 불러오는 중" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("3건")).toBeNull();
  });

  it("오류면 placeholder 글", () => {
    stubWide();
    renderList({ placeholder: <p role="alert">보유 종목을 불러오지 못했습니다.</p> });
    expect(screen.getByRole("alert").textContent).toBe("보유 종목을 불러오지 못했습니다.");
    expect(screen.queryByRole("region")).toBeNull();
  });
});

// QA-661: 넓은 화면 옆 칸 배치에서 줄이 없으면 검사 칸을 그리지 않는데 두 칸 격자('1fr 15rem')는 그대로라, 빈 안내 글이 왼쪽 칸(1440 /regime 342px)에 갇혀
// 오른쪽 240px가 비고 글이 두 줄로 꺾였습니다. 안내 상자에 break-keep도 없어 낱말 가운데서 꺾였습니다('…에 생|깁니다' — 1440·390, P5a QA 모의 빈 기록).
// 이제 줄이 없으면 한 칸이고 안내 글은 낱말 사이에서 꺾습니다. 읽는 중·오류 자리표시는 두 칸 그대로(QA-651 — 값이 온 뒤 목록 폭과 같게).
// 수정 전(재현 커밋에서는 it.fails)에는 격자에 '@lg:grid-cols-[minmax(0,1fr)_15rem]'가 있고 안내 상자에 break-keep이 없었습니다.
describe("QA-661 줄이 없으면 한 칸 — 빈 안내 글이 좁은 왼쪽 칸에 갇히지 않고 낱말 사이에서 꺾인다", () => {
  it("넓은 화면·옆 칸 배치에서 items가 비면 격자에 두 칸 클래스가 없고, 안내 상자는 break-keep·wrap-anywhere", () => {
    stubWide();
    renderList({ items: [], emptyText: <p>아직 기록이 없습니다. 첫 기록은 KST 18시 이후에 생깁니다.</p> });
    const box = screen.getByText("아직 기록이 없습니다. 첫 기록은 KST 18시 이후에 생깁니다.").parentElement as HTMLElement;
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(["break-keep", "wrap-anywhere"]));
    const grid = box.parentElement as HTMLElement;
    expect(grid.className.split(/\s+/)).toContain("grid");
    expect(grid.className).not.toContain("@lg:grid-cols-");
  });

  it("읽는 중·오류 자리표시는 두 칸 격자 그대로(QA-651 — 값이 온 뒤 목록 폭과 같게)", () => {
    stubWide();
    renderList({ items: [], placeholder: <Skeleton lines={3} label="판정 기록 불러오는 중" /> });
    const grid = screen.getByRole("status", { name: "판정 기록 불러오는 중" }).closest(".grid") as HTMLElement;
    expect(grid.className.split(/\s+/)).toContain("@lg:grid-cols-[minmax(0,1fr)_15rem]");
  });
});
