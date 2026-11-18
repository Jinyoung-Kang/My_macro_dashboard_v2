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

  it("변화 단위(change.unit)는 변화량 바로 옆에 작게(공용 변화 칩의 unit) — 주지 않으면 단위 없음(홈 띠 그대로)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "spread", label: "10Y-3M", value: -0.42, unit: "%p", change: { change: -0.032, digits: 3, unit: "%p", caption: "전일 대비" } },
          { key: "kospi", label: "코스피", value: 2612.5, change: { change: 12.3, changePct: 0.47 } },
        ]}
      />,
    );
    const amount = within(tile("10Y-3M")).getByText("−0.032");
    expect(amount.textContent).toBe("−0.032%p");
    expect(within(amount).getByText("%p").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "font-normal"]));
    // 주지 않으면 변화량 옆에 단위 칸이 없다
    const plain = within(tile("코스피")).getByText("+12.30");
    expect(plain.children).toHaveLength(0);
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
    // 단위가 있는 숫자 값의 값 줄은 타일 안쪽 여백까지 걸치는 여유(−12px)를 갖습니다(QA-625 — 예전에는 단위 글의 음수 여백).
    expect(numberRow.className.split(/\s+/)).toEqual(["mt-0.5", "-mr-3", "flex", "items-baseline"]);
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

  // QA-663: lg 칸 수가 타일 수와 상관없이 네 칸이라, 타일 둘인 상관 요약 띠가 1024~1279에서 줄의 절반만 써 칸이 90~119px로 좁아졌습니다
  // (QA 스택 1024 메뉴 220 '상관계수 (변|화)', 1100·1180 메뉴 220 보조 글 '2026-11-|03'). lg 칸 수는 타일 수와 4 가운데 작은 쪽이어야 합니다.
  // 수정 전(재현 커밋에서는 it.fails) items(2)의 목록에는 'lg:grid-cols-4'가 있었고 'lg:grid-cols-2'가 없었습니다.
  it("lg 칸 수는 타일 수와 4 가운데 작은 쪽 — 하나·둘·셋이면 그만큼, 넷 이상이면 네 칸 (QA-663)", () => {
    const items = (n: number): KpiItem[] => Array.from({ length: n }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: index }));
    const { container, rerender } = render(<KpiStrip label="요약" items={items(2)} />);
    const list = () => (container.querySelector("ul") as HTMLElement).className.split(/\s+/);
    expect(list()).toContain("lg:grid-cols-2");
    expect(list()).not.toContain("lg:grid-cols-4");
    rerender(<KpiStrip label="요약" items={items(3)} />);
    expect(list()).toContain("lg:grid-cols-3");
    expect(list()).not.toContain("lg:grid-cols-4");
    rerender(<KpiStrip label="요약" items={items(1)} />);
    expect(list()).toContain("lg:grid-cols-1");
    for (const n of [4, 6, 7, 9]) {
      rerender(<KpiStrip label="요약" items={items(n)} />);
      expect(list().filter((token) => token.startsWith("lg:grid-cols")), `${n}`).toEqual(["lg:grid-cols-4"]);
    }
    // sm 세 칸은 그대로.
    rerender(<KpiStrip label="요약" items={items(2)} />);
    expect(list()).toContain("sm:grid-cols-3");
  });

  // QA-663: 타일 이름 칸에 break-keep이 없어 타일의 wrap-anywhere만 물려받아 한글을 음절 사이에서 꺾었습니다('상관계수 (변|화)' — QA 스택 1024 메뉴 220).
  // 공용 글 부품 규약(QA-568 — 낱말 사이에서만 꺾음, 보조 글은 QA-637)에서 빠진 자리입니다. 수정 전(재현 커밋에서는 it.fails) 이름 칸 클래스에 'break-keep'이 없었습니다.
  it("타일 이름은 낱말 사이에서만 꺾는다 — 묶음 타일·링크 타일 모두 break-keep (QA-663)", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "corr", label: "상관계수 (변화)", value: -0.007 },
          { key: "sp500", label: "S&P 500", value: 6012.3, href: "/markets/i/sp500" },
        ]}
      />,
    );
    expect(within(tile("상관계수 (변화)")).getByText("상관계수 (변화)").className.split(/\s+/)).toContain("break-keep");
    const link = screen.getByRole("link", { name: /S&P 500/ });
    expect(within(link).getByText("S&P 500").className.split(/\s+/)).toContain("break-keep");
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

  // QA-604: 홈 시장 타일의 자리 줄 5(변화·이전 값 배지·출처 3줄)는 타일이 좁은 배치(두 칸 390·네 칸 1024·한 줄 배치)에 맞춘 값이라, 타일이 넓은
  // 세 칸(sm~lg, 192~312px)과 띠 816px(= 4 × 198 + 3 × 8) 이상의 네 칸(lg 1100~1279, 198~243px)에서는 출처 줄이 덜 꺾여 읽은 뒤 타일(QA 자료
  // 154~187·175px, 새 자료 128~178·149~166px)보다 자리표시(200px)가 커 값이 오면 아래 전체가 올라왔습니다(QA 스택 /api/* 1.5초 지연 CLS — 새 자료
  // 768 0.082·900 0.093·1000 0.095·820x1180 0.093~0.113, lg 1100~1279 0.041~0.075). jsdom은 배치를 재지 못해 클래스로 봅니다.
  // 수정 전(재현 커밋에서는 it.fails) 다섯째 덧 막대의 클래스는 'h-3.5 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border w-3/5'
  // (감추는 클래스 없음 — pendingLinesWide를 읽지 않음)였습니다.
  // 두 칸도 띠가 404px(= 2 × 198 + 8) 이상이면 넓은 칸 배치입니다(아래 시험 — 검토 뒤 덧붙임).
  it("넓은 칸 배치 자리 줄(pendingLinesWide) — 그 수 이상 순번의 덧 막대만 띠 404px 이상의 두 칸·세 칸(sm~lg)·띠 816px 이상의 네 칸에서 감추고, 앞 막대·읽어 주기·막대 수는 그대로 (QA-604)", () => {
    const market: KpiItem = { key: "sp500", label: "S&P 500", value: null, pending: true, pendingLines: 5, pendingLinesWide: 4 };
    const items = (n: number): KpiItem[] => [
      market,
      ...Array.from({ length: n - 1 }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: null, pending: true, pendingLines: 5 })),
    ];
    const { rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const tokens = (element: Element) => element.className.split(/\s+/);
    const extraBars = (name: string) => {
      const block = tile(name).querySelector('div[aria-hidden="true"].flex-col') as HTMLElement;
      return Array.from(block.children);
    };
    const WIDE_HIDE = ["max-sm:@min-[404px]:hidden", "sm:max-lg:hidden", "lg:max-xl:@min-[816px]:hidden"];
    // 읽어 주는 상태는 하나, DOM 막대 수(값 자리표시 1 + 덧 막대 5)는 그대로 — 감추는 것은 넓은 칸 배치의 CSS뿐입니다.
    expect(within(tile("S&P 500")).getAllByRole("status")).toHaveLength(1);
    expect(tile("S&P 500").querySelectorAll(".bg-control-fill")).toHaveLength(1 + 5);
    const bars = extraBars("S&P 500");
    expect(bars).toHaveLength(5);
    // 앞 네 막대는 어느 배치에서도 보입니다.
    for (const [index, bar] of bars.slice(0, 4).entries()) {
      expect(tokens(bar).filter((token) => token.endsWith(":hidden")), `${index}`).toEqual([]);
    }
    for (const token of [...WIDE_HIDE, "xl:@min-[816px]:@max-[986px]:hidden"]) {
      expect(tokens(bars[4]), token).toContain(token);
    }
    // pendingLinesWide를 주지 않은 타일은 감추는 막대가 없습니다.
    for (const bar of extraBars("값 0")) {
      expect(tokens(bar).filter((token) => token.endsWith(":hidden"))).toEqual([]);
    }
    // xl이면서 한 줄이 아닌 폭(띠 816px 이상 · 한 줄 경계 미만 — ONE_ROW_GRID와 같은 경계)에서도 감춥니다. 한 줄 경계가 816px 이하(타일 5개 이하)면
    // xl에서 띠 816px 이상은 늘 한 줄이라 xl 몫이 없고, 8개를 넘으면 한 줄 배치가 없어 띠 폭만 봅니다.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      rerender(<KpiStrip label="요약" items={items(n)} />);
      const last = tokens(extraBars("S&P 500")[4]);
      const boundary = n * 134 + (n - 1) * 8;
      const xl = n > 8 ? ["xl:@min-[816px]:hidden"] : boundary > 816 ? [`xl:@min-[816px]:@max-[${boundary}px]:hidden`] : [];
      expect(last.filter((token) => token.endsWith(":hidden")), `${n}`).toEqual([...WIDE_HIDE, ...xl]);
    }
  });

  // QA-604 후속(검토): 두 칸 배치(뷰포트 640 미만)도 띠가 넓으면 타일이 넓어 출처 줄이 덜 꺾입니다 — QA 스택 홈 시장 타일의 읽은 뒤 줄 높이는 띠 400px
  // (타일 196px)까지 QA 자료 170·187·187·새 자료 144·161·178px였다가 띠 401~402px(타일 196.5~197px)부터 154·171·171·128·145·162px로 낮아집니다
  // (네 칸이 띠 808→810px, 타일 196→196.5px에서 낮아지는 것과 같은 타일 폭). 그런데 고침은 두 칸을 모두 다섯 줄(200px)로 두어 440~639의 새 자료 CLS가
  // 0.115~0.163(440x956·540x720·600x1024 — 0.1 넘음)이었습니다. 또 넓은 칸 배치에서 다섯째(짧은) 막대를 감추면 보이는 마지막 막대(넷째)가 w-full이라
  // '마지막 줄을 짧게'(공용 Skeleton 규칙)가 그 배치에서만 사라졌습니다(768 홈 — 막대 다섯이 모두 전체 폭).
  // 수정 전(재현 커밋에서는 it.fails) 다섯째 덧 막대의 감추는 클래스는 ['sm:max-lg:hidden', 'lg:max-xl:@min-[816px]:hidden', 'xl:@min-[816px]:@max-[986px]:hidden']
  // (두 칸 몫 없음), 넷째 덧 막대에는 ':w-3/5'로 끝나는 클래스가 없었습니다(늘 w-full).
  it("두 칸 넓은 띠(404px 이상 = 타일 198px, 네 칸 816px과 같은 타일 폭)에서도 다섯째 막대를 감추고, 넓은 칸 배치마다 보이는 마지막 막대를 짧게 (QA-604)", () => {
    const market: KpiItem = { key: "sp500", label: "S&P 500", value: null, pending: true, pendingLines: 5, pendingLinesWide: 4 };
    const items = (n: number, first: KpiItem = market): KpiItem[] => [
      first,
      ...Array.from({ length: n - 1 }, (_, index) => ({ key: `k${index}`, label: `값 ${index}`, value: null, pending: true, pendingLines: 5 })),
    ];
    const { rerender } = render(<KpiStrip label="요약" items={items(7)} />);
    const tokens = (element: Element) => element.className.split(/\s+/);
    const extraBars = (name: string) => Array.from((tile(name).querySelector('div[aria-hidden="true"].flex-col') as HTMLElement).children);
    const variantShort = (element: Element) => tokens(element).filter((token) => token.endsWith(":w-3/5"));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      rerender(<KpiStrip label="요약" items={items(n)} />);
      const bars = extraBars("S&P 500");
      const hide = tokens(bars[4]).filter((token) => token.endsWith(":hidden"));
      // 두 칸 몫은 표의 맨 앞 — 뷰포트 640 미만이면서 띠 404px 이상(2 × 198 + 8)입니다.
      expect(hide[0], `${n}`).toBe("max-sm:@min-[404px]:hidden");
      // 넷째 막대는 다섯째를 감추는 바로 그 배치들에서만 짧습니다(같은 표에서 만듦 — 변형 하나하나가 짝).
      expect(variantShort(bars[3]), `${n}`).toEqual(hide.map((token) => token.replace(/:hidden$/, ":w-3/5")));
      expect(tokens(bars[3]), `${n}`).toContain("w-full");
      // 앞 세 막대는 어느 배치에서도 전체 폭, 다섯째는 지금처럼 늘 짧습니다(좁은 배치의 마지막 줄).
      for (const bar of bars.slice(0, 3)) {
        expect(variantShort(bar)).toEqual([]);
      }
      expect(tokens(bars[4])).toContain("w-3/5");
    }
    // pendingLinesWide를 주지 않은 타일은 감추는 막대도, 배치별로 짧아지는 막대도 없습니다.
    for (const bar of extraBars("값 0")) {
      expect(tokens(bar).filter((token) => token.endsWith(":hidden") || token.endsWith(":w-3/5"))).toEqual([]);
    }
    // 넓은 칸 배치에서 한 줄만 남으면 짧게 하지 않습니다(공용 Skeleton — 줄이 둘 이상일 때만 마지막을 짧게).
    rerender(<KpiStrip label="요약" items={items(7, { ...market, pendingLinesWide: 1 })} />);
    const one = extraBars("S&P 500");
    expect(variantShort(one[0])).toEqual([]);
    for (const bar of one.slice(1)) {
      expect(tokens(bar)).toContain("max-sm:@min-[404px]:hidden");
    }
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

  it("상태 글의 낭독 머리말(status.srPrefix)을 주면 톤 기본 머리말 대신 그 말 — 아이콘·톤 색은 그대로", () => {
    render(
      <KpiStrip
        label="요약"
        items={[{ key: "t10y3m", label: "10Y-3M", value: -0.62, status: { tone: "danger", text: "깊은 역전", srPrefix: "주의: " } }]}
      />,
    );
    const text = within(tile("10Y-3M")).getByText("깊은 역전");
    expect(text.parentElement?.className).toContain("text-danger");
    expect(text.parentElement?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(within(tile("10Y-3M")).getByText("주의:").className).toContain("sr-only");
    expect(within(tile("10Y-3M")).queryByText("오류:")).toBeNull();
  });

  it("상태 아이콘(status.icon 'alert')을 주면 위험 톤의 엑스 원 대신 경고 삼각형 — 주지 않으면 톤 기본 아이콘(엑스 원) 그대로", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "t10y3m", label: "10Y-3M", value: -0.62, status: { tone: "danger", text: "깊은 역전", srPrefix: "주의: ", icon: "alert" } },
          { key: "err", label: "수집 오류", value: 3, status: { tone: "danger", text: "오류 태스크 3개" } },
        ]}
      />,
    );
    const marketIcon = within(tile("10Y-3M")).getByText("깊은 역전").parentElement?.querySelector("svg[aria-hidden='true']");
    expect(marketIcon?.querySelector('path[d="M12 3.5 2.5 20h19z"]')).toBeTruthy();
    expect(marketIcon?.querySelector("circle")).toBeNull();
    expect(within(tile("10Y-3M")).getByText("깊은 역전").parentElement?.className).toContain("text-danger");
    const errorIcon = within(tile("수집 오류")).getByText("오류 태스크 3개").parentElement?.querySelector("svg[aria-hidden='true']");
    expect(errorIcon?.querySelector("circle")).toBeTruthy();
  });
});

