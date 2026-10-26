/**
 * StatTile·StatGrid — 통계 타일(설계서 §5 "표본 부족이면 —와 사유").
 * 네 상태: 값 있음(값 + 단위 + 보조 글), 값 없음("—" + 사유, 단위 없음 — QA-049), 추정·대리(배지), 오래됨(⚠️ 이전 값 + 사유).
 * a11y: 타일 하나가 라벨 이름의 group.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatGrid, StatTile } from "../StatTile";

afterEach(() => cleanup());

describe("StatTile", () => {
  it("값 있음 — 라벨 이름의 group, 카드 숫자(24px)·tabular-nums, 단위는 작게 옆에", () => {
    render(<StatTile label="샤프 비율" value={1.2345} unit="배" note="2023-10-09 이후 784개 · 약 3.0년" />);
    const tile = screen.getByRole("group", { name: "샤프 비율" });
    expect(tile.className).toContain("rounded-xl");
    expect(tile.className).toContain("border");
    const value = within(tile).getByText("1.23");
    expect(value.className).toContain("text-2xl");
    expect(value.className).toContain("tabular-nums");
    expect(within(tile).getByText("배").className).toContain("text-sm");
    expect(within(tile).getByText("2023-10-09 이후 784개 · 약 3.0년")).toBeTruthy();
    expect(within(tile).queryByText("추정")).toBeNull();
    expect(within(tile).queryByText("이전 값")).toBeNull();
  });

  it("format이 있으면 그것으로, 글 값은 그대로", () => {
    render(
      <>
        <StatTile label="표본" value={784} format={(v) => v.toLocaleString("ko-KR")} unit="개" />
        <StatTile label="기간" value="3.0년" />
      </>,
    );
    expect(within(screen.getByRole("group", { name: "표본" })).getByText("784")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "기간" })).getByText("3.0년")).toBeTruthy();
  });

  it("값 0은 값이다 — '—'가 아니다", () => {
    render(<StatTile label="낙폭" value={0} unit="%" />);
    const tile = screen.getByRole("group", { name: "낙폭" });
    expect(within(tile).getByText("0.00")).toBeTruthy();
    expect(within(tile).queryByText("—")).toBeNull();
  });

  it("값 없음 — '—'와 사유, 단위는 붙이지 않는다(—% 없음)", () => {
    render(<StatTile label="연환산 변동성" value={null} unit="%" emptyReason="표본 부족(20일 미만)" />);
    const tile = screen.getByRole("group", { name: "연환산 변동성" });
    expect(within(tile).getByText("—")).toBeTruthy();
    expect(within(tile).getByText("값 없음")).toBeTruthy();
    expect(within(tile).getByText("표본 부족(20일 미만)")).toBeTruthy();
    expect(within(tile).queryByText("%")).toBeNull();
    expect(tile.textContent).not.toContain("0.00");
  });

  it("값 없음 — 수집기의 'N/A'·NaN도 '—'", () => {
    render(
      <>
        <StatTile label="가" value="N/A" unit="%" />
        <StatTile label="나" value={Number.NaN} unit="%" />
      </>,
    );
    for (const name of ["가", "나"]) {
      const tile = screen.getByRole("group", { name });
      expect(within(tile).getByText("—")).toBeTruthy();
      expect(within(tile).queryByText("N/A")).toBeNull();
      expect(within(tile).queryByText("NaN")).toBeNull();
      expect(within(tile).queryByText("%")).toBeNull();
    }
  });

  it("보조 글이 비었거나 수집기의 'N/A'면 그리지 않는다", () => {
    render(
      <>
        <StatTile label="가" value={1} note="N/A" />
        <StatTile label="나" value={1} note="   " />
      </>,
    );
    for (const name of ["가", "나"]) {
      const tile = screen.getByRole("group", { name });
      expect(tile.querySelector("p")).toBeNull();
      expect(within(tile).queryByText("N/A")).toBeNull();
    }
  });

  it("추정·대리 — 배지가 보인다(숨기는 옵션 없음)", () => {
    render(
      <>
        <StatTile label="KOSPI200 선물" value={402.5} isEstimated />
        <StatTile label="MOVE" value={98.1} isProxy />
      </>,
    );
    expect(within(screen.getByRole("group", { name: "KOSPI200 선물" })).getByText("추정")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "MOVE" })).getByText("대리 지표")).toBeTruthy();
  });

  it("오래됨 — ⚠️ 이전 값 배지와 사유가 보인다", () => {
    render(<StatTile label="순자산" value="1억 2,000만" unit="원" isStale staleReason="이번 수집 실패" />);
    const tile = screen.getByRole("group", { name: "순자산" });
    expect(within(tile).getByText("1억 2,000만")).toBeTruthy();
    expect(within(tile).getByText("이전 값").parentElement?.className).toContain("text-warn");
    expect(within(tile).getByText("· 이번 수집 실패")).toBeTruthy();
  });

  it("값 없음 + 오래됨 + 추정이 함께 와도 모두 보인다", () => {
    render(<StatTile label="합" value={null} isEstimated isStale emptyReason="입력 부족" />);
    const tile = screen.getByRole("group", { name: "합" });
    expect(within(tile).getByText("—")).toBeTruthy();
    expect(within(tile).getByText("입력 부족")).toBeTruthy();
    expect(within(tile).getByText("추정")).toBeTruthy();
    expect(within(tile).getByText("이전 값")).toBeTruthy();
  });
});

describe("StatGrid", () => {
  it("기본 4칸(좁은 화면 2칸), cols로 2·3칸", () => {
    const { container } = render(
      <>
        <StatGrid>
          <StatTile label="a" value={1} />
        </StatGrid>
        <StatGrid cols={3}>
          <StatTile label="b" value={1} />
        </StatGrid>
        <StatGrid cols={2}>
          <StatTile label="c" value={1} />
        </StatGrid>
      </>,
    );
    const [four, three, two] = Array.from(container.children) as HTMLElement[];
    expect(four.className).toContain("grid-cols-2");
    expect(four.className).toContain("md:grid-cols-4");
    expect(three.className).toContain("md:grid-cols-3");
    expect(two.className).toContain("grid-cols-2");
    expect(two.className).not.toContain("md:grid-cols");
    expect(within(four).getByRole("group", { name: "a" })).toBeTruthy();
  });
});
