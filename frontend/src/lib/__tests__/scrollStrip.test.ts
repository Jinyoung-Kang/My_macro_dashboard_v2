/**
 * 가로 스크롤 줄의 칸 보이기(lib/scrollStrip — QA-510). 줄 안 좌표(칸의 offsetLeft·폭, 줄의 scrollLeft·보이는 폭)만으로 셉니다.
 */
import { describe, expect, it } from "vitest";

import { stripScrollLeft } from "../scrollStrip";

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
