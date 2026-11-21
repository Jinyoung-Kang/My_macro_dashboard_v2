/**
 * QA-939(작업대 결정 거리 datatable-scroll-region-tabstop-without-overflow — P8): 공용 스크롤 상자(DataTable·LogPanel·HeatmapTable)가 넘치지 않아도
 * Tab 정지점(tabIndex 0)이고 이름 있는 영역 '… (좌우 스크롤)'·'… (스크롤)'입니다. 홈 두 표처럼 상자에 다 들어가는 표에서 Tab이 하나 늘고 낭독기가 스크롤할 것이
 * 없는 상자를 '좌우 스크롤'이라고 읽었습니다(결정 5 뒤 홈 두 표에서 드러남, D6 전 QA의 원문 본문 상자·LogPanel도 같은 꼴).
 *
 * 기대(공용 계약): 상자 크기를 재어(ResizeObserver) 넘칠 때만 Tab 정지점·이름 있는 영역이고, 넘치지 않으면 정지점·영역·이름이 없습니다(스크립트 포커스
 * 자리로만 tabIndex -1 — 부르는 쪽의 포커스 되돌림이 닿게). 아직 재지 못했거나 잴 수 없는 환경이면 지금처럼 정지점을 둡니다(키보드로 못 닿는 상자를 만들지 않음).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): '넘치지 않으면' 사례 셋 모두 영역이 남음 —
 * 'expected <div …(좌우 스크롤)…> to be null'.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "../DataTable";
import { HeatmapTable } from "../HeatmapTable";
import { LogPanel } from "../LogPanel";

type Size = { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };

/** 잰 크기 — 스크롤 상자(표를 바로 감싼 상자·pre)에만 주고, 나머지 요소는 0입니다. */
let boxSize: Size = { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 };
const observers: { callback: () => void }[] = [];

