/**
 * SplitPane — 칸 틀(작업대 실행 명세 §6, P4 — 상세 화면 셋의 왼쪽 속성 · 가운데 탭 · 오른쪽 연결·출처).
 * 틀 패턴이라 값 상태가 없습니다 — 네 상태는 칸 안 패턴(PropertyList·패널)이 맡고, 여기서는 칸이 비었을 때(빈 칸)·칸 안에 불러오는 중/오류 글이 와도
 * 자리와 차례가 그대로인지, 클래스가 정보 검색 틀(ENTITY_FRAME)과 같은지를 봅니다. jsdom은 배치를 계산하지 않으므로 클래스로만 봅니다(실제 폭은 D2 전 브라우저 확인).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("leftWidth='wide'는 왼쪽 칸만 15rem(나머지 틀은 같음), 주지 않으면 정보 검색 틀 그대로", () => {
    const { container, unmount } = render(
      <SplitPane leftWidth="wide" left={<p>왼쪽</p>} right={<p>오른쪽</p>}>
        <p>가운데</p>
      </SplitPane>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(tokens(root)).toEqual(
      expect.arrayContaining(["lg:grid", "lg:grid-cols-[15rem_minmax(0,1fr)]", "lg:grid-rows-[auto_1fr]", "xl:grid-cols-[15rem_minmax(0,1fr)_18rem]", "xl:grid-rows-none"]),
    );
    expect(tokens(root)).not.toContain("lg:grid-cols-[13rem_minmax(0,1fr)]");
    unmount();
    const plain = render(
      <SplitPane left={<p>왼쪽</p>} right={<p>오른쪽</p>}>
        <p>가운데</p>
      </SplitPane>,
    );
    expect(tokens(plain.container.firstElementChild as HTMLElement)).toEqual(expect.arrayContaining(ENTITY_FRAME.split(" ")));
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

  // 2026-11-16 결정 2 — 좁은 화면(lg 미만)에서 왼쪽 속성 칸이 탭·차트를 첫 화면 밖으로 밀어(390 종목 상세 탭 줄 y≈1,490) 왼쪽 칸을 접는 옵션을 둡니다.
  describe("collapseLeft — lg 미만에서 왼쪽 칸을 접는 단추", () => {
    it("처음에는 접힘: 단추(44px·lg 이상 숨김)가 왼쪽 칸 앞에 있고 aria-expanded=false·aria-controls가 왼쪽 칸, 왼쪽 칸은 lg 미만에서만 숨김", () => {
      const { container } = render(
        <SplitPane collapseLeft="핵심 지표·회사 개요" left={<a href="#a">속성 링크</a>} right={<a href="#c">연결 링크</a>}>
          <a href="#b">탭 링크</a>
        </SplitPane>,
      );
      const root = container.firstElementChild as HTMLElement;
      // 단추 → 왼쪽 → 가운데 → 오른쪽 — 넓은 화면에서 단추는 display:none이라 격자 칸을 차지하지 않음
      expect(root.children).toHaveLength(4);
      const button = screen.getByRole("button", { name: "핵심 지표·회사 개요 펼치기" });
      expect(root.firstElementChild).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(tokens(button)).toEqual(expect.arrayContaining(["min-h-11", "w-full", "lg:hidden"]));
      const left = root.children[1] as HTMLElement;
      expect(button.getAttribute("aria-controls")).toBe(left.id);
      expect(left.id).not.toBe("");
      expect(tokens(left)).toEqual(expect.arrayContaining([...ENTITY_FRAME_LEFT.split(" "), "max-lg:hidden"]));
      // lg 이상에서 늘 보이도록 숨김은 lg 미만 변형만(맨 hidden·lg:hidden 없음)
      expect(tokens(left)).not.toContain("hidden");
      expect(tokens(left)).not.toContain("lg:hidden");
      // 접어도 마운트된 채(요청 시점 그대로) — DOM 차례도 단추 → 왼쪽 → 가운데 → 오른쪽
      const links = [...root.querySelectorAll("a")].map((link) => link.textContent);
      expect(links).toEqual(["속성 링크", "탭 링크", "연결 링크"]);
    });

    it("누르면 펼침(글 '… 접기'·aria-expanded=true·숨김 클래스 없음), 다시 누르면 접힘", () => {
      const { container } = render(
        <SplitPane collapseLeft="속성" left={<p>속성 본문</p>} right={null}>
          <p>탭</p>
        </SplitPane>,
      );
      const left = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;
      fireEvent.click(screen.getByRole("button", { name: "속성 펼치기" }));
      const button = screen.getByRole("button", { name: "속성 접기" });
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(tokens(left)).not.toContain("max-lg:hidden");
      expect(screen.getByText("속성 본문")).toBeTruthy();
      fireEvent.click(button);
      expect(screen.getByRole("button", { name: "속성 펼치기" }).getAttribute("aria-expanded")).toBe("false");
      expect(tokens(left)).toContain("max-lg:hidden");
    });

    it("주지 않으면 지금 그대로 — 단추 없음·세 칸·숨김 클래스 없음", () => {
      const { container } = render(
        <SplitPane left={<p>속성</p>} right={<p>연결</p>}>
          <p>탭</p>
        </SplitPane>,
      );
      expect(screen.queryByRole("button")).toBeNull();
      const root = container.firstElementChild as HTMLElement;
      expect(root.children).toHaveLength(3);
      expect(tokens(root.children[0])).not.toContain("max-lg:hidden");
      expect(root.children[0].hasAttribute("id")).toBe(false);
    });
  });
});
