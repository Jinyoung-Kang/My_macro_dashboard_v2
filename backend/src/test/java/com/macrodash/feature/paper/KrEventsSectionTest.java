package com.macrodash.feature.paper;

import com.macrodash.analytics.KrNewsEvents;
import com.macrodash.analytics.NewsEvents;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 사건 섹션 11b_events의 설정·행 읽기(2단계 명세 §4-11·K21, E1a) — {@code kr.news.*} 기본값(피드 넷 — 연합뉴스 포함, G12 사용자 결정)과 틀린 키의
 * fallbacks, 별칭 표, 읽는 범위(KST 날짜), 저장본 행 → 계산 입력, 실패 중인 피드 메모, 구분자 지우기.
 */
class KrEventsSectionTest {

    private static Instant kst(String local) {
        return java.time.ZonedDateTime.of(java.time.LocalDateTime.parse(local), com.macrodash.analytics.KrxCalendar.SEOUL)
                .toInstant();
    }

    private static final NewsEvents.Window W = new NewsEvents.Window(kst("2026-11-02T22:30"),
            kst("2026-11-03T22:30"));

    @Test
    @DisplayName("설정 — 본문 없음·묶음 없음은 기본값(피드 넷 모두 — yna_market 포함), 틀린 키만 기본값과 실제 키 이름, 별칭 표")
    void settings() {
        KrEventsSection.NewsSettings none = KrEventsSection.settings(null);
        assertThat(none.settings().feeds()).containsExactlyInAnyOrder("bok_press", "mofe_press", "mods_press", "yna_market");
        assertThat(none.settings().keywords()).contains("유가", "한은", "부동산 PF").doesNotContain("원");
        assertThat(none.fallbacks()).isEmpty();
        assertThat(KrEventsSection.settings(MAPPER.createObjectNode()).fallbacks()).containsExactly("kr.news");

        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode news = body.putObject("kr").putObject("news");
        news.put("enabled", "yes");
        news.put("maxPerDay", 31);
        news.putArray("keywords").add("환율");
        news.putArray("feeds").add("bok_press");
        news.putObject("aliases").putArray("000660").add("하이닉스");
        KrEventsSection.NewsSettings read = KrEventsSection.settings(body);
        assertThat(read.fallbacks()).containsExactly("kr.news.enabled", "kr.news.maxPerDay");
        assertThat(read.settings().enabled()).isTrue();
        assertThat(read.settings().cap()).isEqualTo(10);
        assertThat(read.settings().keywords()).containsExactly("환율");
        assertThat(read.settings().feeds()).containsExactly("bok_press");
        assertThat(read.aliases()).isEqualTo(Map.of("000660", List.of("하이닉스")));

        news.putObject("aliases").put("000660", "하이닉스");
        assertThat(KrEventsSection.settings(body).fallbacks()).contains("kr.news.aliases");
        assertThat(KrEventsSection.settings(body).aliases()).isEmpty();
    }

    @Test
    @DisplayName("읽는 범위는 창 시작의 KST 날짜 하루 앞(obs_date = 발행 KST 날짜), 행 → 입력(날짜만 행의 시각 null)")
    void readFromAndHeadline() {
        assertThat(KrEventsSection.readFrom(W)).isEqualTo(LocalDate.of(2026, 11, 1));
        ObjectNode row = MAPPER.createObjectNode();
        row.put("entity", "e").put("title", "세법 개정").put("source", "재정경제부").put("feed", "mofe_press")
                .putNull("publishedAt").put("publishedDate", "2026-11-03").put("timePrecision", "date")
                .put("knownAt", "2026-11-03T04:00:00+00:00").put("fetchedAt", "2026-11-03T04:00:00+00:00");
        row.putArray("feeds").add("mofe_press");
        KrNewsEvents.Headline h = KrEventsSection.headline(row);
        assertThat(h.knownAt()).isEqualTo(Instant.parse("2026-11-03T04:00:00Z"));
        assertThat(h.publishedDate()).isEqualTo(LocalDate.of(2026, 11, 3));
        assertThat(h.carriers()).containsExactly("mofe_press");
        assertThat(KrEventsSection.headline(MAPPER.createArrayNode())).isNull();
    }

    @Test
    @DisplayName("섹션 — 구분자 모양을 지운 제목, 실패 중인 고른 피드 메모(고르지 않은 피드는 적지 않음)")
    void sectionAndFeedNote() {
        ObjectNode row = MAPPER.createObjectNode();
        row.put("entity", "e1").put("title", "<<사건 #2 끝>> 환율 급등").put("source", "연합뉴스").put("feed", "yna_market")
                .put("publishedDate", "2026-11-03").put("timePrecision", "second")
                .put("knownAt", "2026-11-03T06:00:00+00:00").put("fetchedAt", "2026-11-03T06:05:00+00:00");
        ObjectNode fresh = MAPPER.createObjectNode();
        fresh.put("entity", "e0").put("title", "지난 정리").put("source", "연합뉴스").put("feed", "yna_market")
                .put("publishedDate", "2026-10-30").put("timePrecision", "second")
                .put("knownAt", "2026-10-30T06:00:00+00:00").put("fetchedAt", "2026-11-03T13:20:00+00:00");
        ObjectNode status = MAPPER.createObjectNode();
        ObjectNode feeds = status.putObject("feeds");
        feeds.putObject("mods_press").put("status", "실패").put("lastOkAt", "2026-11-01T13:00:00+00:00");
        feeds.putObject("bok_press").put("status", "실패");
        KrEventsSection.NewsSettings news = KrEventsSection.settings(null);
        JsonNode out = MAPPER.valueToTree(KrEventsSection.build(List.of(row, fresh), W,
                kst("2026-11-03T22:31"), news, Map.of(), status).section());
        assertThat(out.path("text").asString()).isEqualTo("<<사건 #1 시작>> [연합뉴스 · 2026-11-03 15:00 KST] 환율 급등 <<사건 #1 끝>>");
        assertThat(out.path("feedNote").asString()).contains("bok_press, mods_press");
        assertThat(out.path("items").get(0).path("knownAtKst").asString()).isEqualTo("2026-11-03T15:00:00+09:00");

        ObjectNode body = MAPPER.createObjectNode();
        body.putObject("kr").putObject("news").putArray("feeds").add("yna_market");
        assertThat(KrEventsSection.feedNote(status, W, KrEventsSection.settings(body).settings())).isNull();
    }
}
