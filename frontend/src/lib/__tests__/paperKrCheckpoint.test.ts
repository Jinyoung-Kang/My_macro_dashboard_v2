/**
 * 한국 Claude 계좌2 장중 확인(단계 2b — 명세 2026-11-02 §10)의 화면 글.
 *  - '오늘 장중 확인' 한 줄(상태 응답 kr_claude2.checkpoint) — 칸이 없으면 null, 계획 없음·꺼짐, 계획이면 서울 시각·감시 1분봉·감시 목록·상태와 사유·확인 결정·
 *    감시 저장본 지연. 시각은 KST만(ET 없음)
 *  - 사유는 한국 스위치 키(kr.claude2.checkpoints)·감시 태스크 이름으로
 *  - 결정 로그: 밤 결정의 장중 확인 요청 줄은 'HH:MM KST', 확인 결정(kind CHECKPOINT) 본문은 KST·원·한국 시점 이름
 */
import { describe, expect, it } from "vitest";
import { checkpointReasonText, claudeDecisionView, krClaude2CheckpointLine } from "../paper";
import type { PaperKrClaude2Status } from "../types";

const status = (checkpoint: PaperKrClaude2Status["checkpoint"]): PaperKrClaude2Status => ({
  book: "kr_claude2", status: "ACTIVE", startedOn: "2026-10-30", checkpoint,
});

describe("krClaude2CheckpointLine — 한국 계좌2 '오늘 장중 확인' 한 줄", () => {
  it("칸이 없는 백엔드면 null, 계획이 없으면 켬·꺼짐에 따라 계획 없음·꺼짐", () => {
    expect(krClaude2CheckpointLine(null)).toBeNull();
    expect(krClaude2CheckpointLine(status(undefined))).toBeNull();
    expect(krClaude2CheckpointLine(status({ enabled: true, session: "2026-12-02", today: null, watch: null })))
      .toBe("오늘 장중 확인(한국 계좌2, 세션 2026-12-02): 계획 없음 — 밤 결정이 요청하지 않았거나 아직 그 밤 결정 전입니다(세션당 최대 한 번)");
    expect(krClaude2CheckpointLine(status({ enabled: false, session: "2026-12-02", today: null, watch: null })))
      .toContain("꺼짐 — 설정 kr.claude2.checkpoints");
  });

  it("계획이면 서울 시각·감시 1분봉·감시 목록·상태, 정규장이면 감시 저장본 받은 시각·지연 — ET는 적지 않음", () => {
    const line = krClaude2CheckpointLine(status({
      enabled: true,
      session: "2026-12-02",
      today: {
        session: "2026-12-02", atEt: null, atKst: "2026-12-02 11:00", feed: "MINUTE", watch: ["005930", "000660"],
        status: "DONE", reason: null, decisionId: 42, calledAtKst: "2026-12-02 11:04",
      },
      watch: { collectedAtKst: "2026-12-02 11:00", ageSeconds: 240, lagSeconds: 5 },
    }));
    expect(line).toContain("세션 2026-12-02");
    expect(line).toContain("11:00 KST");
    expect(line).toContain("감시 1분봉(토스, 확인 시각 뒤 한 번)");
    expect(line).toContain("감시 005930, 000660");
    expect(line).toContain("확인 결정 #42");
    expect(line).toContain("지연 5");
    expect(line).not.toContain("ET");
  });

  it("놓친 계획은 한국 사유로 — 스위치 꺼짐은 kr.claude2.checkpoints, 감시 저장본 없음은 paper_watch_kr", () => {
    expect(checkpointReasonText("CHECKPOINTS_OFF — 설정 kr.claude2.checkpoints가 꺼져 있음", "KR"))
      .toBe("설정 kr.claude2.checkpoints가 꺼져 있음 (CHECKPOINTS_OFF)");
    expect(checkpointReasonText("CHECKPOINTS_OFF — …")).toContain("claude2.enabled");
    const line = krClaude2CheckpointLine(status({
      enabled: true, session: "2026-12-02", watch: null,
      today: {
        session: "2026-12-02", atEt: null, atKst: "2026-12-02 11:00", feed: "MINUTE", watch: ["005930"], status: "EXPIRED",
        reason: "NO_WATCH_SNAPSHOT — 확인 시각 뒤에 받은 감시 저장본이 창 끝까지 없음", decisionId: null, calledAtKst: null,
      },
    }));
    expect(line).toContain("paper_watch_kr");
    expect(line).toContain("(NO_WATCH_SNAPSHOT)");
  });
});

describe("결정 로그 — 한국 계좌2 장중 확인 요청·확인 결정", () => {
  it("밤 결정의 장중 확인 요청 줄은 'HH:MM KST'와 감시 1분봉", () => {
    const view = claudeDecisionView({
      book: "kr_claude2", kind: "SCHEDULED", status: "OK",
      response: {
        stance: "NEUTRAL", orders: [], summary: "요약",
        checkpointPlan: { session: "2026-12-02", atKst: "11:00", feed: "MINUTE", watch: ["005930"], status: "PLANNED" },
        checkpointVerdict: { accepted: true, reasons: [] },
      },
    });
    expect(view.checkpointPlan).toBe("세션 2026-12-02 · 11:00 KST · 감시 1분봉(토스, 확인 시각 뒤 한 번) · 감시 005930 · 예정");
  });

  it("확인 결정 본문 — 요청 줄은 KST, 예상 장부는 원, 체결로 본 주문의 시점은 한국 이름", () => {
    const view = claudeDecisionView({
      book: "kr_claude2", kind: "CHECKPOINT", status: "OK",
      response: {
        action: "REPLACE", orders: [], summary: "바꿈", applied: true, supersededOrders: [7],
        checkpoint: { session: "2026-12-02", atKst: "11:00", feed: "MINUTE", sourceDecisionId: 3, lagSeconds: 5 },
        expectedState: {
          cash: 50_000_000, nav: 100_000_000, exposurePct: 50,
          assumedFills: [{ ticker: "005930", side: "BUY", timing: "AT_1000", priceSource: "WATCH" }], unpriced: [], note: "추정",
        },
      },
    });
    expect(view.checkpoint?.request).toBe("세션 2026-12-02 · 11:00 KST · 감시 1분봉(토스, 확인 시각 뒤 한 번) · 지연 5.0초");
    expect(view.checkpoint?.expected[0]).toContain("원");
    expect(view.checkpoint?.expected[0]).not.toContain("$");
    expect(view.checkpoint?.expected[1]).toContain("다음 거래일 10:00 KST");
    expect(view.checkpoint?.superseded).toBe("1건(#7)");
  });
});
