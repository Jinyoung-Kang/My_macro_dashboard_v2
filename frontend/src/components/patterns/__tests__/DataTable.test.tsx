/**
 * DataTable — 밀도 높은 표(설계서 §5 "열 정렬·고정 머리, 행 클릭 → 상세", §6 네 상태).
 * 네 상태: 값 있음(숫자 열 오른쪽·tabular-nums), 값 없음(칸 "—"·행 없음 문구), 추정·대리(칸 배지), 오래됨(칸 ⚠️ 이전 값).
 * 정렬: 머리 단추 + 정렬한 열의 th에만 aria-sort, 모르는 값은 방향과 무관하게 맨 뒤. 행 클릭: Tab으로 닿고 Enter·Space로 열림.
 * 틀: 가로 스크롤 상자·sticky 머리·maxHeight, scrollHint(최소 640px + 폰 안내 줄), 행 머리(rowHeader → th scope=row).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("추정·대리 — 칸 안의 배지가 그대로 보인다", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} />);
    const aapl = within(bodyRows()[2]).getAllByRole("cell")[1];
    expect(within(aapl).getByText("대리 지표")).toBeTruthy();
    expect(within(aapl).getByText("· ETF 대리")).toBeTruthy();
    expect(within(within(bodyRows()[0]).getAllByRole("cell")[1]).queryByText("대리 지표")).toBeNull();
  });

  it("오래됨 — 칸 안의 '⚠️ 이전 값' + 사유(경고색)", () => {
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
    expect(within(row).getAllByRole("cell")[0].className).not.toContain("group-hover:underline");
  });

  it("행을 누르면 그 행으로 부른다 — tabIndex 0, hover는 첫 칸 밑줄(바탕을 칠하지 않음 — 상승·하락 글자 대비)", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.ticker} onRowClick={onRowClick} />);
    const row = bodyRows()[2];
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).not.toMatch(/hover:bg-/);
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
