package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 리스크 점검 정기 작업(설계 §6-3) — 5분마다 새 관측치({@code paper.quotes})가 있으면 장부에 적용합니다(체결·스탑·분할·평가).
 *
 * <p>시장마다 따로 돕니다(2단계 명세 §9 A5): 정기 실행은 {@link PaperMarkets#all}을 차례로, 시장마다 그 시장의 관측치 저장본을
 * 읽어 그 시장 책에만 적용하고({@link PaperLedgerService} 설명), 작업 기록은 그 시장 이름({@link PaperMarket#jobName})으로
 * 남깁니다. 한국은 출발일·한국 계좌가 갖춰질 때까지 건너뜁니다({@link PaperMarket#dormantReason} — 실행을 열지 않고 기록도 없음, C1c).
 * 시장을 받지 않는 수동 실행·한 번 실행은 미국 판입니다.
 * 실행마다 그 시장의 실행 문맥({@link MarketRun} — 달력 한 벌·설정 행 하나)을 열어 앞 창 확인·장부·관측치 요약에 넘깁니다(C1a).
 *
 * <p><b>운영 알림</b>: 장부가 낸 알림({@link Outcome#alerts} — 한국 '미처리 기업행위' 보류가 걸린 날 뒤 5거래일을 넘김, 명세 §4-2 K32)은 그
 * 실행 기록의 {@code detail.alerts}와 경고 로그에 남습니다(알림 벨·알림함에는 넣지 않음 — 2단계 명세 §4-2 'C2c 구현에서 정한 것').
 *
 * <p><b>금융위 확정 조정</b>(한국 — {@link PaperMarket#confirmsFills}, 2단계 K29·C3): 금융위 값은 관측치와 따로(D+1 밤 slow 첫머리) 들어오므로 새
 * 관측치가 없는 주기에도 장부의 확정 조정만 돌립니다({@link PaperLedgerService#confirm}). 확정 조정 행을 썼거나 순자산 줄이 확정이 됐거나 새 오류가
 * 났을 때만 기록하고({@code detail.confirmationOnly}), 새 관측치가 있으면 장부가 그 처리 앞에서 확정 조정을 함께 합니다({@code detail.confirmed}).
 *
 * <p>관측치는 수집기가 1시간마다 저장하므로 대부분의 실행은 "새 저장본 없음"으로 끝나고, 그때는 기록을 남기지 않습니다
 * (5분마다 한 줄씩 쌓이면 작업 기록 200건이 17시간 치뿐입니다). 일했을 때와 오류일 때만 {@code paper_job_runs}에 남기고,
 * detail에 관측치 수집 시각·다수 티커의 봉 날짜·확정 종가 여부를 적습니다 — 장중 저장본의 마지막 봉이 정말 그날 지연 시세인지
 * (명세 §7 첫 항목) 이 기록으로 확인합니다.
 *
 * <p>저장본은 {@link StoreReader#quietly}로만 읽습니다 — 정기 작업이 수집기를 깨우지 않게(ADR 0008). 예외는 삼키고 로그만
 * 남깁니다(RegimeLogService와 같은 관례). 같은 관측치를 두 번 처리해도 결과는 한 번입니다(장부의 멱등 키).
 *
 * <p>한 책이 오류로 되돌려지면 그 관측치는 그 책에 대해 다시 돌리지 않습니다({@link PaperLedgerService} 설명) — 같은 저장본으로
 * 5분마다 같은 오류를 내고 ERROR 기록이 쌓여 장중 봉 확인용 기록을 밀어내지 않게. 새 관측치가 오면 다시 시도하고, 수동 실행은
 * 같은 관측치로 한 번 더 시도합니다(미국 {@code POST /api/paper/run/risk}, 한국 {@code ?market=KR} — 한국은 그 밤 새 관측치가 오지 않아 이것이
 * 재기동 말고 창 안의 복구 경로, {@link #runNowView}).
 *
 * <p>그 시장 달력이 앞으로 쓸 창의 해를 모르면(공휴일 목록 없음 — 명세 K35) 관측치를 읽지 않고 그 시장 실행을 멈추며, 작업 기록에
 * {@value CalendarGaps#NO_CALENDAR}('달력 없음' 사유·빠진 해)를 남깁니다 — 정기 실행은 그 시장·KST 날짜·빠진 해마다 한 번,
 * 수동 실행은 누를 때마다({@link CalendarGaps}).
 *
 * <p>{@code dashboard.paper.enabled=false}면 정기 실행은 아무것도 하지 않습니다(통합 테스트). 수동 실행({@link #runNow})은
 * 설정과 상관없이 한 번 돕니다.
 */
@Service
public class PaperRiskJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 시장의 작업 기록 접두어를 붙여 씁니다(미국은 접두어 없이 그대로). */
    static final String JOB = "risk";

    private static final Logger log = LoggerFactory.getLogger(PaperRiskJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 정기 실행이 도는 시장 목록(도는 순서 — {@link PaperMarkets#all}). */
    private final PaperMarkets markets;
    /** '달력 없음'을 시장·날짜·빠진 해마다 한 번만 남기는 장부(클래스 설명). */
    private final CalendarGaps calendarGaps = new CalendarGaps();

    @Autowired
    PaperRiskJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                 PaperConfig config, ObjectMapper mapper, PaperMarkets markets) {
        this(store, reader, marketData, ledger, config, mapper, Clock.systemUTC(), markets);
    }

    /** 테스트용 — 시계를 움직입니다(시장 목록은 운영 목록). */
    PaperRiskJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                 PaperConfig config, ObjectMapper mapper, Clock clock) {
        this(store, reader, marketData, ledger, config, mapper, clock, new PaperMarkets(store, reader));
    }

    /** 테스트용 — 시계와 시장 목록을 바꿉니다(시장 격리 시험이 시험용 한국 시장을 넣음). */
    PaperRiskJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                 PaperConfig config, ObjectMapper mapper, Clock clock, List<PaperMarket> markets) {
        this(store, reader, marketData, ledger, config, mapper, clock, new PaperMarkets(store, reader, markets));
    }

    private PaperRiskJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                         PaperConfig config, ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = markets;
    }

    /**
     * 정기 실행 — 시장마다 차례로 한 번({@link PaperMarkets#all}, 2단계 명세 §9 A5). 한 시장의 예외는 그 시장만 로그로 남기고 다음
     * 시장으로 넘어갑니다. 꺼져 있으면 아무것도 하지 않습니다.
     */
    @Scheduled(initialDelayString = "${dashboard.paper.risk-initial-delay-ms:90000}",
            fixedDelayString = "${dashboard.paper.risk-interval-ms:300000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        for (PaperMarket market : markets.all()) {
            try {
                Outcome outcome = run(market, false);
                if (!outcome.alerts().isEmpty()) {
                    log.warn("모의 매매 운영 알림({}): {}", market.code(), outcome.alerts());
                }
                if (!outcome.errors().isEmpty()) {
                    log.warn("모의 매매 리스크 점검 중 오류 — 그 책은 같은 관측치로 다시 시도하지 않고 새 관측치에서 다시 시도합니다: {}",
                            outcome.errors());
                } else if (outcome.skippedReason() == null) {
                    log.info("모의 매매 리스크 점검({}): 체결 {} · 스탑 {} · 만료 {} · 분할 {} · 확정 조정 {} ({})", market.code(),
                            outcome.filled(), outcome.stopped(), outcome.expired(), outcome.splits(), outcome.confirmed(),
                            outcome.booksProcessed());
                }
            } catch (RuntimeException e) {
                log.warn("모의 매매 리스크 점검 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
            }
        }
    }

    /** 미국 책의 수동 실행(POST /api/paper/run/risk) — {@link #runNow(PaperMarket)}의 미국 판. */
    public Outcome runNow() {
        return runNow(UsPaperMarket.INSTANCE);
    }

    /**
     * 그 시장의 수동 실행 — {@code dashboard.paper.enabled}와 상관없이 한 번. 그 시장에서 오류가 났던 관측치도 한 번 더
     * 시도합니다(사람이 원인을 고친 뒤 누르는 버튼이라). 기록은 누른 만큼만 남습니다. 지우는 기억은 그 시장 것뿐입니다
     * ({@link PaperLedgerService#forgetFailures(PaperMarket)} — 다른 시장 책은 같은 관측치로 다시 시도하지 않은 채 그대로).
     */
    Outcome runNow(PaperMarket market) {
        ledger.forgetFailures(market);
        return run(market, true);
    }

    /**
     * POST /api/paper/run/risk?market= — 미국 밖 시장의 수동 실행 응답(2단계 명세 §4-16·§9 'F1 — 한국 장부 실패 기억 지우기'):
     * {@code {ok, market, dormantReason, outcome}}. 한국 관측치는 KR 거래일마다 한 번이라 장부가 그 관측치에서 오류를 내면 그 밤 새 관측치가
     * 오지 않습니다 — 이 실행이 그 시장의 실패 기억을 지우고 같은 관측치를 다시 처리하는 창 안의 복구 단추입니다(결정 게이트 ①의 미달 문구가 이
     * 경로를 안내 — {@link KrDecisionGates#ledger}). 그 시장이 정기 작업을 쉬면(한국 출발일·한국 계좌 없음 — {@link PaperMarket#dormantReason})
     * 실행을 열지 않고 {@code ok:false}·{@code dormantReason}과 그 사유로 건너뛴 결과입니다(예외가 아님). {@code ok}는 쉬지 않고 오류가 없을 때
     * 참입니다. 미국 응답({@code {ok, outcome}})은 시장을 받기 전 그대로입니다(부르는 쪽이 {@link #runNow()}).
     */
    Map<String, Object> runNowView(PaperMarket market) {
        String dormant = store.ready() ? market.dormantReason(config, () -> store.books(market.code())) : null;
        Outcome outcome = dormant != null ? Outcome.skipped(dormant) : runNow(market);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", dormant == null && outcome.errors().isEmpty());
        out.put("market", market.code());
        out.put("dormantReason", dormant);
        out.put("outcome", outcome);
        return out;
    }

    /** 미국 책 한 번 실행 — {@link #run(PaperMarket, boolean)}의 미국 판. 테스트가 부릅니다. */
    Outcome run(boolean manual) {
        return run(UsPaperMarket.INSTANCE, manual);
    }

    /** 그 시장 한 번 실행(정기·수동 공통) — 그 시장의 관측치를 그 시장 책에만 적용하고, 그 시장 이름으로 기록합니다. */
    Outcome run(PaperMarket requested, boolean manual) {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다(V8·V9 적용 전) — make up 후 다시 보세요");
        }
        // 출발일·계좌가 갖춰지지 않은 시장(한국 초기화 전)은 실행을 열지 않고 기록도 남기지 않습니다(PaperMarket#dormantReason).
        String dormant = requested.dormantReason(config, () -> store.books(requested.code()));
        if (dormant != null) {
            return Outcome.skipped(dormant);
        }
        Instant started = clock.instant();
        // 이 실행의 시장 문맥 — 달력 한 벌과 설정 행 하나를 장부까지 넘깁니다(PaperMarkets#open).
        MarketRun market = markets.open(requested);
        try {
            market.requireCalendarWindow(started);
            calendarGaps.clear(market);
        } catch (CalendarUnavailableException e) {
            // 그 시장 달력이 앞 창의 해를 모름(명세 K35) — 장부를 돌리지 않고 '달력 없음'으로 남깁니다(클래스 설명).
            if (manual || calendarGaps.firstToday(market, started, e)) {
                Map<String, Object> detail = CalendarGaps.detail(e);
                detail.put("manual", manual);
                write(market, started, CalendarGaps.NO_CALENDAR, detail);
                log.warn("모의 매매 리스크 점검({}) — {}", market.code(), e.getMessage());
            }
            return Outcome.skipped(e.getMessage());
        }
        Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(market));
        if (quotes.isEmpty() || !ledger.hasNewObservation(market, quotes.get())) {
            // 새 관측치가 없어도 금융위 확정 조정은 돕니다(한국 — 금융위 값은 관측치와 따로 들어옴, K29·C3). 한 일이 있을 때만 기록합니다.
            Outcome confirmation = confirmOnly(market, started, manual, quotes.orElse(null));
            if (confirmation != null) {
                return confirmation;
            }
        }
        if (quotes.isEmpty()) {
            return Outcome.skipped("관측치 저장본(" + market.quotesDataset() + ")이 아직 없습니다 — 수집기의 "
                    + market.quotesTask() + "가 돈 뒤에 다시 보세요");
        }
        if (!ledger.hasNewObservation(market, quotes.get())) {
            List<String> failed = ledger.failedBooks(market, quotes.get());
            if (!failed.isEmpty()) {
                return Outcome.skipped(PaperLedgerService.heldBackReason(quotes.get(), failed));
            }
            return Outcome.skipped("새 관측치가 없습니다(수집 " + Kst.stamp(quotes.get().collectedAt()) + "까지 처리함)");
        }
        Outcome outcome;
        try {
            outcome = ledger.process(market, quotes.get());
        } catch (RuntimeException e) {
            outcome = Outcome.failed(e.getClass().getSimpleName() + " " + e.getMessage());
        }
        record(market, started, manual, quotes.get(), outcome);
        return outcome;
    }

    private void record(PaperMarket market, Instant started, boolean manual, Quotes quotes, Outcome outcome) {
        Map<String, Object> detail = describe(market, quotes);
        detail.put("manual", manual);
        detail.put("filled", outcome.filled());
        detail.put("stopped", outcome.stopped());
        detail.put("expired", outcome.expired());
        detail.put("splits", outcome.splits());
        detail.put("booksProcessed", outcome.booksProcessed());
        if (outcome.skippedReason() != null) {
            detail.put("skippedReason", outcome.skippedReason());
        }
        if (!outcome.notes().isEmpty()) {
            detail.put("notes", outcome.notes());
        }
        if (!outcome.errors().isEmpty()) {
            detail.put("errors", outcome.errors());
        }
        if (!outcome.alerts().isEmpty()) {
            detail.put("alerts", outcome.alerts());   // 운영 알림(한국 미처리 기업행위 보류 5거래일 넘음 — 미국은 생기지 않음)
        }
        if (outcome.confirmed() > 0) {
            detail.put("confirmed", outcome.confirmed());   // 금융위 확정 조정 행(한국 — 미국은 생기지 않음)
        }
        write(market, started, outcome.errors().isEmpty() ? "OK" : "ERROR", detail);
    }

    /**
     * 새 관측치가 없는 주기의 금융위 확정 조정(확정 조정 시장만 — {@link PaperMarket#confirmsFills}, {@link PaperLedgerService#confirm}). 확정 조정 행을
     * 썼거나 순자산 줄이 확정이 됐거나 새 오류가 났으면 작업 기록을 남기고 그 결과를, 한 일이 없으면 null(부르는 쪽이 '새 관측치 없음'으로 답함)을
     * 돌려줍니다 — 금융위 값을 기다리는 5분마다의 확인은 기록하지 않습니다(클래스 설명의 '할 일 없음').
     *
     * @param quotes 지금 관측치(없으면 null — 기록의 관측치 요약에만)
     */
    private Outcome confirmOnly(MarketRun market, Instant started, boolean manual, Quotes quotes) {
        if (!market.confirmsFills()) {
            return null;
        }
        Outcome outcome;
        try {
            outcome = ledger.confirm(market);
        } catch (RuntimeException e) {
            outcome = Outcome.failed(e.getClass().getSimpleName() + " " + e.getMessage());
        }
        if (outcome.booksProcessed().isEmpty() && outcome.errors().isEmpty()) {
            return null;
        }
        Map<String, Object> detail = quotes == null ? new LinkedHashMap<>() : describe(market, quotes);
        detail.put("manual", manual);
        detail.put("confirmationOnly", true);   // 새 관측치 없이 확정 조정만 — 체결·스탑·평가는 하지 않음
        detail.put("confirmed", outcome.confirmed());
        detail.put("booksProcessed", outcome.booksProcessed());
        if (!outcome.notes().isEmpty()) {
            detail.put("notes", outcome.notes());
        }
        if (!outcome.errors().isEmpty()) {
            detail.put("errors", outcome.errors());
        }
        write(market, started, outcome.errors().isEmpty() ? "OK" : "ERROR", detail);
        return outcome;   // 로그는 정기 실행이 결과로 남김(scheduledRun)
    }

    private void write(PaperMarket market, Instant started, String outcome, Map<String, Object> detail) {
        try {
            store.recordJobRun(market.jobName(JOB), started, clock.instant(), outcome, mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            // 기록 실패가 처리 결과(이미 커밋됨)를 오류로 바꾸지 않게 로그만 남깁니다.
            log.warn("모의 매매 작업 기록을 남기지 못했습니다: {}", e.toString());
        }
    }

    /** 미국 관측치 요약 — {@link #describe(PaperMarket, Quotes)}의 미국 판(결정 작업 기록이 씀). */
    static Map<String, Object> describe(Quotes quotes) {
        return describe(UsPaperMarket.INSTANCE, quotes);
    }

    /**
     * 관측치 요약 — 수집 시각·다수 티커의 봉 날짜·그 시각의 세션·확정 종가 여부(세션·확정은 그 시장 달력). {@code barDate ==
     * session}인데 {@code finalClose == false}면 장중 봉(지연 시세)입니다. {@code finalClose}는 그 봉의 종가가 나왔나(시장의
     * {@link PaperMarket#closeAvailable}, 결정 d9)이고 금융위 확정 여부가 아닙니다.
     */
    static Map<String, Object> describe(PaperMarket market, Quotes quotes) {
        Map<String, Object> out = new LinkedHashMap<>();
        LocalDate barDate = quotes.modalBarDate();
        out.put("collectedAt", quotes.collectedAt().toString());
        out.put("collectedAtKst", Kst.stamp(quotes.collectedAt()));
        out.put("barDate", barDate == null ? null : barDate.toString());
        // 세션·확정 판정이 달력이 모르는 해에 닿으면 그 칸만 null + 사유(명세 K35 — 기록을 실패시키지 않음, 미국은 생기지 않음).
        String gap = null;
        try {
            out.put("session", market.calendar().currentOrLastSession(quotes.collectedAt()).toString());
        } catch (CalendarUnavailableException e) {
            out.put("session", null);
            gap = e.getMessage();
        }
        try {
            out.put("finalClose", barDate != null && market.closeAvailable(barDate, quotes.collectedAt()));
        } catch (CalendarUnavailableException e) {
            out.put("finalClose", null);
            gap = gap == null ? e.getMessage() : gap;
        }
        if (gap != null) {
            out.put("calendarReason", gap);
        }
        out.put("tickers", quotes.bars().size());
        out.put("staleTickers", quotes.staleTickers().size());
        return out;
    }
}
