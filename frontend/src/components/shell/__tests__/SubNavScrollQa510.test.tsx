/**
 * QA-510: 좁은 화면(lg 미만) 하위 메뉴 줄은 가로로 스크롤하는데(줄을 바꾸지 않음), 지금 칸이나 Tab으로 옮긴 칸을 줄 안으로 스크롤하지 않았습니다 —
 * 정보 수집 '정보(메커니즘)'(여덟째 칸)처럼 뒤쪽 칸을 연 화면에서 지금 칸이 줄 밖에 가려진 채 열렸고, 반쯤 가려진 칸에 포커스해도 그대로였습니다
 * (D1 QA 스택 확인 'scroll-strip-active-item-offscreen' — 개편 전부터, 390px). 모의매매 화면 안의 탭 줄은 P6이 같은 훅으로 고칩니다.
 *
 * jsdom은 배치를 계산하지 않으므로 줄과 칸의 크기를 정해 둡니다 — 줄(ul) 보이는 폭 358px, 칸(a) 폭 120px·줄 안 왼쪽 위치 4 + 120 × 순서(px-1).
 * 줄을 스크롤하는 값(scrollLeft)은 jsdom이 기억합니다. 창 세로 스크롤을 건드리지 않게 scrollIntoView가 아니라 줄의 scrollLeft만 바꾸는지도 봅니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/types";

import { SubNav } from "../SubNav";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };

const STRIP_WIDTH = 358;
const ITEM_WIDTH = 120;
const STRIP_PAD = 4;

/** 링크가 줄에서 몇째 칸인가(감싼 li의 순서) — 줄 밖의 요소는 -1. */
function indexOf(element: Element): number {
  const item = element.parentElement;
  if (element.tagName !== "A" || !item || item.tagName !== "LI" || !item.parentElement) return -1;
  return [...item.parentElement.children].indexOf(item);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    const index = indexOf(this);
    return index < 0 ? 0 : STRIP_PAD + index * ITEM_WIDTH;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return indexOf(this) < 0 ? 0 : ITEM_WIDTH;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.tagName === "UL" ? STRIP_WIDTH : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const strip = (name: string) => screen.getByRole("navigation", { name }).querySelector("ul") as HTMLUListElement;

describe("QA-510 — 좁은 화면 하위 메뉴 줄이 지금 칸·포커스한 칸을 줄 안으로 스크롤한다", () => {
  // 수정 전(재현 커밋에서는 it.fails): scrollLeft 0 그대로 — 여덟째 칸(왼쪽 844 ~ 오른쪽 964px)이 358px 줄 밖에 가려진 채 열림.
  it("뒤쪽 칸(/info/mechanism — 여덟째)을 연 화면에서는 그 칸이 오른쪽 여백 16px까지 보이게 줄을 스크롤해 둔다", () => {
    render(<SubNav pathname="/info/mechanism" user={OWNER} />);
    const list = strip("정보 수집 하위 메뉴");
    expect(screen.getByRole("link", { name: "정보(메커니즘)" }).getAttribute("aria-current")).toBe("page");
    // 844 + 120 + 16 − 358
    expect(list.scrollLeft).toBe(622);
  });

  // 수정 전(재현 커밋에서는 it.fails): scrollLeft 0 그대로 — 오른쪽이 6px 잘린 셋째 칸(244 ~ 364px)에 Tab으로 가도 줄이 움직이지 않음.
  it("Tab으로 옮긴 칸이 잘려 있으면 그 칸이 보이게 줄을 스크롤하고, 다 보이는 칸이면 그대로 둔다", () => {
    render(<SubNav pathname="/info/overview" user={OWNER} />);
    const list = strip("정보 수집 하위 메뉴");
    expect(list.scrollLeft).toBe(0);

    act(() => screen.getByRole("link", { name: "뉴스·글" }).focus());
    expect(list.scrollLeft).toBe(0);

    act(() => screen.getByRole("link", { name: "국내 시장·수급" }).focus());
    // 244 + 120 + 16 − 358
    expect(list.scrollLeft).toBe(22);

    // 왼쪽으로 잘린 칸 — 그 칸 왼쪽 16px 앞까지
    act(() => screen.getByRole("link", { name: "개요" }).focus());
    expect(list.scrollLeft).toBe(0);
  });

  it("줄이 없던 화면에서 줄이 있는 화면으로 오면 그 줄에서도 지금 칸·포커스한 칸을 보이게 한다 — 같은 주소로 다시 그릴 때는 밀어 둔 줄을 되돌리지 않는다", () => {
    const { rerender } = render(<SubNav pathname="/" user={OWNER} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(<SubNav pathname="/info/mechanism" user={OWNER} />);
    const list = strip("정보 수집 하위 메뉴");
    expect(list.scrollLeft).toBe(622);
    act(() => screen.getByRole("link", { name: "개요" }).focus());
    expect(list.scrollLeft).toBe(0);
    rerender(<SubNav pathname="/info/mechanism" user={OWNER} />);
    expect(list.scrollLeft).toBe(0);
  });

  it("창 세로 스크롤을 건드리는 scrollIntoView는 쓰지 않는다 — 줄은 위치 기준(relative)이라 칸의 offsetLeft가 줄 안 좌표", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<SubNav pathname="/info/mechanism" user={OWNER} />);
    act(() => screen.getByRole("link", { name: "출처 상태" }).focus());
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(strip("정보 수집 하위 메뉴").className.split(/\s+/)).toContain("relative");
  });
});

