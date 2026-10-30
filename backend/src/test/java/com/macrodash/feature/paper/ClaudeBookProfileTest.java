package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.analytics.OrderValidator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.entry;
import static org.mockito.Mockito.mock;

/**
 * Claude 계좌 프로필(계좌2 명세 §9-1, 1-1) — 시장 기본 Claude 계좌(미국 계좌1·한국 Claude 계좌)의 프로필은 시장 묶음의 값을 그대로 옮긴
 * 것이고, 프로필로 렌더링한 시스템 프롬프트는 시장 렌더링과 글자 그대로(미국 고정본)이며, 끝의 고정 문단만 프로필에서 받는지 봅니다.
 */
class ClaudeBookProfileTest {

    @Test
    @DisplayName("운영 결정 문맥 = 미국 계좌1·한국 Claude 계좌 프로필 — 코드·응답 스키마·고정 문단·받는 체결 시점은 시장 묶음 값 그대로, 시점 순위는 이른 시점 0·나머지 1, 패킷 변형·소상한 키는 없음")
    void marketDefaultProfilesCarryTheMarketValues() {
        assertThat(ClaudeBookService.marketContexts(mock(PacketBuilder.class), mock(KrPacketBuilder.class)))
                .extracting(ClaudeDecisionPipeline.MarketContext::profile)
                .containsExactly(ClaudeBookProfile.US_CLAUDE, ClaudeBookProfile.US_CLAUDE2, ClaudeBookProfile.KR_CLAUDE);

        ClaudeBookProfile us = ClaudeBookProfile.US_CLAUDE;
        assertThat(us.market()).isSameAs(UsPaperMarket.INSTANCE);
        assertThat(us.code()).isEqualTo(PaperBooks.CLAUDE).isEqualTo(UsPaperMarket.INSTANCE.claudeBook());
        assertThat(us.schemaResource()).isEqualTo(ClaudeBookService.SCHEMA_RESOURCE);
        assertThat(us.fixedRules()).isEqualTo(ClaudePrompts.FIXED_RULES).isEqualTo(UsPaperMarket.INSTANCE.promptFixedRules());
        assertThat(us.timings()).containsExactly(OrderValidator.NEXT_OBSERVATION, OrderValidator.NEXT_CLOSE)
                .isEqualTo(UsPaperMarket.INSTANCE.timings());
        assertThat(us.timingRanks()).as("이른 시점 0·나머지 1(검증기의 두 갈래)")
                .containsExactly(entry(OrderValidator.NEXT_OBSERVATION, 0), entry(OrderValidator.NEXT_CLOSE, 1));
        assertThat(us.packetVariant()).isNull();
        assertThat(us.callCapKey()).isNull();
        assertThat(us.timingNames()).isEqualTo(OrderValidator.Market.US.timingNames());
        assertThat(us.timed()).isFalse();

        ClaudeBookProfile kr = ClaudeBookProfile.KR_CLAUDE;
        assertThat(kr.market()).isSameAs(KrPaperMarket.INSTANCE);
        assertThat(kr.code()).isEqualTo(PaperBooks.KR_CLAUDE).isEqualTo(KrPaperMarket.INSTANCE.claudeBook());
        assertThat(kr.schemaResource()).isEqualTo(ClaudeBookService.KR_SCHEMA_RESOURCE);
        assertThat(kr.fixedRules()).isEqualTo(ClaudePrompts.KR_FIXED_RULES)
                .isEqualTo(KrPaperMarket.INSTANCE.promptFixedRules());
        assertThat(kr.timings()).isEqualTo(KrPaperMarket.INSTANCE.timings()).startsWith(PaperBooks.NEXT_OPEN);
        assertThat(kr.timingRanks()).hasSize(kr.timings().size()).containsEntry(PaperBooks.NEXT_OPEN, 0);
        kr.timings().stream().skip(1).forEach(timing -> assertThat(kr.timingRanks()).containsEntry(timing, 1));
        assertThat(kr.packetVariant()).isNull();
        assertThat(kr.callCapKey()).isNull();
        assertThat(kr.timed()).isFalse();

        assertThat(ClaudeBookProfile.marketDefault(UsPaperMarket.INSTANCE, ClaudeBookService.SCHEMA_RESOURCE))
                .as("시장 묶음에서 만든 기본 계좌 프로필 = 운영 상수").isEqualTo(us);
        assertThat(ClaudeBookProfile.marketDefault(TestKrMarket.INSTANCE, ClaudeBookService.SCHEMA_RESOURCE).code())
                .as("시험용 시장 묶음도 그 시장 기본 계좌").isEqualTo(TestKrMarket.CLAUDE_BOOK);
    }

    @Test
    @DisplayName("프로필 렌더링 = 시장 렌더링(글자 그대로 — 미국 고정본 render-us-v0-default.txt), 끝의 고정 문단은 시장이 아니라 프로필의 것")
    void renderTakesTheFixedRulesFromTheProfile() {
        JsonNode body = FrameworkService.interimBody(MAPPER);
        JsonNode defaults = PaperFixtures.settings(new FakePaperStore()).defaultsJson();
        Golden.assertMatches("render-us-v0-default.txt",
                FrameworkService.render(ClaudeBookProfile.US_CLAUDE, body, 0, defaults));
        assertThat(FrameworkService.render(ClaudeBookProfile.KR_CLAUDE, body, 0, defaults))
                .isEqualTo(FrameworkService.render(KrPaperMarket.INSTANCE, body, 0, defaults));

        // 같은 미국 시장 묶음에 고정 문단만 다른 계좌 — 하드 규칙 줄까지는 계좌1과 같고 끝 문단만 그 계좌 것.
        ClaudeBookProfile other = new ClaudeBookProfile(UsPaperMarket.INSTANCE, "t_claude_other",
                ClaudeBookService.SCHEMA_RESOURCE, "## 시험용 고정 문단\n- 한 줄", null, UsPaperMarket.INSTANCE.timings(),
                ClaudeBookProfile.US_CLAUDE.timingRanks(), null);
        String book1 = FrameworkService.render(ClaudeBookProfile.US_CLAUDE, body, 0, defaults);
        String rendered = FrameworkService.render(other, body, 0, defaults);
        String beforeFixed = book1.substring(0, book1.indexOf("## 근거(고정)"));
        assertThat(rendered).isEqualTo(beforeFixed + "## 시험용 고정 문단\n- 한 줄");
    }

