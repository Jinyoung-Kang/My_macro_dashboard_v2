/**
 * QA-907(작업대 P8 통합 검토 지적): 공용 DataTable에 세로 한도(maxHeight)가 있으면 넘침을 두 방향(axis "both")으로 재서 세로로만 넘쳐도 Tab 정지점·이름 있는
 * 영역이 되는데, 그 이름이 늘 '{caption} (좌우 스크롤)'이었습니다 — 좌우로는 넘길 것이 없는 상자를 낭독기가 '좌우 스크롤'이라고 읽었습니다(쓰는 곳: ISA
 * 표·실제 매매 표·한국 종목 선정 — 고치는 것은 공용 DataTable뿐).
 *
 * 기대: 잰 넘침 방향에 맞춘 이름 — 세로로 넘치면(가로도 함께 넘쳐도) '{caption} (스크롤)', 가로로만 넘치면 '(좌우 스크롤)'. 재기 전·잴 수 없으면 지금 이름
 * 그대로('(좌우 스크롤)' — jsdom 시험·서버 그리기가 같게), 세로 한도가 없는 표도 그대로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 세로 넘침 사례 둘 — 'Unable to find an accessible element with the role "region" and name
 * "합성 표 (스크롤)"'.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "../DataTable";

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

const WIDE: Size = { scrollWidth: 1_200, clientWidth: 600, scrollHeight: 200, clientHeight: 200 };
const TALL: Size = { scrollWidth: 600, clientWidth: 600, scrollHeight: 900, clientHeight: 480 };
const BOTH: Size = { scrollWidth: 1_200, clientWidth: 600, scrollHeight: 900, clientHeight: 480 };

type Row = { name: string; value: string };
const ROWS: Row[] = [
  { name: "가상 하나", value: "1" },
  { name: "가상 둘", value: "2" },
];

function renderTable(maxHeight?: number) {
  return render(
    <DataTable<Row>
      caption="합성 표"
      maxHeight={maxHeight}
      columns={[
        { key: "name", header: "이름", cell: (row) => row.name },
        { key: "value", header: "값", align: "right", cell: (row) => row.value },
      ]}
      rows={ROWS}
      rowKey={(row) => row.name}
    />,
  );
}

describe("DataTable 스크롤 영역 이름 — 넘침 방향(QA-907)", () => {
  it("세로 한도가 있고 세로로만 넘치면 '(스크롤)'", () => {
    boxSize = TALL;
    renderTable(480);
    const region = screen.getByRole("region", { name: "합성 표 (스크롤)" });
    expect(region.tabIndex).toBe(0);
  });

  it("세로 한도가 있고 두 방향 모두 넘치면 '(스크롤)'", () => {
    boxSize = BOTH;
    renderTable(480);
    expect(screen.getByRole("region", { name: "합성 표 (스크롤)" }).tabIndex).toBe(0);
  });

  it("세로 한도가 있고 가로로만 넘치면 '(좌우 스크롤)' 그대로", () => {
    boxSize = WIDE;
    renderTable(480);
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).tabIndex).toBe(0);
  });

  it("세로 한도가 없는 표는 '(좌우 스크롤)' 그대로", () => {
    boxSize = WIDE;
    renderTable();
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).tabIndex).toBe(0);
  });

  it("재기 전·잴 수 없으면(ResizeObserver 없음) 세로 한도가 있어도 지금 이름 '(좌우 스크롤)' 그대로", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    boxSize = TALL;
    renderTable(480);
    expect(screen.getByRole("region", { name: "합성 표 (좌우 스크롤)" }).tabIndex).toBe(0);
  });
});
