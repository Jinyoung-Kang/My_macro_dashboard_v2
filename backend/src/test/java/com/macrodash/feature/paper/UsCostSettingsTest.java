package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Fill;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.SAT;
import static com.macrodash.feature.paper.PaperFixtures.TUE;
import static com.macrodash.feature.paper.PaperFixtures.TUE_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.pending;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 미국 체결 비용 설정 키 넷(ADR 0030, 명세 2026-11-06 §1) — 키 표·범위·기본값·저장 이력, 이 키가 없는 옛 행은 기본 비율로 읽고 fallbacks에 남음, 한국
 * 읽기에는 없음, 체결은 그 실행이 읽은 설정 판의 비율(바꾸면 그 뒤 체결부터).
 */
class UsCostSettingsTest {

    private FakePaperStore store;
    private PaperSettingsService service;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        service = new PaperSettingsService(store, MAPPER);
        service.ensureInitialized();
    }

    private Map<String, Object> update(Object... keyAndValue) {
        Map<String, Object> patch = new LinkedHashMap<>();
        for (int i = 0; i < keyAndValue.length; i += 2) {
            patch.put((String) keyAndValue[i], keyAndValue[i + 1]);
        }
        return service.update(MAPPER.valueToTree(patch));
    }

    @Test
    @DisplayName("키 표: commissionBp(0~100)·regFees.secPerMillion(0~1000)·regFees.tafPerShare(0~0.01)·regFees.tafMaxPerTrade(0~100) — 미국, 규칙 계좌 영향, 슬리피지 바로 뒤")
    void keysAreListed() {
        List<String> keys = PaperSettingKeys.ALL.stream().map(PaperSettingKeys.Spec::key).toList();
        int slippage = keys.indexOf("slippageBp");
        assertThat(keys.subList(slippage, slippage + 5)).containsExactly("slippageBp", "commissionBp",
                "regFees.secPerMillion", "regFees.tafPerShare", "regFees.tafMaxPerTrade");
        Map<String, double[]> ranges = Map.of("commissionBp", new double[]{0, 100}, "regFees.secPerMillion",
                new double[]{0, 1_000}, "regFees.tafPerShare", new double[]{0, 0.01}, "regFees.tafMaxPerTrade",
                new double[]{0, 100});
        for (PaperSettingKeys.Spec spec : PaperSettingKeys.ALL) {
            double[] range = ranges.get(spec.key());
            if (range == null) {
                continue;
            }
            assertThat(spec.type()).as(spec.key()).isEqualTo(PaperSettingKeys.Type.NUMBER);
            assertThat(spec.min()).as(spec.key()).isEqualTo(range[0]);
            assertThat(spec.max()).as(spec.key()).isEqualTo(range[1]);
            assertThat(spec.affectsRules()).as(spec.key() + " — 규칙 계좌도 비용을 냄").isTrue();
            assertThat(spec.view().get("market")).as(spec.key()).isEqualTo("US");
        }
    }

    @Test
    @DisplayName("기본값 본문: commissionBp 10, regFees {20.6, 0.000195, 9.79} — 새 행은 fallbacks 없이 기본 비율로 읽힘")
    void defaults() {
        JsonNode defaults = service.defaultsJson();
        assertThat(defaults.path("commissionBp").asDouble()).isEqualTo(10);
        assertThat(defaults.path("regFees").path("secPerMillion").asDouble()).isEqualTo(20.6);
        assertThat(defaults.path("regFees").path("tafPerShare").asDouble()).isEqualTo(0.000195);
        assertThat(defaults.path("regFees").path("tafMaxPerTrade").asDouble()).isEqualTo(9.79);
        PaperSettings.UsCostRates rates = service.current().settings().usCosts();
        assertThat(rates.commissionBp()).isEqualTo(10);
        assertThat(rates.secPerMillion()).isEqualTo(20.6);
        assertThat(rates.tafPerShare()).isEqualTo(0.000195);
        assertThat(rates.tafMaxPerTrade()).isEqualTo(9.79);
        assertThat(rates.fallbacks()).isEmpty();
        assertThat(PaperSettings.defaults().usCosts()).isEqualTo(rates);
        assertThat(service.current(KrPaperMarket.INSTANCE).settings().usCosts()).as("한국 읽기에는 없음").isNull();
        assertThat(service.current().settings().costRates()).as("미국 읽기에는 한국 요율 없음").isNull();
    }

    @Test
    @DisplayName("이 키가 생기기 전 행(키 없음)·범위 밖 값은 그 키만 기본 비율로 읽고 fallbacks에 남김 — 설정 화면·상태가 보임, 장부 키 fallbacks와 따로")
    void missingKeysFallBack() {
        ObjectNode body = (ObjectNode) store.settings.body();
        body.remove("commissionBp");
        ((ObjectNode) body.get("regFees")).put("tafPerShare", -1).remove("tafMaxPerTrade");
        PaperSettings parsed = PaperSettings.from(body);
        assertThat(parsed.usCosts().fallbacks()).containsExactly("commissionBp", "regFees.tafPerShare",
                "regFees.tafMaxPerTrade");
        assertThat(parsed.usCosts().commissionBp()).isEqualTo(10);
        assertThat(parsed.usCosts().secPerMillion()).isEqualTo(20.6);
        assertThat(parsed.fallbacks()).as("장부 키 fallbacks에는 섞지 않음").doesNotContain("commissionBp");
        body.remove("regFees");
        assertThat(PaperSettings.from(body).usCosts().fallbacks()).containsExactly("commissionBp", "regFees.secPerMillion",
                "regFees.tafPerShare", "regFees.tafMaxPerTrade");
        @SuppressWarnings("unchecked")
        List<String> viewFallbacks = (List<String>) service.view().get("fallbacks");
        assertThat(viewFallbacks).contains("commissionBp", "regFees.secPerMillion", "regFees.tafPerShare",
                "regFees.tafMaxPerTrade");
    }

    @Test
    @DisplayName("저장: 점 경로·묶음으로 바꾸면 판 +1·이력·규칙 계좌 경고, 범위 밖(수수료 101·TAF 0.02·음수)은 400")
    void savesAndValidates() {
        Map<String, Object> out = update("commissionBp", 2.5, "regFees", Map.of("tafPerShare", 0.000166));
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("commissionBp", "regFees.tafPerShare"));
        assertThat(out.get("warning")).isEqualTo(PaperSettingKeys.RULES_FROZEN_WARNING);
        assertThat(service.current().settings().usCosts().commissionBp()).isEqualTo(2.5);
        assertThat(service.current().settings().usCosts().tafPerShare()).isEqualTo(0.000166);
        assertThatThrownBy(() -> update("commissionBp", 101)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("commissionBp: 0~100 범위");
        assertThatThrownBy(() -> update("regFees.tafPerShare", 0.02)).hasMessageContaining("regFees.tafPerShare");
        assertThatThrownBy(() -> update("regFees.secPerMillion", -1)).hasMessageContaining("regFees.secPerMillion");
        assertThat(service.current().version()).isEqualTo(2);
    }

    @Test
    @DisplayName("체결은 그 실행이 읽은 설정 판의 비율 — 수수료 5bp 판의 체결은 5bp, 20bp로 바꾼 뒤의 체결은 20bp(앞 체결은 그대로)")
    void fillsUseTheSettingsInForce() {
        PaperMarketData marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        update("commissionBp", 5);
        pending(store, PaperBooks.CLAUDE, "AAA", "BUY", 100, null, null, "NEXT_OBSERVATION", FRI, SAT);

        ledger.process(quotes(MON_INTRADAY, bar("AAA", FRI, 100, MON, 100)));
        update("commissionBp", 20);
        pending(store, PaperBooks.CLAUDE, "BBB", "BUY", 100, null, null, "NEXT_OBSERVATION", MON, MON_INTRADAY.plusSeconds(60));
        ledger.process(quotes(TUE_INTRADAY, bar("AAA", MON, 100, TUE, 100), bar("BBB", MON, 100, TUE, 100)));

        List<Fill> fills = store.fillsOf(PaperBooks.CLAUDE);
        assertThat(fills).extracting(Fill::ticker).containsExactly("AAA", "BBB");
        // 100 × 100.05 = 10,005 → 5bp 5.0025 → 5.00, 20bp 20.01
        assertThat(fills.get(0).fee()).isEqualByComparingTo("5.00");
        assertThat(fills.get(1).fee()).isEqualByComparingTo("20.01");
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(100_000 - 10_005 - 5.00 - 10_005 - 20.01);
    }
}
