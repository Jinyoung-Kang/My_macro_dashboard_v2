package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.UsMarketCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;

/**
 * 체결 시점의 잠금(2단계 명세 K38, 계좌2 명세 §9-6) — 응답 스키마 파일의 {@code orders.items.timing.enum}(API가 받는 값), 계좌 프로필의
 * {@link ClaudeBookProfile#timings}(검증기가 받는 값 — {@link ClaudeBookProfile#orderValidation}·시점 순위), 시스템 프롬프트 고정 문단
 * ({@link ClaudeBookProfile#fixedRules} — Claude에게 권하는 값), V17 {@code paper_orders.timing} CHECK(DB가 받는 값 — 마이그레이션 파일을 읽어 봄)가
 * 운영 결정 문맥({@link ClaudeBookService#marketContexts} — 미국 계좌1·계좌2·한국, 계좌마다)마다 같은 시점을 말하는지 봅니다. 넷은 정적 JSON·코드
 * 상수·프롬프트 글·SQL로 따로 있어서, 하나만 바뀌면 API는 받는데 검증기가 거절하거나 프롬프트가 받지 않는 시점을 권하거나 주문 행이 DB에서
 * 막힙니다.
 */
class DecisionTimingsLockTest {

    private static final Path V17 = Path.of("../db/migrations/V17__paper_timed_fills_and_exec.sql");

