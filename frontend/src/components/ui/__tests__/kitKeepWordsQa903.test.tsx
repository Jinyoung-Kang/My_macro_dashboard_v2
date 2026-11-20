/**
 * 공용 글 부품의 한국어 줄바꿈 — QA-903(`callout-body-no-break-keep`(P8 S4)·P7 넘김 '공용 PageHeader 설명 break-keep'·'검사 칸 안내는 P8', 개편 전부터).
 *
 * 공용 안내 상자(Callout — 62개 파일 217곳) 본문, 화면 머리(PageHeader) 설명·'자세히' 글, 검사 칸(InspectorFrame) 안내 글에 break-keep이 없어 좁은 칸에서
 * 한글이 음절 사이에서 꺾였습니다(/cot 가격 대용 안내, 390 /correlation 머리 '…산점|도' 등 — 공용 글 부품 규약 QA-568 목록에서 빠진 자리).
 *
 * 기대: 글에서 부품 상자까지 break-keep(낱말 사이에서만 줄바꿈)과 wrap-break-word(공백 없는 긴 토큰만 칸 안에서 꺾음 — 배지·출처 줄·오류 상자와 같음)가
 * 있고, wrap-anywhere·break-all은 없습니다. jsdom은 배치를 재지 못하므로 클래스를 대조합니다(QA-664 시험과 같은 방법).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 세 사례 모두 "expected [ 'break-keep', 'wrap-break-word' ] to deeply equal []" 꼴.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InspectorFrame } from "@/components/patterns/InspectorFrame";
import { Callout, PageHeader } from "@/components/ui";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 글 요소에서 상자(stop, 포함)까지 올라가며 cls가 있는지 — word-break·overflow-wrap은 상속되므로 조상 어디에 있어도 됩니다. */
function chainHas(element: Element, stop: Element, cls: string): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (tokens(node).includes(cls)) return true;
    if (node === stop) break;
  }
  return false;
}
const missing = (text: Element, box: Element) => ["break-keep", "wrap-break-word"].filter((cls) => !chainHas(text, box, cls));
const forbidden = (text: Element, box: Element) => ["wrap-anywhere", "break-all"].filter((cls) => chainHas(text, box, cls));

describe("공용 글 부품의 한국어 줄바꿈(QA-903)", () => {
  it("안내 상자(Callout) 본문과 제목", () => {
    const { container } = render(
      <Callout tone="warn" title="가격 대용 안내">
        <p>선물 가격을 받지 못해 현물 지수를 대용으로 씁니다.</p>
      </Callout>,
    );
    const box = container.firstElementChild as HTMLElement;
    for (const text of [screen.getByText("가격 대용 안내"), screen.getByText("선물 가격을 받지 못해 현물 지수를 대용으로 씁니다.")]) {
      expect(missing(text, box)).toEqual([]);
      expect(forbidden(text, box)).toEqual([]);
    }
  });

  it("화면 머리(PageHeader) 설명과 '자세히' 글", () => {
    const { container } = render(<PageHeader title="상관" description="두 계열의 산점도와 이동 상관" details="상관계수는 인과를 뜻하지 않습니다." />);
    const box = container.firstElementChild as HTMLElement;
    for (const text of [screen.getByText("두 계열의 산점도와 이동 상관"), screen.getByText("상관계수는 인과를 뜻하지 않습니다.")]) {
      expect(missing(text, box)).toEqual([]);
      expect(forbidden(text, box)).toEqual([]);
    }
  });

  it("검사 칸(InspectorFrame) 안내 글", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    const { container } = render(
      <InspectorFrame label="합성 미리보기" titleOf={() => null} renderDetail={() => null} inspectorHint="줄을 고르면 여기에 자세한 값이 나옵니다.">
        {() => <p>목록</p>}
      </InspectorFrame>,
    );
    const text = screen.getByText("줄을 고르면 여기에 자세한 값이 나옵니다.");
    const box = container.firstElementChild as HTMLElement;
    expect(missing(text, box)).toEqual([]);
    expect(forbidden(text, box)).toEqual([]);
  });
});
