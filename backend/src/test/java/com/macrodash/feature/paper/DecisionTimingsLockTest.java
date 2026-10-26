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
 * 값)이 운영 결정 문맥({@link ClaudeBookService#marketContexts})마다 같은 시점을 말하는지 봅니다. 셋은 정적 JSON·코드 상수·프롬프트 글로
 * 따로 있어서, 하나만 바뀌면 API는 받는데 검증기가 거절하거나 프롬프트가 받지 않는 시점을 권합니다. 한국 문맥(E2)을 운영 목록에
 * 더하면 이 시험이 그 문맥도 봅니다.
 */
class DecisionTimingsLockTest {

    @Test
    @DisplayName("운영 결정 문맥마다 스키마 timing enum = 시장 체결 시점(순서까지), 이른 시점이 그 첫째, 시점마다 고정 문단에 그 이름이 있음")
    void schemaMarketAndPromptAgree() throws IOException {
        List<ClaudeDecisionPipeline.MarketContext> contexts = ClaudeBookService.marketContexts(mock(PacketBuilder.class));
        assertThat(contexts).extracting(context -> context.market().code()).as("운영 문맥(지금 미국 하나)")
                .containsExactly(UsPaperMarket.INSTANCE.code());
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
        }
    }
}
