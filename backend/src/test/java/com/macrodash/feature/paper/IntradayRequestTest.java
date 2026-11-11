package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.OrderValidator;
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
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 자유 시점 판의 장중 판단 예약 의미 검사({@link IntradayRequest} — ADR 0027 결정 3·ADR 0031): 받는 범위(미국 개장 10분 뒤 ~ 마감 30분 전, 한국 개장 10분 뒤 ~
 * 종가 단일가 시작 30분 전), 지난 시각, 20분 간격, 세션당 횟수(최대 3), 감시 목록·피드·질문. 어긴 항목만 버리고 사유를 남깁니다.
 *
 * <p>시각: 미국 목표 세션 E = 2026-10-27(화, 서머타임 — 09:30 ET = 13:30Z), 검사 시각은 그 전날 저녁. 한국 E = 2026-11-03(화).
 */
class IntradayRequestTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    private static final LocalDate EARLY_CLOSE = LocalDate.of(2026, 11, 27);
    private static final LocalDate KR_E = LocalDate.of(2026, 11, 3);
    private static final Instant NIGHT = Instant.parse("2026-10-26T23:00:00Z");
    private static final Set<String> UNIVERSE = Set.of("AAA", "BBB", "SHY");
    private static final Set<String> KR_UNIVERSE = Set.of("005930", "000660");

    private static String item(String at, String feed, String watch, String question) {
        return "{\"at\":" + (at == null ? "null" : "\"" + at + "\"") + (feed == null ? "" : ",\"feed\":\"" + feed + "\"")
                + ",\"watch\":" + watch + ",\"question\":" + (question == null ? "null" : "\"" + question + "\"") + "}";
    }

    private static JsonNode list(String... items) {
        return MAPPER.readTree("[" + String.join(",", items) + "]");
    }

    private static IntradayRequest.Verdict us(JsonNode requests, int max, List<LocalTime> taken) {
        return IntradayRequest.validate(requests, TUE, US, UNIVERSE, NIGHT, max, taken, false);
    }

    @Test
    @DisplayName("받는 범위: 미국 09:40~15:30 ET(양 끝 포함), 조기 폐장일은 12:30까지, 한국 09:10~14:50 KST(수능일 10:10~15:50) — 밖이면 그 항목만 버리고 "
            + "사유에 범위를 적음")
    void windowPerMarket() {
        assertThat(IntradayRequest.AFTER_OPEN).isEqualTo(com.macrodash.analytics.SessionWindows.OPEN_OFFSET).hasMinutes(10);
        IntradayRequest.Window us = IntradayRequest.window(TUE, US, false);
        assertThat(us.first()).isEqualTo(Instant.parse("2026-10-27T13:40:00Z"));
        assertThat(us.last()).isEqualTo(Instant.parse("2026-10-27T19:30:00Z"));
        assertThat(IntradayRequest.window(EARLY_CLOSE, US, false).last()).as("마감 13:00 ET(18:00Z)의 30분 전")
                .isEqualTo(Instant.parse("2026-11-27T17:30:00Z"));
        IntradayRequest.Window kr = IntradayRequest.window(KR_E, KR, true);
        assertThat(kr.first()).as("09:10 KST").isEqualTo(Instant.parse("2026-11-03T00:10:00Z"));
        assertThat(kr.last()).as("14:50 KST — 종가 단일가(15:20) 30분 전").isEqualTo(Instant.parse("2026-11-03T05:50:00Z"));

        // 범위의 앞 끝(09:40)은 감시 1분봉으로 봅니다 — 미국 HOURLY는 10:10 ET부터 받습니다(QA-359, earlyHourlyIsRejected).
        IntradayRequest.Verdict edges = us(list(item("09:40", "MINUTE", "[\"AAA\"]", "개장 뒤"), item("15:30", "HOURLY", "[]", "마감 전")), 2,
                List.of());
        assertThat(edges.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(9, 40), LocalTime.of(15, 30));
        assertThat(edges.rejected()).isEmpty();

        IntradayRequest.Verdict outside = us(list(item("09:39", "HOURLY", "[]", "이름"), item("15:31", "HOURLY", "[]", "늦음"),
                item("09:35", "HOURLY", "[]", "옛 첫 시각")), 3, List.of());
        assertThat(outside.accepted()).isEmpty();
        assertThat(outside.rejected()).extracting(IntradayRequest.Rejected::at).containsExactly("09:39", "15:31", "09:35");
        assertThat(outside.rejected().get(0).reason()).startsWith(OrderValidator.CHECKPOINT_INVALID).contains("09:40~15:30 ET");

        IntradayRequest.Verdict early = IntradayRequest.validate(list(item("12:30", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")),
                EARLY_CLOSE, US, UNIVERSE, NIGHT, 2, List.of(), false);
        assertThat(early.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(12, 30));
        assertThat(early.rejected().get(0).reason()).contains("09:40~12:30 ET");

        IntradayRequest.Verdict korea = IntradayRequest.validate(list(item("09:10", null, "[\"005930\"]", "q"),
                item("14:51", null, "[\"005930\"]", "q"), item("09:09", null, "[\"005930\"]", "q")), KR_E, KR, KR_UNIVERSE,
                Instant.parse("2026-11-02T13:30:00Z"), 3, List.of(), true);
        assertThat(korea.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(9, 10));
        assertThat(korea.accepted().get(0).feed()).as("한국은 늘 감시 1분봉").isEqualTo(ExecutionSection.FEED_MINUTE);
        assertThat(korea.rejected()).extracting(IntradayRequest.Rejected::at).containsExactly("14:51", "09:09");
        assertThat(korea.rejected().get(0).reason()).contains("09:10~14:50 KST");
        assertThat(kr.last()).as("한국 끝은 14:50 그대로").isEqualTo(Instant.parse("2026-11-03T05:50:00Z"));

        // 장 시간 변경일(수능일 10:00~16:30)은 그날 개장·마감에서 셈 — 10:10~15:50 KST.
        LocalDate exam = LocalDate.of(2026, 11, 19);
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(exam, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        IntradayRequest.Window examWindow = IntradayRequest.window(exam, shifted, true);
        assertThat(examWindow.first()).isEqualTo(Instant.parse("2026-11-19T01:10:00Z"));
        assertThat(examWindow.last()).isEqualTo(Instant.parse("2026-11-19T06:50:00Z"));
    }

    @Test
    @DisplayName("QA-359 미국 HOURLY 예약은 개장 40분 뒤(10:10 ET)부터 — 그 전 시각은 사유와 함께 버림(조기 폐장일도 같음). MINUTE와 한국은 받는 범위 그대로")
    void earlyHourlyIsRejected() {
        assertThat(IntradayRequest.HOURLY_AFTER_OPEN).hasMinutes(40);
        IntradayRequest.Verdict v = us(list(item("09:45", "HOURLY", "[]", "이른 시간별"), item("10:09", "HOURLY", "[]", "경계 앞"),
                item("10:10", "HOURLY", "[]", "경계"), item("09:40", "MINUTE", "[\"AAA\"]", "감시 1분봉")), 3, List.of());

        assertThat(v.accepted()).extracting(i -> i.at() + " " + i.feed()).containsExactly("09:40 MINUTE", "10:10 HOURLY");
        assertThat(v.rejected()).extracting(IntradayRequest.Rejected::at).containsExactly("09:45", "10:09");
        assertThat(v.rejected()).allSatisfy(r -> assertThat(r.reason()).startsWith(OrderValidator.CHECKPOINT_INVALID)
                .contains("HOURLY", "10:10 ET"));

        IntradayRequest.Verdict early = IntradayRequest.validate(list(item("10:00", "HOURLY", "[]", "q"), item("10:30", "HOURLY", "[]", "q")),
                EARLY_CLOSE, US, UNIVERSE, NIGHT, 2, List.of(), false);
        assertThat(early.accepted()).as("조기 폐장일도 개장은 09:30").extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(10, 30));
        assertThat(early.rejected()).extracting(IntradayRequest.Rejected::at).containsExactly("10:00");

        IntradayRequest.Verdict korea = IntradayRequest.validate(list(item("09:10", "HOURLY", "[\"005930\"]", "q")), KR_E, KR, KR_UNIVERSE,
                Instant.parse("2026-11-02T13:30:00Z"), 1, List.of(), true);
        assertThat(korea.accepted()).as("한국은 늘 감시 1분봉 — 이 경계가 없음").extracting(IntradayRequest.Item::at)
                .containsExactly(LocalTime.of(9, 10));
    }

    @Test
    @DisplayName("지난 시각: 호출 창 시작(시각 + 2분)이 지금보다 뒤여야 함 — 세션 도중의 결정이 이미 지난 시각을 예약하지 못함")
    void pastTimesAreRejected() {
        Instant during = Instant.parse("2026-10-27T15:00:00Z");   // 11:00 ET
        IntradayRequest.Verdict v = IntradayRequest.validate(list(item("10:58", "HOURLY", "[]", "q"), item("10:59", "HOURLY", "[]", "q")),
                TUE, US, UNIVERSE, during, 2, List.of(), false);
        assertThat(v.rejected()).extracting(IntradayRequest.Rejected::at).as("10:58 + 2분 = 지금 — 이미 지남").containsExactly("10:58");
        assertThat(v.rejected().get(0).reason()).contains("이미 지남");
        assertThat(v.accepted()).as("간격 검사는 받은 것끼리 — 10:59만 남음").extracting(IntradayRequest.Item::at)
                .containsExactly(LocalTime.of(10, 59));
    }

    @Test
    @DisplayName("간격·횟수: 이른 시각부터 받고, 다른 판단 시각(이미 정해진 것 포함)과 20분 안이면 버리고, 남은 횟수(최대 3)를 넘으면 버림 — 0이면 모두 버림")
    void gapAndCount() {
        assertThat(IntradayRequest.MIN_GAP).hasMinutes(20);
        IntradayRequest.Verdict close = us(list(item("11:19", "HOURLY", "[]", "뒤"), item("11:00", "HOURLY", "[]", "앞")), 2, List.of());
        assertThat(close.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(11, 0));
        assertThat(close.rejected().get(0).at()).isEqualTo("11:19");
        assertThat(close.rejected().get(0).reason()).contains("11:00").contains("20분 안");

        IntradayRequest.Verdict exact = us(list(item("11:00", "HOURLY", "[]", "q"), item("11:20", "HOURLY", "[]", "q")), 2, List.of());
        assertThat(exact.accepted()).as("딱 20분은 받음").hasSize(2);

        IntradayRequest.Verdict three = us(list(item("10:10", "HOURLY", "[]", "q"), item("12:00", "HOURLY", "[]", "q"),
                item("14:00", "HOURLY", "[]", "q"), item("15:00", "HOURLY", "[]", "q")), 3, List.of());
        assertThat(three.accepted()).as("세션당 셋까지").extracting(IntradayRequest.Item::at)
                .containsExactly(LocalTime.of(10, 10), LocalTime.of(12, 0), LocalTime.of(14, 0));
        assertThat(three.rejected()).singleElement().satisfies(r -> {
            assertThat(r.at()).isEqualTo("15:00");
            assertThat(r.reason()).contains("횟수(3번, 남은 3번)");
        });

        IntradayRequest.Verdict taken = us(list(item("10:15", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")), 1,
                List.of(LocalTime.of(10, 0)));
        assertThat(taken.accepted()).as("끝난 판단 10:00과 20분 안인 10:15는 버리고 13:00을 받음").extracting(IntradayRequest.Item::at)
                .containsExactly(LocalTime.of(13, 0));

        IntradayRequest.Verdict over = us(list(item("10:10", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")), 1, List.of());
        assertThat(over.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(10, 10));
        assertThat(over.rejected().get(0).reason()).contains("횟수");

        assertThat(us(list(item("10:10", "HOURLY", "[]", "q")), 0, List.of()).accepted()).isEmpty();
        assertThat(us(null, 2, List.of()).accepted()).as("예약 없음").isEmpty();
        assertThat(us(MAPPER.readTree("{}"), 2, List.of()).rejected()).as("배열이 아니면 예약 없음").isEmpty();
    }

    @Test
    @DisplayName("감시 목록·피드·질문·시각 글자: MINUTE는 한 종목 이상, 10개 이하·중복 없음·유니버스 안, 피드는 MINUTE·HOURLY, 질문은 비어 있지 않음, 시각은 HH:MM")
    void watchFeedQuestion() {
        IntradayRequest.Verdict v = us(list(item("10:00", "MINUTE", "[]", "q")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).contains("감시 목록이 비어 있음");
        v = us(list(item("10:00", "MINUTE", "[\"AAA\",\"AAA\",\"ZZZ\"]", "q")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).contains("중복: AAA").contains("유니버스 밖 티커: ZZZ");
        v = us(list(item("10:00", "TICK", "[\"AAA\"]", "q")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).contains("MINUTE·HOURLY가 아님");
        v = us(list(item("10:00", null, "[\"AAA\"]", "q")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).as("미국은 피드가 필수").contains("MINUTE·HOURLY가 아님");
        v = us(list(item("10:00", "HOURLY", "[]", " ")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).contains("질문이 비어 있음");
        v = us(list(item("10시", "HOURLY", "[]", "q"), item(null, "HOURLY", "[]", "q")), 2, List.of());
        assertThat(v.rejected()).hasSize(2);
        assertThat(v.rejected().get(0).reason()).contains("HH:MM 모양이 아님");
        String eleven = "[\"AAA\",\"BBB\",\"SHY\",\"A1\",\"A2\",\"A3\",\"A4\",\"A5\",\"A6\",\"A7\",\"A8\"]";
        v = us(list(item("10:00", "MINUTE", eleven, "q")), 2, List.of());
        assertThat(v.rejected().get(0).reason()).contains("10개 초과");

        IntradayRequest.Verdict ok = us(list(item("10:00", "MINUTE", "[\"SHY\",\"AAA\"]", "반등 확인")), 2, List.of());
        assertThat(ok.rejected()).isEmpty();
        assertThat(ok.accepted().get(0)).extracting(IntradayRequest.Item::feed, IntradayRequest.Item::watch, IntradayRequest.Item::question)
                .containsExactly("MINUTE", List.of("SHY", "AAA"), "반등 확인");
    }
}
