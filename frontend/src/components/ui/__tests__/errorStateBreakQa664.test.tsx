/**
 * QA-664 검토 — 공용 오류 상자(ErrorState)의 메시지가 좁은 칸에서 한글 낱말 가운데서 줄을 바꿨습니다. QA-664 수정이 계열 목록 오류 상자를 상관 화면의
 * 15rem 왼쪽 칸(상자 폭 206px)에 처음 넣어 lg 이상 모든 폭에서 '지표 목록을 읽지 못했습|니다'로 꺾였습니다(자기 빌드 88f6288e, 목록만 503 흉내 —
 * 1024·1280·1440 모두 세 줄). 공용 글 부품 규약(QA-568 — 패널 부제·출처 줄·배지·상태 글 등)에서 빠진 자리입니다.
 *
 * 고친 뒤: 메시지가 낱말 사이에서만 줄을 바꾸고(break-keep — word-break: keep-all), 공백 없는 긴 토큰만 칸 안에서 꺾습니다(wrap-break-word —
 * overflow-wrap: break-word, 배지·출처 줄과 같음 — wrap-anywhere·break-all은 두지 않음). jsdom은 배치를 재지 못하므로 클래스를 대조하고, 실제 줄바꿈은
 * 브라우저 하네스로 잽니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ErrorState } from "@/components/ui";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 글 요소에서 상자(stop, 포함)까지 올라가며 cls가 있는지 — word-break·overflow-wrap은 상속되므로 조상 어디에 있어도 됩니다. */
function chainHas(element: Element, stop: Element, cls: string): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (tokens(node).includes(cls)) return true;
    if (node === stop) break;
  }
  return false;
}

describe("QA-664 검토 — 공용 오류 상자의 메시지는 한글 낱말 사이에서만 줄바꿈", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 메시지에서 상자까지 break-keep·wrap-break-word가 없었습니다(['break-keep', 'wrap-break-word'] 모두 빠짐).
  it("메시지 글에서 상자까지 break-keep과 wrap-break-word가 있고, wrap-anywhere·break-all은 없다", () => {
    const { container } = render(<ErrorState message="지표 목록을 읽지 못했습니다 — 요청 실패 (HTTP 503)" onRetry={() => {}} />);
    const box = container.firstElementChild as HTMLElement;
    const text = screen.getByText("지표 목록을 읽지 못했습니다 — 요청 실패 (HTTP 503)");

    expect(["break-keep", "wrap-break-word"].filter((cls) => !chainHas(text, box, cls))).toEqual([]);
    expect(["wrap-anywhere", "break-all"].filter((cls) => chainHas(text, box, cls))).toEqual([]);
    // 다시 시도 단추는 그대로 상자 안에 하나.
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
  });
});