/**
 * QA-566: 하위 메뉴 줄(ul)은 셸 레이아웃에 있어 클라이언트 이동 때 같은 요소로 남고 scrollLeft도 남습니다. QA-510 훅이 주소가 바뀔 때 두 경우를 놓쳤습니다
 * (QA 스택 390 확인 — QA-510 훅이 만든 상태, D1에는 없음).
 * - 지금 칸이 없는 화면(/more·/markets/i/…·/s/… — aria-current 칸 없음)은 앞 화면에서 훅이 옮겨 둔 줄 위치를 그대로 물려받았습니다(새로 열면 0).
 * - 뒤로·앞으로 가기에서 포커스가 줄 안의 앞 칸에 남아 있는데도 지금 칸을 보이게 옮겨, 포커스한 칸이 줄 밖으로 밀렸습니다(다음 Tab까지).
 */
describe("QA-566 — 주소가 바뀔 때 지금 칸이 없으면 줄을 처음으로, 줄 안에 포커스가 있으면 그 칸을 보이게", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 /more에서 scrollLeft 142 그대로 — 첫 칸 '알림'(4 ~ 124px)이 줄 밖.
  it.fails("/connections(넷째 칸 — 142)에서 지금 칸이 없는 /more로 오면 줄을 처음(0)으로 둔다", () => {
    const { rerender } = render(<SubNav pathname="/connections" user={OWNER} />);
    const list = strip("더보기 하위 메뉴");
    // 364 + 120 + 16 − 358
    expect(list.scrollLeft).toBe(142);
    rerender(<SubNav pathname="/more" user={OWNER} />);
    expect(strip("더보기 하위 메뉴")).toBe(list);
    expect(list.querySelector("[aria-current]")).toBeNull();
    expect(list.scrollLeft).toBe(0);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 /s/us/NVDA에서 scrollLeft 382 그대로 — 첫 칸 '매크로 지표'가 줄 밖.
  it.fails("/regime(여섯째 칸 — 382)에서 지금 칸이 없는 상세 화면 /s/us/NVDA로 오면 줄을 처음(0)으로 둔다", () => {
    const { rerender } = render(<SubNav pathname="/regime" user={OWNER} />);
    const list = strip("시장 하위 메뉴");
    // 604 + 120 + 16 − 358
    expect(list.scrollLeft).toBe(382);
    rerender(<SubNav pathname="/s/us/NVDA" user={OWNER} />);
    expect(strip("시장 하위 메뉴")).toBe(list);
    expect(list.querySelector("[aria-current]")).toBeNull();
    expect(list.scrollLeft).toBe(0);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 /connections로 돌아오면 scrollLeft 142 — 포커스가 남은 '알림'이 줄 기준 -138 ~ -18px로 가려짐.
  it.fails("/connections에서 '알림'에 포커스해 /alerts로 갔다가 다시 /connections로 오면(뒤로 가기) 포커스한 '알림'을 줄 안에 둔다", () => {
    const { rerender } = render(<SubNav pathname="/connections" user={OWNER} />);
    const list = strip("더보기 하위 메뉴");
    expect(list.scrollLeft).toBe(142);
    const alerts = screen.getByRole("link", { name: "알림" });
    act(() => alerts.focus());
    expect(list.scrollLeft).toBe(0);

    rerender(<SubNav pathname="/alerts" user={OWNER} />);
    expect(list.scrollLeft).toBe(0);
    expect(document.activeElement).toBe(alerts);

    rerender(<SubNav pathname="/connections" user={OWNER} />);
    expect(document.activeElement).toBe(alerts);
    expect(list.scrollLeft).toBe(0);
    // '알림'(4 ~ 124px)이 보이는 폭(scrollLeft ~ scrollLeft + 358) 안
    expect(alerts.offsetLeft).toBeGreaterThanOrEqual(list.scrollLeft);
    expect(alerts.offsetLeft + alerts.offsetWidth).toBeLessThanOrEqual(list.scrollLeft + STRIP_WIDTH);
  });
});
