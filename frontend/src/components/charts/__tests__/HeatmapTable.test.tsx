/**
 * 표 히트맵(components/charts/HeatmapTable.tsx — 일반 표 HeatmapTable과 그 감싸개인 13F 포트폴리오 화면의 비중 히트맵 WeightHeatmap). 값은 합성입니다
 * (가상 종목·기관 이름).
 *
 * - 일반 표: 칠한 칸은 순차 팔레트 단계 바탕·단계 글자색·data-step·고대비에서도 색 그대로, 모름 '—'·0(zeroText)은 칠하지 않음, max 0 이하면 칠하지 않음,
 *   범례(견본 다섯·단계 글·'밝은 단계일수록 큼'·설명 글), 영역 이름(가로 스크롤 상자).
 * - DOM 고정: 합성 자료 하나로 그린 비중 히트맵의 요소마다 태그·클래스·인라인 모양·속성·글을 줄로 적어 둡니다. 히트맵 몸통을 옮기거나 일반 표 히트맵으로
 *   바꾸는 커밋이 같은 DOM을 내는지 이 목록으로 봅니다(겉모양을 바꾸는 커밋은 같은 커밋에서 이 목록을 고칩니다).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HeatmapTable, type HeatmapRow, WeightHeatmap } from "@/components/charts";
import { SEQUENTIAL_STEPS, SEQUENTIAL_TEXT } from "@/lib/heatmap";

afterEach(cleanup);

const DATES = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
/** 최댓값 10 — 비율 1·0.8·0.6·0.4·0.003·0.2와 미보유(0)·모름(null). */
const SERIES = {
  "SYNTHETIC ALPHA CO": [10, 8, 6, 4],
  "SYNTHETIC BETA CO": [0.03, 2, 0, null],
};

