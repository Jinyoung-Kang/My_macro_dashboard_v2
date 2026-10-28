package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Note;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 메모 쓰기의 시장 값(2단계 명세 §4-16 — POST 본문 {@code market}, F1b) — 컨트롤러를 실제 메모 서비스(가짜 저장소·가짜 저장본 읽기)로 부릅니다. 값이
 * 없거나 US면 미국 메모 그대로(미국 달력 기준일), KR이면 한국 메모 — 기본 기준일·기본 만료일·{@code active}를 그 조회 실행의 KRX 달력으로 세고 응답
 * 머리에 {@code market}·{@code dormantReason}. 쉬는 한국도 메모는 받고, 달력이 그 해를 모르면 아무것도 쓰기 전에 400, 모르는 시장 값도 쓰기 전에 400.
 */
class NoteCreateMarketTest {

    /** 2026-10-10(토) 10:00 KST — 마지막으로 끝난 미국 세션 10-09(금), 한국은 10-09 한글날 휴장이라 10-08(목). */
    private static final Instant NOW = Instant.parse("2026-10-10T01:00:00Z");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperSettingsService settings;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = NOW;
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
    }

    private PaperFrameworkController route(Instant now, PaperConfig config) {
        NoteService notes = new NoteService(store, settings, Clock.fixed(now, ZoneOffset.UTC));
        return new PaperFrameworkController(mock(FrameworkService.class), notes, new PaperMarkets(store, reader), config);
    }

    private static PaperFrameworkController.NoteRequest request(String kind, String asOf, String market) {
        return new PaperFrameworkController.NoteRequest(kind, asOf, null, "제목", "본문", market);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> note(Map<String, Object> out) {
        return (Map<String, Object>) out.get("note");
    }

    @Test
    @DisplayName("KR 메모 — 기본 기준일은 마지막으로 끝난 한국 세션(10-08 — 10-09 한글날 휴장), 기본 만료일은 KRX 3거래일 뒤, 메모의 시장은 KR, 응답 머리 market·dormantReason(쉬는 한국도 받음)")
    void krNoteUsesTheRunCalendar() {
        Map<String, Object> out = route(NOW, PaperFixtures.config()).createNote(request(NoteService.MARKET, null, "KR"));

        assertThat(out.keySet()).containsExactly("ok", "market", "dormantReason", "note");
        assertThat(out).containsEntry("ok", true).containsEntry("market", "KR")
                .containsEntry("dormantReason", PaperConfig.KR_START_MISSING);
        assertThat(note(out)).containsEntry("asOfDate", "2026-10-08").containsEntry("expiresOn", "2026-10-14")
                .containsEntry("active", true);
        Note stored = store.notes.lastEntry().getValue();
        assertThat(stored.market()).isEqualTo("KR");
        assertThat(stored.asOfDate()).isEqualTo(LocalDate.of(2026, 10, 8));
    }

    @Test
    @DisplayName("시장 값이 없거나 US면 미국 메모 그대로 — 기준일 10-09(미국 세션), 같은 기준일의 만료일은 미국 3거래일 뒤(한국과 다름), 응답에 시장 칸 없음")
    void usNoteIsUnchanged() {
        PaperFrameworkController route = route(NOW, PaperFixtures.config());

        Map<String, Object> plain = route.createNote(request(NoteService.MARKET, null, null));
        Map<String, Object> us = route.createNote(request(NoteService.MARKET, null, "US"));

        assertThat(plain.keySet()).containsExactly("ok", "note");
        assertThat(us.keySet()).containsExactly("ok", "note");
        assertThat(note(plain)).containsEntry("asOfDate", "2026-10-09");
        assertThat(store.notes.values()).extracting(Note::market).containsOnly("US");
        Map<String, Object> usSameDay = route.createNote(request(NoteService.MARKET, "2026-10-08", null));
        Map<String, Object> krSameDay = route.createNote(request(NoteService.MARKET, "2026-10-08", "KR"));
        assertThat(note(usSameDay)).containsEntry("expiresOn", "2026-10-13");
        assertThat(note(krSameDay)).as("10-09 한글날을 건너뜀").containsEntry("expiresOn", "2026-10-14");
    }

    @Test
    @DisplayName("모르는 시장 값은 쓰기 전에 400 — 빈 값·소문자·공백 포함")
    void unknownMarketIsRefusedBeforeInsert() {
        PaperFrameworkController route = route(NOW, PaperFixtures.config());
        for (String market : new String[]{"JP", "", "kr", "KR "}) {
            assertThatThrownBy(() -> route.createNote(request(NoteService.INSIGHT, null, market))).as("'" + market + "'")
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("market는 US · KR 가운데 하나여야 합니다");
        }
        assertThat(store.notes).isEmpty();
    }

    @Test
    @DisplayName("KR 메모 — 그 실행 달력이 지금의 해를 모르면(공휴일 저장본 없음) 400, 기본 만료일이 모르는 해로 넘어가도 400 — 둘 다 쓰기 전(K35 — 기준일을 셀 수 없는 메모를 남기지 않음)")
    void unknownYearIsRefusedBeforeInsert() {
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2027));
        assertThatThrownBy(() -> route(NOW, PaperFixtures.config()).createNote(request(NoteService.INSIGHT, null, "KR")))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("메모의 기준일·만료일을 셀 수 없습니다");

        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026));
        Instant yearEnd = Instant.parse("2026-12-30T01:00:00Z");   // 12-30 10:00 KST — 기준일 12-29는 아는 해, 3거래일 뒤는 2027
        assertThatThrownBy(() -> route(yearEnd, PaperFixtures.config())
                .createNote(request(NoteService.MARKET, "2026-12-29", "KR")))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("2027");
        assertThat(store.notes).isEmpty();
    }
}