describe("KpiStrip — 값 꼴에 맞춘 읽는 중 타일(pendingMatchesValue)", () => {
  it("주면 읽는 중 값 줄이 값 줄 높이(28·32px)이고 받은 출처 글을 그린다 — 주지 않으면 그대로(홈 띠: 자리 줄 수로 맞춤, 읽는 중 출처 줄 없음)", () => {
    const items = [{ key: "1w", label: "S&P 500 (SPY) 1W", value: null, pending: true, source: "Yahoo Finance ETF 일별 종가" }];
    const { container, unmount } = render(<KpiStrip label="띠" items={items} pendingMatchesValue />);
    const status = screen.getByRole("status", { name: "S&P 500 (SPY) 1W 불러오는 중" });
    expect((status.parentElement as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["mt-0.5", "min-h-7", "lg:min-h-8"]));
    expect(container.textContent).toContain("Yahoo Finance ETF 일별 종가");
    unmount();
    const plain = render(<KpiStrip label="띠" items={items} />);
    const plainStatus = screen.getByRole("status", { name: "S&P 500 (SPY) 1W 불러오는 중" });
    expect((plainStatus.parentElement as HTMLElement).className).toBe("mt-0.5");
    expect(plain.container.textContent).not.toContain("Yahoo Finance ETF 일별 종가");
  });

  // 공통 보유 화면 '교집합 기준 분기'는 응답의 기준 분기가 없으면(각 기관의 최신 분기) 판정 라벨 '각 기관 최신'이라, 값 줄이 라벨 글의 줄 높이(24·28px)로
  // 읽는 중 자리(28·32px)보다 4px 낮았음 — 390 두 칸 배치에서 그 타일이 혼자 둘째 줄이라 값이 오면 띠가 203 → 199px로 줄고 아래 패널이 4px 올라감(QA-724).
  // 수정 전 실패(plain it): 값 줄 클래스 ["mt-0.5", "flex", "items-baseline"] — min-h-7·lg:min-h-8 없음.
  it.fails("주면 값이 온 판정 라벨 타일(valueKind 'label')의 값 줄도 읽는 중 자리와 같은 28·32px(QA-724)", () => {
    const items: KpiItem[] = [{ key: "reportDate", label: "교집합 기준 분기", value: "각 기관 최신", valueKind: "label" }];
    render(<KpiStrip label="띠" items={items} pendingMatchesValue />);
    const row = valueText(tile("교집합 기준 분기"), "각 기관 최신").parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["mt-0.5", "flex", "items-baseline", "min-h-7", "lg:min-h-8"]));
  });

  it("주지 않은 띠의 판정 라벨 값 줄(홈·스코어카드)과 주어도 숫자 값 줄은 그대로 — 숫자 값 줄은 글 줄 높이가 이미 28·32px(QA-724 지킴)", () => {
    const label: KpiItem[] = [{ key: "regime", label: "국면", value: "후퇴 경계", valueKind: "label" }];
    const { unmount } = render(<KpiStrip label="띠" items={label} />);
    expect((valueText(tile("국면"), "후퇴 경계").parentElement as HTMLElement).className).toBe("mt-0.5 flex items-baseline");
    unmount();
    const numbers: KpiItem[] = [
      { key: "count", label: "교집합 종목", value: 12, format: (value) => String(value) },
      { key: "ret", label: "1W", value: 1.25, unit: "%" },
    ];
    render(<KpiStrip label="띠" items={numbers} pendingMatchesValue />);
    expect((valueText(tile("교집합 종목"), "12").parentElement as HTMLElement).className).toBe("mt-0.5 flex items-baseline");
    expect((valueText(tile("1W"), "1.25%").parentElement as HTMLElement).className).toBe("mt-0.5 -mr-3 flex items-baseline");
  });
});