function isScrollBox(element: HTMLElement): boolean {
  return element.tagName === "PRE" || element.querySelector(":scope > table") !== null;
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly callback: () => void) {
        observers.push(this);
      }
      observe() {
        this.callback();
      }
      unobserve() {}
      disconnect() {}
    },
  );
  for (const key of ["scrollWidth", "clientWidth", "scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return isScrollBox(this) ? boxSize[key] : 0;
      },
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const key of ["scrollWidth", "clientWidth", "scrollHeight", "clientHeight"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

const FITS: Size = { scrollWidth: 600, clientWidth: 600, scrollHeight: 200, clientHeight: 200 };
const WIDE: Size = { scrollWidth: 1_200, clientWidth: 600, scrollHeight: 200, clientHeight: 200 };
const TALL: Size = { scrollWidth: 600, clientWidth: 600, scrollHeight: 900, clientHeight: 480 };

type Row = { name: string; value: string };
const ROWS: Row[] = [
  { name: "가상 하나", value: "1" },
  { name: "가상 둘", value: "2" },
];

function renderTable() {
  return render(
    <DataTable<Row>
      caption="합성 표"
      columns={[
        { key: "name", header: "이름", cell: (row) => row.name },
        { key: "value", header: "값", align: "right", cell: (row) => row.value },
      ]}
      rows={ROWS}
      rowKey={(row) => row.name}
    />,
  );
}

function renderHeatmap() {
  return render(
    <HeatmapTable
      caption="합성 행렬"
      rowHeader="이름"
      columns={[{ key: "a", label: "가" }]}
      rows={[{ key: "r", label: "가상 행", values: [3] }]}
      max={10}
      format={(value) => value.toFixed(1)}
      zeroText={{ text: "·", sr: "합성 영" }}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
    />,
  );
}

const tableBox = (container: HTMLElement) => container.querySelector("table")?.parentElement as HTMLElement;

describe("QA-939 스크롤 상자 — 넘칠 때만 Tab 정지점·이름 있는 영역", () => {
  it("DataTable: 넘치지 않으면 정지점·영역·이름이 없다(스크립트 포커스 자리 -1)", () => {
    boxSize = FITS;
    const { container } = renderTable();
    expect(screen.queryByRole("region", { name: "합성 표 (좌우 스크롤)" })).toBeNull();
    const box = tableBox(container);
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(box.hasAttribute("role")).toBe(false);
    expect(box.hasAttribute("aria-label")).toBe(false);
    // 부르는 쪽의 포커스 되돌림 자리(알림 규칙 표를 지운 뒤 — data-scroll-box로 찾음)로는 그대로 닿습니다.
    expect(box.hasAttribute("data-scroll-box")).toBe(true);
    act(() => box.focus());
    expect(document.activeElement).toBe(box);
    // 표 이름은 caption이 그대로 읽힙니다.
    expect(screen.getByRole("table", { name: "합성 표" })).toBeTruthy();
  });

  it("DataTable: 좌우로 넘치면 Tab 정지점·'{표 이름} (좌우 스크롤)'", () => {
    boxSize = WIDE;
    renderTable();
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).getAttribute("tabindex")).toBe("0");
  });

  it("DataTable: 폭이 바뀌어 넘치게 되면 정지점이 생기고, 다시 들어가면 없어진다", () => {
    boxSize = FITS;
    renderTable();
    boxSize = WIDE;
    act(() => observers.forEach((observer) => observer.callback()));
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).getAttribute("tabindex")).toBe("0");
    boxSize = FITS;
    act(() => observers.forEach((observer) => observer.callback()));
    expect(screen.queryByRole("region", { name: "합성 표 (좌우 스크롤)" })).toBeNull();
  });

  it("LogPanel: 위아래로 넘치지 않으면 정지점·영역이 없고, 넘치면 '{label} (스크롤)'", () => {
    boxSize = FITS;
    const { container } = render(<LogPanel label="합성 로그" text={"한 줄\n두 줄"} />);
    expect(screen.queryByRole("region", { name: "합성 로그 (스크롤)" })).toBeNull();
    expect(container.querySelector("pre")?.getAttribute("tabindex")).toBe("-1");
    cleanup();
    boxSize = TALL;
    render(<LogPanel label="합성 로그" text={"한 줄\n두 줄"} />);
    expect(screen.getByRole("region", { name: "합성 로그 (스크롤)" }).getAttribute("tabindex")).toBe("0");
  });

  it("HeatmapTable: 넘치지 않으면 정지점·영역이 없고, 넘치면 '{표 이름} (좌우 스크롤)'", () => {
    boxSize = FITS;
    renderHeatmap();
    expect(screen.queryByRole("region", { name: "합성 행렬 (좌우 스크롤)" })).toBeNull();
    cleanup();
    boxSize = WIDE;
    renderHeatmap();
    expect(screen.getByRole("region", { name: "합성 행렬 (좌우 스크롤)" }).getAttribute("tabindex")).toBe("0");
  });

  it("잴 수 없으면(ResizeObserver가 알려 주지 않음) 지금처럼 정지점을 둔다 — 키보드로 못 닿는 상자를 만들지 않음", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    boxSize = FITS;
    renderTable();
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).getAttribute("tabindex")).toBe("0");
    cleanup();
    render(<LogPanel label="합성 로그" text="한 줄" />);
    expect(screen.getByRole("region", { name: "합성 로그 (스크롤)" }).getAttribute("tabindex")).toBe("0");
  });

  it("포커스가 있는 동안에는 넘침이 풀려도 정지점을 떼지 않고, 포커스가 떠나면 뗀다", () => {
    boxSize = WIDE;
    const { container } = renderTable();
    const box = tableBox(container);
    act(() => box.focus());
    boxSize = FITS;
    act(() => observers.forEach((observer) => observer.callback()));
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("tabindex")).toBe("0");
    act(() => box.blur());
    expect(box.getAttribute("tabindex")).toBe("-1");
  });
});
