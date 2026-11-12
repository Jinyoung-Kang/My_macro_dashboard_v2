package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.BriefingStore;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 마감 브리핑 작업({@link PaperBriefingJob}, ADR 0039): 스위치(기본 꺼짐), 보낼 창(마감 + N분 ~ + 3시간), 세션에 한 번(Claude 한 번·행 하나),
 * 의견을 받지 못한 날의 사실만 보내기(호출 실패·형식 오류·상한 — 다시 부르지 않음), 보내기 실패 뒤 같은 글 다시 보내기, 한국은 한국 봇.
 *
 * <p>미국 세션 2026-11-12(목, EST — 마감 21:00Z, 브리핑 21:30Z), 한국 세션 2026-12-02(수 — 마감 15:30 KST, 브리핑 16:00 KST = 07:00Z).
 */
class PaperBriefingJobTest {

    private static final LocalDate US_SESSION = LocalDate.of(2026, 11, 12);
    private static final Instant US_DUE = Instant.parse("2026-11-12T21:30:00Z");
    private static final LocalDate KR_SESSION = LocalDate.of(2026, 12, 2);
    private static final Instant KR_DUE = Instant.parse("2026-12-02T07:00:00Z");
    private static final String ANSWER = "{\"schemaVersion\":1,\"headline\":\"금리가 지배한 하루\",\"reading\":\"해석\",\"accounts\":\"계좌 의견\","
            + "\"tomorrow\":[\"10년물 수준\"],\"strategy\":\"의견\",\"caveats\":null}";

