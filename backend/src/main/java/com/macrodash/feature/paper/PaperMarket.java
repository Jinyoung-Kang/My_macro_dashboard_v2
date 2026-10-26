package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

/**
 * 🧪 모의 매매 시장 하나의 묶음 — 장부 코어가 시장마다 다르게 쓰는 값(달력·관측치·확정 판정·체결 시점·계좌 정의·결정 시각·
 * 복기 시각·통화·설정과 작업 기록의 이름)을 한곳에 둡니다(2단계 명세 2026-10-26-v2-kr-paper-spec.md §9 A4).
 *
 * <p>모든 것을 이 뒤로 보내지는 않습니다. 13F 선정·미국 패킷·게이트·일정/뉴스/재무 섹션은 자료부터 달라 미국 전용으로 남고, 한국은
 * 따로 만듭니다. 비용(수수료·세금)·출발일·초기 현금·금액 표기는 그것을 쓰는 묶음(B6·C1·A7)에서 정합니다.
 *
 * <p>구현은 지금 미국 하나({@link UsPaperMarket#INSTANCE})이고 값은 이 묶음 전의 상수 그대로입니다({@code UsPaperMarketTest}가
 * 고정). 장부·작업·조회가 이 묶음으로 옮겨 가는 것은 A5·A6입니다.
 */
interface PaperMarket {

    /** 시장 코드 — {@code paper_books.market}(US·KR, V13)과 같은 문자열. */
    String code();

    /** 장부 통화 — {@code paper_books.currency}(USD·KRW, V13)와 같은 문자열. */
    String currency();

    /** 세션 날짜를 정하고 체결·만료·재진입 금지·통계 표본을 세는 거래일 달력. */
    TradingCalendar calendar();

    /** 장부 관측치 스냅샷의 데이터셋 — 그 관측치로 체결하면 체결 가격 출처({@code paper_fills.price_source})도 이 이름. */
    String quotesDataset();

    /** 종가 이력(timeseries)의 데이터셋 — 사후 체결·분할 감지·패킷 수익률. 그 이력으로 체결하면 가격 출처도 이 이름. */
    String historyDataset();

    /** 마감 뒤 이만큼 지나 수집한 봉을 확정 종가로 봅니다. */
    Duration finalDelay();

    /**
     * 그 봉이 확정 종가인가: 봉 날짜가 거래일이고, 저장본을 그날 마감 + {@link #finalDelay} 이후에 수집함. 지난 세션의 봉
     * (휴장·거래 정지로 오늘 봉이 없음)은 마감이 이미 지났으므로 확정입니다.
     */
    default boolean isFinal(LocalDate barDate, Instant collectedAt) {
        TradingCalendar calendar = calendar();
        return calendar.isTradingDay(barDate)
                && !collectedAt.isBefore(calendar.closeInstant(barDate).plus(finalDelay()));
    }

    /** 이 시장의 책 정의 — 초기화가 만드는 책이고, 화면에 보이는 순서입니다. */
    List<PaperBooks.Definition> books();

    /** 규칙 책(동결 대조군)의 코드. */
    String rulesBook();

    /** Claude 책(실험군)의 코드. */
    String claudeBook();

    /** 통계(초과·베타)의 비교 기준 책 코드. */
    String benchmarkBook();

    /** 그 책의 비교 기준 책 — 기준 책 자신은 기준이 없습니다(null). */
    default String benchmarkOf(String bookCode) {
        return benchmarkBook().equals(bookCode) ? null : benchmarkBook();
    }

    /** 설정에 현금성 종목 키가 없을 때의 현금성 종목(스탑을 걸지 않고 비중 상한·종목 수·최소 보유일에서 빠짐). */
    List<String> defaultCashLike();

    /** Claude가 고를 수 있는 체결 시점({@code paper_orders.timing}), 이른 것부터. */
    List<String> timings();

    /** 가장 이른 체결 시점 — 규칙 책 주문의 시점이고, 검증기가 '같은 시점 매도만 자리를 만든다'고 보는 시점. */
    String earlyTiming();

    /** 결정 시각(KST)의 기본값 — 설정 값이 없거나 틀릴 때. */
    LocalTime defaultDecisionTime();

    /** 확정 종가를 기다리는 기한(KST)의 기본값 — 설정 값이 없거나 틀릴 때. */
    LocalTime defaultDeadline();

    /**
     * 세션 날짜에 딸린 KST 시각의 순간 — 그 세션의 결정 시각·확정 종가 기한·사건 창 끝이 이 식으로 순간이 됩니다(세션 날짜와 결정
     * 시각의 관계가 시장마다 달라서).
     */
    Instant decisionInstant(LocalDate session, LocalTime kstTime);

    /** 주간 복기가 열리는 요일(KST) — 시장별 코드 상수(명세 K38). */
    DayOfWeek reviewOpensOn();

    /** 주간 복기가 열리는 시각(KST) — 시장별 코드 상수(명세 K38). */
    LocalTime reviewOpensAt();

    /** 설정 키의 접두어(같은 설정 한 행 안의 묶음). */
    String settingsPrefix();

    /** 이 시장의 설정 키 — 접두어 + 키. */
    default String settingKey(String key) {
        return settingsPrefix() + key;
    }

    /** 작업 기록 이름({@code paper_job_runs.job})의 접두어 — 시장마다 작업 기록을 따로 셉니다(작업마다 최근 200건). */
    String jobPrefix();

    /** 이 시장의 작업 기록 이름 — 접두어 + 작업 이름. */
    default String jobName(String job) {
        return jobPrefix() + job;
    }
}
