package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;

/**
 * ISA 계좌가 보는 모의 한국 달력(장 시간 변경일 설정 반영 — {@link PaperMirrorService#sessionHours})의 세 질문 — 다음 개장 세션, 마지막으로 개장한 세션,
 * 그 세션 전 거래일. 달력이 모르는 날을 만나면 null(그 주기는 쉼).
 */
final class ManualAccountCalendar {

    private ManualAccountCalendar() {
    }

    /** 찾는 최대 날 수(연휴 포함 충분히). */
    static final int SEARCH_DAYS = 14;

    /** 개장 순간이 {@code now}보다 뒤인 첫 세션(오늘 개장 전이면 오늘). 모르면 null. */
    static SessionHours nextSession(PaperMirrorService paper, Instant now) {
        LocalDate day = LocalDate.ofInstant(now, Kst.ZONE);
        for (int i = 0; i < SEARCH_DAYS; i++) {
            Optional<SessionHours> hours = paper.sessionHours(day.plusDays(i));
            if (hours.isEmpty()) {
                return null;
            }
            if (hours.get().tradingDay() && hours.get().open() != null && hours.get().open().isAfter(now)) {
                return hours.get();
            }
        }
        return null;
    }

    /** 개장 순간이 {@code now} 이하인 가장 늦은 세션(오늘 개장 뒤면 오늘). 모르면 null. */
    static SessionHours lastOpened(PaperMirrorService paper, Instant now) {
        LocalDate day = LocalDate.ofInstant(now, Kst.ZONE);
        for (int i = 0; i < SEARCH_DAYS; i++) {
            Optional<SessionHours> hours = paper.sessionHours(day.minusDays(i));
            if (hours.isEmpty()) {
                return null;
            }
            if (hours.get().tradingDay() && hours.get().open() != null && !hours.get().open().isAfter(now)) {
                return hours.get();
            }
        }
        return null;
    }

    /** 그 세션 전 거래일(결정일 D). 모르면 null. */
    static LocalDate previousTradingDay(PaperMirrorService paper, LocalDate session) {
        for (int i = 1; i <= SEARCH_DAYS; i++) {
            Optional<SessionHours> hours = paper.sessionHours(session.minusDays(i));
            if (hours.isEmpty()) {
                return null;
            }
            if (hours.get().tradingDay()) {
                return hours.get().date();
            }
        }
        return null;
    }

    /** 그 세션의 개장·마감(거래일이 아니거나 모르면 null). */
    static SessionHours hours(PaperMirrorService paper, LocalDate session) {
        return paper.sessionHours(session).filter(SessionHours::tradingDay).orElse(null);
    }
}
