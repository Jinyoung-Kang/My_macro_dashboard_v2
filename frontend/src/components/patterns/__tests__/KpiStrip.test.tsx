/**
 * KpiStrip — KPI 띠(작업대 실행 명세 §6·W7, P4 — 홈 맨 위).
 * 네 상태: 불러오는 중(pending — 값 자리 Skeleton role=status), 빈 값('—' + 사유, 단위 없음), 오류(상태 글 — 아이콘 + 글), 값 있음(20·24px tabular-nums,
 * 판정 라벨은 tabular 아님). 데이터 패턴의 넷: 값·'—'·추정/대리 배지·이전 값 + 사유, 그리고 출처 줄(출처·지연·시각 — 참고 시세 표기, 툴팁).
 * 변화는 변화 칩(▲▼ 12px·sr '상승/하락'), 대상 링크는 중립 잉크.
 * a11y: 띠는 이름 있는 영역(section aria-label), 타일은 이름 있는 묶음(role=group) — 링크 타일은 링크 이름에 라벨이 들어감.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";

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
    // 좁은 화면 누르는 자리 44px를 클래스로도 — 클래스로 읽는 누름 자리 감사가 링크 타일을 봅니다(높이는 내용이 66px 이상으로 정함).
    expect(belowLgTarget(link.className)).toBeNull();
    expect(within(link).getByText("S&P 500").className).toContain("group-hover:underline");
    expect(screen.queryByRole("group", { name: "S&P 500" })).toBeNull();
  });

  // QA-599: 값 줄이 flex-wrap이라 운영자 일곱 타일의 xl 한 줄(1280 펼친 메뉴 — 타일 135.4px, 안쪽 109.4px)에서 '1,339.28'(약 93px) + '원'이
  // 1.6px 모자라 단위만 다음 줄로 넘어갔습니다. 숫자는 쉼표에서도 꺾이지 않으므로 값과 단위를 한 줄에 둡니다. jsdom은 배치를 재지 않아 클래스로 봅니다.
  // 수정 전(재현 커밋에서는 it.fails) 숫자 값 줄은 'mt-0.5 flex flex-wrap items-baseline gap-x-1'이었습니다.
  it.fails("숫자 값과 단위는 한 덩어리 — 숫자 값 줄은 flex-nowrap, 판정 라벨 줄은 flex-wrap 그대로 (QA-599)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "usdkrw", label: "원/달러", value: 1339.28, format: (v) => v.toLocaleString("ko-KR", { minimumFractionDigits: 2 }), unit: "원" },
          { key: "regime", label: "국면", value: "후퇴 경계 (Late cycle)", valueKind: "label" },
        ]}
      />,
    );
    const numberRow = (within(tile("원/달러")).getByText("원").parentElement as HTMLElement).className.split(/\s+/);
    expect(within(tile("원/달러")).getByText("1,339.28")).toBeTruthy();
    expect(numberRow).toContain("flex-nowrap");
    expect(numberRow).not.toContain("flex-wrap");
    const labelRow = (within(tile("국면")).getByText("후퇴 경계 (Late cycle)").parentElement as HTMLElement).className.split(/\s+/);
    expect(labelRow).toContain("flex-wrap");
    expect(within(tile("국면")).getByText("후퇴 경계 (Late cycle)").className).toContain("break-keep");
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

  // QA-596: 값 줄이 flex 행(mt-0.5 flex flex-wrap items-baseline)이라 폭을 정하지 않은 Skeleton 상자가 flex 항목이 되어 폭 0으로 줄었습니다
  // (QA 스택 1440 상자 0x22·막대 0x14, 390도 0, 고대비 2px — 타일에 이름만 보임). jsdom은 폭을 재지 못해 클래스로 봅니다.
  // 수정 전(재현 커밋에서는 it.fails) role=status의 부모는 'mt-0.5 flex flex-wrap items-baseline gap-x-1'이었습니다.
  it("읽는 중이면 값 줄은 flex 행이 아닌 블록 — 자리표시 막대가 타일 폭 전체가 된다 (QA-596)", () => {
    render(<KpiStrip label="요약" items={[{ key: "sp500", label: "S&P 500", value: null, pending: true }]} />);
    const status = within(tile("S&P 500")).getByRole("status", { name: "S&P 500 불러오는 중" });
    const row = (status.parentElement as HTMLElement).className.split(/\s+/);
    expect(row).toContain("mt-0.5");
    expect(row).not.toContain("flex");
    expect(row).not.toContain("flex-wrap");
  });

  // QA-597: 읽는 중인 링크 타일은 이름 칸('S&P 500')과 안의 자리표시 이름('S&P 500 불러오는 중')이 함께 링크 이름이 되어
  // 'S&P 500 S&P 500 불러오는 중'으로 이름이 두 번 읽혔습니다(QA 스택 홈 여섯 타일, CDP 접근성 트리).
  // 수정 전(재현 커밋에서는 it.fails) 링크 이름은 'S&P 500 S&P 500 불러오는 중'이었습니다.
  it("읽는 중인 링크 타일의 이름은 '{이름} 불러오는 중' 한 번 — 이름 칸은 읽는 동안 읽어 주기에서 뺀다, 묶음 타일은 그대로 (QA-597)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "sp500", label: "S&P 500", value: null, pending: true, href: "/markets/i/sp500" },
          { key: "kospi", label: "코스피", value: null, pending: true },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "S&P 500 불러오는 중" });
    expect(within(link).getByRole("status").getAttribute("aria-label")).toBe("S&P 500 불러오는 중");
    expect(within(link).getByRole("status", { name: "S&P 500 불러오는 중" })).toBeTruthy();
    // 링크가 아닌 타일은 묶음 이름(aria-label)이 이름 그대로입니다.
    expect(within(tile("코스피")).getByRole("status", { name: "코스피 불러오는 중" })).toBeTruthy();
  });

  // QA-598: 읽는 중 타일은 이름 + 자리표시 한 줄(64px)이라 값·변화·배지·출처 줄이 오면 1440 타일 64→208px, 390 띠 280→677px로 자라
  // 아래 2×2 패널 전체가 밀렸습니다(QA 스택 /api/* 1.5초 지연 CLS 390 0.63·1024 0.37·1440 0.24).
  // 수정 전(재현 커밋에서는 it.fails) 막대는 값 자리표시의 1개뿐이었습니다.
  it("읽는 중 자리 줄(pendingLines) — 값 자리표시 아래 같은 블록에 글 없는 막대를 그 수만큼 더 그리고, 읽어 주는 상태는 하나 (QA-598)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "sp500", label: "S&P 500", value: null, pending: true, pendingLines: 4 },
          { key: "alerts", label: "읽지 않은 알림", value: null, pending: true },
        ]}
      />,
    );
    const market = tile("S&P 500");
    const status = within(market).getByRole("status", { name: "S&P 500 불러오는 중" });
    expect(within(market).getAllByRole("status")).toHaveLength(1);
    const bars = Array.from(market.querySelectorAll(".bg-control-fill"));
    expect(bars).toHaveLength(1 + 4);
    for (const bar of bars) {
      expect(bar.closest('[aria-hidden="true"]'), "막대는 읽어 주기에서 뺌").not.toBeNull();
      expect(bar.textContent).toBe("");
    }
    // 덧 막대는 값 자리표시와 같은 블록(값 줄) 안에 있습니다.
    const block = status.parentElement as HTMLElement;
    expect(bars.every((bar) => block.contains(bar))).toBe(true);
    // 주지 않으면 지금처럼 값 자리표시 한 줄입니다.
    expect(tile("읽지 않은 알림").querySelectorAll(".bg-control-fill")).toHaveLength(1);
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

describe("KpiStrip — 출처 줄", () => {
  it("출처·지연·시각을 주면 타일 아래 출처 줄(12px 보조 글 · 읽어 주는 머리말 '출처:') — 링크 타일 이름에도 들어간다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "sp500", label: "S&P 500", value: 6012, source: "Yahoo Finance (^GSPC) · 개장", delayMin: 15, asOf: "2026-11-14T15:30:00+09:00", href: "/markets/i/sp500" },
          { key: "kospi", label: "코스피", value: 2612.5, source: "Yahoo Finance (^KS11) · 마감", asOf: "2026-11-14T15:30:00+09:00", provenanceTitle: "시세 20분 지연(출처 기준) — 장이 닫혀 있어 배지에는 적지 않습니다" },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /S&P 500/ });
    const line = within(link).getByText(/Yahoo Finance \(\^GSPC\) · 개장 · 15분 지연 · 2026-11-14 15:30/);
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3", "tabular-nums"]));
    expect(within(line).getByText("출처:").className).toContain("sr-only");
    expect(link.textContent).toContain("Yahoo Finance (^GSPC) · 개장 · 15분 지연");
    // 닫힌 장이라 배지에 적지 않은 지연은 툴팁으로
    const closed = within(tile("코스피")).getByText(/Yahoo Finance \(\^KS11\) · 마감 · 2026-11-14 15:30/);
    expect(closed.getAttribute("title")).toBe("시세 20분 지연(출처 기준) — 장이 닫혀 있어 배지에는 적지 않습니다");
  });

  it("비공식 참고 시세는 출처 글 그대로 '참고 시세'가 보이고, 값을 모르는 타일('—')에도 출처 줄은 남는다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "us10y", label: "미국채 10년물", value: "4.123", unit: "%", source: "TradingView Scanner · 참고 시세 · 개장", delayMin: 0, asOf: "2026-11-14T15:31:00+09:00" },
          { key: "fail", label: "원/달러", value: null, emptyReason: "수집 실패", source: "Yahoo Finance (KRW=X) · 마감", asOf: "2026-11-13T23:59:00+09:00" },
        ]}
      />,
    );
    expect(within(tile("미국채 10년물")).getByText(/TradingView Scanner · 참고 시세 · 개장 · 실시간 · 2026-11-14 15:31/)).toBeTruthy();
    expect(within(tile("원/달러")).getByText("수집 실패")).toBeTruthy();
    expect(within(tile("원/달러")).getByText(/Yahoo Finance \(KRW=X\) · 마감/)).toBeTruthy();
  });

  it("출처를 주지 않은 타일(앱 안에서 센 수)·읽는 중인 타일에는 출처 줄이 없다 — '출처 —'를 만들지 않는다", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "alerts", label: "읽지 않은 알림", value: 2, format: (v) => `${v}건` },
          { key: "sp500", label: "S&P 500", value: null, pending: true, source: "Yahoo Finance (^GSPC)", asOf: "2026-11-14T15:30:00+09:00" },
        ]}
      />,
    );
    expect(within(tile("읽지 않은 알림")).queryByText(/출처/)).toBeNull();
    expect(within(tile("S&P 500")).queryByText(/Yahoo Finance/)).toBeNull();
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
