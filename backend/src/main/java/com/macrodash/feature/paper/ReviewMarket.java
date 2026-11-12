package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 주간 복기 시장 표의 열(입력 판 2 — ADR 0038) — 결정 패킷이 그날 본 매크로 값 몇 개를 이름 → 값으로 뽑습니다. 복기가 "결정 당시 값이 입력에
 * 없다"며 판단불가로 둔 것(유가·금리·수급)을 채우려는 것이라, 새로 수집하지 않고 그 결정이 실제로 본 패킷에서만 읽습니다(없는 값은 싣지 않음 —
 * 표에서는 null).
 *
 * <p>미국: 매크로 카드({@code 2_macroCards.cards.items}의 {@code price})에서 금리·달러·엔·유가·금, 국면({@code 4_regime})의 판정 코드와 하이일드
 * 스프레드. 한국: 환율({@code 3_kr_macro.fx.items}의 {@code close})과 코스피 외국인 순매수({@code investorFlows} — 당일·5일 합, 억 원),
 * 전날 밤 미국 국면({@code 1_basis.regime}).
 */
final class ReviewMarket {

    private ReviewMarket() {
    }

    /** 미국 매크로 카드에서 싣는 키(이 순서). */
    static final List<String> US_CARDS = List.of("us10y", "us02y", "dxy", "usdjpy", "wti", "brent", "gold");

    /** 그 시장 결정 패킷에서 뽑은 값(넣은 순서 = 표의 열 순서). 패킷이 없으면 빈 표. */
    static Map<String, Object> values(PaperMarket market, JsonNode packet) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (packet == null) {
            return out;
        }
        if (PaperStore.Book.MARKET_US.equals(market.code())) {
            List<JsonNode> cards = Json.array(Json.child(Json.child(packet, PacketBuilder.MACRO), "cards"), "items");
            for (String key : US_CARDS) {
                for (JsonNode card : cards) {
                    if (key.equals(Json.asText(card, "key"))) {
                        put(out, key, Json.asDouble(card, "price"));
                    }
                }
            }
            JsonNode regime = Json.child(packet, "4_regime");
            put(out, "hyOas", Json.asDouble(Json.child(Json.child(regime, "inputs"), "hyOas"), "value"));
            put(out, "regime", Json.asText(regime, "code"));
            return out;
        }
        JsonNode macro = Json.child(packet, "3_kr_macro");
        for (JsonNode fx : Json.array(Json.child(macro, "fx"), "items")) {
            if ("usdkrw".equals(Json.asText(fx, "key"))) {
                put(out, "usdkrw", Json.asDouble(fx, "close"));
            }
        }
        for (JsonNode row : Json.array(Json.child(macro, "investorFlows"), "rows")) {
            if ("KOSPI".equals(Json.asText(row, "market"))) {
                JsonNode foreigner = Json.child(row, "foreigner");
                put(out, "kospiForeignNet", Json.asDouble(foreigner, "sessionNet"));
                put(out, "kospiForeignNet5", Json.asDouble(foreigner, "net5"));
            }
        }
        put(out, "usRegime", Json.asText(Json.child(Json.child(packet, "1_basis"), "regime"), "code"));
        return out;
    }

    private static void put(Map<String, Object> out, String name, Object value) {
        if (value != null) {
            out.put(name, value);
        }
    }
}
