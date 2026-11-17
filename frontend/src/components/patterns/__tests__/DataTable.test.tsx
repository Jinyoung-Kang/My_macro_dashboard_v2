/**
 * DataTable — 밀도 높은 표(설계서 §5 "열 정렬·고정 머리, 행 클릭 → 상세", §6 네 상태).
 * 네 상태: 값 있음(숫자 열 오른쪽·tabular-nums), 값 없음(칸 "—"·행 없음 문구), 추정·대리(칸 배지), 오래됨(칸에 경고 아이콘과 '이전 값').
 * 정렬: 머리 단추 + 정렬한 열의 th에만 aria-sort, 모르는 값은 방향과 무관하게 맨 뒤. 행 클릭: Tab으로 닿고 Enter·Space로 열림.
 * 틀: 가로 스크롤 상자·sticky 머리·maxHeight, scrollHint(최소 640px + 폰 안내 줄, "overflow"면 넘칠 때 늘 안내), 행 머리(rowHeader → th scope=row).
 * 밀도(작업대 실행 명세 §3-7): 넓은 화면 행 32px·조밀 28px, 좁은 화면의 행은 모두 44px, 정렬 머리 단추 lg 미만 44px, 행 구분선 border-subtle, 개수 줄(count).
 * 고른 행(selectedKey, 명세 §3-8): 첫 칸 왼쪽 3px 막대(SELECTED_BAR — 장식)·중립 바탕·aria-current, 기본은 없음.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SELECTED_BAR } from "@/components/ui/classes";

import { EstimateBadge, StaleBadge } from "../badges";
import { type Column, DataTable } from "../DataTable";

afterEach(() => cleanup());

type Holding = {
  ticker: string;
  name: string;
  weight: number | null;
  change: string | null;
  isProxy?: boolean;
  isStale?: boolean;
};

const ROWS: Holding[] = [
  { ticker: "NVDA", name: "엔비디아", weight: 12.5, change: "+1.20%" },
  { ticker: "MSFT", name: "마이크로소프트", weight: null, change: "N/A" },
  { ticker: "AAPL", name: "애플", weight: 30.25, change: "−0.40%", isProxy: true },
  { ticker: "BRK", name: "버크셔", weight: 0, change: null, isStale: true },
];

const COLUMNS: Column<Holding>[] = [
  { key: "ticker", header: "종목", cell: (row) => row.ticker, sortValue: (row) => row.ticker },
  {
    key: "name",
    header: "이름",
    cell: (row) => (
      <span className="inline-flex gap-1">
        {row.name}
        <EstimateBadge proxy={row.isProxy} note={row.isProxy ? "ETF 대리" : null} />
        <StaleBadge stale={row.isStale} reason={row.isStale ? "13F 직전 분기" : null} />
      </span>
    ),
  },
  {
    key: "weight",
    header: "비중",
    align: "right",
    cell: (row) => (row.weight === null ? null : `${row.weight.toFixed(2)}%`),
    sortValue: (row) => row.weight,
  },
  { key: "change", header: "변화", align: "right", cell: (row) => row.change },
];

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const firstCells = () => bodyRows().map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("DataTable — 네 상태", () => {
  it("값 있음 — caption(sr-only), 열 머리, 숫자 열은 오른쪽 정렬·tabular-nums, 글 열은 왼쪽", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} caption="13F 상위 보유" />);
    const table = screen.getByRole("table", { name: "13F 상위 보유" });
    expect(table.querySelector("caption")?.className).toContain("sr-only");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent?.replace(/[↑↓↕]/g, ""))).toEqual([
      "종목",
      "이름",
      "비중",
      "변화",
    ]);
    const nvda = bodyRows()[0];
    const cells = within(nvda).getAllByRole("cell");
    expect(cells[2].textContent).toBe("12.50%");
    expect(cells[2].className).toContain("text-right");
    expect(cells[2].className).toContain("tabular-nums");
    expect(cells[0].className).toContain("text-left");
    expect(within(table).getByRole("columnheader", { name: /비중/ }).className).toContain("text-right");
  });

  it("값 0은 값이다 — '—'가 아니다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    expect(within(bodyRows()[3]).getAllByRole("cell")[2].textContent).toBe("0.00%");
  });

  it("값 없음 — null·'N/A' 칸은 '—'(읽어 주기는 '값 없음', 보조 글자색), 0으로 채우지 않는다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const msft = within(bodyRows()[1]).getAllByRole("cell");
    for (const cell of [msft[2], msft[3]]) {
      const dash = within(cell).getByText("—");
      expect(dash.getAttribute("aria-hidden")).toBe("true");
      // 타일·히어로·자산 행과 같이 '—'는 text-3 — 값이 있는 칸(text-text)과 눈으로 구분된다.
      expect(dash.closest(".text-text-3")).not.toBeNull();
      expect(within(cell).getByText("값 없음").className).toContain("sr-only");
      expect(cell.textContent).not.toContain("0.00");
    }
    // 부호·자릿수가 있는 글은 그대로.
    expect(within(bodyRows()[2]).getAllByRole("cell")[3].textContent).toBe("−0.40%");
  });

  it("행이 없으면 머리는 남기고 emptyText 한 줄(열 수만큼 합친 칸)", () => {
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} emptyText="보유 종목이 없습니다." />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    const cell = screen.getByRole("cell", { name: "보유 종목이 없습니다." });
    expect(cell.getAttribute("colspan")).toBe("4");
    cleanup();
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} />);
    expect(screen.getByText("표시할 데이터가 없습니다.")).toBeTruthy();
  });

  // QA-503: 열이 많은 표는 좁은 화면에서 상자보다 넓어지는데(머리 칸 nowrap), 행 없음 문구가 표 전체 폭의 가운데에 놓여 상자 밖으로 밀렸다
  // (390px '최근 실제 주문' — '이 기능이 낸 '까지만 보임). 문구를 상자의 보이는 폭(100cqw)에 붙여 두면 넘겨도 그 자리에 남는다.
  // jsdom에는 배치가 없으므로 구조(클래스)로 단언합니다 — 잰 값은 QA 스택에서 확인.
  it("행이 없으면 emptyText는 감싼 상자의 보이는 폭에 붙는다 — 상자는 크기 질의 기준(@container), 문구는 sticky left-0 w-[100cqw](QA-503)", () => {
    const classesOf = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} caption="최근 주문" emptyText="주문이 없습니다." />);
    const cell = screen.getByRole("cell", { name: "주문이 없습니다." });
    expect(cell.getAttribute("colspan")).toBe("4");
    const text = within(cell).getByText("주문이 없습니다.");
    expect(classesOf(text)).toEqual(expect.arrayContaining(["sticky", "left-0", "w-[100cqw]"]));
    // 100cqw가 감싼 상자의 보이는 폭이 되려면 상자가 크기 질의 기준(container-type: inline-size)이어야 합니다.
    expect(classesOf(screen.getByRole("region", { name: "최근 주문 (좌우 스크롤)" }))).toContain("@container");
    // 여백·글 모양은 칸이 아니라 안쪽 문구가 집니다 — 칸에 여백이 남으면 100cqw 문구가 상자 오른쪽 끝을 넘습니다. 모양(위아래 24px·가운데·보조 글자)은 예전 그대로.
    expect(classesOf(cell)).toEqual(["p-0"]);
    expect(classesOf(text)).toEqual(expect.arrayContaining(["px-3", "py-6", "text-center", "text-sm", "text-text-3"]));
  });

  // 크기 질의 기준(container-type: inline-size)은 상자의 내용 폭을 바깥에 0으로 알립니다 — 내용 폭에 맞춰 줄어드는 부모(자동 basis flex 행 항목·
  // inline-block·w-fit) 안에서는 상자가 옆 글 폭까지 줄어 표가 잘립니다(2026-11-16 검토 지적 — 크롬 하네스에서 표 상자 439px -> 52px).
  // 그래서 기준은 행 없음 문구(100cqw)가 필요한 빈 표에만 붙이고, 행이 있는 표의 상자는 예전처럼 표 폭을 바깥에 알립니다.
  it("크기 질의 기준(@container)은 행이 없을 때만 — 행이 있는 표의 상자는 기준이 아니다", () => {
    const classesOf = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    const region = () => screen.getByRole("region", { name: "보유 (좌우 스크롤)" });
    const { rerender } = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} caption="보유" scrollHint />);
    // 이름 붙은 기준(@container/이름)도 같은 성질이라 함께 막습니다.
    expect(region().className).not.toMatch(/(^|\s)@container(\/\S+)?(\s|$)/);
    // 행이 모두 빠지면 기준이 붙고(문구가 상자 폭에 붙음), 다시 행이 생기면 떨어집니다.
    rerender(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} caption="보유" scrollHint />);
    expect(classesOf(region())).toContain("@container");
    rerender(<DataTable columns={COLUMNS} rows={ROWS.slice(0, 1)} rowKey={(row) => row.ticker} caption="보유" scrollHint />);
    expect(classesOf(region())).not.toContain("@container");
  });

  it("추정·대리 — 칸 안의 배지가 그대로 보인다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const aapl = within(bodyRows()[2]).getAllByRole("cell")[1];
    expect(within(aapl).getByText("대리 지표")).toBeTruthy();
    expect(within(aapl).getByText("· ETF 대리")).toBeTruthy();
    expect(within(within(bodyRows()[0]).getAllByRole("cell")[1]).queryByText("대리 지표")).toBeNull();
  });

  it("오래됨 — 칸 안의 '이전 값' + 사유(경고색)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const brk = within(bodyRows()[3]).getAllByRole("cell")[1];
    const label = within(brk).getByText("이전 값");
    expect((label.parentElement as HTMLElement).className).toContain("text-warn");
    expect(within(brk).getByText("· 13F 직전 분기")).toBeTruthy();
  });
});

describe("DataTable — 틀", () => {
  it("넓은 표는 감싼 상자 안에서만 좌우로(overflow-x-auto, Tab으로 닿음), 머리는 sticky", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} caption="보유" />);
    const region = screen.getByRole("region", { name: "보유 (좌우 스크롤)" });
    expect(region.className).toContain("overflow-x-auto");
    expect(region.className).toContain("max-w-full");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.style.maxHeight).toBe("");
    expect(screen.getByRole("table").querySelector("thead")?.className).toContain("sticky");
  });

  it("maxHeight를 주면 그 높이에서 세로로도 스크롤 — 머리가 위에 남는다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} maxHeight={320} />);
    const region = screen.getByRole("region", { name: "표 (좌우 스크롤)" });
    expect(region.style.maxHeight).toBe("320px");
    expect(region.style.overflowY).toBe("auto");
  });

  it("scrollHint — 표 최소 640px + 폰(sm 미만)에서만 보이는 '좌우로 넘겨 보세요' 한 줄(옛 ui Table과 같음), 행이 없으면 둘 다 없다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} scrollHint />);
    const hint = screen.getByText("← 표를 좌우로 넘겨 보세요");
    expect(hint.className).toContain("sm:hidden");
    // 낭독기에는 상자 이름 "(좌우 스크롤)"이 같은 말을 하므로 숨깁니다.
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("table").className).toContain("min-w-[640px]");

    cleanup();
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} scrollHint />);
    expect(screen.queryByText("← 표를 좌우로 넘겨 보세요")).toBeNull();
    expect(screen.getByRole("table").className).not.toContain("min-w-[640px]");

    cleanup();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    expect(screen.queryByText("← 표를 좌우로 넘겨 보세요")).toBeNull();
    expect(screen.getByRole("table").className).not.toContain("min-w-[640px]");
  });

  it("scrollHint='overflow' — 상자보다 표가 넓으면 폭과 상관없이 안내, 들어가면 폰에서만, 잴 수 없으면 true와 같다", () => {
    let content = 1_200;
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: () => void) {}
      observe() { this.callback(); }
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true,
      get(this: HTMLElement) { return this.getAttribute("role") === "region" ? content : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true,
      get(this: HTMLElement) { return this.getAttribute("role") === "region" ? 958 : 0; } });
    try {
      render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} scrollHint="overflow" />);
      expect(screen.getByText("← 표를 좌우로 넘겨 보세요").className).not.toContain("sm:hidden");
      expect(screen.getByRole("table").className).toContain("min-w-[640px]");
      cleanup();
      content = 958;
      render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} scrollHint="overflow" />);
      expect(screen.getByText("← 표를 좌우로 넘겨 보세요").className).toContain("sm:hidden");
      cleanup();
      content = 1_200;
      render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} scrollHint />);
      expect(screen.getByText("← 표를 좌우로 넘겨 보세요").className).toContain("sm:hidden");
      cleanup();
      render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} scrollHint="overflow" />);
      expect(screen.queryByText("← 표를 좌우로 넘겨 보세요")).toBeNull();
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      vi.unstubAllGlobals();
    }
    // ResizeObserver가 없는 환경(jsdom 기본) — 재지 못하면 폰에서만(true와 같음).
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} scrollHint="overflow" />);
    expect(screen.getByText("← 표를 좌우로 넘겨 보세요").className).toContain("sm:hidden");
  });

  it("글 열의 칸도 tabular-nums — 날짜·시각 열의 자릿수가 맞는다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    for (const cell of within(bodyRows()[0]).getAllByRole("cell")) {
      expect(cell.className).toContain("tabular-nums");
    }
  });

  it("rowHeader 열은 행 머리(th scope=row) — 줄이 항목인 표에서 칸마다 항목 이름을 함께 읽는다, 모르는 값은 그대로 '—'", () => {
    type Metric = { key: string; label: string | null; a: string | null };
    const columns: Column<Metric>[] = [
      { key: "label", header: "항목", rowHeader: true, cell: (row) => row.label },
      { key: "a", header: "규칙 계좌", align: "right", cell: (row) => row.a },
    ];
    const rows: Metric[] = [
      { key: "nav", label: "순자산", a: "100,000 달러" },
      { key: "x", label: null, a: null },
    ];
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.key} caption="계좌 비교" />);
    const headers = screen.getAllByRole("rowheader");
    expect(headers.map((th) => th.textContent)).toEqual(["순자산", "—값 없음"]);
    expect(headers[0].tagName).toBe("TH");
    expect(headers[0].getAttribute("scope")).toBe("row");
    // 보이는 모양은 다른 칸과 같습니다(굵게 그리지 않음).
    expect(headers[0].className).toContain("font-normal");
    // 행 머리는 칸(cell)으로 세지 않습니다 — 값 칸만 남습니다.
    expect(within(bodyRows()[0]).getAllByRole("cell").map((td) => td.textContent)).toEqual(["100,000 달러"]);
    // 열 머리는 그대로 scope=col
    expect(screen.getAllByRole("columnheader").map((th) => th.getAttribute("scope"))).toEqual(["col", "col"]);
  });

  it("정렬 값이 없는 열은 머리가 글자뿐(단추 없음)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const header = screen.getByRole("columnheader", { name: "이름" });
    expect(within(header).queryByRole("button")).toBeNull();
    expect(within(screen.getByRole("columnheader", { name: /비중/ })).getByRole("button", { name: "비중" })).toBeTruthy();
  });
});

describe("DataTable — 정렬", () => {
  it("처음엔 받은 순서, aria-sort 없음", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    expect(firstCells()).toEqual(["NVDA", "MSFT", "AAPL", "BRK"]);
    for (const th of screen.getAllByRole("columnheader")) {
      expect(th.hasAttribute("aria-sort")).toBe(false);
    }
  });

  it("머리 단추 — 오름차순 → 내림차순, 모르는 값(null)은 두 방향 모두 맨 뒤, aria-sort는 그 th에만", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const weightHeader = screen.getByRole("columnheader", { name: /비중/ });
    const button = within(weightHeader).getByRole("button", { name: "비중" });

    fireEvent.click(button);
    expect(firstCells()).toEqual(["BRK", "NVDA", "AAPL", "MSFT"]);
    expect(weightHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /종목/ }).hasAttribute("aria-sort")).toBe(false);

    fireEvent.click(button);
    expect(firstCells()).toEqual(["AAPL", "NVDA", "BRK", "MSFT"]);
    expect(weightHeader.getAttribute("aria-sort")).toBe("descending");
  });

  it("다른 열을 누르면 그 열의 오름차순부터, aria-sort도 옮겨 간다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} initialSort={{ key: "weight", dir: "desc" }} />);
    expect(firstCells()).toEqual(["AAPL", "NVDA", "BRK", "MSFT"]);
    const tickerHeader = screen.getByRole("columnheader", { name: /종목/ });
    fireEvent.click(within(tickerHeader).getByRole("button", { name: "종목" }));
    expect(firstCells()).toEqual(["AAPL", "BRK", "MSFT", "NVDA"]);
    expect(tickerHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /비중/ }).hasAttribute("aria-sort")).toBe(false);
  });

  // QA-504: 정렬 전 '↕'를 opacity-50으로 흐리게 그려 실제 색이 토큰에 없는 #71767d(머리 바탕 surface 위 3.54:1)가 됐다 — 토큰 대비 시험에도
  // 걸리지 않는다. 흐린 단계는 글자 토큰(text-3, 캡션·각주 — surface 위 5.62:1)으로 그린다.
  it("정렬 전 머리의 흐린 표시는 불투명도가 아니라 글자 토큰(text-text-3)으로 그린다 — 정렬한 열은 그대로 머리 글자색(QA-504)", () => {
    const classesOf = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const markOf = (name: RegExp) =>
      within(screen.getByRole("columnheader", { name })).getByRole("button").querySelector('span[aria-hidden="true"]') as HTMLElement;
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    for (const name of [/종목/, /비중/]) {
      const mark = markOf(name);
      expect(mark.textContent).toBe("↕");
      expect(classesOf(mark).filter((cls) => /^opacity-/.test(cls))).toEqual([]);
      expect(classesOf(mark)).toContain("text-text-3");
    }
    // 정렬한 열의 화살표는 따로 색을 주지 않고 단추의 글자색(text-text)을 물려받습니다.
    fireEvent.click(within(screen.getByRole("columnheader", { name: /비중/ })).getByRole("button"));
    expect(markOf(/비중/).textContent).toBe("↑");
    expect(classesOf(markOf(/비중/))).toEqual([]);
    expect(classesOf(markOf(/종목/))).toContain("text-text-3");
  });

  it("정렬할 수 없는 열을 가리키는 initialSort는 무시한다(받은 순서, aria-sort 없음)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} initialSort={{ key: "name", dir: "asc" }} />);
    expect(firstCells()).toEqual(["NVDA", "MSFT", "AAPL", "BRK"]);
    expect(screen.getByRole("columnheader", { name: "이름" }).hasAttribute("aria-sort")).toBe(false);
  });
});

describe("DataTable — 행 클릭 · 키보드", () => {
  it("onRowClick이 없으면 행은 Tab으로 닿지 않고 hover 표시도 없다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const row = bodyRows()[0];
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.className).not.toContain("cursor-pointer");
    expect(row.className).not.toMatch(/hover:bg-/);
    expect(within(row).getAllByRole("cell")[0].className).not.toContain("group-hover:underline");
  });

  it("행을 누르면 그 행으로 부른다 — tabIndex 0, hover는 surface-2 바탕(그 위에서도 상승·하락 글자 4.5:1)과 첫 칸 밑줄", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={onRowClick} />);
    const row = bodyRows()[2];
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).toContain("hover:bg-surface-2");
    const cells = within(row).getAllByRole("cell");
    expect(cells[0].className).toContain("group-hover:underline");
    expect(cells[1].className).not.toContain("group-hover:underline");
    fireEvent.click(within(row).getAllByRole("cell")[0]);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0][0].ticker).toBe("AAPL");
  });

  it("Enter·Space로도 열리고, Space의 기본 동작(스크롤)은 막는다 — 다른 키는 무시", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={onRowClick} />);
    const row = bodyRows()[0];
    row.focus();
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Enter" });
    const spaceAllowed = fireEvent.keyDown(row, { key: " " });
    fireEvent.keyDown(row, { key: "a" });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick.mock.calls.map((call) => call[0].ticker)).toEqual(["NVDA", "NVDA"]);
    expect(spaceAllowed).toBe(false);
  });

  it("정렬한 뒤에도 클릭한 행의 자료가 넘어간다", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={onRowClick} />);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /비중/ })).getByRole("button"));
    fireEvent.click(bodyRows()[0]);
    expect(onRowClick.mock.calls[0][0].ticker).toBe("BRK");
  });

  it("칸 안의 단추·링크 조작은 행 클릭으로 한 번 더 받지 않는다(클릭·Enter 모두)", () => {
    const onRowClick = vi.fn();
    const onButton = vi.fn();
    const columns: Column<Holding>[] = [
      ...COLUMNS,
      {
        key: "action",
        header: "동작",
        cell: (row) => (
          <button type="button" onClick={() => onButton(row.ticker)}>
            {row.ticker} 담기
          </button>
        ),
      },
    ];
    render(<DataTable columns={columns} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={onRowClick} />);
    const inner = screen.getByRole("button", { name: "NVDA 담기" });
    fireEvent.click(inner);
    fireEvent.keyDown(inner, { key: "Enter" });
    expect(onButton).toHaveBeenCalledWith("NVDA");
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("DataTable — 밀도(행 높이)·개수 줄", () => {
  const classesOf = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

  it("기본 행은 넓은 화면 32px(구분선 1px 포함 — 선 있는 칸 lg:pt-1.5 lg:pb-[5px], 마지막 행 lg:py-1.5)·좁은 화면 44px(py-3 — 누를 수 없는 행도), 머리 줄은 32px — 행 구분선은 옅은 경계(border-subtle), 머리 아래 선은 경계", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const cell = within(bodyRows()[0]).getAllByRole("cell")[1];
    expect(classesOf(cell)).toEqual(expect.arrayContaining(["py-3", "lg:pt-1.5", "lg:pb-[5px]"]));
    expect(classesOf(within(bodyRows()[bodyRows().length - 1]).getAllByRole("cell")[1])).toEqual(expect.arrayContaining(["py-3", "lg:py-1.5"]));
    expect(classesOf(screen.getByRole("columnheader", { name: "이름" }))).toEqual(expect.arrayContaining(["pt-1.5", "pb-[5px]", "text-caption", "leading-5"]));
    // 선은 칸의 아래 테두리(sticky 머리를 내려도 머리 선이 따라옴 — 겹친 테두리 표의 행 선은 sticky 칸과 함께 움직이지 않음), 마지막 행은 선 없음.
    expect(classesOf(screen.getByRole("table"))).toEqual(expect.arrayContaining(["border-separate", "border-spacing-0"]));
    for (const header of screen.getAllByRole("columnheader")) {
      expect(classesOf(header)).toEqual(expect.arrayContaining(["border-b", "border-border"]));
    }
    expect(classesOf(cell)).toEqual(expect.arrayContaining(["border-b", "border-border-subtle"]));
    const last = bodyRows()[bodyRows().length - 1];
    for (const lastCell of within(last).getAllByRole("cell")) {
      expect(classesOf(lastCell)).not.toContain("border-b");
    }
  });

  it("dense면 넓은 화면 28px(구분선 포함 — lg:pt-1 lg:pb-[3px], 마지막 행 lg:py-1, 좁은 화면은 그대로 44px) — 머리 줄도 28px", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} dense />);
    expect(classesOf(within(bodyRows()[0]).getAllByRole("cell")[1])).toEqual(expect.arrayContaining(["py-3", "lg:pt-1", "lg:pb-[3px]"]));
    expect(classesOf(within(bodyRows()[bodyRows().length - 1]).getAllByRole("cell")[1])).toEqual(expect.arrayContaining(["py-3", "lg:py-1"]));
    expect(classesOf(screen.getByRole("columnheader", { name: "이름" }))).toEqual(expect.arrayContaining(["pt-1", "pb-[3px]"]));
    expect(classesOf(screen.getByRole("columnheader", { name: /비중/ }))).toEqual(expect.arrayContaining(["pt-1", "pb-0", "lg:pb-[3px]"]));
  });

  it("누를 수 있는 행은 좁은 화면(lg 미만)에서 44px(py-3), 넓은 화면은 32·28px", () => {
    const { unmount } = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={() => {}} />);
    expect(classesOf(within(bodyRows()[0]).getAllByRole("cell")[1])).toEqual(expect.arrayContaining(["py-3", "lg:pt-1.5", "lg:pb-[5px]"]));
    unmount();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={() => {}} dense />);
    expect(classesOf(within(bodyRows()[0]).getAllByRole("cell")[1])).toEqual(expect.arrayContaining(["py-3", "lg:pt-1", "lg:pb-[3px]"]));
  });

  it("정렬 머리는 lg 미만에서 단추가 44px(min-h-11)이고 위에 포커스 링 자리 4px(pt-1 — 스크롤 상자 위 끝에서 링이 잘리지 않게), 넓은 화면은 행과 같은 32px", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const header = screen.getByRole("columnheader", { name: /비중/ });
    expect(classesOf(header)).toEqual(expect.arrayContaining(["pt-1", "pb-0", "lg:pt-1.5", "lg:pb-[5px]"]));
    expect(classesOf(within(header).getByRole("button"))).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-0"]));
  });

  it("count — 표 위에 'N건'(함수면 그 글), 행이 없으면 '0건', 주지 않으면 개수 줄 없음", () => {
    const { unmount } = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} count />);
    const line = screen.getByText("4건");
    expect(classesOf(line)).toContain("tabular-nums");
    // 표 앞(문서 순서)에 둡니다 — 표 머리 위의 한 줄.
    expect(line.compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    const second = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} count={(n) => `종목 ${n}개`} />);
    expect(screen.getByText("종목 4개")).toBeTruthy();
    second.unmount();

    const third = render(<DataTable columns={COLUMNS} rows={[]} rowKey={(row) => row.ticker} count />);
    expect(screen.getByText("0건")).toBeTruthy();
    third.unmount();

    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    expect(screen.queryByText(/건$/)).toBeNull();
  });

  it("count와 scrollHint를 함께 주면 한 줄 — 개수 왼쪽, 안내 오른쪽(안내는 그대로 폰에서만·낭독기에서 숨김)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} count scrollHint />);
    const hint = screen.getByText("← 표를 좌우로 넘겨 보세요");
    expect(hint.parentElement).toBe(screen.getByText("4건").parentElement);
    expect(classesOf(hint)).toContain("sm:hidden");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DataTable — 고른 행(selectedKey)", () => {
  const classesOf = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
  const barOf = (row: HTMLElement) => row.querySelector('span[aria-hidden="true"].absolute') as HTMLElement | null;

  it("고른 행 — aria-current, 중립 바탕(surface-2), 첫 칸 안 왼쪽 막대(장식 — 이름에 들어가지 않음)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} selectedKey="AAPL" onRowClick={() => {}} />);
    const rows = bodyRows();
    const chosen = rows[2];
    expect(within(chosen).getAllByRole("cell")[0].textContent).toBe("AAPL");
    expect(chosen.getAttribute("aria-current")).toBe("true");
    expect(classesOf(chosen)).toContain("bg-surface-2");
    const firstCell = within(chosen).getAllByRole("cell")[0];
    const bar = barOf(chosen);
    expect(bar).not.toBeNull();
    expect(firstCell.contains(bar)).toBe(true);
    expect(classesOf(firstCell)).toContain("relative");
    expect(bar?.className).toBe(SELECTED_BAR);
    // 데이터 영역 — 강조 파랑을 쓰지 않습니다(A1).
    expect(chosen.outerHTML).not.toMatch(/accent/);
    for (const other of [rows[0], rows[1], rows[3]]) {
      expect(other.getAttribute("aria-current")).toBeNull();
      expect(barOf(other)).toBeNull();
      expect(classesOf(other)).not.toContain("bg-surface-2");
    }
  });

  it("기본(주지 않음)·null·없는 키면 고른 행이 없다 — 행 클릭 없이도 쓸 수 있다", () => {
    const { unmount } = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    expect(bodyRows().some((row) => row.getAttribute("aria-current") !== null || barOf(row) !== null)).toBe(false);
    unmount();
    const second = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} selectedKey={null} />);
    expect(bodyRows().some((row) => row.getAttribute("aria-current") !== null)).toBe(false);
    second.unmount();
    const third = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} selectedKey="TSLA" />);
    expect(bodyRows().some((row) => row.getAttribute("aria-current") !== null)).toBe(false);
    third.unmount();
    // 행 클릭이 없어도 고른 행을 보일 수 있습니다(무엇을 고를지는 부르는 쪽).
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} selectedKey="NVDA" />);
    expect(bodyRows()[0].getAttribute("aria-current")).toBe("true");
    expect(bodyRows()[0].getAttribute("tabindex")).toBeNull();
  });

  it("값 없는 칸이 첫 칸이어도 막대와 '—'를 함께 그리고, 정렬해도 고른 행을 따라간다", () => {
    const columns: Column<Holding>[] = [
      { key: "weight", header: "비중", align: "right", cell: (row) => (row.weight === null ? null : `${row.weight}`), sortValue: (row) => row.weight },
      COLUMNS[0],
    ];
    render(<DataTable columns={columns} rows={ROWS} rowKey={(row) => row.ticker} selectedKey="MSFT" />);
    const chosen = bodyRows().find((row) => row.getAttribute("aria-current") === "true") as HTMLElement;
    expect(within(within(chosen).getAllByRole("cell")[0]).getByText("—")).toBeTruthy();
    expect(barOf(chosen)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /비중/ }));
    const after = bodyRows().find((row) => row.getAttribute("aria-current") === "true") as HTMLElement;
    expect(within(after).getAllByRole("cell")[1].textContent).toBe("MSFT");
  });
});

// QA-624: 고른 행의 막대를 첫 칸 내용 앞에 끼울 때 칸 내용이 '요소 하나'에서 '조각(막대 + 요소)'으로 바뀌어, React가 첫 칸 안의 요소를 새로
// 만들었습니다 — 첫 칸의 단추(검사 칸 틀의 줄 단추 InspectorTrigger 등)로 그 행을 고르면 누른 단추가 문서에서 떨어져 포커스가 body로 갔습니다
// (매크로 지표 표 P5a에서 처음 씀). 고르기 전후로 같은 요소가 남아야 합니다. 가벼운 갈래가 /cot 자산 단추(행 머리 고르기 단추)로 따로 찾은 QA-630도
// 같은 결함이라(통합 때 고침을 이 꼴 하나로 합침) 그 시험(dataTableQa630)을 여기로 합쳤습니다 — 떠난 행의 단추가 같은 요소인지까지 봅니다.
describe("QA-624·QA-630 고른 행이 바뀌어도 첫 칸 안 조작은 다시 그려지지 않는다", () => {
  function Picker() {
    const [picked, setPicked] = useState<string | null>(null);
    const columns: Column<Holding>[] = [
      {
        key: "ticker",
        header: "종목",
        rowHeader: true,
        cell: (row) => (
          <button type="button" onClick={() => setPicked(row.ticker)}>
            {row.ticker}
          </button>
        ),
      },
      COLUMNS[1],
    ];
    return <DataTable columns={columns} rows={ROWS} rowKey={(row) => row.ticker} selectedKey={picked} />;
  }

  it("첫 칸의 단추로 그 행을 고르면 같은 단추가 남고 포커스도 그대로 — 다른 행으로 옮겨도 두 단추 모두 그대로", () => {
    render(<Picker />);
    const aapl = screen.getByRole("button", { name: "AAPL" });
    aapl.focus();
    fireEvent.click(aapl);
    expect(aapl.closest("tr")?.getAttribute("aria-current")).toBe("true");
    expect(aapl.isConnected).toBe(true);
    expect(document.activeElement).toBe(aapl);

    const msft = screen.getByRole("button", { name: "MSFT" });
    msft.focus();
    fireEvent.click(msft);
    expect(msft.isConnected).toBe(true);
    expect(document.activeElement).toBe(msft);
    expect(msft.closest("tr")?.getAttribute("aria-current")).toBe("true");
    // 고름이 떠난 행의 단추도 다시 만들어지지 않음(같은 요소).
    expect(aapl.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "AAPL" })).toBe(aapl);
  });
});
