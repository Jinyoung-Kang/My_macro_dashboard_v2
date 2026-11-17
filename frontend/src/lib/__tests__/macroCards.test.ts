import { describe, expect, it } from "vitest";

import { categoryDelay } from "@/lib/macroCards";
import type { MacroCategory, MacroItem } from "@/lib/types";

const item = (over: Partial<MacroItem>): MacroItem => ({ key: "k", name: "n", status: "ok", ...over });
const category = (items: MacroItem[], note?: string): MacroCategory => ({ id: "c", title: "t", note, items });

describe("categoryDelay", () => {
  it("모두 같으면 그 지연, 다르면 종목마다 다름", () => {
    expect(categoryDelay(category([item({ delayMinutes: 10 }), item({ delayMinutes: 10 })]))).toBe("시세: 10분 지연");
    expect(categoryDelay(category([item({ delayMinutes: 0 }), item({ delayMinutes: 10 })])))
      .toBe("시세: 종목마다 다름 — 기준 칸(없으면 지표 미리보기) 참고");
  });

  it("수집 실패·이어받은 값은 요약에서 뺀다", () => {
    expect(categoryDelay(category([
      item({ delayMinutes: 0 }), item({ delayMinutes: 15, isStale: true }), item({ delayMinutes: 10, status: "fail" }),
    ]))).toBe("시세: 실시간");
  });

  it("예전 저장본(delayMinutes 없음)은 수집기가 적은 요약을 쓴다", () => {
    expect(categoryDelay(category([item({ note: "15분 지연" })], "15분 지연"))).toBe("데이터 지연: 15분 지연");
  });
});

