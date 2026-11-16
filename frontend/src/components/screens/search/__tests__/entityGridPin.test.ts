/**
 * 정보 검색 대상 화면의 칸 틀 클래스 고정 — 작업대 P4에서 클래스 글을 공용 패턴(components/patterns/SplitPane — ENTITY_FRAME·ENTITY_FRAME_LEFT)으로 옮기고
 * search/entityGrid.ts는 같은 이름(ENTITY_GRID·ENTITY_LEFT)으로 다시 내보냅니다. 정보 검색의 겉모습은 P7 전까지 그대로여야 하므로(명세 §7 9행 '겉모습 변화 0'),
 * 옮기기 전 글과 바이트까지 같은지 봅니다 — 상세 화면을 위해 패턴 쪽 글을 바꾸면 여기서 걸립니다(바꾸려면 P7에서 정보 검색과 함께).
 */
import { describe, expect, it } from "vitest";

import { ENTITY_FRAME, ENTITY_FRAME_LEFT } from "@/components/patterns";

import { ENTITY_GRID, ENTITY_LEFT } from "../entityGrid";

describe("정보 검색 칸 틀 클래스 — 옮기기 전 글 그대로", () => {
  it("ENTITY_GRID — lg 두 칸(13rem · 1fr, 두 줄), xl 세 칸(13rem · 1fr · 18rem)", () => {
    expect(ENTITY_GRID).toBe(
      "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:grid-rows-none",
    );
  });

  it("ENTITY_LEFT — lg는 두 줄을 차지, xl은 한 줄", () => {
    expect(ENTITY_LEFT).toBe("lg:row-span-2 xl:row-span-1");
  });

  it("공용 패턴의 같은 글을 다시 내보낸다(두 벌이 아님)", () => {
    expect(ENTITY_GRID).toBe(ENTITY_FRAME);
    expect(ENTITY_LEFT).toBe(ENTITY_FRAME_LEFT);
  });
});
