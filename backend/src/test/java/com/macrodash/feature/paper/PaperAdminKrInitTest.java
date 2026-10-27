package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
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
 * 한국 초기화(2단계 명세 §4-13·K38 — C1c): 출발일 검사(없음·달력이 모르는 해·거래일 아님·출발 기한 지남), 설정 행에 {@code kr.*} 기본값을
 * 한 번(판 한 번), 한국 네 계좌 '시작 전', 멱등, 한 트랜잭션.
 */
class PaperAdminKrInitTest {

    /** 한국 출발일 S — 2026-11-30(월). */
    private static final LocalDate S = LocalDate.of(2026, 11, 30);
    /** 출발 며칠 전(2026-11-27 금 12:00 KST). */
    private static final Clock BEFORE = Clock.fixed(Instant.parse("2026-11-27T03:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperLedgerService ledger;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
    }

    private PaperAdminService admin(LocalDate start, Clock clock) {
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);
        return new PaperAdminService(store, marketData, reader, PaperFixtures.settings(store), ledger, config,
                PaperFixtures.MAPPER, clock);
    }

    /** C1b 전에 만든 설정 행(한국 묶음 없음) — 서버의 지금 행과 같은 모양. */
    private void preC1bSettingsRow() {
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        PaperFixtures.dropKrDefaults(store);
    }

    private static List<String> krKeys() {
        return PaperSettingKeys.ALL.stream().filter(spec -> spec.scope() == PaperSettingKeys.Scope.KR)
                .map(PaperSettingKeys.Spec::key).toList();
    }

    @Test
    @DisplayName("출발일이 비었으면 400(KR_START_MISSING) — 계좌·설정 행 모두 그대로")
    void missingStartDateIsRefused() {
        assertThatThrownBy(() -> admin(null, BEFORE).initKr())
                .isInstanceOf(InvalidRequestException.class).hasMessage(PaperConfig.KR_START_MISSING);
        assertThat(store.books).isEmpty();
        assertThat(store.settings).isNull();
    }

    @Test
    @DisplayName("출발일이 KRX 거래일이 아니면 400 — 주말·공휴일·연말휴장·설정 임시휴장(그 실행의 설정 판)")
    void nonTradingStartDateIsRefused() {
        preC1bSettingsRow();
        for (LocalDate day : List.of(LocalDate.of(2026, 11, 28), LocalDate.of(2026, 12, 25), LocalDate.of(2026, 12, 31))) {
            assertThatThrownBy(() -> admin(day, BEFORE).initKr()).as(day.toString())
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("KRX 거래일이 아닙니다");
        }
        ObjectNode kr = ((ObjectNode) store.settings.body()).putObject("kr");
        kr.putObject("calendar").putArray("extraClosures").add("2026-11-30");
        assertThatThrownBy(() -> admin(S, BEFORE).initKr()).as("임시휴장")
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("KRX 거래일이 아닙니다");
        assertThat(store.books).isEmpty();
        assertThat(store.settings.version()).as("설정 판 그대로").isEqualTo(1);
    }

    @Test
    @DisplayName("출발일의 해를 달력이 모르면 400('달력 없음' — 공휴일 저장본에 그해가 없음, fail-closed)")
    void unknownYearIsRefused() {
        assertThatThrownBy(() -> admin(LocalDate.of(2028, 1, 4), BEFORE).initKr())
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("달력 없음").hasMessageContaining("2028");
        KrFixtures.stubHolidays(reader, null);
        assertThatThrownBy(() -> admin(S, BEFORE).initKr()).as("공휴일 저장본 없음")
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("달력 없음");
        assertThat(store.books).isEmpty();
    }

    @Test
    @DisplayName("처음 만들 때 출발 기한(S+1 01:00 KST)이 지났으면 400 — 00:59는 받음")
    void startWindowAlreadyClosedIsRefused() {
        Clock closed = Clock.fixed(Instant.parse("2026-11-30T16:00:00Z"), ZoneOffset.UTC);   // 12-01 01:00 KST
        assertThatThrownBy(() -> admin(S, closed).initKr())
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("출발 기한").hasMessageContaining("지났습니다");
        assertThat(store.books).isEmpty();

        Clock lastMinute = Clock.fixed(Instant.parse("2026-11-30T15:59:00Z"), ZoneOffset.UTC);
        assertThat(admin(S, lastMinute).initKr().created()).hasSize(4);
    }

