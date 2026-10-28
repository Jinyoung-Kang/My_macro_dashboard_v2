package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 🧪 한국 Claude 계좌({@code kr_claude})의 검증기 문맥 — 시장별 칸(2단계 명세 §4-7·K34·사용자 결정 v2, E2a). 결정 파이프라인
 * ({@link ClaudeDecisionPipeline#plan})이 한국 실행이면 미국 칸({@code usChecks}) 대신 이것을 씁니다. 공통 검사(형식·중복·유니버스·재진입 금지·
 * 최소 보유일·1주 미만 부분 매도·비중 상한·최소 금액·월 상한·최대 종목 수·100% 합)는 {@link OrderValidator} 그대로이고, 한도·현금성은 그 시장 키
 * ({@code kr.*} — 최소 주문 500,000원, 현금성 153130)를 {@code plan}이 읽습니다.
 *
 * <ul>
 *   <li><b>유니버스·ETF·재진입 금지·지금 체결할 수 없는 종목은 패킷 {@code 12_hardRules}가 보인 것</b> — Claude가 본 하드 규칙 그대로 집행합니다
 *       (유니버스 = U ∪ 069500·153130 ∪ {@code kr.universeExtraTickers} — 그 키는 저장 규칙상 늘 빈 목록, C1b d6). 패킷의 그 칸은 규칙 계좌와 같은
 *       읽기·같은 판정({@link KrRuleBookService.Fillable} — 이번 관측치에 봉 없음·기준 거래일 거래정지·미처리 기업행위 보유)으로 만들어졌습니다.
 *       재진입 금지와 미처리 기업행위 보유는 검증하는 순간의 장부도 더합니다(패킷을 만든 뒤 장부가 새로 건 것 — 더 좁은 쪽).</li>
 *   <li><b>지금 체결할 수 없는 종목</b>(사용자 결정 v2): 매수는 {@link OrderValidator#UNFILLABLE}과 사유, 그 종목 보유의 매도는 받습니다 — 규칙 계좌가
 *       매수만 건너뛰고 매도는 내는 것과 같은 조건(패킷 12_hardRules 문장과 같은 범위, 명세 §9 'E1a 메모').</li>
 *   <li><b>정수 주</b>: 기준 가격 = 그 관측치에서 그 종목의 기준 거래일 이하 마지막 봉의 원시 종가(패킷 {@code 8_prices}의 잠정 종가와 같은 값 —
 *       그 봉의 종가가 비었으면 기준 가격 없음), 요율 = 그 실행 설정 판의 {@code kr.commissionBp}·{@code kr.slippageBp}(장부가 체결 때 쓰는 판).
 *       증가분으로 1주도 못 사면 {@link OrderValidator#BUY_BELOW_ONE_SHARE}, 기준 가격이 없으면 {@link OrderValidator#NO_PRICE}. 호가는 검사하지
 *       않습니다 — 주문은 비중이고 체결가는 관측된 단일가 그대로입니다(K31).</li>
 *   <li><b>가격 없음 집합은 비웁니다</b> — 한국 매도는 다음 관측 봉 시가로 체결되고 봉이 없으면 장부가 대기로 두므로(만료 기준일 + 3거래일) 판단할
 *       가격이 필요 없고, 매수는 정수 주 칸이 맡습니다. 이어 쓴 봉(이번에 받지 못한 항목)의 종목도 거절하지 않습니다 — 규칙 계좌도 그 종목을 사고,
 *       장부는 기준일 뒤 첫 관측 봉으로만 체결합니다.</li>
 *   <li><b>이달 재량 주문 수</b>: 출발 결정(INITIAL)의 주문을 빼고 셉니다({@link KrPacketBuilder#monthlyDiscretionaryOrders} — 패킷
 *       {@code 9_portfolio}와 같은 함수, E1a). 출발 결정 자신은 0부터(그 결정 안에서 월 상한까지).</li>
 *   <li><b>신선도</b>: 미국과 같은 규칙({@link ClaudeBookService#inputsStale} — 관측치가 없거나 24시간보다 오래되면 전부 STALE_INPUT). 한국 출발도
 *       그 밤 관측치로 보므로 같습니다.</li>
 * </ul>
 */
final class KrClaudeValidation {

    private KrClaudeValidation() {
    }

    /**
     * 그 결정의 한국 칸.
     *
     * @param market          한국 실행(Claude 계좌 코드)
     * @param asOf            기준 KR 세션 D(출발이면 S)
     * @param initial         출발 결정(이달 재량 주문 수 0부터)
     * @param packetBody      그 결정이 보낸 한국 패킷({@link KrPacketBuilder}) — {@code 12_hardRules}를 읽음
     * @param paper           그 실행 설정 판의 한국 읽기(요율)
     * @param quotes          그 결정의 관측치(패킷을 만든 것 — 결정 게이트가 본 관측치)
     * @param ledgerLockedOut 검증하는 순간 장부의 재진입 금지(다음 세션에도 걸린 것 — 파이프라인이 미국과 같은 식으로 셈)
     * @param now             지금(신선도)
     * @throws IllegalStateException 패킷에 {@code 12_hardRules.universe}가 없음(한국 패킷이 아님 — 유니버스를 짐작하지 않음), 요율이 없음
     */
    static ClaudeDecisionPipeline.MarketChecks checks(PaperMarket market, PaperStore store, LocalDate asOf,
                                                      boolean initial, JsonNode packetBody, PaperSettings paper,
                                                      Optional<Quotes> quotes, Set<String> ledgerLockedOut,
                                                      Instant now) {
        JsonNode hard = Json.child(packetBody, PacketBuilder.HARD_RULES);
        Set<String> universe = tickers(Json.child(hard, "universe"));
        if (universe.isEmpty()) {
            throw new IllegalStateException("한국 패킷에 12_hardRules.universe가 없습니다 — 검증할 유니버스를 정할 수 없습니다");
        }
        Set<String> etfs = tickers(Json.child(hard, "etfTickers"));
        if (etfs.isEmpty()) {
            etfs.addAll(KrPaperMarket.BENCHMARK_TICKERS);
            etfs.addAll(paper.cashLikeTickers());
        }
        Set<String> lockedOut = tickers(Json.child(hard, "lockedOut"));
        if (ledgerLockedOut != null) {
            lockedOut.addAll(ledgerLockedOut);
        }
        Map<String, String> unfillable = new TreeMap<>();
        JsonNode shown = Json.child(hard, "unfillableTickers");
        if (shown != null && shown.isObject()) {
            for (Map.Entry<String, JsonNode> entry : shown.properties()) {
                String reason = entry.getValue() == null || !entry.getValue().isString() ? null
                        : entry.getValue().asString("");
                unfillable.put(entry.getKey().strip(), reason == null || reason.isBlank() ? "지금 체결할 수 없음" : reason);
            }
        }
        for (PaperStore.CorpActionHold hold : store.corpActionHolds(market.claudeBook())) {
            KrRuleBookService.Fillable held = new KrRuleBookService.Fillable(asOf, null, Set.of(),
                    Map.of(hold.ticker(), hold.reason()));
            unfillable.putIfAbsent(hold.ticker(), held.blocked(hold.ticker()));
        }
        if (paper.costRates() == null) {
            throw new IllegalStateException("한국 설정 읽기에 체결 비용 요율이 없습니다 — 정수 주 검사를 할 수 없습니다");
        }
        OrderValidator.WholeShares shares = new OrderValidator.WholeShares(referencePrices(quotes, asOf),
                paper.costRates().rates(paper.slippageBp()));
        int monthly = initial ? 0 : KrPacketBuilder.monthlyDiscretionaryOrders(store, asOf);
        boolean stale = ClaudeBookService.inputsStale(quotes, now);
        return new ClaudeDecisionPipeline.MarketChecks(universe, etfs, lockedOut, Set.of(), monthly, stale, unfillable,
                shares);
    }

    /**
     * 정수 주 검사의 기준 가격 — 관측치의 종목마다 기준 거래일 이하 마지막 봉의 원시 종가(패킷 {@code 8_prices}와 같은 고르기 — 봉은 오래된
     * 날부터). 그 봉의 종가가 비었거나 한국 칸이 없는 봉은 빠집니다(기준 가격 없음).
     */
    static Map<String, BigDecimal> referencePrices(Optional<Quotes> quotes, LocalDate asOf) {
        Map<String, BigDecimal> out = new TreeMap<>();
        if (quotes == null || quotes.isEmpty()) {
            return out;
        }
        for (Bar bar : quotes.get().bars().values()) {
            KrQuotes.Quote quote = bar.kr();
            if (quote == null) {
                continue;
            }
            KrQuotes.Day day = null;
            for (KrQuotes.Day d : quote.days()) {
                if (!d.date().isAfter(asOf)) {
                    day = d;
                }
            }
            if (day != null && day.close() != null && day.close().signum() > 0) {
                out.put(bar.ticker(), day.close());
            }
        }
        return out;
    }

    /** 패킷이 보인 종목 목록 — 쉼표로 이은 글자 또는 배열(공백·빈 칸은 버림). */
    private static Set<String> tickers(JsonNode node) {
        Set<String> out = new TreeSet<>();
        if (node == null) {
            return out;
        }
        Collection<String> raw = new ArrayList<>();
        if (node.isString()) {
            raw.addAll(List.of(node.asString("").split(",")));
        } else if (node.isArray()) {
            node.forEach(item -> raw.add(item.isString() ? item.asString("") : ""));
        }
        for (String ticker : raw) {
            if (!ticker.isBlank()) {
                out.add(ticker.strip());
            }
        }
        return out;
    }
}