    @Test
    @DisplayName("계좌2 시스템 프롬프트(계좌2 명세 §9-4) — 고정본 render-us-claude2-v0-default.txt, 계좌1과 ROLE·원칙·엔진·지침·하드 규칙 줄까지 같고 끝 고정 문단만 다름, 그 문단은 계좌1 문단에서 세 곳(우선순위 첫 줄·timing 줄·체결 절)만 다름")
    void claude2RenderDiffersOnlyInTheFixedRules() {
        JsonNode body = FrameworkService.interimBody(MAPPER);
        JsonNode defaults = PaperFixtures.settings(new FakePaperStore()).defaultsJson();
        String book1 = FrameworkService.render(ClaudeBookProfile.US_CLAUDE, body, 0, defaults);
        String book2 = FrameworkService.render(ClaudeBookProfile.US_CLAUDE2, body, 0, defaults);
        Golden.assertMatches("render-us-claude2-v0-default.txt", book2);
        Golden.assertMatches("render-us-v0-default.txt", book1);
        String shared = book1.substring(0, book1.indexOf("## 근거(고정)"));
        assertThat(book2).startsWith(shared + ClaudePrompts.CLAUDE2_PRIORITY + "\n## 근거(고정)");
        assertThat(book2).contains(ClaudePrompts.ROLE);

        // 세 곳을 되돌리면 계좌1 문단 그대로(그 밖의 문장은 글자까지 같음).
        String rules = ClaudePrompts.CLAUDE2_FIXED_RULES;
        assertThat(rules).startsWith(ClaudePrompts.CLAUDE2_PRIORITY + "\n");
        String back = rules.substring(ClaudePrompts.CLAUDE2_PRIORITY.length() + 1)
                .replace(ClaudePrompts.CLAUDE2_TIMING_LINES, ClaudePrompts.US_TIMING_LINE)
                .replace(ClaudePrompts.CLAUDE2_FILL_SECTION, "");
        assertThat(back).isEqualTo(ClaudePrompts.FIXED_RULES);
        assertThat(rules).contains("## 체결(고정)").contains("결정 뒤 장중 정보는 보지 못한다").contains("executionNote")
                .contains("200자").doesNotContain("5bp");
        assertThat(rules.indexOf("## 체결(고정)")).as("체결 절은 출력 절 앞").isLessThan(rules.indexOf("## 출력(고정)"));
    }

    @Test
    @DisplayName("계좌2 프로필의 검증기 몫 — 받는 시점 여덟·순위 0~7·근거 문구 이름(다음 세션 시가·다음 세션 10:00 … 확정 종가)·달러 표기, 닫힌 시점 없음")
    void claude2OrderValidation() {
        OrderValidator.Market market = ClaudeBookProfile.US_CLAUDE2.orderValidation();
        assertThat(market.timings()).isEqualTo(PaperBooks.CLAUDE2_TIMINGS);
        assertThat(market.earlyTiming()).isEqualTo(PaperBooks.NEXT_OPEN);
        assertThat(market.timingNames()).containsEntry("NEXT_OPEN", "다음 세션 시가").containsEntry("AT_1000", "다음 세션 10:00")
                .containsEntry("AT_1500", "다음 세션 15:00").containsEntry("NEXT_CLOSE", "확정 종가").hasSize(8);
        assertThat(market.money()).isEqualTo(OrderValidator.Money.USD);
        assertThat(market.closed()).isEmpty();
        assertThat(ClaudeBookProfile.US_CLAUDE2.timingRanks().get("AT_1500")).isEqualTo(6);
        assertThat(ClaudeBookProfile.US_CLAUDE2.timingRanks().get("NEXT_CLOSE")).isEqualTo(7);
    }

    @Test
    @DisplayName("시점 순위는 받는 체결 시점마다 하나 — 빠지거나 남는 시점, 받는 시점 없음은 만들 때 거절")
    void ranksMustCoverTheTimings() {
        List<String> timings = UsPaperMarket.INSTANCE.timings();
        Map<String, Integer> missing = Map.of(OrderValidator.NEXT_OBSERVATION, 0);
        assertThatThrownBy(() -> new ClaudeBookProfile(UsPaperMarket.INSTANCE, "t_x", ClaudeBookService.SCHEMA_RESOURCE,
                "x", null, timings, missing, null)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("시점 순위");
        Map<String, Integer> extra = new LinkedHashMap<>(ClaudeBookProfile.US_CLAUDE.timingRanks());
        extra.put(PaperBooks.NEXT_OPEN, 2);
        assertThatThrownBy(() -> new ClaudeBookProfile(UsPaperMarket.INSTANCE, "t_x", ClaudeBookService.SCHEMA_RESOURCE,
                "x", null, timings, extra, null)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("시점 순위");
        assertThatThrownBy(() -> new ClaudeBookProfile(UsPaperMarket.INSTANCE, "t_x", ClaudeBookService.SCHEMA_RESOURCE,
                "x", null, List.of(), Map.of(), null)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("받는 체결 시점");
    }
}
