package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 규칙 계좌의 체결 시각 설정({@link RuleTiming} — ADR 0027 결정 5): 읽기(기본값·받는 목록 밖은 기본), 그 결정의 주문 시점 고르기(닫힌 시점이면 기본 시점과
 * 사유), 저장 검사(AT_MINUTE의 지정 시각 범위). 상태가 없는 계산입니다 — 주문 행·다시 내기는 규칙 계좌·장부 시험이 봅니다.
 *
 * <p>시각: 미국 기준 거래일 d = 2026-10-26(월), 목표 세션 E = 10-27(화, 09:30 ET = 13:30Z). 조기 폐장일 E = 11-27(d = 11-25). 한국 d = 12-01, E = 12-02.
 */
class RuleTimingTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate MON = LocalDate.of(2026, 10, 26);
    private static final Instant NIGHT = Instant.parse("2026-10-26T21:40:00Z");

    private static JsonNode body(String json) {
        return MAPPER.readTree(json);
    }

    @Test
    @DisplayName("읽기: 키가 없거나 받는 목록 밖이면 기본(미국 다음 관측치·한국 시가) — 이 키가 생기기 전의 설정 행, 한국은 NEXT_OBSERVATION을 받지 않음")
    void readsWithDefaults() {
        assertThat(RuleTiming.us(null)).isEqualTo(new RuleTiming("NEXT_OBSERVATION", null));
        assertThat(RuleTiming.us(body("{\"rules\":{\"parkCashThresholdPct\":2}}")).standard(false)).isTrue();
        assertThat(RuleTiming.us(body("{\"rules\":{\"timing\":\"AT_1000\",\"timingAtEt\":\"10:00\"}}")).timing())
                .as("매시 정각 이름은 규칙 계좌가 받지 않음").isEqualTo("NEXT_OBSERVATION");
        RuleTiming minute = RuleTiming.us(body("{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtEt\":\"10:47\"}}"));
        assertThat(minute).isEqualTo(new RuleTiming("AT_MINUTE", LocalTime.of(10, 47)));
        assertThat(minute.standard(false)).isFalse();
        assertThat(minute.label()).isEqualTo("AT_MINUTE 10:47");

        assertThat(RuleTiming.kr(body("{}"))).isEqualTo(new RuleTiming("NEXT_OPEN", null));
        assertThat(RuleTiming.kr(body("{\"kr\":{\"rules\":{\"timing\":\"NEXT_OBSERVATION\"}}}")).timing()).isEqualTo("NEXT_OPEN");
        RuleTiming close = RuleTiming.kr(body("{\"kr\":{\"rules\":{\"timing\":\"NEXT_CLOSE\",\"timingAtKst\":\"10:00\"}}}"));
        assertThat(close.timing()).isEqualTo("NEXT_CLOSE");
        assertThat(close.standard(true)).isFalse();
        assertThat(RuleTiming.US_OPTIONS.get(0)).isEqualTo(ExecutionAudit.NEXT_OBSERVATION);
        assertThat(RuleTiming.KR_OPTIONS.get(0)).isEqualTo(PaperBooks.NEXT_OPEN);
    }

    @Test
    @DisplayName("고르기(미국): 기본 설정은 늘 기본 시점. 지정 시각·시가·종가는 다음 세션에서 받는 범위 안이고 지금 + 60초 뒤면 그 시점 — 조기 폐장일의 범위 밖 "
            + "시각·세션 도중에 이미 지난 시가와 지정 시각은 기본 시점으로 내고 사유를 남김")
    void choosesForTheUsSession() {
        assertThat(new RuleTiming("NEXT_OBSERVATION", LocalTime.of(10, 0)).choose(MON, NIGHT, US, false))
                .isEqualTo(new RuleTiming.Chosen("NEXT_OBSERVATION", null, null));

        RuleTiming minute = new RuleTiming("AT_MINUTE", LocalTime.of(14, 30));
        assertThat(minute.choose(MON, NIGHT, US, false)).isEqualTo(new RuleTiming.Chosen("AT_MINUTE", LocalTime.of(14, 30), null));
        RuleTiming.Chosen early = minute.choose(LocalDate.of(2026, 11, 25), Instant.parse("2026-11-25T22:00:00Z"), US, false);
        assertThat(early.timing()).as("조기 폐장일(11-27 마감 13:00) — 14:30은 범위 밖").isEqualTo("NEXT_OBSERVATION");
        assertThat(early.at()).isNull();
        assertThat(early.note()).contains("AT_MINUTE 14:30").contains("09:31~12:54 ET").contains("기본 시점(NEXT_OBSERVATION)");
        RuleTiming.Chosen passed = minute.choose(MON, Instant.parse("2026-10-27T18:29:30Z"), US, false);
        assertThat(passed.timing()).as("세션 도중의 결정 — 14:30까지 60초가 남지 않음").isEqualTo("NEXT_OBSERVATION");
        assertThat(passed.note()).contains("이미 지남");
        assertThat(minute.choose(MON, Instant.parse("2026-10-27T18:28:59Z"), US, false).timing()).isEqualTo("AT_MINUTE");
        assertThat(new RuleTiming("AT_MINUTE", null).choose(MON, NIGHT, US, false).note()).contains("지정 시각이 없음");

        RuleTiming open = new RuleTiming("NEXT_OPEN", null);
        assertThat(open.choose(MON, NIGHT, US, false)).isEqualTo(new RuleTiming.Chosen("NEXT_OPEN", null, null));
        assertThat(open.choose(MON, Instant.parse("2026-10-27T13:30:00Z"), US, false).note()).contains("개장이 이미 지남");
        RuleTiming close = new RuleTiming("NEXT_CLOSE", LocalTime.of(10, 0));
        assertThat(close.choose(MON, Instant.parse("2026-10-27T19:00:00Z"), US, false))
                .as("종가는 지정 시각을 읽지 않음").isEqualTo(new RuleTiming.Chosen("NEXT_CLOSE", null, null));
        assertThat(close.choose(MON, Instant.parse("2026-10-27T20:00:00Z"), US, false).note()).contains("마감이 이미 지남");
    }

    @Test
    @DisplayName("고르기(한국): 지정 시각은 다음 거래일의 09:01~15:19 KST 안 — 종가 단일가 시간(15:20)은 범위 밖이라 시가로, 기본 설정은 시가")
    void choosesForTheKrSession() {
        LocalDate d = LocalDate.of(2026, 12, 1);
        Instant night = Instant.parse("2026-12-01T13:30:00Z");
        assertThat(new RuleTiming("NEXT_OPEN", null).choose(d, night, KR, true)).isEqualTo(new RuleTiming.Chosen("NEXT_OPEN", null, null));
        assertThat(new RuleTiming("AT_MINUTE", LocalTime.of(9, 1)).choose(d, night, KR, true))
                .isEqualTo(new RuleTiming.Chosen("AT_MINUTE", LocalTime.of(9, 1), null));
        RuleTiming.Chosen auction = new RuleTiming("AT_MINUTE", LocalTime.of(15, 20)).choose(d, night, KR, true);
        assertThat(auction.timing()).isEqualTo("NEXT_OPEN");
        assertThat(auction.note()).contains("09:01~15:19 KST").contains("기본 시점(NEXT_OPEN)");
        assertThat(new RuleTiming("NEXT_CLOSE", null).choose(d, night, KR, true)).isEqualTo(new RuleTiming.Chosen("NEXT_CLOSE", null, null));
    }

    @Test
    @DisplayName("저장 검사: AT_MINUTE이면 지정 시각이 HH:MM이고 보통 날 범위(미국 09:31~15:54 ET·한국 09:01~15:19 KST) 안이어야 함 — 다른 시점은 지정 시각을 "
            + "보지 않음")
    void validatesTheSavedBody() {
        assertThat(RuleTiming.invalid(body("{}"))).isNull();
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"NEXT_CLOSE\",\"timingAtEt\":\"23:00\"}}"))).isNull();
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtEt\":\"09:31\"}}"))).isNull();
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtEt\":\"15:54\"}}"))).isNull();
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtEt\":\"09:30\"}}")))
                .contains("rules.timingAtEt").contains("09:31~15:54 ET").contains("09:30");
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtEt\":\"15:55\"}}"))).isNotNull();
        assertThat(RuleTiming.invalid(body("{\"rules\":{\"timing\":\"AT_MINUTE\"}}"))).as("시각 없음").isNotNull();
        assertThat(RuleTiming.invalid(body("{\"kr\":{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtKst\":\"15:20\"}}}")))
                .contains("kr.rules.timingAtKst").contains("09:01~15:19 KST");
        assertThat(RuleTiming.invalid(body("{\"kr\":{\"rules\":{\"timing\":\"AT_MINUTE\",\"timingAtKst\":\"15:19\"}}}"))).isNull();
    }
}
