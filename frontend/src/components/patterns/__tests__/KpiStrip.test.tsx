/**
 * KpiStrip — KPI 띠(작업대 실행 명세 §6·W7, P4 — 홈 맨 위).
 * 네 상태: 불러오는 중(pending — 값 자리 Skeleton role=status), 빈 값('—' + 사유, 단위 없음), 오류(상태 글 — 아이콘 + 글), 값 있음(20·24px tabular-nums,
 * 판정 라벨은 tabular 아님). 데이터 패턴의 넷: 값·'—'·추정/대리 배지·이전 값 + 사유. 변화는 변화 칩(▲▼ 12px·sr '상승/하락'), 대상 링크는 중립 잉크.
 * a11y: 띠는 이름 있는 영역(section aria-label), 타일은 이름 있는 묶음(role=group) — 링크 타일은 링크 이름에 라벨이 들어감.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KpiStrip, type KpiItem } from "../KpiStrip";

afterEach(() => cleanup());

const tile = (name: string) => screen.getByRole("group", { name });

describe("KpiStrip — 값 있음", () => {
  it("띠는 이름 있는 영역, 타일은 라벨 이름의 묶음 — 값은 20px(lg 24px)·굵게·tabular-nums, 단위는 작게 옆에", () => {
    render(
      <KpiStrip
        label="오늘 요약"
        items={[
          { key: "sp500", label: "S&P 500", value: 6012.345, format: (v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) },
          { key: "us10y", label: "미국채 10년물", value: 4.123, format: (v) => v.toFixed(2), unit: "%" },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: "오늘 요약" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    const value = within(tile("S&P 500")).getByText("6,012.35");
    expect(value.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xl", "lg:text-2xl", "font-semibold", "tabular-nums", "text-text"]));
    expect(within(tile("미국채 10년물")).getByText("%").className).toContain("text-text-3");
    expect(within(tile("S&P 500")).getByText("S&P 500").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-caption", "text-text-2"]));
  });

  it("0은 값이다 — '—'가 아니다", () => {
    render(<KpiStrip label="요약" items={[{ key: "alerts", label: "읽지 않은 알림", value: 0, format: (v) => `${v}건` }]} />);
    expect(within(tile("읽지 않은 알림")).getByText("0건")).toBeTruthy();
    expect(within(tile("읽지 않은 알림")).queryByText("—")).toBeNull();
  });

  it("판정 라벨(valueKind label)은 tabular 없이 16·20px, 중립 값은 중립 잉크", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "regime", label: "국면", value: "확장 후반", valueKind: "label" },
          { key: "unknown", label: "국면(어제)", value: "판정 불가", valueKind: "label", neutral: true },
        ]}
      />,
    );
    const regime = within(tile("국면")).getByText("확장 후반");
    expect(regime.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-heading-sm", "lg:text-heading", "text-text"]));
    expect(regime.className).not.toContain("tabular-nums");
    expect(within(tile("국면(어제)")).getByText("판정 불가").className).toContain("text-neutral");
  });

  it("변화는 변화 칩 — ▲▼는 읽기에서 빼고 12px, 방향은 sr 글, 음수 부호 −, 캡션은 12px 보조 글", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "kospi", label: "코스피", value: 2612.5, change: { change: 12.3, changePct: 0.47, caption: "전일 대비" } },
          { key: "usdkrw", label: "원/달러", value: 1391.2, change: { change: -4.1, changePct: -0.29, caption: "전일 대비" } },
          { key: "none", label: "모름", value: 1, change: { change: null, changePct: null, caption: "전일 대비" } },
        ]}
      />,
    );
    const up = tile("코스피");
    const upArrow = within(up).getByText("▲");
    expect(upArrow.getAttribute("aria-hidden")).toBe("true");
    expect(upArrow.className).toContain("text-xs");
    expect(within(up).getByText("상승").className).toContain("sr-only");
    expect(within(up).getByText("전일 대비").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3"]));
    const down = tile("원/달러");
    expect(within(down).getByText("▼").getAttribute("aria-hidden")).toBe("true");
    expect(within(down).getByText("하락").className).toContain("sr-only");
    expect(within(down).getByText("−4.10")).toBeTruthy();
    // 변화를 모르면 칩도 캡션도 없다(0.00%를 만들지 않음)
    expect(within(tile("모름")).queryByText("전일 대비")).toBeNull();
  });

  it("href가 있으면 타일 전체가 링크(이름에 라벨) — 중립 잉크·hover surface-2·포커스 링, 강조 파랑 클래스 없음", () => {
    render(<KpiStrip label="요약" items={[{ key: "sp500", label: "S&P 500", value: 6012, href: "/markets/i/sp500" }]} />);
    const link = screen.getByRole("link", { name: /S&P 500/ });
    expect(link.getAttribute("href")).toBe("/markets/i/sp500");
    const tokens = link.className.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(["text-text", "hover:bg-surface-2", "focus-visible:outline-focus"]));
    expect(tokens.filter((token) => token.includes("accent"))).toEqual([]);
    expect(within(link).getByText("S&P 500").className).toContain("group-hover:underline");
    expect(screen.queryByRole("group", { name: "S&P 500" })).toBeNull();
  });

  it("xl은 타일 수만큼 한 줄(--kpi-n), 8개를 넘으면 네 칸 그대로", () => {
    const items = (n: number): KpiItem[] => Array.from({ length: n }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: index }));
    const { container, rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const list = () => container.querySelector("ul") as HTMLElement;
    expect(list().className.split(/\s+/)).toEqual(
      expect.arrayContaining(["grid", "grid-cols-2", "gap-2", "sm:grid-cols-3", "lg:grid-cols-4", "xl:grid-cols-[repeat(var(--kpi-n),minmax(0,1fr))]"]),
    );
    expect(list().style.getPropertyValue("--kpi-n")).toBe("7");
    rerender(<KpiStrip label="요약" items={items(9)} />);
    expect(list().className).not.toContain("xl:grid-cols");
    expect(list().style.getPropertyValue("--kpi-n")).toBe("");
  });
});

describe("KpiStrip — 값 없음·불러오는 중·오류", () => {
  it("null·빈 글·'N/A'는 '—'(값 없음)와 사유, 단위는 붙이지 않는다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "a", label: "코스피", value: null, unit: "pt", emptyReason: "저장본에 없음" },
          { key: "b", label: "원/달러", value: "N/A", unit: "원" },
          { key: "c", label: "수집 오류", value: "" },
        ]}
      />,
    );
    for (const name of ["코스피", "원/달러", "수집 오류"]) {
      expect(within(tile(name)).getByText("—").getAttribute("aria-hidden"), name).toBe("true");
      expect(within(tile(name)).getByText("값 없음").className, name).toContain("sr-only");
    }
    expect(within(tile("코스피")).getByText("저장본에 없음")).toBeTruthy();
    expect(within(tile("코스피")).queryByText("pt")).toBeNull();
    expect(within(tile("원/달러")).queryByText("원")).toBeNull();
  });

  it("읽는 중(pending)이면 값 자리에 Skeleton — role=status '{라벨} 불러오는 중', 변화·상태는 그리지 않는다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[{ key: "sp500", label: "S&P 500", value: null, pending: true, change: { change: 1, changePct: 1 }, status: { tone: "warn", text: "지연" } }]}
      />,
    );
    expect(within(tile("S&P 500")).getByRole("status", { name: "S&P 500 불러오는 중" })).toBeTruthy();
    expect(within(tile("S&P 500")).queryByText("—")).toBeNull();
    expect(within(tile("S&P 500")).queryByText("▲")).toBeNull();
    expect(within(tile("S&P 500")).queryByText("지연")).toBeNull();
  });

  it("상태 글(오류·주의)은 아이콘 + 읽어 주는 머리말 + 글 — 색만으로 뜻을 전하지 않는다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "err", label: "수집 오류", value: 3, format: (v) => `${v}건`, status: { tone: "danger", text: "오류 태스크 3개" } },
          { key: "warn", label: "끊긴 출처", value: 1, format: (v) => `${v}곳`, status: { tone: "warn", text: "6시간 넘게 새 글 없음" } },
        ]}
      />,
    );
    const danger = within(tile("수집 오류")).getByText("오류 태스크 3개");
    expect(danger.parentElement?.className).toContain("text-danger");
    expect(danger.parentElement?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(within(tile("수집 오류")).getByText("오류:").className).toContain("sr-only");
    expect(within(tile("끊긴 출처")).getByText("주의:").className).toContain("sr-only");
  });
});

describe("KpiStrip — 추정·대리·이전 값", () => {
  it("추정·대리 배지와 이전 값 배지(+ 사유)가 늘 보인다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "a", label: "공정가치", value: 101, isEstimated: true },
          { key: "b", label: "유동성", value: 5.1, isProxy: true },
          { key: "c", label: "원/달러", value: 1391, isStale: true, staleReason: "수집 실패 — 11-14 값", note: "기준 2026-11-14 15:30" },
        ]}
      />,
    );
    expect(within(tile("공정가치")).getByText("추정")).toBeTruthy();
    expect(within(tile("유동성")).getByText("대리 지표")).toBeTruthy();
    expect(within(tile("원/달러")).getByText("이전 값")).toBeTruthy();
    expect(within(tile("원/달러")).getByText("· 수집 실패 — 11-14 값")).toBeTruthy();
    expect(within(tile("원/달러")).getByText("기준 2026-11-14 15:30").className).toContain("text-text-3");
  });
});
