package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.NewsEvents;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.ReviewFacts;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.InputStream;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.groups.Tuple.tuple;

/**
 * 미국 시장 묶음의 값 고정(2단계 명세 §9 A4) — {@link UsPaperMarket}이 이 묶음 전의 상수를 그대로 돌려주는지 값 자체(글자 그대로)와
 * 원래 상수 둘 다로 확인합니다. 어느 쪽이 바뀌어도 여기서 깨집니다 — 장부·작업이 이 묶음으로 옮겨 갈 때(A5·A6) 미국 숫자가 그대로인 근거.
 */
class UsPaperMarketTest {

    private static final PaperMarket US = UsPaperMarket.INSTANCE;
    private static final LocalDate FROM = LocalDate.of(2025, 1, 1);
    private static final LocalDate TO = LocalDate.of(2027, 12, 31);

    @Test
    @DisplayName("시장·통화 = US·USD — paper_books의 V13 기본값이고, 옛 모양(인자 7개) 책 레코드의 값과 같음")
    void codeAndCurrency() {
        assertThat(US.code()).isEqualTo("US").isEqualTo(Book.MARKET_US);
        assertThat(US.currency()).isEqualTo("USD").isEqualTo(Book.CURRENCY_USD);
        Book legacy = new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.RULES_LABEL, 100_000, null, null, null);
        assertThat(legacy.market()).isEqualTo(US.code());
        assertThat(legacy.currency()).isEqualTo(US.currency());
    }

    @Test
    @DisplayName("달력 = 미국 달력 어댑터 그 자체(뉴욕 세션 날짜)")
    void calendar() {
        assertThat(US.calendar()).isSameAs(UsMarketCalendar.CALENDAR);
        assertThat(US.calendar().zone()).isEqualTo(ZoneId.of("America/New_York"));
    }

    @Test
    @DisplayName("관측치 paper.quotes·이력 equity_close — 데이터셋 상수이자 체결 가격 출처 문자열")
    void datasets() {
        assertThat(US.quotesDataset()).isEqualTo("paper.quotes").isEqualTo(Datasets.SNAP_PAPER_QUOTES)
                .isEqualTo(PaperBooks.SOURCE_QUOTES);
        assertThat(US.historyDataset()).isEqualTo("equity_close").isEqualTo(Datasets.TS_EQUITY_CLOSE)
                .isEqualTo(PaperBooks.SOURCE_HISTORY);
    }

    @Test
    @DisplayName("관측치를 채우는 수집기 태스크 = paper_quotes(A5 전 저장본 읽기·안내 문구의 글자) — 수집기 태스크 목록에 그 이름이 있음")
    void quotesTask() throws IOException {
        assertThat(US.quotesTask()).isEqualTo("paper_quotes");
        java.nio.file.Path registry = java.nio.file.Path.of("../collector/app/tasks/registry.py");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.exists(registry),
                "collector/app/tasks/registry.py를 찾을 수 없습니다");
        assertThat(java.nio.file.Files.readString(registry)).contains("Task(\"" + US.quotesTask() + "\", ");
    }

    @Test
    @DisplayName("확정 종가 = 거래일 봉 + 마감 15분 뒤 수집 — 보기(금요일·추수감사절 다음 날 조기 폐장·휴장일)와 2025~2027 모든 날에서 PaperMarketData.isFinal과 같음")
    void isFinal() {
        assertThat(US.finalDelay()).isEqualTo(Duration.ofMinutes(15)).isEqualTo(PaperMarketData.FINAL_DELAY);

        assertThat(US.isFinal(FRI, Instant.parse("2026-10-23T20:14:59Z"))).as("마감(20:00Z) + 15분 1초 전").isFalse();
        assertThat(US.isFinal(FRI, Instant.parse("2026-10-23T20:15:00Z"))).as("마감 + 15분 그 순간").isTrue();
        LocalDate blackFriday = LocalDate.of(2026, 11, 27);
        assertThat(US.calendar().isEarlyClose(blackFriday)).isTrue();
        assertThat(US.isFinal(blackFriday, Instant.parse("2026-11-27T18:14:59Z"))).as("조기 폐장 13:00 ET").isFalse();
        assertThat(US.isFinal(blackFriday, Instant.parse("2026-11-27T18:15:00Z"))).isTrue();
        assertThat(US.isFinal(LocalDate.of(2026, 11, 26), Instant.parse("2026-11-28T00:00:00Z"))).as("추수감사절 봉")
                .isFalse();
        assertThat(US.isFinal(LocalDate.of(2026, 10, 24), Instant.parse("2026-10-26T00:00:00Z"))).as("토요일 봉").isFalse();

        int checked = 0;
        for (LocalDate d = FROM; !d.isAfter(TO); d = d.plusDays(1)) {
            List<Instant> moments = new ArrayList<>(List.of(d.atTime(12, 0).toInstant(ZoneOffset.UTC),
                    d.plusDays(1).atTime(12, 0).toInstant(ZoneOffset.UTC)));
            if (UsMarketCalendar.isTradingDay(d)) {
                Instant close = UsMarketCalendar.closeInstant(d);
                for (long seconds : new long[]{-1, 0, 899, 900, 901, 86_400}) {
                    moments.add(close.plusSeconds(seconds));
                }
            }
            for (Instant t : moments) {
                assertThat(US.isFinal(d, t)).as(d + " " + t).isEqualTo(PaperMarketData.isFinal(d, t));
                checked++;
            }
        }
        assertThat(checked).isGreaterThan(5_000);
    }

    @Test
    @DisplayName("책 넷 = PaperBooks.ALL(규칙·Claude·SPY 100%·SPY 60/SHY 40, 화면 순서), 비교 기준 bench_spy(자신은 null)")
    void books() {
        assertThat(US.books()).isSameAs(PaperBooks.ALL);
        assertThat(US.books()).extracting(PaperBooks.Definition::code, PaperBooks.Definition::kind,
                        PaperBooks.Definition::label, PaperBooks.Definition::weights)
                .containsExactly(
                        tuple("rules", "RULES", "규칙 계좌", Map.of()),
                        tuple("claude", "CLAUDE", "Claude 계좌", Map.of()),
                        tuple("bench_spy", "BENCHMARK", "SPY 계좌", Map.of("SPY", 100.0)),
                        tuple("bench_mix", "BENCHMARK", "60/40 계좌", Map.of("SPY", 60.0, "SHY", 40.0)));
        assertThat(US.books().get(3).weights().keySet()).as("사는 순서").containsExactly("SPY", "SHY");

        assertThat(US.rulesBook()).isEqualTo("rules").isEqualTo(PaperBooks.RULES);
        assertThat(US.claudeBook()).isEqualTo("claude").isEqualTo(PaperBooks.CLAUDE);
        assertThat(US.benchmarkBook()).isEqualTo("bench_spy").isEqualTo(PaperBooks.BENCH_SPY);
        for (PaperBooks.Definition definition : PaperBooks.ALL) {
            assertThat(US.benchmarkOf(definition.code())).as(definition.code())
                    .isEqualTo(PaperBooks.benchmarkOf(definition.code()));
        }
        assertThat(US.benchmarkOf("bench_spy")).isNull();
        assertThat(US.benchmarkOf("bench_mix")).isEqualTo("bench_spy");
    }

    @Test
    @DisplayName("현금성 기본 = [SHY] — PaperSettings 기본값이자 설정 기본 본문의 cashLikeTickers")
    void cashLike() {
        assertThat(US.defaultCashLike()).containsExactly("SHY").isEqualTo(PaperSettings.DEFAULT_CASH_LIKE);
        JsonNode defaults = PaperFixtures.settings(new FakePaperStore()).defaultsJson();
        List<String> cashLike = new ArrayList<>();
        defaults.get(US.settingKey("cashLikeTickers")).forEach(node -> cashLike.add(node.asString()));
        assertThat(cashLike).isEqualTo(US.defaultCashLike());
    }

    @Test
    @DisplayName("Claude 체결 시점 = NEXT_OBSERVATION·NEXT_CLOSE(이른 것 NEXT_OBSERVATION) — 검증기 상수·결정 스키마의 timing enum과 같음")
    void timings() throws IOException {
        assertThat(US.timings()).containsExactly("NEXT_OBSERVATION", "NEXT_CLOSE")
                .containsExactly(OrderValidator.NEXT_OBSERVATION, OrderValidator.NEXT_CLOSE);
        assertThat(US.timings().get(1)).isEqualTo(PaperBooks.NEXT_CLOSE);
        assertThat(US.earlyTiming()).isEqualTo("NEXT_OBSERVATION").isEqualTo(US.timings().get(0));

        JsonNode schema;
        try (InputStream in = UsPaperMarketTest.class.getResourceAsStream("/paper/decision.schema.json")) {
            assertThat(in).as("결정 스키마 파일").isNotNull();
            schema = MAPPER.readTree(in);
        }
        List<String> schemaTimings = new ArrayList<>();
        schema.path("properties").path("orders").path("items").path("properties").path("timing").path("enum")
                .forEach(node -> schemaTimings.add(node.asString()));
        assertThat(schemaTimings).isEqualTo(US.timings());
    }

    @Test
    @DisplayName("결정 07:30·기한 12:00 KST — 결정 작업 기본값이자 설정 기본 본문, 키 이름은 지금 그대로(설정 표에 있음)")
    void decisionTimes() {
        assertThat(US.defaultDecisionTime()).isEqualTo(LocalTime.of(7, 30))
                .isEqualTo(PaperDecisionJob.DEFAULT_DECISION_TIME);
        assertThat(US.defaultDeadline()).isEqualTo(LocalTime.of(12, 0)).isEqualTo(PaperDecisionJob.DEFAULT_DEADLINE);

        JsonNode defaults = PaperFixtures.settings(new FakePaperStore()).defaultsJson();
        assertThat(US.settingKey("decisionTimeKst")).isEqualTo("decisionTimeKst");
        assertThat(US.settingKey("decisionDeadlineKst")).isEqualTo("decisionDeadlineKst");
        assertThat(LocalTime.parse(defaults.get(US.settingKey("decisionTimeKst")).asString()))
                .isEqualTo(US.defaultDecisionTime());
        assertThat(LocalTime.parse(defaults.get(US.settingKey("decisionDeadlineKst")).asString()))
                .isEqualTo(US.defaultDeadline());
        for (String key : List.of("decisionTimeKst", "decisionDeadlineKst", "cashLikeTickers")) {
            assertThat(PaperSettingKeys.find(US.settingKey(key))).as(key).isPresent();
        }
    }

    @Test
    @DisplayName("결정 순간 = 세션 다음 KST 날의 그 시각 — 금요일 세션 07:30은 토요일 07:30 KST, 2025~2027 모든 거래일에서 사건 창(NewsEvents.window)의 양 끝과 같음")
    void decisionInstant() {
        assertThat(US.decisionInstant(FRI, LocalTime.of(7, 30))).isEqualTo(Instant.parse("2026-10-23T22:30:00Z"));
        assertThat(US.decisionInstant(FRI, LocalTime.of(12, 0))).isEqualTo(Instant.parse("2026-10-24T03:00:00Z"));

        LocalTime time = US.defaultDecisionTime();
        int checked = 0;
        for (LocalDate d = FROM; !d.isAfter(TO); d = d.plusDays(1)) {
            if (!UsMarketCalendar.isTradingDay(d)) {
                continue;
            }
            assertThat(US.decisionInstant(d, time)).as(d.toString())
                    .isEqualTo(ZonedDateTime.of(d.plusDays(1), time, Kst.ZONE).toInstant());
            NewsEvents.Window window = NewsEvents.window(d, time);
            assertThat(window.to()).as(d + " 창 끝").isEqualTo(US.decisionInstant(d, time));
            assertThat(window.from()).as(d + " 창 시작")
                    .isEqualTo(US.decisionInstant(US.calendar().previousTradingDay(d), time));
            checked++;
        }
        assertThat(checked).isGreaterThan(700);
    }

    @Test
    @DisplayName("복기 = 토요일 09:00 KST — ReviewFacts의 코드 상수")
    void review() {
        assertThat(US.reviewOpensOn()).isEqualTo(DayOfWeek.SATURDAY).isEqualTo(ReviewFacts.OPENS_ON);
        assertThat(US.reviewOpensAt()).isEqualTo(LocalTime.of(9, 0)).isEqualTo(ReviewFacts.OPENS_AT);
    }

    @Test
    @DisplayName("설정 키·작업 기록 이름은 접두어 없음 — risk·decision·review 그대로")
    void names() {
        assertThat(US.settingsPrefix()).isEmpty();
        assertThat(US.jobPrefix()).isEmpty();
        assertThat(US.jobName(PaperRiskJob.JOB)).isEqualTo("risk");
        assertThat(US.jobName(PaperDecisionJob.JOB)).isEqualTo("decision");
        assertThat(US.jobName(PaperReviewJob.JOB)).isEqualTo("review");
    }
}
