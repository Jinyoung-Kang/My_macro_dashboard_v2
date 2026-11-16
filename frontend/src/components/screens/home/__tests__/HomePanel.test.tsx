/**
 * 홈 패널 틀(HomePanel) — 공용 Panel과 같은 모양(면·머리줄·개수·동작·본문 여백)에 이름 있는 영역 하나만 더한 것인지 대조합니다.
 * 공용 Panel의 머리·본문 클래스가 바뀌면 이 시험이 깨져 홈 틀도 함께 고치게 합니다(두 곳이 조용히 갈라지지 않게).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel } from "@/components/ui";
import { HomePanel } from "../HomeCard";

afterEach(() => cleanup());

/** 클래스 낱말(순서·빈칸 무시). */
const tokens = (element: Element) => element.className.split(/\s+/).filter(Boolean).sort();

function frame(section: HTMLElement) {
  const header = section.querySelector(":scope > header") as HTMLElement;
  return {
    section: tokens(section).filter((token) => token !== "min-w-0"),
    header: tokens(header),
    heading: (section.querySelector("h2") as HTMLElement).className,
    count: (header.querySelector("h2 + span") as HTMLElement).className,
    actions: (header.querySelector(":scope > div:last-child") as HTMLElement).className,
    body: (section.querySelector(":scope > div") as HTMLElement).className,
  };
}

describe("홈 패널 틀", () => {
  it("머리줄(제목·개수·동작)·본문 여백·면이 공용 Panel과 같다", () => {
    const { container } = render(
      <>
        <Panel title="공용" count="3개" actions={<span>동작</span>}>
          본문
        </Panel>
        <HomePanel title="홈" count="3개" actions={<span>동작</span>}>
          본문
        </HomePanel>
      </>,
    );
    const [shared, home] = Array.from(container.querySelectorAll("section")) as HTMLElement[];
    expect(frame(home)).toEqual(frame(shared));
  });

  it("이름 있는 영역 — 제목(h2)이 영역 이름, 개수는 이름에 들지 않는다", () => {
    render(
      <HomePanel title="오늘의 국면" count="4개">
        본문
      </HomePanel>,
    );
    const region = screen.getByRole("region", { name: "오늘의 국면" });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("오늘의 국면");
    expect(within(region).getByText("4개").className).toContain("tabular-nums");
    expect(within(region).getByText("본문")).toBeTruthy();
  });
});
