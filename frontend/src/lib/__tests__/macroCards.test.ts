import { describe, expect, it } from "vitest";

import { cardNotices, categoryDelay } from "@/lib/macroCards";
import type { MacroCategory, MacroItem } from "@/lib/types";

const item = (over: Partial<MacroItem>): MacroItem => ({ key: "k", name: "n", status: "ok", ...over });
const category = (items: MacroItem[], note?: string): MacroCategory => ({ id: "c", title: "t", note, items });

describe("categoryDelay", () => {
  it("모두 같으면 그 지연, 다르면 종목마다 다름", () => {
    expect(categoryDelay(category([item({ delayMinutes: 10 }), item({ delayMinutes: 10 })]))).toBe("시세: 10분 지연");
    expect(categoryDelay(category([item({ delayMinutes: 0 }), item({ delayMinutes: 10 })])))
      .toBe("시세: 종목마다 다름 — 카드 배지 참고");
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

describe("cardNotices", () => {
  it("이어받은 값과 경고만 — 지연 문구는 알림이 아니다", () => {
    expect(cardNotices(item({ note: "실시간 · TradingView 참고", delayMinutes: 0 }))).toEqual([]);
    const notices = cardNotices(item({ isStale: true, staleReason: "HTTP 429", warning: "선물 조회 실패 · 지수 값" }));
    expect(notices.map((n) => n.text)).toEqual(["이전 값", "선물 조회 실패 · 지수 값"]);
    // 이어받은 값은 경고 톤 — 기호는 글에 넣지 않고 그리는 쪽이 아이콘으로
    expect(notices.map((n) => n.tone)).toEqual(["warn", undefined]);
  });
});
