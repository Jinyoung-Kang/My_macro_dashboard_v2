package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Choice;
import com.macrodash.feature.paper.KrQuotes.Close1m;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.KrQuotes.Timed;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 한국 Claude 계좌2의 매시·종가 체결 사다리(단계 2a — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §2·§9). 목표 세션 E의 1분봉
 * ({@code paper.kr.timed} — 장부가 {@link KrPaperMarket#withListings}로 그 종목에 붙임)으로 풉니다. 라벨은 봉 끝 시각(KST)이라 기준 시각 T의 봉은 라벨
 * T + 1분입니다(개장 봉 09:01과 같은 뜻).
 *
 * <ul>
 *   <li><b>매시</b>({@code AT_1000}~{@code AT_1500}, T = hh:00): R1 {@value #SOURCE_AT} — 라벨 hh:01 봉 시가(거래량 &gt; 0) → R2 {@value #SOURCE_NEXT} —
 *       창(라벨 hh:02~hh:05) 안 첫 거래 봉 시가(경고) → R2b {@value #SOURCE_LATE} — 그날 마감 봉 라벨 이하에서 T 뒤 첫 거래 봉 시가(대체). 셋 다 없으면
 *       기다림(멈춘 가격으로 채우지 않음 — 만료까지).</li>
 *   <li><b>종가</b>({@code NEXT_CLOSE}): {@value #SOURCE_CLOSE} — 마감 단일가 봉 종가(거래량 &gt; 0). 라벨은 그날 마감 시각(그 실행 달력 — 장 시간 변경일
 *       포함)에 NXT 종목이면 + 1분(G2: NXT 15:31, NXT 미지원 표시 주식·ETF 15:30). NXT 여부를 모르면 기다림. 토스 일봉 종가로 채우지 않습니다(G2 — 20:00까지
 *       체결이 섞여 18/21 다름). 금융위 종가가 들어오면 확정 조정이 그 값으로 고칩니다.</li>
 *   <li>1분봉 상태가 실패(FAILED)이거나 아직 없으면 기다립니다 — 수집기가 다음 slow 주기에 다시 묻습니다. 그날 봉이 없으면(NO_BARS — 거래 정지 등) 체결하지
 *       않습니다. 마감 봉을 덮지 못하는 이른 저장본(그날 마감 + 10분 전에 받음 — 장 시간 변경일)이면 종가는 기다립니다.</li>
 * </ul>
 */
final class KrTimedLadder {

    private KrTimedLadder() {
    }

    /** 한국 체결가 출처(§4-14 {@code paper_fills.price_source}) — 매시 T 봉 시가. */
    static final String SOURCE_AT = "TOSS_1M_AT";
    /** T 봉에 거래가 없어 창 안 첫 거래 봉 시가. */
    static final String SOURCE_NEXT = "TOSS_1M_NEXT";
    /** 창 안 거래가 없어 그날 T 뒤 첫 거래 봉 시가(대체). */
    static final String SOURCE_LATE = "TOSS_1M_LATE";
    /** 마감 단일가 봉 종가. */
    static final String SOURCE_CLOSE = "TOSS_1M_CLOSE";

    /** 매시 시점 → 기준 시각(KST). 수집기 KR_TIMED_HOURS와 같은 시각. */
    static final Map<String, LocalTime> HOURLY = Map.of(
            PaperBooks.AT_1000, LocalTime.of(10, 0), PaperBooks.AT_1100, LocalTime.of(11, 0),
            PaperBooks.AT_1200, LocalTime.of(12, 0), PaperBooks.AT_1300, LocalTime.of(13, 0),
            PaperBooks.AT_1400, LocalTime.of(14, 0), PaperBooks.AT_1500, LocalTime.of(15, 0));

    /** 마감 봉을 덮었다고 보는 저장본 — 그날 마감 이만큼 뒤에 받음(수집기 KR_TIMED_AFTER가 보통 날 마감 + 10분). */
    static final Duration CLOSE_COVERED_AFTER = Duration.ofMinutes(10);

    /** 사다리 결과 — 체결 또는 기다림 사유. */
    record Result(Choice choice, String reason) {
    }

    /** 매시 시점의 기준 시각, 매시 시점이 아니면 null. */
    static LocalTime hourly(String timing) {
        return timing == null ? null : HOURLY.get(timing);
    }

    static String label(LocalTime time) {
        return String.format(Locale.ROOT, "%02d:%02d", time.getHour(), time.getMinute());
    }

    /**
     * 그 주문 시점의 E 체결가(클래스 설명).
     *
     * @param collectedAt 관측치 저장본을 받은 시각(쓰지 않음 — 기다림의 끝은 수집기 다시 묻기)
     * @param deadline    그 봉 날짜 밤의 결정 기한 — 실패가 그 뒤에도 남으면 사유에 적음
     */
    static Result price(String timing, Quote quote, LocalDate session, Instant collectedAt, TradingCalendar calendar,
                        Instant deadline) {
        Timed timed = quote.timedOn(session);
        String head = session + " " + timing;
        if (timed == null) {
            return new Result(null, head + " — 목표 세션 1분봉(paper.kr.timed)을 아직 받지 않음(수집기 kr_paper_timed — 세션 15:40 뒤) · 기다림");
        }
        if (KrQuotes.TIMED_NO_BARS.equals(timed.status())) {
            return new Result(null, head + " — 그날 1분봉 없음(거래 정지 등) · 체결하지 않음(만료까지)");
        }
        if (!KrQuotes.TIMED_OK.equals(timed.status())) {
            return new Result(null, head + " — 1분봉 " + timed.status() + (timed.reason() == null ? "" : "(" + timed.reason() + ")")
                    + " · 수집기가 다시 묻는 중이라 기다림" + (collectedAt != null && !collectedAt.isBefore(deadline)
                    ? "(결정 기한 " + Kst.stamp(deadline) + " 지남)" : ""));
        }
        LocalTime close = calendar.closeInstant(session).atZone(KrxCalendar.SEOUL).toLocalTime();
        if (PaperBooks.NEXT_CLOSE.equals(timing)) {
            if (quote.nxtSupported() == null) {
                return new Result(null, head + " — NXT 여부를 몰라 마감 봉 라벨(15:30·15:31)을 고르지 못함 · 기다림");
            }
            if (timed.fetchedAt() != null && timed.fetchedAt().isBefore(calendar.closeInstant(session).plus(CLOSE_COVERED_AFTER))) {
                return new Result(null, head + " — 1분봉 저장본이 그날 마감 + 10분 전에 받은 것이라 마감 봉을 덮지 못함 · 기다림");
            }
            String label = label(Boolean.TRUE.equals(quote.nxtSupported()) ? close.plusMinutes(1) : close);
            Close1m bar = timed.closes().get(label);
            if (bar == null || bar.close() == null || bar.volume() == null || bar.volume() <= 0) {
                return new Result(null, head + " — 마감 단일가 봉(라벨 " + label + ") " + (bar == null ? "없음" : "거래 없음")
                        + " · 토스 일봉 종가로 채우지 않음(G2) — 만료까지");
            }
            return new Result(new Choice(session, bar.close(), SOURCE_CLOSE, null), null);
        }
        LocalTime at = hourly(timing);
        if (at == null || !at.isBefore(close)) {
            return new Result(null, head + " — 그날 마감(" + label(close) + ") 전의 매시 시점이 아님 · 체결하지 않음(만료까지)");
        }
        String key = label(at);
        List<Bar1m> window = timed.windows().getOrDefault(key, List.of());
        String first = label(at.plusMinutes(1));
        for (Bar1m bar : window) {
            if (bar.traded()) {
                boolean exact = first.equals(bar.label());
                return new Result(new Choice(session, bar.open(), exact ? SOURCE_AT : SOURCE_NEXT,
                        exact ? null : key + " 봉(라벨 " + first + ") 거래 없음 → 라벨 " + bar.label() + " 봉 시가(창 안 첫 거래 봉)"), null);
            }
        }
        Bar1m late = timed.firstAfter().get(key);
        String closeLabel = label(close.plusMinutes(1));
        if (late != null && late.traded() && late.label().compareTo(closeLabel) <= 0) {
            return new Result(new Choice(session, late.open(), SOURCE_LATE,
                    key + " 창(라벨 " + first + "~) 안 거래 없음 → 그날 T 뒤 첫 거래 봉(라벨 " + late.label() + ") 시가(대체)"), null);
        }
        return new Result(null, head + " — 그날 " + key + " 뒤 정규장 거래 없음(거래 정지·무거래 가능) · 체결하지 않음(만료까지)");
    }
}
