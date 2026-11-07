import { describe, expect, it } from "vitest";
import { decisionKindLabel, decisionStatusBadge, timingLabel } from "@/lib/paper";
import { intradayBookView, intradayReasonText, intradayStatusBadge, runIntradayResultText } from "@/lib/paperIntraday";
import type { PaperIntradayStatus } from "@/lib/types/paper";

/** 자유 시점 판의 장중 판단(ADR 0027) — 상태 응답 intraday를 화면 줄로, 분 단위 지정 시각·장중 판단 종류의 이름. */
const STATUS: PaperIntradayStatus = {
  session: "2026-11-02",
  maxPerSession: 2,
  books: [
    {
      book: "claude",
      freeTiming: true,
      plans: [
        { slot: 1, at: "10:15", feed: "MINUTE", watch: ["AAA", "SHY"], question: "개장 뒤 확인", manual: false, status: "DONE",
          reason: null, decisionId: 71, lagSeconds: 75, calledAtKst: "2026-11-03 00:17 KST" },
        { slot: 2, at: "13:30", feed: "HOURLY", watch: [], question: "오후 확인", manual: true, status: "EXPIRED",
          reason: "NO_FRESH_QUOTES — 그 세션의 시간별 관측치가 창 끝까지 없음", decisionId: null, lagSeconds: null, calledAtKst: null },
      ],
    },
    { book: "claude2", freeTiming: false, plans: [{ slot: 1, at: "11:00", feed: "HOURLY", status: "SUPERSEDED", reason: "뒤 결정이 대신함" }] },
  ],
};

