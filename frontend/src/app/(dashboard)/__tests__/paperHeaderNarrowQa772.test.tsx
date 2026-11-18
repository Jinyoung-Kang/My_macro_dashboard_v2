/**
 * QA-772 — 모의매매 머리(작업대 P6 PaperHeader)의 좁은 화면(lg 미만) 둘째 줄 결함 둘:
 *
 * 1. 계좌 고르기 칸이 `flex-1 min-w-0`이라 같은 줄의 동작 단추에 밀려 줄어들어, 보유·체결 탭(동작 둘 — '일시정지'·'계좌 초기화')에서 고른 계좌 이름이
 *    잘렸습니다(검토 자기 빌드 390: 상자 122px·글 영역 76px에 'Claude 계좌1 · 운용 중' 142px — 'Claude 계좌'까지만 보여 계좌1·계좌2를 가를 수 없음, 430도
 *    116px로 잘림). 기준 화면(패널 안 고르기 상자)은 189px로 다 보였습니다.
 * 2. DOM 차례가 계좌 → 한계·자세히 → 동작이고 좁은 화면만 CSS order로 한계 줄을 맨 끝으로 옮겨, Tab 차례(계좌 → 한계·자세히 → 동작)가 보이는 차례(계좌·동작 →
 *    한계·자세히)와 달랐습니다(WCAG 1.3.2·2.4.3).
 *
 * jsdom은 배치를 계산하지 않으므로 칸의 줄어듦 클래스와 DOM 차례로 봅니다(실제 폭은 자기 빌드 브라우저로 잼 — 진행 기록 P6 검토 반영).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaperHeader } from "@/components/screens/paper/PaperHeader";

afterEach(() => cleanup());

function renderHeader() {
  return render(
    <PaperHeader
      title="모의 매매"
      market="US"
      tab="holdings"
      description={<p>설명</p>}
      limits={{ lines: ["한계 한 줄"], source: "출처", book2Label: null }}
      refreshError={null}
      onAccountSlot={() => {}}
      onActionsSlot={() => {}}
    />,
  );
}

const slot = (name: "account" | "actions") => document.querySelector<HTMLElement>(`[data-paper-header-slot="${name}"]`) as HTMLElement;
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

describe("QA-772 — 머리 둘째 줄: 계좌 고르기는 줄어들지 않고, DOM 차례 = 보이는 차례", () => {
  it.fails("계좌 칸은 내용 폭 아래로 줄어들지 않는다(flex-1·min-w-0 없음 — 넘치면 동작이 다음 줄로), 줄 폭은 넘지 않음(max-w-full)", () => {
    renderHeader();
    const account = classes(slot("account"));
    expect(account).not.toContain("flex-1");
    expect(account).not.toContain("min-w-0");
    expect(account).toEqual(expect.arrayContaining(["shrink-0", "max-w-full"]));
  });

  it.fails("DOM 차례 — 계좌 칸 → 동작 칸 → 한계·자세히(좁은 화면의 보이는 차례), 좁은 화면 order 바꾸기 없음", () => {
    renderHeader();
    const details = screen.getByRole("button", { name: "자세히" });
    const following = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(following(slot("account"), slot("actions"))).toBe(true);
    expect(following(slot("actions"), details)).toBe(true);
    const row = details.parentElement as HTMLElement;
    expect(classes(row)).not.toContain("order-last");
  });
});
