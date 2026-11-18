/**
 * ReadingGuide — '읽는 법' 접기(작업대 실행 명세 §1 '긴 설명 문단은 접기로', P5b /style에서 만들어 P6에서 공용 패턴으로 옮김).
 *
 *  - 처음에는 접혀 있다(details — 글은 DOM에 있지만 그려지지 않음), 머리를 누르면 펼친다
 *  - 머리의 보이는 글은 '읽는 법'이고, 무엇의 읽는 법인지(topic)는 낭독기 전용 글로 이름 뒤에 붙는다(보이는 글이 이름의 앞 — WCAG 2.5.3)
 *  - 머리는 좁은 화면(lg 미만) 44px 누름 자리(공용 TEXT_TARGET)·포커스 링, 화살표 아이콘은 장식
 *  - 본문 글은 72자 폭 안 12px 보조 글
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FOCUS_RING, TEXT_TARGET } from "@/components/ui";

import { ReadingGuide } from "../ReadingGuide";

afterEach(() => cleanup());

function renderGuide() {
  const { container } = render(<ReadingGuide topic="겹침 비중·코사인">두 기관 비중의 겹침과 코사인 유사도를 함께 봅니다.</ReadingGuide>);
  const details = container.querySelector("details") as HTMLDetailsElement;
  const summary = details.querySelector("summary") as HTMLElement;
  return { details, summary };
}

describe("ReadingGuide", () => {
  it("처음에는 접혀 있고, 머리를 누르면 펼친다 — 글은 접힌 동안에도 DOM에 있다", () => {
    const { details, summary } = renderGuide();
    expect(details.open).toBe(false);
    expect(screen.getByText("두 기관 비중의 겹침과 코사인 유사도를 함께 봅니다.")).toBeTruthy();
    fireEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it("머리 글은 '읽는 법'이 앞이고 topic은 낭독기 전용 글로 뒤에 붙는다 — 화살표는 장식", () => {
    const { summary } = renderGuide();
    expect(summary.textContent).toBe("읽는 법 — 겹침 비중·코사인");
    const hidden = summary.querySelector(".sr-only");
    expect(hidden?.textContent).toBe(" — 겹침 비중·코사인");
    expect(summary.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("머리는 좁은 화면 44px 누름 자리(TEXT_TARGET)·포커스 링, 본문은 72자 폭 12px 보조 글", () => {
    const { details, summary } = renderGuide();
    const classes = summary.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining([...TEXT_TARGET.split(" "), ...FOCUS_RING.split(" "), "list-none", "cursor-pointer"]));
    const body = details.querySelector("p") as HTMLElement;
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-[72ch]", "text-xs", "text-text-3"]));
  });
});
