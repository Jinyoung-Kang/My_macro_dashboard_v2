package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.FillConfirmation;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.UnconfirmedFill;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 🧪 한국 금융위 확정 조정(2단계 명세 §4-1 '확정가'·K29, ADR 0021 결정 3 — C3). 장부({@code PaperLedgerService})가 확정 조정 시장
 * ({@link PaperMarket#confirmsFills})의 책마다 한 트랜잭션 안에서 부릅니다 — 관측치를 처리하기 전에, 그리고 리스크 점검이 새 관측치가 없는 주기에도.
 *
 * <p><b>체결마다 한 행</b>: 확정 조정 행이 아직 없는 체결({@link PaperStore#unconfirmedFills})마다 그 체결일 D의 금융위 행을 봅니다 — 주식은
 * 주식시세({@code fsc_price}), ETF(설정 현금성 ∪ 벤치마크 종목)는 증권상품시세({@code fsc_etf_price}). 확정가는 시가 체결({@code NEXT_OPEN} —
 * {@code STOP} 포함)이면 그날 시가({@code mkp}), 종가 체결({@code NEXT_CLOSE})이면 그날 종가(거래량 &gt; 0 행만 — 거래 없던 날의 종가는 전날 값이라
 * 체결가가 아님, 명세 §4-15 'B2 구현에서 정한 것')입니다. 금융위 값이 들어오면 <b>언제나</b> 확정합니다(잠정가와 같아도 — 현금 차이 0인 행).
 * 체결 행은 고치지 않고 {@code paper_fill_confirmations}에 한 행을 더합니다:
 *
 * <ul>
 *   <li>비용 칸 = 같은 체결(방향·종목 구분·체결일·수량)을 확정가로 다시 계산한 수수료·세금·슬리피지({@link KrxCosts#fill}). 요율은 지금 설정이
 *       아니라 <b>그 체결 때 유효했던 설정 판</b>(결정 d7 — {@link PaperStore#settingsInForceAt}에 체결 행의 쓴 시각)입니다 — 그래서 요율 변경이
 *       현금 차이에 섞이지 않고, 새해 세율을 시행일에 저장한 뒤 지난해 매도를 확정해도 '세율 모름'이 되지 않습니다. 종목 구분은 그 판의 ETF 목록
 *       ({@link KrPaperMarket#etf}) → 체결일 금융위 행의 시장 구분입니다.</li>
 *   <li>{@code cash_delta} = 확정 기준 현금 흐름 − 잠정 기준 현금 흐름 — 잠정 쪽은 저장된 체결 칸(체결가 × 수량·{@code fee}·{@code tax}·
 *       {@code slippage_cost} — {@link KrxCosts#cashFlow})으로 다시 셉니다. 매수 10주 잠정 71,300 → 확정 71,200이면 +1,000, 코스피 매도 10주 잠정
 *       72,000 → 확정 72,100이면 +999(수수료 108·슬리피지 360·거래세 360·농특세 1,081 — 명세 §5).</li>
 *   <li>같은 트랜잭션에서 계좌 현금·순자산(상태)에 {@code cash_delta}를 더하고, 매수면 보유 평단을 <b>가격 차이만큼</b> 옮깁니다(결정 d14 — 평단은
 *       체결가로만, 비용은 비용 칸): 평단 += (확정가 − 잠정가) × min(체결 수량, 지금 수량) ÷ 지금 수량. 그 체결 뒤 같은 종목을 더 사거나 분할을
 *       반영했어도 원가 합이 그 체결 수량 × 가격 차이만큼 움직이고, 그 체결로 연 보유를 일부 판 뒤에도 남은 주식의 평단이 가격 차이만큼 움직입니다.
 *       보유가 그 체결 뒤에 새로 열렸거나(다 판 뒤 다시 삼) 없으면 평단을 옮기지 않습니다(현금 차이는 늘 반영). 매도는 평단을 바꾸지 않습니다
 *       (가중 평균 원가 — 매도는 평단 그대로).</li>
 *   <li><b>최고가 다시 계산</b>(명세 §4-2 'C2c 구현에서 정한 것'이 넘긴 자리): 그 체결이 연 보유(분할을 반영한 적 없음)면 최고가 = max(확정가,
 *       체결일부터의 금융위 확정 종가 — 거래량 &gt; 0 행)로 바꿉니다. 새 보유의 최고가 처음 값은 잠정 체결가라 시가 사다리를 내려간
 *       {@code TOSS_INTEGRATED}(NXT 08:00 프리마켓 첫 체결일 수 있음)면 KRX 기준가가 아니기 때문입니다 — 확정값 우선(K30).</li>
 * </ul>
 *
 * <p><b>멱등</b>: 행은 체결 번호가 기본키라 체결마다 한 번이고({@link PaperStore#insertFillConfirmationIfAbsent}), 현금·평단은 그 행을 새로 넣었을
 * 때만 같은 트랜잭션에서 움직입니다 — 재기동하거나 같은 확정을 두 번 돌려도 현금이 두 번 움직이지 않습니다.
 *
 * <p><b>확정하지 못하는 체결</b>(행을 쓰지 않고 다음 주기에 다시 봄): 금융위가 그날을 아직 내지 않음(데이터셋의 최신 기준일 &lt; 체결일 — 조용히
 * 기다림), 그날을 냈는데 그 종목 행이 없음(<b>'금융위 확정 미보정'</b> — ETF는 증권상품시세의 그날 행이 없을 때만, 작업 기록에 사유), 확정가 칸이
 * 비었음(거래 없던 날·시가 칸 전 저장본), 체결 때 설정 판을 이력에서 찾지 못함, 종목 구분을 모름. 확정되지 않은 체결이 남은 날의 순자산은
 * 확정({@code prices_final})이 되지 않습니다.
 *
 * <p><b>확정 순자산 줄</b>({@link #rewriteNav}): 체결을 확정한 뒤 그 책의 마지막 순자산 줄(거래일 D)을 금융위 D 종가로 다시 씁니다 — 장부 상태가 D
 * 마감일 때만(마지막 관측치의 세션 = D, D 뒤 체결 없음). 그날까지의 체결이 모두 확정되고 모든 보유가 금융위 D 종가로 평가되고 D 이하 봉으로 나중에
 * 체결될 수 있는 대기 주문이 없으면({@link #pendingThrough}) {@code prices_final = true}, 아니면 잠정(이번에 확정한 체결이 있으면 고친 현금으로 다시 씀).
 * 미처리 기업행위 보유는 묶인 평가 그대로라 그 줄은 잠정입니다.
 */
final class KrConfirmations {

    /** 평단 이동의 중간 자릿수(저장은 소수 4자리로 반올림 — {@link PaperLedger#round4}). */
    private static final int AVG_SCALE = 10;

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final Clock clock;

    KrConfirmations(PaperStore store, PaperMarketData marketData, Clock clock) {
        this.store = store;
        this.marketData = marketData;
        this.clock = clock;
    }

    /**
     * 책 하나의 확정 결과.
     *
     * @param confirmed    이번에 쓴 확정 조정 행 수
     * @param navFinalized 이번에 확정({@code prices_final = true})이 된 순자산 줄의 거래일(없으면 null)
     * @param notes        사람이 알아야 할 일(확정한 체결의 잠정 → 확정가·현금 차이, 확정하지 못한 사유, 순자산 줄)
     */
    record Result(int confirmed, LocalDate navFinalized, List<String> notes) {

        static final Result NOTHING = new Result(0, null, List.of());

        Result {
            notes = List.copyOf(notes);
        }

        boolean worked() {
            return confirmed > 0 || navFinalized != null;
        }
    }

    /**
     * 책 하나를 확정합니다(클래스 설명) — 부르는 쪽이 장부 잠금과 {@link PaperStore#atomically} 안에서 부릅니다. 체결을 확정한 뒤 그 책의 마지막
     * 순자산 줄을 금융위 종가로 다시 씁니다({@link #rewriteNav}).
     *
     * @param run 그 실행(시장 묶음·설정 판 — 확정 시세 읽기의 ETF 목록, 달력 — 장부 상태의 세션)
     */
    Result confirm(MarketRun run, Book book) {
        List<UnconfirmedFill> pending = store.unconfirmedFills(book.code());
        Optional<BookState> stateRow = store.state(book.code());
        if (stateRow.isEmpty()) {
            if (pending.isEmpty()) {
                return Result.NOTHING;
            }
            throw new IllegalStateException("계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요");
        }
        BookState state = stateRow.get();
        LocalDate navDay = state.lastNavTradingDate();
        Optional<NavRow> line = navDay == null ? Optional.empty() : store.navSeries(book.code()).stream()
                .filter(row -> navDay.equals(row.tradingDate())).findFirst();
        boolean lineOpen = line.isPresent() && !line.get().pricesFinal();
        if (pending.isEmpty() && !lineOpen) {
            return Result.NOTHING;   // 확정할 체결도, 확정을 기다리는 순자산 줄도 없음(5분마다 도는 길 — 시세를 읽지 않음)
        }
        Map<String, Position> positions = new TreeMap<>();
        store.positions(book.code()).forEach(position -> positions.put(position.ticker(), position));
        Set<String> codes = new TreeSet<>(positions.keySet());
        LocalDate from = navDay;
        for (UnconfirmedFill unconfirmed : pending) {
            codes.add(unconfirmed.fill().ticker());
            LocalDate day = unconfirmed.fill().observationDate();
            from = from == null || (day != null && day.isBefore(from)) ? day : from;
        }
        KrConfirmed fsc = run.confirmedPrices(marketData, codes, run.settings(), from);

        BigDecimal cash = BigDecimal.valueOf(state.cash());
        BigDecimal nav = BigDecimal.valueOf(state.nav());
        int confirmed = 0;
        List<String> notes = new ArrayList<>();
        List<UnconfirmedFill> left = new ArrayList<>();
        for (UnconfirmedFill unconfirmed : pending) {
            Optional<BigDecimal> delta = confirmFill(run, book, unconfirmed, fsc, positions, notes);
            if (delta.isPresent()) {
                cash = cash.add(delta.get());
                nav = nav.add(delta.get());
                confirmed++;
            } else {
                left.add(unconfirmed);
            }
        }
        double cashNow = PaperLedger.round4(cash.doubleValue());
        if (confirmed > 0) {
            double navNow = PaperLedger.round4(nav.doubleValue());
            double exposure = navNow > 0 ? PaperLedger.round4(state.equityValue() / navNow * 100) : state.exposurePct();
            store.upsertState(new BookState(state.bookCode(), cashNow, navNow, state.equityValue(), exposure,
                    state.lastObservedAt(), state.lastProcessedCollectedAt(), state.lastNavTradingDate(), null));
        }
        LocalDate finalized = null;
        if (line.isPresent() && (confirmed > 0 || lineOpen)) {
            finalized = rewriteNav(run, book, state, line.get(), cashNow, positions, left, fsc, confirmed > 0, notes);
        }
        return new Result(confirmed, finalized, notes);
    }

    /**
     * 그 책의 마지막 순자산 줄(거래일 D = 상태의 {@code last_nav_trading_date})을 금융위 종가로 다시 씁니다(명세 §4-1·K29 — '그날까지 모든 체결이
     * 확정되고 모든 보유가 확정 종가로 평가된 날만 {@code prices_final=true}, 그 전은 잠정, 확정 때 다시 씀').
     *
     * <p><b>장부 상태가 D 마감일 때만</b> 씁니다 — 줄을 다시 셀 수량·현금은 지금 상태뿐이라(지난날로 되감지 않음): 마지막으로 처리한 관측치의 세션이 D이고
     * D 뒤 체결이 없을 때. 금융위 D 값은 D+1 밤에 D+1 관측치보다 먼저 들어오므로(slow 순서, 장부는 관측치 처리 전에 확정 조정을 먼저 돎) 보통은 이
     * 조건이 맞습니다. 금융위가 D+1 관측치 처리보다 늦게 들어오면 D 줄은 잠정으로 남고 다음 줄이 확정됩니다(남은 위험 — 명세 §4-1 'C3 구현에서 정한 것').
     *
     * <p>평가: 보유마다 그 종목 금융위 D 행의 종가(거래가 없던 날이면 그 행의 종가 = KRX 공식 종가인 전날 값 — 평가 가격으로는 그대로 씀; 체결가가
     * 아닐 뿐), 행이 없으면 마지막 평가 가격(토스 — 그 줄은 잠정), <b>미처리 기업행위 보유는 묶인 평가 그대로</b>(금융위 최신 종가로 덮지 않음 — 그 줄은
     * 잠정, 명세 §4-2 'C2c 구현에서 정한 것'이 넘긴 자리). 현금은 확정 조정을 반영한 지금 현금. 확정 = 그날까지(체결일 ≤ D) 확정 안 된 체결이 없고 모든
     * 보유가 금융위 D 종가로 평가되고 D 이하 봉으로 나중에 체결될 수 있는 대기 주문이 없음({@link #pendingThrough}). 이번에 확정한 체결이 있으면 잠정이어도 다시 쓰고(고친 현금), 없으면 확정이 될 때만 씁니다. 확정 줄은 잠정 줄로
     * 덮이지 않습니다({@link PaperStore#upsertNav}).
     *
     * @return 이번에 확정이 된 줄의 거래일(아니면 null)
     */
    private LocalDate rewriteNav(MarketRun run, Book book, BookState state, NavRow line, double cash,
                                 Map<String, Position> positions, List<UnconfirmedFill> left, KrConfirmed fsc,
                                 boolean cashChanged, List<String> notes) {
        LocalDate day = line.tradingDate();
        String moved = stateMovedPast(run, book, state, day);
        if (moved != null) {
            if (cashChanged) {
                notes.add("순자산 " + day + " 줄은 다시 쓰지 않음 — " + moved + "(확정 현금은 상태에 반영, 그 줄은 잠정 그대로)");
            }
            return null;
        }
        Map<String, String> holds = new TreeMap<>();
        store.corpActionHolds(book.code()).forEach(hold -> holds.put(hold.ticker(), hold.reason()));
        Map<String, Integer> qty = new TreeMap<>();
        Map<String, Double> price = new TreeMap<>();
        List<String> provisional = new ArrayList<>();
        for (Position p : positions.values()) {
            qty.put(p.ticker(), p.qty());
            double valued = p.lastPrice() != null ? p.lastPrice() : p.avgCost();
            Optional<KrConfirmed.Day> row = fsc.of(p.ticker()).on(day);
            if (holds.containsKey(p.ticker())) {
                provisional.add(p.ticker() + " 미처리 기업행위 — 묶인 평가 " + won(BigDecimal.valueOf(valued)) + "원");
            } else if (row.isPresent() && row.get().close() != null) {
                valued = row.get().close().doubleValue();
            } else {
                provisional.add(p.ticker() + " 금융위 " + day + " 종가 없음 — 마지막 평가 가격 " + won(BigDecimal.valueOf(valued)) + "원");
            }
            price.put(p.ticker(), valued);
        }
        for (UnconfirmedFill unconfirmed : left) {
            LocalDate filled = unconfirmed.fill().observationDate();
            if (filled == null || !filled.isAfter(day)) {
                provisional.add("체결 " + unconfirmed.fill().id() + " " + unconfirmed.fill().ticker() + "(" + filled + ") 확정 전");
            }
        }
        provisional.addAll(pendingThrough(store, run, book.code(), day));
        boolean pricesFinal = provisional.isEmpty();
        if (!cashChanged && !pricesFinal) {
            return null;   // 고칠 현금도, 확정할 수도 없음 — 줄 그대로
        }
        PaperLedger.Valuation valuation = PaperLedger.value(cash, qty, price);
        store.upsertNav(new NavRow(book.code(), day, PaperLedger.round4(valuation.nav()), PaperLedger.round4(cash),
                PaperLedger.round4(valuation.equityValue()), PaperLedger.round4(valuation.exposurePct()), pricesFinal));
        if (pricesFinal) {
            notes.add("순자산 " + day + " 확정(금융위 종가) " + won(BigDecimal.valueOf(PaperLedger.round4(valuation.nav())))
                    + "원 — 그날까지 체결 모두 확정·보유 모두 금융위 " + day + " 종가");
            return line.pricesFinal() ? null : day;
        }
        notes.add("순자산 " + day + " 잠정으로 다시 씀(확정 현금 " + won(BigDecimal.valueOf(PaperLedger.round4(cash))) + "원) — "
                + String.join("; ", provisional));
        return null;
    }

    /**
     * 그 책의 대기 주문 중 그날({@code day}) 이하 봉으로 <b>나중에</b> 체결될 수 있는 것 — 기준 거래일 &lt; 그날이고 그 시장이 체결하는 시점
     * ({@link PaperMarket#timings})인 대기 주문(사람이 읽을 한 줄씩). 한국 체결은 기준일 뒤 <b>첫 관측 봉</b>의 시가라(§4-2 'C2b') 1분봉 {@code FAILED}
     * 기다림(결정 d11)·기업행위·종목 구분·세율 보류로 대기하던 주문이 다음 밤 저장본에서 그날 날짜로 체결될 수 있습니다. 그런 주문이 있는 날의
     * 순자산 줄은 확정으로 쓰지 않습니다 — 확정 줄은 잠정 줄로 덮이지 않고 확정 조정은 마지막 줄만 다시 쓰므로, 그 체결이 빠진 확정 줄이 영구히
     * 남기 때문입니다(묶음 C 리뷰 — 결정 d11의 '대기 주문 = 정리 안 됨'과 같은 뜻). 기준일 = 그날인 주문(그날 밤 결정·스탑 감지)은 그날 뒤 봉으로만
     * 체결되므로 세지 않습니다.
     */
    static List<String> pendingThrough(PaperStore store, PaperMarket market, String bookCode, LocalDate day) {
        List<String> out = new ArrayList<>();
        for (Order order : store.ordersByStatus(bookCode, PaperBooks.ORDER_PENDING)) {
            if (order.asOfTradingDate() != null && order.asOfTradingDate().isBefore(day)
                    && market.timings().contains(order.timing())) {
                out.add("주문 " + order.id() + " " + order.side() + " " + order.ticker() + "(기준일 " + order.asOfTradingDate()
                        + ") 대기 — " + day + " 이하 봉으로 체결될 수 있음");
            }
        }
        return out;
    }

    /**
     * 장부 상태가 그 줄의 거래일 D 마감이 아닌 까닭(맞으면 null) — 마지막으로 처리한 관측치의 세션이 D가 아니거나 D 뒤 체결이 있음({@link #rewriteNav}).
     */
    private String stateMovedPast(MarketRun run, Book book, BookState state, LocalDate day) {
        if (state.lastProcessedCollectedAt() == null) {
            return "장부가 관측치를 처리한 적이 없음";
        }
        LocalDate session;
        try {
            session = run.calendar().currentOrLastSession(state.lastProcessedCollectedAt());
        } catch (com.macrodash.analytics.CalendarUnavailableException e) {
            return "마지막 관측치의 세션을 셀 수 없음(" + e.getMessage() + ")";
        }
        if (!day.equals(session)) {
            return "마지막으로 처리한 관측치의 세션이 " + session + "(그 줄 " + day + "이 아님)";
        }
        Optional<LocalDate> latest = store.latestFillDate(book.code());
        if (latest.isPresent() && latest.get().isAfter(day)) {
            return day + " 뒤 체결(" + latest.get() + ")이 장부에 있음";
        }
        return null;
    }

    /** 체결 하나 — 확정 조정 행을 새로 썼으면 그 현금 차이, 아니면 empty(사유는 {@code notes}). */
    private Optional<BigDecimal> confirmFill(MarketRun run, Book book, UnconfirmedFill unconfirmed, KrConfirmed fsc,
                                             Map<String, Position> positions, List<String> notes) {
        Fill fill = unconfirmed.fill();
        String head = "체결 " + fill.id() + " " + fill.side() + " " + fill.ticker() + " " + fill.qty() + "주(" + fill.observationDate()
                + ")";
        boolean open = PaperBooks.NEXT_OPEN.equals(unconfirmed.timing());
        if (!open && !PaperBooks.NEXT_CLOSE.equals(unconfirmed.timing())) {
            notes.add(head + " 확정 조정 안 함 — 체결 시점 " + unconfirmed.timing() + "에는 금융위 확정가(시가·종가)가 정해지지 않음");
            return Optional.empty();
        }
        LocalDate day = fill.observationDate();
        KrConfirmed.Series series = fsc.of(fill.ticker());
        Optional<KrConfirmed.Day> row = day == null ? Optional.empty() : series.on(day);
        if (row.isEmpty()) {
            if (day != null && series.datasetLatest() != null && !series.datasetLatest().isBefore(day)) {
                notes.add(head + " " + uncorrected(series) + " — " + dataset(series) + " " + day + " 행 없음(최신 기준일 "
                        + series.datasetLatest() + "): 잠정가 그대로");
            }
            return Optional.empty();   // 금융위가 그날을 아직 내지 않음 — 다음 주기에 다시 봄(조용히)
        }
        BigDecimal price = open ? row.get().open() : row.get().observed() ? row.get().close() : null;
        if (price == null) {
            notes.add(head + " " + uncorrected(series) + " — " + dataset(series) + " " + day + " " + (open ? "시가" : "종가")
                    + (open ? " 칸 없음(거래 없던 날·시가 칸 전 저장본)" : " 없음(거래량 0·모름 — 그날 종가는 체결가가 아님)") + ": 잠정가 그대로");
            return Optional.empty();
        }
        Optional<SettingsRow> version = fill.createdAt() == null ? Optional.empty()
                : store.settingsInForceAt(fill.createdAt());
        if (version.isEmpty()) {
            notes.add(head + " 확정 조정 안 함 — 체결 때(" + fill.createdAt() + ") 유효했던 설정 판을 이력에서 찾지 못함");
            return Optional.empty();
        }
        PaperSettings settings = PaperSettings.from(version.get().body(), run.definition());
        PaperSettings.CostRates rates = settings.costRates();
        if (rates == null) {
            throw new IllegalStateException("한국 비용 요율이 없는 설정입니다 — 확정 조정은 한국 시장 판으로 읽은 설정이 필요합니다");
        }
        Optional<KrxCosts.Instrument> instrument = KrxCosts.classify(row.get().market(),
                KrPaperMarket.etf(fill.ticker(), settings));
        if (instrument.isEmpty()) {
            notes.add(head + " 확정 조정 안 함 — 종목 구분 모름(금융위 " + day + " 시장 구분 "
                    + (row.get().market() == null ? "없음" : "'" + row.get().market() + "'") + ", 설정 v" + version.get().version()
                    + "의 ETF 목록에도 없음)");
            return Optional.empty();
        }
        PaperLedger.Side side = PaperBooks.SELL.equals(fill.side()) ? PaperLedger.Side.SELL : PaperLedger.Side.BUY;
        KrxCosts.Rates fillRates = rates.rates(settings.slippageBp());
        BigDecimal provisional = BigDecimal.valueOf(fill.price());
        BigDecimal provisionalFlow = KrxCosts.cashFlow(side, provisional.multiply(BigDecimal.valueOf(fill.qty())), fill.fee(),
                fill.tax(), fill.slippageCost());
        KrxCosts.Costs costs;
        try {
            costs = KrxCosts.fill(side, instrument.get(), day, fill.qty(), price, fillRates);
        } catch (IllegalArgumentException e) {
            notes.add(head + " 확정 조정 안 함 — 비용을 셀 수 없음(설정 v" + version.get().version() + "): " + e.getMessage());
            return Optional.empty();
        }
        BigDecimal delta = costs.cashFlow().subtract(provisionalFlow);
        String source = KrConfirmed.SOURCE_FSC_ETF.equals(series.source()) ? FillConfirmation.SOURCE_FSC_ETF
                : FillConfirmation.SOURCE_FSC;
        if (!store.insertFillConfirmationIfAbsent(new FillConfirmation(fill.id(), book.code(), price, costs.commission(),
                costs.tax(), costs.slippage(), delta, source, null))) {
            return Optional.empty();   // 이미 확정함(같은 트랜잭션 밖에서 먼저 씀) — 현금을 두 번 옮기지 않음
        }
        StringBuilder note = new StringBuilder(head).append(" 확정(").append(source).append(' ').append(day)
                .append(open ? " 시가" : " 종가").append("): 잠정 ").append(won(provisional)).append("원(").append(fill.priceSource())
                .append(") → 확정 ").append(won(price)).append("원, 현금 ").append(signed(delta)).append("원 · 비용 수수료 ")
                .append(won(costs.commission())).append("·세금 ").append(won(costs.tax())).append("·슬리피지 ")
                .append(won(costs.slippage())).append("(설정 v").append(version.get().version()).append(')');
        if (!provisionalMatches(side, instrument.get(), day, fill, provisional, fillRates)) {
            note.append(" — 주의: 잠정 체결의 비용 칸이 이 판의 요율로 다시 센 값과 다름(체결 처리 중에 설정이 저장됨 등)");
        }
        notes.add(note.toString());
        if (side == PaperLedger.Side.BUY) {
            moveAverage(book, fill, price.subtract(provisional), price, fsc.of(fill.ticker()), positions, notes);
        }
        return Optional.of(delta);
    }

    /**
     * 매수 확정의 평단 이동(결정 d14)과 그 체결이 연 보유의 최고가 다시 계산(클래스 설명). 보유가 없거나 그 체결 뒤에 열린 보유면 아무것도 하지
     * 않습니다.
     */
    private void moveAverage(Book book, Fill fill, BigDecimal priceShift, BigDecimal confirmedPrice,
                             KrConfirmed.Series series, Map<String, Position> positions, List<String> notes) {
        Position p = positions.get(fill.ticker());
        if (p == null || p.qty() <= 0 || p.openedAt() == null || fill.observedAt() == null
                || p.openedAt().isAfter(fill.observedAt())) {
            return;   // 그 체결을 담은 보유가 없음(다 팔았거나 그 뒤 새로 열림) — 현금 차이만
        }
        int kept = Math.min(fill.qty(), p.qty());
        BigDecimal shift = priceShift.multiply(BigDecimal.valueOf(kept)).divide(BigDecimal.valueOf(p.qty()), AVG_SCALE,
                RoundingMode.HALF_UP);
        double avg = PaperLedger.round4(BigDecimal.valueOf(p.avgCost()).add(shift).doubleValue());
        if (!(avg > 0)) {
            notes.add("체결 " + fill.id() + " " + fill.ticker() + " 평단을 옮기지 않음 — 옮긴 값이 0 이하(" + avg + ")");
            avg = p.avgCost();
        }
        double watermark = p.highWatermark();
        java.time.Instant watermarkAt = p.watermarkAt();
        boolean opening = p.openedAt().equals(fill.observedAt()) && fill.observationDate() != null
                && fill.observationDate().equals(p.openedOn()) && (p.splitNote() == null || p.splitNote().isBlank());
        if (opening) {
            BigDecimal high = confirmedPrice;
            for (KrConfirmed.Day day : series.observedFrom(fill.observationDate())) {
                high = high.max(day.close());
            }
            double recomputed = PaperLedger.round4(high.doubleValue());
            if (recomputed != watermark) {
                notes.add(fill.ticker() + " 최고가 다시 계산(확정값 우선) — " + won(BigDecimal.valueOf(watermark)) + " → "
                        + won(BigDecimal.valueOf(recomputed)) + "원(확정 체결가와 " + fill.observationDate() + "부터의 금융위 종가 중 최고)");
                lowerPendingStops(book, fill.ticker(), recomputed, notes);
                watermark = recomputed;
                watermarkAt = clock.instant();
            }
        }
        Position moved = new Position(p.bookCode(), p.ticker(), p.qty(), avg, p.openedOn(), p.openedAt(), watermark,
                watermarkAt, p.lastPrice(), p.lastPriceAt(), p.priceStale(), p.fillRefDate(), p.fillRefClose(), p.splitNote());
        store.upsertPosition(moved);
        positions.put(p.ticker(), moved);
    }

    /**
     * 그 보유의 대기 STOP 주문 근거에 확정 조정이 낮춘 최고가를 남깁니다({@code PaperLedgerService.STOP_CONFIRMED_WATERMARK}) — 감지 때 근거의 최고가가
     * 잠정 체결가(시가 사다리를 내려간 {@code TOSS_INTEGRATED} 등)였던 스탑을 체결 처리 때 확정값으로 다시 판정하게(K30, 묶음 C 리뷰). 감지 때 최고가보다
     * 낮아졌을 때만이고(감지 뒤 오른 값으로 스탑가를 올리지 않음), 이미 남긴 값보다 낮을 때만 바꿉니다. 근거가 객체가 아니거나 최고가가 없는 주문(손으로
     * 넣은 주문 — 다시 판정하지 않음)은 그대로 둡니다.
     */
    private void lowerPendingStops(Book book, String ticker, double recomputed, List<String> notes) {
        for (Order order : store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING)) {
            if (!PaperBooks.SOURCE_STOP.equals(order.source()) || !ticker.equals(order.ticker())
                    || !(order.reason() instanceof tools.jackson.databind.node.ObjectNode reason)) {
                continue;
            }
            tools.jackson.databind.JsonNode detected = reason.get("highWatermark");
            tools.jackson.databind.JsonNode already = reason.get(PaperLedgerService.STOP_CONFIRMED_WATERMARK);
            if (detected == null || !detected.isNumber() || !(recomputed < detected.asDouble())
                    || (already != null && already.isNumber() && already.asDouble() <= recomputed)) {
                continue;
            }
            tools.jackson.databind.node.ObjectNode updated = reason.deepCopy();
            updated.put(PaperLedgerService.STOP_CONFIRMED_WATERMARK, recomputed);
            store.updateOrderReason(order.id(), updated);
            notes.add("주문 " + order.id() + " " + ticker + " 스탑 재판정의 최고가 = 확정값 " + won(BigDecimal.valueOf(recomputed))
                    + "원(감지 때 " + won(BigDecimal.valueOf(detected.asDouble())) + "원 — 잠정 체결가)");
        }
    }

    /** 잠정 체결의 비용 칸이 그 판의 요율로 잠정가를 다시 센 값과 같은가(체결 처리와 설정 저장이 겹쳤는지 알리는 점검). */
    private static boolean provisionalMatches(PaperLedger.Side side, KrxCosts.Instrument instrument, LocalDate day, Fill fill,
                                              BigDecimal provisional, KrxCosts.Rates rates) {
        try {
            KrxCosts.Costs again = KrxCosts.fill(side, instrument, day, fill.qty(), provisional, rates);
            return again.commission().compareTo(fill.fee()) == 0 && again.tax().compareTo(fill.tax()) == 0
                    && again.slippage().compareTo(fill.slippageCost()) == 0;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** 확정하지 못한 사유의 머리 — ETF는 '금융위 확정 미보정'(명세 §4-1·§6), 주식은 '금융위 확정 못 함'. */
    private static String uncorrected(KrConfirmed.Series series) {
        return KrConfirmed.SOURCE_FSC_ETF.equals(series.source()) ? "금융위 확정 미보정(ETF)" : "금융위 확정 못 함";
    }

    private static String dataset(KrConfirmed.Series series) {
        return KrConfirmed.SOURCE_FSC_ETF.equals(series.source()) ? "증권상품시세" : "주식시세";
    }

    private static String won(BigDecimal value) {
        return value.stripTrailingZeros().toPlainString();
    }

    private static String signed(BigDecimal value) {
        return (value.signum() > 0 ? "+" : "") + won(value);
    }
}