describe("KpiStrip — 날짜 마디 묶음(keepDates)", () => {
  it("주면 출처 줄·보조 글의 날짜·시각 마디만 줄바꿈 없는 묶음(글 그대로), 주지 않으면 묶음 없음(홈 띠 그대로)", () => {
    const items = [{ key: "a", label: "심화", value: 1.2, note: "표본 2016-08-08 이후 2,560개 · 기준일 2026-11-03", source: "FRED", asOf: "2026-11-03" }];
    const { container, unmount } = render(<KpiStrip label="띠" items={items} keepDates />);
    expect(Array.from(container.querySelectorAll(".whitespace-nowrap")).map((span) => span.textContent)).toEqual(expect.arrayContaining(["2016-08-08", "2026-11-03"]));
    expect(within(tile("심화")).getByText(/표본/).textContent).toBe("표본 2016-08-08 이후 2,560개 · 기준일 2026-11-03");
    unmount();
    const plain = render(<KpiStrip label="띠" items={items} />);
    expect(Array.from(plain.container.querySelectorAll(".whitespace-nowrap")).some((span) => /\d{4}-\d{2}-\d{2}/.test(span.textContent ?? ""))).toBe(false);
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
    // (값 줄의 오른쪽 바깥 여백 −12px — QA-625, 예전에는 단위 글의 여백).
    for (const [tileNode, unit] of [[link, "%"], [group, "pt"]] as const) {
      const unitNode = within(tileNode).getByText(unit);
      const tail = unitNode.parentElement as HTMLElement;
      expect(tail.textContent, unit).toBe(`4${unit}`);
      expect(tail.className.split(/\s+/), unit).toContain("whitespace-nowrap");
      expect(tail.parentElement, unit).toBe(valueText(tileNode, `${LONG_VALUE}${unit}`));
      expect(unitNode.className.split(/\s+/), unit).toEqual(expect.arrayContaining(["ml-1", "font-normal"]));
      expect(((tail.parentElement as HTMLElement).parentElement as HTMLElement).className.split(/\s+/), unit).toContain("-mr-3");
    }
  });
});

