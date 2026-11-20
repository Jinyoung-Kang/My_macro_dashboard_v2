/**
 * 폼 칸 공용 상수(FIELD_LABEL·FIELD_WIDTH·FIELD_INPUT) — 화면마다 따로 적던 글을 모은 것이라 글이 예전과 바이트까지 같아야 겉모습이 같습니다
 * (P7 알림 규칙·회원 만들기·내 계정·정보 수집 고르기, P6 메모·설정 고르기 폭, 공용 Select 감싼 칸).
 */
import { describe, expect, it } from "vitest";
import { FIELD_INPUT, FIELD_LABEL, FIELD_WIDTH, inputClasses } from "@/components/ui";

describe("폼 칸 공용 상수", () => {
  it("예전 화면별 글과 같다", () => {
    expect(FIELD_LABEL).toBe("flex min-w-0 flex-col gap-1 text-[13px] text-text-2");
    expect(FIELD_WIDTH).toBe("w-full sm:max-w-[22rem]");
    expect(FIELD_INPUT).toBe(`w-full sm:max-w-[22rem] ${inputClasses()}`);
    expect(`block ${FIELD_WIDTH}`).toBe("block w-full sm:max-w-[22rem]");
  });
});
