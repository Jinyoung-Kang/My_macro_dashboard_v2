/**
 * 패널(ui/index.tsx의 Panel — 옛 이름 Card)과 지표 칸(Metric) — 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-3·§3-7·§6.
 *  - 패널은 section, 제목은 h2 하나(앞 아이콘을 뗌), 머리줄(제목·개수·동작)은 아래 경계로 본문과 가르고 본문 안쪽은 12px(lg 16px)
 *  - 개수는 제목 옆 보조 글 — 제목(h2)의 이름에는 들지 않음
 *  - 제목·동작·출처가 없으면 머리줄을 그리지 않음, Card는 Panel과 같은 부품
 *  - region을 켜면 이름 있는 영역(section aria-labelledby → 제목 h2) — 겉모양(면·머리줄·개수·동작·본문 여백)은 켜지 않은 패널과 같음, 기본은 영역 아님
 *  - 지표 칸의 값은 KPI 크기(20px, lg 24px)와 tabular-nums
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Card, Panel } from "@/components/ui";

afterEach(() => cleanup());

describe("Panel", () => {
  it("section 안에 h2 제목·개수·보조 글·출처·동작이 머리줄에, 본문은 그 아래 따로 된 칸에", () => {
    render(
      <Panel title="보유 종목" count="12종목" subtitle="계좌1 기준" source="모의 장부" actions={<button type="button">새로고침</button>}>
        <p>본문</p>
      </Panel>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "보유 종목" });
    const section = heading.closest("section") as HTMLElement;
    const header = heading.closest("header") as HTMLElement;
    expect(within(header).getByText("12종목")).toBeTruthy();
    expect(within(header).getByText("계좌1 기준")).toBeTruthy();
    expect(within(header).getByText("모의 장부")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "새로고침" })).toBeTruthy();
    const body = screen.getByText("본문").parentElement as HTMLElement;
    expect(header.contains(body)).toBe(false);
    expect(section.contains(body)).toBe(true);
    // 겉모양: 4px·1px 경계·그림자 없음, 머리줄 아래 경계, 본문 안쪽 12px(lg 16px)
    expect(section.className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-card", "border", "bg-surface"]));
    expect(section.className).not.toContain("shadow");
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-b", "border-border"]));
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["p-3", "lg:p-4"]));
  });

  it("개수는 제목 이름에 들지 않고 tabular-nums 보조 글", () => {
    render(
      <Panel title="체결" count={3}>
        <p>본문</p>
      </Panel>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "체결" });
    const count = screen.getByText("3");
    expect(heading.contains(count)).toBe(false);
    expect(count.className.split(/\s+/)).toEqual(expect.arrayContaining(["tabular-nums", "text-text-3"]));
  });

  it("제목·동작·출처가 없으면 머리줄이 없다", () => {
    const { container } = render(
      <Panel>
        <p>본문만</p>
      </Panel>,
    );
    expect(container.querySelector("header")).toBeNull();
    expect(screen.getByText("본문만")).toBeTruthy();
  });

  // QA-494: 접힌 패널(모의매매 '이 장부의 한계' — children이 `{open && …}`라 false)도 본문 칸(p-3 lg:p-4)을 늘 그려, 머리 아래 1px 경계 밑에
  // 빈 띠(넓은 화면 32px·좁은 화면 24px)가 남았습니다. 본문이 비면(false·null·undefined) 머리만 있는 상자여야 합니다. 재현 커밋에서는 it.fails였습니다.
  it("QA-494: 본문이 비면(false·null) 본문 칸과 머리 아래 경계를 그리지 않는다 — 머리만 있는 상자", () => {
    for (const empty of [false, null]) {
      render(
        <Panel title="한계" actions={<button type="button">펼치기</button>}>
          {empty}
        </Panel>,
      );
      const heading = screen.getByRole("heading", { level: 2, name: "한계" });
      const section = heading.closest("section") as HTMLElement;
      const header = heading.closest("header") as HTMLElement;
      expect([...section.children], String(empty)).toEqual([header]);
      expect(header.className.split(/\s+/), String(empty)).not.toContain("border-b");
      cleanup();
    }
  });

  it("기본은 이름 없는 section — 낭독기 영역(region) 목록에 오르지 않는다", () => {
    render(
      <Panel title="보유 종목">
        <p>본문</p>
      </Panel>,
    );
    const section = screen.getByRole("heading", { level: 2, name: "보유 종목" }).closest("section") as HTMLElement;
    expect(section.hasAttribute("aria-labelledby")).toBe(false);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("region이면 이름 있는 영역 — 제목(h2)이 영역 이름, 개수는 이름에 들지 않는다", () => {
    render(
      <Panel region title="오늘의 국면" count="4개">
        본문
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "오늘의 국면" });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("오늘의 국면");
    expect(within(region).getByText("4개").className).toContain("tabular-nums");
    expect(within(region).getByText("본문")).toBeTruthy();
  });

  it("region을 켜도 겉모양(면·머리줄·제목·개수·동작·본문 여백)은 켜지 않은 패널과 같다 — 홈 구역·차트 패널이 공용 틀에서 갈라지지 않게", () => {
    const tokens = (element: Element) => element.className.split(/\s+/).filter(Boolean).sort();
    const frame = (section: HTMLElement) => {
      const header = section.querySelector(":scope > header") as HTMLElement;
      return {
        section: tokens(section),
        header: tokens(header),
        heading: (section.querySelector("h2") as HTMLElement).className,
        count: (header.querySelector("h2 + span") as HTMLElement).className,
        actions: (header.querySelector(":scope > div:last-child") as HTMLElement).className,
        body: (section.querySelector(":scope > div") as HTMLElement).className,
      };
    };
    const { container } = render(
      <>
        <Panel title="공용" count="3개" actions={<span>동작</span>}>
          본문
        </Panel>
        <Panel region title="영역" count="3개" actions={<span>동작</span>}>
          본문
        </Panel>
      </>,
    );
    const [plain, named] = Array.from(container.querySelectorAll("section")) as HTMLElement[];
    expect(frame(named)).toEqual(frame(plain));
    expect(named.getAttribute("aria-labelledby")).toBe((named.querySelector("h2") as HTMLElement).id);
  });

  it("Card는 Panel과 같은 부품(옛 이름)", () => {
    expect(Card).toBe(Panel);
  });
});
