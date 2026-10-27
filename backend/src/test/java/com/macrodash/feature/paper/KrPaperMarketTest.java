package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 시장 묶음(2단계 명세 §4 — C1c): 값 고정, 실행마다 만드는 달력(공휴일 저장본 + 설정 판의 임시휴장·장 시간 변경일), 관측치 늦음
 * (결정 d5), 결정 순간.
 */
class KrPaperMarketTest {

    private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(java.time.LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    private static TradingCalendar calendar2026And2027() {
        return KR.openCalendar(KrFixtures.inputs(null, KrFixtures.holidays(2026, 2027)));
    }

    @Test
    @DisplayName("값 — KR·KRW·kr. 접두어, 관측치 paper.kr.quotes·이력 kr_close_adj, 네 계좌·비교 기준 kr_bench_k200, 현금성 153130·최소 주문 500,000원, NEXT_OPEN만")
    void values() {
        assertThat(KR.code()).isEqualTo(PaperStore.Book.MARKET_KR);
        assertThat(KR.currency()).isEqualTo(PaperStore.Book.CURRENCY_KRW);
        assertThat(KR.definition()).isSameAs(KR);
        assertThat(KR.quotesDataset()).isEqualTo("paper.kr.quotes").isEqualTo(Datasets.SNAP_KR_PAPER_QUOTES);
        assertThat(KR.quotesTask()).isEqualTo("kr_paper_quotes");
        assertThat(KR.historyDataset()).isEqualTo("kr_close_adj").isEqualTo(Datasets.TS_KR_CLOSE_ADJ);
        assertThat(KR.books()).extracting(PaperBooks.Definition::code)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(KR.books()).extracting(PaperBooks.Definition::kind)
                .containsExactly(PaperBooks.KIND_RULES, PaperBooks.KIND_CLAUDE, PaperBooks.KIND_BENCHMARK,
                        PaperBooks.KIND_BENCHMARK);
        assertThat(KR.books().get(2).weights()).containsExactly(Map.entry("069500", 100.0));
        assertThat(KR.books().get(3).weights()).containsExactly(Map.entry("069500", 60.0), Map.entry("153130", 40.0));
        assertThat(KR.rulesBook()).isEqualTo("kr_rules");
        assertThat(KR.claudeBook()).isEqualTo("kr_claude");
        assertThat(KR.benchmarkBook()).isEqualTo("kr_bench_k200");
        assertThat(KR.benchmarkOf("kr_bench_mix")).isEqualTo("kr_bench_k200");
        assertThat(KR.benchmarkOf("kr_bench_k200")).isNull();
        assertThat(KR.bookOrder().compare("kr_rules", "kr_bench_mix")).isNegative();
        assertThat(KR.defaultCashLike()).containsExactly("153130");
        assertThat(KR.defaultMinOrderNotional()).isEqualTo(500_000);

        assertThat(KrPaperMarket.ALLOW_NEXT_CLOSE).as("G2 판정 전(K13·K38)").isFalse();
        assertThat(KR.timings()).containsExactly(PaperBooks.NEXT_OPEN);
        assertThat(KR.earlyTiming()).isEqualTo("NEXT_OPEN");
        assertThat(KR.timingNames()).containsExactly(Map.entry("NEXT_OPEN", "다음 거래일 시가"));
        assertThat(KR.orderValidation().timings()).containsExactly("NEXT_OPEN");
        assertThat(KR.money().suffix()).isEqualTo("원");
        assertThat(KR.defaultDecisionTime()).isEqualTo(LocalTime.of(22, 30));
        assertThat(KR.defaultDeadline()).isEqualTo(LocalTime.of(1, 0));
        assertThat(KR.reviewOpensOn()).isEqualTo(DayOfWeek.SATURDAY);
        assertThat(KR.reviewOpensAt()).isEqualTo(LocalTime.of(22, 30));
        assertThat(KR.reviewOpening(LocalDate.of(2026, 11, 6))).isEqualTo(kst("2026-11-07T22:30"));
        assertThat(KR.settingsPrefix()).isEqualTo("kr.");
        assertThat(KR.settingKey("decisionTimeKst")).isEqualTo("kr.decisionTimeKst");
        assertThat(KR.jobName(PaperDecisionJob.JOB)).isEqualTo("kr.decision");
    }

    @Test
    @DisplayName("기본값이 설정 kr.* 기본 본문과 같다 — 현금성·최소 주문·결정 시각·기한")
    void defaultsMatchSettingsBody() {
        Map<String, Object> body = PaperSettingsService.krDefaultsBody();
        assertThat(body.get("cashLikeTickers")).isEqualTo(KR.defaultCashLike());
        assertThat(((Number) body.get("minOrderNotional")).doubleValue()).isEqualTo(KR.defaultMinOrderNotional());
        assertThat(body.get("decisionTimeKst")).isEqualTo(KR.defaultDecisionTime().toString());
        assertThat(body.get("decisionDeadlineKst")).isEqualTo("01:00");
        PaperSettings read = PaperSettings.defaults(KR);
        assertThat(read.cashLikeTickers()).containsExactly("153130");
    }

    @Test
    @DisplayName("고정 달력 없음 — 실행 밖에서 묻으면 던지고, 실행을 열 때 공휴일 저장본으로 KrxCalendar를 한 벌 만든다(2026·2027 앎, 2025 모름)")
    void calendarIsPerRun() {
        assertThatThrownBy(KR::calendar).isInstanceOf(IllegalStateException.class).hasMessageContaining("실행 문맥");
        TradingCalendar calendar = calendar2026And2027();
        assertThat(calendar).isInstanceOf(KrxCalendar.class);
        assertThat(((KrxCalendar) calendar).coveredYears()).containsExactly(2026, 2027);
        assertThat(calendar.isTradingDay(LocalDate.of(2026, 12, 25))).as("성탄절").isFalse();
        assertThat(calendar.isTradingDay(LocalDate.of(2026, 12, 31))).as("연말휴장일").isFalse();
        assertThat(calendar.isTradingDay(LocalDate.of(2026, 11, 30))).isTrue();
        assertThatThrownBy(() -> calendar.isTradingDay(LocalDate.of(2025, 12, 30)))
                .isInstanceOf(CalendarUnavailableException.class);

        TradingCalendar none = KR.openCalendar(KrFixtures.inputs(null, null));
        assertThatThrownBy(() -> none.isTradingDay(LocalDate.of(2026, 11, 30)))
                .as("저장본이 없으면 아는 해가 없음 — 평일은 '달력 없음'(K35)").isInstanceOf(CalendarUnavailableException.class);
    }

    @Test
    @DisplayName("공휴일 저장본 해석 — 발표 전(빈 목록)·날짜 형식이 틀린 날·다른 해의 날이 든 해는 모르는 해(그해만), 숫자가 아닌 해 키는 버림")
    void holidaysByYearFailsClosedPerYear() {
        ObjectNode payload = KrFixtures.holidaysPayload(2026, 2027);
        ObjectNode years = (ObjectNode) payload.get("years");
        years.putObject("2028").put("announced", false).putArray("holidays");
        ((tools.jackson.databind.node.ArrayNode) years.get("2027").get("holidays")).addObject().put("date", "2027/12/24");
        years.putObject("x").putArray("holidays").addObject().put("date", "2026-01-01");

        Map<Integer, List<LocalDate>> read = KrPaperMarket.holidaysByYear(payload);
        assertThat(read).containsOnlyKeys(2026);
        assertThat(read.get(2026)).hasSize(22).contains(LocalDate.of(2026, 12, 25));

        ObjectNode otherYear = KrFixtures.holidaysPayload(2026);
        ((tools.jackson.databind.node.ArrayNode) otherYear.get("years").get("2026").get("holidays")).addObject()
                .put("date", "2027-01-01");
        assertThat(KrPaperMarket.holidaysByYear(otherYear)).isEmpty();
        assertThat(KrPaperMarket.holidaysByYear(null)).isEmpty();
        assertThat(KrPaperMarket.holidaysByYear(PaperFixtures.MAPPER.createObjectNode())).isEmpty();
    }

    @Test
    @DisplayName("그 실행의 설정 판 — 임시휴장(kr.calendar.extraClosures)은 휴장, 장 시간 변경일(결정 d8)은 개장·마감 쌍, 틀린 값은 그 키 기본값")
    void settingsVersionShapesTheCalendar() {
        ObjectNode body = PaperFixtures.MAPPER.createObjectNode();
        ObjectNode calendarKeys = body.putObject("kr").putObject("calendar");
        calendarKeys.putArray("extraClosures").add("2026-11-30");
        calendarKeys.putObject("openTimeOverrides").putObject("2026-11-19").put("open", "10:00").put("close", "16:30");
        TradingCalendar calendar = KR.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027)));
        assertThat(calendar.isTradingDay(LocalDate.of(2026, 11, 30))).as("임시휴장").isFalse();
        assertThat(calendar.closeInstant(LocalDate.of(2026, 11, 19))).isEqualTo(kst("2026-11-19T16:30"));
        assertThat(calendar.openInstant(LocalDate.of(2026, 11, 19))).isEqualTo(kst("2026-11-19T10:00"));
        assertThat(calendar.lastCompletedSession(kst("2026-11-19T16:00"))).isEqualTo(LocalDate.of(2026, 11, 18));

        assertThat(KrPaperMarket.extraClosures(body)).containsExactly(LocalDate.of(2026, 11, 30));
        assertThat(KrPaperMarket.sessionHours(body)).containsOnlyKeys(LocalDate.of(2026, 11, 19));
        assertThat(KrPaperMarket.extraClosures(null)).isEmpty();
        assertThat(KrPaperMarket.sessionHours(null)).isEmpty();

        ObjectNode broken = PaperFixtures.MAPPER.createObjectNode();
        ObjectNode brokenKeys = broken.putObject("kr").putObject("calendar");
        brokenKeys.putArray("extraClosures").add("2026-11-30").add("11/30");
        brokenKeys.putObject("openTimeOverrides").putObject("2026-11-19").put("open", "16:30").put("close", "10:00");
        assertThat(KrPaperMarket.extraClosures(broken)).as("손으로 고친 틀린 값 — 키 기본값(빈 목록)").isEmpty();
        assertThat(KrPaperMarket.sessionHours(broken)).as("개장이 마감보다 늦음 — 키 기본값(빈 표)").isEmpty();
        brokenKeys.put("extraClosures", "2026-11-30");
        assertThat(KrPaperMarket.extraClosures(broken)).as("목록이 아님").isEmpty();
    }

    @Test
    @DisplayName("실행 열기 — 그 실행의 설정 행(판)과 조용히 읽은 공휴일 저장본으로 달력 한 벌, 설정 읽기는 kr. 접두어·현금성 153130")
    void openRunReadsHolidaysAndSettingsOnce() {
        FakePaperStore store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        com.macrodash.read.StoreReader reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        PaperMarkets markets = new PaperMarkets(store, reader, List.of(UsPaperMarket.INSTANCE, KR));

        MarketRun run = markets.open(KR);
        assertThat(run.definition()).isSameAs(KR);
        assertThat(run.settingsVersion()).isEqualTo(1);
        assertThat(run.calendar().isTradingDay(LocalDate.of(2026, 12, 25))).isFalse();
        assertThat(run.settings().cashLikeTickers()).containsExactly("153130");
        assertThat(run.settings().slippageBp()).isEqualTo(5);
        org.mockito.Mockito.verify(reader).quietly(org.mockito.ArgumentMatchers.any());
    }

    @Test
    @DisplayName("결정 순간 — 09:00 전 시각은 세션 다음 날 아침(기본 기한 01:00 → D+1 01:00), 나머지는 세션 그날(22:30)")
    void decisionInstant() {
        LocalDate d = LocalDate.of(2026, 11, 30);
        assertThat(KR.decisionInstant(d, LocalTime.of(22, 30))).isEqualTo(kst("2026-11-30T22:30"));
        assertThat(KR.decisionInstant(d, LocalTime.of(1, 0))).isEqualTo(kst("2026-12-01T01:00"));
        assertThat(KR.decisionInstant(d, LocalTime.of(8, 59))).isEqualTo(kst("2026-12-01T08:59"));
        assertThat(KR.decisionInstant(d, LocalTime.of(9, 0))).isEqualTo(kst("2026-11-30T09:00"));
        assertThat(KR.decisionInstant(d, LocalTime.of(20, 30))).isEqualTo(kst("2026-11-30T20:30"));
    }

    @Test
    @DisplayName("관측치 늦음(결정 d5) = 다음 거래일 D′의 21:55 + 2시간 5분 = D′+1 00:00 KST — 금요일은 화요일 00:00, 휴장은 건너뜀, 세션을 모르면 수집 시각으로")
    void quotesLateAt() {
        TradingCalendar calendar = calendar2026And2027();
        Instant collected = kst("2026-11-02T22:01");
        assertThat(KR.quotesLateAt(collected, LocalDate.of(2026, 11, 2), calendar)).isEqualTo(kst("2026-11-04T00:00"));
        assertThat(KR.quotesLateAt(kst("2026-10-30T21:58"), LocalDate.of(2026, 10, 30), calendar))
                .as("금요일 → 다음 월요일의 다음 날 00:00").isEqualTo(kst("2026-11-03T00:00"));
        assertThat(KR.quotesLateAt(kst("2026-12-24T22:00"), LocalDate.of(2026, 12, 24), calendar))
                .as("12-25(금) 휴장 → 12-28(월) → 12-29 00:00").isEqualTo(kst("2026-12-29T00:00"));

        // 세션을 모르면 수집 시각으로 — 거래일 20:30 이후면 그날, 아니면 직전 거래일(수집기 kr_target_session).
        assertThat(KrPaperMarket.targetSession(kst("2026-10-30T20:30"), calendar)).isEqualTo(LocalDate.of(2026, 10, 30));
        assertThat(KrPaperMarket.targetSession(kst("2026-10-30T20:29"), calendar)).isEqualTo(LocalDate.of(2026, 10, 29));
        assertThat(KrPaperMarket.targetSession(kst("2026-10-31T03:00"), calendar)).isEqualTo(LocalDate.of(2026, 10, 30));
        assertThat(KR.quotesLateAt(kst("2026-10-31T03:00"), null, calendar)).isEqualTo(kst("2026-11-03T00:00"));
        assertThat(KR.quotesLateAt(kst("2026-11-02T20:00"), null, calendar))
                .as("월요일 20:30 전 수집 = 금요일 세션 → 화요일 00:00").isEqualTo(kst("2026-11-03T00:00"));

        // D′이 모르는 해 — 늦음을 지어내지 않고 '달력 없음'.
        assertThatThrownBy(() -> KR.quotesLateAt(kst("2027-12-30T22:00"), LocalDate.of(2027, 12, 30), calendar))
                .isInstanceOf(CalendarUnavailableException.class);
    }

    @Test
    @DisplayName("확정 판정 셋(결정 d9) — 아직 옛 기본 isFinal 식: 15:30 + 5시간 = 그날 20:30 이후 수집이면 셋 다 참")
    void finalJudgementsMeetCollectionTime() {
        MarketRun run = new MarketRun(KR, calendar2026And2027(), null);
        LocalDate d = LocalDate.of(2026, 11, 2);
        assertThat(run.closeAvailable(d, kst("2026-11-02T20:29"))).isFalse();
        assertThat(run.closeAvailable(d, kst("2026-11-02T20:30"))).isTrue();
        assertThat(run.pricesConfirmed(d, kst("2026-11-02T20:29"))).isFalse();
        assertThat(run.pricesConfirmed(d, kst("2026-11-02T20:30"))).isTrue();
    }

    @Test
    @DisplayName("한국 Claude 시스템 프롬프트(하드 규칙 줄·고정 문단)는 E2 — 그 전에 부르면 던진다")
    void promptPartsAreE2() {
        JsonNode body = PaperFixtures.MAPPER.createObjectNode();
        assertThatThrownBy(() -> KR.promptHardRules(body)).isInstanceOf(IllegalStateException.class).hasMessageContaining("E2");
        assertThatThrownBy(KR::promptFixedRules).isInstanceOf(IllegalStateException.class).hasMessageContaining("E2");
    }
}
