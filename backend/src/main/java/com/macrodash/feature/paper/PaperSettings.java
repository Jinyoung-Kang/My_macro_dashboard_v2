package com.macrodash.feature.paper;

import com.macrodash.analytics.GateIndicator;
import com.macrodash.analytics.Signal13F;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.DoublePredicate;

/**
 * 🧪 장부가 지금(단계 1) 읽는 설정 값 — DB 설정 한 행({@code paper_settings.body}, 설계 §4-4)에서 고른 것.
 *
 * <p>나머지 키(모델·상한·트랙레코드 등)는 본문에 그대로 있고 뒤 단계의 서비스가 읽습니다.
 *
 * <p><b>시장마다 읽습니다</b>(C1a, 2단계 명세 §9 묶음 A 리뷰 메모 'C1 — 시장별 설정 읽기'): 장부 키(슬리피지·스탑·재진입 금지·현금성)와
 * {@code rules.*}는 그 시장의 설정 접두어 아래({@link PaperMarket#settingsPrefix} — 미국은 접두어 없이 지금 키, 한국은 {@code kr.})에서
 * 읽고, 현금성 키가 없으면 그 시장의 현금성 기본값({@link PaperMarket#defaultCashLike} — 미국 SHY)입니다. 13F·OS 게이트 키
 * ({@code gate.*}·{@code blend.*})는 미국 전용 단계가 읽는 자리라 시장과 상관없이 설정 루트에서 읽습니다(미국 판과 같은 값).
 * 시장을 받지 않는 {@link #from(JsonNode)}·{@link #defaults()}는 미국입니다. 장부·결정 파이프라인·검증기·프롬프트 하드 규칙·관리
 * 리셋이 시장 판({@link #from(JsonNode, PaperMarket)})을 씁니다.
 *
 * <p><b>키가 없거나 값이 틀리면 그 키만 기본값으로 읽습니다.</b> 설정 쓰기 API(단계 3a)가 검사하기 전의 행이나 손으로 고친
 * 행이 있어도 장부가 멈추지 않게 — 예컨대 스탑 비율 0은 모든 보유를 바로 팔게 만들고, 슬리피지 음수는 '유리한 체결'이 됩니다.
 * 기본값으로 읽은 키는 {@link #fallbacks}에 남아 화면·로그가 알 수 있습니다(시장 접두어를 붙인 실제 키 이름 — 한국은 {@code kr.slippageBp}).
 *
 * @param slippageBp         체결가에 얹는 슬리피지(bp, 0 이상 10000 미만, 기본 5 — D9)
 * @param trailingStopPct    트레일링 스탑(%, 0 초과 100 미만, 기본 8 — D10)
 * @param lockoutTradingDays 스탑 뒤 재진입 금지 거래일(0 이상, 기본 20 — D10)
 * @param cashLikeTickers    스탑을 걸지 않는 현금성 종목(기본 SHY)
 * @param gate               OS 게이트 지표의 참고 임계치(구속하지 않음 — D7)
 * @param fallbacks          기본값으로 대신 읽은 키(비어 있으면 모두 설정대로). {@code blend.*}는 {@link Blend#fallbacks}에
 *                           따로 있습니다 — 장부는 그 키를 읽지 않으므로 장부 경로의 경고에 섞지 않습니다
 * @param blend              두 기관 그룹 섞기(D27) — 규칙 책·기관 선정이 읽는 값
 * @param rules              규칙 책의 {@code rules.*} 묶음(매일 남는 현금 SHY 기준) — 규칙 책이 읽는 값
 */
