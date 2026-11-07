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
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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

    /** 마이그레이션 가운데 마지막으로 {@code paper_orders.timing} CHECK를 다시 만드는 파일의 값(번호 순). */
    private static List<String> latestTimings() throws IOException {
        Path dir = Path.of("../db/migrations");
        assumeTrue(Files.isDirectory(dir), "db/migrations를 찾을 수 없습니다");
        List<String> out = new ArrayList<>();
        List<Path> ordered;
        try (var files = Files.list(dir)) {
            ordered = files.filter(p -> p.getFileName().toString().matches("V\\d+__.*\\.sql")).sorted(java.util.Comparator.comparing(
                    p -> Integer.parseInt(p.getFileName().toString().replaceAll("^V(\\d+)__.*$", "$1")))).toList();
        }
        for (Path file : ordered) {
            Matcher check = Pattern.compile("CHECK \\(timing IN \\(([^)]*)\\)\\)").matcher(Files.readString(file));
            if (check.find()) {
                out.clear();
                Matcher value = Pattern.compile("'([A-Z_0-9]+)'").matcher(check.group(1));
                while (value.find()) {
                    out.add(value.group(1));
                }
            }
        }
        return out;
    }

    @Test
    @DisplayName("자유 시점 판(ADR 0027 결정 2·ADR 0031)의 문맥 — 미국·한국 계좌1·계좌2: 스키마 timing enum = 프로필의 받는 시점 = AT_MINUTE·NEXT_CLOSE(시가 없음), atLocal은 선택 "
            + "칸이고 pattern이 읽는 식과 같음, 고정 문단 timing 줄이 셋을 모두 말하고 매시 정각 이름은 말하지 않음, 받는 시점은 마지막 timing CHECK 안, 끈 판 프로필은 모두 "
            + "freeTiming 거짓")
    void freeTimingContextsAreLocked() throws IOException {
        List<ClaudeDecisionPipeline.MarketContext> contexts = ClaudeBookService.freeContexts(mock(PacketBuilder.class),
                mock(KrPacketBuilder.class));
        assertThat(contexts).extracting(context -> context.profile().code()).containsExactly(PaperBooks.CLAUDE, PaperBooks.CLAUDE2,
                PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2);
        assertThat(contexts).extracting(context -> context.profile()).containsExactly(ClaudeBookProfile.US_CLAUDE_FT,
                ClaudeBookProfile.US_CLAUDE2_FT, ClaudeBookProfile.KR_CLAUDE_FT, ClaudeBookProfile.KR_CLAUDE2_FT);
        assertThat(contexts).extracting(context -> context.shared() != null).as("끈 판처럼 미국 둘만 시장 입력을 함께 씀(입력 동결)")
                .containsExactly(true, true, false, false);
        assertThat(ClaudeBookService.freeContexts(mock(PacketBuilder.class), null)).as("한국 패킷 빌더가 없으면 미국 둘(시험)")
                .extracting(context -> context.profile().code()).containsExactly(PaperBooks.CLAUDE, PaperBooks.CLAUDE2);
        List<String> latest = latestTimings();
        for (ClaudeDecisionPipeline.MarketContext context : contexts) {
            ClaudeBookProfile profile = context.profile();
            boolean korea = profile.market() == KrPaperMarket.INSTANCE;
            String code = profile.code() + "(자유 시점 판)";
            assertThat(profile.freeTiming()).as(code).isTrue();
            assertThat(profile.timed()).as(code + " 미국은 시각 지정 방식(다음 세션 하루짜리), 한국은 계좌2처럼 켜지 않음").isEqualTo(!korea);
            assertThat(profile.checkpoints()).as(code + " 기존 장중 확인 판이 아님").isFalse();
            assertThat(profile.timings()).as(code).containsExactly("AT_MINUTE", "NEXT_CLOSE")
                    .isEqualTo(FreeTiming.DECISION_TIMINGS).isEqualTo(schemaTimings(context.schemaResource()));
            assertThat(profile.timingNames()).as(code + " 시가 이름 없음").doesNotContainKey(PaperBooks.NEXT_OPEN);
            assertThat(context.schemaResource()).isEqualTo(korea ? ClaudeBookService.KR_FT_SCHEMA_RESOURCE
                    : ClaudeBookService.US_FT_SCHEMA_RESOURCE);
            OrderValidator.Market validation = profile.orderValidation();
            assertThat(validation.timings()).isEqualTo(profile.timings());
            assertThat(validation.earlyTiming()).isEqualTo(PaperBooks.AT_MINUTE);
            assertThat(validation.closed()).as(code + " 닫힘은 결정마다(FreeTiming.validation)").isEmpty();
            assertThat(latest).as(code + " 받는 시점은 마지막 timing CHECK 안").containsAll(profile.timings());
            String timingLine = profile.fixedRules().lines().filter(line -> line.startsWith("- timing은")).findFirst().orElseThrow();
            for (String timing : profile.timings()) {
                assertThat(timingLine).as(code + " timing 줄에 " + timing).contains(timing);
            }
            assertThat(timingLine).as(code + " 켠 판 timing 줄은 시가를 메뉴로 말하지 않음").doesNotContain("NEXT_OPEN");
            // 받는 범위 글자 = 보통 날의 FreeTiming.window(개장 10분 뒤 ~ 장 끝 여유 앞).
            String range = com.macrodash.analytics.SessionWindows.regularRange(korea);
            assertThat(profile.fixedRules()).as(code + " 범위 글자").contains("보통 날 " + range + (korea ? " KST" : " ET"))
                    .contains("개장 10분 뒤");
            assertThat(profile.fixedRules()).as(code + " 매시 정각 이름·장중 확인 절이 없음").doesNotContain("AT_1000").doesNotContain("AT_1500")
                    .doesNotContain("## 장중 확인(고정)").contains("atLocal");
            List<String> mentions = profile.fixedRules().lines().filter(line -> line.contains(ExecutionAudit.NEXT_OBSERVATION)).toList();
            assertThat(mentions).as(code + " NEXT_OBSERVATION은 우선순위 줄에만").hasSize(1);
            assertThat(mentions.get(0)).startsWith("우선순위(고정)");
            if (korea) {
                assertThat(mentions.get(0)).contains(ClaudePrompts.KR_FT_TIMING_READING).doesNotContain(ClaudePrompts.KR_CLAUDE2_TIMING_READING);
                assertThat(profile.fixedRules()).as(code + " 체결할 수 없는 종목 매도도 시가가 아님").contains(ClaudePrompts.KR_FT_UNFILLABLE_SELL)
                        .doesNotContain(ClaudePrompts.KR_UNFILLABLE_SELL);
                assertThat(profile.packetVariant()).as(code + " 한국 패킷은 KrPacketBuilder.forFree").isNull();
                assertThat(profile.fixedRules()).isEqualTo(ClaudePrompts.KR_FT_FIXED_RULES).doesNotContain("NEXT_OPEN뿐");
            } else {
                assertThat(mentions.get(0)).isEqualTo(ClaudePrompts.CLAUDE2_PRIORITY);
                assertThat(profile.packetVariant()).as(code + " 13_execution이 있는 줄기").isEqualTo(PacketBuilder.VARIANT_CLAUDE2);
            }
        }
        // 장중 판단 응답(ADR 0027 결정 3) — 그 시장의 장중 판단 스키마의 timing enum = 응답 프로필의 받는 시점 = INTRADAY_TIMINGS, 계좌 몫은 그대로.
        for (ClaudeDecisionPipeline.MarketContext context : contexts) {
            ClaudeBookProfile profile = context.profile();
            boolean korea = profile.market() == KrPaperMarket.INSTANCE;
            String resource = ClaudeDecisionPipeline.checkpointSchemaResource(profile);
            assertThat(resource).as(profile.code()).isEqualTo(korea ? KrCheckpointPacket.FREE_SCHEMA_RESOURCE
                    : CheckpointPacket.FREE_SCHEMA_RESOURCE);
            ClaudeBookProfile replies = ClaudeBookProfile.intradayReplies(profile);
            assertThat(replies.timings()).as(profile.code() + " 장중 판단 응답").containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE")
                    .isEqualTo(FreeTiming.INTRADAY_TIMINGS).isEqualTo(schemaTimings(resource));
            assertThat(replies.code()).isEqualTo(profile.code());
            assertThat(replies.schemaResource()).isEqualTo(resource);
            assertThat(replies.fixedRules()).isEqualTo(profile.fixedRules());
            assertThat(replies.callCapKey()).isEqualTo(profile.callCapKey());
            assertThat(replies.timed()).isEqualTo(profile.timed());
            assertThat(replies.freeTiming()).isTrue();
            assertThat(replies.checkpoints()).isFalse();
            assertThat(replies.orderValidation().earlyTiming()).isEqualTo(PaperBooks.MARKET);
            assertThat(latest).as("장중 판단이 받는 시점도 마지막 timing CHECK 안").containsAll(replies.timings());
            JsonNode schema;
            try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + resource)) {
                schema = MAPPER.readTree(in);
            }
            JsonNode item = schema.path("properties").path("orders").path("items").path("properties");
            assertThat(item.path("atLocal").path("pattern").asString()).isEqualTo(FreeTiming.CLOCK_PATTERN);
            List<String> actions = new ArrayList<>();
            schema.path("properties").path("action").path("enum").forEach(node -> actions.add(node.asString()));
            assertThat(actions).containsExactly("KEEP", "REPLACE");
            JsonNode next = schema.path("properties").path("nextCheckpoint");
            assertThat(next.path("type").toString()).as(resource + " nextCheckpoint는 null을 받는 선택 칸").isEqualTo("[\"object\",\"null\"]");
            List<String> top = new ArrayList<>();
            schema.path("required").forEach(node -> top.add(node.asString()));
            assertThat(top).doesNotContain("nextCheckpoint");
            assertThat(next.path("properties").path("at").path("pattern").asString()).isEqualTo(FreeTiming.CLOCK_PATTERN);
            assertThat(next.path("properties").path("watch").path("maxItems").asInt()).isEqualTo(ExecutionSection.WATCH_MAX);
            assertThat(next.path("properties").has("feed")).as(resource + " 피드 칸은 미국만").isEqualTo(!korea);
        }
        assertThatThrownBy(() -> ClaudeBookProfile.intradayReplies(ClaudeBookProfile.US_CLAUDE2)).as("끈 판 프로필은 장중 판단 응답 프로필이 없음")
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(ClaudeBookProfile.KR_CLAUDE_FT.fixedRules()).as("한국 두 계좌도 같은 문단(계좌2의 투자 성향 절은 렌더링이 더함)")
                .isEqualTo(ClaudeBookProfile.KR_CLAUDE2_FT.fixedRules());
        assertThat(ClaudeBookProfile.US_CLAUDE_FT.callCapKey()).as("계좌1은 소상한 없음").isNull();
        assertThat(ClaudeBookProfile.US_CLAUDE2_FT.callCapKey()).isEqualTo(Claude2Settings.MAX_CALLS_PER_CYCLE);
        assertThat(ClaudeBookProfile.US_CLAUDE_FT.fixedRules()).as("두 계좌가 같은 문단(계좌2의 투자 성향 절은 렌더링이 더함)")
                .isEqualTo(ClaudeBookProfile.US_CLAUDE2_FT.fixedRules()).isEqualTo(ClaudePrompts.US_FT_FIXED_RULES);

        for (String resource : List.of(ClaudeBookService.US_FT_SCHEMA_RESOURCE, ClaudeBookService.KR_FT_SCHEMA_RESOURCE)) {
            JsonNode schema;
            try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + resource)) {
                schema = MAPPER.readTree(in);
            }
            JsonNode item = schema.path("properties").path("orders").path("items");
            assertThat(item.path("properties").path("atLocal").path("pattern").asString()).as(resource).isEqualTo(FreeTiming.CLOCK_PATTERN);
            assertThat(item.path("properties").path("atLocal").path("type").toString()).isEqualTo("[\"string\",\"null\"]");
            List<String> required = new ArrayList<>();
            item.path("required").forEach(node -> required.add(node.asString()));
            assertThat(required).as(resource + " atLocal은 선택 칸 — 'AT_MINUTE면 필수'는 검증이 막음").doesNotContain("atLocal")
                    .contains("timing", "executionNote");
            assertThat(schema.path("properties").has("checkpoint")).as(resource + " 기존 장중 확인 요청 칸 없음").isFalse();
            // 장중 판단 예약(ADR 0027 결정 3) — 선택 칸 checkpoints: 세션당 최대 횟수·감시 상한·시각 글자가 코드 상수와 같고, 피드는 미국만.
            boolean korea = resource.equals(ClaudeBookService.KR_FT_SCHEMA_RESOURCE);
            JsonNode requests = schema.path("properties").path("checkpoints");
            List<String> top = new ArrayList<>();
            schema.path("required").forEach(node -> top.add(node.asString()));
            assertThat(top).as(resource + " checkpoints는 선택 칸").doesNotContain("checkpoints");
            assertThat(requests.path("maxItems").asInt()).as(resource).isEqualTo(RuleBookService.INTRADAY_MAX);
            JsonNode request = requests.path("items").path("properties");
            assertThat(request.path("at").path("pattern").asString()).isEqualTo(FreeTiming.CLOCK_PATTERN);
            assertThat(request.path("watch").path("maxItems").asInt()).isEqualTo(ExecutionSection.WATCH_MAX);
            assertThat(request.path("watch").path("items").path("pattern").asString()).as(resource + " 감시 종목은 주문 티커와 같은 식")
                    .isEqualTo(item.path("properties").path("ticker").path("pattern").asString());
            List<String> feeds = new ArrayList<>();
            request.path("feed").path("enum").forEach(node -> feeds.add(node.asString()));
            assertThat(feeds).as(resource + " 한국은 늘 감시 1분봉이라 피드 칸이 없음").isEqualTo(korea ? List.of() : ExecutionSection.FEEDS);
        }
        // 장중 판단 절의 숫자 = 의미 검사의 상수(보통 날의 받는 범위·간격·호출 창), 장중 판단이 받는 시점 = INTRADAY_TIMINGS.
        java.time.LocalDate usDay = java.time.LocalDate.of(2026, 10, 27);
        IntradayRequest.Window us = IntradayRequest.window(usDay, UsPaperMarket.INSTANCE.calendar(), false);
        String usRange = FreeTiming.label(us.first().atZone(UsPaperMarket.INSTANCE.calendar().zone()).toLocalTime()) + "~"
                + FreeTiming.label(us.last().atZone(UsPaperMarket.INSTANCE.calendar().zone()).toLocalTime());
        assertThat(usRange).isEqualTo("09:40~15:30");
        assertThat(ClaudePrompts.US_FT_INTRADAY_SECTION).contains(usRange + " ET").contains(IntradayRequest.MIN_GAP.toMinutes() + "분 이상")
                .contains("13_execution.intraday.maxPerSession").contains("nextCheckpoint").doesNotContain("실시간");
        assertThat(ClaudePrompts.KR_FT_INTRADAY_SECTION).contains("09:10~14:50 KST").contains(IntradayRequest.MIN_GAP.toMinutes() + "분 이상")
                .contains("1_basis.intraday.maxPerSession").contains("nextCheckpoint").doesNotContain("실시간").doesNotContain("feed");
        // 보장·사건 줄(ADR 0031 결정 4·7) — 보통 날 보장 시각 = 개장 + 보장 오프셋(미국 12:30 ET·한국 11:30 KST), 지수 종목 = 사건 상수, 그 까닭은
        // 장중 판단 패킷의 출처·사건 칸.
        java.time.LocalDate krDay = java.time.LocalDate.of(2026, 12, 2);
        com.macrodash.analytics.TradingCalendar krCalendar = new com.macrodash.analytics.KrxCalendar(
                KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), java.util.Map.of());
        String usGuarantee = FreeTiming.label(IntradayScheduler.guaranteeAt(usDay, UsPaperMarket.INSTANCE.calendar(), false)
                .atZone(UsPaperMarket.INSTANCE.calendar().zone()).toLocalTime());
        String krGuarantee = FreeTiming.label(IntradayScheduler.guaranteeAt(krDay, krCalendar, true).atZone(krCalendar.zone()).toLocalTime());
        assertThat(usGuarantee + " " + krGuarantee).isEqualTo("12:30 11:30");
        assertThat(ClaudePrompts.US_FT_INTRADAY_SECTION).contains("13_execution.intraday.guarantee").contains("보통 날 " + usGuarantee + " ET")
                .contains("지수(" + IntradayScheduler.US_INDEX + ")").contains("1_basis.origin·3_request.trigger");
        assertThat(ClaudePrompts.KR_FT_INTRADAY_SECTION).contains("1_basis.intraday.guarantee").contains("보통 날 " + krGuarantee + " KST")
                .contains("지수(" + IntradayScheduler.KR_INDEX + ")").contains("1_basis.origin·2_request.trigger");
        assertThat(IntradayScheduler.eventRule(false)).contains("±4%").contains("±1.5%").contains("간격(" + IntradayRequest.MIN_GAP.toMinutes() + "분)");
        assertThat(IntradayRequest.AFTER_OPEN.toMinutes()).as("체결 창과 같은 개장 10분 뒤").isEqualTo(10);
        assertThat(IntradayRequest.AFTER_OPEN).isEqualTo(com.macrodash.analytics.SessionWindows.OPEN_OFFSET);
        assertThat(IntradayRequest.MIN_GAP.toMinutes()).isEqualTo(20);
        assertThat(RuleBookService.INTRADAY_MAX).as("코드가 부를 수 있는 순번 = 종류 수").isEqualTo(3)
                .isEqualTo(RuleBookService.INTRADAY_KINDS.size());
        assertThat(FreeTimingSettings.DEFAULT_INTRADAY_MAX).as("설정 키가 없으면 2 그대로 — 배포만으로는 셋째를 부르지 않음").isEqualTo(2);
        for (int slot = 1; slot <= RuleBookService.INTRADAY_MAX; slot++) {
            assertThat(RuleBookService.intradayKind(slot)).isEqualTo("INTRADAY_" + slot);
            assertThat(RuleBookService.intraday(RuleBookService.intradayKind(slot))).isTrue();
        }
        assertThatThrownBy(() -> RuleBookService.intradayKind(4)).isInstanceOf(IllegalArgumentException.class);
        assertThat(RuleBookService.intraday("INTRADAY_4")).isFalse();
        assertThat(RuleBookService.intraday(null)).isFalse();
        assertThat(IntradayRequest.BEFORE_CLOSE).isEqualTo(ExecutionSection.CHECKPOINT_BEFORE_CLOSE);
        for (String section : List.of(ClaudePrompts.US_FT_INTRADAY_SECTION, ClaudePrompts.KR_FT_INTRADAY_SECTION)) {
            String timingLine = section.lines().filter(line -> line.startsWith("- 장중 판단 주문의 timing은")).findFirst().orElseThrow();
            for (String timing : FreeTiming.INTRADAY_TIMINGS) {
                assertThat(timingLine).as("장중 판단 timing 줄에 " + timing).contains(timing);
            }
            assertThat(timingLine).doesNotContain("NEXT_OPEN");
        }
        assertThat(ClaudePrompts.US_FT_FIXED_RULES).contains(ClaudePrompts.US_FT_INTRADAY_SECTION + ClaudePrompts.OUTPUT_HEADER)
                .contains(ClaudePrompts.US_FT_INTRADAY_LINE).doesNotContain(ClaudePrompts.CLAUDE2_NO_INTRADAY_LINE);
        assertThat(ClaudePrompts.KR_FT_FIXED_RULES).contains(ClaudePrompts.KR_FT_FILL_SECTION + ClaudePrompts.KR_FT_INTRADAY_SECTION
                + ClaudePrompts.OUTPUT_HEADER).doesNotContain("장중 정보는 보지 못한다");
        assertThat(ExecutionSection.INTRADAY_RULES.get(0)).contains("+ " + PaperCheckpointJob.WINDOW_START_MINUTES + "분")
                .contains("+ " + PaperCheckpointJob.WINDOW_END_MINUTES + "분").contains(IntradayRequest.MIN_GAP.toMinutes() + "분 이상");
        // 한국 켠 판의 하드 규칙 줄 — 시장 묶음의 'NEXT_OPEN뿐'이 아니라 그 프로필의 받는 시점 셋. 끈 판 줄은 그대로.
        String krOn = FrameworkService.render(ClaudeBookProfile.KR_CLAUDE_FT, FrameworkService.interimBody(MAPPER), 0, null);
        String krOff = FrameworkService.render(ClaudeBookProfile.KR_CLAUDE, FrameworkService.interimBody(MAPPER), 0, null);
        assertThat(krOn).contains("- 체결 시점은 AT_MINUTE(다음 거래일의 지정한 분, 개장 10분 뒤 ~ 종가 단일가 앞 — atLocal에 한국 시간 HH:MM)·"
                + "NEXT_CLOSE(다음 거래일 종가), 정수 주").doesNotContain("NEXT_OPEN(다음 거래일 시가)");
        assertThat(krOff).contains("- 체결 시점은 NEXT_OPEN(다음 거래일 시가)뿐, 정수 주");

        for (ClaudeBookProfile off : List.of(ClaudeBookProfile.US_CLAUDE, ClaudeBookProfile.US_CLAUDE2, ClaudeBookProfile.US_CLAUDE2_C2,
                ClaudeBookProfile.US_CLAUDE2_CHECKPOINT, ClaudeBookProfile.KR_CLAUDE, ClaudeBookProfile.KR_CLAUDE2,
                ClaudeBookProfile.KR_CLAUDE2_CHECKPOINT)) {
            assertThat(off.freeTiming()).as("끈 판 " + off.code() + " " + off.schemaResource()).isFalse();
            assertThat(off.timings()).as("끈 판은 분 단위 지정 시각을 받지 않음").doesNotContain(PaperBooks.AT_MINUTE);
        }
    }

    @Test
    @DisplayName("운영 결정 문맥(계좌마다 — 미국 계좌1·계좌2·한국)마다 스키마 timing enum = 프로필의 받는 시점(순서까지) = 검증기가 받는 시점·순위 키, 이른 시점이 그 첫째, 시점마다 고정 문단에 그 이름, 모두 V17 CHECK 안")
    void schemaMarketAndPromptAgree() throws IOException {
        List<ClaudeDecisionPipeline.MarketContext> contexts = ClaudeBookService.marketContexts(mock(PacketBuilder.class),
                mock(KrPacketBuilder.class));
        assertThat(contexts).extracting(context -> context.profile().code())
                .as("운영 문맥(계좌마다 — 미국 둘 · 한국 둘, 계좌2 명세 §9-1·한국 계좌2 사용자 결정 2026-11-02)")
                .containsExactly(PaperBooks.CLAUDE, PaperBooks.CLAUDE2, PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2);
        assertThat(contexts).extracting(context -> context.market().code())
                .containsExactly(UsPaperMarket.INSTANCE.code(), UsPaperMarket.INSTANCE.code(), KrPaperMarket.INSTANCE.code(),
                        KrPaperMarket.INSTANCE.code());
        assertThat(contexts.get(2).market()).isSameAs(KrPaperMarket.INSTANCE);
        assertThat(contexts.get(2).schemaResource()).isEqualTo(ClaudeBookService.KR_SCHEMA_RESOURCE);
        assertThat(contexts.get(3).schemaResource()).isEqualTo(ClaudeBookService.KR_CLAUDE2_SCHEMA_RESOURCE);
        assertThat(contexts).extracting(context -> context.shared() != null).as("미국 둘만 시장 입력을 함께 씀(입력 동결)")
                .containsExactly(true, true, false, false);
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
            if (!profile.timed() && profile.code().equals(context.market().claudeBook())) {
                // 시장 기본 계좌 — 시장 묶음의 받는 시점·두 갈래 순위·시장 몫 그대로(한국 Claude 계좌2는 메뉴 계좌 — 아래 따로).
                PaperMarket market = context.market();
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
        assertThat(UsTimedFills.TIMINGS).as("장부 2b가 받는 시점 = 메뉴의 시각 지정 일곱 + 장중 확인의 MARKET + 분 단위 지정 시각(ADR 0027 — 어느 메뉴에도 아직 없음)")
                .containsExactlyInAnyOrderElementsOf(java.util.stream.Stream.concat(timed.stream(),
                        java.util.stream.Stream.of(PaperBooks.MARKET, PaperBooks.AT_MINUTE)).toList());
        assertThat(book2.timings()).as("끈 판 메뉴에는 분 단위 지정 시각이 없음").doesNotContain(PaperBooks.AT_MINUTE);
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

    @Test
    @DisplayName("한국 Claude 계좌2(단계 2a): 메뉴 여덟 = 스키마 enum = 순위 0~7 = 고정 문단 timing 줄 = 장부 매시 사다리 시각 + 시가·종가 = 수집기 KR_TIMED_TIMINGS + "
            + "NEXT_OPEN, 모두 V17 CHECK 안, NEXT_OBSERVATION은 우선순위 줄에만, 계좌1 스키마·문단은 NEXT_OPEN뿐")
    void krClaude2MenuIsLockedEverywhere() throws IOException {
        ClaudeBookProfile kr2 = ClaudeBookProfile.KR_CLAUDE2;
        assertThat(kr2.timings()).containsExactly("NEXT_OPEN", "AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500",
                "NEXT_CLOSE").isEqualTo(PaperBooks.KR_CLAUDE2_TIMINGS).isEqualTo(schemaTimings(ClaudeBookService.KR_CLAUDE2_SCHEMA_RESOURCE));
        assertThat(new java.util.HashSet<>(kr2.orderValidation().ranks().values())).as("시점마다 다른 때 체결").hasSize(8);
        assertThat(kr2.orderValidation().earlyTiming()).isEqualTo(PaperBooks.NEXT_OPEN);
        assertThat(v17Timings()).containsAll(kr2.timings());
        assertThat(kr2.timings().stream().filter(t -> KrTimedLadder.hourly(t) != null).toList())
                .as("장부 매시 사다리 시각").containsExactlyInAnyOrderElementsOf(KrTimedLadder.HOURLY.keySet());
        String collector = java.nio.file.Files.readString(Path.of("../collector/app/tasks/kr_paper_timed.py"));
        Matcher tuple = Pattern.compile("KR_TIMED_TIMINGS = \\(([^)]*)\\)").matcher(collector);
        assertThat(tuple.find()).isTrue();
        List<String> collected = new ArrayList<>();
        Matcher quoted = Pattern.compile("\"([A-Z_0-9]+)\"").matcher(tuple.group(1));
        while (quoted.find()) {
            collected.add(quoted.group(1));
        }
        List<String> later = new ArrayList<>(kr2.timings().subList(1, 8));
        later.add(PaperBooks.MARKET);
        assertThat(collected).as("수집기가 1분봉을 받는 시점 = 메뉴의 시가 밖 일곱 + 장중 확인의 MARKET(단계 2b)").containsExactlyElementsOf(later);

        // 장중 확인 요청(단계 2b) — 시각 목록이 응답 스키마 enum·의미 검사·고정 문단에서 같음.
        JsonNode checkpoint;
        try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + ClaudeBookService.KR_CLAUDE2_SCHEMA_RESOURCE)) {
            checkpoint = MAPPER.readTree(in).path("properties").path("checkpoint");
        }
        List<String> times = new ArrayList<>();
        checkpoint.path("properties").path("atKst").path("enum").forEach(t -> times.add(t.asString()));
        assertThat(times).isEqualTo(KrCheckpointRequest.TIMES.stream().map(KrTimedLadder::label).toList());
        assertThat(checkpoint.path("properties").has("feed")).as("한국 확인은 늘 1분봉 — 피드 칸 없음").isFalse();
        assertThat(ClaudePrompts.KR_CLAUDE2_CHECKPOINT_SECTION).contains("10:00~15:00 KST의 30분 단위");
        assertThat(schemaTimings(KrCheckpointPacket.SCHEMA_RESOURCE)).as("한국 장중 확인 응답의 시점 = 확인 프로필")
                .isEqualTo(PaperBooks.CHECKPOINT_TIMINGS).isEqualTo(ClaudeBookProfile.KR_CLAUDE2_CHECKPOINT.timings());
        assertThat(ClaudeDecisionPipeline.checkpointSchemaResource(kr2)).isEqualTo(KrCheckpointPacket.SCHEMA_RESOURCE);
        assertThat(ClaudeDecisionPipeline.checkpointSchemaResource(ClaudeBookProfile.US_CLAUDE2_C2)).isEqualTo(CheckpointPacket.SCHEMA_RESOURCE);

        String rules = kr2.fixedRules();
        String timingLine = rules.lines().filter(line -> line.startsWith("- timing은")).findFirst().orElseThrow();
        for (String timing : kr2.timings()) {
            assertThat(timingLine).as("timing 줄에 " + timing).contains(timing);
        }
        assertThat(rules.lines().filter(line -> line.contains(ExecutionAudit.NEXT_OBSERVATION)).toList())
                .as("NEXT_OBSERVATION은 우선순위 줄에만").singleElement().asString().startsWith("우선순위(고정)");
        assertThat(schemaTimings(ClaudeBookService.KR_SCHEMA_RESOURCE)).as("계좌1은 그대로").containsExactly(PaperBooks.NEXT_OPEN);
        assertThat(ClaudeBookProfile.KR_CLAUDE.fixedRules()).doesNotContain("AT_1000");
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

    @Test
    @DisplayName("장중 확인 응답(계좌2 단계 2): 확인 스키마 timing enum = 확인 프로필의 받는 시점(MARKET·AT_1000~AT_1500·NEXT_CLOSE) = 검증기 순위 키(MARKET 0 < AT_1000 1 < … < NEXT_CLOSE 7) = 확인 패킷의 시점, c2-2 장중 확인 절이 MARKET·NEXT_CLOSE를 말함, 모두 마지막으로 timing CHECK를 다시 만드는 V18 안, 장부 2b의 시점 = 메뉴 ∪ {MARKET}")
    void checkpointMenuIsLockedEverywhere() throws IOException {
        ClaudeBookProfile reply = ClaudeBookProfile.US_CLAUDE2_CHECKPOINT;
        assertThat(reply.code()).isEqualTo(PaperBooks.CLAUDE2);
        assertThat(reply.timings()).containsExactly("MARKET", "AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400",
                "AT_1500", "NEXT_CLOSE").isEqualTo(PaperBooks.CHECKPOINT_TIMINGS).isEqualTo(CheckpointPacket.TIMINGS)
                .isEqualTo(schemaTimings(CheckpointPacket.SCHEMA_RESOURCE));
        assertThat(reply.schemaResource()).isEqualTo(CheckpointPacket.SCHEMA_RESOURCE);
        assertThat(reply.fixedRules()).isEqualTo(ClaudePrompts.CLAUDE2_FIXED_RULES_C2);
        assertThat(reply.timed()).isTrue();
        assertThat(reply.checkpoints()).isTrue();
        Map<String, Integer> ranks = new LinkedHashMap<>();
        for (int i = 0; i < reply.timings().size(); i++) {
            ranks.put(reply.timings().get(i), i);
        }
        assertThat(reply.timingRanks()).containsExactlyEntriesOf(ranks);
        OrderValidator.Market validation = reply.orderValidation();
        assertThat(validation.ranks()).isEqualTo(reply.timingRanks());
        assertThat(validation.timings()).isEqualTo(reply.timings());
        assertThat(validation.earlyTiming()).isEqualTo(PaperBooks.MARKET);
        assertThat(ClaudeBookProfile.US_CLAUDE2_C2.timings()).as("아침 결정은 MARKET을 받지 않음").doesNotContain(PaperBooks.MARKET);
        assertThat(schemaTimings(ClaudeBookService.CLAUDE2_C2_SCHEMA_RESOURCE)).doesNotContain(PaperBooks.MARKET);

        String section = ClaudePrompts.CLAUDE2_CHECKPOINT_SECTION;
        assertThat(section).contains(PaperBooks.MARKET).contains(PaperBooks.NEXT_CLOSE).contains("AT_*");
        assertThat(reply.fixedRules()).contains(section);

        // 마이그레이션 가운데 마지막으로 paper_orders_timing_check를 다시 만드는 파일이 확인 시점을 모두 받음(V18이 MARKET을, V22가 AT_MINUTE를 더함 — 뒤 파일은
        // 늘 앞 파일의 상위 집합이어야 하므로 파일 번호를 박지 않음). V17 대조(v17Timings)는 그대로.
        Path last = null;
        try (var files = Files.list(Path.of("../db/migrations"))) {
            for (Path file : files.filter(p -> p.getFileName().toString().matches("V\\d+__.*\\.sql")).sorted(java.util.Comparator.comparing(p -> Integer.parseInt(
                    p.getFileName().toString().replaceAll("^V(\\d+)__.*$", "$1")))).toList()) {
                if (Files.readString(file).contains("ADD CONSTRAINT paper_orders_timing_check")) {
                    last = file;
                }
            }
        } catch (java.nio.file.NoSuchFileException e) {
            assumeTrue(false, "db/migrations를 찾을 수 없습니다");
        }
        assertThat(last).isNotNull();
        Matcher check = Pattern.compile("CHECK \\(timing IN \\(([^)]*)\\)\\)").matcher(Files.readString(last));
        assertThat(check.find()).isTrue();
        List<String> latest = new ArrayList<>();
        Matcher value = Pattern.compile("'([A-Z_0-9]+)'").matcher(check.group(1));
        while (value.find()) {
            latest.add(value.group(1));
        }
        assertThat(latest).containsAll(reply.timings()).containsAll(PaperBooks.CLAUDE2_TIMINGS).containsAll(v17Timings())
                .contains(PaperBooks.AT_MINUTE);
        assertThat(v17Timings()).doesNotContain(PaperBooks.MARKET);

        assertThat(UsTimedFills.TIMINGS).containsExactlyInAnyOrderElementsOf(java.util.stream.Stream.concat(
                ExecutionAudit.MENU.keySet().stream(), java.util.stream.Stream.of(PaperBooks.MARKET, PaperBooks.AT_MINUTE)).toList());
        assertThat(reply.timings()).as("끈 판의 장중 확인 응답에는 분 단위 지정 시각이 없음").doesNotContain(PaperBooks.AT_MINUTE);
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
