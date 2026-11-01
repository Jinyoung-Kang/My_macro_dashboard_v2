/**
 * Hero — 큰 값 · 변화 칩 · 판정 글 · 배지 · 기간 탭(설계서 §5 "판정은 글로").
 * 네 상태: 값 있음(큰 숫자 + 단위 + 칩 + 판정 글), 값 없음("—" + 사유, 칩 생략, 단위 없음),
 * 추정(meta 배지), 오래됨(meta의 경고 아이콘 + 이전 값 + 사유), 자리표시(placeholder — 값 대신, 탭은 그 자리 그대로). a11y: 제목(label)이 영역 이름,
 * headingLevel. 문지르기(scrub, 명세 §4·D9): 큰 숫자는 그 점 값(눈으로만), 지금 값은 sr-only '지금 값 …', '기간 시작 대비' 칩·날짜, 배지는 그대로,
 * 알림 영역(aria-live polite)에 '날짜 값', 추정 점 배지와 그 설명(알림에도 '추정 23:58'), 장부 값 꼬리 점은 배지 없이 '장부'. 탭 자리(tabsPlacement) 위·아래.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeChip } from "../ChangeChip";
import { Empty } from "../Empty";
import { Hero } from "../Hero";
import { EstimateBadge, ProvenanceBadge, StaleBadge } from "../badges";

afterEach(() => cleanup());

describe("Hero", () => {
  it("값 있음 — 영역 이름은 제목, 큰 숫자(글자 단계 display — 36~44px)·단위·칩·판정 글", () => {
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
    expect(value.className).toContain("text-display-sm");
    expect(value.className).toContain("sm:text-display");
    expect(value.className).toContain("tabular-nums");
    expect(within(region).getByText("원").className).toContain("text-base");
    expect(within(region).getByText("▼")).toBeTruthy();
    expect(within(region).getByText("(−0.12%)")).toBeTruthy();
    expect(within(region).getByText("네 계좌 모두 기준선 위").tagName).toBe("P");
    expect(within(region).getByText("모의매매 장부 · 2026-10-26 15:30")).toBeTruthy();
    expect(within(region).getByRole("group", { name: "기간" })).toBeTruthy();
    expect(within(region).getByText("차트 자리")).toBeTruthy();
    expect(region.className).toContain("rounded-card");
  });

  it("valueKind='label'이면 판정 라벨 — 한 단계 작은 글자(좁은 화면 28px·sm 이상 36px), 숫자 자리 맞춤 없음", () => {
    render(<Hero label="오늘의 국면" value="후퇴 경계 (Late cycle)" valueKind="label" verdict="유동성이 빠지고 있습니다." />);
    const value = screen.getByText("후퇴 경계 (Late cycle)");
    expect(value.className).toContain("text-title-1");
    expect(value.className).toContain("sm:text-display-sm");
    expect(value.className).not.toContain("tabular-nums");
    expect(value.className).not.toContain("sm:text-display ");
    expect(screen.getByText("유동성이 빠지고 있습니다.")).toBeTruthy();
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

  it("오래됨 — meta의 이전 값 배지와 사유가 보인다", () => {
    render(<Hero label="순유동성" value="5.9" unit="조 달러" meta={<StaleBadge stale reason="이번 수집 실패" />} />);
    const region = screen.getByRole("region", { name: "순유동성" });
    expect(within(region).getByText("이전 값").parentElement?.className).toContain("text-warn");
    expect(within(region).getByText("· 이번 수집 실패")).toBeTruthy();
    expect(within(region).getByText("5.9")).toBeTruthy();
  });

  it("자리표시 — 값·변화·판정·배지 대신 그리고, 탭은 같은 자리에 남아 값으로 바뀌어도 다시 마운트되지 않는다", () => {
    const tabs = <input aria-label="시장" />;
    const { rerender } = render(
      <Hero label="순자산" value={null} unit="원" placeholder={<div role="status" aria-label="불러오는 중" />} tabs={tabs}
        verdict="판정 글" meta={<span>배지</span>} change={<span>칩</span>} />,
    );
    const region = screen.getByRole("region", { name: "순자산" });
    expect(within(region).getByRole("status", { name: "불러오는 중" })).toBeTruthy();
    expect(within(region).queryByText("—")).toBeNull();
    expect(within(region).queryByText("판정 글")).toBeNull();
    expect(within(region).queryByText("배지")).toBeNull();
    expect(within(region).queryByText("칩")).toBeNull();
    const input = within(region).getByRole("textbox", { name: "시장" });
    input.focus();
    rerender(<Hero label="순자산" value="1억" unit="원" tabs={tabs} verdict="판정 글" />);
    expect(screen.getByText("1억")).toBeTruthy();
    expect(screen.getByText("판정 글")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("textbox", { name: "시장" })).toBe(input);
    expect(document.activeElement).toBe(input);
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

  describe("문지르기(scrub)", () => {
    const base = {
      label: "순자산",
      value: "100,136.32",
      unit: "달러",
      change: (
        <span>
          <ChangeChip changePct={0.14} /> 출발 대비
        </span>
      ),
      verdict: "네 계좌 모두 기준선 위",
      meta: <StaleBadge stale reason="관측치 저장본이 늦음" />,
    };
    const liveRegion = (region: HTMLElement) => region.querySelector('[aria-live="polite"]') as HTMLElement;

    it("문지르지 않을 때(scrub=null) — 지금 값·부르는 쪽 칩, 알림 영역은 미리 있고 비어 있다", () => {
      render(<Hero {...base} scrub={null} />);
      const region = screen.getByRole("region", { name: "순자산" });
      expect(within(region).getByText("100,136.32").getAttribute("aria-hidden")).toBeNull();
      expect(within(region).getByText("출발 대비")).toBeTruthy();
      const live = liveRegion(region);
      expect(live.className).toContain("sr-only");
      expect(live.getAttribute("aria-atomic")).toBe("true");
      expect(live.textContent).toBe("");
      expect(within(region).queryByText(/지금 값/)).toBeNull();
    });

    it("문지르는 중 — 큰 숫자는 그 점 값(눈으로만), sr '지금 값', '기간 시작 대비' 칩과 날짜, 판정 글·이전 값 배지는 그대로", () => {
      render(
        <Hero
          {...base}
          scrub={{ valueText: "99,341.08", dateText: "2026-10-27", change: -658.92, changePct: -0.66 }}
        />,
      );
      const region = screen.getByRole("region", { name: "순자산" });
      const shown = within(region).getByText("99,341.08");
      expect(shown.getAttribute("aria-hidden")).toBe("true");
      expect(shown.className).toContain("text-display-sm");
      expect(within(region).getByText(/지금 값/).className).toContain("sr-only");
      expect(within(region).getByText(/지금 값/).textContent).toBe("지금 값 100,136.32 달러");
      expect(within(region).queryByText("출발 대비")).toBeNull();
      expect(within(region).getByText("기간 시작 대비 ·")).toBeTruthy();
      expect(within(region).getByText("(−0.66%)")).toBeTruthy();
      expect(within(region).getByText("−658.92")).toBeTruthy();
      expect(within(region).getByText("2026-10-27")).toBeTruthy();
      // 판정 글과 meta 배지(이전 값)는 문지르는 동안에도 보입니다(원칙 A3).
      expect(within(region).getByText("네 계좌 모두 기준선 위")).toBeTruthy();
      expect(within(region).getByText("이전 값").parentElement?.className).toContain("text-warn");
      expect(liveRegion(region).textContent).toBe("2026-10-27 99,341.08 달러");
    });

    it("그 점의 값이 없으면 '—'(단위 없음)·칩 생략, 날짜만 — 알림도 단위 없이", () => {
      render(<Hero {...base} scrub={{ valueText: "—", dateText: "2026-10-28", change: null, changePct: null }} />);
      const region = screen.getByRole("region", { name: "순자산" });
      expect(within(region).getByText("—").className).toContain("text-text-3");
      expect(within(region).queryByText("기간 시작 대비 ·")).toBeNull();
      expect(within(region).queryByText("▲")).toBeNull();
      expect(within(region).queryByText("▼")).toBeNull();
      expect(within(region).getByText("2026-10-28")).toBeTruthy();
      // 단위는 지금 값(sr-only)에만
      expect(within(region).getAllByText(/달러/).every((node) => node.className.includes("sr-only"))).toBe(true);
      expect(liveRegion(region).textContent).toBe("2026-10-28 —");
    });

    it("추정 점 — 점 옆에 추정 배지(설명), 알림에 '추정'과 그 설명(기준 시각 — 눈으로만 보이지 않게)", () => {
      render(
        <Hero
          {...base}
          scrub={{ valueText: "100,250.00", dateText: "2026-10-30", change: 250, changePct: 0.25, isEstimated: true, estimateNote: "23:58" }}
        />,
      );
      const region = screen.getByRole("region", { name: "순자산" });
      expect(within(region).getByText("추정").parentElement?.className).toContain("border-dashed");
      expect(within(region).getByText("· 23:58")).toBeTruthy();
      expect(liveRegion(region).textContent).toBe("2026-10-30 100,250.00 달러 추정 23:58");
    });

    it("장부 값 꼬리 점(현금뿐 계좌) — 추정 배지 없이 설명 '장부', 알림에도 '장부'", () => {
      render(
        <Hero
          {...base}
          scrub={{ valueText: "100,000.00", dateText: "2026-10-30", change: 0, changePct: 0, isEstimated: false, estimateNote: "장부" }}
        />,
      );
      const region = screen.getByRole("region", { name: "순자산" });
      expect(within(region).queryByText("추정")).toBeNull();
      expect(within(region).getByText("· 장부")).toBeTruthy();
      expect(liveRegion(region).textContent).toBe("2026-10-30 100,000.00 달러 장부");
    });

    it("문지르기와 지금 값이 바뀌어도 본문(차트)은 다시 마운트되지 않는다", () => {
      const chart = <input aria-label="차트" />;
      const { rerender } = render(<Hero {...base} scrub={null}>{chart}</Hero>);
      const input = screen.getByRole("textbox", { name: "차트" });
      input.focus();
      rerender(<Hero {...base} scrub={{ valueText: "1", dateText: "d", change: 1, changePct: 1 }}>{chart}</Hero>);
      rerender(<Hero {...base} scrub={null}>{chart}</Hero>);
      expect(screen.getByRole("textbox", { name: "차트" })).toBe(input);
      expect(document.activeElement).toBe(input);
    });

    it("scrub을 주지 않으면 알림 영역도 없다(문지를 수 없는 히어로)", () => {
      render(<Hero {...base} />);
      expect(liveRegion(screen.getByRole("region", { name: "순자산" }))).toBeNull();
    });
  });

  it("tabsPlacement — 기본은 본문 위, 'below'면 본문 아래(차트 아래 기간 알약)", () => {
    const tabs = <div role="tablist" aria-label="기간" />;
    const { rerender } = render(
      <Hero label="순자산" value="1" tabs={tabs}>
        <div>차트</div>
      </Hero>,
    );
    const order = () => {
      const list = screen.getByRole("tablist", { name: "기간" });
      return list.compareDocumentPosition(screen.getByText("차트")) & Node.DOCUMENT_POSITION_FOLLOWING ? "above" : "below";
    };
    expect(order()).toBe("above");
    rerender(
      <Hero label="순자산" value="1" tabs={tabs} tabsPlacement="below">
        <div>차트</div>
      </Hero>,
    );
    expect(order()).toBe("below");
  });
});
