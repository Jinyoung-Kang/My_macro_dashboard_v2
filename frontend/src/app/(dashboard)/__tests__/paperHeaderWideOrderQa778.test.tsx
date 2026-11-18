/**
 * QA-778 — 모의매매 머리(작업대 P6 PaperHeader)의 넓은 화면(lg 이상) Tab 차례 결함. QA-772 고침이 좁은 화면의 DOM 차례를 계좌 → 동작 → 한계·자세히로
 * 바꾸고 넓은 화면은 동작 칸만 `lg:order-last`로 오른쪽 끝에 옮겼습니다. 그래서 넓은 화면의 보이는 차례(계좌 → 한계 → 자세히 → 동작)와 Tab 차례(계좌 →
 * 동작 → 한계 → 자세히)가 달라졌습니다(P6 검토 반박 검증 자기 빌드 1024·1280·1440 — WCAG 2.4.3). 어느 폭에서도 CSS order로 차례를 바꾸지 않고, DOM
 * 차례가 곧 보이는 차례여야 합니다(제목 → 계좌 → 한계·자세히·신선도 → 동작 — 동작은 줄 끝).
 *
 * jsdom은 배치를 계산하지 않으므로 order 클래스와 DOM 차례로 봅니다(실제 배치는 QA 스택 브라우저로 잼 — 진행 기록 P6).
 */
import { cleanup, render } from "@testing-library/react";
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

describe("QA-778 — 머리의 DOM 차례가 어느 폭에서도 보이는 차례", () => {
  it("머리 안 어떤 요소도 CSS order로 차례를 바꾸지 않는다(접두 없는 order-*·lg:order-* 모두)", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header") as HTMLElement;
    const reordered = [header, ...header.querySelectorAll<HTMLElement>("*")]
      .flatMap((element) => (element.getAttribute("class") ?? "").split(/\s+/))
      .filter((name) => /(^|:)order-/.test(name));
    expect(reordered).toEqual([]);
  });

  it("DOM 차례 — 제목 → 계좌 칸 → 한계·자세히·신선도 → 동작 칸(줄 끝)", () => {
    const { container } = renderHeader();
    const account = container.querySelector('[data-paper-header-slot="account"]') as HTMLElement;
    const row = account.parentElement as HTMLElement;
    const order = [...row.children].map((child) =>
      child.getAttribute("data-paper-header-slot") ?? (child.querySelector("h1") ? "title" : child.querySelector("button") ? "meta" : "?"),
    );
    expect(order).toEqual(["title", "account", "meta", "actions"]);
  });
});
