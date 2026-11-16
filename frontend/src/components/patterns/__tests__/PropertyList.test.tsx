/**
 * PropertyList — 속성 목록(작업대 실행 명세 §6, P4 — 상세 화면 왼쪽 칸·검사 칸).
 * 네 상태: 불러오는 중(placeholder — Skeleton role=status), 빈 값(줄 없음 → emptyText, 값 없음 → '—' + 사유·단위 없음), 오류(placeholder 글), 값 있음
 * (0은 값, 단위는 값이 있을 때만, 고정폭 식별자, 긴 글 block). 데이터 패턴의 넷: 값·'—'·추정/대리 배지·이전 값 + 사유(늘 보임).
 * 겉모양: 값 칸은 말줄임하지 않음(truncate·whitespace-nowrap 없음 — QA-530 계열), 넓은 화면 줄 32·28px 여백, 제목이 있으면 이름 있는 영역.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PropertyList, type PropertyItem } from "../PropertyList";
import { Skeleton } from "../Skeleton";

afterEach(() => cleanup());

/** 이름(dt)이 label인 줄의 값 칸(dd). */
function valueOf(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.nextElementSibling as HTMLElement | null;
  if (!value || value.tagName !== "DD") throw new Error(`${label}의 값 칸이 없습니다`);
  return value;
}

