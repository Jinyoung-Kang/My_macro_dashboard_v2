/**
 * InspectorFrame · InspectorTrigger — 표·목록의 검사 칸 틀(작업대 실행 명세 §6, P5a — 처음 쓰는 곳 매크로 지표 표·섹터 표).
 * 네 상태: 값 있음(옆 검사 칸 — 영역 이름·제목·내용, 고른 행이 표의 aria-current / 대화상자), 빈 값(고른 줄 없음 — 안내 글, 사라진 키 — 그 사실),
 * 불러오는 중·오류(renderDetail이 Skeleton·ErrorState를 돌려주면 그대로 — 자리표시는 부르는 쪽이 그림).
 * 넓은 화면은 matchMedia 대역(lib/shellCommands WIDE_SHELL_MEDIA)으로, 틀 폭은 getBoundingClientRect·ResizeObserver 대역으로 흉내 냅니다(MasterDetail.test와 같음).
 * jsdom은 크기 질의를 계산하지 않아 옆 칸 자리(@lg·@min-[52rem])는 클래스로 봅니다. 누름 자리(lg 미만 44px), 강조색 없음.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorState } from "@/components/ui";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

import { DataTable } from "../DataTable";
import { InspectorFrame, InspectorTrigger, type InspectorLayout } from "../InspectorFrame";
import { PropertyList } from "../PropertyList";
import { Skeleton } from "../Skeleton";

type Indicator = { key: string; name: string; value: string };

const ROWS: Indicator[] = [
  { key: "us10y", name: "미국채 10년물", value: "4.12%" },
  { key: "dxy", name: "달러 인덱스", value: "104.20" },
  { key: "vix", name: "VIX", value: "15.30" },
];

/** 배치 전환 시험용(QA-660) — 이름 = 키. */
const ABC: Indicator[] = [
  { key: "a", name: "a", value: "1.00" },
  { key: "b", name: "b", value: "2.00" },
  { key: "c", name: "c", value: "3.00" },
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

/** 틀(@container) 폭을 흉내 냅니다 — resize(width)가 ResizeObserver 콜백을 부릅니다. */
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
    return this.classList.contains("@container")
      ? ({ width: frame.width, height: 0, top: 0, left: 0, right: frame.width, bottom: 0, x: 0, y: 0 } as DOMRect)
      : original.call(this);
  });
  return {
    resize: (width: number) =>
      act(() => {
        frame.width = width;
        for (const callback of [...callbacks]) callback();
      }),
  };
}

type FrameProps = Partial<Omit<Parameters<typeof InspectorFrame>[0], "children">> & { rows?: Indicator[]; layout?: InspectorLayout };

function renderFrame({ rows = ROWS, ...props }: FrameProps = {}) {
  return render(
    <InspectorFrame
      label="지표 미리보기"
      titleOf={(key) => rows.find((row) => row.key === key)?.name ?? null}
      renderDetail={(key) => {
        const row = rows.find((entry) => entry.key === key);
        return row ? <PropertyList items={[{ label: "값", value: row.value }, { label: "티커", value: row.key, mono: true }]} /> : null;
      }}
      {...props}
    >
      {(inspector) => (
        <DataTable<Indicator>
          caption="지표"
          rows={rows}
          rowKey={(row) => row.key}
          selectedKey={inspector.shownKey}
          columns={[
            { key: "name", header: "지표", rowHeader: true, cell: (row) => <InspectorTrigger inspector={inspector} itemKey={row.key}>{row.name}</InspectorTrigger> },
            { key: "value", header: "값", align: "right", cell: (row) => row.value },
          ]}
        />
      )}
    </InspectorFrame>,
  );
}

const trigger = (name: string) => screen.getByRole("button", { name });
/** 검사 칸 영역 — 표의 가로 스크롤 상자도 이름 있는 영역이라 이름으로 가립니다. */
const inspectorRegion = () => screen.queryByRole("region", { name: /^지표 미리보기 — / });
const rowOf = (name: string) => trigger(name).closest("tr") as HTMLElement;
const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