/** 요소 하나를 한 줄로 — 깊이·태그·속성(이름 차례)·바로 아래 글 마디. */
function pinLines(root: Element): string[] {
  const lines: string[] = [];
  const visit = (element: Element, depth: number) => {
    const attributes = [...element.attributes]
      .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
      .sort();
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join("");
    lines.push(`${"  ".repeat(depth)}${element.tagName.toLowerCase()}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}${text ? ` ${JSON.stringify(text)}` : ""}`);
    for (const child of element.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines;
}

/** jsdom이 인라인 바탕을 적는 꼴(rgb(r, g, b)). */
function rgbOf(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const COLUMNS = [
  { key: "a", label: "가", title: "가상 갑 기관" },
  { key: "b", label: "나", title: "가상 을 기관" },
  { key: "c", label: "다" },
  { key: "d", label: "라" },
  { key: "e", label: "마" },
];

function renderTable(rows: HeatmapRow[], extra: { max?: number; zeroText?: string; note?: string } = {}) {
  return render(
    <HeatmapTable
      caption="합성 행렬"
      rowHeader="기관"
      columns={COLUMNS}
      rows={rows}
      max={extra.max ?? 100}
      format={(value) => value.toFixed(1)}
      zeroText={extra.zeroText}
      legend={{ stepLabel: (step) => `단계 ${step}`, note: extra.note }}
    />,
  );
}

/** 이름이 label인 행의 값 칸(첫 열 머리 칸을 뺀 td). */
function cellsOf(label: string): HTMLTableCellElement[] {
  const row = screen.getByText(label).closest("tr") as HTMLTableRowElement;
  return Array.from(row.querySelectorAll("td")).filter((cell) => cell.textContent !== label);
}

describe("표 히트맵(HeatmapTable) — 칸·범례", () => {
  it("값: 칠한 칸마다 순차 팔레트 단계 바탕·단계 글자색(1~3 본문색, 4~5 바탕색)·data-step, 고대비에서도 색 그대로·tabular-nums", () => {
    renderTable([{ key: "r", label: "가상 행", values: [100, 70, 50, 30, 10] }]);
    const cells = cellsOf("가상 행");
    expect(cells.map((cell) => cell.textContent)).toEqual(["100.0", "70.0", "50.0", "30.0", "10.0"]);
    [5, 4, 3, 2, 1].forEach((step, index) => {
      const cell = cells[index];
      expect(cell.getAttribute("data-step")).toBe(String(step));
      expect(cell.style.backgroundColor).toBe(rgbOf(SEQUENTIAL_STEPS[step - 1]));
      expect(cell.style.color).toBe(SEQUENTIAL_TEXT[step - 1]);
      expect(tokens(cell)).toEqual(expect.arrayContaining(["forced-color-adjust-none", "tabular-nums"]));
    });
    expect(cells.map((cell) => cell.style.color)).toEqual(["var(--bg)", "var(--bg)", "var(--text)", "var(--text)", "var(--text)"]);
  });

  it("모름은 '—', 0은 zeroText — 둘 다 칠하지 않는다(단계·바탕·고대비 예외 없음)", () => {
    renderTable([{ key: "r", label: "가상 행", values: [null, undefined, 0, 40, 0] }], { zeroText: "·" });
    const cells = cellsOf("가상 행");
    expect(cells.map((cell) => cell.textContent)).toEqual(["—", "—", "·", "40.0", "·"]);
    for (const index of [0, 1, 2, 4]) {
      const cell = cells[index];
      expect(cell.hasAttribute("data-step"), `${index}`).toBe(false);
      expect(cell.style.backgroundColor, `${index}`).toBe("");
      expect(tokens(cell), `${index}`).not.toContain("forced-color-adjust-none");
    }
    expect(cells[3].getAttribute("data-step")).toBe("2");
  });

  it("zeroText가 없으면 0도 format 글이고 칠하지 않는다, 음수도 칠하지 않는다", () => {
    renderTable([{ key: "r", label: "가상 행", values: [0, -5, 100, null, 1] }]);
    const cells = cellsOf("가상 행");
    expect(cells.map((cell) => cell.textContent)).toEqual(["0.0", "-5.0", "100.0", "—", "1.0"]);
    expect(cells.map((cell) => cell.getAttribute("data-step"))).toEqual([null, null, "5", null, "1"]);
  });

  it("견줄 최댓값이 0 이하면 아무 칸도 칠하지 않는다", () => {
    renderTable([{ key: "r", label: "가상 행", values: [1, 2, 3, 4, 5] }], { max: 0 });
    expect(cellsOf("가상 행").every((cell) => !cell.hasAttribute("data-step") && cell.style.backgroundColor === "")).toBe(true);
  });

  it("칸 마우스 설명은 '{행} · {열}' — 행·열의 전체 이름(title)이 있으면 그것", () => {
    renderTable([{ key: "r", label: "가상 행", title: "가상 행 전체 이름", values: [1, 2, 3, 4, 5] }]);
    expect(cellsOf("가상 행").map((cell) => cell.getAttribute("title"))).toEqual([
      "가상 행 전체 이름 · 가상 갑 기관",
      "가상 행 전체 이름 · 가상 을 기관",
      "가상 행 전체 이름 · 다",
      "가상 행 전체 이름 · 라",
      "가상 행 전체 이름 · 마",
    ]);
  });

  it("범례: 견본 다섯(장식·단계 바탕·고대비에서도 색 그대로)과 단계 글, '밝은 단계일수록 큼', 설명 글", () => {
    renderTable([{ key: "r", label: "가상 행", values: [1, 2, 3, 4, 5] }], { note: "합성 설명 글" });
    const legend = screen.getByRole("list", { name: "칸 색 단계" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["단계 1", "단계 2", "단계 3", "단계 4", "단계 5", "밝은 단계일수록 큼"]);
    items.slice(0, 5).forEach((item, index) => {
      const swatch = item.querySelector("span") as HTMLElement;
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
      expect(swatch.style.backgroundColor).toBe(rgbOf(SEQUENTIAL_STEPS[index]));
      expect(tokens(swatch)).toContain("forced-color-adjust-none");
    });
    expect(screen.getByText("합성 설명 글").tagName).toBe("P");
  });

  it("설명 글을 주지 않으면 범례 아래 문단이 없다", () => {
    const { container } = renderTable([{ key: "r", label: "가상 행", values: [1, 2, 3, 4, 5] }]);
    expect(container.querySelector("p")).toBeNull();
  });

  it("영역 이름 '{caption} (좌우 스크롤)'·Tab 정지점, 최소 폭은 기본 640px 클래스·주면 인라인 폭", () => {
    const { unmount } = renderTable([{ key: "r", label: "가상 행", values: [1, 2, 3, 4, 5] }]);
    const region = screen.getByRole("region", { name: "합성 행렬 (좌우 스크롤)" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(tokens(region.querySelector("table") as HTMLElement)).toContain("min-w-[640px]");
    unmount();
    render(
      <HeatmapTable
        caption="합성 행렬"
        rowHeader="기관"
        columns={COLUMNS}
        rows={[{ key: "r", label: "가상 행", values: [1, 2, 3, 4, 5] }]}
        max={5}
        format={String}
        legend={{ stepLabel: String }}
        minWidth={720}
      />,
    );
    const table = screen.getByRole("table");
    expect(tokens(table)).not.toContain("min-w-[640px]");
    expect(table.style.minWidth).toBe("720px");
  });
});

describe("비중 히트맵 DOM 고정(합성 자료)", () => {
  it("요소마다 태그·클래스·인라인 모양·속성·글이 아래 목록과 같다", () => {
    const { container } = render(<WeightHeatmap dates={DATES} series={SERIES} />);
    expect(pinLines(container.firstElementChild as Element)).toEqual([
      "div aria-label=\"비중 히트맵 (좌우 스크롤)\" class=\"overflow-x-auto\" role=\"region\" tabindex=\"0\"",
      "  table class=\"w-full min-w-[640px] border-collapse text-xs\"",
      "    thead",
      "      tr class=\"text-xs text-text-3\"",
      "        th class=\"sticky left-0 bg-surface px-3 py-2 text-left font-medium\" \"종목\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"25-12-31\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-03-31\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-06-30\"",
      "        th class=\"px-2 py-2 text-right font-medium tabular-nums\" \"26-09-30\"",
      "    tbody",
      "      tr",
      "        td class=\"sticky left-0 bg-surface px-3 py-1.5 text-left text-text-2\" \"SYNTHETIC ALPHA CO\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"5\" style=\"background-color: rgb(214, 159, 214); color: var(--bg);\" title=\"SYNTHETIC ALPHA CO · 2025-12-31\" \"10.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"4\" style=\"background-color: rgb(189, 107, 189); color: var(--bg);\" title=\"SYNTHETIC ALPHA CO · 2026-03-31\" \"8.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"3\" style=\"background-color: rgb(157, 63, 157); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2026-06-30\" \"6.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"2\" style=\"background-color: rgb(124, 50, 124); color: var(--text);\" title=\"SYNTHETIC ALPHA CO · 2026-09-30\" \"4.0%\"",
      "      tr",
      "        td class=\"sticky left-0 bg-surface px-3 py-1.5 text-left text-text-2\" \"SYNTHETIC BETA CO\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"1\" style=\"background-color: rgb(92, 37, 92); color: var(--text);\" title=\"SYNTHETIC BETA CO · 2025-12-31\" \"<0.1%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums forced-color-adjust-none\" data-step=\"1\" style=\"background-color: rgb(92, 37, 92); color: var(--text);\" title=\"SYNTHETIC BETA CO · 2026-03-31\" \"2.0%\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" title=\"SYNTHETIC BETA CO · 2026-06-30\" \"·\"",
      "        td class=\"px-2 py-1.5 text-right tabular-nums\" title=\"SYNTHETIC BETA CO · 2026-09-30\" \"—\"",
      "  ul aria-label=\"칸 색 단계\" class=\"mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3\"",
      "    li class=\"inline-flex items-center gap-1 tabular-nums\" \"최댓값의 0~20%\"",
      "      span aria-hidden=\"true\" class=\"size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none\" style=\"background-color: rgb(92, 37, 92);\"",
      "    li class=\"inline-flex items-center gap-1 tabular-nums\" \"최댓값의 20~40%\"",
      "      span aria-hidden=\"true\" class=\"size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none\" style=\"background-color: rgb(124, 50, 124);\"",
      "    li class=\"inline-flex items-center gap-1 tabular-nums\" \"최댓값의 40~60%\"",
      "      span aria-hidden=\"true\" class=\"size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none\" style=\"background-color: rgb(157, 63, 157);\"",
      "    li class=\"inline-flex items-center gap-1 tabular-nums\" \"최댓값의 60~80%\"",
      "      span aria-hidden=\"true\" class=\"size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none\" style=\"background-color: rgb(189, 107, 189);\"",
      "    li class=\"inline-flex items-center gap-1 tabular-nums\" \"최댓값의 80~100%\"",
      "      span aria-hidden=\"true\" class=\"size-3 shrink-0 rounded-sm border border-border forced-color-adjust-none\" style=\"background-color: rgb(214, 159, 214);\"",
      "    li \"밝은 단계일수록 큼\"",
      "  p class=\"mt-1 text-xs text-text-3\" \"최댓값은 이 표에서 가장 큰 비중(10.0%)입니다. \\\"·\\\"는 그 분기에 는 뜻이고, \\\"—\\\"는 는 뜻입니다 — 둘은 다르고, 둘 다 칠하지 않습니다.\"",
      "    b \"보유하지 않았다\"",
      "    b \"값을 모른다\"",
    ]);
  });
});
