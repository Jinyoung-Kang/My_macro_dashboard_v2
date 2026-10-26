package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.Objects;

/**
 * 🧪 트레일링 스탑과 재진입 금지(명세 L7·D10, 설계 §3-3).
 *
 * <p>진입 뒤 <b>최고 관측가</b>(체결가 포함)를 따라 올라가는 기준선에서 stopPct% 밑으로 내려온 관측치에서 전량 매도하고,
 * 그 종목은 관측일 다음 거래일부터 n거래일 동안 다시 사지 않습니다. 현금성(SHY)·벤치마크 책을 빼는 판단은 서비스가 합니다.
 *
 * <p>순서가 중요합니다: 관측치마다 {@link #raiseWatermark}로 최고가를 먼저 올린 뒤 {@link #triggered}를 봅니다. 같은 관측치가
 * 새 최고가이면서 스탑일 수는 없습니다(price = 최고가 &gt; 스탑가).
 */
public final class TrailingStop {

    private TrailingStop() {
    }

    /** 최고가 갱신 = max(기존, 관측가). */
    public static double raiseWatermark(double watermark, double price) {
        if (!Double.isFinite(price)) {
            // Math.max(…, NaN)은 NaN이라 최고가가 영영 망가집니다.
            throw new IllegalArgumentException("관측 가격이 숫자가 아닙니다: " + price);
        }
        return Math.max(watermark, price);
    }

    /**
     * 스탑가 = 최고가 × (1 − stopPct/100). 예: 최고가 110, 8% → 101.2.
     *
     * @param stopPct 0 초과 100 미만. 0이면 최고가 아래 모든 관측치가 스탑이 되고, 100 이상이면 스탑이 없는 것과 같아
     *                설정 실수로 보고 막습니다
     * @throws IllegalArgumentException stopPct가 범위 밖
     */
    public static double stopPrice(double watermark, double stopPct) {
        if (!(stopPct > 0) || stopPct >= 100) {
            throw new IllegalArgumentException("스탑 비율(%)은 0 초과 100 미만이어야 합니다: " + stopPct);
        }
        return watermark * (1.0 - stopPct / 100.0);
    }

    /** 관측가가 스탑가 이하이면 발동(같으면 발동). */
    public static boolean triggered(double watermark, double price, double stopPct) {
        return price <= stopPrice(watermark, stopPct);
    }

    /**
     * 재진입 금지 마지막 날 = 관측일 + n거래일({@link UsMarketCalendar#addTradingDays}). 예: 2026-10-23 스탑, 20거래일 →
     * 2026-11-20까지 금지, 11-23부터 매수 가능. 미국 달력 — {@link #lockoutUntil(TradingCalendar, LocalDate, int)}에 미국 달력을 넘깁니다.
     */
    public static LocalDate lockoutUntil(LocalDate observationDate, int tradingDays) {
        return lockoutUntil(UsMarketCalendar.CALENDAR, observationDate, tradingDays);
    }

    /**
     * 재진입 금지 마지막 날 = 관측일 + n거래일(그 시장 달력의 {@link TradingCalendar#addTradingDays}).
     *
     * @param calendar 그 책이 속한 시장의 거래일 달력
     */
    public static LocalDate lockoutUntil(TradingCalendar calendar, LocalDate observationDate, int tradingDays) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        return calendar.addTradingDays(observationDate, tradingDays);
    }

    /**
     * 오늘이 금지 기간 안인지(today ≤ until).
     *
     * @param until 금지 마지막 날. null이면 금지 없음(false)
     */
    public static boolean lockedOut(LocalDate until, LocalDate today) {
        return until != null && !today.isAfter(until);
    }
}