describe("InspectorFrame — 옆 검사 칸(넓은 화면·넓은 틀)", () => {
  it("검사 칸에 보이는 줄의 단추 자신이 aria-current(포커스 때 읽힘 — 행에도 있음), 대화상자 배치에서는 어느 단추에도 없다", () => {
    stubWide();
    const { unmount } = renderFrame({ defaultKey: "us10y" });
    expect(trigger("미국채 10년물").getAttribute("aria-current")).toBe("true");
    expect(trigger("VIX").getAttribute("aria-current")).toBeNull();
    fireEvent.click(trigger("VIX"));
    expect(trigger("VIX").getAttribute("aria-current")).toBe("true");
    expect(trigger("미국채 10년물").getAttribute("aria-current")).toBeNull();
    unmount();
    renderFrame({ defaultKey: "us10y", layout: "dialog" });
    expect(screen.getAllByRole("button").some((button) => button.hasAttribute("aria-current"))).toBe(false);
  });

  it("고른 줄이 없으면 안내 글 — 줄 단추를 누르면 검사 칸(영역 이름·제목 h3·내용)과 표의 고른 행(aria-current), 단추는 aria-controls", () => {
    stubWide();
    renderFrame();
    const empty = screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" });
    expect(within(empty).getByText("줄을 고르면 이 칸에 자세한 값이 나옵니다.")).toBeTruthy();
    const target = trigger("달러 인덱스");
    expect(target.getAttribute("aria-controls")).toBe(empty.id);
    expect(target.getAttribute("aria-haspopup")).toBeNull();
    expect(target.getAttribute("data-inspect-key")).toBe("dxy");

    fireEvent.click(target);
    const region = screen.getByRole("region", { name: "지표 미리보기 — 달러 인덱스" });
    expect(within(region).getByRole("heading", { level: 3, name: "달러 인덱스" })).toBeTruthy();
    expect(within(region).getByText("104.20")).toBeTruthy();
    expect(rowOf("달러 인덱스").getAttribute("aria-current")).toBe("true");
    expect(rowOf("VIX").getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("배치 md는 틀 폭 32rem부터 옆 15rem, lg는 52rem부터 옆 18rem — 크기 질의 클래스, 검사 칸은 스크롤 영역 위쪽에 붙음(sticky)", () => {
    stubWide();
    const { container, unmount } = renderFrame();
    const grid = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(tokens(container.firstElementChild as HTMLElement)).toEqual(expect.arrayContaining(["@container", "min-w-0"]));
    expect(tokens(grid)).toContain("@lg:grid-cols-[minmax(0,1fr)_15rem]");
    expect(tokens((inspectorRegion() as HTMLElement))).toEqual(
      expect.arrayContaining(["self-start", "border", "border-border", "p-3", "@lg:sticky", "@lg:top-[calc(var(--section-strip-h,0px)+1rem)]"]),
    );
    unmount();
    const wide = renderFrame({ layout: "lg" });
    const lgGrid = (wide.container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(tokens(lgGrid)).toContain("@min-[52rem]:grid-cols-[minmax(0,1fr)_18rem]");
    expect(tokens((inspectorRegion() as HTMLElement))).toEqual(expect.arrayContaining(["@min-[52rem]:sticky", "@min-[52rem]:top-[calc(var(--section-strip-h,0px)+1rem)]"]));
  });

  it("defaultKey — 아무것도 고르지 않았으면 그 키를 보이고 콜백은 부르지 않는다, 사용자가 고르면 그 줄·콜백", () => {
    stubWide();
    const onChange = vi.fn();
    renderFrame({ defaultKey: "us10y", onSelectedKeyChange: onChange });
    expect(screen.getByRole("region", { name: "지표 미리보기 — 미국채 10년물" })).toBeTruthy();
    expect(rowOf("미국채 10년물").getAttribute("aria-current")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(trigger("VIX"));
    expect(onChange).toHaveBeenCalledWith("vix");
    expect(screen.getByRole("region", { name: "지표 미리보기 — VIX" })).toBeTruthy();
  });

  it("Esc는 사용자가 고른 것이 있을 때만 풀고(안내 글·기본 동작 막음) — 기본 키만 보일 때는 그대로, 푼 뒤 기본 키는 다시 저절로 보이지 않는다", () => {
    stubWide();
    const onChange = vi.fn();
    renderFrame({ defaultKey: "us10y", onSelectedKeyChange: onChange });
    const untouched = fireEvent.keyDown(trigger("VIX"), { key: "Escape" });
    expect(untouched).toBe(true);
    expect(screen.getByRole("region", { name: "지표 미리보기 — 미국채 10년물" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger("VIX"));
    const handled = fireEvent.keyDown(trigger("VIX"), { key: "Escape" });
    expect(handled).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" })).toBeTruthy();
    expect(rowOf("미국채 10년물").getAttribute("aria-current")).toBeNull();
  });

  it("selectedKey를 주면 부르는 쪽이 쥔다 — 바꾸면 그 줄, 자료에서 사라진 키면 행 표시 없이 그 사실을 적는다", () => {
    stubWide();
    const { rerender } = render(<></>);
    const frame = (selectedKey: string | null, rows = ROWS) => (
      <InspectorFrame
        label="지표 미리보기"
        selectedKey={selectedKey}
        titleOf={(key) => rows.find((row) => row.key === key)?.name ?? null}
        renderDetail={(key) => <p>{key} 자세히</p>}
      >
        {(inspector) => (
          <DataTable<Indicator>
            rows={rows}
            rowKey={(row) => row.key}
            selectedKey={inspector.shownKey}
            columns={[{ key: "name", header: "지표", cell: (row) => <InspectorTrigger inspector={inspector} itemKey={row.key}>{row.name}</InspectorTrigger> }]}
          />
        )}
      </InspectorFrame>
    );
    rerender(frame("dxy"));
    expect(screen.getByText("dxy 자세히")).toBeTruthy();
    rerender(frame("vix"));
    expect(screen.getByRole("region", { name: "지표 미리보기 — VIX" })).toBeTruthy();
    rerender(frame("vix", ROWS.filter((row) => row.key !== "vix")));
    expect(screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" }).textContent).toBe("고른 줄이 지금 자료에 없습니다. 다른 줄을 고르세요.");
    expect(screen.getAllByRole("row").some((row) => row.hasAttribute("aria-current"))).toBe(false);
  });

  it("headingLevel로 검사 칸 제목 단계를 바꾸고, inspectorHint로 안내 글을 바꾼다", () => {
    stubWide();
    renderFrame({ headingLevel: 4, inspectorHint: "지표 이름을 누르면 미리보기가 나옵니다." });
    expect(screen.getByText("지표 이름을 누르면 미리보기가 나옵니다.")).toBeTruthy();
    fireEvent.click(trigger("VIX"));
    expect(screen.getByRole("heading", { level: 4, name: "VIX" })).toBeTruthy();
  });
});

describe("InspectorFrame — 대화상자", () => {
  it("좁은 화면 — 줄 단추는 aria-haspopup=dialog·aria-expanded, 누르면 제목 이름의 대화상자, 닫으면 연 단추로 포커스가 돌아간다", async () => {
    renderFrame({ defaultKey: "us10y" });
    expect(inspectorRegion()).toBeNull();
    // 기본 키는 대화상자를 저절로 열지 않고 행 표시도 없다
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("row").some((row) => row.hasAttribute("aria-current"))).toBe(false);
    const target = trigger("달러 인덱스");
    expect(target.getAttribute("aria-haspopup")).toBe("dialog");
    expect(target.getAttribute("aria-expanded")).toBe("false");
    expect(target.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(target);
    const dialog = screen.getByRole("dialog", { name: "달러 인덱스" });
    expect(within(dialog).getByText("104.20")).toBeTruthy();
    expect(target.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger("달러 인덱스")));
    expect(trigger("달러 인덱스").getAttribute("aria-expanded")).toBe("false");
  });

  it("layout='dialog'면 넓은 화면·넓은 틀에서도 늘 대화상자", () => {
    stubWide();
    stubFrameWidth(1200);
    renderFrame({ layout: "dialog" });
    expect(inspectorRegion()).toBeNull();
    fireEvent.click(trigger("VIX"));
    expect(screen.getByRole("dialog", { name: "VIX" })).toBeTruthy();
  });

  it("넓은 화면이라도 틀 폭이 기준 미만이면 대화상자 — md는 32rem(512px), lg는 52rem(832px)", () => {
    stubWide();
    stubFrameWidth(700);
    const md = renderFrame();
    expect((inspectorRegion() as HTMLElement)).toBeTruthy();
    md.unmount();
    renderFrame({ layout: "lg" });
    expect(inspectorRegion()).toBeNull();
    expect(trigger("VIX").getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("대화상자로 연 키가 자료에서 사라지면 닫히고, 그 줄이 다시 와도 저절로 다시 열리지 않는다", () => {
    const { rerender } = renderFrame();
    fireEvent.click(trigger("VIX"));
    expect(screen.getByRole("dialog", { name: "VIX" })).toBeTruthy();
    const frame = (rows: Indicator[]) => (
      <InspectorFrame label="지표 미리보기" titleOf={(key) => rows.find((row) => row.key === key)?.name ?? null} renderDetail={(key) => <p>{key} 자세히</p>}>
        {(inspector) => (
          <ul>
            {rows.map((row) => (
              <li key={row.key}>
                <InspectorTrigger inspector={inspector} itemKey={row.key}>
                  {row.name}
                </InspectorTrigger>
              </li>
            ))}
          </ul>
        )}
      </InspectorFrame>
    );
    rerender(frame(ROWS.filter((row) => row.key !== "vix")));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(frame(ROWS));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger("VIX").getAttribute("aria-expanded")).toBe("false");
  });

  it("inspect(key)로도 연다 — 옆 칸이면 고르고, 대화상자 배치면 대화상자", () => {
    let open: ((key: string) => void) | null = null;
    render(
      <InspectorFrame label="지표 미리보기" titleOf={(key) => ROWS.find((row) => row.key === key)?.name ?? null} renderDetail={(key) => <p>{key} 자세히</p>}>
        {(inspector) => {
          open = inspector.inspect;
          return <p>표</p>;
        }}
      </InspectorFrame>,
    );
    act(() => open?.("vix"));
    expect(screen.getByRole("dialog", { name: "VIX" })).toBeTruthy();
  });
});

describe("InspectorFrame — 배치가 바뀔 때", () => {
  it("대화상자 배치 → 옆 칸 배치: 열려 있던 대화상자의 키를 고르고 닫는다(콜백 한 번) — 다시 좁아지면 대화상자를 저절로 열지 않는다", () => {
    stubWide();
    const frame = stubFrameWidth(700);
    const onChange = vi.fn();
    renderFrame({ layout: "lg", onSelectedKeyChange: onChange });
    fireEvent.click(trigger("VIX"));
    expect(screen.getByRole("dialog", { name: "VIX" })).toBeTruthy();
    frame.resize(900);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "지표 미리보기 — VIX" })).toBeTruthy();
    expect(rowOf("VIX").getAttribute("aria-current")).toBe("true");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("vix");
    frame.resize(700);
    expect(inspectorRegion()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("VIX").getAttribute("aria-current")).toBeNull();
    // 고른 키는 남아 다시 넓어지면 보인다
    frame.resize(900);
    expect(screen.getByRole("region", { name: "지표 미리보기 — VIX" })).toBeTruthy();
  });

  it("폭을 모르면(0 — 숨긴 탭 안·배치 없는 대역) 크기 질의 배치에 맡겨 옆 칸 동작 그대로", () => {
    stubWide();
    stubFrameWidth(0);
    renderFrame({ layout: "lg" });
    expect((inspectorRegion() as HTMLElement)).toBeTruthy();
    expect(trigger("VIX").getAttribute("aria-haspopup")).toBeNull();
  });

  // QA-660: 대화상자 배치에서 옆 칸 배치로 바뀔 때 열려 있는 대화상자의 키만 넘겼습니다 — Esc로 닫은 뒤(포커스는 그 줄 단추) 넓히면 앞서 고른 키나 defaultKey가
  // 남아 포커스 링(대화상자로 본 줄)과 고른 행·검사 칸이 갈라졌습니다(P5a QA — /macro 1024 메뉴 220 '브렌트유' 대화상자 → Esc → 1440: 검사 칸은 첫 지표).
  // 목록-검사(MasterDetail)의 QA-590 규칙과 같게, 열린 대화상자가 없으면 포커스가 있는 줄 단추의 키를 고릅니다. 수정 전(재현 커밋에서는 it.fails)에는
  // 검사 칸 제목이 기본 키 'a'였고 콜백이 불리지 않았습니다.
  it("좁은 틀에서 대화상자로 본 줄을 Esc로 닫고(포커스는 그 단추) 넓히면 그 줄을 고른다 — 기본 키가 아니라 'c', 콜백 한 번 (QA-660)", async () => {
    stubWide();
    const frame = stubFrameWidth(434);
    const onChange = vi.fn();
    renderFrame({ rows: ABC, layout: "lg", defaultKey: "a", onSelectedKeyChange: onChange });
    fireEvent.click(trigger("c"));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "c" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger("c")));
    frame.resize(906);
    const region = screen.getByRole("region", { name: "지표 미리보기 — c" });
    expect(within(region).getByRole("heading", { level: 3, name: "c" })).toBeTruthy();
    expect(trigger("c").getAttribute("aria-current")).toBe("true");
    expect(trigger("a").getAttribute("aria-current")).toBeNull();
    expect(onChange.mock.calls).toEqual([["c"]]);
  });

  it("대화상자를 닫은 뒤 포커스를 틀 밖으로 옮기고 넓히면 기본 키 그대로 — 콜백 없음 (QA-660)", async () => {
    stubWide();
    const frame = stubFrameWidth(434);
    const onChange = vi.fn();
    const outside = document.createElement("button");
    outside.textContent = "틀 밖";
    document.body.appendChild(outside);
    try {
      renderFrame({ rows: ABC, layout: "lg", defaultKey: "a", onSelectedKeyChange: onChange });
      fireEvent.click(trigger("c"));
      fireEvent.keyDown(screen.getByRole("dialog", { name: "c" }), { key: "Escape" });
      await waitFor(() => expect(document.activeElement).toBe(trigger("c")));
      outside.focus();
      frame.resize(906);
      expect(screen.getByRole("region", { name: "지표 미리보기 — a" })).toBeTruthy();
      expect(trigger("a").getAttribute("aria-current")).toBe("true");
      expect(trigger("c").getAttribute("aria-current")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("옆 칸에서 고른 뒤 Esc로 풀고 줄을 건드리지 않은 채 좁혔다 넓히면 '고른 줄 없음' 그대로 — 다시 고르지 않는다 (QA-660)", () => {
    stubWide();
    const frame = stubFrameWidth(906);
    const onChange = vi.fn();
    renderFrame({ rows: ABC, layout: "lg", defaultKey: "a", onSelectedKeyChange: onChange });
    fireEvent.click(trigger("c"));
    fireEvent.keyDown(trigger("c"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger("c"));
    expect(screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" })).toBeTruthy();
    frame.resize(434);
    frame.resize(906);
    expect(screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" })).toBeTruthy();
    expect(ABC.map((row) => trigger(row.name).getAttribute("aria-current"))).toEqual([null, null, null]);
    expect(onChange.mock.calls).toEqual([["c"], [null]]);
  });

  // QA-660 후속: 위 고침이 목록-검사의 조건('직전에 보이던 키가 있으면 포커스 줄을 따라감')을 그대로 옮겨, 옆 칸에서 Tab으로 줄 단추에 포커스만 둔 채(누르지
  // 않음) 폭만 왕복해도(창 1440 → 1024 → 1440·'[' 두 번) 그 줄이 골라지고 콜백이 불렸습니다(고침 검토 — 자기 빌드 /macro 1024 레일, 미리보기 '달러 인덱스
  // (DXY)'(기본 키)에서 '미국채 10년물 수익률(%)'에 포커스만 → '[' 두 번: 검사 칸이 미국채 10년물로, 08e3d838은 DXY 그대로). 이 틀의 옆 칸에서는 Tab이
  // 고르지 않으므로 포커스 줄과 보이는 줄이 다른 것이 정상입니다. 수정 전(재현 커밋에서는 it.fails)에는 검사 칸이 'c'였고 콜백 [['c']]이 불렸습니다.
  it.fails("옆 칸에서 Tab으로 줄 단추에 포커스만 두고(누르지 않음) 좁혔다 넓히면 보이던 키(기본 키·앞서 고른 키) 그대로 — 콜백 없음 (QA-660 후속)", () => {
    stubWide();
    const frame = stubFrameWidth(906);
    const onChange = vi.fn();
    renderFrame({ rows: ABC, layout: "lg", defaultKey: "a", onSelectedKeyChange: onChange });
    // 기본 키 'a'가 보이는 옆 칸 — 'c' 단추에 포커스만.
    act(() => trigger("c").focus());
    frame.resize(434);
    frame.resize(906);
    expect(screen.getByRole("region", { name: "지표 미리보기 — a" })).toBeTruthy();
    expect(ABC.map((row) => trigger(row.name).getAttribute("aria-current"))).toEqual(["true", null, null]);
    expect(onChange).not.toHaveBeenCalled();
    // 'b'를 누른 뒤 'c'에 포커스만 두고 좁혔다 넓혀도 'b' 그대로.
    fireEvent.click(trigger("b"));
    act(() => trigger("c").focus());
    frame.resize(434);
    frame.resize(906);
    expect(screen.getByRole("region", { name: "지표 미리보기 — b" })).toBeTruthy();
    expect(ABC.map((row) => trigger(row.name).getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(onChange.mock.calls).toEqual([["b"]]);
  });
});

describe("InspectorFrame — 자리표시·누름 자리·강조색", () => {
  it("renderDetail이 읽는 중(Skeleton role=status)·오류(ErrorState·다시 시도)를 돌려주면 검사 칸에 그대로", () => {
    stubWide();
    const retry = vi.fn();
    render(
      <InspectorFrame
        label="지표 미리보기"
        defaultKey="us10y"
        titleOf={(key) => ROWS.find((row) => row.key === key)?.name ?? null}
        renderDetail={(key) =>
          key === "us10y" ? <Skeleton lines={2} label="미리보기 불러오는 중" /> : <ErrorState message="요청 실패 (HTTP 503)" onRetry={retry} />
        }
      >
        {(inspector) => (
          <ul>
            {ROWS.map((row) => (
              <li key={row.key}>
                <InspectorTrigger inspector={inspector} itemKey={row.key}>
                  {row.name}
                </InspectorTrigger>
              </li>
            ))}
          </ul>
        )}
      </InspectorFrame>,
    );
    const region = screen.getByRole("region", { name: "지표 미리보기 — 미국채 10년물" });
    expect(within(region).getByRole("status", { name: "미리보기 불러오는 중" })).toBeTruthy();
    fireEvent.click(trigger("VIX"));
    const errored = screen.getByRole("region", { name: "지표 미리보기 — VIX" });
    expect(within(errored).getByText("요청 실패 (HTTP 503)")).toBeTruthy();
    fireEvent.click(within(errored).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("줄 단추는 좁은 화면 높이·폭 44px·넓은 화면 높이·폭 24px(짧은 이름도 — 결정 8)·중립 잉크(본문색·밑줄은 마우스를 올릴 때)·포커스 링, 낱말 사이에서 꺾음 — 누름 자리 감사 통과", () => {
    renderFrame();
    const classes = tokens(trigger("미국채 10년물"));
    expect(classes).toEqual(
      expect.arrayContaining(["min-h-11", "lg:min-h-6", "min-w-11", "lg:min-w-6", "text-left", "text-text", "break-keep", "hover:underline", "focus-visible:outline-focus"]),
    );
    // 같은 변형의 높이·폭 하한이 둘이면(예: lg:min-h-0과 lg:min-h-6) 이기는 쪽이 CSS 차례에 걸립니다 — 하나씩만.
    expect(classes.filter((token) => token.startsWith("lg:min-h-"))).toEqual(["lg:min-h-6"]);
    expect(classes.filter((token) => token.startsWith("lg:min-w-"))).toEqual(["lg:min-w-6"]);
    expect(trigger("미국채 10년물").getAttribute("type")).toBe("button");
    expect(smallTargets(screen.getByRole("table"))).toEqual([]);
  });

  it("틀·검사 칸·줄 단추에 강조 파랑 클래스가 없다(데이터 영역)", () => {
    stubWide();
    const { container } = renderFrame({ defaultKey: "dxy" });
    const accent = [...container.querySelectorAll("[class]")].flatMap((element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter((token) => token.includes("accent")),
    );
    expect(accent).toEqual([]);
  });
});

// QA-642: 옆 검사 칸 배치에서 검사 칸 안(예: 매크로 미리보기의 '지표 상세 열기' 링크)에 포커스를 둔 채 Esc를 누르면 고름이 풀리며 그 링크가
// DOM에서 사라져 포커스가 body로 떨어졌습니다 — Esc를 받는 틀 상자가 표만이 아니라 검사 칸까지 감싸서(P5a 검토 — 자기 빌드 /macro 1440·1920 CDP).
// 다음 Tab이 고른 줄이 아니라 표의 첫 줄에서 다시 시작해 자리를 잃었습니다. 대화상자를 닫을 때 연 단추로 돌아오는 것과 같게, 고름을 풀면 포커스는
// 그 키의 줄 단추로 돌아와야 합니다.
describe("QA-642 검사 칸 안에서 Esc로 고름을 풀면 포커스가 고른 줄 단추로 돌아온다", () => {
  it("검사 칸 링크에 포커스 → Esc → 고름이 풀리고 포커스는 그 줄 단추", () => {
    stubWide();
    renderFrame({
      renderDetail: (key) => (
        <>
          <p>{key} 자세히</p>
          <a href={`/markets/i/${key}`}>지표 상세 열기</a>
        </>
      ),
    });
    fireEvent.click(trigger("달러 인덱스"));
    const link = within(screen.getByRole("region", { name: "지표 미리보기 — 달러 인덱스" })).getByRole("link", { name: "지표 상세 열기" });
    link.focus();
    expect(document.activeElement).toBe(link);

    const handled = fireEvent.keyDown(link, { key: "Escape" });
    expect(handled).toBe(false);
    expect(screen.getByRole("region", { name: "지표 미리보기 — 고른 줄 없음" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger("달러 인덱스"));
  });
});

// QA-657: 옆 검사 칸은 스크롤 영역 위쪽 16px(top-4)에 붙었는데, 같은 스크롤 상자 맨 위에 긴 화면 목차의 가로 줄(SectionIndex — 31px, z-20, 불투명)이
// 붙는 폭(/macro 1024 레일·1280~1535)에서는 검사 칸 위 15px(위 테두리·안쪽 여백)이 줄 밑에 가려졌습니다(P5a QA — 검사 칸 위 끝 64px, 줄 48~79px).
// 이제 검사 칸은 목차가 문서 루트에 적는 잰 줄 높이(--section-strip-h, 없으면 0) 아래 16px에 붙습니다. 수정 전(재현 커밋에서는 it.fails)에는 top-4였습니다.
// jsdom은 크기 질의·sticky를 계산하지 않아 클래스로 봅니다(브라우저 값은 진행 기록).
describe("QA-657 옆 검사 칸은 목차 가로 줄 아래 16px에 붙는다", () => {
  it("md·lg 배치 모두 sticky top이 calc(var(--section-strip-h,0px)+1rem) — top-4가 아니다", () => {
    stubWide();
    const md = renderFrame();
    const mdTokens = tokens(inspectorRegion() as HTMLElement);
    expect(mdTokens).toEqual(expect.arrayContaining(["@lg:sticky", "@lg:top-[calc(var(--section-strip-h,0px)+1rem)]"]));
    expect(mdTokens).not.toContain("@lg:top-4");
    md.unmount();
    renderFrame({ layout: "lg" });
    const lgTokens = tokens(inspectorRegion() as HTMLElement);
    expect(lgTokens).toEqual(expect.arrayContaining(["@min-[52rem]:sticky", "@min-[52rem]:top-[calc(var(--section-strip-h,0px)+1rem)]"]));
    expect(lgTokens).not.toContain("@min-[52rem]:top-4");
  });
});
