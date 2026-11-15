/**
 * 개장 배지의 휴장 추정 — 장 밖 값의 거래일로도 판정한다(QA-138).
 *
 * 카드 값을 TradingView 실시간 시세로 바꾸면 카드 시각은 체결 시각이 아니라 '수집 시각'이나 '거래일'입니다. 예전 휴장
 * 추정은 체결 시각(Yahoo 분봉)만 봐서, 공휴일 목록이 없는 도쿄·홍콩의 휴장일에 배지가 '개장'으로 남습니다.
 * 2026-10-19(월)은 홍콩 중양절 대체 휴장 — 그날 TradingView 항셍의 마지막 거래일은 10-16(금)이었습니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionBadge } from "../SessionBadge";

afterEach(() => cleanup());

const HK_1100 = new Date("2026-10-19T03:00:00Z"); // 홍콩 월요일 11:00 — 시간표로는 개장
const COLLECTED = "2026-10-19 11:55 KST"; // 홍콩 10:55

function badge(lastTs: string) {
  render(<SessionBadge market="hkex" now={HK_1100} krOfficial={null} lastTs={lastTs} collectedAt={COLLECTED} />);
}

describe("QA-138 장 밖 거래일로 본 휴장 추정", () => {
  it("개장 시간인데 마지막 거래일이 그 시장의 오늘보다 앞서면 '휴장 추정'", () => {
    badge("2026-10-16 거래일 기준 (TradingView · 장 밖)");
    expect(screen.getByText("휴장 추정")).toBeTruthy();
  });

  it("마지막 거래일이 오늘이면 그대로 '개장'", () => {
    badge("2026-10-19 거래일 기준 (TradingView · 장 밖)");
    expect(screen.getByText("개장")).toBeTruthy();
  });

  it("수집 시각 표기는 거래일로 읽지 않는다", () => {
    badge("2026-10-19 11:50 KST (TradingView 수집 시각)");
    expect(screen.getByText("개장")).toBeTruthy();
  });
});

describe("개장 상태와 시세 지연을 배지 하나로", () => {
  const TUE_1954_KST = new Date("2026-10-20T10:54:00Z");   // 뉴욕 06:54 — CME 개장, 뉴욕 증시 마감(장 전)

  it("개장이면 '개장 · 10분 지연'", () => {
    render(<SessionBadge market="cme" now={TUE_1954_KST} krOfficial={null} delayMinutes={10} />);
    expect(screen.getByText("개장 · 10분 지연")).toBeTruthy();
  });

  it("마감이면 지연은 배지에 적지 않고 툴팁에만", () => {
    render(<SessionBadge market="nyse" now={TUE_1954_KST} krOfficial={null} delayMinutes={0} />);
    const badge = screen.getByText("마감");
    expect(badge.getAttribute("title")).toContain("시세 실시간(출처 기준)");
  });

  it("이어받은 예전 값이면 지연을 적지 않는다", () => {
    render(<SessionBadge market="cme" now={TUE_1954_KST} krOfficial={null} delayMinutes={0} stale />);
    expect(screen.getByText("개장")).toBeTruthy();
  });

  it("시간표를 모르는 시장이면 지연만", () => {
    render(<SessionBadge market="unknown" now={TUE_1954_KST} krOfficial={null} delayMinutes={15} />);
    expect(screen.getByText("15분 지연")).toBeTruthy();
  });
});

describe("모양 — 4px 태그와 상태 점(상태색은 늘 아이콘과 글 — 작업대 실행 명세 §3-1·§6)", () => {
  const TUE_1954_KST = new Date("2026-10-20T10:54:00Z");
  const dotOf = (badge: HTMLElement) => badge.querySelector("span[aria-hidden='true'].rounded-full");

  it("개장은 ok 점 + 글, 마감은 중립 점 + 글 — 태그는 rounded-control(알약 아님), 점은 읽어 주지 않는다", () => {
    render(<SessionBadge market="cme" now={TUE_1954_KST} krOfficial={null} delayMinutes={10} />);
    const open = screen.getByText("개장 · 10분 지연");
    expect(open.className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-control", "text-ok"]));
    expect(open.className.split(/\s+/)).not.toContain("rounded-full");
    expect(dotOf(open)?.classList.contains("text-ok")).toBe(true);
    expect(open.textContent).toBe("개장 · 10분 지연");
    cleanup();

    render(<SessionBadge market="nyse" now={TUE_1954_KST} krOfficial={null} delayMinutes={0} />);
    const closed = screen.getByText("마감");
    expect(dotOf(closed)?.classList.contains("text-text-3")).toBe(true);
  });

  it("시간표를 모르는 시장의 지연만 배지는 점 없이 글만(상태가 아님)", () => {
    render(<SessionBadge market="unknown" now={TUE_1954_KST} krOfficial={null} delayMinutes={15} />);
    const badge = screen.getByText("15분 지연");
    expect(badge.className.split(/\s+/)).toContain("rounded-control");
    expect(dotOf(badge)).toBeNull();
  });
});
