package com.macrodash.feature.detail;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.InvalidRequestException;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 검색 상세 화면(종목·지표·기관 — 명세 docs/specs/2026-11-01-search-detail.md)의 외부 정보 — 시세·핵심 지표·개요, 주요 뉴스, 종목 찾기.
 *
 * <p>저장하지 않는 실시간 자료라 수집기의 {@code /live/quote}·{@code /live/news}·{@code /live/symbols}를 그대로 전합니다(출처·받은 시각·출처별
 * 오류는 수집기 응답 그대로 — 화면이 출처 링크로 적음). 공개 데모처럼 저장본만 읽는 모드({@code store_only})에서는 외부 호출을 일으키지 않고
 * {@code available:false}입니다({@code MacroService.tickerSeries}와 같은 약속, ADR 0012). 시장·코드 형식은 여기서 먼저 막습니다(수집기와 같은 규칙).
 */
@Service
public class DetailService {

    /** 미국·해외 — Yahoo 심볼 형식(^VIX·KRW=X·BRK-B·7203.T). */
    static final Pattern US_CODE = Pattern.compile("^[A-Za-z0-9^=.\\-]{1,24}$");
    /** 국내 — 거래소 코드 6자리(대문자 영숫자 — 0088M0 같은 신규 코드 포함). */
    static final Pattern KR_CODE = Pattern.compile("^[0-9A-Z]{6}$");
    static final int MAX_QUERY = 60;
    static final int MAX_SYMBOL_QUERY = 40;

    private final StoreReader store;
    private final CollectorClient collector;

    public DetailService(StoreReader store, CollectorClient collector) {
        this.store = store;
        this.collector = collector;
    }

    /** 검사한 시장·코드 — 시장은 소문자 us·kr, 코드는 대문자. */
    record Target(String market, String code) {
    }

    /**
     * 시장·코드 검사. 'us'는 Yahoo 심볼 형식, 'kr'은 6자리 대문자 영숫자.
     *
     * @throws InvalidRequestException 시장·코드가 틀림(400)
     */
    static Target target(String market, String code) {
        String m = market == null ? "" : market.strip().toLowerCase(Locale.ROOT);
        String c = code == null ? "" : code.strip().toUpperCase(Locale.ROOT);
        if (m.equals("kr")) {
            if (!KR_CODE.matcher(c).matches()) {
                throw new InvalidRequestException("국내 코드는 영문 대문자·숫자 6자리입니다.");
            }
        } else if (m.equals("us")) {
            if (!US_CODE.matcher(c).matches()) {
                throw new InvalidRequestException("심볼 형식이 올바르지 않습니다 (영문·숫자·^=.- 24자 이내).");
            }
        } else {
            throw new InvalidRequestException("market은 us 또는 kr입니다.");
        }
        return new Target(m, c);
    }

    /** 검색어 — 앞뒤 공백을 지우고, 비면 null, 너무 길면 400. */
    static String query(String q, int max) {
        String text = q == null ? "" : q.strip();
        if (text.length() > max) {
            throw new InvalidRequestException("검색어는 " + max + "자 이하로 입력하세요.");
        }
        return text.isEmpty() ? null : text;
    }

    /** 시세·핵심 지표·개요 → {@code {available, quote}}(수집기 응답 그대로 — 받지 못하면 available:false와 사유). */
    public Map<String, Object> quote(String market, String code) {
        Target target = target(market, code);
        return relay("quote", () -> collector.liveQuote(target.market(), target.code()));
    }

    /**
     * 주요 뉴스 → {@code {available, news}}. 종목(시장·코드)이 있으면 그 종목 뉴스, 검색어가 있으면 구글 뉴스 RSS — 둘 다 없으면 400.
     */
    public Map<String, Object> news(String market, String code, String q) {
        String text = query(q, MAX_QUERY);
        Target target = code == null || code.isBlank() ? null : target(market, code);
        if (target == null && text == null) {
            throw new InvalidRequestException("code나 q 중 하나가 있어야 합니다.");
        }
        String m = target != null ? target.market() : (market == null || market.isBlank() ? null : market.strip().toLowerCase(Locale.ROOT));
        return relay("news", () -> collector.liveNews(m, target == null ? null : target.code(), text));
    }

    /** 종목 찾기 → {@code {available, symbols}}. 검색어가 비면 빈 목록(부르지 않음). */
    public Map<String, Object> symbols(String q) {
        String text = query(q, MAX_SYMBOL_QUERY);
        if (text == null) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("available", true);
            out.put("symbols", Map.of("items", java.util.List.of()));
            return out;
        }
        return relay("symbols", () -> collector.liveSymbols(text));
    }

    private Map<String, Object> relay(String field, java.util.function.Supplier<Optional<JsonNode>> call) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (store.readMode() == AppProperties.ReadMode.STORE_ONLY) {
            out.put("available", false);
            out.put("message", "store_only 모드에서는 외부 정보(시세·뉴스)를 조회하지 않습니다.");
            return out;
        }
        Optional<JsonNode> payload = call.get();
        if (payload.isEmpty()) {
            out.put("available", false);
            out.put("message", "수집기에서 응답을 받지 못했습니다.");
            return out;
        }
        out.put("available", true);
        out.put(field, payload.get());
        return out;
    }
}
