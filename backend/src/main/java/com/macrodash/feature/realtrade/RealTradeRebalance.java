package com.macrodash.feature.realtrade;

import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Order;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * 규칙 계좌 재선정 다음 묶음의 회전율 예외 판정(ADR 0028 덧붙임 2026-11-19 — 사용자 승인 R1~R4, 계획 3판) — 순수 계산입니다({@link RealTradePlanner}와
 * 같은 성격: DB·네트워크·시계를 모름). 회전율 60% 멈춤({@code RealTradeJob#turnoverHalt})이 멈춤을 낸 묶음 가운데, 따라 하는 책이 규칙 계좌이고 앞 거래일
 * D의 정기 결정이 {@code REBALANCE}·{@code OK}이며 가장 최근 묶음이 D 세션의 같은 책 묶음일 때(입구 — {@code RealTradeJob}이 봄), 아래 열두 확인을 모두
 * 지나면 그 묶음 하나를 보냅니다. 하나라도 어긋나거나 모르면 지금처럼 멈춥니다(fail-closed). 보내는 주문 계산은 바꾸지 않습니다 — 묶음을 만들지 말지만.
 *
 * <p>측정값(모두 운용 평가액 E 대비 %, 소수 둘째 자리 — 가격 배율만 소수 셋째 자리)
 * <ul>
 *   <li><b>T</b> 판정 회전율 — 지금 멈춤 판정과 같은 식({@link RealTradePlanner#sync} + {@link RealTradePlanner#withoutStops})이되 막는 종목 자리에
 *       이 기능의 미종료 주문 종목({@code own})만 — 매매 제한(VI·거절 대기) 종목도 셉니다(풀리면 같은 창 마무리가 검사 없이 맞추므로).</li>
 *   <li><b>V</b> 계좌 어긋남 — 앞 묶음 목표(양쪽에서 이미 없는 종목만 뺀 {@link #prevKept})로 지금 맞춘다면 낼 회전율(정수 주·1% 문턱·책 밖 보유 전량을
 *       T와 똑같이, 스탑 종목은 범위 밖).</li>
 *   <li><b>U</b> 판정에서 빠진 종목 수 — T·V 계획에서 스탑이 아닌 종목이 {@link #UNCOUNTED_SKIPS}로 빠진 것(그 몫은 금액을 셀 수 없고 같은 창 마무리가
 *       검사 없이 맞춤).</li>
 *   <li><b>D</b> 하루 한도로 오늘 못 내는 매수(상한가 기준) — 현금을 넉넉히 둔 계좌로 1건 상한 없이 다리를 내고 남은 하루 건수·매수 금액만
 *       {@code limit()} 순서로 적용해 본 차이. 밀리는 매도도 셉니다.</li>
 *   <li><b>Q</b> 가격 배율 — 지금 목표의 모든 종목에서 max(책 가격 ÷ 실제 가격, 역수). 실제 가격을 모르는 종목은 빼고(U가 멈춤) 책 가격을 모르면 모름.</li>
 *   <li><b>J</b> 종목 목표 증가 — max(지금 목표 − 앞 묶음 목표), 현금성 뺌. <b>K</b> 유지 종목 축소 — max(앞 − 지금), 두 목표에 다 있는 주식 종목(스탑 뺌).</li>
 *   <li><b>N</b> 주식 목표 종목 수(현금성·스탑 뺌, 목표 1% 이상만). <b>R</b> 비현금성 노출 감소 = Σ보유 비중 − Σ지금 목표(현금성·스탑 뺌).
 *       <b>I</b> 목표 합 Σ지금 목표(스탑 크레딧 없음 — R2).</li>
 *   <li><b>B°</b> 스탑 감소분만 뺀 책 변화량({@code RealTradeJob#targetDrift}, 현금성 상쇄 없음 — 교차 확인 기준), <b>B</b> 현금성 상쇄까지 뺀 책
 *       변화량(표시용).</li>
 * </ul>
 *
 * <p>판정({@link #judge}) — 모든 값을 다 센 뒤 처음 어긋난 코드(같음은 통과): 값 모름 → U = 0 → D ≤ 20·밀린 매도 없음 → V ≤ 20 → Q ≤ 1.5 → J ≤ 12 →
 * K ≤ 5 → N ≥ 1 → R ≤ 30 → I ≥ 90 → I ≤ 101 → T ≤ B° + 20 → T ≤ 150.
 */
final class RealTradeRebalance {

    private RealTradeRebalance() {
    }

    // ------------------------------------------------------------------ 모의 쪽 글자(경계 때문에 모의 클래스를 참조하지 않음 — 선례 ManualAccountJob.FINAL_STATUSES)
    /** 규칙 계좌 재선정일의 정기 결정 종류 — 모의 {@code RuleBookService.REBALANCE}(:103, {@code KrRuleBookService}가 씀). 대조 시험이 같은 글자인지 봅니다. */
    static final String KIND_REBALANCE = "REBALANCE";
    /** 결정 상태 OK — 모의 {@code RuleBookService.STATUS_OK}(:141). */
    static final String STATUS_OK = "OK";
    /** 규칙 계좌의 책 종류 — 모의 {@code PaperBooks.KIND_RULES}(:35). */
    static final String BOOK_KIND_RULES = "RULES";

    // ------------------------------------------------------------------ 임계값(계획 3판 3-3 — 바꾸는 것은 새 결정)
    static final BigDecimal DAILY_SHORT_MAX_PCT = new BigDecimal("20");
    static final BigDecimal ACCOUNT_DRIFT_MAX_PCT = new BigDecimal("20");
    static final BigDecimal PRICE_RATIO_MAX = new BigDecimal("1.5");
    static final BigDecimal NAME_JUMP_MAX_PCT = new BigDecimal("12");
    static final BigDecimal NAME_CUT_MAX_PCT = new BigDecimal("5");
    static final int MIN_STOCK_NAMES = 1;
    /** 주식 목표 종목 수(N)에 넣는 목표 비중의 하한(%) — {@link RealTradePlanner#SYNC_MIN_FRACTION}의 책 종목 문턱과 같은 크기. */
    static final double MIN_NAME_WEIGHT_PCT = 1.0;
    static final BigDecimal DERISK_MAX_PCT = new BigDecimal("30");
    static final BigDecimal INVESTED_MIN_PCT = new BigDecimal("90");
    static final BigDecimal INVESTED_MAX_PCT = new BigDecimal("101");
    /** 교차 확인 여유 — 판정 회전율 ≤ B° + 이 값. */
    static final BigDecimal SLACK_PCT = new BigDecimal("20");
    static final BigDecimal CAP_PCT = new BigDecimal("150");
    /** 하루 한도 셈에서 계좌의 현금 자리에 넣는 E의 배수(현금 제약 없이 — 153130 매도 대금이 들어온 뒤의 마무리까지 합친 하루). */
    static final BigDecimal RICH_CASH_MULTIPLE = BigDecimal.TEN;

    /** 판정에서 빠진 종목으로 세는 건너뜀 사유(스탑 종목은 빼고 셈). */
    static final Set<String> UNCOUNTED_SKIPS = Set.of(RealTradePlanner.SKIP_OWN, RealTradePlanner.SKIP_OPPOSITE,
            RealTradePlanner.SKIP_PENDING_UNKNOWN, RealTradePlanner.SKIP_PRICE, RealTradePlanner.SKIP_NOT_SELLABLE);

    // ------------------------------------------------------------------ 판정 코드(HALT detail rebalanceCheck — 화면 이름표 대조 시험이 CHECK_ 접두어를 읽음)
    // 입구
    static final String CHECK_BUYS_PAUSED = "buys-paused";
    static final String CHECK_BUYS_UNPRICED = "buys-unpriced";
    static final String CHECK_CALENDAR_UNKNOWN = "calendar-unknown";
    static final String CHECK_NO_REBALANCE = "no-rebalance";
    static final String CHECK_PRIOR_BATCH = "prior-batch";
    // 열두 확인
    static final String CHECK_VALUE_UNKNOWN = "value-unknown";
    static final String CHECK_UNCOUNTED = "uncounted";
    static final String CHECK_DAILY_CAP_SHORT = "daily-cap-short";
    static final String CHECK_ACCOUNT_DRIFT = "account-drift";
    static final String CHECK_PRICE_MISMATCH = "price-mismatch";
    static final String CHECK_NAME_JUMP = "name-jump";
    static final String CHECK_NAME_CUT = "name-cut";
    static final String CHECK_NO_NAMES = "no-names";
    static final String CHECK_DERISK_OVER = "derisk-over";
    static final String CHECK_TARGETS_THIN = "targets-thin";
    static final String CHECK_TARGETS_OVER = "targets-over";
    static final String CHECK_OVER_ALLOWANCE = "over-allowance";
    static final String CHECK_OVER_CAP = "over-cap";

    // ------------------------------------------------------------------ 기록 칸(이벤트 detail — %·배율·개수만, 종목·수량·금액 없음)
    static final String DETAIL_CHECK = "rebalanceCheck";
    static final String DETAIL_DECISION_DATE = "decisionDate";
    static final String DETAIL_DECISION_KIND = "decisionKind";
    static final String DETAIL_DECISION_STATUS = "decisionStatus";

    private static final BigDecimal HUNDRED = new BigDecimal("100");

    // ------------------------------------------------------------------ 측정값
    /**
     * 열두 확인의 입력(null은 모름 — {@value #CHECK_VALUE_UNKNOWN}). {@code crossDriftPct}는 B°, {@code bookDriftPct}는 B, {@code sellsDropped}는 하루
     * 건수로 오늘 못 내는 매도 수입니다.
     */
    record Inputs(BigDecimal checkTurnoverPct, BigDecimal crossDriftPct, BigDecimal bookDriftPct, BigDecimal accountDriftPct, Integer uncounted,
                  BigDecimal dailyShortPct, Integer sellsDropped, BigDecimal priceRatio, BigDecimal nameJumpPct, BigDecimal nameCutPct,
                  Integer stockNames, BigDecimal deriskPct, BigDecimal investedPct) {

        /** 아무것도 셀 수 없음. */
        static final Inputs UNKNOWN = new Inputs(null, null, null, null, null, null, null, null, null, null, null, null, null);

        /** 모든 값을 셌는가(음수 개수는 모름으로 봄). */
        boolean known() {
            return checkTurnoverPct != null && crossDriftPct != null && bookDriftPct != null && accountDriftPct != null && uncounted != null
                    && uncounted >= 0 && dailyShortPct != null && sellsDropped != null && sellsDropped >= 0 && priceRatio != null
                    && nameJumpPct != null && nameCutPct != null && stockNames != null && deriskPct != null && investedPct != null;
        }

        /** 허용폭 표시값 min(B° + 20, 150)(detail에만) — B°를 모르면 null. */
        BigDecimal allowancePct() {
            return crossDriftPct == null ? null : crossDriftPct.add(SLACK_PCT).min(CAP_PCT);
        }
    }

    /**
     * 판정 결과. {@code check}가 null이면 예외로 보냄({@link #exempt}), 아니면 멈춤 사유 코드. {@code inputs}는 셌을 때만(입구에서 끊긴 판정은 null),
     * {@code extra}는 입구 판정의 코드 칸(결정 종류·상태 — 값이 있을 때만).
     */
    record Verdict(String check, Inputs inputs, Map<String, Object> extra) {

        Verdict {
            extra = extra == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
        }

        /** 입구에서 끊긴 판정(측정 없음). */
        static Verdict gate(String check) {
            return new Verdict(check, null, Map.of());
        }

        boolean exempt() {
            return check == null;
        }

        /**
         * 이벤트 detail에 더할 칸 — 멈춤이면 {@value #DETAIL_CHECK}, 셌으면 숫자 칸(판정 회전율·책 변화량·계좌 어긋남·하루 한도로 못 내는 매수·가격 배율·
         * 종목 증가·유지 종목 축소·주식 종목 수·노출 감소·목표 합·허용폭)과 멈춤이면 빠진 종목 수. 모르는 값은 넣지 않습니다. 종목·수량·금액은 없습니다.
         */
        Map<String, Object> detail() {
            Map<String, Object> out = new LinkedHashMap<>();
            if (check != null) {
                out.put(DETAIL_CHECK, check);
            }
            out.putAll(extra);
            if (inputs != null) {
                putIf(out, "checkTurnoverPct", inputs.checkTurnoverPct());
                putIf(out, "bookDriftPct", inputs.bookDriftPct());
                putIf(out, "accountDriftPct", inputs.accountDriftPct());
                putIf(out, "dailyShortPct", inputs.dailyShortPct());
                putIf(out, "priceRatio", inputs.priceRatio());
                putIf(out, "nameJumpPct", inputs.nameJumpPct());
                putIf(out, "nameCutPct", inputs.nameCutPct());
                putIf(out, "stockNames", inputs.stockNames());
                putIf(out, "deriskPct", inputs.deriskPct());
                putIf(out, "investedPct", inputs.investedPct());
                putIf(out, "allowancePct", inputs.allowancePct());
                if (check != null) {
                    putIf(out, "uncounted", inputs.uncounted());
                }
            }
            return out;
        }

        private static void putIf(Map<String, Object> out, String key, Object value) {
            if (value != null) {
                out.put(key, value);
            }
        }
    }

    /** 하루 한도로 오늘 못 내는 매수(E 대비 %, 상한가 기준)와 밀리는 매도 수. */
    record DailyShort(BigDecimal shortPct, int sellsDropped) {
    }

    // ------------------------------------------------------------------ 판정
    /** 열두 확인(클래스 설명의 순서) — 처음 어긋난 코드, 모두 지나면 예외. */
    static Verdict judge(Inputs in) {
        return new Verdict(check(in), in, Map.of());
    }

    private static String check(Inputs in) {
        if (in == null || !in.known()) {
            return CHECK_VALUE_UNKNOWN;
        }
        if (in.uncounted() != 0) {
            return CHECK_UNCOUNTED;
        }
        if (in.dailyShortPct().compareTo(DAILY_SHORT_MAX_PCT) > 0 || in.sellsDropped() > 0) {
            return CHECK_DAILY_CAP_SHORT;
        }
        if (in.accountDriftPct().compareTo(ACCOUNT_DRIFT_MAX_PCT) > 0) {
            return CHECK_ACCOUNT_DRIFT;
        }
        if (in.priceRatio().compareTo(PRICE_RATIO_MAX) > 0) {
            return CHECK_PRICE_MISMATCH;
        }
        if (in.nameJumpPct().compareTo(NAME_JUMP_MAX_PCT) > 0) {
            return CHECK_NAME_JUMP;
        }
        if (in.nameCutPct().compareTo(NAME_CUT_MAX_PCT) > 0) {
            return CHECK_NAME_CUT;
        }
        if (in.stockNames() < MIN_STOCK_NAMES) {
            return CHECK_NO_NAMES;
        }
        if (in.deriskPct().compareTo(DERISK_MAX_PCT) > 0) {
            return CHECK_DERISK_OVER;
        }
        if (in.investedPct().compareTo(INVESTED_MIN_PCT) < 0) {
            return CHECK_TARGETS_THIN;
        }
        if (in.investedPct().compareTo(INVESTED_MAX_PCT) > 0) {
            return CHECK_TARGETS_OVER;
        }
        if (in.checkTurnoverPct().compareTo(in.crossDriftPct().add(SLACK_PCT)) > 0) {
            return CHECK_OVER_ALLOWANCE;
        }
        if (in.checkTurnoverPct().compareTo(CAP_PCT) > 0) {
            return CHECK_OVER_CAP;
        }
        return null;
    }

    // ------------------------------------------------------------------ 측정
    /**
     * 열두 확인의 입력을 셉니다. 비중(지금·앞 묶음)에 유한하지 않거나 음수인 값이 있거나 E가 없으면 모두 모름({@link Inputs#UNKNOWN}), 하나를 셀 수 없으면 그
     * 칸만 모름(판정은 {@value #CHECK_VALUE_UNKNOWN}).
     *
     * @param prev         앞 묶음 목표({@code RealTradeJob#weights} — 비중 0의 전량 매도 표시는 뺀 맵)
     * @param now          지금 목표 비중({@code OpenTargets.weightPct})
     * @param bookPrice    책이 그 비중을 셈한 평가 가격({@code OpenTargets.price})
     * @param stops        따라 하는 책의 대기 STOP 종목(멈춤 판정과 같은 집합)
     * @param own          이 기능의 미종료 주문 종목(매매 제한 종목을 더하기 전 — {@code Planned.ownBlocked})
     * @param reserved     같은 창에서 이미 잡은 매수의 상한가 합
     * @param rules        멈춤 판정과 같은 계획 규칙
     * @param stopProceeds 계획 밖의 스탑 대금({@code RealTradeJob#stopProceeds})
     * @param roomOrders   수집기 하루 한도의 오늘 남은 건수
     * @param roomBuyKrw   수집기 하루 한도의 오늘 남은 매수 금액(null이면 모름)
     */
    static Inputs measure(Map<String, Double> prev, Map<String, Double> now, Map<String, Double> bookPrice, Set<String> stops,
                          Set<String> cashLike, Account account, BigDecimal equity, Set<String> own, BigDecimal reserved, Rules rules,
                          BigDecimal stopProceeds, Integer roomOrders, BigDecimal roomBuyKrw) {
        if (equity == null || equity.signum() <= 0 || !validWeights(prev) || !validWeights(now) || account == null || account.cash() == null) {
            return Inputs.UNKNOWN;
        }
        Map<String, Double> kept = prevKept(prev, now, stops, account);
        Plan judged = judgePlan(now, equity, account, own, reserved, rules, stops, stopProceeds);
        Plan drift = accountDrift(kept, equity, account, own, rules, stops);
        DailyShort daily = dailyShort(now, equity, account, own, cashLike, roomOrders, roomBuyKrw);
        BigDecimal cross = RealTradeJob.targetDrift(kept, now, stops, Set.of()).orElse(null);
        BigDecimal book = RealTradeJob.targetDrift(kept, now, stops, cashLike).orElse(null);
        return new Inputs(judged.turnoverPct(), cross, book, drift.turnoverPct(), uncounted(judged, drift, stops),
                daily == null ? null : daily.shortPct(), daily == null ? null : daily.sellsDropped(), priceRatio(now, bookPrice, account),
                nameJump(now, kept, cashLike), nameCut(now, kept, stops, cashLike), stockNames(now, stops, cashLike),
                derisk(now, stops, cashLike, account, equity), invested(now));
    }

    /** 앞 묶음 목표에서 양쪽에서 이미 없는 종목(지금 목표에 없고, 스탑 종목이 아니고, 실제 보유가 1주 미만)만 뺀 맵 — 스탑 종목은 남깁니다. */
    static Map<String, Double> prevKept(Map<String, Double> prev, Map<String, Double> now, Set<String> stops, Account account) {
        Map<String, Double> out = new TreeMap<>();
        prev.forEach((symbol, weight) -> {
            boolean gone = !now.containsKey(symbol) && !stops.contains(symbol) && account.held(symbol).compareTo(BigDecimal.ONE) < 0;
            if (!gone) {
                out.put(symbol, weight);
            }
        });
        return out;
    }

    /**
     * 판정 계획 — 지금 멈춤 판정과 같은 식({@link RealTradePlanner#sync} → {@link RealTradePlanner#withoutStops})이되 막는 종목 자리에 {@code own}(이 기능의
     * 미종료 주문 종목)만. 매매 제한 종목은 막지 않아 그날 실제로 나갈 몫을 셉니다. 건너뜀은 {@code sync}의 것 그대로입니다.
     */
    static Plan judgePlan(Map<String, Double> now, BigDecimal equity, Account account, Set<String> own, BigDecimal reserved, Rules rules,
                          Set<String> stops, BigDecimal stopProceeds) {
        Plan full = RealTradePlanner.sync(now, equity, account, own, reserved, rules, true);
        return RealTradePlanner.withoutStops(full, now, account, own, rules, true, stops, stopProceeds);
    }

    /** 계좌 어긋남 계획 — 앞 묶음 목표({@link #prevKept})로 지금 맞춘다면 낼 계획(범위 = 앞 목표 ∪ 보유 − 스탑 종목, 막는 종목은 {@code own}만). */
    static Plan accountDrift(Map<String, Double> prevKept, BigDecimal equity, Account account, Set<String> own, Rules rules, Set<String> stops) {
        Set<String> scope = new TreeSet<>(prevKept.keySet());
        account.positions().forEach((symbol, p) -> {
            if (p.quantity() != null && p.quantity().signum() > 0) {
                scope.add(symbol);
            }
        });
        scope.removeAll(stops);
        return RealTradePlanner.sync(prevKept, equity, account, own, BigDecimal.ZERO, rules, true, scope, null);
    }

    /** 판정에서 빠진 종목 수 — 두 계획의 건너뜀 가운데 {@link #UNCOUNTED_SKIPS} 사유이고 스탑 종목이 아닌 종목(종목마다 한 번). */
    static int uncounted(Plan judged, Plan drift, Set<String> stops) {
        Set<String> out = new TreeSet<>();
        for (Plan plan : new Plan[]{judged, drift}) {
            for (Skip skip : plan.skipped()) {
                if (UNCOUNTED_SKIPS.contains(skip.reason()) && (skip.symbol() == null || !stops.contains(skip.symbol()))) {
                    out.add(skip.symbol() == null ? "" : skip.symbol());
                }
            }
        }
        return out.size();
    }

    /**
     * 하루 한도로 오늘 못 내는 매수 — 현금만 E × {@link #RICH_CASH_MULTIPLE}로 바꾼 계좌로 1건 상한·매수 멈춤·매도 가능 요구 없이 두 번 계획해(하루 한도 없이 /
     * 남은 하루 건수·매수 금액으로 — 같은 {@code limit()} 순서: 매도 먼저, 현금성 매수 마지막) 매수가 잡는 상한가 금액의 차이(E 대비 %)와 밀리는 매도 수.
     * 남은 하루 매수 금액을 모르면 null(모름).
     */
    static DailyShort dailyShort(Map<String, Double> now, BigDecimal equity, Account account, Set<String> own, Set<String> cashLike,
                                 Integer roomOrders, BigDecimal roomBuyKrw) {
        if (roomOrders == null || roomBuyKrw == null) {
            return null;
        }
        Account rich = new Account(equity.multiply(RICH_CASH_MULTIPLE), account.positions(), account.quotes(), account.sellable(),
                account.pending());
        Rules open = new Rules(null, cashLike, false, false, null, null);
        Plan need = RealTradePlanner.sync(now, equity, rich, own, BigDecimal.ZERO, open, true);
        Plan fit = RealTradePlanner.sync(now, equity, rich, own, BigDecimal.ZERO, open.withDaily(roomOrders, roomBuyKrw), true);
        BigDecimal shortKrw = buyReserve(need).subtract(buyReserve(fit)).max(BigDecimal.ZERO);
        int dropped = Math.max(0, sells(need) - sells(fit));
        return new DailyShort(pct(shortKrw, equity), dropped);
    }

    private static BigDecimal buyReserve(Plan plan) {
        return plan.orders().stream().filter(Order::buy).map(Order::reserve).reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private static int sells(Plan plan) {
        return (int) plan.orders().stream().filter(o -> !o.buy()).count();
    }

    /** 가격 배율 Q — 지금 목표의 모든 종목에서 max(책 가격 ÷ 실제 가격, 역수), 없으면 1. 실제 가격을 모르는 종목은 뺌, 책 가격을 모르면 null. */
    static BigDecimal priceRatio(Map<String, Double> now, Map<String, Double> bookPrice, Account account) {
        double max = 1.0;
        for (String symbol : now.keySet()) {
            BigDecimal real = account.price(symbol);
            if (real == null) {
                continue;
            }
            Double book = bookPrice == null ? null : bookPrice.get(symbol);
            if (book == null || !Double.isFinite(book) || book <= 0) {
                return null;
            }
            double ratio = book / real.doubleValue();
            if (!Double.isFinite(ratio) || ratio <= 0) {
                return null;
            }
            max = Math.max(max, Math.max(ratio, 1 / ratio));
        }
        return Double.isFinite(max) ? BigDecimal.valueOf(max).setScale(3, RoundingMode.HALF_UP) : null;
    }

    /** 종목 목표 증가 J — max(지금 − 앞, 앞에 없으면 0), 현금성 뺌, 없으면 0. */
    static BigDecimal nameJump(Map<String, Double> now, Map<String, Double> kept, Set<String> cashLike) {
        double max = 0;
        for (Map.Entry<String, Double> e : now.entrySet()) {
            if (!cashLike.contains(e.getKey())) {
                max = Math.max(max, e.getValue() - kept.getOrDefault(e.getKey(), 0.0));
            }
        }
        return round(max);
    }

    /** 유지 종목 축소 K — max(앞 − 지금), 두 목표에 다 있는 주식 종목(현금성·스탑 뺌), 없으면 0. */
    static BigDecimal nameCut(Map<String, Double> now, Map<String, Double> kept, Set<String> stops, Set<String> cashLike) {
        double max = 0;
        for (Map.Entry<String, Double> e : now.entrySet()) {
            String symbol = e.getKey();
            if (kept.containsKey(symbol) && !cashLike.contains(symbol) && !stops.contains(symbol)) {
                max = Math.max(max, kept.get(symbol) - e.getValue());
            }
        }
        return round(max);
    }

    /** 주식 목표 종목 수 N — 현금성·스탑 뺌, 목표 {@value #MIN_NAME_WEIGHT_PCT}% 이상만. */
    static int stockNames(Map<String, Double> now, Set<String> stops, Set<String> cashLike) {
        return (int) now.entrySet().stream().filter(e -> !cashLike.contains(e.getKey()) && !stops.contains(e.getKey())
                && e.getValue() >= MIN_NAME_WEIGHT_PCT).count();
    }

    /** 비현금성 노출 감소 R = Σ보유 비중 − Σ지금 목표(현금성·스탑 뺌, 보유는 수량 &gt; 0 전부). 보유 가격을 모르면 null. */
    static BigDecimal derisk(Map<String, Double> now, Set<String> stops, Set<String> cashLike, Account account, BigDecimal equity) {
        BigDecimal held = BigDecimal.ZERO;
        for (Map.Entry<String, RealTradePlanner.Position> e : account.positions().entrySet()) {
            RealTradePlanner.Position p = e.getValue();
            if (p.quantity() == null || p.quantity().signum() <= 0 || cashLike.contains(e.getKey()) || stops.contains(e.getKey())) {
                continue;
            }
            BigDecimal price = account.price(e.getKey());
            if (price == null) {
                return null;
            }
            held = held.add(p.quantity().multiply(price));
        }
        double target = now.entrySet().stream().filter(e -> !cashLike.contains(e.getKey()) && !stops.contains(e.getKey()))
                .mapToDouble(Map.Entry::getValue).sum();
        BigDecimal heldPct = held.multiply(HUNDRED).divide(equity, 8, RoundingMode.HALF_UP);
        return heldPct.subtract(BigDecimal.valueOf(target)).setScale(2, RoundingMode.HALF_UP);
    }

    /** 목표 합 I = Σ지금 목표(크레딧 없음). */
    static BigDecimal invested(Map<String, Double> now) {
        return round(now.values().stream().mapToDouble(Double::doubleValue).sum());
    }

    /** 관찰 로그 한 줄(계획 3-8 — %·배율·개수만, 종목·수량·금액 없음). 모르는 값은 '?'. */
    static String summary(Inputs in) {
        return "판정 회전율 " + text(in.checkTurnoverPct()) + "% · 빠진 종목 " + text(in.uncounted()) + " · 계좌 어긋남 " + text(in.accountDriftPct())
                + "% · 가격 배율 " + text(in.priceRatio()) + " · 종목 증가 " + text(in.nameJumpPct()) + "%p · 유지 종목 축소 " + text(in.nameCutPct())
                + "%p · 주식 종목 " + text(in.stockNames()) + " · 노출 감소 " + text(in.deriskPct()) + "%p · 목표 합 " + text(in.investedPct())
                + "% · 책 변화량 " + text(in.bookDriftPct()) + "%p · 교차 기준 " + text(in.crossDriftPct()) + "%p";
    }

    private static String text(Object value) {
        return value == null ? "?" : value.toString();
    }

    private static boolean validWeights(Map<String, Double> weights) {
        if (weights == null) {
            return false;
        }
        for (Double w : weights.values()) {
            if (w == null || !Double.isFinite(w) || w < 0) {
                return false;
            }
        }
        return true;
    }

    private static BigDecimal pct(BigDecimal amount, BigDecimal equity) {
        return amount.multiply(HUNDRED).divide(equity, 2, RoundingMode.HALF_UP);
    }

    private static BigDecimal round(double value) {
        return Double.isFinite(value) ? BigDecimal.valueOf(value).setScale(2, RoundingMode.HALF_UP) : null;
    }

    /** 입구 G4 — 앞 거래일 결정이 재선정(REBALANCE)이고 OK인가(null 안전). */
    static boolean rebalanceOk(String kind, String status) {
        return KIND_REBALANCE.equals(kind) && STATUS_OK.equals(status);
    }

    /** 결정 종류·상태 코드 칸(입구 G4가 어긋날 때 detail에) — 대문자·밑줄 코드 모양일 때만(다른 글은 싣지 않음). */
    static Map<String, Object> decisionCodes(String kind, String status) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (kind != null && DECISION_CODE.matcher(kind).matches()) {
            out.put(DETAIL_DECISION_KIND, kind);
        }
        if (status != null && DECISION_CODE.matcher(status).matches()) {
            out.put(DETAIL_DECISION_STATUS, status);
        }
        return out;
    }

    private static final Pattern DECISION_CODE = Pattern.compile("^[A-Z][A-Z_]{0,39}$");
}
