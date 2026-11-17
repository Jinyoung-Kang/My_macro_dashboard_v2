/**
 * 금리차 카드의 "변화" 칸 — 한쪽 값을 모르면 변화도 모른다("—")로 보여야 합니다.
 *
 * 예전 조건(`latest !== null && previous !== null`)은 값이 **없는 필드(undefined)** 를 통과시키고
 * `?? 0`으로 메워, 직전 값을 모르는데도 "+0.500%p"처럼 사실 같은 변화를 그렸습니다.
 * 지금 백엔드는 모르는 값을 null로 보내 드러나지 않았지만, 필드가 빠지면(버전 차이 등) 그대로 나옵니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpreadSection } from "../macro/SpreadSection";
import type { SpreadBlock } from "@/lib/types";

afterEach(() => cleanup());

const block = (fields: Partial<SpreadBlock>) =>
  ({ longId: "DGS10", shortId: "DGS2", points: [], ...fields }) as SpreadBlock;

/** 공식 확정치 KPI 띠(이름 있는 영역) — 값 타일·직전 확정치 타일. */
const official = () => screen.getByRole("region", { name: "10Y−2Y 공식 확정치" });
const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("SpreadSection 변화 칸", () => {
  it("직전 값이 없으면 변화를 계산하지 않는다(0으로 메우지 않음)", () => {
    render(<SpreadSection title="10Y−2Y" block={block({ latest: 0.5 })} />);
    // 현재값 타일에만 "+0.500%p"가 있어야 합니다. 변화 칩이 있으면(같은 글자든 다른 글자든) 0을 빼서 만든 값입니다.
    const text = official().textContent ?? "";
    expect(occurrences(text, "+0.500%p")).toBe(1);
    expect(within(official()).queryByText(/^(상승|하락|변화 없음)$/)).toBeNull();
  });

  it("현재 값이 없으면 변화를 계산하지 않는다", () => {
    render(<SpreadSection title="10Y−2Y" block={block({ previous: 0.2 })} />);
    expect(within(official()).queryByText(/^(상승|하락|변화 없음)$/)).toBeNull();
    expect(official().textContent).not.toContain("−0.200%p");
  });

  it("둘 다 있으면 차이를 보여 준다", () => {
    render(<SpreadSection title="10Y−2Y" block={block({ latest: 0.5, previous: 0.2 })} />);
    const text = official().textContent ?? "";
    expect(text).toContain("▲");
    expect(text).toContain("+0.300%p");
    expect(within(official()).getByText("상승").className).toContain("sr-only");
  });
});

describe("SpreadSection 스크래핑 패널 (QA-060)", () => {
  it("이전(이어받은) 금리로 계산한 스프레드는 '이전 값'으로 표시한다", () => {
    const scraped = {
      longValue: 4.1, shortValue: 3.6, spread: 0.5, previousSpread: 0.45, delta: 0.05, isStale: true,
    };
    render(<SpreadSection title="10Y−2Y" block={block({ latest: 0.5, scraped })} />);
    // 스프레드 타일의 '이전 값' 배지(띠 안) — 세 값 모두에 거는 묶음 머리 상태 글은 아래 QA-644.
    const strip = screen.getByRole("region", { name: "10Y−2Y 스크래핑 참고 시세" });
    expect(within(within(strip).getByRole("group", { name: "10Y−2Y 스프레드" })).getAllByText(/이전 값/).length).toBeGreaterThan(0);
  });
});

// QA-644: 스크래핑 금리차의 '이전 값'(scraped.isStale — 수집 실패로 이어받은 이전 금리가 섞임)은 스프레드·장기·단기 세 값 모두에 걸리는데, P5a에서
// KPI 띠로 옮기며 표시가 스프레드 타일 배지 하나로 줄었습니다 — 이전 금리일 수 있는 장·단기 타일에는 아무 표시가 없어 지금 시세처럼 보였습니다(예전 화면은
// 묶음 머리의 '이전 값 포함(수집 실패)' 상태 글로 셋 모두에 걸었음, P5a 검토). 위 QA-060 시험은 '이전 값' 글이 어딘가에 있는지만 봐서 잡지 못했습니다.
describe("QA-644 스크래핑 묶음의 이전 값 표시는 세 값 모두에 걸린다", () => {
  it("isStale이면 스크래핑 묶음 머리(띠 밖)에 '이전 값 포함(수집 실패)' 상태 글 — 경고 아이콘 + 글", () => {
    const scraped = { longValue: 4.1, shortValue: 3.6, spread: 0.5, previousSpread: 0.45, delta: 0.05, isStale: true };
    render(<SpreadSection title="10Y−2Y" block={block({ latest: 0.5, scraped })} />);
    const strip = screen.getByRole("region", { name: "10Y−2Y 스크래핑 참고 시세" });
    const group = strip.parentElement as HTMLElement;
    const status = within(group).getByText(/이전 값 포함\(수집 실패\)/);
    expect(strip.contains(status)).toBe(false);
    expect(status.closest("[class*='text-warn']")).not.toBeNull();
  });

  it("이전 값이 아니면 묶음 머리의 상태 글이 없다", () => {
    const scraped = { longValue: 4.1, shortValue: 3.6, spread: 0.5, previousSpread: 0.45, delta: 0.05 };
    render(<SpreadSection title="10Y−2Y" block={block({ latest: 0.5, scraped })} />);
    expect(screen.queryByText(/이전 값 포함/)).toBeNull();
  });
});

// QA-622: 금리차 값·직전 확정치·스크래핑 스프레드는 formatSigned(ASCII '-')로 찍혀, 같은 칸의 변화 줄(−, U+2212 — 공용 지표 칸 QA-525)과 부호가
// 달랐습니다(실행 명세 §3-1 '음수 부호는 −').
describe("QA-622 금리차 음수 부호는 −(U+2212)", () => {
  it("공식 값·직전 확정치·스크래핑 스프레드의 음수가 −로 찍힌다", () => {
    const scraped = { longValue: 4.0, shortValue: 4.3, spread: -0.3, previousSpread: -0.28, delta: -0.02 };
    const { container } = render(<SpreadSection title="10Y−2Y" block={block({ latest: -0.25, previous: -0.2, scraped })} />);

    const text = container.textContent ?? "";
    expect(text).toContain("−0.250%p");
    expect(text).toContain("−0.200%p");
    expect(text).toContain("−0.300%p");
    expect(text).not.toMatch(/(^|[^\d])-0\.(250|200|300)%p/);
  });
});
