/**
 * AssetRow·AssetList — 자산 행(설계서 §5 "값 없음 —, 변화 없음은 칩 생략, 플래그 배지는 반드시 보인다").
 * 네 상태: 값 있음(이름·보조·값+단위·변화 칩), 값 없음("—"·단위 없음·칩 생략, valueText "N/A"도 "—"),
 * 추정·대리(배지), 오래됨(⚠️ 이전 값 + 사유). 그 밖에 경고 글·출처 배지·스파크라인,
 * 상호작용(href → 링크, onSelect → aria-pressed 버튼, 둘 다 없으면 그냥 줄), 목록(제목·윗선·빈 글·선택).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetList, AssetRow, type AssetRowData } from "../AssetRow";

afterEach(() => cleanup());

const SPX: AssetRowData = {
  id: "spx",
  name: "S&P 500",
  sub: "SPX",
  value: 5800.123,
  unit: "pt",
  change: 12.3,
  changePct: 0.21,
  source: "TradingView",
  delayMin: 15,
  asOf: "2026-10-26 05:00",
};

describe("AssetRow", () => {
  it("값 있음 — 이름·보조·값(tabular-nums)·단위(작게)·변화 칩, 배지 줄은 없다", () => {
    const { container } = render(<AssetRow row={SPX} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.tagName).toBe("DIV");
    expect(row.className).toContain("min-h-[54px]");
    expect(screen.getByText("S&P 500")).toBeTruthy();
    expect(screen.getByText("SPX").className).toContain("text-text-3");
    const value = screen.getByText("5,800.12");
    expect(value.className).toContain("tabular-nums");
    expect(within(value).getByText("pt").className).toContain("text-xs");
    expect(screen.getByText("+12.30")).toBeTruthy();
    expect(screen.getByText("(+0.21%)")).toBeTruthy();
    expect(screen.getByText("상승")).toBeTruthy();
    expect(screen.queryByText("추정")).toBeNull();
    expect(screen.queryByText("이전 값")).toBeNull();
    // 출처 배지는 showProvenance일 때만
    expect(screen.queryByText(/TradingView/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("valueText가 있으면 숫자 서식보다 우선", () => {
    render(<AssetRow row={{ ...SPX, valueText: "5,800.1" }} />);
    expect(screen.getByText("5,800.1")).toBeTruthy();
    expect(screen.queryByText("5,800.12")).toBeNull();
  });

  it("값 없음 — '—'(값 없음), 단위 없음, 변화를 모르면 칩 생략(0.00% 없음)", () => {
    const { container } = render(
      <AssetRow row={{ id: "x", name: "WTI", value: null, unit: "달러", change: null, changePct: null }} />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("값 없음")).toBeTruthy();
    expect(screen.queryByText("달러")).toBeNull();
    expect(container.textContent).not.toContain("0.00");
    expect(container.textContent).not.toContain("%");
    expect(screen.queryByText("상승")).toBeNull();
    expect(screen.queryByText("변화 없음")).toBeNull();
  });

  it("값 없음 — 수집기 valueText 'N/A'는 숫자가 있어도 '—'", () => {
    const { container } = render(<AssetRow row={{ ...SPX, valueText: "N/A" }} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("N/A")).toBeNull();
    expect(screen.queryByText("5,800.12")).toBeNull();
    expect(screen.queryByText("pt")).toBeNull();
    // 변화 칩은 값과 별개 — 아는 변화는 그대로 보인다
    expect(container.textContent).toContain("+12.30");
  });

  it("값 0은 값이다 — '—'가 아니다", () => {
    render(<AssetRow row={{ id: "z", name: "기준금리 변화", value: 0, changePct: 0 }} />);
    expect(screen.getByText("0.00")).toBeTruthy();
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(screen.queryByText("값 없음")).toBeNull();
    expect(screen.getByText("변화 없음")).toBeTruthy();
  });

  it("추정·대리 — 배지가 보인다(숨기는 옵션 없음)", () => {
    render(
      <>
        <AssetRow row={{ id: "a", name: "KOSPI200 야간", value: 402.5, isEstimated: true }} />
        <AssetRow row={{ id: "b", name: "MOVE", value: 98.1, isProxy: true }} />
      </>,
    );
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("대리 지표")).toBeTruthy();
  });

  it("오래됨 — ⚠️ 이전 값 배지(경고색)와 사유", () => {
    render(<AssetRow row={{ ...SPX, isStale: true, staleReason: "이번 수집 실패" }} />);
    expect(screen.getByText("5,800.12")).toBeTruthy();
    expect(screen.getByText("이전 값").parentElement?.className).toContain("text-warn");
    expect(screen.getByText("· 이번 수집 실패")).toBeTruthy();
  });

  it("경고 글 — 경고색 + 아이콘, 읽어 주기에는 '주의:'", () => {
    render(<AssetRow row={{ id: "w", name: "달러 인덱스", value: null, warning: "수집 실패" }} />);
    const warning = screen.getByText("수집 실패");
    expect(warning.className).toContain("text-warn");
    expect(within(warning).getByText("⚠️").getAttribute("aria-hidden")).toBe("true");
    expect(within(warning).getByText("주의:")).toBeTruthy();
  });

  it("빈 경고 글·'N/A'는 그리지 않는다", () => {
    render(<AssetRow row={{ id: "w", name: "달러 인덱스", value: 1, warning: "N/A" }} />);
    expect(screen.queryByText("N/A")).toBeNull();
    expect(screen.queryByText("주의:")).toBeNull();
  });

  it("showProvenance — 출처 · 지연 · 시각 배지, 출처를 모르면 '출처 —'", () => {
    render(
      <>
        <AssetRow row={SPX} showProvenance />
        <AssetRow row={{ id: "u", name: "모름", value: 1 }} showProvenance />
        <AssetRow row={{ id: "l", name: "환율", value: 1420.5, source: "TradingView", live: true, delayMin: 15 }} showProvenance />
      </>,
    );
    expect(screen.getByText("TradingView · 15분 지연 · 2026-10-26 05:00")).toBeTruthy();
    expect(screen.getByText("출처 —")).toBeTruthy();
    expect(screen.getByText("TradingView · 실시간")).toBeTruthy();
  });

  it("스파크라인 — 알려진 점 2개 이상이면 aria-hidden svg, 아니면 없음", () => {
    const { container, rerender } = render(<AssetRow row={{ ...SPX, spark: [1, 2, null, 3] }} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    rerender(<AssetRow row={{ ...SPX, spark: [1, null] }} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("href — 행 전체가 링크", () => {
    render(<AssetRow row={{ ...SPX, href: "/macro" }} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/macro");
    expect(within(link).getByText("S&P 500")).toBeTruthy();
    expect(within(link).getByText("5,800.12")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("onSelect — aria-pressed 버튼, 누르면 id를 넘긴다", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<AssetRow row={SPX} onSelect={onSelect} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("spx");
    rerender(<AssetRow row={SPX} onSelect={onSelect} selected />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("href와 onSelect가 함께 오면 링크가 이긴다", () => {
    render(<AssetRow row={{ ...SPX, href: "/macro" }} onSelect={() => {}} selected />);
    expect(screen.getByRole("link")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AssetList", () => {
  const ROWS: AssetRowData[] = [
    SPX,
    { id: "ndx", name: "나스닥 100", value: null },
    { id: "vix", name: "VIX", value: 18.4, isStale: true, staleReason: "이번 수집 실패" },
  ];

  it("제목이 있으면 h2 + 그 이름의 영역, 행마다 목록 항목, 둘째 행부터 1px 윗선", () => {
    render(<AssetList title="시장" rows={ROWS} />);
    const region = screen.getByRole("region", { name: "시장" });
    expect(within(region).getByRole("heading", { level: 2, name: "시장" })).toBeTruthy();
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.className).toContain("border-t");
      expect(item.className).toContain("border-border");
    }
    expect(items[0].className).toContain("first:border-t-0");
  });

  it("네 상태가 한 목록에 섞여도 각자 보인다", () => {
    render(<AssetList title="시장" rows={[...ROWS, { id: "est", name: "추정 지표", value: 3, isEstimated: true }]} />);
    const [spx, ndx, vix, est] = screen.getAllByRole("listitem");
    expect(within(spx).getByText("5,800.12")).toBeTruthy();
    expect(within(ndx).getByText("—")).toBeTruthy();
    expect(within(vix).getByText("이전 값")).toBeTruthy();
    expect(within(est).getByText("추정")).toBeTruthy();
  });

  it("행이 없으면 emptyText(기본 문구)", () => {
    render(
      <>
        <AssetList title="가" rows={[]} emptyText="보유 종목이 없습니다." />
        <AssetList title="나" rows={[]} />
      </>,
    );
    expect(within(screen.getByRole("region", { name: "가" })).getByText("보유 종목이 없습니다.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "나" })).getByText("표시할 항목이 없습니다.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("onSelect·selectedId — 고른 행만 aria-pressed=true", () => {
    const onSelect = vi.fn();
    render(<AssetList rows={ROWS} onSelect={onSelect} selectedId="ndx" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    fireEvent.click(buttons[2]);
    expect(onSelect).toHaveBeenCalledWith("vix");
  });

  it("showProvenance는 모든 행에, children은 행 아래에", () => {
    render(
      <AssetList title="시장" rows={ROWS} showProvenance>
        <a href="/macro">매크로 지표 전체</a>
      </AssetList>,
    );
    expect(screen.getAllByText(/TradingView|출처 —/)).toHaveLength(3);
    const region = screen.getByRole("region", { name: "시장" });
    expect(region.lastElementChild?.textContent).toBe("매크로 지표 전체");
  });

  it("제목이 없으면 이름 없는 묶음(제목 요소 없음)", () => {
    render(<AssetList rows={ROWS} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
