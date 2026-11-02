package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 Claude 계좌2 장중 확인 요청의 의미 검사({@link KrCheckpointRequest}, 단계 2b — 명세 2026-11-02 §10) — 시각 목록(10:00~15:00 KST 30분 단위),
 * 장 시간 변경일의 개장 + 30분·마감 − 30분, 지난 시각, 빈 감시(한국은 늘 1분봉), 10개 초과, 중복, 유니버스 밖, 질문 공백.
 */
class KrCheckpointRequestTest {

    /** 보통 날(화) — 09:00~15:30. */
    private static final LocalDate E = LocalDate.of(2026, 11, 3);
    private static final Instant NIGHT_BEFORE = kst("2026-11-02T22:40");
    private static final Set<String> UNIVERSE = Set.of("005930", "000660", "035720");
    private static final TradingCalendar CALENDAR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    /** 장 시간 변경일(수능일 꼴) — 10:00~16:30. */
    private static final TradingCalendar SHIFTED = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
            Map.of(E, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));

    private static Instant kst(String dateTime) {
        return LocalDateTime.parse(dateTime).atZone(KrxCalendar.SEOUL).toInstant();
    }

    private static JsonNode request(String at, String watch, String question) {
        return MAPPER.readTree("{\"atKst\":\"" + at + "\",\"watch\":" + watch + ",\"question\":"
                + (question == null ? "null" : "\"" + question + "\"") + "}");
    }

    private static CheckpointRequest.Verdict check(JsonNode request, TradingCalendar calendar, Instant now) {
        return KrCheckpointRequest.validate(request, E, calendar, UNIVERSE, now);
    }

    @Test
    @DisplayName("시각 — 10:00~15:00 KST 30분 단위만, 보통 날 10:00·15:00 통과, 목록 밖(09:30·15:30·10:15) 거절")
    void times() {
        assertThat(KrCheckpointRequest.TIMES).hasSize(11).first().isEqualTo(LocalTime.of(10, 0));
        assertThat(KrCheckpointRequest.TIMES).last().isEqualTo(LocalTime.of(15, 0));
        assertThat(check(request("10:00", "[\"005930\"]", "q"), CALENDAR, NIGHT_BEFORE).accepted()).isTrue();
        assertThat(check(request("15:00", "[\"005930\"]", "q"), CALENDAR, NIGHT_BEFORE).accepted()).isTrue();
        for (String at : List.of("09:30", "15:30", "10:15", "아무때나")) {
            CheckpointRequest.Verdict bad = check(request(at, "[\"005930\"]", "q"), CALENDAR, NIGHT_BEFORE);
            assertThat(bad.accepted()).as(at).isFalse();
            assertThat(bad.reason()).startsWith(OrderValidator.CHECKPOINT_INVALID + " — ").contains("10:00~15:00 KST 30분 단위");
        }
    }

    @Test
    @DisplayName("장 시간 변경일(10:00~16:30) — 10:00은 개장 + 30분 전이라 거절, 10:30부터 통과, 15:00은 마감 − 30분(16:00) 안")
    void shiftedHours() {
        CheckpointRequest.Verdict early = check(request("10:00", "[\"005930\"]", "q"), SHIFTED, NIGHT_BEFORE);
        assertThat(early.reasons()).singleElement().asString().contains("개장 30분 뒤(10:30 KST) 전");
        assertThat(check(request("10:30", "[\"005930\"]", "q"), SHIFTED, NIGHT_BEFORE).accepted()).isTrue();
        assertThat(check(request("15:00", "[\"005930\"]", "q"), SHIFTED, NIGHT_BEFORE).accepted()).isTrue();
    }

    @Test
    @DisplayName("지난 시각 — 확인 시각 + 2분이 이미 지났으면 거절(늦은 수동 결정), 바로 앞이면 통과")
    void passed() {
        assertThat(check(request("11:00", "[\"005930\"]", "q"), CALENDAR, kst("2026-11-03T11:01:59")).accepted()).isTrue();
        assertThat(check(request("11:00", "[\"005930\"]", "q"), CALENDAR, kst("2026-11-03T11:02")).reasons())
                .singleElement().asString().contains("호출 창 시작").contains("이미 지남");
    }

    @Test
    @DisplayName("감시 목록 — 비면 거절(한국은 늘 1분봉), 10개 초과·중복·유니버스 밖 거절, 질문 공백 거절")
    void watchAndQuestion() {
        assertThat(check(request("11:00", "[]", "q"), CALENDAR, NIGHT_BEFORE).reasons()).singleElement().asString()
                .contains("감시 목록이 비어 있음");
        String eleven = "[\"005930\",\"000660\",\"035720\",\"A1\",\"A2\",\"A3\",\"A4\",\"A5\",\"A6\",\"A7\",\"A8\"]";
        assertThat(check(request("11:00", eleven, "q"), CALENDAR, NIGHT_BEFORE).reasons()).anySatisfy(r -> assertThat(r).contains("11개 — 10개 초과"));
        CheckpointRequest.Verdict dup = check(request("11:00", "[\"005930\",\"005930\",\"999999\"]", " "), CALENDAR, NIGHT_BEFORE);
        assertThat(dup.reasons()).containsExactly("감시 목록 중복: 005930", "감시 목록의 유니버스 밖 종목: 999999", "질문이 비어 있음");
        assertThat(KrCheckpointRequest.FEED).isEqualTo(ExecutionSection.FEED_MINUTE);
    }
}