describe("장중 판단 묶음", () => {
  it("그 계좌의 계획 행을 순번·시각·피드·감시 목록·수동 표시와 상태 배지로", () => {
    const view = intradayBookView(STATUS, "claude", "US");
    expect(view).not.toBeNull();
    expect(view?.summary).toBe("2026-11-02 세션 · 세션당 2번까지");
    expect(view?.on).toBe(true);
    expect(view?.blocked).toBeNull();
    expect(view?.rows.map((row) => row.text)).toEqual([
      "1번째 · 10:15 ET · 감시 1분봉 · AAA, SHY",
      "2번째 · 13:30 ET · 시간별 관측치 · 수동",
    ]);
    expect(view?.rows.map((row) => row.badge.label)).toEqual(["부름", "놓침"]);
    expect(view?.rows[0].reason).toBeNull();
    expect(view?.rows[1].reason).toContain("NO_FRESH_QUOTES");
    expect(view?.rows[0].question).toBe("개장 뒤 확인");
  });

  it("응답에 그 계좌가 없으면 null — 아무것도 그리지 않음. 스위치가 꺼졌거나 횟수가 0이면 수동 요청을 막고 까닭을 적음", () => {
    expect(intradayBookView(STATUS, "rules", "US")).toBeNull();
    expect(intradayBookView(null, "claude", "US")).toBeNull();
    expect(intradayBookView(undefined, "claude", "US")).toBeNull();
    const off = intradayBookView(STATUS, "claude2", "US");
    expect(off?.on).toBe(false);
    expect(off?.blocked).toContain("스위치가 꺼져");
    expect(off?.rows[0].badge.label).toBe("대신함");
    const zero = intradayBookView({ ...STATUS, maxPerSession: 0 }, "claude", "US");
    expect(zero?.blocked).toContain("횟수 설정이 0");
    expect(zero?.summary).toContain("세션당 0번까지");
  });

  it("한국은 시각에 KST, 모르는 값은 —", () => {
    const view = intradayBookView(
      { session: null, maxPerSession: null, books: [{ book: "kr_claude", freeTiming: true, plans: [{ slot: 1, at: "09:10", feed: "MINUTE" }] }] },
      "kr_claude",
      "KR",
    );
    expect(view?.summary).toBe("— 세션 · 세션당 —까지");
    expect(view?.rows[0].text).toBe("1번째 · 09:10 KST · 감시 1분봉");
  });

  it("셋째 판단·호출 이유(ADR 0031): 다음 예약·코드 보장·사건은 줄에 적고(결정의 예약은 따로 적지 않음), 사건 내용과 원래 시각을 한 줄로, 보장·사건 스위치는 요약에", () => {
    const view = intradayBookView(
      {
        session: "2026-11-09",
        maxPerSession: 3,
        minPerSession: 1,
        events: true,
        books: [
          {
            book: "claude",
            freeTiming: true,
            plans: [
              { slot: 1, at: "10:00", feed: "HOURLY", status: "DONE", origin: "RESERVED" },
              { slot: 2, at: "11:00", feed: "HOURLY", status: "DONE", origin: "NEXT" },
              { slot: 3, at: "12:31", feed: "HOURLY", status: "PLANNED", origin: "GUARANTEE", trigger: null },
            ],
          },
        ],
      },
      "claude",
      "US",
    );
    expect(view?.summary).toBe("2026-11-09 세션 · 세션당 3번까지 · 최소 1번(세션 중간 보장) · 사건 당김");
    expect(view?.rows.map((row) => row.text)).toEqual([
      "1번째 · 10:00 ET · 시간별 관측치",
      "2번째 · 11:00 ET · 시간별 관측치 · 다음 예약",
      "3번째 · 12:31 ET · 시간별 관측치 · 코드 보장",
    ]);
    expect(view?.rows.every((row) => row.trigger === null)).toBe(true);
    const second = intradayBookView({ session: "2026-11-09", maxPerSession: 3, books: [
      { book: "claude2", freeTiming: true, plans: [
        { slot: 1, at: "10:20", feed: "MINUTE", watch: ["SPY"], status: "PLANNED", origin: "EVENT",
          trigger: { originalAt: "13:30", events: [{ type: "INDEX_MOVE", ticker: "SPY" }, { type: "NEW_KIND", ticker: null }] } },
        { slot: 2, at: "14:00", feed: "HOURLY", status: "PLANNED", manual: true, origin: "MANUAL" },
        { slot: 3, at: "15:00", feed: "HOURLY", status: "PLANNED", origin: "OTHER" },
      ] },
    ] }, "claude2", "US");
    expect(second?.summary).toBe("2026-11-09 세션 · 세션당 3번까지");
    expect(second?.rows.map((row) => row.text)).toEqual([
      "1번째 · 10:20 ET · 감시 1분봉 · SPY · 사건",
      "2번째 · 14:00 ET · 시간별 관측치 · 수동",
      "3번째 · 15:00 ET · 시간별 관측치 · OTHER",
    ]);
    expect(second?.rows[0].trigger).toBe("사건: 지수 변동 SPY, NEW_KIND · 원래 13:30");
    expect(second?.rows[1].trigger).toBeNull();
  });

  it("사유·상태 이름 — 장중 판단만의 코드는 따로, 나머지는 장중 확인과 같은 표", () => {
    expect(intradayReasonText("INTRADAY_OFF — 세션당 장중 판단 횟수 설정이 0이거나 그 계좌가 꺼져 있음")).toContain("(INTRADAY_OFF)");
    expect(intradayReasonText("OUT_OF_RANGE — …")).toContain("받는 범위 밖");
    expect(intradayReasonText("CALL_CAP — 하루 호출 상한에 닿음")).toContain("하루 호출 상한");
    expect(intradayReasonText(null)).toBe("—");
    expect(intradayStatusBadge("PLANNED").label).toBe("예정");
    expect(intradayStatusBadge("SUPERSEDED").label).toBe("대신함");
  });

  it("수동 요청 결과 — 예약만 했음을 그대로 적음", () => {
    expect(runIntradayResultText({ ok: true, planned: { slot: 1, atEt: "10:13", created: false }, note: "예약됨 — 작업이 부릅니다." }))
      .toBe("1번째 장중 판단을 10:13 ET로 당겼습니다. 예약됨 — 작업이 부릅니다.");
    expect(runIntradayResultText({ ok: true, market: "KR", planned: { slot: 2, atKst: "11:05", created: true } }, "KR"))
      .toBe("2번째 장중 판단을 11:05 KST로 예약했습니다.");
    expect(runIntradayResultText({ ok: false, available: false, message: "테이블이 없습니다." })).toBe("테이블이 없습니다.");
  });
});

describe("분 단위 지정 시각·장중 판단 종류의 이름", () => {
  it("AT_MINUTE은 주문 행의 targetLocal과 시장의 시간대를 붙임 — 시각이 없으면 이름만", () => {
    expect(timingLabel("AT_MINUTE", "US", "10:47")).toBe("지정 시각 10:47 ET");
    expect(timingLabel("AT_MINUTE", "KR", "09:01")).toBe("지정 시각 09:01 KST");
    expect(timingLabel("AT_MINUTE", "US", null)).toBe("지정 시각");
    expect(timingLabel("NEXT_CLOSE", "US", "10:47")).toBe("다음 종가");
    expect(timingLabel("AT_1000", "KR")).toBe("다음 거래일 10:00 KST");
  });

  it("결정 종류 INTRADAY_n — 이름과 '재시도 없음' 표시", () => {
    expect(decisionKindLabel("INTRADAY_1")).toBe("장중 판단 1");
    expect(decisionKindLabel("INTRADAY_2")).toBe("장중 판단 2");
    expect(decisionStatusBadge("API_ERROR", "INTRADAY_1").label).toContain("재시도 없음");
    expect(decisionStatusBadge("API_ERROR", "SCHEDULED").label).not.toContain("재시도 없음");
  });
});