    @Test
    @DisplayName("한국 초기화 — 한국 키를 기본값으로 채워 판을 한 번 올리고(이력에 채운 키), 네 계좌 KR·KRW·1억·시작 전, 미국 계좌는 그대로")
    void initWritesKrDefaultsOnceAndCreatesFourBooks() {
        preC1bSettingsRow();
        PaperFixtures.activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        Book usBefore = store.books.get(PaperBooks.CLAUDE);

        PaperAdminService.KrInitResult result = admin(S, BEFORE).initKr();

        assertThat(result.startDate()).isEqualTo(S);
        assertThat(result.settingsCreated()).isFalse();
        assertThat(result.settingsVersion()).isEqualTo(2);
        assertThat(result.settingsKeysWritten()).containsExactlyElementsOf(krKeys()).hasSize(32);
        assertThat(store.settings.version()).isEqualTo(2);
        assertThat(store.settingsChangedKeys.get(2)).containsExactlyElementsOf(krKeys());
        JsonNode kr = store.settings.body().get("kr");
        assertThat(PaperFixtures.MAPPER.convertValue(kr, Map.class))
                .isEqualTo(PaperFixtures.MAPPER.convertValue(PaperSettingsService.krDefaultsBody(), Map.class));
        assertThat(store.settings.body().path("slippageBp").asDouble()).as("미국 키 그대로").isEqualTo(5);

        assertThat(result.created()).containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        for (PaperBooks.Definition d : PaperBooks.KR) {
            Book book = store.books.get(d.code());
            assertThat(book.market()).isEqualTo("KR");
            assertThat(book.currency()).isEqualTo("KRW");
            assertThat(book.initialCash()).isEqualTo(100_000_000);
            assertThat(book.status()).isEqualTo(PaperBooks.NOT_STARTED);
            assertThat(book.startedOn()).isNull();
            assertThat(book.label()).isEqualTo(d.label());
            BookState state = store.states.get(d.code());
            assertThat(state.cash()).isEqualTo(100_000_000);
            assertThat(state.nav()).isEqualTo(100_000_000);
        }
        assertThat(store.books.get(PaperBooks.CLAUDE)).isEqualTo(usBefore);
        assertThat(store.orders).as("사후 체결·주문 없음(K28)").isEmpty();
        assertThat(store.startPrices).isEmpty();

        // 다시 누름 — 판도 계좌도 그대로(멱등). 출발 기한이 지나도 이미 있는 계좌의 다시 누름은 받습니다.
        Clock afterDeadline = Clock.fixed(Instant.parse("2026-12-02T03:00:00Z"), ZoneOffset.UTC);
        PaperAdminService.KrInitResult again = admin(S, afterDeadline).initKr();
        assertThat(again.created()).isEmpty();
        assertThat(again.settingsKeysWritten()).isEmpty();
        assertThat(again.settingsVersion()).isEqualTo(2);
        assertThat(store.settings.version()).isEqualTo(2);
        assertThat(store.books).hasSize(5);
    }

    @Test
    @DisplayName("먼저 저장한 한국 키는 그대로 — 빠진 키만 채움, 설정 행이 없으면 기본 본문(한국 묶음 포함)으로 판 1을 만들고 더 쓰지 않음")
    void keepsSavedKrKeysAndCreatesMissingRow() {
        preC1bSettingsRow();
        ObjectNode kr = ((ObjectNode) store.settings.body()).putObject("kr");
        kr.put("slippageBp", 7);
        kr.putObject("calendar").putArray("extraClosures").add("2026-12-29");

        PaperAdminService.KrInitResult result = admin(S, BEFORE).initKr();

        assertThat(result.settingsKeysWritten()).doesNotContain("kr.slippageBp", "kr.calendar.extraClosures")
                .contains("kr.commissionBp", "kr.calendar.openTimeOverrides").hasSize(30);
        assertThat(store.settings.body().at("/kr/slippageBp").asDouble()).isEqualTo(7);
        assertThat(store.settings.body().at("/kr/calendar/extraClosures/0").asString()).isEqualTo("2026-12-29");
        assertThat(store.settings.body().at("/kr/tax/kospi/sttBp").asDouble()).isEqualTo(5);

        FakePaperStore fresh = new FakePaperStore();
        store = fresh;
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        PaperAdminService.KrInitResult created = admin(S, BEFORE).initKr();
        assertThat(created.settingsCreated()).isTrue();
        assertThat(created.settingsVersion()).isEqualTo(1);
        assertThat(created.settingsKeysWritten()).isEmpty();
        assertThat(fresh.books).hasSize(4);
    }

    @Test
    @DisplayName("한 트랜잭션 — 계좌 하나를 넣다 실패하면 설정 판·다른 계좌 모두 되돌림")
    void initIsAtomic() {
        store = new FakePaperStore() {
            @Override
            public boolean insertBookIfAbsent(Book book) {
                if (PaperBooks.KR_BENCH_MIX.equals(book.code())) {
                    throw new IllegalStateException("시험용 실패");
                }
                return super.insertBookIfAbsent(book);
            }
        };
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        preC1bSettingsRow();

        assertThatThrownBy(() -> admin(S, BEFORE).initKr()).isInstanceOf(IllegalStateException.class);

        assertThat(store.books).isEmpty();
        assertThat(store.states).isEmpty();
        assertThat(store.settings.version()).isEqualTo(1);
        assertThat(store.settings.body().has("kr")).isFalse();
    }

    @Test
    @DisplayName("미국 초기화 경로는 한국을 받지 않는다(한국은 initKr — 사후 체결·출발일 종가 없음)")
    void usInitRejectsKr() {
        assertThatThrownBy(() -> admin(S, BEFORE).init(KrPaperMarket.INSTANCE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("initKr");
        assertThat(BigDecimal.valueOf(100_000_000)).isEqualTo(PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }
}
