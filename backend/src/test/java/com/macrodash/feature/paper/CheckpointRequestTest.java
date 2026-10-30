package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.UsMarketCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 확인 요청의 의미 검사({@link CheckpointRequest}, 계좌2 명세 §9-5·§10-5 {@code CHECKPOINT_INVALID}) — 시각 경계(보통 날 15:00·조기 폐장일
 * 12:30), 지난 시각, MINUTE 빈 감시, 유니버스 밖, 중복, 질문 공백.
 */
class CheckpointRequestTest {

    /** 보통 날(화). */
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    /** 조기 폐장일(추수감사절 다음 날 — 13:00 ET 마감). */
    private static final LocalDate EARLY = LocalDate.of(2026, 11, 27);
    /** 결정 시각 — 10-26 23:00Z(전날 마감 뒤). */
    private static final Instant NIGHT_BEFORE = Instant.parse("2026-10-26T23:00:00Z");
    private static final Set<String> UNIVERSE = Set.of("AAA", "BBB", "SPY");

    private static JsonNode request(String atEt, String feed, String watch, String question) {
        return MAPPER.readTree("{\"atEt\":\"" + atEt + "\",\"feed\":\"" + feed + "\",\"watch\":" + watch + ",\"question\":"
                + (question == null ? "null" : "\"" + question + "\"") + "}");
    }

    private static CheckpointRequest.Verdict check(JsonNode request, LocalDate session, Instant now) {
        return CheckpointRequest.validate(request, session, UsMarketCalendar.CALENDAR, UNIVERSE, now);
    }

    @Test
    @DisplayName("시각 경계 — 보통 날 15:00 통과(마감 − 30분 = 15:30), 조기 폐장일 12:30 통과·13:00 거절('조기 폐장일')")
    void timeBoundaries() {
        assertThat(check(request("15:00", "HOURLY", "[]", "q"), TUE, NIGHT_BEFORE).accepted()).isTrue();
        assertThat(check(request("10:00", "MINUTE", "[\"AAA\"]", "q"), TUE, NIGHT_BEFORE).accepted()).isTrue();
        Instant beforeEarly = Instant.parse("2026-11-26T23:00:00Z");
        assertThat(UsMarketCalendar.CALENDAR.isEarlyClose(EARLY)).isTrue();
        assertThat(check(request("12:30", "HOURLY", "[]", "q"), EARLY, beforeEarly).accepted()).isTrue();
        CheckpointRequest.Verdict late = check(request("13:00", "HOURLY", "[]", "q"), EARLY, beforeEarly);
        assertThat(late.accepted()).isFalse();
        assertThat(late.reasons()).singleElement().asString().contains("12:30 ET").contains("조기 폐장일");
        assertThat(late.reason()).startsWith(OrderValidator.CHECKPOINT_INVALID + " — ");
        assertThat(check(request("15:00", "HOURLY", "[]", "q"), EARLY, beforeEarly).accepted()).isFalse();
    }

    @Test
    @DisplayName("지난 시각 — 확인 시각 + 2분(호출 창 시작)이 이미 지났으면 거절(늦은 수동 결정), 바로 앞이면 통과")
    void passedTime() {
        // 10-27 10:00 ET(EDT) = 14:00Z — 창 시작 14:02Z.
        assertThat(check(request("10:00", "HOURLY", "[]", "q"), TUE, Instant.parse("2026-10-27T14:01:59Z")).accepted())
                .isTrue();
        CheckpointRequest.Verdict passed = check(request("10:00", "HOURLY", "[]", "q"), TUE,
                Instant.parse("2026-10-27T14:02:00Z"));
        assertThat(passed.reasons()).singleElement().asString().contains("이미 지남");
        assertThat(check(request("11:00", "HOURLY", "[]", "q"), TUE, Instant.parse("2026-10-27T14:02:00Z")).accepted())
                .isTrue();
    }

    @Test
    @DisplayName("감시 목록 — MINUTE 빈 목록 거절(HOURLY는 빈 목록 통과), 중복·유니버스 밖 거절(사유에 그 티커), 10개 초과 거절")
    void watchList() {
        assertThat(check(request("10:30", "MINUTE", "[]", "q"), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("MINUTE").contains("비어");
        assertThat(check(request("10:30", "HOURLY", "[]", "q"), TUE, NIGHT_BEFORE).accepted()).isTrue();
        assertThat(check(request("10:30", "MINUTE", "[\"AAA\",\"AAA\"]", "q"), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("중복").contains("AAA");
        assertThat(check(request("10:30", "MINUTE", "[\"AAA\",\"ZZZ\"]", "q"), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("유니버스 밖").contains("ZZZ");
        String eleven = "[\"AAA\",\"BBB\",\"SPY\",\"AAA\",\"BBB\",\"SPY\",\"AAA\",\"BBB\",\"SPY\",\"AAA\",\"BBB\"]";
        assertThat(check(request("10:30", "HOURLY", eleven, "q"), TUE, NIGHT_BEFORE).reasons())
                .anySatisfy(r -> assertThat(r).contains("10개 초과"));
    }

    @Test
    @DisplayName("피드·시각 글자·질문 — 스키마가 막는 값도 다시 봄(API용 스키마는 제약을 걷어 냄): 모르는 피드·격자 밖 시각(10:15)·질문 공백·null")
    void schemaLevelValuesAreCheckedAgain() {
        assertThat(check(request("10:30", "TICK", "[\"AAA\"]", "q"), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("TICK");
        assertThat(check(request("10:15", "HOURLY", "[]", "q"), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("10:15");
        assertThat(check(request("10:30", "HOURLY", "[]", "   "), TUE, NIGHT_BEFORE).reasons())
                .singleElement().asString().contains("질문");
        assertThat(check(request("10:30", "HOURLY", "[]", null), TUE, NIGHT_BEFORE).accepted()).isFalse();
        CheckpointRequest.Verdict many = check(request("15:30", "MINUTE", "[]", " "), TUE, NIGHT_BEFORE);
        assertThat(many.reasons()).hasSize(3);
        assertThat(many.reason()).contains("; ");
    }
}
