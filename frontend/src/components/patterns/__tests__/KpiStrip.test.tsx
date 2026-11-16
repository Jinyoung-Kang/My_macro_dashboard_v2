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
/**
 * 타일 안 값 글 — 글이 '값 + 단위' 전체와 같은 가장 안쪽 요소. 단위가 있으면 마지막 글자와 단위가 값 끝 묶음으로 갈려 글 마디가 나뉘므로(QA-599)
 * getByText(값)으로는 찾지 못합니다.
 */
const valueText = (tileNode: HTMLElement, text: string): HTMLElement =>
  within(tileNode).getByText(
    (_, element) => element !== null && element.textContent === text && !Array.from(element.children).some((child) => child.textContent === text),
  );

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
  // 1.6px 모자라 단위만 다음 줄로 넘어갔습니다. 첫 고침(189659ac)은 값 줄을 flex-nowrap으로 두었지만, 긴 값 정리(6bfa67cb)가 단위를 값 글 안으로 옮긴
  // 뒤로 값 줄의 flex 항목은 하나뿐이라 효과가 없었습니다 — 단위를 붙드는 실제 기제는 아래 두 시험(값 끝 묶음·띠 폭으로 정하는 한 줄)이 봅니다.
  // 여기서는 값 줄이 값 글 하나를 담는 flex 행이고 줄바꿈 규칙은 값 글이 정한다는 것만 봅니다. jsdom은 배치를 재지 않아 클래스로 봅니다.
  it("값 줄은 값 글 하나를 담는 flex 행 — 숫자 값 글은 단위를 안에 담고, 판정 라벨은 낱말 사이에서 꺾는다 (QA-599)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "usdkrw", label: "원/달러", value: 1339.28, format: (v) => v.toLocaleString("ko-KR", { minimumFractionDigits: 2 }), unit: "원" },
          { key: "regime", label: "국면", value: "후퇴 경계 (Late cycle)", valueKind: "label" },
        ]}
      />,
    );
    const value = valueText(tile("원/달러"), "1,339.28원");
    expect(within(value).getByText("원")).toBeTruthy();
    const numberRow = value.parentElement as HTMLElement;
    expect(numberRow.children).toHaveLength(1);
    expect(numberRow.className.split(/\s+/)).toEqual(["mt-0.5", "flex", "items-baseline"]);
    const label = within(tile("국면")).getByText("후퇴 경계 (Late cycle)");
    expect((label.parentElement as HTMLElement).children).toHaveLength(1);
    expect(label.className).toContain("break-keep");
  });

  // QA-599(근본 원인): 긴 값 정리(6bfa67cb)가 단위를 값 글 안 끝으로 옮긴 뒤로 값 줄의 flex 항목은 하나뿐이라 위 시험이 보는 flex-nowrap은 효과가 없고,
  // 단위를 한 줄에 붙드는 것은 단위의 오른쪽 바깥 여백(−12px)뿐이었습니다. 숫자 끝과 단위 사이의 줄바꿈 기회(한글 단위 앞)가 그대로라 12px보다 많이
  // 모자라면 단위만 다음 줄로 갔습니다(루프백 빌드 1280 · 메뉴 320 — 타일 121.1px에서 '원' 아래 끝 170 / 값 줄 140, 메뉴 220에서도 '13,392.80'이면 같음).
  // 수정 전(재현 커밋에서는 it.fails) '원'의 부모는 값 글 span(클래스에 whitespace-nowrap 없음 — 글 '1,339.28원')이었습니다. 단위가 다음 줄로 가지
  // 않으려면 띠가 그만큼 좁은 칸을 만들지 않아야 합니다(아래 시험 — 한 줄 최소 칸 폭 134px).
  it("단위는 값의 마지막 글자와 한 nowrap 묶음 — 숫자 끝과 단위 사이에 줄바꿈 기회가 없다 (QA-599)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "usdkrw", label: "원/달러", value: 1339.28, format: (v) => v.toLocaleString("ko-KR", { minimumFractionDigits: 2 }), unit: "원" },
          { key: "us10y", label: "미국채 10년물", value: "4.933", unit: "%" },
        ]}
      />,
    );
    for (const [name, unit, tail, whole] of [
      ["원/달러", "원", "8원", "1,339.28원"],
      ["미국채 10년물", "%", "3%", "4.933%"],
    ] as const) {
      const group = within(tile(name)).getByText(unit).parentElement as HTMLElement;
      expect(group.className.split(/\s+/), name).toContain("whitespace-nowrap");
      expect(group.textContent, name).toBe(tail);
      // 묶음은 값 글(24px 굵게 tabular) 안 끝 — 값 글 전체는 '값 + 단위' 그대로입니다.
      const value = group.parentElement as HTMLElement;
      expect(value.className.split(/\s+/), name).toContain("tabular-nums");
      expect(value.textContent, name).toBe(whole);
    }
  });

  // QA-599(근본 원인): 한 줄 여부를 뷰포트(xl)만으로 정해, 왼쪽 메뉴가 넓으면 1280에서 일곱 타일이 121px(메뉴 320)까지 좁아져 단위 여유(12px)를
  // 넘었습니다. 수정 전(재현 커밋에서는 it.fails) 띠 section은 컨테이너가 아니고(클래스 'min-w-0'), 목록은 'xl:grid-cols-[repeat(var(--kpi-n),minmax(0,1fr))]'였습니다.
  it("한 줄 여부는 띠 폭(컨테이너 질의) — xl이면서 띠가 '타일 수 × 134px + 사이 8px'보다 넓을 때만 타일 수만큼 한 줄 (QA-599)", () => {
    const items = (n: number): KpiItem[] => Array.from({ length: n }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: index }));
    const { container, rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const section = () => container.querySelector("section") as HTMLElement;
    const list = () => (container.querySelector("ul") as HTMLElement).className.split(/\s+/);
    expect(section().className.split(/\s+/)).toContain("@container");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      rerender(<KpiStrip label="요약" items={items(n)} />);
      expect(list(), `${n}`).toContain(`xl:@min-[${n * 134 + (n - 1) * 8}px]:grid-cols-${n}`);
      // 뷰포트만으로 한 줄을 정하는 클래스는 없습니다.
      expect(list().filter((token) => token.startsWith("xl:grid-cols")), `${n}`).toEqual([]);
    }
  });

  it("기본 배치는 두 칸·sm 세 칸·lg 네 칸, 8개를 넘으면 xl에서도 네 칸 그대로", () => {
    const items = (n: number): KpiItem[] => Array.from({ length: n }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: index }));
    const { container, rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const list = () => container.querySelector("ul") as HTMLElement;
    expect(list().className.split(/\s+/)).toEqual(["grid", "grid-cols-2", "gap-2", "sm:grid-cols-3", "lg:grid-cols-4", "xl:@min-[986px]:grid-cols-7"]);
    rerender(<KpiStrip label="요약" items={items(9)} />);
    expect(list().className.split(/\s+/)).toEqual(["grid", "grid-cols-2", "gap-2", "sm:grid-cols-3", "lg:grid-cols-4"]);
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

  // QA-598(한 줄 배치): 읽는 중 시장 타일은 200px인데 한 줄 배치의 칸은 좁아 읽은 뒤 타일이 가장 낮아도 208px(1440·1920 홈, 1280은 259px)이라 값이
  // 오면 아래 패널 격자가 8px 이상 밀렸습니다(루프백 빌드 /api/* 1.5초 지연 — 1440 layout-shift 합 0.057 가운데 0.055).
  // 수정 전(재현 커밋에서는 it.fails) 자리 줄 블록 클래스는 배치와 상관없이 'mt-2.5 flex flex-col gap-3.5'였습니다.
  it("한 줄 배치(ONE_ROW_GRID와 같은 띠 폭 경계)에서는 읽는 중 자리 줄 위 간격이 18px, 그 밖은 10px (QA-598)", () => {
    const items = (n: number): KpiItem[] =>
      Array.from({ length: n }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: null, pending: true, pendingLines: 5 }));
    const { container, rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const block = () => (container.querySelector('li div[aria-hidden="true"].flex-col') as HTMLElement).className.split(/\s+/);
    for (const n of [6, 7, 8]) {
      rerender(<KpiStrip label="요약" items={items(n)} />);
      expect(block(), `${n}`).toEqual(["mt-2.5", "flex", "flex-col", "gap-3.5", `xl:@min-[${n * 134 + (n - 1) * 8}px]:mt-4.5`]);
    }
    // 8개를 넘으면 한 줄 배치가 없으므로 간격도 그대로입니다.
    rerender(<KpiStrip label="요약" items={items(9)} />);
    expect(block()).toEqual(["mt-2.5", "flex", "flex-col", "gap-3.5"]);
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

// 공백 없는 긴 출처(URL 꼬리)와 끊을 곳 없는 긴 값이 타일 밖(옆 타일 밑)으로 넘쳤습니다(QA 스택 합성 응답 — 1280 출처 479px·값 91px 넘침).
// jsdom은 배치를 재지 않아 '조상 클래스 사슬'로 봅니다(DetailQaHolderBreak·SearchQaHoldings 시험과 같은 방법).
describe("KpiStrip — 긴 값·출처의 줄바꿈", () => {
  const LONG_SOURCE = "TradingView Scanner · https://example.invalid/averyveryverylongpathwithoutanybreakingpoints/abcdefghijklmnopqrstuvwxyz0123456789";
  const LONG_VALUE = "12,345,678,901.234";
  /** 요소에서 타일(링크 또는 묶음)까지의 조상 클래스 사슬에 그 클래스가 있나. */
  const chainHas = (node: HTMLElement, tileNode: HTMLElement, token: string) => {
    for (let current: HTMLElement | null = node; current; current = current.parentElement) {
      if (current.className.split(/\s+/).includes(token)) return true;
      if (current === tileNode) return false;
    }
    return false;
  };

  it("값·출처 글에서 타일까지 wrap-anywhere — 링크 타일과 묶음 타일 모두, 숫자 값은 줄어들지 않고 값 줄 폭까지·단위는 마지막 글자에 붙어 꺾지 않음", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "us10y", label: "미국채 10년물", value: LONG_VALUE, unit: "%", source: LONG_SOURCE, asOf: "2026-11-14T15:31:00+09:00", href: "/markets/i/us10y" },
          { key: "plain", label: "긴 값", value: LONG_VALUE, unit: "pt", source: LONG_SOURCE },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /^미국채 10년물/ });
    const group = tile("긴 값");
    for (const tileNode of [link, group]) {
      const value = valueText(tileNode, `${LONG_VALUE}${tileNode === link ? "%" : "pt"}`);
      const source = within(tileNode).getByText(/averyveryverylongpath/);
      expect(chainHas(value, tileNode, "wrap-anywhere"), "값").toBe(true);
      expect(chainHas(source, tileNode, "wrap-anywhere"), "출처").toBe(true);
      // 숫자 값은 flex-nowrap 값 줄에서 줄어들지 않고(짧은 숫자가 숫자 안에서 꺾이지 않게) 값 줄 폭까지만 — 그보다 긴 값만 그 안에서 꺾입니다.
      expect(value.className.split(/\s+/)).toEqual(expect.arrayContaining(["shrink-0", "max-w-full"]));
    }
    // 단위는 값 글 안 끝의 값 끝 묶음(마지막 글자 + 단위, nowrap) 안이라 값이 꺾이면 마지막 줄을 따라가고, 타일 안쪽 여백까지 걸칠 수 있습니다
    // (오른쪽 바깥 여백 −12px).
    for (const [tileNode, unit] of [[link, "%"], [group, "pt"]] as const) {
      const unitNode = within(tileNode).getByText(unit);
      const tail = unitNode.parentElement as HTMLElement;
      expect(tail.textContent, unit).toBe(`4${unit}`);
      expect(tail.className.split(/\s+/), unit).toContain("whitespace-nowrap");
      expect(tail.parentElement, unit).toBe(valueText(tileNode, `${LONG_VALUE}${unit}`));
      expect(unitNode.className.split(/\s+/), unit).toEqual(expect.arrayContaining(["-mr-3", "ml-1", "font-normal"]));
    }
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
