/**
 * SplitPane — 칸 틀(작업대 실행 명세 §6, P4 — 상세 화면 셋의 왼쪽 속성 · 가운데 탭 · 오른쪽 연결·출처).
 * 틀 패턴이라 값 상태가 없습니다 — 네 상태는 칸 안 패턴(PropertyList·패널)이 맡고, 여기서는 칸이 비었을 때(빈 칸)·칸 안에 불러오는 중/오류 글이 와도
 * 자리와 차례가 그대로인지, 클래스가 정보 검색 틀(ENTITY_FRAME)과 같은지를 봅니다. jsdom은 배치를 계산하지 않으므로 클래스로만 봅니다(실제 폭은 D2 전 브라우저 확인).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ENTITY_FRAME, ENTITY_FRAME_LEFT } from "@/components/ui/classes";

import { SplitPane } from "../SplitPane";
import { Skeleton } from "../Skeleton";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("SplitPane", () => {
  it("뿌리는 lg 미만 한 칸(flex-col)·lg 이상 정보 검색과 같은 칸 틀(ENTITY_FRAME), 칸 사이 12·16px", () => {
    const { container } = render(
      <SplitPane left={<p>속성</p>} right={<p>연결</p>}>
        <p>탭</p>
      </SplitPane>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(tokens(root)).toEqual(expect.arrayContaining(["flex", "min-w-0", "flex-col", "gap-3", "lg:gap-4", ...ENTITY_FRAME.split(" ")]));
    expect(root.children).toHaveLength(3);
  });

  it("자식 차례는 왼쪽 → 가운데 → 오른쪽(읽는 차례·Tab 차례), 왼쪽 칸만 ENTITY_FRAME_LEFT(lg 두 줄)", () => {
    const { container } = render(
      <SplitPane left={<a href="#a">속성 링크</a>} right={<a href="#c">연결 링크</a>}>
        <a href="#b">탭 링크</a>
      </SplitPane>,
    );
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links).toEqual(["속성 링크", "탭 링크", "연결 링크"]);
    const [left, center, right] = [...(container.firstElementChild as HTMLElement).children];
    expect(tokens(left)).toEqual(expect.arrayContaining(["flex", "min-w-0", "flex-col", "gap-3", "lg:gap-4", ...ENTITY_FRAME_LEFT.split(" ")]));
    expect(tokens(center)).not.toContain("lg:row-span-2");
    expect(tokens(right)).not.toContain("lg:row-span-2");
    expect(tokens(center)).toEqual(expect.arrayContaining(["min-w-0", "flex-col"]));
  });

  it("새 랜드마크를 만들지 않는다 — 칸은 div", () => {
    const { container } = render(
      <SplitPane left={null} right={null}>
        {null}
      </SplitPane>,
    );
    expect(container.querySelectorAll("aside, section, nav, main, [role]")).toHaveLength(0);
    // 빈 칸도 자리는 그대로(세 칸)
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(3);
  });

  it("칸 안에 불러오는 중·오류 글이 와도 자리·차례가 그대로다", () => {
    render(
      <SplitPane left={<Skeleton lines={2} label="속성 불러오는 중" />} right={<p role="alert">연결을 불러오지 못했습니다.</p>}>
        <p>탭</p>
      </SplitPane>,
    );
    const status = screen.getByRole("status", { name: "속성 불러오는 중" });
    const alert = screen.getByRole("alert");
    expect(status.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("정보 검색 틀 글 그대로 — 공용 모듈(ui/classes)의 글을 바꾸면 정보 검색 겉모습이 바뀐다(entityGridPin.test가 같이 막음)", () => {
    expect(ENTITY_FRAME).toBe(
      "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:grid-rows-none",
    );
    expect(ENTITY_FRAME_LEFT).toBe("lg:row-span-2 xl:row-span-1");
  });
});
