/**
 * 가로 스크롤 줄의 칸 보이기(lib/scrollStrip — QA-510). 줄 안 좌표(칸의 offsetLeft·폭, 줄의 scrollLeft·보이는 폭)만으로 셉니다.
 * 세로판 navScrollTop(넓은 화면 왼쪽 나무 메뉴 — QA-555)은 메뉴 스크롤 내용 안 좌표(칸 위 끝·높이, 메뉴의 scrollTop·보이는 높이)로 셉니다.
 */
import { describe, expect, it } from "vitest";

import { navScrollTop, stripScrollLeft } from "../scrollStrip";

const VIEW = 358;

describe("stripScrollLeft", () => {
  it("칸이 다 보이면 그대로 — 가장자리에 붙어 있어도 움직이지 않는다", () => {
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: VIEW }, { left: 4, width: 120 })).toBe(0);
    expect(stripScrollLeft({ scrollLeft: 100, clientWidth: VIEW }, { left: 100, width: 120 })).toBe(100);
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: VIEW }, { left: 238, width: 120 })).toBe(0);
  });

  it("오른쪽이 잘리면 칸 오른쪽이 여백(16px)만큼 안쪽에 오게", () => {
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: VIEW }, { left: 244, width: 120 })).toBe(22);
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: VIEW }, { left: 844, width: 120 })).toBe(622);
  });

  it("왼쪽이 잘리면 칸 왼쪽이 여백만큼 안쪽에 오게 — 0 미만은 0", () => {
    expect(stripScrollLeft({ scrollLeft: 622, clientWidth: VIEW }, { left: 484, width: 120 })).toBe(468);
    expect(stripScrollLeft({ scrollLeft: 622, clientWidth: VIEW }, { left: 4, width: 120 })).toBe(0);
  });

  it("칸이 줄(여백 포함)보다 넓으면 왼쪽 끝을 맞춘다", () => {
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: 200 }, { left: 300, width: 190 })).toBe(284);
  });

  it("여백을 바꿀 수 있다", () => {
    expect(stripScrollLeft({ scrollLeft: 0, clientWidth: VIEW }, { left: 244, width: 120 }, 0)).toBe(6);
  });
});

describe("navScrollTop(세로 — 왼쪽 나무 메뉴, QA-555)", () => {
  // QA 스택 1024x600 /krx(고친 뒤 배치): 메뉴 보이는 높이 503px, 지금 칸 '파생·투기세력(KRX)'은 메뉴 안 512~544px.
  const MENU = 503;

  it("칸이 다 보이면 그대로 — 아래 끝에 붙어 있어도 움직이지 않는다", () => {
    expect(navScrollTop({ scrollTop: 0, clientHeight: MENU }, { top: 8, height: 32 })).toBe(0);
    expect(navScrollTop({ scrollTop: 0, clientHeight: MENU }, { top: 471, height: 32 })).toBe(0);
    // 끝까지 굴린 메뉴(scrollTop 49 — 보이는 49~552)에서는 512~544 칸이 다 보임
    expect(navScrollTop({ scrollTop: 49, clientHeight: MENU }, { top: 512, height: 32 })).toBe(49);
  });

  it("아래가 잘리면 칸 아래가 여백(16px)만큼 안쪽에 오게 — 끝을 넘는 값은 브라우저가 줄임", () => {
    // 512 + 32 + 16 − 503
    expect(navScrollTop({ scrollTop: 0, clientHeight: MENU }, { top: 512, height: 32 })).toBe(57);
  });

  it("위가 잘리면 칸 위가 여백만큼 안쪽에 오게 — 0 미만은 0", () => {
    expect(navScrollTop({ scrollTop: 200, clientHeight: MENU }, { top: 182, height: 32 })).toBe(166);
    expect(navScrollTop({ scrollTop: 200, clientHeight: MENU }, { top: 8, height: 32 })).toBe(0);
  });

  it("칸이 메뉴(여백 포함)보다 높으면 위 끝을 맞추고, 여백을 바꿀 수 있다", () => {
    expect(navScrollTop({ scrollTop: 0, clientHeight: 40 }, { top: 100, height: 32 })).toBe(84);
    expect(navScrollTop({ scrollTop: 0, clientHeight: MENU }, { top: 512, height: 32 }, 0)).toBe(41);
  });
});
