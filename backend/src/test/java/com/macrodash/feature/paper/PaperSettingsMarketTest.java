package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 시장별 설정 읽기(C1a, 2단계 명세 §9 묶음 A 리뷰 메모 'C1 — 시장별 설정 읽기') — {@link PaperSettings#from(JsonNode, PaperMarket)}·
 * {@link PacketBuilder.Limits#from(JsonNode, PaperMarket)}가 장부 키·{@code rules.*}·검증기 한도를 그 시장 접두어 아래에서, 현금성·최소 주문
 * 금액이 없으면 그 시장 기본값으로 읽고, 13F·게이트 키({@code gate.*}·{@code blend.*})는 설정 루트에서 읽는지. 미국 판은 이 묶음 전과
 * 같은 값·같은 fallbacks입니다(고정본·해시는 각 시험이 지킴).
 */
class PaperSettingsMarketTest {

    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    /** 기본 본문(C1b부터 한국 묶음 kr.*도 들어 있음 — 한국 키가 없는 옛 행은 {@link #withoutKr}). */
    private static ObjectNode defaults() {
        return (ObjectNode) PaperFixtures.settings(new FakePaperStore()).defaultsJson();
    }

    /** 한국 묶음이 없는 기본 본문 — C1b 전에 만든 행(서버의 지금 행)과 같은 모양. */
    private static ObjectNode withoutKr() {
        ObjectNode body = defaults();
        body.remove("kr");
        return body;
    }

    /** 접두어 kr.·현금성 기본 153130·최소 주문 기본 500,000원인 시장 묶음(가짜 — 실제 한국 묶음 KrPaperMarket은 C1c). */
    private static PaperMarket krLike() {
        PaperMarket market = mock(PaperMarket.class);
        when(market.settingsPrefix()).thenReturn("kr.");
        when(market.defaultCashLike()).thenReturn(List.of("153130"));
        when(market.defaultMinOrderNotional()).thenReturn(500_000.0);
        return market;
    }

    @Test
    @DisplayName("미국 판 — 접두어 없이 지금 키·현금성 기본 SHY·최소 주문 $500, fallbacks는 지금 키 이름(이 묶음 전 값 그대로)")
    void usReadsTheRootKeys() {
        PaperSettings read = PaperSettings.from(defaults(), US);
        assertThat(List.of(read.slippageBp(), read.trailingStopPct(), (double) read.lockoutTradingDays()))
                .containsExactly(5.0, 8.0, 20.0);
        assertThat(read.cashLikeTickers()).containsExactly("SHY");
        assertThat(read.fallbacks()).isEmpty();
        assertThat(PacketBuilder.Limits.from(defaults(), US)).isEqualTo(new PacketBuilder.Limits(10, 20, 20, 500, 20, 5));

        ObjectNode body = defaults();
        body.put("slippageBp", 7).put("trailingStopPct", 11).put("maxPositions", 9);
        body.remove("lockoutTradingDays");
        body.remove("cashLikeTickers");
        PaperSettings changed = PaperSettings.from(body, US);
        assertThat(changed.slippageBp()).isEqualTo(7);
        assertThat(changed.trailingStopPct()).isEqualTo(11);
        assertThat(changed.cashLikeTickers()).as("키가 없으면 미국 현금성 기본값").containsExactly("SHY");
        assertThat(changed.fallbacks()).containsExactly("lockoutTradingDays", "cashLikeTickers");
        assertThat(PacketBuilder.Limits.from(body, US).maxPositions()).isEqualTo(9);
        assertThat(PaperSettings.from(null, US)).isEqualTo(PaperSettings.defaults());
    }

    @Test
    @DisplayName("한국 접두어 — 장부 키·rules.*·검증기 한도는 kr. 아래에서만 읽고 미국 키가 새지 않음, 게이트·섞기는 설정 루트")
    void prefixedKeysDoNotLeak() {
        ObjectNode body = defaults();
        body.put("slippageBp", 9).put("maxPositions", 20);
        ObjectNode kr = body.putObject("kr");
        kr.put("slippageBp", 3).put("trailingStopPct", 12).put("lockoutTradingDays", 10).put("maxPositions", 7)
                .put("minOrderNotional", 250_000);
        kr.putArray("cashLikeTickers").add("153130");
        kr.putObject("rules").put("parkCashThresholdPct", 3);
        PaperMarket market = krLike();

        PaperSettings read = PaperSettings.from(body, market);
        assertThat(read.slippageBp()).isEqualTo(3);
        assertThat(read.trailingStopPct()).isEqualTo(12);
        assertThat(read.lockoutTradingDays()).isEqualTo(10);
        assertThat(read.cashLikeTickers()).containsExactly("153130");
        assertThat(read.cashLike("SHY")).as("미국 현금성이 한국 책에 새지 않음").isFalse();
        assertThat(read.rules().parkCashThresholdPct()).isEqualTo(3);
        assertThat(read.fallbacks()).isEmpty();
        assertThat(read.gate()).as("게이트는 설정 루트(미국 전용 단계)").isEqualTo(PaperSettings.from(body).gate());
        assertThat(read.blend()).isEqualTo(PaperSettings.from(body).blend());

        PacketBuilder.Limits limits = PacketBuilder.Limits.from(body, market);
        assertThat(limits.maxPositions()).isEqualTo(7);
        assertThat(limits.minOrderNotional()).isEqualTo(250_000);

        PaperSettings us = PaperSettings.from(body);
        assertThat(us.slippageBp()).as("미국 판은 루트 키 그대로").isEqualTo(9);
        assertThat(us.cashLikeTickers()).containsExactly("SHY");
        assertThat(PacketBuilder.Limits.from(body).maxPositions()).isEqualTo(20);
    }

    @Test
    @DisplayName("한국 묶음이 없는 행(한국 키를 아직 쓰지 않음) — 키마다 기본값, 현금성·최소 주문은 그 시장 기본값(SHY·$500 아님), fallbacks는 접두어를 붙인 실제 키 이름")
    void missingSectionFallsBackToMarketDefaults() {
        ObjectNode body = withoutKr();
        PaperMarket market = krLike();

        PaperSettings read = PaperSettings.from(body, market);
        assertThat(read.slippageBp()).isEqualTo(PaperSettings.DEFAULT_SLIPPAGE_BP);
        assertThat(read.trailingStopPct()).isEqualTo(PaperSettings.DEFAULT_TRAILING_STOP_PCT);
        assertThat(read.cashLikeTickers()).containsExactly("153130");
        assertThat(read.fallbacks()).containsExactly("kr.slippageBp", "kr.trailingStopPct", "kr.lockoutTradingDays",
                "kr.cashLikeTickers");
        assertThat(read.rules().fallbacks()).containsExactly("kr.rules");
        assertThat(PacketBuilder.Limits.from(body, market).minOrderNotional()).isEqualTo(500_000);
        assertThat(PacketBuilder.Limits.from(null, market).minOrderNotional()).isEqualTo(500_000);

        body.put("kr", "객체가 아님");
        assertThat(PaperSettings.from(body, market).cashLikeTickers()).containsExactly("153130");
        assertThat(PaperSettings.from(null, market)).as("설정 행 없음 = 그 시장 기본값(fallbacks 없음)")
                .isEqualTo(PaperSettings.defaults(market));
        assertThat(PaperSettings.defaults(market).cashLikeTickers()).containsExactly("153130");
        assertThat(PaperSettings.defaults(market).fallbacks()).isEmpty();
    }

    @Test
    @DisplayName("한국 기본 본문(C1b) — 장부 키·rules.*·검증기 한도를 kr. 아래 기본값으로 읽어 fallbacks가 없고, 값은 미국과 같은 크기·현금성 153130·최소 주문 500,000원")
    void krDefaultsReadWithoutFallbacks() {
        ObjectNode body = defaults();
        PaperMarket market = krLike();
        PaperSettings read = PaperSettings.from(body, market);
        assertThat(read.fallbacks()).isEmpty();
        assertThat(read.rules().fallbacks()).isEmpty();
        assertThat(List.of(read.slippageBp(), read.trailingStopPct(), (double) read.lockoutTradingDays(),
                read.rules().parkCashThresholdPct())).containsExactly(5.0, 8.0, 20.0, 2.0);
        assertThat(read.cashLikeTickers()).containsExactly("153130");
        assertThat(PacketBuilder.Limits.from(body, market)).isEqualTo(new PacketBuilder.Limits(10, 20, 20, 500_000, 20, 5));
        assertThat(PaperSettings.from(body)).as("미국 판은 한국 묶음과 상관없이 그대로").isEqualTo(PaperSettings.from(withoutKr()));
        assertThat(PacketBuilder.Limits.from(body)).isEqualTo(PacketBuilder.Limits.from(withoutKr()));
    }

    @Test
    @DisplayName("실행의 설정 = 그 실행이 읽은 행을 그 시장 판으로 — 시험용 한국 실행은 kr. 아래, 미국 실행은 루트")
    void runSettingsUseTheMarketsKeys() {
        FakePaperStore store = new FakePaperStore();
        ObjectNode body = defaults();
        body.putObject("kr").put("slippageBp", 2).putArray("cashLikeTickers").add("153130");
        store.initSettingsIfAbsent(body);
        PaperMarkets markets = new PaperMarkets(store, PaperFixtures.quietReader(), List.of(US, TestKrMarket.INSTANCE));

        MarketRun kr = markets.open(TestKrMarket.INSTANCE);
        assertThat(kr.settings().slippageBp()).isEqualTo(2);
        assertThat(kr.settings().cashLikeTickers()).containsExactly("153130");
        MarketRun us = markets.open(US);
        assertThat(us.settings()).isEqualTo(PaperSettings.from(body));
        assertThat(new PaperSettingsService(store, MAPPER).current(TestKrMarket.INSTANCE).settings())
                .isEqualTo(kr.settings());
        assertThat(new PaperSettingsService(store, MAPPER).current().settings()).isEqualTo(us.settings());
    }

    @Test
    @DisplayName("프롬프트 하드 규칙 줄의 설정 읽기도 그 시장 판 — 미국 줄은 글자 그대로, 같은 함수에 한국 키를 주면 kr. 아래 값")
    void hardRulesReadTheMarketsKeys() {
        ObjectNode body = defaults();
        body.putObject("kr").put("maxPositions", 7).put("trailingStopPct", 12).putArray("cashLikeTickers")
                .add("153130");
        assertThat(FrameworkService.hardRules(US, body)).isEqualTo(US.promptHardRules(body));
        assertThat(FrameworkService.hardRules(US, body).get(0)).contains("현금성(SHY)").contains("최대 20종목");
        List<String> kr = FrameworkService.hardRules(krLike(), body);
        assertThat(kr.get(0)).contains("현금성(153130)").contains("최대 7종목");
        assertThat(kr.get(1)).contains("−12%");
    }
}
