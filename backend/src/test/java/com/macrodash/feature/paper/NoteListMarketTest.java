package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Note;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 메모 목록의 시장 값(2단계 명세 §4-16 '?market', F1) — 미국 목록은 그대로(미국 메모·미국 달력 기준일), 한국은 한국 메모만, 만료·{@code active}의
 * 기준일을 그 조회 실행의 KRX 달력으로 셉니다(한국 달력은 실행마다 만듦 — 실행 없이는 셀 수 없음). 쉬는 한국은 사유를, 달력이 모르는 해는 기준일
 * null + 사유를 싣습니다.
 */
class NoteListMarketTest {

    /** 2026-10-10(토) 10:00 KST — 마지막으로 끝난 미국 세션 10-09(금), 한국은 10-09 한글날 휴장이라 10-08(목). */
    private static final Instant NOW = Instant.parse("2026-10-10T01:00:00Z");
    private static final LocalDate S = LocalDate.of(2026, 11, 30);

    private FakePaperStore store;
    private StoreReader reader;
    private NoteService notes;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = NOW;
        PaperSettingsService settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        notes = new NoteService(store, settings, Clock.fixed(NOW, ZoneOffset.UTC));

        note(Book.MARKET_US, NoteService.MARKET, "2026-10-07", "2026-10-09", "미국");
        note(Book.MARKET_KR, NoteService.MARKET, "2026-10-06", "2026-10-08", "한국 유효");
        note(Book.MARKET_KR, NoteService.MARKET, "2026-10-02", "2026-10-07", "한국 만료");
        note(Book.MARKET_KR, NoteService.INSIGHT, "2026-10-05", null, "한국 방법론");
        store.archiveNote(note(Book.MARKET_KR, NoteService.MARKET, "2026-10-01", null, "한국 보관"));
    }

    private long note(String market, String kind, String asOf, String expires, String title) {
        return store.insertNote(new Note(0, kind, LocalDate.parse(asOf), expires == null ? null : LocalDate.parse(expires),
                title, "본문", false, null, market));
    }

    private PaperMarkets.Scope scope(PaperConfig config) {
        return new PaperMarkets(store, reader).scope(KrPaperMarket.INSTANCE, config);
    }

    private static PaperConfig krConfig() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    private void krBooks() {
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, null, PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> rows(Map<String, Object> body) {
        return ((List<Map<String, Object>>) body.get("notes")).stream()
                .map(row -> row.get("title") + " " + row.get("active")).toList();
    }

    @Test
    @DisplayName("미국 목록은 그대로 — 미국 메모만, 기준일 = 마지막으로 끝난 미국 세션(10-09), 한국 칸 없음")
    void usListIsUnchanged() {
        Map<String, Object> us = notes.list(false);

        assertThat(us).doesNotContainKeys("market", "dormantReason").containsEntry("referenceDate", "2026-10-09");
        assertThat(rows(us)).containsExactly("미국 true");
    }

    @Test
    @DisplayName("한국 목록: 한국 메모만, 기준일은 KRX 달력의 10-08(미국 달력이면 10-09라 '한국 유효'가 만료로 빠짐) — 만료·보관은 includeExpired일 때만")
    void koreanListUsesTheRunCalendar() {
        krBooks();

        Map<String, Object> kr = notes.list(scope(krConfig()), false);

        assertThat(List.copyOf(kr.keySet())).containsExactly("available", "market", "dormantReason", "referenceDate",
                "notes");
        assertThat(kr).containsEntry("market", "KR").containsEntry("dormantReason", null)
                .containsEntry("referenceDate", "2026-10-08");
        assertThat(rows(kr)).containsExactly("한국 유효 true", "한국 방법론 true");
        assertThat(rows(notes.list(scope(krConfig()), true)))
                .containsExactly("한국 유효 true", "한국 방법론 true", "한국 만료 false", "한국 보관 false");
    }

    @Test
    @DisplayName("GET /api/paper/notes 컨트롤러가 includeExpired와 market을 함께 넘김(F1 리뷰) — KR은 한국 메모(만료·보관은 includeExpired=true일 때만), 값 없음·US는 미국 목록 그대로, 모르는 값은 400")
    void listRoutePassesIncludeExpiredAndMarket() {
        krBooks();
        PaperFrameworkController route = new PaperFrameworkController(mock(FrameworkService.class), notes,
                new PaperMarkets(store, reader), krConfig());

        Map<String, Object> krAll = route.notes(true, "KR");
        assertThat(krAll).containsEntry("market", "KR").containsEntry("referenceDate", "2026-10-08");
        assertThat(rows(krAll)).containsExactly("한국 유효 true", "한국 방법론 true", "한국 만료 false", "한국 보관 false");
        assertThat(rows(route.notes(false, "KR"))).containsExactly("한국 유효 true", "한국 방법론 true");

        Map<String, Object> us = route.notes(true, null);
        assertThat(us).doesNotContainKeys("market", "dormantReason").isEqualTo(notes.list(true));
        assertThat(route.notes(true, "US")).isEqualTo(us);
        assertThat(route.notes(false, "US")).isEqualTo(notes.list(false));
        assertThatThrownBy(() -> route.notes(true, "JP")).hasMessageContaining("US · KR");
    }

    @Test
    @DisplayName("쉬는 한국(출발일 없음): 예외 없이 쉬는 사유와 함께 — 기준일은 그 조회 실행의 한국 달력으로 그대로")
    void dormantKoreaCarriesTheReason() {
        Map<String, Object> kr = notes.list(scope(PaperFixtures.config()), false);

        assertThat(kr).containsEntry("dormantReason", PaperConfig.KR_START_MISSING)
                .containsEntry("referenceDate", "2026-10-08");
        assertThat(rows(kr)).containsExactly("한국 유효 true", "한국 방법론 true");
    }

    @Test
    @DisplayName("한국 달력이 지금의 해를 모르면 기준일 null + 사유 — 만료를 가를 수 없어 보관하지 않은 메모 전부, MARKET의 active는 null")
    void unknownKoreanYear() {
        krBooks();
        KrFixtures.stubHolidays(reader, null);

        Map<String, Object> kr = notes.list(scope(krConfig()), false);

        assertThat(kr).containsEntry("referenceDate", null);
        assertThat((String) kr.get("referenceDateReason")).startsWith("달력 없음");
        assertThat(rows(kr)).containsExactly("한국 유효 null", "한국 방법론 true", "한국 만료 null");
        assertThat(rows(notes.list(scope(krConfig()), true)))
                .containsExactly("한국 유효 null", "한국 방법론 true", "한국 만료 null", "한국 보관 false");
    }

    @Test
    @DisplayName("테이블이 없으면 한국 목록도 available:false")
    void notReady() {
        store.ready = false;

        assertThat(notes.list(scope(krConfig()), false)).containsEntry("available", false);
    }
}
