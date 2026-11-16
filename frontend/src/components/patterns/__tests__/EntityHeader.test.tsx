/**
 * EntityHeader — 대상 머리(작업대 실행 명세 §6, P4 — 상세 화면 셋의 맨 위).
 * 네 상태: 불러오는 중(placeholder Skeleton — 값·배지 자리만 바뀌고 이름·종류·동작은 그대로), 빈 값('—' + 사유, 단위 없음), 오류(placeholder 글),
 * 값 있음(28px tabular-nums·캡션·단위·변화). 데이터 패턴의 넷: 값·'—'·추정/대리 배지·이전 값(배지 줄은 늘 보임, 비면 접힘).
 * a11y: 이름은 h1(headingLevel 2면 h2), 종류는 아이콘(장식) + 글 태그, 식별자는 고정폭. 상세 셋 밖의 종류는 부르는 쪽이 글·아이콘을 넘기고(열린 꼴),
 * 변화는 KPI 띠와 같은 구조화된 꼴(변화 칩 + 캡션)도 받습니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PersonIcon } from "@/components/ui/icons";

import { EstimateBadge, StaleBadge } from "../badges";
import { ChangeChip } from "../ChangeChip";
import { EntityHeader } from "../EntityHeader";
import { Skeleton } from "../Skeleton";

afterEach(() => cleanup());

describe("EntityHeader — 값 있음", () => {
  it("이름은 h1(heading 20px, 말줄임 없이 낱말 사이 줄바꿈), 종류는 장식 아이콘 칸 + '종목' 태그, 식별자는 고정폭 태그, 보조 글", () => {
    const { container } = render(
      <EntityHeader kind="stock" name="Apple Inc." identifiers={["AAPL"]} description="NasdaqGS · 주식 · USD" />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Apple Inc." });
    expect(heading.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-heading", "text-text", "break-keep", "wrap-anywhere"]));
    expect(heading.className).not.toContain("truncate");
    expect(screen.getByText("종목")).toBeTruthy();
    const iconBox = container.querySelector("header > div > span") as HTMLElement;
    expect(iconBox.getAttribute("aria-hidden")).toBe("true");
    expect(iconBox.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("AAPL").className).toContain("font-mono");
    expect(screen.getByText("NasdaqGS · 주식 · USD").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-sm", "text-text-2"]));
  });

  it("종류마다 다른 글 — 지표·종목·기관", () => {
    const { rerender } = render(<EntityHeader kind="indicator" name="미국 10년물 금리" />);
    expect(screen.getByText("지표")).toBeTruthy();
    rerender(<EntityHeader kind="institution" name="Berkshire Hathaway" identifiers={["CIK 0001067983"]} />);
    expect(screen.getByText("기관")).toBeTruthy();
    expect(screen.getByText("CIK 0001067983").className).toContain("font-mono");
  });

  it("상세 셋 밖의 종류는 부르는 쪽이 글과 장식 아이콘을 넘긴다 — 패턴을 고치지 않고 종류를 더함", () => {
    const { container } = render(<EntityHeader kind={{ label: "인물", icon: PersonIcon }} name="합성 인물" headingLevel={2} />);
    expect(screen.getByText("인물")).toBeTruthy();
    const iconBox = container.querySelector("header span[aria-hidden='true']") as HTMLElement;
    expect(iconBox.querySelector("svg")).toBeTruthy();
  });

  it("변화는 구조화된 꼴(KPI 띠와 같음)도 받는다 — 변화 칩(▲▼ 장식·sr 방향·부호 −)과 12px 캡션, 둘 다 모르면 줄이 없다", () => {
    const { rerender } = render(
      <EntityHeader kind="indicator" name="S&P 500" value="7,622.99" change={{ change: -40.46, changePct: -0.53, digits: 2, pctDigits: 2, caption: "전일 대비" }} />,
    );
    expect(screen.getByText("▼").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("하락").className).toContain("sr-only");
    expect(screen.getByText("−40.46")).toBeTruthy();
    expect(screen.getByText("전일 대비").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3"]));
    rerender(<EntityHeader kind="indicator" name="S&P 500" value="7,622.99" change={{ change: null, changePct: null, caption: "전일 대비" }} />);
    expect(screen.queryByText("전일 대비")).toBeNull();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });

  it("headingLevel 2면 h2 — 화면 안의 머리", () => {
    render(<EntityHeader kind="stock" name="삼성전자" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "삼성전자" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("주 값은 28px(text-value-lg)·tabular-nums, 앞에 12px 캡션, 단위·변화는 옆에", () => {
    render(
      <EntityHeader
        kind="stock"
        name="Apple Inc."
        valueLabel="종가"
        value={228.5}
        format={(v) => v.toFixed(2)}
        unit="USD"
        change={<ChangeChip change={-1.2} changePct={-0.52} />}
      />,
    );
    const value = screen.getByText("228.50");
    expect(value.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-value-lg", "tabular-nums", "text-text"]));
    expect(screen.getByText("종가").className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3"]));
    expect(screen.getByText("USD").className).toContain("text-text-3");
    expect(screen.getByText("▼").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("하락").className).toContain("sr-only");
  });

  it("0은 값이다 — '—'가 아니다", () => {
    render(<EntityHeader kind="indicator" name="정책 금리 변화" value={0} unit="%p" />);
    expect(screen.getByText("0.00")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("value를 넘기지 않으면 값 줄이 없다", () => {
    const { container } = render(<EntityHeader kind="institution" name="Berkshire Hathaway" />);
    expect(container.querySelector(".text-value-lg")).toBeNull();
  });

  it("동작은 머리 안 오른쪽 영역(넓은 화면) — 링크·고르기를 그대로 둔다", () => {
    render(<EntityHeader kind="stock" name="Apple Inc." actions={<a href="/search?q=AAPL">정보 검색에서 보기</a>} />);
    const link = screen.getByRole("link", { name: "정보 검색에서 보기" });
    expect(link.closest("header")).toBeTruthy();
    expect((link.parentElement as HTMLElement).className).toContain("lg:justify-end");
  });

  it("값·태그·아이콘 칸에 강조 파랑(accent) 클래스가 없다", () => {
    const { container } = render(<EntityHeader kind="stock" name="Apple Inc." identifiers={["AAPL"]} value={1} />);
    const accent = [...container.querySelectorAll("[class]")].flatMap((element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter((token) => token.includes("accent")),
    );
    expect(accent).toEqual([]);
  });
});

describe("EntityHeader — 값 없음·추정·이전 값", () => {
  it("null·빈 글·'N/A'는 '—'(값 없음)와 사유, 단위는 붙이지 않는다", () => {
    const { rerender } = render(<EntityHeader kind="stock" name="Apple Inc." value={null} unit="USD" emptyReason="시세 없음" />);
    expect(screen.getByText("—").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("값 없음").className).toContain("sr-only");
    expect(screen.getByText("시세 없음")).toBeTruthy();
    expect(screen.queryByText("USD")).toBeNull();
    rerender(<EntityHeader kind="stock" name="Apple Inc." value="N/A" unit="USD" />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("USD")).toBeNull();
  });

  it("배지 줄(추정·이전 값)은 값 줄 아래에 늘 보이고, 그린 것이 없으면 접힌다(empty:hidden)", () => {
    const { container, rerender } = render(
      <EntityHeader
        kind="indicator"
        name="미국 10년물 금리"
        value={4.12}
        badges={
          <>
            <EstimateBadge estimated />
            <StaleBadge stale reason="수집 실패 — 11-14 값" />
          </>
        }
      />,
    );
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
    rerender(<EntityHeader kind="indicator" name="미국 10년물 금리" value={4.12} badges={<EstimateBadge />} />);
    const badgeRow = container.querySelector(".empty\\:hidden") as HTMLElement;
    expect(badgeRow.childElementCount).toBe(0);
  });
});

describe("EntityHeader — 불러오는 중·오류(placeholder)", () => {
  it("불러오는 중이면 값 줄·배지 자리만 Skeleton — 이름·종류·식별자·동작은 그대로이고 다시 마운트되지 않는다", () => {
    const { rerender } = render(
      <EntityHeader
        kind="stock"
        name="AAPL"
        identifiers={["AAPL"]}
        value={null}
        badges={<EstimateBadge estimated />}
        actions={<a href="/search">정보 검색에서 보기</a>}
        placeholder={<Skeleton lines={1} label="시세 불러오는 중" />}
      />,
    );
    expect(screen.getByRole("status", { name: "시세 불러오는 중" })).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText("추정")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1, name: "AAPL" });
    const link = screen.getByRole("link", { name: "정보 검색에서 보기" });
    rerender(
      <EntityHeader
        kind="stock"
        name="AAPL"
        identifiers={["AAPL"]}
        value={228.5}
        badges={<EstimateBadge estimated />}
        actions={<a href="/search">정보 검색에서 보기</a>}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("228.50")).toBeTruthy();
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "AAPL" })).toBe(heading);
    expect(screen.getByRole("link", { name: "정보 검색에서 보기" })).toBe(link);
  });

  it("오류면 값 자리에 오류 글 — 이름은 그대로", () => {
    const { container } = render(<EntityHeader kind="stock" name="AAPL" value={null} placeholder={<p role="alert">시세를 불러오지 못했습니다.</p>} />);
    expect(screen.getByRole("alert").textContent).toBe("시세를 불러오지 못했습니다.");
    expect(within(container.querySelector("header") as HTMLElement).getByRole("heading", { name: "AAPL" })).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });
});
