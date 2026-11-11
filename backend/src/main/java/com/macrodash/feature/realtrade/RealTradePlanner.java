package com.macrodash.feature.realtrade;

import com.macrodash.analytics.SessionWindows;
import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.feature.paper.PaperMirrorService;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * 실제 매매의 순수 계산(ADR 0028 — 명세 docs/specs/2026-11-06-real-trade-mirror.md §2·§3) — 입력 레코드를 받아 결과 레코드를 돌려주고 DB·네트워크·시계를
 * 모릅니다(시험이 사례 표로 고정). 정하는 것: 운용 평가액, 목표 수량과 보낼 수량, 건너뜀 사유, 상한가 기준 현금 확인, 1건 상한, 시가 맞추기 임계값,
 * 회전율, 한 창 안 순서, 그날 창 네 가지(시각 맞추기 날은 시가 맞추기 대신 시각 맞추기 창 — ADR 0033), 쉬는 날 판정.
 *
 * <ul>
 *   <li><b>운용 평가액 E</b> = min(원화 매수 가능 금액 + 국내 보유 전부의 평가액, 안전 상한) — 보유 하나라도 가격을 모르면 정하지 않습니다(모르면 보내지 않음).</li>
 *   <li><b>목표 수량</b> = floor(비중 × E ÷ 기준가(현재가)), <b>보낼 수량</b> = 목표 − 보유 − 같은 방향 미체결(앱 주문 포함, 매수는 +·매도는 −).
 *       소수점 보유는 차이 계산에 그대로 들어가고, 팔 수 있는 것은 정수 부분과 매도 가능 수량까지입니다(소수 부분은 {@value #SKIP_FRACTION}로 표시).</li>
 *   <li>반대 방향 미체결이 있는 종목·이 기능의 미종료 주문이 있는 종목은 건너뜁니다(사용자 주문을 취소하지 않음).</li>
 *   <li>매수는 수량 × 상한가 ≤ 매수 가능 금액 − 같은 창에서 이미 잡은 매수의 상한가 합일 때만 — 모자라면 줄이고 1주도 안 되면 그 창에서 미룹니다.
 *       1건 상한을 넘으면 쪼개지 않고 상한까지만 보냅니다({@code capped}). 매도의 1건 상한 수량은 보내기 직전 가격이 조금 올라도 수집기 검사를 지나게
 *       현재가 × {@value #SELL_PRICE_MARGIN_TEXT}로 셉니다.</li>
 *   <li>수집기 하루 한도(오늘 건수·오늘 매수 금액 — {@link #dailyUsage})의 남은 몫 안에서만 — 넘는 주문은 {@value #SKIP_DAILY_CAP}로 미룹니다.</li>
 *   <li>순서: 매도 → 매수, 현금성 종목은 매도 처음·매수 마지막.</li>
 * </ul>
 */
final class RealTradePlanner {

    private RealTradePlanner() {
    }

    static final String BUY = "BUY";
    static final String SELL = "SELL";

    // ------------------------------------------------------------------ 창(명세 §3 표)
    static final String WINDOW_SYNC = "SYNC";
    static final String WINDOW_FOLLOWUP = "SYNC_FOLLOWUP";
    static final String WINDOW_MIRROR = "MIRROR";
    static final String WINDOW_CLOSE = "NEXT_CLOSE";
    /**
     * 시각 맞추기 창(ADR 0033 결정 1) — 따라 하는 책이 개장 10분 뒤 지정 시각으로 체결하는 날, 시가 단일가 맞추기 대신 그 시각 T부터 시장가(DAY)로
     * 묶음을 만들고 보내는 창 [T, T + {@link #TIMED_SYNC_LENGTH}]. 묶음 종류·주문 용도는 시가 뒤 마무리와 같습니다(DB CHECK 그대로).
     */
    static final String WINDOW_SYNC_AT = "SYNC_AT";

    /** 시가 맞추기 창: [프리마켓 단일가 시작 + 30초, 프리마켓 끝 − 90초]. */
    static final Duration SYNC_OPEN_AFTER = Duration.ofSeconds(30);
    static final Duration SYNC_CLOSE_BEFORE = Duration.ofSeconds(90);
    /** 시가 뒤 마무리 창: [정규장 시작 + 30초, 정규장 시작 + 30분](보통 09:30 — 장 시간 변경일은 시작 + 30분). */
    static final Duration FOLLOWUP_OPEN_AFTER = Duration.ofSeconds(30);
    static final Duration FOLLOWUP_LENGTH = Duration.ofMinutes(30);
    /** 시각 맞추기 창 길이: [T, T + 3분](사용자 결정 2026-11-06 '09:10~09:13 시장가' — 묶음 생성·창 안 재시도 모두 이 안에서). */
    static final Duration TIMED_SYNC_LENGTH = Duration.ofMinutes(3);
    /** 서킷브레이커 의심 때 시각 맞추기 창의 길이 — 발동 직후여도 20분 정지 + 10분 단일가 뒤에 보낼 여유. */
    static final Duration RESTRICTED_MARKET_SYNC_LENGTH = Duration.ofMinutes(45);
    /** VI·종목 제한 때 시각 맞추기 창의 길이 — VI는 보통 2분 남짓. */
    static final Duration RESTRICTED_SYMBOL_SYNC_LENGTH = Duration.ofMinutes(12);
    /** 서킷브레이커 의심을 처음 본 뒤 보내지 않는 시간(20분 정지 + 10분 단일가 + 여유 1분). */
    static final Duration CIRCUIT_HOLD = Duration.ofMinutes(31);
    /** 코스피·코스닥 전 거래일 대비 등락률이 이 값 이하면 서킷브레이커 1·2·3단계로 봄(발동 기준 −8·−15·−20%, 지수 지연 여유 0.2%p). */
    private static final BigDecimal[] CIRCUIT_STAGES = {new BigDecimal("-7.8"), new BigDecimal("-14.8"), new BigDecimal("-19.8")};
    /** 장중 따라 하기 창: [T, min(T + 3분, 종가 단일가 시작 − 30초)] — 시작은 수집기의 DAY 창(정규장 시작 + 30초)보다 앞서지 않게. */
    static final Duration MIRROR_LENGTH = Duration.ofMinutes(3);
    static final Duration MIRROR_CLOSE_BEFORE = Duration.ofSeconds(30);
    /** 종가 따라 하기 창: [종가 단일가 시작 + 30초, 정규장 끝 − 120초]. */
    static final Duration CLOSE_OPEN_AFTER = Duration.ofSeconds(30);
    static final Duration CLOSE_CLOSE_BEFORE = Duration.ofSeconds(120);
    /** 종가 주문 체결 시각이 정규장 끝 ± 이 안이어야 함(명세 §10 — 아니면 이상 멈춤 close-auction-mismatch). */
    static final Duration CLOSE_FILL_TOLERANCE = Duration.ofMinutes(2);
    /** 토스 응답 시각과 서버 시각 차이의 상한(초, 명세 §3). */
    static final double MAX_SKEW_SECONDS = 5.0;

    // ------------------------------------------------------------------ 임계값(명세 §3.1)
    /** 시가 맞추기는 차이 금액이 E의 1% 이상일 때만(책에 없는 보유는 조건 없이 전량). */
    static final BigDecimal SYNC_MIN_FRACTION = new BigDecimal("0.01");
    /** 한 시가 맞추기 묶음의 매수 + 매도 금액 합 상한(E 대비 %). */
    static final BigDecimal TURNOVER_LIMIT_PCT = new BigDecimal("60");
    /** 한 주문 수량 상한(수집기 검사 {@code ^[1-9][0-9]{0,8}$}). */
    static final int MAX_QUANTITY = 999_999_999;
    /**
     * 1건 상한에 맞춘 매도 수량의 가격 여유 — 수집기는 보내기 직전 현재가 × 수량으로 1건 상한을 다시 재므로(넘으면 {@code over-order-limit}로 그날 그 매도가
     * 사라짐), 계획 때 현재가의 3% 위 가격으로 수량을 셉니다(매수는 그날 고정인 상한가라 여유가 필요 없음).
     */
    static final String SELL_PRICE_MARGIN_TEXT = "1.03";
    static final BigDecimal SELL_PRICE_MARGIN = new BigDecimal(SELL_PRICE_MARGIN_TEXT);

    // ------------------------------------------------------------------ 쉬는 날 사유(명세 §3)
    static final String SKIP_MARKET_CLOSED = "market-closed";
    static final String SKIP_CALENDAR_DATE = "calendar-date-mismatch";
    static final String SKIP_PAPER_CALENDAR = "paper-calendar-unknown";
    static final String SKIP_HOURS = "hours-mismatch";
    static final String SKIP_CLOCK = "clock-skew";
    static final String SKIP_CLOCK_UNKNOWN = "clock-skew-unknown";
    static final String SKIP_LEDGER = "ledger-behind";

    // ------------------------------------------------------------------ 종목 건너뜀 사유(명세 §2·§3.2)
    static final String SKIP_OPPOSITE = "opposite-pending";
    static final String SKIP_OWN = "own-pending";
    static final String SKIP_PENDING_UNKNOWN = "pending-unknown";
    static final String SKIP_PRICE = "price-missing";
    static final String SKIP_FRACTION = "fractional-part";
    static final String SKIP_SELLABLE = "sellable-unknown";
    static final String SKIP_NOT_SELLABLE = "not-sellable";
    static final String SKIP_DEFERRED_CASH = "deferred-cash";
    /** 수집기 하루 한도(오늘 건수 또는 오늘 매수 금액)의 남은 몫이 모자라 줄이거나 미룸 — 수집기가 거절할 주문을 보내지 않음. */
    static final String SKIP_DAILY_CAP = "deferred-daily-cap";
    static final String SKIP_CAPPED = "capped";
    static final String SKIP_BUYS_PAUSED = "buys-paused";
    static final String SKIP_WEIGHT = "weight-unknown";
    static final String SKIP_SYMBOL = "symbol-unsupported";
    /**
     * 따라 하는 책에 그 종목의 오늘 대기 STOP 매도가 있어 매수를 보내지 않음(ADR 0033 결정 4 — 묶음 재시도·마무리·장중 따라 하기의 매수를 보내기
     * 직전에 다시 읽음, 방금 판 종목을 다시 사지 않게).
     */
    static final String SKIP_PENDING_STOP = "pending-stop";

    /** 국내 종목 코드(수집기·DB 검사와 같음) — 아니면 주문하지 않습니다. */
    private static final Pattern KR_SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");

    /** 국내 종목 코드 모양인가 — 수집기에 종목을 물을 때도 같은 검사로 거릅니다(매매 제한 조회, QA-351). */
    static boolean krSymbol(String symbol) {
        return symbol != null && KR_SYMBOL.matcher(symbol).matches();
    }

    private static final BigDecimal HUNDRED = new BigDecimal("100");
    private static final BigDecimal ONE = BigDecimal.ONE;

    // ------------------------------------------------------------------ 입력
    /** 국내 보유 하나(소수점 보유면 수량이 소수). 가격을 모르면 null. */
    record Position(String symbol, String name, BigDecimal quantity, BigDecimal lastPrice) {
    }

    /** 현재가·상한가(모르면 null). */
    record Quote(BigDecimal lastPrice, BigDecimal upperLimitPrice) {
    }

    /** 그 종목의 토스 미체결 잔량(앱 주문 포함) — 매수·매도. {@code unknown}이면 잔량을 읽지 못한 주문이 있음(그 종목은 건너뜀). */
    record Pending(BigDecimal buy, BigDecimal sell, boolean unknown) {

        static final Pending NONE = new Pending(BigDecimal.ZERO, BigDecimal.ZERO, false);
    }

    /**
     * 토스에서 새로 읽은 계좌. {@code sellable}은 물은 종목만(없는 종목은 모름). {@code pending}은 종목 → 미체결 잔량.
     */
    record Account(BigDecimal cash, Map<String, Position> positions, Map<String, Quote> quotes, Map<String, BigDecimal> sellable,
                   Map<String, Pending> pending) {

        Account {
            positions = Map.copyOf(positions);
            quotes = Map.copyOf(quotes);
            sellable = Map.copyOf(sellable);
            pending = Map.copyOf(pending);
        }

        BigDecimal held(String symbol) {
            Position p = positions.get(symbol);
            return p == null || p.quantity() == null ? BigDecimal.ZERO : p.quantity();
        }

        String name(String symbol) {
            Position p = positions.get(symbol);
            return p == null ? null : p.name();
        }

        /** 기준가 — 현재가(시세), 없으면 보유의 현재가. 모르면 null. */
        BigDecimal price(String symbol) {
            Quote q = quotes.get(symbol);
            if (q != null && positive(q.lastPrice())) {
                return q.lastPrice();
            }
            Position p = positions.get(symbol);
            return p != null && positive(p.lastPrice()) ? p.lastPrice() : null;
        }

        BigDecimal upper(String symbol) {
            Quote q = quotes.get(symbol);
            return q != null && positive(q.upperLimitPrice()) ? q.upperLimitPrice() : null;
        }

        Pending pendingOf(String symbol) {
            return pending.getOrDefault(symbol, Pending.NONE);
        }
    }

    /**
     * 계획 규칙. {@code maxOrderKrw}는 1건 상한(수집기 한도), {@code cashLike}는 현금성 종목(창 안 순서), {@code buysPaused}면 매수 없음(손실 한도),
     * {@code requireSellable}이면 매도 가능 수량을 모르는 종목은 팔지 않습니다(실제 주문 — 켜기 창의 예상 목록은 거짓이라 정수 보유로 어림).
     * {@code remainingOrders}·{@code remainingBuyKrw}는 수집기 하루 한도의 오늘 남은 건수·매수 금액(한도 − {@link #dailyUsage}) — null이면 따지지 않습니다.
     */
    record Rules(BigDecimal maxOrderKrw, Set<String> cashLike, boolean buysPaused, boolean requireSellable, Integer remainingOrders,
                 BigDecimal remainingBuyKrw) {

        Rules {
            cashLike = Set.copyOf(cashLike);
        }

        /** 하루 한도를 따지지 않는 규칙. */
        Rules(BigDecimal maxOrderKrw, Set<String> cashLike, boolean buysPaused, boolean requireSellable) {
            this(maxOrderKrw, cashLike, buysPaused, requireSellable, null, null);
        }

        Rules withRequireSellable(boolean require) {
            return new Rules(maxOrderKrw, cashLike, buysPaused, require, remainingOrders, remainingBuyKrw);
        }

        /** 오늘 남은 하루 건수·매수 금액(null이면 따지지 않음). */
        Rules withDaily(Integer orders, BigDecimal buyKrw) {
            return new Rules(maxOrderKrw, cashLike, buysPaused, requireSellable, orders, buyKrw);
        }
    }

    // ------------------------------------------------------------------ 출력
    /** 보낼 주문 하나. {@code refPrice}는 수량을 정한 기준가, {@code reserve}는 매수가 잡는 상한가 금액(매도는 0). */
    record Order(String symbol, String name, String side, int quantity, BigDecimal refPrice, BigDecimal reserve, boolean capped) {

        BigDecimal estAmount() {
            return refPrice.multiply(BigDecimal.valueOf(quantity));
        }

        boolean buy() {
            return BUY.equals(side);
        }
    }

    /** 건너뛴 종목 하나와 사유 코드. */
    record Skip(String symbol, String name, String reason) {
    }

    /**
     * 계획. {@code turnoverAmount}는 임계값을 넘은 차이(줄이기 전 — 현금·1건 상한으로 줄이거나 미룬 것 포함, 건너뛴 종목·멈춘 매수 제외)의 금액 합,
     * {@code equity}는 그때의 E.
     */
    record Plan(List<Order> orders, List<Skip> skipped, BigDecimal turnoverAmount, BigDecimal equity) {

        Plan {
            orders = List.copyOf(orders);
            skipped = List.copyOf(skipped);
        }

        /** 회전율(E 대비 %) — E가 0 이하이면 0. */
        BigDecimal turnoverPct() {
            if (equity == null || equity.signum() <= 0) {
                return BigDecimal.ZERO;
            }
            return turnoverAmount.multiply(HUNDRED).divide(equity, 2, RoundingMode.HALF_UP);
        }

        boolean turnoverExceeded() {
            return turnoverPct().compareTo(TURNOVER_LIMIT_PCT) > 0;
        }
    }

    // ------------------------------------------------------------------ 평가액
    /**
     * 운용 평가액 E = min(매수 가능 금액 + 보유 평가액, 안전 상한). 보유 하나라도 가격을 모르거나 매수 가능 금액이 없으면 empty.
     *
     * @param maxEquity 안전 상한(null이면 상한 없음 — 실제 주문 경로는 늘 수집기 한도를 넘김)
     */
    static Optional<BigDecimal> equity(Account account, BigDecimal maxEquity) {
        if (account.cash() == null) {
            return Optional.empty();
        }
        BigDecimal total = account.cash();
        for (Position p : account.positions().values()) {
            if (p.quantity() == null || p.quantity().signum() <= 0) {
                continue;
            }
            BigDecimal price = account.price(p.symbol());
            if (price == null) {
                return Optional.empty();
            }
            total = total.add(p.quantity().multiply(price));
        }
        if (maxEquity != null && total.compareTo(maxEquity) > 0) {
            total = maxEquity;
        }
        return Optional.of(total);
    }

    // ------------------------------------------------------------------ 시가 맞추기
    /**
     * 시가 맞추기(명세 §3.1) — 책의 목표 비중 {@code weightPct}(종목 → %)로 책의 종목과 보유 종목 모두를 맞춥니다. 책에 없는 보유는 목표 0(전량 매도,
     * 1% 조건 없음). {@code threshold}면 책의 종목은 차이가 1주 이상이고 E의 1% 이상일 때만 보냅니다. {@code reservedBuy}는 같은 창에서 이미 잡은
     * 매수의 상한가 합, {@code blocked}는 이 기능의 미종료 주문이 있는 종목입니다.
     */
    static Plan sync(Map<String, Double> weightPct, BigDecimal equity, Account account, Set<String> blocked, BigDecimal reservedBuy,
                     Rules rules, boolean threshold) {
        return sync(weightPct, equity, account, blocked, reservedBuy, rules, threshold, null, null);
    }

    /**
     * {@link #sync(Map, BigDecimal, Account, Set, BigDecimal, Rules, boolean)}에 범위를 더한 것.
     *
     * @param scope    다룰 종목(null이면 책의 종목 ∪ 보유 전부). 시가 뒤 마무리는 묶음의 종목에서 그날 장중 따라 하기가 손댄 종목을 뺀 집합을 넘깁니다 — 범위 밖
     *                 보유는 '책에 없는 보유'로 팔지도, 묶음 목표로 다시 사지도 않습니다(건너뜀도 남기지 않음).
     * @param sendable 이번 창에서 보낼 수 있는 종목(null이면 전부) — 현금·하루 한도는 이 종목에만 배정합니다(시도를 다 쓴 종목이 현금을 먼저 잡아 뒤 순서
     *                 매수가 미뤄지지 않게). 회전율은 거르기 전 값입니다.
     */
    static Plan sync(Map<String, Double> weightPct, BigDecimal equity, Account account, Set<String> blocked, BigDecimal reservedBuy,
                     Rules rules, boolean threshold, Set<String> scope, Set<String> sendable) {
        List<Skip> skipped = new ArrayList<>();
        List<Candidate> candidates = new ArrayList<>();
        BigDecimal turnover = BigDecimal.ZERO;
        Set<String> symbols = new TreeSet<>(weightPct.keySet());
        account.positions().forEach((symbol, p) -> {
            if (p.quantity() != null && p.quantity().signum() > 0) {
                symbols.add(symbol);
            }
        });
        if (scope != null) {
            symbols.retainAll(scope);
        }
        BigDecimal minAmount = equity.multiply(SYNC_MIN_FRACTION);
        for (String symbol : symbols) {
            String name = account.name(symbol);
            if (!KR_SYMBOL.matcher(symbol).matches()) {
                skipped.add(new Skip(symbol, name, SKIP_SYMBOL));
                continue;
            }
            Double w = weightPct.get(symbol);
            boolean inBook = w != null;
            if (inBook && (!Double.isFinite(w) || w < 0)) {
                skipped.add(new Skip(symbol, name, SKIP_WEIGHT));
                continue;
            }
            BigDecimal held = account.held(symbol);
            BigDecimal price = account.price(symbol);
            if (price == null) {
                skipped.add(new Skip(symbol, name, SKIP_PRICE));
                continue;
            }
            BigDecimal target = inBook ? targetQuantity(w, equity, price) : BigDecimal.ZERO;
            Decision d = decide(symbol, name, target, held, price, account, blocked, null, skipped);
            if (d == null) {
                continue;
            }
            if (threshold && inBook && d.desiredAmount().compareTo(minAmount) < 0) {
                continue;
            }
            if (d.buy() && rules.buysPaused()) {
                skipped.add(new Skip(symbol, name, SKIP_BUYS_PAUSED));
                continue;
            }
            turnover = turnover.add(d.desiredAmount());
            candidates.add(d.candidate());
        }
        if (sendable != null) {
            candidates.removeIf(c -> !sendable.contains(c.symbol()));
        }
        List<Order> orders = limit(order(candidates, rules.cashLike()), account, reservedBuy, rules, skipped);
        return new Plan(orders, skipped, turnover, equity);
    }

    /**
     * 이상 멈춤 판정에 쓰는 회전율(ADR 0033 결정 3, QA-302) — {@code plan}({@link #sync}를 같은 비중·계좌·{@code blocked}·규칙·임계값으로 부른 계획,
     * 범위 없음)의 회전율 금액에서 대기 STOP 종목의 <b>매도</b> 몫과, 현금성 종목의 <b>매수</b> 몫 가운데 스탑 대금(그 스탑 매도 금액 +
     * {@code stopProceeds})까지를 뺀 계획을 돌려줍니다. 스탑 매도는 손절이라 회전율 멈춤의 대상이 아니고(멈추면 같은 주기의 스탑 매도 경로까지 서서 손절이
     * 사라짐), 책이 그 대금으로 사는 현금성(규칙 계좌의 남는 현금 몫)도 같은 몫으로 봅니다 — 스탑 대금보다 많은 현금성 매수와 스탑이 아닌 종목의 매매는
     * 그대로 셉니다. 종목마다의 차이 금액은 다른 종목과 상관없으므로 {@link #sync}를 그 종목 하나의 범위로 다시 불러 셉니다. 주문·건너뜀은 바꾸지 않고,
     * 스탑 종목이 없으면 {@code plan} 그대로입니다.
     *
     * @param stopProceeds 계획 밖의 스탑 대금 — 오늘 스탑 매도 경로가 묶음보다 먼저 보낸 스탑 종목 매도(진행 중이면 이 기능 주문 진행 중이라, 끝났으면
     *                     보유에서 빠져 계획의 회전율에 없음). null이면 0.
     */
    static Plan withoutStops(Plan plan, Map<String, Double> weightPct, Account account, Set<String> blocked, Rules rules, boolean threshold,
                             Set<String> stopSymbols, BigDecimal stopProceeds) {
        if (stopSymbols == null || stopSymbols.isEmpty()) {
            return plan;
        }
        BigDecimal stopSells = BigDecimal.ZERO;
        BigDecimal cashBuys = BigDecimal.ZERO;
        Set<String> symbols = new TreeSet<>(stopSymbols);
        symbols.addAll(rules.cashLike());
        for (String symbol : symbols) {
            BigDecimal amount = sync(weightPct, plan.equity(), account, blocked, BigDecimal.ZERO, rules, threshold, Set.of(symbol), null)
                    .turnoverAmount();
            if (amount.signum() <= 0) {
                continue;
            }
            boolean buy = buys(symbol, weightPct.get(symbol), plan.equity(), account);
            if (!buy && stopSymbols.contains(symbol)) {
                stopSells = stopSells.add(amount);
            } else if (buy && rules.cashLike().contains(symbol)) {
                cashBuys = cashBuys.add(amount);
            }
        }
        BigDecimal funding = stopProceeds == null ? stopSells : stopSells.add(stopProceeds.max(BigDecimal.ZERO));
        BigDecimal counted = plan.turnoverAmount().subtract(stopSells).subtract(cashBuys.min(funding)).max(BigDecimal.ZERO);
        return new Plan(plan.orders(), plan.skipped(), counted, plan.equity());
    }

    /** {@link #sync}가 그 종목을 사는 쪽으로 정하는가(차이가 양수 — 회전율에 들어간 종목만 부르므로 차이는 1주 이상 벌어져 있음). */
    private static boolean buys(String symbol, Double weightPct, BigDecimal equity, Account account) {
        BigDecimal price = account.price(symbol);
        BigDecimal target = weightPct != null && price != null ? targetQuantity(weightPct, equity, price) : BigDecimal.ZERO;
        return difference(target, account.held(symbol), account.pendingOf(symbol)).signum() > 0;
    }

    /** 차이 = 목표 − 보유 − 미체결 매수 + 미체결 매도(명세 §2). */
    private static BigDecimal difference(BigDecimal target, BigDecimal held, Pending pending) {
        return target.subtract(held).subtract(pending.buy()).add(pending.sell());
    }

    /**
     * 매도 가능 수량을 물어야 할 종목 — 계획의 매도 주문과 매도 가능 수량을 몰라 건너뛴 종목. 정기 작업은 먼저 매도 가능 수량 없이 계획한 뒤(정수 보유로 어림)
     * 이 종목만 다시 물어 매도 수량을 자릅니다(수집기 사전 조회 시간 예산 — 명세 §5.2).
     */
    static Set<String> sellSymbols(Plan plan) {
        Set<String> out = new TreeSet<>();
        plan.orders().stream().filter(o -> SELL.equals(o.side())).forEach(o -> out.add(o.symbol()));
        plan.skipped().stream().filter(s -> SKIP_SELLABLE.equals(s.reason()) && s.symbol() != null).forEach(s -> out.add(s.symbol()));
        return out;
    }

    // ------------------------------------------------------------------ 장중 따라 하기
    /**
     * 장중 따라 하기(명세 §3.2) — 그 주문 뒤 예상 비중 {@code weightPct}(w*)로 목표 수량을 구해 <b>원 주문 방향으로만</b> 보냅니다(매수 주문이면 차이가
     * 1주 이상 모자랄 때만 매수, 매도 주문이면 1주 이상 넘칠 때만 매도 — w* = 0인 매도는 정수 보유 전량). 1% 조건은 없습니다. 보낼 것이 없으면 주문이
     * 빈 계획입니다.
     */
    static Plan mirror(String symbol, String paperSide, double weightPct, BigDecimal equity, Account account, Set<String> blocked,
                       BigDecimal reservedBuy, Rules rules) {
        List<Skip> skipped = new ArrayList<>();
        String name = account.name(symbol);
        if (symbol == null || !KR_SYMBOL.matcher(symbol).matches()) {
            skipped.add(new Skip(symbol, name, SKIP_SYMBOL));
            return new Plan(List.of(), skipped, BigDecimal.ZERO, equity);
        }
        if (!Double.isFinite(weightPct) || weightPct < 0) {
            skipped.add(new Skip(symbol, name, SKIP_WEIGHT));
            return new Plan(List.of(), skipped, BigDecimal.ZERO, equity);
        }
        BigDecimal price = account.price(symbol);
        if (price == null) {
            skipped.add(new Skip(symbol, name, SKIP_PRICE));
            return new Plan(List.of(), skipped, BigDecimal.ZERO, equity);
        }
        BigDecimal target = targetQuantity(weightPct, equity, price);
        Decision d = decide(symbol, name, target, account.held(symbol), price, account, blocked, paperSide, skipped);
        if (d == null) {
            return new Plan(List.of(), skipped, BigDecimal.ZERO, equity);
        }
        if (d.buy() && rules.buysPaused()) {
            skipped.add(new Skip(symbol, name, SKIP_BUYS_PAUSED));
            return new Plan(List.of(), skipped, BigDecimal.ZERO, equity);
        }
        List<Order> orders = limit(List.of(d.candidate()), account, reservedBuy, rules, skipped);
        return new Plan(orders, skipped, d.desiredAmount(), equity);
    }

    /** 목표 수량 floor(비중% × E ÷ 기준가). */
    static BigDecimal targetQuantity(double weightPct, BigDecimal equity, BigDecimal price) {
        if (equity.signum() <= 0 || weightPct <= 0) {
            return BigDecimal.ZERO;
        }
        return BigDecimal.valueOf(weightPct).multiply(equity).divide(HUNDRED.multiply(price), 8, RoundingMode.DOWN)
                .setScale(0, RoundingMode.FLOOR);
    }

    /** 방향과 수량이 정해진 후보(현금·1건 상한 적용 전). */
    private record Candidate(String symbol, String name, String side, BigDecimal quantity, BigDecimal price) {
    }

    private record Decision(Candidate candidate, BigDecimal desiredAmount) {

        boolean buy() {
            return BUY.equals(candidate.side());
        }
    }

    /**
     * 한 종목의 방향·수량(명세 §2) — 차이 = 목표 − 보유 − 미체결 매수 + 미체결 매도. 1주 미만이면 null. 목표가 0(전량 매도)인데 소수 보유가 남으면 표시합니다. {@code onlySide}가 있으면
     * 그 방향일 때만(장중 따라 하기). 이 기능의 미종료 주문·반대 방향 미체결·잔량 모름은 건너뜀. 매도는 정수 보유·매도 가능 수량까지.
     */
    private static Decision decide(String symbol, String name, BigDecimal target, BigDecimal held, BigDecimal price, Account account,
                                   Set<String> blocked, String onlySide, List<Skip> skipped) {
        Pending pending = account.pendingOf(symbol);
        boolean fractional = held.signum() > 0 && held.stripTrailingZeros().scale() > 0;
        if (pending.unknown()) {
            skipped.add(new Skip(symbol, name, SKIP_PENDING_UNKNOWN));
            return null;
        }
        BigDecimal diff = difference(target, held, pending);
        String side = diff.compareTo(ONE) >= 0 ? BUY : diff.compareTo(ONE.negate()) <= 0 ? SELL : null;
        if (side == null) {
            if (fractional && target.signum() == 0 && (onlySide == null || SELL.equals(onlySide))) {
                skipped.add(new Skip(symbol, name, SKIP_FRACTION));
            }
            return null;
        }
        if (onlySide != null && !onlySide.equals(side)) {
            return null;
        }
        if (blocked.contains(symbol)) {
            skipped.add(new Skip(symbol, name, SKIP_OWN));
            return null;
        }
        if ((BUY.equals(side) && pending.sell().signum() > 0) || (SELL.equals(side) && pending.buy().signum() > 0)) {
            skipped.add(new Skip(symbol, name, SKIP_OPPOSITE));
            return null;
        }
        BigDecimal quantity = diff.abs().setScale(0, RoundingMode.FLOOR);
        BigDecimal desired = quantity.multiply(price);
        if (SELL.equals(side)) {
            BigDecimal wholeHeld = held.setScale(0, RoundingMode.FLOOR);
            BigDecimal cap = wholeHeld;
            BigDecimal sellable = account.sellable().get(symbol);
            if (sellable != null) {
                cap = cap.min(sellable.setScale(0, RoundingMode.FLOOR));
            }
            if (fractional && target.signum() == 0) {
                skipped.add(new Skip(symbol, name, SKIP_FRACTION));
            }
            if (cap.signum() <= 0) {
                if (!(fractional && target.signum() == 0 && wholeHeld.signum() == 0)) {
                    skipped.add(new Skip(symbol, name, SKIP_NOT_SELLABLE));
                }
                return null;
            }
            quantity = quantity.min(cap);
        }
        return new Decision(new Candidate(symbol, name, side, quantity, price), desired);
    }

    /** 한 창 안 순서(명세 §3) — 매도(현금성 먼저) → 매수(현금성 마지막), 같은 무리는 종목 코드 순. */
    private static List<Candidate> order(List<Candidate> candidates, Set<String> cashLike) {
        List<Candidate> out = new ArrayList<>(candidates);
        out.sort(Comparator.comparingInt((Candidate c) -> rank(c, cashLike)).thenComparing(Candidate::symbol));
        return out;
    }

    private static int rank(Candidate c, Set<String> cashLike) {
        boolean cash = cashLike.contains(c.symbol());
        if (SELL.equals(c.side())) {
            return cash ? 0 : 1;
        }
        return cash ? 3 : 2;
    }

    /**
     * 현금·1건 상한·매도 가능 수량(모를 때)·하루 한도를 차례로 적용합니다. 매수는 상한가 × 수량이 남은 매수 가능 금액 안이어야 하고(모자라면 줄이고, 1주도
     * 안 되면 미룸), 1건 금액(매수 = 상한가 × 수량, 매도 = 현재가 × 수량 — 수집기 검사와 같은 기준, 매도는 가격 여유 {@link #SELL_PRICE_MARGIN})이 1건
     * 상한을 넘으면 상한까지만(쪼개지 않음). 하루 한도가 있으면 남은 건수만큼만 보내고, 매수의 상한가 × 수량은 남은 하루 매수 금액 안으로 줄입니다(1주도 안
     * 되거나 건수가 없으면 {@value #SKIP_DAILY_CAP}).
     */
    private static List<Order> limit(List<Candidate> candidates, Account account, BigDecimal reservedBuy, Rules rules, List<Skip> skipped) {
        List<Order> out = new ArrayList<>();
        BigDecimal reserved = reservedBuy == null ? BigDecimal.ZERO : reservedBuy;
        Integer ordersLeft = rules.remainingOrders();
        BigDecimal buyLeft = rules.remainingBuyKrw();
        for (Candidate c : candidates) {
            if (ordersLeft != null && ordersLeft <= 0) {
                skipped.add(new Skip(c.symbol(), c.name(), SKIP_DAILY_CAP));
                continue;
            }
            BigDecimal quantity = c.quantity();
            boolean capped = false;
            if (SELL.equals(c.side())) {
                if (rules.requireSellable() && !account.sellable().containsKey(c.symbol())) {
                    skipped.add(new Skip(c.symbol(), c.name(), SKIP_SELLABLE));
                    continue;
                }
                BigDecimal maxByOrder = maxQuantity(rules.maxOrderKrw(), c.price().multiply(SELL_PRICE_MARGIN));
                if (maxByOrder != null && quantity.compareTo(maxByOrder) > 0) {
                    quantity = maxByOrder;
                    capped = true;
                }
                if (quantity.signum() <= 0) {
                    skipped.add(new Skip(c.symbol(), c.name(), SKIP_CAPPED));
                    continue;
                }
                if (capped) {
                    skipped.add(new Skip(c.symbol(), c.name(), SKIP_CAPPED));
                }
                out.add(new Order(c.symbol(), c.name(), SELL, clamp(quantity), c.price(), BigDecimal.ZERO, capped));
                if (ordersLeft != null) {
                    ordersLeft--;
                }
                continue;
            }
            BigDecimal upper = account.upper(c.symbol());
            if (upper == null) {
                skipped.add(new Skip(c.symbol(), c.name(), SKIP_PRICE));
                continue;
            }
            BigDecimal maxByOrder = maxQuantity(rules.maxOrderKrw(), upper);
            if (maxByOrder != null && quantity.compareTo(maxByOrder) > 0) {
                quantity = maxByOrder;
                capped = true;
            }
            if (quantity.signum() <= 0) {
                skipped.add(new Skip(c.symbol(), c.name(), SKIP_CAPPED));
                continue;
            }
            BigDecimal available = account.cash().subtract(reserved);
            BigDecimal maxByCash = available.signum() <= 0 ? BigDecimal.ZERO
                    : available.divide(upper, 0, RoundingMode.FLOOR);
            if (quantity.compareTo(maxByCash) > 0) {
                quantity = maxByCash;
            }
            if (quantity.signum() <= 0) {
                skipped.add(new Skip(c.symbol(), c.name(), SKIP_DEFERRED_CASH));
                continue;
            }
            if (buyLeft != null) {
                BigDecimal maxByDaily = buyLeft.signum() <= 0 ? BigDecimal.ZERO : buyLeft.divide(upper, 0, RoundingMode.FLOOR);
                if (quantity.compareTo(maxByDaily) > 0) {
                    quantity = maxByDaily;
                    skipped.add(new Skip(c.symbol(), c.name(), SKIP_DAILY_CAP));
                }
                if (quantity.signum() <= 0) {
                    continue;
                }
            }
            if (capped) {
                skipped.add(new Skip(c.symbol(), c.name(), SKIP_CAPPED));
            }
            int q = clamp(quantity);
            BigDecimal reserve = upper.multiply(BigDecimal.valueOf(q));
            reserved = reserved.add(reserve);
            out.add(new Order(c.symbol(), c.name(), BUY, q, c.price(), reserve, capped));
            if (buyLeft != null) {
                buyLeft = buyLeft.subtract(reserve);
            }
            if (ordersLeft != null) {
                ordersLeft--;
            }
        }
        return out;
    }

    /** 1건 상한 안의 최대 수량(상한이 없으면 null). */
    private static BigDecimal maxQuantity(BigDecimal maxOrderKrw, BigDecimal unitPrice) {
        if (maxOrderKrw == null || unitPrice == null || unitPrice.signum() <= 0) {
            return null;
        }
        return maxOrderKrw.divide(unitPrice, 0, RoundingMode.FLOOR);
    }

    private static int clamp(BigDecimal quantity) {
        return quantity.compareTo(BigDecimal.valueOf(MAX_QUANTITY)) > 0 ? MAX_QUANTITY : quantity.intValueExact();
    }

    private static boolean positive(BigDecimal value) {
        return value != null && value.signum() > 0;
    }

    // ------------------------------------------------------------------ 계좌 옮기기
    /**
     * 수집기 사전 조회 + 토스 미체결 목록 → 계획 입력. 미체결 잔량은 수량 − 체결 수량이고(체결 수량이 없으면 0), 수량을 모르는 주문이 있으면 그 종목을
     * 잔량 모름으로 둡니다. 방향을 모르는 주문도 잔량 모름입니다.
     */
    static Account account(CollectorTradeClient.Preflight preflight, Collection<CollectorTradeClient.BrokerOrder> openOrders) {
        Map<String, Position> positions = new LinkedHashMap<>();
        for (CollectorTradeClient.Holding h : preflight.holdings()) {
            Position previous = positions.get(h.symbol());
            BigDecimal quantity = h.quantity() == null ? BigDecimal.ZERO : h.quantity();
            if (previous != null) {
                quantity = quantity.add(previous.quantity());
            }
            positions.put(h.symbol(), new Position(h.symbol(), h.name(), quantity, h.lastPrice()));
        }
        Map<String, Quote> quotes = new HashMap<>();
        preflight.quotes().forEach((symbol, q) -> quotes.put(symbol, new Quote(q.lastPrice(), q.upperLimitPrice())));
        Map<String, BigDecimal> buy = new HashMap<>();
        Map<String, BigDecimal> sell = new HashMap<>();
        Set<String> unknown = new TreeSet<>();
        for (CollectorTradeClient.BrokerOrder o : openOrders) {
            if (o.symbol() == null) {
                continue;
            }
            BigDecimal remaining = o.quantity() == null ? null
                    : o.quantity().subtract(o.filledQuantity() == null ? BigDecimal.ZERO : o.filledQuantity());
            if (remaining == null || (!BUY.equals(o.side()) && !SELL.equals(o.side()))) {
                unknown.add(o.symbol());
                continue;
            }
            if (remaining.signum() <= 0) {
                continue;
            }
            (BUY.equals(o.side()) ? buy : sell).merge(o.symbol(), remaining, BigDecimal::add);
        }
        Map<String, Pending> pending = new HashMap<>();
        Set<String> touched = new TreeSet<>(buy.keySet());
        touched.addAll(sell.keySet());
        touched.addAll(unknown);
        for (String symbol : touched) {
            pending.put(symbol, new Pending(buy.getOrDefault(symbol, BigDecimal.ZERO), sell.getOrDefault(symbol, BigDecimal.ZERO),
                    unknown.contains(symbol)));
        }
        return new Account(preflight.cashBuyingPowerKrw(), positions, quotes, preflight.sellable(), pending);
    }

    // ------------------------------------------------------------------ 하루 한도
    /** 오늘 쓴 수집기 하루 한도 — 국내 주문 수와 매수 금액 합. */
    record DailyUsage(int orders, BigDecimal buyKrw) {
    }

    /**
     * 수집기 하루 한도 검사(collector toss_trade._today_usage)와 같은 식 — 오늘 국내(KRW) 주문(토스 진행 중 + 끝남, 앱 주문 포함)의 수와, 매도가 아닌 주문
     * (방향을 모르면 매수로 셈)의 체결 금액(없으면 체결 수량 × 평균 체결가) + 진행 중이면 남은 수량 × 상한가. 진행 중인지는 토스 미체결 목록에 같은 주문
     * 번호가 있는가로 봅니다. 읽을 수 없는 값(체결 수량·평균 체결가·수량·상한가)이 하나라도 있으면 empty — 수집기도 그때는 보내지 않습니다.
     *
     * @param upper 종목 → 상한가(모르면 null) — {@link #dailyUpperSymbols}의 종목이 필요합니다
     */
    static Optional<DailyUsage> dailyUsage(Collection<CollectorTradeClient.BrokerOrder> today, Set<String> openOrderIds,
                                           Function<String, BigDecimal> upper) {
        int count = 0;
        BigDecimal bought = BigDecimal.ZERO;
        for (CollectorTradeClient.BrokerOrder o : today) {
            if (!"KRW".equals(o.currency())) {
                continue;
            }
            count++;
            if (SELL.equals(o.side())) {
                continue;
            }
            BigDecimal filled = filledAmount(o);
            if (filled == null) {
                return Optional.empty();
            }
            bought = bought.add(filled);
            if (!openOrderIds.contains(o.orderId())) {
                continue;
            }
            if (o.quantity() == null || o.filledQuantity() == null) {
                return Optional.empty();
            }
            BigDecimal remaining = o.quantity().subtract(o.filledQuantity());
            if (remaining.signum() <= 0) {
                continue;
            }
            BigDecimal unit = o.symbol() == null ? null : upper.apply(o.symbol());
            if (!positive(unit)) {
                return Optional.empty();
            }
            bought = bought.add(remaining.multiply(unit));
        }
        return Optional.of(new DailyUsage(count, bought));
    }

    // ------------------------------------------------------------------ 미체결 매수가 잡은 금액(손실 한도의 기준 — RT3-BE-4)
    /** 미체결 목록에서 매수 가능 금액을 잡는 주문(국내 KRW이고 매도가 아님 — 방향을 모르면 매수로 셈, {@link #dailyUsage}와 같음)인가. */
    private static boolean holdsBuyingPower(CollectorTradeClient.BrokerOrder o) {
        return "KRW".equals(o.currency()) && !SELL.equals(o.side());
    }

    /** {@link #openBuyHold}가 상한가를 알아야 하는 종목 — 토스 미체결 목록(앱 주문 포함)의 매수 종목. */
    static Set<String> openBuySymbols(Collection<CollectorTradeClient.BrokerOrder> open) {
        Set<String> out = new TreeSet<>();
        for (CollectorTradeClient.BrokerOrder o : open) {
            if (holdsBuyingPower(o) && o.symbol() != null) {
                out.add(o.symbol());
            }
        }
        return out;
    }

    /**
     * 토스 미체결 목록(앱 주문 포함)의 매수가 잡은 금액 — Σ (수량 − 체결 수량) × 상한가. 손실 판정의 '지금 값'이 이 기능의 미체결 매수에 되돌리는 금액과
     * 같은 식이며(명세 §12.5), 켜기·기준 다시 잡기의 기준 총액 U0에 더합니다. 남은 수량이 0 이하인 주문은 건너뛰고, 수량·종목·상한가를 모르는 매수가
     * 있으면 empty(기준을 정하지 않음).
     *
     * @param upper 종목 → 상한가(모르면 null) — {@link #openBuySymbols}의 종목이 필요합니다
     */
    static Optional<BigDecimal> openBuyHold(Collection<CollectorTradeClient.BrokerOrder> open, Function<String, BigDecimal> upper) {
        BigDecimal held = BigDecimal.ZERO;
        for (CollectorTradeClient.BrokerOrder o : open) {
            if (!holdsBuyingPower(o)) {
                continue;
            }
            if (o.quantity() == null) {
                return Optional.empty();
            }
            BigDecimal remaining = o.quantity().subtract(o.filledQuantity() == null ? BigDecimal.ZERO : o.filledQuantity());
            if (remaining.signum() <= 0) {
                continue;
            }
            BigDecimal unit = o.symbol() == null ? null : upper.apply(o.symbol());
            if (!positive(unit)) {
                return Optional.empty();
            }
            held = held.add(remaining.multiply(unit));
        }
        return Optional.of(held);
    }

    /** {@link #dailyUsage}가 상한가를 알아야 하는 종목 — 오늘 국내 주문 가운데 진행 중인 매수(방향 모름 포함)의 종목. */
    static Set<String> dailyUpperSymbols(Collection<CollectorTradeClient.BrokerOrder> today, Set<String> openOrderIds) {
        Set<String> out = new TreeSet<>();
        for (CollectorTradeClient.BrokerOrder o : today) {
            if ("KRW".equals(o.currency()) && !SELL.equals(o.side()) && openOrderIds.contains(o.orderId()) && o.symbol() != null) {
                out.add(o.symbol());
            }
        }
        return out;
    }

    /** 체결 금액 — 토스 체결 금액, 없으면 체결 수량 × 평균 체결가(체결 수량 0이면 0). 모르면 null. */
    private static BigDecimal filledAmount(CollectorTradeClient.BrokerOrder o) {
        if (o.filledAmount() != null) {
            return o.filledAmount();
        }
        if (o.filledQuantity() == null) {
            return null;
        }
        if (o.filledQuantity().signum() == 0) {
            return BigDecimal.ZERO;
        }
        return o.averageFilledPrice() == null ? null : o.filledQuantity().multiply(o.averageFilledPrice());
    }

    // ------------------------------------------------------------------ 창
    /** 창 하나 — [start, end] 양끝 포함. */
    record Window(String kind, Instant start, Instant end) {

        boolean contains(Instant now) {
            return !now.isBefore(start) && !now.isAfter(end);
        }
    }

    /**
     * 그날 창(명세 §3 표, 토스 장 운영 정보로). 단일가 시각이 없으면 그 경로는 null(시가 맞추기 — 프리마켓 단일가 시작, 장중·종가 — 종가 단일가 시작).
     * {@code intraday}는 장중 따라 하기가 쓸 수 있는 전체 범위([정규장 시작 + 30초, 종가 단일가 시작 − 30초]). {@code syncAt}이 있으면 시각 맞추기 날
     * (ADR 0033 결정 1)이라 {@code sync}가 null이고 {@code followup}이 시각 맞추기 창({@value #WINDOW_SYNC_AT})입니다.
     */
    record Day(LocalDate date, Window sync, Window followup, Window intraday, Window close, Instant regularStart,
               Instant closingAuctionStart, Instant regularEnd, Instant syncAt) {

        /** 화면에 보이는 창 목록(없는 경로는 뺌). */
        List<Window> list() {
            List<Window> out = new ArrayList<>();
            for (Window w : new Window[]{sync, followup, intraday, close}) {
                if (w != null) {
                    out.add(w);
                }
            }
            return out;
        }

        /** 시각 맞추기 창의 끝을 {@code end}까지 늘린 그날 창(장중 끝을 넘지 않음). 시각 맞추기 날이 아니거나 이미 그보다 길면 그대로. */
        Day withTimedSyncUntil(Instant end) {
            Instant capped = intraday != null && end.isAfter(intraday.end()) ? intraday.end() : end;
            if (syncAt == null || !capped.isAfter(followup.end())) {
                return this;
            }
            return new Day(date, sync, new Window(followup.kind(), followup.start(), capped), intraday, close, regularStart, closingAuctionStart,
                    regularEnd, syncAt);
        }

        /** 그날 첫 창의 시작(시가 맞추기, 없으면 마무리). */
        Instant firstStart() {
            return sync != null ? sync.start() : followup.start();
        }
    }

    /** 토스 장 운영 정보 → 그날 창(시가 맞추기 날). 정규장이 없으면(휴장) null. */
    static Day windows(LocalDate date, CollectorTradeClient.Session session) {
        return windows(date, session, null);
    }

    /**
     * 토스 장 운영 정보 → 그날 창. {@code syncAt}(모의 공개 창의 일일 맞추기 시각 — ADR 0033 결정 1)이 있으면 시가 단일가 맞추기 창 없이 마무리 창
     * 자리에 시각 맞추기 창 [max(T, 정규장 시작 + 30초), min(T + {@link #TIMED_SYNC_LENGTH}, 장중 끝)]을 둡니다 — 그 창이 비면(T가 장중 끝 뒤) 시가
     * 맞추기 날로 셉니다(되돌리기용으로 남긴 경로). null이면 지금과 같습니다. 정규장이 없으면(휴장) null.
     */
    static Day windows(LocalDate date, CollectorTradeClient.Session session, Instant syncAt) {
        if (session == null || session.regular() == null) {
            return null;
        }
        CollectorTradeClient.Regular regular = session.regular();
        CollectorTradeClient.PreMarket pre = session.preMarket();
        Window sync = null;
        if (pre != null && pre.auctionStart() != null) {
            sync = window(WINDOW_SYNC, pre.auctionStart().plus(SYNC_OPEN_AFTER), pre.end().minus(SYNC_CLOSE_BEFORE));
        }
        Window followup = window(WINDOW_FOLLOWUP, regular.start().plus(FOLLOWUP_OPEN_AFTER), regular.start().plus(FOLLOWUP_LENGTH));
        Window intraday = null;
        Window close = null;
        Instant auction = regular.closingAuctionStart();
        if (auction != null) {
            intraday = window(WINDOW_MIRROR, regular.start().plus(FOLLOWUP_OPEN_AFTER), auction.minus(MIRROR_CLOSE_BEFORE));
            close = window(WINDOW_CLOSE, auction.plus(CLOSE_OPEN_AFTER), regular.end().minus(CLOSE_CLOSE_BEFORE));
        }
        if (syncAt != null) {
            Instant earliest = regular.start().plus(FOLLOWUP_OPEN_AFTER);
            Instant start = syncAt.isBefore(earliest) ? earliest : syncAt;
            Instant until = start.plus(TIMED_SYNC_LENGTH);
            Instant last = intraday != null ? intraday.end() : regular.end().minus(CLOSE_CLOSE_BEFORE);
            Window timed = window(WINDOW_SYNC_AT, start, until.isBefore(last) ? until : last);
            if (timed != null) {
                return new Day(date, null, timed, intraday, close, regular.start(), auction, regular.end(), syncAt);
            }
        }
        return new Day(date, sync, followup, intraday, close, regular.start(), auction, regular.end(), null);
    }

    /** 지수 등락률로 추정한 서킷브레이커 단계(0 = 아님) — 토스에 시장 정지 표시가 없음. 시장이 달라도 가장 높은 단계. */
    static int circuitStage(Map<String, BigDecimal> indexChangePct) {
        int stage = 0;
        for (BigDecimal change : indexChangePct.values()) {
            for (int i = CIRCUIT_STAGES.length; i > stage; i--) {
                if (change != null && change.compareTo(CIRCUIT_STAGES[i - 1]) <= 0) {
                    stage = i;
                    break;
                }
            }
        }
        return stage;
    }

    private static Window window(String kind, Instant start, Instant end) {
        return start.isBefore(end) ? new Window(kind, start, end) : null;
    }

    /**
     * 스탑 매도 하나의 창(ADR 0033 결정 2) — 종가 STOP은 그날 종가 창, 그 밖은 시작 = max(따라 할 시각, 장중 시작, 정규장 시작 +
     * {@link SessionWindows#OPEN_OFFSET}), 끝 = min(시작 + 3분, 장중 끝). 모의 쪽이 개장 10분 전 시각의 STOP을 내더라도 실제로는 개장 10분 전에 팔지 않게
     * 하는 방어입니다(사용자 결정 2026-11-06 — 개장 10분 전에는 팔지 않음). 경로가 없거나 창이 비면 null(놓침).
     */
    static Window stopWindow(Day day, Instant mirrorAt, boolean nextClose) {
        if (nextClose) {
            return day.close();
        }
        Window intraday = day.intraday();
        if (intraday == null || mirrorAt == null) {
            return null;
        }
        Instant start = mirrorAt.isAfter(intraday.start()) ? mirrorAt : intraday.start();
        Instant earliest = day.regularStart().plus(SessionWindows.OPEN_OFFSET);
        if (start.isBefore(earliest)) {
            start = earliest;
        }
        Instant until = start.plus(MIRROR_LENGTH);
        Instant end = until.isBefore(intraday.end()) ? until : intraday.end();
        return start.isAfter(end) ? null : new Window(WINDOW_MIRROR, start, end);
    }

    /**
     * 장중 주문 하나의 창 — 종가는 그날 종가 창, 그 밖은 [max(따라 할 시각, 장중 시작), min(따라 할 시각 + 3분, 장중 끝)]. 경로가 없거나 창이 비면 null
     * (놓침).
     */
    static Window mirrorWindow(Day day, Instant mirrorAt, boolean nextClose) {
        if (nextClose) {
            return day.close();
        }
        Window intraday = day.intraday();
        if (intraday == null || mirrorAt == null) {
            return null;
        }
        Instant start = mirrorAt.isAfter(intraday.start()) ? mirrorAt : intraday.start();
        Instant until = mirrorAt.plus(MIRROR_LENGTH);
        Instant end = until.isBefore(intraday.end()) ? until : intraday.end();
        return start.isAfter(end) ? null : new Window(WINDOW_MIRROR, start, end);
    }

    /**
     * 그날을 쉬는가(명세 §3) — 휴장, 토스 날짜가 오늘이 아님, 모의 달력을 모름, 토스 정규장 시작·끝이 모의 달력과 다름(예: 수능일 10:00~16:30인데 모의
     * 장 시간 변경 설정이 없음), 시계 차이를 모르거나 5초 넘게 어긋남, 모의 장부가 전 거래일을 반영하지 않음. 쉬지 않으면 null.
     */
    static String skipReason(LocalDate today, CollectorTradeClient.Calendar calendar, Optional<PaperMirrorService.SessionHours> paper,
                             boolean ledgerCaughtUp) {
        if (calendar.today() == null || calendar.today().regular() == null) {
            return SKIP_MARKET_CLOSED;
        }
        if (!today.equals(calendar.date())) {
            return SKIP_CALENDAR_DATE;
        }
        if (paper.isEmpty()) {
            return SKIP_PAPER_CALENDAR;
        }
        PaperMirrorService.SessionHours hours = paper.get();
        CollectorTradeClient.Regular regular = calendar.today().regular();
        if (!hours.tradingDay() || !regular.start().equals(hours.open()) || !regular.end().equals(hours.close())) {
            return SKIP_HOURS;
        }
        if (calendar.skewSeconds() == null) {
            return SKIP_CLOCK_UNKNOWN;
        }
        if (Math.abs(calendar.skewSeconds()) > MAX_SKEW_SECONDS) {
            return SKIP_CLOCK;
        }
        if (!ledgerCaughtUp) {
            return SKIP_LEDGER;
        }
        return null;
    }

    /** 종가 주문 체결 시각이 정규장 끝 ± 2분 안인가(명세 §10). 시각을 모르면 거짓. */
    static boolean closeFillOk(Instant filledAt, Instant regularEnd) {
        if (filledAt == null || regularEnd == null) {
            return false;
        }
        return Duration.between(regularEnd, filledAt).abs().compareTo(CLOSE_FILL_TOLERANCE) <= 0;
    }
}
