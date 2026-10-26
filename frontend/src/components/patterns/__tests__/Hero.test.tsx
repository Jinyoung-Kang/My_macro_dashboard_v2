/**
 * Hero — 큰 값 · 변화 칩 · 판정 글 · 배지 · 기간 탭(설계서 §5 "판정은 글로").
 * 네 상태: 값 있음(큰 숫자 + 단위 + 칩 + 판정 글), 값 없음("—" + 사유, 칩 생략, 단위 없음),
 * 추정(meta 배지), 오래됨(meta의 ⚠️ 이전 값 + 사유). a11y: 제목(label)이 영역 이름, headingLevel.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeChip } from "../ChangeChip";
import { Empty } from "../Empty";
import { Hero } from "../Hero";
import { EstimateBadge, ProvenanceBadge, StaleBadge } from "../badges";

afterEach(() => cleanup());

describe("Hero", () => {
  it("값 있음 — 영역 이름은 제목, 큰 숫자(36~44px)·단위·칩·판정 글", () => {
    render(
      <Hero
        label="순자산"
        value="1억 2,345만"
        unit="원"
        change={<ChangeChip change={-12.5} changePct={-0.12} unit="만 원" />}
        verdict="네 계좌 모두 기준선 위"
        meta={<ProvenanceBadge source="모의매매 장부" asOf="2026-10-26 15:30" />}
        tabs={<div role="group" aria-label="기간">기간 탭</div>}
      >
        <div>차트 자리</div>
      </Hero>,
    );
    const region = screen.getByRole("region", { name: "순자산" });
    expect(within(region).getByRole("heading", { level: 2, name: "순자산" })).toBeTruthy();
    const value = within(region).getByText("1억 2,345만");
    expect(value.className).toContain("text-[36px]");
    expect(value.className).toContain("sm:text-[44px]");
    expect(value.className).toContain("tabular-nums");
    expect(within(region).getByText("원").className).toContain("text-base");
    expect(within(region).getByText("▼")).toBeTruthy();
    expect(within(region).getByText("(−0.12%)")).toBeTruthy();
    expect(within(region).getByText("네 계좌 모두 기준선 위").tagName).toBe("P");
    expect(within(region).getByText("모의매매 장부 · 2026-10-26 15:30")).toBeTruthy();
    expect(within(region).getByRole("group", { name: "기간" })).toBeTruthy();
    expect(within(region).getByText("차트 자리")).toBeTruthy();
    expect(region.className).toContain("rounded-xl");
  });

  it("headingLevel=3이면 h3", () => {
    render(<Hero label="오늘의 국면" value="확장" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "오늘의 국면" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("값 없음 — '—', 칩 생략, 단위 없음, 사유는 Empty로", () => {
    const { container } = render(
      <Hero
        label="순자산"
        value={<Empty reason="장부를 읽지 못함" />}
        unit="원"
        change={<ChangeChip change={null} changePct={null} />}
        verdict="판정 불가 — 입력 두 개가 빠짐"
      />,
    );
    const region = screen.getByRole("region", { name: "순자산" });
    expect(within(region).getByText("—")).toBeTruthy();
    expect(within(region).getByText("장부를 읽지 못함")).toBeTruthy();
    expect(within(region).getByText("판정 불가 — 입력 두 개가 빠짐")).toBeTruthy();
    expect(within(region).queryByText("▲")).toBeNull();
    expect(within(region).queryByText("▼")).toBeNull();
    expect(container.textContent).not.toContain("0.00%");
    // 사유와 함께 넘긴 <Empty />도 값 없음 — 단위를 붙이지 않는다("— 원" 없음)
    expect(within(region).queryByText("원")).toBeNull();
    cleanup();
    render(<Hero label="순자산" value={null} unit="원" change={<ChangeChip />} />);
    const empty = screen.getByRole("region", { name: "순자산" });
    expect(within(empty).getByText("—")).toBeTruthy();
    expect(within(empty).getByText("값 없음")).toBeTruthy();
    expect(within(empty).queryByText("원")).toBeNull();
  });

  it("값 없음 — 'N/A'·빈 글·NaN도 '—'", () => {
    for (const value of ["N/A", "", Number.NaN]) {
      render(<Hero label="지표" value={value} />);
      expect(within(screen.getByRole("region", { name: "지표" })).getByText("—")).toBeTruthy();
      cleanup();
    }
  });

  it("값 0은 값이다", () => {
    render(<Hero label="노출" value={0} unit="%" />);
    const region = screen.getByRole("region", { name: "노출" });
    expect(within(region).getByText("0")).toBeTruthy();
    expect(within(region).getByText("%")).toBeTruthy();
  });

  it("판정이 없으면(null·빈 글·수집기의 'N/A') 판정 줄을 만들지 않는다", () => {
    for (const verdict of [null, "  ", "N/A"]) {
      const { container } = render(<Hero label="가격" value="100" verdict={verdict} />);
      expect(container.querySelector("p")).toBeNull();
      cleanup();
    }
  });

  it("추정 — meta의 배지가 보인다", () => {
    render(
      <Hero
        label="KOSPI200 선물"
        value="402.50"
        meta={
          <>
            <EstimateBadge estimated note="KODEX 200 기반 추정치" />
            <ProvenanceBadge source="KODEX 200 기반 추정치" />
          </>
        }
      />,
    );
    const region = screen.getByRole("region", { name: "KOSPI200 선물" });
    expect(within(region).getByText("추정")).toBeTruthy();
    expect(within(region).getByText("· KODEX 200 기반 추정치")).toBeTruthy();
  });

  it("오래됨 — meta의 ⚠️ 이전 값 배지와 사유가 보인다", () => {
    render(<Hero label="순유동성" value="5.9" unit="조 달러" meta={<StaleBadge stale reason="이번 수집 실패" />} />);
    const region = screen.getByRole("region", { name: "순유동성" });
    expect(within(region).getByText("이전 값").parentElement?.className).toContain("text-warn");
    expect(within(region).getByText("· 이번 수집 실패")).toBeTruthy();
    expect(within(region).getByText("5.9")).toBeTruthy();
  });

  it("두 히어로의 제목 id가 겹치지 않는다", () => {
    render(
      <>
        <Hero label="하나" value="1" />
        <Hero label="둘" value="2" />
      </>,
    );
    expect(screen.getByRole("region", { name: "하나" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "둘" })).toBeTruthy();
  });
});