    private FakePaperStore store;
    private StoreReader reader;
    private BriefingStore briefings;
    private AiService ai;
    private PaperTelegram telegram;
    private final Map<String, BriefingStore.Row> rows = new HashMap<>();
    private final List<String> sent = new ArrayList<>();
    private String sendError;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = Instant.parse("2026-11-12T00:00:00Z");
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        LocalDate started = LocalDate.of(2026, 11, 2);
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌", 100_000, started,
                PaperBooks.ACTIVE, store.dbNow));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 100_000, 100_000, 0, 0, store.dbNow, store.dbNow,
                US_SESSION, store.dbNow));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, US_SESSION, 100_000, 100_000, 0, 0, true));
        reader = PaperFixtures.quietReader();
        ObjectNode macro = MAPPER.createObjectNode();
        macro.putArray("categories").addObject().putArray("items").addObject().put("key", "sp500").put("name", "S&P 500")
                .put("price", 6800.0).put("pct", -1.2);
        when(reader.readStored(Datasets.SNAP_MACRO_COLLECTED)).thenReturn(Optional.of(
                new Snapshot(Datasets.SNAP_MACRO_COLLECTED, macro, "json", "ok", null, US_DUE)));
        when(reader.read(eq(Datasets.SNAP_KR_HOLIDAYS), anyLong(), any())).thenReturn(Optional.of(KrFixtures.holidays(2026, 2027)));

        briefings = mock(BriefingStore.class);
        when(briefings.ready()).thenReturn(true);
        when(briefings.find(anyString(), any())).thenAnswer(in -> Optional.ofNullable(rows.get(in.getArgument(0) + " " + in.getArgument(1))));
        when(briefings.insertIfAbsent(any())).thenAnswer(in -> {
            BriefingStore.Row row = in.getArgument(0);
            return rows.putIfAbsent(row.market() + " " + row.sessionDate(), row) == null;
        });
        org.mockito.Mockito.doAnswer(in -> {
            String key = in.getArgument(0) + " " + in.getArgument(1);
            BriefingStore.Row r = rows.get(key);
            rows.put(key, new BriefingStore.Row(r.market(), r.sessionDate(), r.status(), r.facts(), r.response(), r.message(), r.model(),
                    r.usage(), r.error(), r.createdAt(), in.getArgument(2)));
            return null;
        }).when(briefings).markSent(anyString(), any(), any());
        ai = mock(AiService.class);
        answer(new AiService.StructuredResult(true, ANSWER, "end_turn", null, null, true, 9000L, 600L, 0L, 0L, 1200));
        telegram = mock(PaperTelegram.class);
        when(telegram.send(any(PaperTelegram.Channel.class), anyString())).thenAnswer(in -> {
            if (sendError == null) {
                sent.add(in.getArgument(0) + " " + in.getArgument(1));
            }
            return sendError;
        });
    }

    private void answer(AiService.StructuredResult result) {
        when(ai.structured(anyString(), anyString(), anyString(), anyMap(), anyString(), anyInt())).thenReturn(result);
    }

    private ObjectNode body() {
        return (ObjectNode) store.settings.body();
    }

    private void enable(boolean korea) {
        ObjectNode at = korea ? (ObjectNode) body().get("kr") : body();
        ((ObjectNode) at.get("briefing")).put("enabled", true);
    }

    private PaperBriefingJob.Result run(PaperMarket market, Instant now) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        PaperSettingsService settings = PaperFixtures.settings(store);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        FrameworkService framework = new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock);
        return new PaperBriefingJob(store, briefings, reader, new PaperMarkets(store, reader), framework, calls, ai, telegram,
                PaperFixtures.config(), MAPPER, 30, clock).run(market);
    }

    private int aiCalls() {
        return org.mockito.Mockito.mockingDetails(ai).getInvocations().size();
    }

    @Test
    @DisplayName("스위치와 창: 기본 설정은 꺼짐(아무것도 읽지 않음) — 켜면 마감 + 30분 전에는 기다리고, 그 시각부터 세 시간 안에 한 번 만들어 보낸다. 그보다 "
            + "늦으면(서버가 오래 꺼져 있었음) 뒤늦게 보내지 않는다. 분 설정을 바꾸면 그 시각을 따른다")
    void switchAndWindow() {
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE).outcome()).isEqualTo(PaperBriefingJob.OFF);
        verify(briefings, never()).find(anyString(), any());
        enable(false);
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE.minusSeconds(1)).outcome()).isEqualTo(PaperBriefingJob.TOO_EARLY);
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE.plus(PaperBriefingJob.WINDOW).plusSeconds(1)).outcome()).isEqualTo(PaperBriefingJob.TOO_LATE);
        assertThat(rows).isEmpty();
        assertThat(aiCalls()).isZero();

        ((ObjectNode) body().get("briefing")).put("afterCloseMinutes", 60);
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE.plusSeconds(60)).outcome()).as("마감 60분 뒤로 옮김").isEqualTo(PaperBriefingJob.TOO_EARLY);
        PaperBriefingJob.Result result = run(UsPaperMarket.INSTANCE, US_DUE.plusSeconds(1800));
        assertThat(result.outcome()).isEqualTo(PaperBriefingJob.SENT);
        assertThat(result.session()).isEqualTo(US_SESSION);
    }

    @Test
    @DisplayName("세션에 한 번: 사실을 만들고 Claude를 한 번 불러 글을 미국 봇으로 보낸 뒤 행(OK·보낸 시각)과 작업 기록을 남긴다 — 다음 주기는 다시 부르지도 "
            + "보내지도 않는다. 호출은 하루 상한에 한 번 센다")
    void oncePerSession() {
        enable(false);
        PaperBriefingJob.Result first = run(UsPaperMarket.INSTANCE, US_DUE);
        assertThat(first.outcome()).isEqualTo(PaperBriefingJob.SENT);
        BriefingStore.Row row = rows.get("US " + US_SESSION);
        assertThat(row.status()).isEqualTo(BriefingStore.OK);
        assertThat(row.sentAt()).isEqualTo(US_DUE);
        assertThat(row.facts().get("session").asString()).isEqualTo(US_SESSION.toString());
        assertThat(row.facts().get("macro").get(0).get("key").asString()).isEqualTo("sp500");
        assertThat(row.response().get("headline").asString()).isEqualTo("금리가 지배한 하루");
        assertThat(row.usage().get("inputTokens").asLong()).isEqualTo(9000L);
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)).startsWith("US *미국 마감 브리핑 — 2026\\-11\\-12*").contains("금리가 지배한 하루").contains("*해석*")
                .contains(PaperTelegram.esc(Briefing.DISCLAIMER));
        assertThat(store.jobRuns).extracting(r -> r.job() + " " + r.outcome()).containsExactly("briefing SENT");
        assertThat(store.apiUsage.values()).extracting(u -> u.calls()).as("하루 호출 수에 한 번").containsExactly(1);

        assertThat(run(UsPaperMarket.INSTANCE, US_DUE.plusSeconds(60)).outcome()).isEqualTo(PaperBriefingJob.ALREADY_SENT);
        assertThat(aiCalls()).isEqualTo(1);
        assertThat(sent).hasSize(1);
        verify(ai, times(1)).structured(anyString(), org.mockito.ArgumentMatchers.startsWith(Briefing.PROMPT),
                org.mockito.ArgumentMatchers.contains(Briefing.INPUT_START), anyMap(), anyString(), anyInt());
    }

    @Test
    @DisplayName("의견을 받지 못한 날: 호출 실패·형식 오류·보내기 전 예외·하루 상한이면 사실만 담은 글(FACTS_ONLY, 까닭 한 줄)을 보내고 그 세션은 다시 "
            + "부르지 않는다")
    void factsOnlyWhenTheOpinionFails() {
        enable(false);
        answer(new AiService.StructuredResult(false, null, null, "TIMEOUT", "300초 안에 답이 없음", false, null, null, null, null, 300_000));
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE).outcome()).isEqualTo(PaperBriefingJob.SENT);
        BriefingStore.Row row = rows.get("US " + US_SESSION);
        assertThat(row.status()).isEqualTo(BriefingStore.FACTS_ONLY);
        assertThat(row.response()).isNull();
        assertThat(row.error()).isEqualTo("[TIMEOUT] 300초 안에 답이 없음");
        assertThat(sent.get(0)).contains("의견은 싣지 못했습니다").contains("TIMEOUT").contains("S&P 500").doesNotContain("*해석*");
        assertThat(run(UsPaperMarket.INSTANCE, US_DUE.plusSeconds(120)).outcome()).isEqualTo(PaperBriefingJob.ALREADY_SENT);
        assertThat(aiCalls()).as("재시도 없음").isEqualTo(1);

        rows.clear();
        answer(new AiService.StructuredResult(true, "{\"schemaVersion\":1,\"headline\":\"칸이 모자람\"}", "end_turn", null, null, true, 10L, 5L,
                0L, 0L, 10));
        run(UsPaperMarket.INSTANCE, US_DUE);
        assertThat(rows.get("US " + US_SESSION).error()).startsWith("응답 형식 오류");

        rows.clear();
        when(ai.structured(anyString(), anyString(), anyString(), anyMap(), anyString(), anyInt())).thenThrow(new IllegalStateException("키 없음"));
        run(UsPaperMarket.INSTANCE, US_DUE);
        assertThat(rows.get("US " + US_SESSION).error()).isEqualTo("호출을 보내지 못했습니다: 키 없음");

        rows.clear();
        int before = aiCalls();
        body().put("apiDailyCallCap", 5).put("apiScheduledReserve", 5);
        run(UsPaperMarket.INSTANCE, US_DUE);
        assertThat(rows.get("US " + US_SESSION).error()).as("정기 결정 몫의 예약은 쓰지 않음").startsWith("하루 호출 상한");
        assertThat(aiCalls()).isEqualTo(before);
    }

    @Test
    @DisplayName("보내기 실패: 행은 남고 보낸 시각이 비어 다음 주기에 같은 글을 다시 보낸다 — Claude는 다시 부르지 않는다")
    void resendsWhenTelegramFails() {
        enable(false);
        sendError = "텔레그램 502";
        PaperBriefingJob.Result failed = run(UsPaperMarket.INSTANCE, US_DUE);
        assertThat(failed.outcome()).isEqualTo(PaperBriefingJob.SEND_FAILED);
        assertThat(failed.message()).isEqualTo("텔레그램 502");
        BriefingStore.Row row = rows.get("US " + US_SESSION);
        assertThat(row.sentAt()).isNull();
        assertThat(store.jobRuns).extracting(r -> r.outcome()).containsExactly(PaperBriefingJob.SEND_FAILED);

        sendError = null;
        PaperBriefingJob.Result again = run(UsPaperMarket.INSTANCE, US_DUE.plusSeconds(60));
        assertThat(again.outcome()).isEqualTo(PaperBriefingJob.SENT);
        assertThat(sent).containsExactly("US " + row.message());
        assertThat(rows.get("US " + US_SESSION).sentAt()).isEqualTo(US_DUE.plusSeconds(60));
        assertThat(aiCalls()).isEqualTo(1);
    }

    @Test
    @DisplayName("한국: 15:30 마감 + 30분(16:00 KST)에 한국 봇으로 — 장부가 그 세션을 아직 처리하지 않아(밤 처리) 그 참고가 실리고, 미국 스위치와 따로 켠다")
    void koreaUsesItsOwnSwitchAndBot() {
        store.books.put(PaperBooks.KR_CLAUDE, new Book(PaperBooks.KR_CLAUDE, PaperBooks.KIND_CLAUDE, "한국 Claude 계좌", 100_000_000,
                LocalDate.of(2026, 11, 2), PaperBooks.ACTIVE, store.dbNow, Book.MARKET_KR, "KRW"));
        store.states.put(PaperBooks.KR_CLAUDE, new BookState(PaperBooks.KR_CLAUDE, 100_000_000, 100_000_000, 0, 0, store.dbNow, store.dbNow,
                LocalDate.of(2026, 12, 1), store.dbNow));
        enable(false);
        assertThat(run(KrPaperMarket.INSTANCE, KR_DUE).outcome()).as("미국만 켬").isEqualTo(PaperBriefingJob.OFF);
        enable(true);
        assertThat(run(KrPaperMarket.INSTANCE, KR_DUE.minusSeconds(1)).outcome()).isEqualTo(PaperBriefingJob.TOO_EARLY);
        PaperBriefingJob.Result result = run(KrPaperMarket.INSTANCE, KR_DUE);
        assertThat(result.outcome()).isEqualTo(PaperBriefingJob.SENT);
        assertThat(result.session()).isEqualTo(KR_SESSION);
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)).startsWith("KR *한국 마감 브리핑 — 2026\\-12\\-02*").contains(PaperTelegram.esc("참고: " + Briefing.KR_LEDGER_NOTE));
        assertThat(rows).containsOnlyKeys("KR " + KR_SESSION);
        assertThat(store.jobRuns).extracting(r -> r.job()).containsExactly(KrPaperMarket.INSTANCE.jobName(PaperBriefingJob.JOB));
    }
}