    private static List<String> schemaTimings(String resource) throws IOException {
        JsonNode schema;
        try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + resource)) {
            assertThat(in).as("응답 스키마 " + resource).isNotNull();
            schema = MAPPER.readTree(in);
        }
        List<String> out = new ArrayList<>();
        schema.path("properties").path("orders").path("items").path("properties").path("timing").path("enum")
                .forEach(node -> out.add(node.asString()));
        return out;
    }

    /** V17이 다시 만드는 {@code paper_orders.timing} CHECK의 값(마이그레이션 파일 그대로). */
    private static List<String> v17Timings() throws IOException {
        assumeTrue(Files.exists(V17), "V17 파일을 찾을 수 없습니다");
        Matcher check = Pattern.compile("CHECK \\(timing IN \\(([^)]*)\\)\\)").matcher(Files.readString(V17));
        assertThat(check.find()).as("V17의 timing CHECK").isTrue();
        List<String> out = new ArrayList<>();
        Matcher value = Pattern.compile("'([A-Z_0-9]+)'").matcher(check.group(1));
        while (value.find()) {
            out.add(value.group(1));
        }
        return out;
    }

    @Test
    @DisplayName("운영 결정 문맥(계좌마다 — 미국 계좌1·계좌2·한국)마다 스키마 timing enum = 프로필의 받는 시점(순서까지) = 검증기가 받는 시점·순위 키, 이른 시점이 그 첫째, 시점마다 고정 문단에 그 이름, 모두 V17 CHECK 안")
    void schemaMarketAndPromptAgree() throws IOException {
        List<ClaudeDecisionPipeline.MarketContext> contexts = ClaudeBookService.marketContexts(mock(PacketBuilder.class),
                mock(KrPacketBuilder.class));
        assertThat(contexts).extracting(context -> context.profile().code()).as("운영 문맥(계좌마다 — 미국 둘 · 한국, 계좌2 명세 §9-1)")
                .containsExactly(PaperBooks.CLAUDE, PaperBooks.CLAUDE2, PaperBooks.KR_CLAUDE);
        assertThat(contexts).extracting(context -> context.market().code())
                .containsExactly(UsPaperMarket.INSTANCE.code(), UsPaperMarket.INSTANCE.code(), KrPaperMarket.INSTANCE.code());
        assertThat(contexts.get(2).market()).isSameAs(KrPaperMarket.INSTANCE);
        assertThat(contexts.get(2).schemaResource()).isEqualTo(ClaudeBookService.KR_SCHEMA_RESOURCE);
        assertThat(contexts).extracting(context -> context.shared() != null).as("미국 둘만 시장 입력을 함께 씀(입력 동결)")
                .containsExactly(true, true, false);
        assertThat(ClaudeBookService.marketContexts(mock(PacketBuilder.class), null)).as("한국 패킷 빌더가 없으면 미국 둘(시험)")
                .extracting(context -> context.profile().code()).containsExactly(PaperBooks.CLAUDE, PaperBooks.CLAUDE2);
        List<String> v17 = v17Timings();
        for (ClaudeDecisionPipeline.MarketContext context : contexts) {
            ClaudeBookProfile profile = context.profile();
            String code = profile.code();
            List<String> schemaTimings = schemaTimings(context.schemaResource());
            assertThat(schemaTimings).as(code + " 스키마 timing enum = 프로필의 받는 시점").isNotEmpty()
                    .isEqualTo(profile.timings());
            OrderValidator.Market validation = profile.orderValidation();
            assertThat(validation.timings()).as(code + " 검증기가 받는 시점").isEqualTo(profile.timings());
            assertThat(validation.ranks()).as(code + " 검증기 순위 = 프로필 순위").isEqualTo(profile.timingRanks());
            assertThat(validation.ranks().keySet()).as(code + " 순위 키").containsExactlyElementsOf(profile.timings());
            assertThat(validation.earlyTiming()).as(code + " 이른 시점 = 받는 시점의 첫째").isEqualTo(profile.timings().get(0));
            assertThat(validation.closed()).as(code + " 프로필의 시장 몫에는 닫힌 시점이 없음(결정마다 파이프라인이 더함)").isEmpty();
            for (String timing : profile.timings()) {
                assertThat(profile.fixedRules()).as(code + " 고정 문단에 " + timing).contains(timing);
            }
            assertThat(v17).as(code + " 받는 시점은 모두 V17 timing CHECK 안(주문 행이 DB에서 막히지 않음)")
                    .containsAll(profile.timings());
            assertThat(profile.timed()).as(code + " 시각 지정 체결 계좌 = 정의의 실행 프로필 TIMED")
                    .isEqualTo(PaperBooks.find(code).map(PaperBooks.Definition::timed).orElse(false));
            if (!profile.timed()) {
                // 시장 기본 계좌 — 시장 묶음의 받는 시점·두 갈래 순위·시장 몫 그대로.
                PaperMarket market = context.market();
                assertThat(profile.code()).as(code + " 프로필 계좌").isEqualTo(market.claudeBook());
                assertThat(profile.timings()).as(code + " 시장 체결 시점").isEqualTo(market.timings());
                assertThat(market.earlyTiming()).as(code + " 이른 시점").isEqualTo(market.timings().get(0));
                assertThat(market.orderValidation().timings()).isEqualTo(market.timings());
                assertThat(market.orderValidation().ranks()).as(code + " 검증기 순위 = 프로필 순위")
                        .isEqualTo(profile.timingRanks());
                assertThat(market.orderValidation().withRanks(profile.timingRanks())).as(code + " 검증기 시장 몫")
                        .isEqualTo(market.orderValidation());
                assertThat(validation).as(code + " 파이프라인이 쓰는 프로필의 시장 몫 = 시장 묶음 값")
                        .isEqualTo(market.orderValidation());
                for (String timing : market.timings()) {
                    assertThat(market.promptFixedRules()).as(code + " 시장 고정 문단에 " + timing).contains(timing);
                }
            }
        }
    }

    @Test
    @DisplayName("계좌2(계좌2 명세 §6·§9-6·§10-5): 메뉴 여덟 = 스키마 enum = 순위 NEXT_OPEN 0 < AT_1000 1 < … < AT_1500 6 < NEXT_CLOSE 7 = 고정 문단 timing 줄 = V17 CHECK의 시각 지정 값 = 실행 감사 메뉴, 첫 시점 NEXT_OPEN, NEXT_OBSERVATION은 우선순위 줄(읽는 법)에만")
    void claude2MenuIsLockedEverywhere() throws IOException {
        ClaudeBookProfile book2 = ClaudeBookProfile.US_CLAUDE2;
        assertThat(book2.code()).isEqualTo(PaperBooks.CLAUDE2);
        assertThat(book2.market()).isSameAs(UsPaperMarket.INSTANCE);
        assertThat(book2.timings()).containsExactly("NEXT_OPEN", "AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400",
                "AT_1500", "NEXT_CLOSE").isEqualTo(PaperBooks.CLAUDE2_TIMINGS)
                .isEqualTo(schemaTimings(ClaudeBookService.CLAUDE2_SCHEMA_RESOURCE));
        assertThat(book2.timings().get(0)).isEqualTo(PaperBooks.NEXT_OPEN);
        Map<String, Integer> ranks = new LinkedHashMap<>();
        for (int i = 0; i < book2.timings().size(); i++) {
            ranks.put(book2.timings().get(i), i);
        }
        assertThat(book2.timingRanks()).containsExactlyEntriesOf(ranks);
        assertThat(book2.orderValidation().ranks()).isEqualTo(book2.timingRanks());
        assertThat(new java.util.HashSet<>(book2.orderValidation().ranks().values())).as("시점마다 다른 때 체결").hasSize(8);
        assertThat(book2.timed()).isTrue();
        assertThat(book2.packetVariant()).isEqualTo(PacketBuilder.VARIANT_CLAUDE2);
        assertThat(book2.callCapKey()).isEqualTo(Claude2Settings.MAX_CALLS_PER_CYCLE);
        assertThat(book2.schemaResource()).isEqualTo(ClaudeBookService.CLAUDE2_SCHEMA_RESOURCE);
        assertThat(book2.fixedRules()).isEqualTo(ClaudePrompts.CLAUDE2_FIXED_RULES);

        // V17 CHECK의 시각 지정 값(AT_*) = 계좌2 메뉴의 매시 여섯, NEXT_OPEN·NEXT_CLOSE도 그 안.
        List<String> v17 = v17Timings();
        assertThat(v17.stream().filter(t -> t.startsWith("AT_")).toList())
                .isEqualTo(book2.timings().stream().filter(t -> t.startsWith("AT_")).toList());
        assertThat(v17).contains(PaperBooks.NEXT_OPEN, PaperBooks.NEXT_CLOSE);
        // 실행 감사 메뉴(반사실 시점) = 계좌2의 시각 지정 시점, 장부 2b가 받는 시점도 같음.
        List<String> timed = book2.timings().subList(0, book2.timings().size() - 1);
        assertThat(ExecutionAudit.MENU.keySet()).containsExactlyElementsOf(timed);
        assertThat(UsTimedFills.TIMINGS).containsExactlyInAnyOrderElementsOf(timed);
        assertThat(ExecutionAudit.TIMINGS).as("반사실 = 계좌1식 기준 + 계좌2 메뉴").containsExactlyElementsOf(
                java.util.stream.Stream.concat(java.util.stream.Stream.of(ExecutionAudit.NEXT_OBSERVATION),
                        book2.timings().stream()).toList());

        // 고정 문단: 계좌2 timing 줄이 여덟을 모두 말하고 NEXT_OBSERVATION은 말하지 않음 — NEXT_OBSERVATION은 첫 줄(프레임 문장을 메뉴로 읽는 법)에만.
        String rules = book2.fixedRules();
        String timingLine = rules.lines().filter(line -> line.startsWith("- timing은")).findFirst().orElseThrow();
        for (String timing : book2.timings()) {
            assertThat(timingLine).as("timing 줄에 " + timing).contains(timing);
        }
        assertThat(timingLine).doesNotContain(ExecutionAudit.NEXT_OBSERVATION);
        List<String> mentions = rules.lines().filter(line -> line.contains(ExecutionAudit.NEXT_OBSERVATION)).toList();
        assertThat(mentions).as("NEXT_OBSERVATION은 우선순위 줄에만").containsExactly(ClaudePrompts.CLAUDE2_PRIORITY);
        assertThat(schemaTimings(ClaudeBookService.CLAUDE2_SCHEMA_RESOURCE)).doesNotContain(ExecutionAudit.NEXT_OBSERVATION);
    }

    private static final Path V18 = Path.of("../db/migrations/V18__paper_checkpoints.sql");

    @Test
    @DisplayName("장중 확인 판(계좌2 단계 2 — US_CLAUDE2_C2)도 단계 1과 같은 잠금: 아침 결정의 받는 시점·순위 = 메뉴 여덟(MARKET 없음), c2 스키마 timing enum = 여덟, c2-2 timing 줄 = c2-1 줄, checkpoint.atEt enum = checkpointOptions의 보통 날 시각 = 고정 문단의 '10:00~15:00 ET의 30분 단위', feed enum = V18 feed CHECK")
    void claude2C2ContextIsLockedLikeStageOne() throws IOException {
        ClaudeBookProfile c1 = ClaudeBookProfile.US_CLAUDE2;
        ClaudeBookProfile c2 = ClaudeBookProfile.US_CLAUDE2_C2;
        ClaudeDecisionPipeline.MarketContext context = ClaudeBookService.checkpointContext(mock(PacketBuilder.class));
        assertThat(context.profile()).isSameAs(c2);
        assertThat(context.shared()).as("계좌2처럼 시장 입력을 함께 씀").isNotNull();
        assertThat(c2.code()).isEqualTo(PaperBooks.CLAUDE2);
        assertThat(c2.timings()).isEqualTo(c1.timings()).isEqualTo(PaperBooks.CLAUDE2_TIMINGS).doesNotContain("MARKET");
        assertThat(c2.timingRanks()).isEqualTo(c1.timingRanks());
        assertThat(c2.orderValidation()).isEqualTo(c1.orderValidation());
        assertThat(schemaTimings(c2.schemaResource())).isEqualTo(c2.timings());
        assertThat(v17Timings()).containsAll(c2.timings());

        String line1 = c1.fixedRules().lines().filter(line -> line.startsWith("- timing은")).findFirst().orElseThrow();
        String line2 = c2.fixedRules().lines().filter(line -> line.startsWith("- timing은")).findFirst().orElseThrow();
        assertThat(line2).as("아침 결정의 timing 줄은 단계 1 그대로").isEqualTo(line1);
        assertThat(c2.fixedRules().lines().filter(line -> line.contains(ExecutionAudit.NEXT_OBSERVATION)).toList())
                .as("NEXT_OBSERVATION은 우선순위 줄에만").containsExactly(ClaudePrompts.CLAUDE2_PRIORITY);

        JsonNode schema;
        try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + c2.schemaResource())) {
            schema = MAPPER.readTree(in);
        }
        List<String> atEt = new ArrayList<>();
        schema.at("/properties/checkpoint/properties/atEt/enum").forEach(node -> atEt.add(node.asString()));
        List<String> grid = ExecutionSection.CHECKPOINT_TIMES.stream().map(ExecutionSection::clock).toList();
        assertThat(atEt).isEqualTo(grid);
        assertThat(ExecutionSection.checkpointTimes(java.time.LocalDate.of(2026, 11, 2), UsMarketCalendar.CALENDAR)
                .stream().map(ExecutionSection::clock).toList()).as("보통 날 고를 수 있는 시각 = 스키마 enum").isEqualTo(atEt);
        assertThat(atEt.get(0)).isEqualTo("10:00");
        assertThat(atEt.get(atEt.size() - 1)).isEqualTo("15:00");
        assertThat(c2.fixedRules()).contains(atEt.get(0) + "~" + atEt.get(atEt.size() - 1) + " ET의 30분 단위");

        List<String> feeds = new ArrayList<>();
        schema.at("/properties/checkpoint/properties/feed/enum").forEach(node -> feeds.add(node.asString()));
        assertThat(feeds).isEqualTo(ExecutionSection.FEEDS);
        assumeTrue(Files.exists(V18), "V18 파일을 찾을 수 없습니다");
        Matcher check = Pattern.compile("CHECK \\(feed IN \\(([^)]*)\\)\\)").matcher(Files.readString(V18));
        assertThat(check.find()).as("V18의 feed CHECK").isTrue();
        List<String> v18 = new ArrayList<>();
        Matcher value = Pattern.compile("'([A-Z_]+)'").matcher(check.group(1));
        while (value.find()) {
            v18.add(value.group(1));
        }
        assertThat(v18).as("스키마 feed enum = V18 feed CHECK").isEqualTo(feeds);
        for (String feed : feeds) {
            assertThat(c2.fixedRules()).as("고정 문단에 " + feed).contains(feed);
        }
    }

    /**
     * 한국 문맥(E2a — 결정 문맥 목록에는 E2b에서 오름, 위 시험이 함께 봄)도 같은 잠금: 한국 스키마의 timing enum = 한국 시장 체결 시점({@code ALLOW_NEXT_CLOSE}가
     * 정함), 고정 문단·하드 규칙 줄이 받는 시점을 말하고 받지 않는 시점(지금 NEXT_CLOSE)은 말하지 않음. G2 뒤 상수를 켜는 판의 문단도 미리 봄.
     */
    @Test
    @DisplayName("한국: 스키마 timing enum = 한국 체결 시점, 고정 문단·하드 규칙 줄에 받는 시점만(NEXT_CLOSE는 ALLOW_NEXT_CLOSE일 때만)")
    void krSchemaMarketAndPromptAgree() throws IOException {
        KrPaperMarket market = KrPaperMarket.INSTANCE;
        JsonNode schema;
        try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + ClaudeBookService.KR_SCHEMA_RESOURCE)) {
            assertThat(in).isNotNull();
            schema = MAPPER.readTree(in);
        }
        List<String> schemaTimings = new ArrayList<>();
        schema.path("properties").path("orders").path("items").path("properties").path("timing").path("enum")
                .forEach(node -> schemaTimings.add(node.asString()));
        assertThat(schemaTimings).isEqualTo(market.timings()).isEqualTo(market.orderValidation().timings());
        assertThat(market.earlyTiming()).isEqualTo(market.timings().get(0)).isEqualTo(PaperBooks.NEXT_OPEN);
        String hardRules = String.join("\n", market.promptHardRules(null));
        for (String timing : List.of(PaperBooks.NEXT_OPEN, PaperBooks.NEXT_CLOSE)) {
            boolean accepted = market.timings().contains(timing);
            assertThat(market.promptFixedRules().contains(timing)).as("고정 문단에 " + timing).isEqualTo(accepted);
            assertThat(hardRules.contains(timing)).as("하드 규칙 줄에 " + timing).isEqualTo(accepted);
        }
        assertThat(KrPaperMarket.ALLOW_NEXT_CLOSE).isEqualTo(market.timings().contains(PaperBooks.NEXT_CLOSE));
        assertThat(ClaudePrompts.krFixedRules(true)).as("G2 통과 뒤 판").contains("NEXT_OPEN·NEXT_CLOSE")
                .contains("또는 NEXT_CLOSE(다음 KRX 거래일의 정규장 종가 단일가)");
        assertThat(ClaudePrompts.krFixedRules(false)).isEqualTo(ClaudePrompts.KR_FIXED_RULES).doesNotContain("NEXT_CLOSE");
    }
}