describe("PropertyList — 값 있음", () => {
  it("이름(dt 13px 보조 글)·값(dd 14px tabular-nums, 오른쪽 정렬) 두 칸 줄, 0은 값이고 단위는 값 옆에", () => {
    const items: PropertyItem[] = [
      { label: "시가총액", value: "3.2조 달러" },
      { label: "배당수익률", value: 0, unit: "%" },
      { label: "PER", value: 28.456, format: (v) => v.toFixed(1), unit: "배" },
    ];
    const { container } = render(<PropertyList items={items} />);
    expect(container.querySelectorAll("dl > div")).toHaveLength(3);
    const term = screen.getByText("시가총액", { selector: "dt" });
    expect(term.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-caption", "text-text-2"]));
    // 이름 칸은 값이 길어도 눌리지 않는다(줄 폭의 절반까지, 낱말 사이 줄바꿈)
    expect(term.className.split(/\s+/)).toEqual(expect.arrayContaining(["shrink-0", "max-w-[50%]", "break-keep", "wrap-anywhere"]));
    const cap = valueOf("시가총액");
    expect(cap.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-right", "text-body", "text-text", "tabular-nums", "break-keep", "wrap-anywhere"]));
    expect(within(cap).getByText("3.2조 달러")).toBeTruthy();

    const dividend = valueOf("배당수익률");
    expect(within(dividend).getByText("0.00")).toBeTruthy();
    expect(within(dividend).getByText("%")).toBeTruthy();
    expect(within(dividend).queryByText("—")).toBeNull();

    const per = valueOf("PER");
    expect(within(per).getByText("28.5")).toBeTruthy();
    expect(within(per).getByText("배").className).toContain("text-text-3");
  });

  it("식별자는 고정폭(font-mono), 긴 글(block)은 이름 위·값 아래 왼쪽 정렬, 보조 글(note)은 값 아래 12px", () => {
    render(
      <PropertyList
        items={[
          { label: "CIK", value: "0001067983", mono: true },
          { label: "소개", value: "버크셔 해서웨이는 보험·철도·에너지 사업을 거느린 지주회사입니다.", block: true },
          { label: "보유 종목 수", value: "42종목", note: "2026-09-30 보고" },
        ]}
      />,
    );
    expect(within(valueOf("CIK")).getByText("0001067983").className).toContain("font-mono");
    const about = valueOf("소개");
    expect(about.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-left", "leading-relaxed"]));
    expect(about.className).not.toContain("text-right");
    expect((about.parentElement as HTMLElement).className.split(/\s+/)).toContain("flex-col");
    const note = within(valueOf("보유 종목 수")).getByText("2026-09-30 보고");
    expect(note.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-text-3"]));
  });

  it("값 칸 어디에도 말줄임(truncate·whitespace-nowrap)이 없다 — 긴 영문 업종도 칸 안에서 줄을 바꾼다", () => {
    const { container } = render(
      <PropertyList
        items={[
          { label: "업종", value: "Semiconductor Equipment & Materials" },
          { label: "누리집", value: "https://www.example.com/investor-relations/annual-report", mono: true },
        ]}
      />,
    );
    for (const element of container.querySelectorAll("dd, dd *")) {
      const tokens = (element.getAttribute("class") ?? "").split(/\s+/);
      expect(tokens, element.outerHTML).not.toContain("truncate");
      expect(tokens, element.outerHTML).not.toContain("whitespace-nowrap");
      expect(tokens, element.outerHTML).not.toContain("text-ellipsis");
    }
  });

  // QA-570: 이름 칸(dt)이 max-w-[50%] shrink-0이라 값이 짧아 자리가 남아도 13rem 왼쪽 칸(줄 174px)에서 이름이 87px에서 꺾였습니다
  // ('PER(최근 / 4분기)' — 값 '33.71배' 49px, 줄 32 → 50px). 기관 상세 '13F 보고 평가액'은 이름에 밀려 값까지 '1,551억 / 달러'로 갈렸습니다.
  // 고친 뒤: 줄은 auto 두 트랙 그리드(양 끝 정렬) — 둘 다 들어가면 자연 폭, 모자라면 남는 폭을 두 칸에 고르게 나눠 짧은 쪽이 다 들어가고 나머지를
  // 긴 쪽이 씁니다(둘 다 길면 거의 반씩 — 이름도 값도 절반 밑으로 눌리지 않음). 아주 긴 낱말만 칸 안에서 꺾습니다(min-w-0 wrap-anywhere).
  // 수정 전 실패: 줄이 flex이고 이름 칸이 max-w-[50%] shrink-0(재현 커밋에서는 it.fails).
  it.fails("값이 짧으면 이름이 남은 폭을 쓴다 — 줄은 auto 두 트랙 그리드, 이름 칸에 절반 상한·shrink-0이 없다(긴 글 block 줄은 그대로 세로)", () => {
    render(
      <PropertyList
        items={[
          { label: "PER(최근 4분기)", value: "33.71배" },
          { label: "소개", value: "합성 기관 소개 글입니다.", block: true },
        ]}
      />,
    );
    const term = screen.getByText("PER(최근 4분기)", { selector: "dt" });
    const row = (term.parentElement as HTMLElement).className.split(/\s+/);
    expect(row).toEqual(expect.arrayContaining(["grid", "grid-cols-[auto_auto]", "items-baseline", "justify-between", "gap-x-3", "min-w-0"]));
    expect(row).not.toContain("flex");
    const termClasses = term.className.split(/\s+/);
    expect(termClasses).toEqual(expect.arrayContaining(["min-w-0", "break-keep", "wrap-anywhere"]));
    expect(termClasses).not.toContain("max-w-[50%]");
    expect(termClasses).not.toContain("shrink-0");
    const block = (screen.getByText("소개", { selector: "dt" }).parentElement as HTMLElement).className.split(/\s+/);
    expect(block).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-0.5"]));
    expect(block).not.toContain("grid");
  });

  it("넓은 화면 줄 높이는 32px(기본)·28px(dense) 여백 — 아래 구분선 1px을 높이 안에 넣고 마지막 줄은 위아래 같게, 옅은 경계", () => {
    const { container, rerender } = render(<PropertyList items={[{ label: "가", value: "1" }, { label: "나", value: "2" }]} />);
    const row = () => container.querySelector("dl > div") as HTMLElement;
    expect(row().className.split(/\s+/)).toEqual(
      expect.arrayContaining(["border-b", "border-border-subtle", "last:border-0", "lg:pt-1.5", "lg:pb-[5px]", "lg:last:pb-1.5"]),
    );
    rerender(<PropertyList dense items={[{ label: "가", value: "1" }, { label: "나", value: "2" }]} />);
    expect(row().className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:pt-1", "lg:pb-[3px]", "lg:last:pb-1"]));
  });

  it("목록 출처는 '출처 · …' 줄, 줄 출처는 그 값 아래 출처 캡션", () => {
    render(
      <PropertyList
        source="SEC EDGAR 13F"
        items={[{ label: "평가액", value: "2,671억 달러", source: "SEC 13F-HR" }]}
      />,
    );
    expect(screen.getByText("SEC EDGAR 13F").textContent).toBe("출처 · SEC EDGAR 13F");
    expect(within(valueOf("평가액")).getByText(/SEC 13F-HR/)).toBeTruthy();
  });

  it("제목을 주면 그 이름의 영역(section)과 제목 — 기본 h3, headingLevel 2면 h2", () => {
    const { rerender } = render(<PropertyList title="회사 개요" items={[{ label: "업종", value: "반도체" }]} />);
    const region = screen.getByRole("region", { name: "회사 개요" });
    expect(within(region).getByRole("heading", { level: 3, name: "회사 개요" })).toBeTruthy();
    rerender(<PropertyList title="회사 개요" headingLevel={2} items={[{ label: "업종", value: "반도체" }]} />);
    const heading = screen.getByRole("heading", { level: 2, name: "회사 개요" });
    expect(heading.className).toContain("text-heading-sm");
  });

  it("제목이 없으면 영역을 만들지 않는다(보통 Panel 안)", () => {
    render(<PropertyList items={[{ label: "업종", value: "반도체" }]} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("PropertyList — 값 없음·빈 목록", () => {
  it("null·undefined·빈 글·'N/A'·NaN은 '—'(값 없음)와 사유, 단위는 붙이지 않는다", () => {
    render(
      <PropertyList
        items={[
          { label: "PER", value: null, unit: "배", emptyReason: "적자" },
          { label: "PBR", value: undefined, unit: "배" },
          { label: "업종", value: "" },
          { label: "배당", value: "N/A", unit: "%" },
          { label: "베타", value: Number.NaN },
        ]}
      />,
    );
    for (const label of ["PER", "PBR", "업종", "배당", "베타"]) {
      const value = valueOf(label);
      expect(within(value).getByText("—").getAttribute("aria-hidden"), label).toBe("true");
      expect(within(value).getByText("값 없음").className, label).toContain("sr-only");
      expect(within(value).queryByText("배"), label).toBeNull();
      expect(within(value).queryByText("%"), label).toBeNull();
    }
    expect(within(valueOf("PER")).getByText("적자")).toBeTruthy();
    expect(valueOf("PER").querySelector(".text-text-3")).toBeTruthy();
  });

  it("줄이 없으면 emptyText(기본 '표시할 속성이 없습니다.')", () => {
    const { rerender } = render(<PropertyList items={[]} />);
    expect(screen.getByText("표시할 속성이 없습니다.")).toBeTruthy();
    expect(document.querySelector("dl")).toBeNull();
    rerender(<PropertyList items={[]} emptyText="보유 종목이 없습니다." />);
    expect(screen.getByText("보유 종목이 없습니다.")).toBeTruthy();
  });
});

describe("PropertyList — 추정·대리·이전 값", () => {
  it("추정·대리 배지와 이전 값 배지(+ 사유)가 값 옆에 늘 보인다 — 값을 몰라도", () => {
    render(
      <PropertyList
        items={[
          { label: "적정가", value: "182달러", isEstimated: true },
          { label: "기관 순매수", value: "1.2억 달러", isProxy: true },
          { label: "시가총액", value: "3.2조 달러", isStale: true, staleReason: "수집 실패 — 11-14 값" },
          { label: "배당", value: null, isStale: true },
        ]}
      />,
    );
    expect(within(valueOf("적정가")).getByText("추정")).toBeTruthy();
    expect(within(valueOf("기관 순매수")).getByText("대리 지표")).toBeTruthy();
    const stale = valueOf("시가총액");
    expect(within(stale).getByText("이전 값")).toBeTruthy();
    expect(within(stale).getByText("· 수집 실패 — 11-14 값")).toBeTruthy();
    expect(within(valueOf("배당")).getByText("이전 값")).toBeTruthy();
    expect(within(valueOf("배당")).getByText("—")).toBeTruthy();
  });
});

describe("PropertyList — 불러오는 중·오류(placeholder)", () => {
  it("불러오는 중이면 줄 대신 Skeleton(role=status) — 제목은 그대로", () => {
    render(<PropertyList title="회사 개요" items={[{ label: "업종", value: "반도체" }]} placeholder={<Skeleton lines={3} label="회사 개요 불러오는 중" />} />);
    expect(screen.getByRole("region", { name: "회사 개요" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "회사 개요 불러오는 중" })).toBeTruthy();
    expect(screen.queryByText("업종")).toBeNull();
  });

  it("오류면 줄 대신 오류 글", () => {
    render(<PropertyList items={[]} placeholder={<p role="alert">회사 개요를 불러오지 못했습니다.</p>} />);
    expect(screen.getByRole("alert").textContent).toBe("회사 개요를 불러오지 못했습니다.");
    expect(screen.queryByText("표시할 속성이 없습니다.")).toBeNull();
  });
});
