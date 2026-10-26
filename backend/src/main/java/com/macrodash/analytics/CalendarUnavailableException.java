package com.macrodash.analytics;

/**
 * 🧪 달력이 모르는 날 — 거래일 달력({@link TradingCalendar})이 그날이 거래일인지 알 수 없을 때 던집니다(2단계 명세
 * 2026-10-26-v2-kr-paper-spec.md §4-4·K35, §9 묶음 A 리뷰 메모 'B5 — 달력이 모르는 날').
 *
 * <p>한국 달력({@link KrxCalendar})은 공휴일 목록을 받은 해만 압니다. 목록이 없는 해의 평일을 '거래일'이나 '휴장'으로 짐작하면
 * 주문 만료·재진입 금지·통계 표본이 조용히 바뀌므로, 짐작하지 않고 이 예외로 알립니다(fail-closed). 주말은 목록 없이도 휴장이라
 * 던지지 않습니다. 미국 달력은 규칙으로 모든 해를 덮어 던지지 않습니다.
 *
 * <p>받는 쪽의 몫(K35): 정기 작업(결정·리스크 점검·복기)은 앞으로 쓸 창의 해가 빠졌으면 작업 기록에 {@value #REASON}으로 남기고 그
 * 시장 실행을 멈추며, 조회는 그 계산(통계 표본·보유 거래일)만 null로 두고 이 메시지를 사유로 함께 내보냅니다. {@link IllegalStateException}
 * 이 아닌 따로 된 형인 것은, 일반 상태 오류를 잡는 곳이 이 사유를 다른 오류와 섞지 않게 하려는 것입니다.
 */
public final class CalendarUnavailableException extends RuntimeException {

    /** 작업 기록·조회 사유의 머리말. */
    public static final String REASON = "달력 없음";

    private final int year;

    /**
     * @param year     거래일인지 알 수 없는 날의 해
     * @param calendar 어느 달력인지(메시지용 — 예: {@code KrxCalendar[2025~2027]})
     */
    public CalendarUnavailableException(int year, String calendar) {
        super(REASON + " — " + year + "년 공휴일 목록이 없어 그해 거래일을 알 수 없습니다(" + calendar
                + "). 천문연 공휴일 저장본(kr_holidays)에 그해 목록이 들어온 뒤 다시 계산합니다");
        this.year = year;
    }

    /** 목록이 없는 해. */
    public int year() {
        return year;
    }
}
