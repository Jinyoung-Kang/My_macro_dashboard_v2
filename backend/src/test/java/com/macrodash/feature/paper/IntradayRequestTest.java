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
 * 자유 시점 판의 장중 판단 예약 의미 검사({@link IntradayRequest} — ADR 0027 결정 3): 받는 범위(미국 개장 5분 뒤 ~ 마감 30분 전, 한국 개장 5분 뒤 ~
 * 종가 단일가 시작 30분 전), 지난 시각, 30분 간격, 세션당 횟수, 감시 목록·피드·질문. 어긴 항목만 버리고 사유를 남깁니다.
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
    @DisplayName("받는 범위: 미국 09:35~15:30 ET(양 끝 포함), 조기 폐장일은 12:30까지, 한국 09:05~14:50 KST — 밖이면 그 항목만 버리고 사유에 범위를 적음")
    void windowPerMarket() {
        IntradayRequest.Window us = IntradayRequest.window(TUE, US, false);
        assertThat(us.first()).isEqualTo(Instant.parse("2026-10-27T13:35:00Z"));
        assertThat(us.last()).isEqualTo(Instant.parse("2026-10-27T19:30:00Z"));
        assertThat(IntradayRequest.window(EARLY_CLOSE, US, false).last()).as("마감 13:00 ET(18:00Z)의 30분 전")
                .isEqualTo(Instant.parse("2026-11-27T17:30:00Z"));
        IntradayRequest.Window kr = IntradayRequest.window(KR_E, KR, true);
        assertThat(kr.first()).as("09:05 KST").isEqualTo(Instant.parse("2026-11-03T00:05:00Z"));
        assertThat(kr.last()).as("14:50 KST — 종가 단일가(15:20) 30분 전").isEqualTo(Instant.parse("2026-11-03T05:50:00Z"));

        IntradayRequest.Verdict edges = us(list(item("09:35", "HOURLY", "[]", "개장 뒤"), item("15:30", "HOURLY", "[]", "마감 전")), 2, List.of());
        assertThat(edges.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(9, 35), LocalTime.of(15, 30));
        assertThat(edges.rejected()).isEmpty();

        IntradayRequest.Verdict outside = us(list(item("09:34", "HOURLY", "[]", "이름"), item("15:31", "HOURLY", "[]", "늦음")), 2, List.of());
        assertThat(outside.accepted()).isEmpty();
        assertThat(outside.rejected()).extracting(IntradayRequest.Rejected::at).containsExactly("09:34", "15:31");
        assertThat(outside.rejected().get(0).reason()).startsWith(OrderValidator.CHECKPOINT_INVALID).contains("09:35~15:30 ET");

        IntradayRequest.Verdict early = IntradayRequest.validate(list(item("12:30", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")),
                EARLY_CLOSE, US, UNIVERSE, NIGHT, 2, List.of(), false);
        assertThat(early.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(12, 30));
        assertThat(early.rejected().get(0).reason()).contains("09:35~12:30 ET");

        IntradayRequest.Verdict korea = IntradayRequest.validate(list(item("09:05", null, "[\"005930\"]", "q"),
                item("14:51", null, "[\"005930\"]", "q")), KR_E, KR, KR_UNIVERSE, Instant.parse("2026-11-02T13:30:00Z"), 2, List.of(), true);
        assertThat(korea.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(9, 5));
        assertThat(korea.accepted().get(0).feed()).as("한국은 늘 감시 1분봉").isEqualTo(ExecutionSection.FEED_MINUTE);
        assertThat(korea.rejected().get(0).reason()).contains("09:05~14:50 KST");
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
    @DisplayName("간격·횟수: 이른 시각부터 받고, 다른 판단 시각(이미 정해진 것 포함)과 30분 안이면 버리고, 남은 횟수를 넘으면 버림 — 0이면 모두 버림")
    void gapAndCount() {
        IntradayRequest.Verdict close = us(list(item("11:20", "HOURLY", "[]", "뒤"), item("11:00", "HOURLY", "[]", "앞")), 2, List.of());
        assertThat(close.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(11, 0));
        assertThat(close.rejected().get(0).at()).isEqualTo("11:20");
        assertThat(close.rejected().get(0).reason()).contains("11:00").contains("30분 안");

        IntradayRequest.Verdict exact = us(list(item("11:00", "HOURLY", "[]", "q"), item("11:30", "HOURLY", "[]", "q")), 2, List.of());
        assertThat(exact.accepted()).as("딱 30분은 받음").hasSize(2);

        IntradayRequest.Verdict taken = us(list(item("10:20", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")), 1,
                List.of(LocalTime.of(10, 0)));
        assertThat(taken.accepted()).as("끝난 판단 10:00과 30분 안인 10:20은 버리고 13:00을 받음").extracting(IntradayRequest.Item::at)
                .containsExactly(LocalTime.of(13, 0));

        IntradayRequest.Verdict over = us(list(item("10:00", "HOURLY", "[]", "q"), item("13:00", "HOURLY", "[]", "q")), 1, List.of());
        assertThat(over.accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(10, 0));
        assertThat(over.rejected().get(0).reason()).contains("횟수");

        assertThat(us(list(item("10:00", "HOURLY", "[]", "q")), 0, List.of()).accepted()).isEmpty();
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
