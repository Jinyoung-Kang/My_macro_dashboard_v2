package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 체결 시점 세 곳의 잠금(2단계 명세 K38) — 응답 스키마 파일의 {@code orders.items.timing.enum}(API가 받는 값), 시장 묶음의
 * {@link PaperMarket#timings}(검증기가 받는 값), 시스템 프롬프트 고정 문단({@link PaperMarket#promptFixedRules} — Claude에게 권하는
 * 값)이 운영 결정 문맥({@link ClaudeBookService#marketContexts} — 미국·한국, E2b)마다 같은 시점을 말하는지 봅니다. 셋은 정적 JSON·코드 상수·
 * 프롬프트 글로 따로 있어서, 하나만 바뀌면 API는 받는데 검증기가 거절하거나 프롬프트가 받지 않는 시점을 권합니다.
 */
class DecisionTimingsLockTest {

    @Test
    @DisplayName("운영 결정 문맥마다 스키마 timing enum = 시장 체결 시점(순서까지), 이른 시점이 그 첫째, 시점마다 고정 문단에 그 이름이 있음")
    void schemaMarketAndPromptAgree() throws IOException {
        List<ClaudeDecisionPipeline.MarketContext> contexts = ClaudeBookService.marketContexts(mock(PacketBuilder.class),
                mock(KrPacketBuilder.class));
        assertThat(contexts).extracting(context -> context.market().code()).as("운영 문맥(미국 · 한국 — E2b)")
                .containsExactly(UsPaperMarket.INSTANCE.code(), KrPaperMarket.INSTANCE.code());
        assertThat(contexts.get(1).market()).isSameAs(KrPaperMarket.INSTANCE);
        assertThat(contexts.get(1).schemaResource()).isEqualTo(ClaudeBookService.KR_SCHEMA_RESOURCE);
        assertThat(ClaudeBookService.marketContexts(mock(PacketBuilder.class), null)).as("한국 패킷 빌더가 없으면 미국 하나(시험)")
                .extracting(context -> context.market().code()).containsExactly(UsPaperMarket.INSTANCE.code());
        for (ClaudeDecisionPipeline.MarketContext context : contexts) {
            PaperMarket market = context.market();
            JsonNode schema;
            try (InputStream in = DecisionTimingsLockTest.class.getResourceAsStream("/" + context.schemaResource())) {
                assertThat(in).as(market.code() + " 응답 스키마 " + context.schemaResource()).isNotNull();
                schema = MAPPER.readTree(in);
            }
            List<String> schemaTimings = new ArrayList<>();
            schema.path("properties").path("orders").path("items").path("properties").path("timing").path("enum")
                    .forEach(node -> schemaTimings.add(node.asString()));
            assertThat(schemaTimings).as(market.code() + " 스키마 timing enum = 시장 체결 시점").isNotEmpty()
                    .isEqualTo(market.timings());
            assertThat(market.earlyTiming()).as(market.code() + " 이른 시점").isEqualTo(market.timings().get(0));
            assertThat(market.orderValidation().timings()).as(market.code() + " 검증기가 받는 시점")
                    .isEqualTo(market.timings());
            for (String timing : market.timings()) {
                assertThat(market.promptFixedRules()).as(market.code() + " 고정 문단에 " + timing).contains(timing);
            }
            // 계좌 프로필(계좌2 명세 §9-1) — 결정 파이프라인이 실제로 쓰는 받는 시점·고정 문단도 같은 시점을 말함.
            ClaudeBookProfile profile = context.profile();
            assertThat(profile.code()).as(market.code() + " 프로필 계좌").isEqualTo(market.claudeBook());
            assertThat(profile.timings()).as(market.code() + " 프로필의 받는 시점 = 스키마 enum").isEqualTo(schemaTimings);
            for (String timing : profile.timings()) {
                assertThat(profile.fixedRules()).as(market.code() + " 프로필 고정 문단에 " + timing).contains(timing);
            }
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
