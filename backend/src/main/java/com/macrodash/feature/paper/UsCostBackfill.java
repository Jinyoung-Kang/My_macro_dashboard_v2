package com.macrodash.feature.paper;

import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.UsCosts;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.CostAdjustment;
import com.macrodash.store.PaperStore.CostBackfillFill;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Params;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 미국 모의 계좌 체결 비용의 과거 소급(ADR 0030 결정 2, 명세 2026-11-06-us-costs-backfill.md §2) — 운영자가 배포 뒤 한 번 돌립니다
 * ({@code POST /api/paper/admin/cost-backfill}).
 *
 * <p><b>대상</b>: 미국 계좌(벤치마크 포함 다섯 — {@code paper_books.market = US})의 체결 가운데 비용 칸이 비었고({@code fee = 0 AND tax = 0}) 소급
 * 조정 행이 없는 것. 새 비용으로 이미 체결된 행·이미 조정한 행은 건너뛰므로 두 번 돌려도 결과는 한 번입니다.
 *
 * <p><b>계산</b>: 체결마다 미국 체결 비용 식({@link UsCosts} — 저장된 체결가·체결 금액·수량으로, <b>그 체결 때 유효했던 설정 판</b>의 비율 —
 * {@link PaperStore#settingsInForceAt}에 체결 행을 쓴 시각, 한국 확정 조정 결정 d7과 같음)으로 수수료·매도 제비용을 셉니다. ADR 0030 전 판에는
 * 비용 키가 없어 기본 비율(수수료 10bp·SEC $20.60/백만·TAF $0.000195/주·상한 $9.79 — 사용자 결정)로 읽히고, 이력보다 앞선 체결도 기본 비율입니다.
 * 실행 순서·지금 판과 무관합니다(소급 전에 비율을 바꿔 저장해도 과거 체결은 그때 판으로). 비용이 0원으로 나온 체결(비율 0인 판에서 낸 체결)은
 * 조정 행을 넣지 않습니다(다음 실행에서도 0원이라 무해). 당시 수량·체결가·결정은 바꾸지 않습니다(그때 수수료가 있었다면 수량이 조금 달랐을 것
 * — 화면에 적음). 체결 행은 고치지 않고 조정 행({@code paper_cost_adjustments})을 넣습니다(한국 확정 조정 선례).
 *
 * <p><b>장부</b>: 새로 넣은 조정의 현금 차이(−(수수료 + 제비용)) 합을 계좌 상태의 현금·순자산에 더하고, 일별 순자산 줄은 날짜 d마다 fill_date ≤ d인
 * 조정의 현금 차이 합을 현금·순자산에 더합니다(노출은 평가액 ÷ 순자산으로 다시 셈, 평가액·확정 표시는 그대로). 수익률·통계(누적 수익률·MDD·샤프·
 * 초과 수익)는 읽을 때 순자산 줄에서 계산되므로 그대로 따라옵니다.
 *
 * <p>장부 잠금({@link PaperLedgerService#exclusively}) 안, 한 트랜잭션입니다 — 관측치 처리와 겹치지 않고, 중간에 실패하면 모두 되돌립니다. 확인 글자
 * ({@value #CONFIRM})는 서버가 다시 봅니다.
 */
final class UsCostBackfill {

    private static final Logger log = LoggerFactory.getLogger(UsCostBackfill.class);

    /** 확인 글자(명세 §2 — 화면과 같은 글자). */
    static final String CONFIRM = "비용 소급";
    /** 작업 기록 이름(미국 작업 — 접두어 없음). */
    static final String JOB = "cost-backfill";

    private final PaperStore store;
    private final PaperLedgerService ledger;
    private final ObjectMapper mapper;
    private final Clock clock;

    UsCostBackfill(PaperStore store, PaperLedgerService ledger, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.ledger = ledger;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 계좌 하나의 소급 결과.
     *
     * @param fills     이번에 조정 행을 넣은 체결 수
     * @param fee       그 수수료 합
     * @param tax       그 매도 제비용 합
     * @param cashDelta 그 현금 차이 합(0 이하)
     */
    record BookResult(String code, int fills, BigDecimal fee, BigDecimal tax, BigDecimal cashDelta) {
    }

    /**
     * 소급에 쓴 설정 판 하나.
     *
     * @param settingsVersion 체결 때 유효했던 설정 판(이력보다 앞선 체결이면 null — 기본 비율)
     * @param rates           그 판의 비율(설정 키 이름 그대로)
     * @param fills           이 판의 비율로 조정 행을 넣은 체결 수
     */
    record VersionUsed(Integer settingsVersion, Map<String, Object> rates, int fills) {
    }

    /**
     * 소급 결과.
     *
     * @param navRowsUpdated 현금·순자산을 고친 일별 순자산 줄 수(계좌 합)
     * @param versions       조정 행을 넣은 체결의 설정 판별 비율과 건수(판 번호 순, 이력 전 체결은 맨 앞)
     * @param zeroCostFills  비용이 0원으로 나와 조정 행을 넣지 않은 체결 수(비율 0인 판에서 낸 체결)
     */
    record Result(String market, List<BookResult> books, int navRowsUpdated, List<VersionUsed> versions,
                  int zeroCostFills) {

        Result {
            books = List.copyOf(books);
            versions = List.copyOf(versions);
        }
    }

    /**
     * 소급을 한 번 돌립니다.
     *
     * @param market  {@code "US"}만(한국 계좌는 출발부터 토스와 같은 비용 모델 — 명세 §0)
     * @param confirm 확인 글자 {@value #CONFIRM}
     * @throws InvalidRequestException 시장이 US가 아님·확인 글자가 다름
     */
    Result run(String market, String confirm) {
        if (!Book.MARKET_US.equals(market)) {
            throw new InvalidRequestException("비용 소급은 미국(US)만 합니다 — 한국 계좌는 출발부터 수수료·매도세를 반영합니다"
                    + "(market: " + (market == null ? "없음" : Params.echo(market)) + ")");
        }
        if (!CONFIRM.equals(confirm)) {
            throw new InvalidRequestException("비용을 소급하려면 확인 문구로 '" + CONFIRM + "'를 그대로 입력하세요.");
        }
        Instant started = clock.instant();
        Result result = ledger.exclusively(() -> store.atomically(this::backfillLocked));
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("market", result.market());
        detail.put("versions", result.versions());
        detail.put("zeroCostFills", result.zeroCostFills());
        detail.put("navRowsUpdated", result.navRowsUpdated());
        detail.put("books", result.books());
        store.recordJobRun(JOB, started, clock.instant(), "OK", mapper.valueToTree(detail));
        log.info("미국 체결 비용 소급(체결 때 판 {}): {} — 순자산 줄 {}줄, 0원 체결 {}건", result.versions(), result.books(),
                result.navRowsUpdated(), result.zeroCostFills());
        return result;
    }

    /** 체결 때 유효했던 설정 판의 미국 비용 비율(판 번호 — 이력 전이면 null). */
    private record InForce(Integer version, UsCosts.Rates rates, Map<String, Object> view, JsonNode json) {
    }

    private InForce inForce(Instant createdAt, Map<Integer, InForce> cache, InForce fallback) {
        Optional<SettingsRow> row = createdAt == null ? Optional.empty() : store.settingsInForceAt(createdAt);
        if (row.isEmpty()) {
            return fallback;
        }
        return cache.computeIfAbsent(row.get().version(), version -> rates(version,
                PaperSettings.from(row.get().body(), UsPaperMarket.INSTANCE).usCosts()));
    }

    private InForce rates(Integer version, PaperSettings.UsCostRates costRates) {
        Map<String, Object> view = costRates.view();
        return new InForce(version, costRates.rates(), view, mapper.valueToTree(view));
    }

    private Result backfillLocked() {
        PaperMarket us = UsPaperMarket.INSTANCE;
        InForce fallback = rates(null, PaperSettings.defaults(us).usCosts());
        Map<Integer, InForce> cache = new HashMap<>();
        Map<Integer, Integer> fillsByVersion = new TreeMap<>(Comparator.nullsFirst(Comparator.naturalOrder()));
        Map<Integer, InForce> used = new HashMap<>();
        int zeroCost = 0;
        List<Book> books = new ArrayList<>(store.books(us.code()));
        books.sort(Comparator.comparing(Book::code, us.bookOrder()));
        List<BookResult> out = new ArrayList<>();
        int navRows = 0;
        for (Book book : books) {
            int fills = 0;
            BigDecimal fee = BigDecimal.ZERO;
            BigDecimal tax = BigDecimal.ZERO;
            BigDecimal cash = BigDecimal.ZERO;
            TreeMap<java.time.LocalDate, BigDecimal> byDate = new TreeMap<>();
            for (CostBackfillFill fill : store.costBackfillTargets(book.code())) {
                InForce rates = inForce(fill.createdAt(), cache, fallback);
                PaperLedger.Side side = PaperBooks.SELL.equals(fill.side()) ? PaperLedger.Side.SELL : PaperLedger.Side.BUY;
                UsCosts.Costs costs = UsCosts.of(side, fill.qty(), fill.price(), fill.gross(), rates.rates());
                if (costs.costDelta().signum() == 0) {
                    zeroCost++;   // 비율 0인 판에서 낸 체결 — 0원 조정 행은 남기지 않음(다음 실행에서도 0원)
                    continue;
                }
                CostAdjustment adjustment = new CostAdjustment(fill.fillId(), book.code(), us.code(), costs.commission(),
                        costs.tax(), costs.costDelta(), fill.observationDate(), rates.version(), rates.json(),
                        CostAdjustment.REASON_US_BACKFILL, null);
                if (!store.insertCostAdjustmentIfAbsent(adjustment)) {
                    continue;   // 그사이 다른 실행이 넣음(잠금 안이라 오지 않지만 방어 — 현금은 넣은 행만 옮김)
                }
                fills++;
                fee = fee.add(costs.commission());
                tax = tax.add(costs.tax());
                cash = cash.add(costs.costDelta());
                byDate.merge(fill.observationDate(), costs.costDelta(), BigDecimal::add);
                fillsByVersion.merge(rates.version(), 1, Integer::sum);
                used.putIfAbsent(rates.version(), rates);
            }
            boolean first = true;
            for (Map.Entry<java.time.LocalDate, BigDecimal> entry : byDate.entrySet()) {
                if (entry.getValue().signum() == 0) {
                    continue;
                }
                int rows = store.shiftNavFrom(book.code(), entry.getKey(), entry.getValue());
                if (first) {
                    navRows += rows;   // 가장 이른 날의 갱신이 그 뒤 날짜 줄을 모두 덮음(바꾼 줄 집합 = 이 줄들)
                    first = false;
                }
            }
            if (cash.signum() != 0) {
                store.shiftStateCash(book.code(), cash);
            }
            out.add(new BookResult(book.code(), fills, fee, tax, cash));
        }
        List<VersionUsed> versions = new ArrayList<>();
        fillsByVersion.forEach((version, count) -> versions.add(new VersionUsed(version, used.get(version).view(), count)));
        return new Result(us.code(), out, navRows, versions, zeroCost);
    }
}
