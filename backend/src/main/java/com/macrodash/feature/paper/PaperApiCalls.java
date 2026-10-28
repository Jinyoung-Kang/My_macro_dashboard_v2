package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.store.PaperStore;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 Claude 호출 예산(명세 C8·D18·F7) — 하루(KST) 호출 상한 잡기·되돌리기·사용량(토큰·추정 비용) 기록을 한 곳에 둡니다. Claude 재량
 * 책의 결정·미리보기·시작과 프레임 제안이 <b>같은 상한</b>을 나눠 씁니다 — 상한을 따로 두면 제안을 여러 번 눌러 하루 비용이 결정
 * 상한을 넘습니다. 한국 책도 같은 줄을 씁니다(두 책 합 상한, 2단계 명세 §4-10·K18). 상한의 문턱은 부르는 쪽이 정합니다 — 정기 작업은 상한까지,
 * 수동 호출은 정기 작업 몫 예약({@code apiScheduledReserve})을 남긴 문턱까지({@link ClaudeBookService.ClaudeSettings#callLimit}, 같은 SQL의 문턱만 다름).
 *
 * <p><b>순서</b>: 호출 전에 {@link #reserve}(검사와 증가가 한 문장 — 동시에 눌러도 상한을 넘지 않음), 부른 뒤 {@link #record}. 키가
 * 없거나 허용 목록 밖이라 요청을 보내지 않았으면({@code NO_KEY}·{@code NOT_ALLOWED}) {@link #record}가 잡은 호출을 돌려놓고, 요청을 보내기 전에 예외로 멈췄으면 부른 쪽이
 * {@link #release}합니다. 실패한 호출(429·5xx·거절·형식 오류)도 과금됐을 수 있어 호출 수를 그대로 둡니다.
 *
 * <p><b>추정 비용</b>: 설정의 단가({@code pricing.sonnet.*}·{@code pricing.haiku.*}, 달러/100만 토큰)로
 * (입력 × 입력 단가 + 출력 × 출력 단가 + 캐시 읽기 × 읽기 단가 + 캐시 쓰기 × 쓰기 단가) ÷ 100만. 모델 ID에 sonnet·haiku가 없으면
 * 단가를 몰라 추정하지 않고, 응답이 토큰 넷 중 하나라도 알려 주지 않았으면 그 호출은 추정하지 않습니다 — 모르는 토큰을 0으로 놓으면
 * 실제보다 싼 숫자가 "추정"으로 보입니다. 그래서 하루·한 달의 추정은 {@code estimatedCalls}회의 합이고, 화면은 전체 호출 수와 함께
 * 보입니다. 단가는 코드에 두지 않고 설정 키에 두어(기본값은 아래 {@link Pricing#defaults}) 가격이 바뀌면 화면에서 고칩니다.
 *
 * <p>기록 실패(DB 오류)는 받은 응답을 버리게 하지 않습니다 — 경고 로그만 남깁니다(결정·제안은 계속).
 */
@Service
public class PaperApiCalls {

    private static final Logger log = LoggerFactory.getLogger(PaperApiCalls.class);

    /** 단가 설정 키의 최댓값(달러/100만 토큰) — 오타(2000)로 추정이 백 배가 되지 않게. */
    static final double MAX_PRICE = 1_000;
    /** 단가 키 설명에 붙이는 출처 문구. */
    static final String PRICE_NOTE = "공식 가격표 기준 기본값(2026-10-25 확인) — 가격이 바뀌면 고칠 것";
    /** 토큰 단가의 단위(100만 토큰). */
    private static final double PER_MTOK = 1_000_000.0;

    /**
     * 모델 한 종류의 단가(달러/100만 토큰).
     */
    record Rates(double inputUsdPerMTok, double outputUsdPerMTok, double cacheReadUsdPerMTok,
                 double cacheWriteUsdPerMTok) {

        Map<String, Object> body() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("inputUsdPerMTok", inputUsdPerMTok);
            out.put("outputUsdPerMTok", outputUsdPerMTok);
            out.put("cacheReadUsdPerMTok", cacheReadUsdPerMTok);
            out.put("cacheWriteUsdPerMTok", cacheWriteUsdPerMTok);
            return out;
        }
    }

    /**
     * 설정의 단가 묶음({@code pricing.*}). 키가 없거나 범위(0~{@value #MAX_PRICE}) 밖이면 그 키만 기본값으로 읽고 {@link #fallbacks}에
     * {@code pricing.…} 이름으로(묶음이 통째로 없으면 {@code pricing}) 남깁니다 — 단계 3b 전에 만든 설정 행(pricing 없음)도 기본
     * 단가로 추정합니다({@link PaperSettings.Blend}와 같은 방식).
     */
    record Pricing(Rates sonnet, Rates haiku, List<String> fallbacks) {

        /**
         * Sonnet 기본 단가(PRICE_NOTE의 날짜에 확인한 값 — 설정에서 고침). 캐시 읽기 0.10은 공식 가격표의 Sonnet 5.5 값입니다
         * (Opus 5.5·Sonnet 5.5의 캐시 읽기는 입력 단가의 0.05배 — 다른 모델의 0.1배와 다름). 캐시 쓰기(5분)는 1.25배.
         */
        static final Rates DEFAULT_SONNET = new Rates(2, 10, 0.10, 2.50);
        /** Haiku 기본 단가(프롬프트 100K 토큰 이하 단가). */
        static final Rates DEFAULT_HAIKU = new Rates(0.10, 0.50, 0.01, 0.125);

        Pricing {
            fallbacks = List.copyOf(fallbacks);
        }

        static Pricing defaults() {
            return new Pricing(DEFAULT_SONNET, DEFAULT_HAIKU, List.of());
        }

        /** 설정 기본값 본문({@code {"sonnet":{…}, "haiku":{…}}}). */
        Map<String, Object> body() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("sonnet", sonnet.body());
            out.put("haiku", haiku.body());
            return out;
        }

        /** 설정 본문 전체에서 {@code pricing}을 읽습니다. 본문이 null이면 기본값(설정 행이 없는 것 — fallbacks 없음). */
        static Pricing from(JsonNode body) {
            if (body == null) {
                return defaults();
            }
            JsonNode pricing = Json.child(body, "pricing");
            if (pricing == null || !pricing.isObject()) {
                return new Pricing(DEFAULT_SONNET, DEFAULT_HAIKU, List.of("pricing"));
            }
            List<String> fallbacks = new ArrayList<>();
            Rates sonnet = rates(pricing, "sonnet", DEFAULT_SONNET, fallbacks);
            Rates haiku = rates(pricing, "haiku", DEFAULT_HAIKU, fallbacks);
            return new Pricing(sonnet, haiku, fallbacks.stream().map(key -> "pricing." + key).toList());
        }

        private static Rates rates(JsonNode pricing, String model, Rates fallback, List<String> fallbacks) {
            JsonNode node = Json.child(pricing, model);
            if (node == null || !node.isObject()) {
                fallbacks.add(model);
                return fallback;
            }
            return new Rates(price(node, model, "inputUsdPerMTok", fallback.inputUsdPerMTok(), fallbacks),
                    price(node, model, "outputUsdPerMTok", fallback.outputUsdPerMTok(), fallbacks),
                    price(node, model, "cacheReadUsdPerMTok", fallback.cacheReadUsdPerMTok(), fallbacks),
                    price(node, model, "cacheWriteUsdPerMTok", fallback.cacheWriteUsdPerMTok(), fallbacks));
        }

        private static double price(JsonNode node, String model, String key, double fallback, List<String> fallbacks) {
            Double value = Json.asDouble(node, key);
            if (value == null || !Double.isFinite(value) || value < 0 || value > MAX_PRICE) {
                fallbacks.add(model + "." + key);
                return fallback;
            }
            return value;
        }

        /** 모델 ID의 단가 — sonnet·haiku가 들어 있으면 그 단가, 아니면 empty(모르는 모델은 추정하지 않음). */
        Optional<Rates> ratesFor(String model) {
            if (model == null) {
                return Optional.empty();
            }
            String id = model.toLowerCase(Locale.ROOT);
            if (id.contains("sonnet")) {
                return Optional.of(sonnet);
            }
            if (id.contains("haiku")) {
                return Optional.of(haiku);
            }
            return Optional.empty();
        }
    }

    private final PaperStore store;
    private final PaperSettingsService settings;

    public PaperApiCalls(PaperStore store, PaperSettingsService settings) {
        this.store = store;
        this.settings = settings;
    }

    /**
     * 그날(KST) 호출 한 번을 잡습니다(상한 {@code cap} 안에서만, 한 문장 — {@link PaperStore#reserveApiCallNumber}).
     *
     * @return 잡았으면 그 호출이 그날 몇 번째인지(이 호출까지 센 호출 수), 상한에 닿았으면(또는 {@code cap ≤ 0}) empty — 아무것도
     *         바꾸지 않음
     */
    public Optional<Long> reserve(LocalDate kstDay, int cap) {
        return store.reserveApiCallNumber(kstDay, cap).map(Integer::longValue);
    }

    /** 잡아 둔 호출 한 번을 돌려놓습니다(요청을 보내지도 않은 경우). 실패는 로그만 — 부른 쪽의 예외·결과를 가리지 않게. */
    public void release(LocalDate kstDay) {
        try {
            store.releaseApiCall(kstDay);
        } catch (RuntimeException e) {
            log.warn("잡아 둔 Claude 호출 수를 돌려놓지 못했습니다: {}", e.toString());
        }
    }

    /**
     * 부른 결과를 그날 사용량에 남깁니다 — 요청을 보내지 않았으면({@code NO_KEY}·{@code NOT_ALLOWED}) 잡은 호출을 돌려놓고, 아니면 응답이
     * 알려 준 토큰과 추정 비용(클래스 설명)을 더합니다. 기록 실패는 로그만 남깁니다.
     *
     * @param model 부른 모델 ID(단가를 고르는 데 씀)
     */
    public void record(LocalDate kstDay, String model, AiService.StructuredResult r) {
        if (r == null) {
            return;
        }
        if ("NO_KEY".equals(r.errorKind()) || "NOT_ALLOWED".equals(r.errorKind())) {
            release(kstDay);
            return;
        }
        try {
            Double cost = estimateCostUsd(model, r);
            if (r.inputTokens() != null || r.outputTokens() != null || r.cacheReadTokens() != null
                    || r.cacheWriteTokens() != null || cost != null) {
                store.addApiTokens(kstDay, r.inputTokens(), r.outputTokens(), r.cacheReadTokens(),
                        r.cacheWriteTokens(), cost);
            }
        } catch (RuntimeException e) {
            log.warn("Claude 호출 사용량(토큰·추정 비용)을 남기지 못했습니다 — 계속합니다: {}", e.toString());
        }
    }

    /**
     * 호출 한 번의 추정 비용(달러) — 지금 설정의 단가로(클래스 설명). 단가를 모르는 모델이거나 토큰 넷 중 하나라도 모르면 null.
     */
    public Double estimateCostUsd(String model, AiService.StructuredResult r) {
        if (r == null) {
            return null;
        }
        return estimateCostUsd(model, r.inputTokens(), r.outputTokens(), r.cacheReadTokens(), r.cacheWriteTokens(),
                pricing());
    }

    /** 지금 설정의 단가(설정 행이 없거나 테이블이 없으면 기본값). */
    Pricing pricing() {
        if (!store.ready()) {
            return Pricing.defaults();
        }
        JsonNode body = store.settings().map(PaperStore.SettingsRow::body).orElseGet(settings::defaultsJson);
        return Pricing.from(body);
    }

    /** 추정 비용 계산(클래스 설명) — 순수 함수(시험용으로 패키지 안에 엶). */
    static Double estimateCostUsd(String model, Long input, Long output, Long cacheRead, Long cacheWrite,
                                  Pricing pricing) {
        if (input == null || output == null || cacheRead == null || cacheWrite == null
                || input < 0 || output < 0 || cacheRead < 0 || cacheWrite < 0) {
            return null;
        }
        Optional<Rates> rates = pricing.ratesFor(model);
        if (rates.isEmpty()) {
            return null;
        }
        Rates p = rates.get();
        double usd = (input * p.inputUsdPerMTok() + output * p.outputUsdPerMTok()
                + cacheRead * p.cacheReadUsdPerMTok() + cacheWrite * p.cacheWriteUsdPerMTok()) / PER_MTOK;
        return Double.isFinite(usd) ? usd : null;
    }
}