// QA-637: 보조 글(note)은 타일의 wrap-anywhere만 물려받아 한글 낱말 가운데서 줄을 바꿨습니다 — 상관 화면 표본 수 타일 '두 지표가 모두 값을 가|진
// 날짜만 셉니다'(QA 스택 1440·1024). 공용 글 부품의 한글 줄바꿈 규약(QA-568 — 낱말 사이에서만, break-keep)을 KPI 띠 보조 글에도 둡니다. 공백 없는 긴
// 토큰은 그대로 타일 안에서 꺾입니다(타일의 wrap-anywhere).
describe("QA-637 KPI 띠 보조 글의 한글 줄바꿈", () => {
  it("보조 글은 낱말 사이에서만 줄을 바꾼다(break-keep) — 타일의 wrap-anywhere는 그대로", () => {
    render(<KpiStrip label="요약" items={[{ key: "n", label: "표본 수", value: 496, unit: "개", note: "두 지표가 모두 값을 가진 날짜만 셉니다." }]} />);
    const note = within(tile("표본 수")).getByText("두 지표가 모두 값을 가진 날짜만 셉니다.");
    expect(note.className.split(/\s+/)).toContain("break-keep");
    expect(tile("표본 수").className.split(/\s+/)).toContain("wrap-anywhere");
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

// QA-625: 단위의 여유(타일 안쪽 여백까지 걸침 — QA-599)를 단위 글의 오른쪽 바깥 음수 여백(−12px)으로 두면, 크롬은 값 글의 내용 폭을 그만큼 덜 재고
// 그 폭 안에 줄을 다시 놓다가 숫자 안에서 꺾었습니다 — 좁은 단위('pt'·'x')에서만(넓은 단위 '%p'·'%'·'원'은 그대로). 매크로 신용·변동성의
// '−0.58'+'pt'가 '−0.5' / '8 pt' 두 줄로 갈렸습니다(자기 빌드 390·412·1024 — 값 글 54x56px, 값 줄 136px에 자리가 남는데도). 여유를 값 줄(flex 행)의
// 오른쪽 음수 여백으로 옮기면 값 글 폭이 바르게 재여 한 줄(66x28px)이고, 값 글의 최대 폭(max-w-full = 값 줄)은 그대로 12px 넓어져 걸침도 같습니다.
// jsdom은 배치를 재지 않아 자리(클래스)로 봅니다.
describe("QA-625 짧은 단위의 값이 숫자 안에서 꺾이지 않는다", () => {
  it("단위의 여유(−12px)는 값 줄이 갖고 단위 글에는 바깥 음수 여백이 없다 — 단위 없는 값의 값 줄은 그대로", () => {
    render(
      <KpiStrip
        label="요약"
        items={[
          { key: "stlfsi", label: "금융스트레스", value: "−0.58", unit: "pt" },
          { key: "plain", label: "단위 없음", value: "12.5" },
        ]}
      />,
    );
    const unit = within(tile("금융스트레스")).getByText("pt");
    expect(unit.className.split(/\s+/).some((name) => /^-m[rx]-/.test(name))).toBe(false);
    const value = valueText(tile("금융스트레스"), "−0.58pt");
    expect((value.parentElement as HTMLElement).className.split(/\s+/)).toContain("-mr-3");
    const plainRow = valueText(tile("단위 없음"), "12.5").parentElement as HTMLElement;
    expect(plainRow.className.split(/\s+/)).toEqual(["mt-0.5", "flex", "items-baseline"]);
  });
});