public record PaperSettings(double slippageBp, double trailingStopPct, int lockoutTradingDays,
                            List<String> cashLikeTickers, GateIndicator.Thresholds gate, List<String> fallbacks,
                            Blend blend, Rules rules) {

    public static final double DEFAULT_SLIPPAGE_BP = 5;
    public static final double DEFAULT_TRAILING_STOP_PCT = 8;
    public static final int DEFAULT_LOCKOUT_TRADING_DAYS = 20;
    public static final List<String> DEFAULT_CASH_LIKE = List.of("SHY");

    public PaperSettings {
        cashLikeTickers = List.copyOf(cashLikeTickers);
        fallbacks = List.copyOf(fallbacks);
    }

    /** 설정 행이 아직 없을 때(초기화 전) — 미국({@link #defaults(PaperMarket)}의 미국 판). */
    public static PaperSettings defaults() {
        return defaults(UsPaperMarket.INSTANCE);
    }

    /** 설정 행이 아직 없을 때의 그 시장 값 — 현금성은 그 시장의 기본값({@link PaperMarket#defaultCashLike}). */
    static PaperSettings defaults(PaperMarket market) {
        return new PaperSettings(DEFAULT_SLIPPAGE_BP, DEFAULT_TRAILING_STOP_PCT, DEFAULT_LOCKOUT_TRADING_DAYS,
                market.defaultCashLike(), GateIndicator.Thresholds.defaults(), List.of(), Blend.defaults(),
                Rules.defaults());
    }

    /** 스탑을 걸지 않는 현금성 종목인가. */
    public boolean cashLike(String ticker) {
        return cashLikeTickers.contains(ticker);
    }

    /** DB 본문에서 미국 값을 읽습니다({@link #from(JsonNode, PaperMarket)}의 미국 판). null이면 기본값 그대로. */
    static PaperSettings from(JsonNode body) {
        return from(body, UsPaperMarket.INSTANCE);
    }

    /**
     * DB 본문에서 그 시장 값을 읽습니다(클래스 설명 — 장부 키·{@code rules.*}는 그 시장 접두어 아래, {@code gate.*}·{@code blend.*}는
     * 설정 루트). null이면 그 시장 기본값 그대로. 접두어 묶음이 통째로 없으면(한국 키를 아직 쓰지 않은 행) 그 묶음의 키를 모두
     * 기본값으로 읽고 {@link #fallbacks}에 접두어를 붙인 이름으로 남깁니다.
     */
    static PaperSettings from(JsonNode body, PaperMarket market) {
        if (body == null) {
            return defaults(market);
        }
        String prefix = market.settingsPrefix();
        JsonNode scoped = scoped(body, prefix);
        List<String> marketFallbacks = new ArrayList<>();
        double slippage = number(scoped, "slippageBp", DEFAULT_SLIPPAGE_BP, v -> v >= 0 && v < 10_000,
                marketFallbacks);
        double stop = number(scoped, "trailingStopPct", DEFAULT_TRAILING_STOP_PCT, v -> v > 0 && v < 100,
                marketFallbacks);
        double lockout = number(scoped, "lockoutTradingDays", DEFAULT_LOCKOUT_TRADING_DAYS,
                v -> v >= 0 && v <= 1000 && v == Math.rint(v), marketFallbacks);
        List<String> cashLike = tickers(scoped, "cashLikeTickers", market.defaultCashLike(), marketFallbacks);
        List<String> fallbacks = new ArrayList<>();
        marketFallbacks.forEach(key -> fallbacks.add(prefix + key));

        GateIndicator.Thresholds base = GateIndicator.Thresholds.defaults();
        JsonNode gate = Json.child(body, "gate");
        GateIndicator.Thresholds thresholds = base;
        if (gate != null) {
            List<String> gateFallbacks = new ArrayList<>();
            double confirm = number(gate, "confirmDays", base.confirmDays(), v -> v >= 1 && v <= 250 && v == Math.rint(v),
                    gateFallbacks);
            thresholds = new GateIndicator.Thresholds(
                    number(gate, "us10yStage1", base.us10yStage1(), Double::isFinite, gateFallbacks),
                    number(gate, "us10yFull", base.us10yFull(), Double::isFinite, gateFallbacks),
                    number(gate, "brentMax", base.brentMax(), Double::isFinite, gateFallbacks),
                    number(gate, "wtiMax", base.wtiMax(), Double::isFinite, gateFallbacks),
                    number(gate, "usdjpyMin", base.usdjpyMin(), Double::isFinite, gateFallbacks),
                    (int) confirm);
            gateFallbacks.forEach(key -> fallbacks.add("gate." + key));
        } else {
            fallbacks.add("gate");
        }
        Rules rules = Rules.from(scoped);
        return new PaperSettings(slippage, stop, (int) lockout, cashLike, thresholds, fallbacks, Blend.from(body),
                new Rules(rules.parkCashThresholdPct(), rules.fallbacks().stream().map(key -> prefix + key).toList()));
    }

    /**
     * 그 시장 접두어 아래 묶음({@code kr.} → 본문의 {@code kr}, 점 경로) — 접두어가 없으면 본문 그대로. 묶음이 없거나 객체가 아니면 빈
     * 객체(그 묶음의 키가 모두 '없음'으로 읽혀 기본값과 fallbacks에 남게 — null로 두면 {@link Rules#from}이 '설정 행 없음'으로 읽음).
     * 검증기 한도({@link PacketBuilder.Limits#from(JsonNode, PaperMarket)})도 같은 묶음을 읽습니다.
     */
    static JsonNode scoped(JsonNode body, String prefix) {
        if (prefix.isEmpty()) {
            return body;
        }
        JsonNode node = PaperSettingsService.valueAt(body, prefix.endsWith(".")
                ? prefix.substring(0, prefix.length() - 1) : prefix);
        return node != null && node.isObject() ? node : JsonNodeFactory.instance.objectNode();
    }

    private static double number(JsonNode body, String key, double fallback, DoublePredicate valid,
                                 List<String> fallbacks) {
        Double value = Json.asDouble(body, key);
        if (value == null || !Double.isFinite(value) || !valid.test(value)) {
            fallbacks.add(key);
            return fallback;
        }
        return value;
    }

    /**
     * 두 기관 그룹 섞기(명세 R1·R2·R4·D27, 설계 §4-4 {@code blend.*}). 키가 없거나 범위 밖이면 그 키만 기본값으로 읽고
     * {@link #fallbacks}에 {@code blend.…} 이름으로 남깁니다 — D27 이전에 만든 설정 행(blend 없음)도 기본값으로 돕니다.
     *
     * @param groupBTopN        그룹 B 선정 수(blend.groupB.topN, 기본 4, 1~12 — 기존 메뉴가 12곳)
     * @param groupBWindowYears 그룹 B 트랙레코드 창(blend.groupB.windowYears, 기본 2, 1~2 — 기존 메뉴 저장본 q8이 덮는 길이)
     * @param groupBMinPeriods  그룹 B 자격의 최소 구간 수(blend.groupB.minPeriods, 기본 6, 1~8 — 2년 창 8구간의 75%)
     * @param groupWeightA      기관 가중에서 그룹 A 몫 g(blend.groupWeightA, 기본 0.5, 0~1)
     * @param convictionCapPct  확신도 상한(blend.convictionCapPct, 기본 10%, 1~50)
     * @param allocation        배분 방식(blend.allocation, 기본 CONVICTION, 대안 EQUAL)
     * @param minTargetPct      확신도 비례 배분의 최소 목표 비중(blend.minTargetPct, 기본 1.0%, 0~10)
     */
    public record Blend(int groupBTopN, int groupBWindowYears, int groupBMinPeriods, double groupWeightA,
                        double convictionCapPct, Signal13F.Mode allocation, double minTargetPct,
                        List<String> fallbacks) {

        public static final int DEFAULT_GROUP_B_TOP_N = 4;
        public static final int DEFAULT_GROUP_B_WINDOW_YEARS = 2;
        public static final int DEFAULT_GROUP_B_MIN_PERIODS = 6;
        public static final double DEFAULT_GROUP_WEIGHT_A = 0.5;
        public static final double DEFAULT_CONVICTION_CAP_PCT = 10;
        public static final Signal13F.Mode DEFAULT_ALLOCATION = Signal13F.Mode.CONVICTION;
        public static final double DEFAULT_MIN_TARGET_PCT = 1.0;

        public Blend {
            fallbacks = List.copyOf(fallbacks);
        }

        public static Blend defaults() {
            return new Blend(DEFAULT_GROUP_B_TOP_N, DEFAULT_GROUP_B_WINDOW_YEARS, DEFAULT_GROUP_B_MIN_PERIODS,
                    DEFAULT_GROUP_WEIGHT_A, DEFAULT_CONVICTION_CAP_PCT, DEFAULT_ALLOCATION, DEFAULT_MIN_TARGET_PCT,
                    List.of());
        }

        /** 설정 본문 전체에서 {@code blend}를 읽습니다. 본문이 null이면 기본값(fallbacks 없음 — 설정 행이 없는 것). */
        public static Blend from(JsonNode body) {
            if (body == null) {
                return defaults();
            }
            JsonNode blend = Json.child(body, "blend");
            if (blend == null || !blend.isObject()) {
                return new Blend(DEFAULT_GROUP_B_TOP_N, DEFAULT_GROUP_B_WINDOW_YEARS, DEFAULT_GROUP_B_MIN_PERIODS,
                        DEFAULT_GROUP_WEIGHT_A, DEFAULT_CONVICTION_CAP_PCT, DEFAULT_ALLOCATION, DEFAULT_MIN_TARGET_PCT,
                        List.of("blend"));
            }
            List<String> fallbacks = new ArrayList<>();
            JsonNode groupB = Json.child(blend, "groupB");
            int topN = DEFAULT_GROUP_B_TOP_N;
            int window = DEFAULT_GROUP_B_WINDOW_YEARS;
            int minPeriods = DEFAULT_GROUP_B_MIN_PERIODS;
            if (groupB != null && groupB.isObject()) {
                List<String> groupFallbacks = new ArrayList<>();
                topN = (int) number(groupB, "topN", DEFAULT_GROUP_B_TOP_N, Blend::isWhole1To12, groupFallbacks);
                // 창은 기존 메뉴 저장본(q8, 8분기 ≈ 2년)이 덮는 범위 안에서만 — 더 길면 q8 기관은 앞쪽이 비어 짧은 기간의 값이 됩니다.
                window = (int) number(groupB, "windowYears", DEFAULT_GROUP_B_WINDOW_YEARS,
                        v -> v >= 1 && v <= 2 && v == Math.rint(v), groupFallbacks);
                minPeriods = (int) number(groupB, "minPeriods", DEFAULT_GROUP_B_MIN_PERIODS,
                        v -> v >= 1 && v <= 8 && v == Math.rint(v), groupFallbacks);
                groupFallbacks.forEach(key -> fallbacks.add("groupB." + key));
            } else {
                fallbacks.add("groupB");
            }
            double weightA = number(blend, "groupWeightA", DEFAULT_GROUP_WEIGHT_A, v -> v >= 0 && v <= 1, fallbacks);
            double cap = number(blend, "convictionCapPct", DEFAULT_CONVICTION_CAP_PCT, v -> v >= 1 && v <= 50,
                    fallbacks);
            double minTarget = number(blend, "minTargetPct", DEFAULT_MIN_TARGET_PCT, v -> v >= 0 && v <= 10,
                    fallbacks);
            Signal13F.Mode mode = DEFAULT_ALLOCATION;
            String modeText = Json.asText(blend, "allocation");
            try {
                mode = Signal13F.Mode.valueOf(modeText == null ? "" : modeText.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                fallbacks.add("allocation");
            }
            return new Blend(topN, window, minPeriods, weightA, cap, mode, minTarget,
                    fallbacks.stream().map(key -> "blend." + key).toList());
        }

        private static boolean isWhole1To12(double v) {
            return v >= 1 && v <= 12 && v == Math.rint(v);
        }
    }

    /**
     * 규칙 책의 {@code rules.*} 묶음(설계 §4-2·§4-4). 단계 2에 더한 키라 그 전에 만든 설정 행에는 없습니다 — 키가 없거나 범위
     * 밖이면 그 키만 기본값으로 읽고 {@link #fallbacks}에 {@code rules.…} 이름으로(묶음이 통째로 없으면 {@code rules}) 남깁니다.
     * {@link Blend}처럼 장부의 {@link PaperSettings#fallbacks}와 따로 두는 것은 장부가 이 키를 읽지 않아서입니다(장부 경로의 경고에
     * 섞지 않게).
     *
     * @param parkCashThresholdPct 재선정일이 아닌 날(SCHEDULED·MANUAL) 남는 현금을 SHY에 두는 기준(rules.parkCashThresholdPct,
     *                             순자산의 %, 기본 2, 0~20) — 어림한 남는 현금이 이보다 클 때만 SHY 매수를 한 건 냅니다. 기준을
     *                             두는 것은 매도 대금 몇백 달러마다 SHY를 사고팔아 슬리피지를 날마다 내지 않게 하려는 것입니다
     */
    public record Rules(double parkCashThresholdPct, List<String> fallbacks) {

        public static final double DEFAULT_PARK_CASH_THRESHOLD_PCT = 2;
        /** 기준의 상한(%) — 이보다 크면 매도 대금이 몇 달씩 현금으로 놀아 '남는 현금은 SHY'(R3)가 무의미해집니다. */
        public static final double MAX_PARK_CASH_THRESHOLD_PCT = 20;

        public Rules {
            fallbacks = List.copyOf(fallbacks);
        }

        public static Rules defaults() {
            return new Rules(DEFAULT_PARK_CASH_THRESHOLD_PCT, List.of());
        }

        /** 설정 본문 전체에서 {@code rules}를 읽습니다. 본문이 null이면 기본값(fallbacks 없음 — 설정 행이 없는 것). */
        public static Rules from(JsonNode body) {
            if (body == null) {
                return defaults();
            }
            JsonNode rules = Json.child(body, "rules");
            if (rules == null || !rules.isObject()) {
                return new Rules(DEFAULT_PARK_CASH_THRESHOLD_PCT, List.of("rules"));
            }
            List<String> fallbacks = new ArrayList<>();
            double threshold = number(rules, "parkCashThresholdPct", DEFAULT_PARK_CASH_THRESHOLD_PCT,
                    v -> v >= 0 && v <= MAX_PARK_CASH_THRESHOLD_PCT, fallbacks);
            return new Rules(threshold, fallbacks.stream().map(key -> "rules." + key).toList());
        }
    }

    private static List<String> tickers(JsonNode body, String key, List<String> fallback, List<String> fallbacks) {
        JsonNode node = Json.child(body, key);
        if (node == null || !node.isArray()) {
            fallbacks.add(key);
            return fallback;
        }
        List<String> out = new ArrayList<>();
        for (JsonNode item : node) {
            if (item.isString() && !item.asString("").isBlank()) {
                out.add(item.asString("").trim().toUpperCase(java.util.Locale.ROOT));
            }
        }
        // 빈 목록은 '현금성 종목 없음'이라는 뜻일 수 있어 그대로 받습니다(SHY에도 스탑을 거는 설정).
        return out;
    }
}
