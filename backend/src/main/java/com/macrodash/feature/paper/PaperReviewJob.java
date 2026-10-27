package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.ReviewFacts;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Review;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 🧪 주간 복기 작업(2단계 명세 §3 D1·D4) — 30분마다 돌며, 그 주 복기를 낼 때가 됐으면 {@link ReviewService#review}를 한 번 부릅니다.
 *
 * <pre>
 *  그 시장 달력이 앞 창(직전 세션 ~ 10거래일)의 해를 모름 → NO_CALENDAR(정기 실행은 그 시장·KST 날짜·빠진 해마다 한 번 기록 — 명세 K35)
 *  w = 지금 마감이 끝난 가장 최근 복기 주(그 ISO 주의 마지막 거래일 — 금요일, 휴장이면 목요일)
 *  w 주 토요일 09:00 KST 전                                  → TOO_EARLY(기록 안 함)
 *  w의 행이 이미 있음(다시 부를 API 오류가 아니면)              → ALREADY_REVIEWED
 *  Claude 계좌가 운용 중(ACTIVE)이 아니거나 출발일이 w 전이 아님 → NOT_ACTIVE(복기 없음 — 초기 결정뿐인 주·일시정지 중)
 *  w 확정 종가가 아직 없음(장부의 w 확정 순자산 줄이 없고, 관측치 저장본의 w 확정 종가를 장부가 아직 반영하지 않음)
 *                                                            → WAITING_FINAL_CLOSE(다음 주기에 다시)
 *  → 복기: 창 안 결정이 없으면 SKIPPED 행(부르지 않음), 하루 호출 상한이면 CAP_REACHED(행 없음 — 다음 주기에 다시), 아니면 Claude 한 번
 * </pre>
 *
 * <p><b>놓친 토요일</b>(맥이 꺼져 있었음): w는 다음 복기 주의 마감(다음 금요일 장 마감)까지 바뀌지 않으므로, 그사이 켜지면 첫 주기에
 * 그 주 복기를 냅니다. 그 뒤에는 새 주가 w가 되고 지난 주는 다시 보지 않습니다(한 주 늦은 복기보다 새 주 복기가 낫습니다 — 명세 D1).
 *
 * <p>확정 종가 조건은 Claude 계좌의 w 확정 순자산 줄이 있거나, 관측치 저장본이 w 마감 + 15분 뒤에 수집한 w 봉이고
 * ({@link PaperDecisionJob#finalFor}) <b>Claude 계좌의 w 순자산 줄이 있으면</b>(확정이 아니어도 — 보유 하나가 이어 쓴 봉이면 확정이 아닌
 * 채로 남음) 참입니다 — 금요일 종가 대비 수익률이 장중 값으로 계산되지 않게. 관측치만 보고 열면, 확정 관측치가 저장된 뒤 장부(리스크
 * 작업 5분 주기·결정 작업)가 그것을 처리하기 전에 복기가 돌아 모든 계좌의 w 순자산 줄이 없어 계좌 비교가 전부 null로 굳고(한 주 한
 * 행), 금요일 체결·스탑도 빠집니다. 장부가 그 관측치에서 오류를 내 줄을 못 쓰면 결정 작업이 기한(KST 12:00)에 남기는 확정 아닌
 * 줄({@code settleNav})로 열립니다. 저장본은 {@link StoreReader#quietly}로만 읽습니다(정기 작업이 수집을 깨우지 않게).
 *
 * <p>정기 실행과 수동 실행({@link #runNow} — 토요일 시각 조건만 빼고 같은 조건)은 한 잠금을 씁니다. 정기 실행은 잠금을 기다리지 않고
 * {@value #BUSY}로 넘어가고(Claude 호출이 몇 분 걸릴 수 있음 — 스케줄러 스레드를 붙잡지 않게), 수동 실행은 429로 답합니다(두 번 눌러
 * 두 번 과금되지 않게 — 끝난 뒤 다시 누르면 남은 행을 돌려줌). 같은 주에 오류(예외)가 {@value #MAX_ATTEMPTS}번 나면 그 주는 정기 실행이
 * 더 시도하지 않습니다(30분마다 같은 오류가 작업 기록을 밀어내지 않게 — 수동 실행은 다시 시도, 재기동하면 처음부터 셈).
 * {@code dashboard.paper.enabled=false}면 정기 실행은 아무것도 하지 않습니다.
 *
 * <p><b>시장마다 따로</b>입니다(2단계 명세 §9 A6). 정기 실행은 {@link PaperMarkets#all}을 차례로 돌고(미국 → 한국 — 한국은 출발일·한국
 * 계좌가 갖춰질 때까지 {@value #DORMANT}로 건너뜀, {@link PaperMarket#dormantReason}), 시장마다 복기 주
 * (그 시장 달력)·여는 순간({@link PaperMarket#reviewOpening} — 시장별 요일·시각)·그 시장 Claude 책·확정 종가(그 시장 관측치와 확정
 * 판정)·오류 횟수(시장 × 주)·작업 기록 이름(시장 접두어 + {@value #JOB})을 그 시장 것으로 쓰고 그 시장 문맥으로 복기합니다
 * ({@link ReviewService}). 복기 행은 시장마다 한 주 한 행이라(V14 기본키 (market, week_ending)) '이미 복기함'·재시도 판정도 그 시장
 * 행으로 봅니다. 시장을 받지 않는 옛 시그니처(한 번 실행·수동 실행)는 미국 판입니다. 실행마다 그 시장의 실행 문맥({@link MarketRun} —
 * 달력 한 벌)을 열어 복기 주·여는 순간·확정 종가 판정과 복기 서비스에 같은 한 벌을 넘깁니다(C1a).
 */
@Service
public class PaperReviewJob {

    private static final Logger log = LoggerFactory.getLogger(PaperReviewJob.class);

    /** 작업 기록의 이름(paper_job_runs.job). */
    static final String JOB = "review";
    static final int MAX_ATTEMPTS = 3;
    static final Duration BUSY_RETRY = Duration.ofSeconds(30);

    public static final String NOT_READY = "NOT_READY";
    public static final String TOO_EARLY = "TOO_EARLY";
    public static final String ALREADY_REVIEWED = "ALREADY_REVIEWED";
    public static final String NOT_ACTIVE = "NOT_ACTIVE";
    public static final String WAITING_FINAL_CLOSE = "WAITING_FINAL_CLOSE";
    public static final String CAP_REACHED = "CAP_REACHED";
    public static final String GAVE_UP = "GAVE_UP";
    public static final String BUSY = "BUSY";
    /** Claude를 불러 행을 남김(상태는 행에 — OK·FORMAT_ERROR·REFUSED·API_ERROR). */
    public static final String REVIEWED = "REVIEWED";
    /** 창 안에 복기할 결정이 없어 SKIPPED 행을 남김(부르지 않음). */
    public static final String SKIPPED = "SKIPPED";
    public static final String ERROR = "ERROR";
    /** 그 시장 달력이 앞 창의 해를 모름 — 그 시장 복기를 하지 않음(명세 K35, {@link CalendarGaps}). */
    public static final String NO_CALENDAR = CalendarGaps.NO_CALENDAR;
    /** 출발일·계좌가 갖춰지지 않은 시장 — 실행을 열지 않음(기록 안 함, {@link PaperMarket#dormantReason}). */
    public static final String DORMANT = "DORMANT";

    /**
     * 한 번 실행의 결과.
     *
     * @param outcome    위 상수 중 하나. REVIEWED·SKIPPED·ERROR만 작업 기록을 남깁니다(NO_CALENDAR는 정기 실행에서 시장·KST 날짜·빠진 해마다 한 번)
     * @param weekEnding 대상 복기 주(테이블이 없으면 null)
     * @param review     남은(또는 이미 있던) 복기 행. 없으면 null
     */
    public record Result(String outcome, LocalDate weekEnding, Review review, String message) {
    }

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final ReviewService reviews;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 정기 실행이 도는 시장 목록(도는 순서 — {@link PaperMarkets#all}). */
    private final PaperMarkets markets;
    /** 정기·수동 실행이 겹치지 않게(한 주에 한 행 — 유일 제약이 마지막 방어선, 한 번의 유료 호출). 시장이 여럿이어도 하나. */
    private final ReentrantLock running = new ReentrantLock();
    /** (시장, 복기 주) → 오류 난 횟수(클래스 설명). 재기동하면 사라집니다. */
    private final Map<FailureKey, Integer> failures = new ConcurrentHashMap<>();
    /** '달력 없음'을 시장·날짜·빠진 해마다 한 번만 남기는 장부(클래스 설명). */
    private final CalendarGaps calendarGaps = new CalendarGaps();

    /** 오류 횟수를 세는 단위 — 시장 × 복기 주(그 시장 달력의 주 마지막 거래일). */
    private record FailureKey(String market, LocalDate week) {
    }

    @Autowired
    PaperReviewJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ReviewService reviews,
                   PaperConfig config, ObjectMapper mapper, PaperMarkets markets) {
        this(store, reader, marketData, reviews, config, mapper, Clock.systemUTC(), markets);
    }

    /** 테스트용 — 시계를 움직입니다(시장 목록은 운영 목록). */
    PaperReviewJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ReviewService reviews,
                   PaperConfig config, ObjectMapper mapper, Clock clock) {
        this(store, reader, marketData, reviews, config, mapper, clock, new PaperMarkets(store, reader));
    }

    /** 테스트용 — 시계와 시장 목록을 바꿉니다(시장 격리 시험이 시험용 한국 시장을 넣음). */
    PaperReviewJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ReviewService reviews,
                   PaperConfig config, ObjectMapper mapper, Clock clock, List<PaperMarket> markets) {
        this(store, reader, marketData, reviews, config, mapper, clock, new PaperMarkets(store, reader, markets));
    }

    private PaperReviewJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ReviewService reviews,
                           PaperConfig config, ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.reviews = reviews;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = markets;
    }

    /**
     * 정기 실행 — 시장마다 차례로 한 번({@link PaperMarkets#all}, 클래스 설명). 꺼져 있으면 아무것도 하지 않습니다. 예외는 삼키고
     * 로그만(결정 작업과 같은 관례) — 한 시장의 예외가 다음 시장을 막지 않습니다.
     */
    @Scheduled(initialDelayString = "${dashboard.paper.review-initial-delay-ms:180000}",
            fixedDelayString = "${dashboard.paper.review-interval-ms:1800000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        for (PaperMarket market : markets.all()) {
            try {
                Result result = run(market);
                switch (result.outcome()) {
                    case REVIEWED, SKIPPED -> log.info("주간 복기 작업: {} {} — {}", result.weekEnding(), result.outcome(),
                            result.review() == null ? "" : result.review().status());
                    case ERROR -> log.warn("주간 복기 작업 오류({}) — {}", result.weekEnding(), result.message());
                    case CAP_REACHED, BUSY -> log.info("주간 복기 작업: {}", result.message());
                    default -> log.debug("주간 복기 작업: {} {}", result.outcome(), result.message());
                }
            } catch (RuntimeException e) {
                log.warn("주간 복기 작업 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
            }
        }
    }

    /** 미국 시장 정기 실행 한 번 — {@link #run(PaperMarket)}의 미국 판. 테스트가 부릅니다. */
    Result run() {
        return run(UsPaperMarket.INSTANCE);
    }

    /**
     * 그 시장의 정기 실행 한 번(클래스 설명의 순서). 수동 실행이 잠금을 쥐고 있으면 기다리지 않고 {@value #BUSY}. 복기 중 예외는 그
     * 시장·그 주의 오류 횟수를 올리고 {@value #ERROR}로 기록합니다.
     */
    Result run(PaperMarket market) {
        String dormant = dormantReason(market);
        if (dormant != null) {
            return new Result(DORMANT, null, null, dormant);
        }
        if (!running.tryLock()) {
            return new Result(BUSY, null, null, "수동 복기가 진행 중 — 이번 주기는 건너뛰고 다음 주기에 다시 봅니다");
        }
        Instant now = clock.instant();
        MarketRun run = null;
        try {
            // 이 실행의 시장 문맥 — 복기 주·여는 순간·확정 종가 판정·복기 입력이 같은 달력 한 벌(PaperMarkets#open).
            run = markets.open(market);
            return runLocked(run, now, true);
        } catch (RuntimeException e) {
            LocalDate week = ReviewFacts.latestCompletedWeekEnding((run != null ? run : market).calendar(), now);
            int attempt = failures.merge(new FailureKey(market.code(), week), 1, Integer::sum);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("weekEnding", week.toString());
            detail.put("error", message(e));
            detail.put("attempt", attempt);
            record(market, now, ERROR, detail);
            return new Result(ERROR, week, null, message(e));
        } finally {
            running.unlock();
        }
    }

    /**
     * POST /api/paper/reviews/run — 지금 마감이 끝난 가장 최근 복기 주를 지금 복기합니다. 토요일 09:00 시각 조건만 빼고 정기 실행과 같은
     * 조건이며, 그 주의 행이 이미 있으면 부르지 않고 그 행을 돌려줍니다(API 오류였으면 한 번 다시 부름).
     *
     * @return {@code {ok, outcome, review}} — 테이블이 없으면 {@code {available:false, ok:false, message}}
     * @throws InvalidRequestException  Claude 계좌가 운용 중이 아님·출발일이 그 주 전이 아님·확정 종가가 아직 없음·하루 호출 상한·
     *                                  그 시장 달력이 앞 창의 해를 모름('달력 없음' — 명세 K35)
     * @throws TooManyRequestsException 다른 복기 실행이 진행 중
     */
    public Map<String, Object> runNow() {
        return runNow(UsPaperMarket.INSTANCE);
    }

    /** 그 시장의 수동 복기 — {@link #runNow()}와 같되 그 시장의 주·책·관측치·기록 이름으로. */
    Map<String, Object> runNow(PaperMarket requested) {
        String dormant = dormantReason(requested);
        if (dormant != null) {
            throw new InvalidRequestException(dormant);
        }
        if (!running.tryLock()) {
            throw new TooManyRequestsException("다른 주간 복기가 진행 중입니다 — 끝난 뒤 다시 누르세요.", BUSY_RETRY);
        }
        try {
            Instant now = clock.instant();
            MarketRun market = markets.open(requested);
            // 그 주의 오류 횟수를 지웁니다 — 수동 실행은 포기한 주도 다시 시도합니다(결정 작업의 수동 실행과 같음).
            LocalDate week;
            try {
                market.requireCalendarWindow(now);
                week = ReviewFacts.latestCompletedWeekEnding(market.calendar(), now);
            } catch (CalendarUnavailableException e) {
                throw new InvalidRequestException(e.getMessage());
            }
            failures.remove(new FailureKey(market.code(), week));
            Result result = runLocked(market, now, false);
            switch (result.outcome()) {
                case NOT_READY -> {
                    Map<String, Object> out = ReviewService.notReady();
                    out.put("ok", false);
                    return out;
                }
                case NOT_ACTIVE, WAITING_FINAL_CLOSE, CAP_REACHED, NO_CALENDAR ->
                        throw new InvalidRequestException(result.message());
                default -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("ok", true);
                    out.put("outcome", result.outcome());
                    out.put("review", result.review() == null ? null : reviews.reviewView(result.review()));
                    return out;
                }
            }
        } finally {
            running.unlock();
        }
    }

    /**
     * 출발일·계좌가 갖춰지지 않은 시장이면 그 사유({@link PaperMarket#dormantReason}) — 실행을 열기 전에 봅니다(저장본을 읽지 않게). 테이블이
     * 없으면 보지 않습니다(그 판정은 {@value #NOT_READY}).
     */
    private String dormantReason(PaperMarket market) {
        if (!store.ready()) {
            return null;
        }
        return market.dormantReason(config, () -> !store.books(market.code()).isEmpty());
    }

    /** 조건을 보고(클래스 설명) 복기합니다. {@code scheduled}가 거짓(수동)이면 토요일 시각 조건과 포기 횟수를 보지 않습니다. */
    private Result runLocked(PaperMarket market, Instant now, boolean scheduled) {
        if (!store.ready()) {
            return new Result(NOT_READY, null, null, PaperQueryService.NOT_READY_MESSAGE);
        }
        try {
            market.requireCalendarWindow(now);
            calendarGaps.clear(market);
        } catch (CalendarUnavailableException e) {
            // 그 시장 달력이 앞 창의 해를 모름(명세 K35) — 복기하지 않고, 정기 실행은 하루 한 번 '달력 없음'으로 남깁니다.
            if (scheduled && calendarGaps.firstToday(market, now, e)) {
                record(market, now, NO_CALENDAR, CalendarGaps.detail(e));
                log.warn("주간 복기 작업({}) — {}", market.code(), e.getMessage());
            }
            return new Result(NO_CALENDAR, null, null, e.getMessage());
        }
        LocalDate week = ReviewFacts.latestCompletedWeekEnding(market.calendar(), now);
        Instant opens = market.reviewOpening(week);
        if (scheduled && now.isBefore(opens)) {
            return new Result(TOO_EARLY, week, null, "복기 시각 " + Kst.stamp(opens) + " 전");
        }
        Optional<Review> existing = store.review(market.code(), week);
        if (existing.isPresent() && !ReviewService.retryable(existing.get())) {
            return new Result(ALREADY_REVIEWED, week, existing.get(), week + " 복기를 이미 남겼습니다("
                    + existing.get().status() + ")");
        }
        String inactive = inactiveReason(store.book(market.claudeBook()), week);
        if (inactive != null) {
            return new Result(NOT_ACTIVE, week, null, inactive);
        }
        if (!finalCloseIn(market, week)) {
            return new Result(WAITING_FINAL_CLOSE, week, null, week + " 확정 종가가 아직 없습니다 — 장부의 확정 순자산 줄이나, "
                    + "마감 뒤 수집한 관측치를 장부가 반영해 그날 순자산 줄을 남긴 뒤 복기합니다(장중 값으로 금요일 수익률을 만들지 않게)");
        }
        if (scheduled && failures.getOrDefault(new FailureKey(market.code(), week), 0) >= MAX_ATTEMPTS) {
            return new Result(GAVE_UP, week, null, week + " 복기 오류가 " + MAX_ATTEMPTS + "번 나 정기 실행은 더 시도하지 않습니다 "
                    + "— 수동 실행(POST /api/paper/reviews/run)은 다시 시도합니다");
        }
        ReviewService.Outcome outcome = reviews.review(market, week);
        failures.remove(new FailureKey(market.code(), week));
        return switch (outcome.kind()) {
            case EXISTING -> new Result(ALREADY_REVIEWED, week, outcome.review(), week + " 복기를 이미 남겼습니다");
            case CAP_REACHED -> new Result(CAP_REACHED, week, null, outcome.message());
            case SKIPPED -> recorded(market, now, SKIPPED, week, outcome.review(), scheduled, outcome.message());
            case CALLED -> recorded(market, now, REVIEWED, week, outcome.review(), scheduled, null);
        };
    }

    private Result recorded(PaperMarket market, Instant now, String outcome, LocalDate week, Review review,
                            boolean scheduled, String message) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("weekEnding", week.toString());
        detail.put("manual", !scheduled);
        detail.put("status", review.status());
        detail.put("windowWeeks", review.windowWeeks());
        detail.put("retryCount", review.retryCount());
        detail.put("proposalId", review.proposalId());
        detail.put("error", review.error());
        record(market, now, outcome, detail);
        return new Result(outcome, week, review, message);
    }

    /**
     * Claude 계좌가 그 주를 복기할 상태가 아니면 이유, 맞으면 null — 운용 중(ACTIVE)이고 출발일이 복기 주 <b>전</b>이어야 합니다(출발한
     * 주는 초기 결정뿐이라 그 뒤 가격과 대조할 것이 없음). 일시정지 중이면 복기하지 않습니다(재개한 뒤 다음 기회에).
     */
    static String inactiveReason(Optional<Book> book, LocalDate week) {
        if (book.isEmpty()) {
            return "Claude 계좌가 없습니다 — 먼저 초기화(POST /api/paper/init)를 누르세요.";
        }
        if (PaperBooks.NOT_STARTED.equals(book.get().status())) {
            return "Claude 계좌가 아직 시작 전입니다 — 복기할 결정이 없습니다.";
        }
        if (!PaperBooks.ACTIVE.equals(book.get().status())) {
            return "Claude 계좌가 일시정지 중이라 복기하지 않습니다 — 재개한 뒤 다음 기회에 복기합니다.";
        }
        LocalDate startedOn = book.get().startedOn();
        if (startedOn == null || !startedOn.isBefore(week)) {
            return "Claude 계좌 출발일(" + startedOn + ")이 복기 주(" + week + ") 전이 아닙니다 — 출발한 주는 초기 결정뿐이라 "
                    + "복기하지 않습니다.";
        }
        return null;
    }

    /** 미국 Claude 책 기준 — {@link #finalCloseIn(PaperMarket, LocalDate)}의 미국 판. */
    boolean finalCloseIn(LocalDate week) {
        return finalCloseIn(UsPaperMarket.INSTANCE, week);
    }

    /**
     * 그 주 기준일의 확정 종가가 들어왔나(클래스 설명) — 그 시장 Claude 계좌의 w 확정 순자산 줄, 또는 그 시장 관측치 저장본의 확정 종가 +
     * 장부가 남긴 w 순자산 줄(확정이 아니어도).
     */
    boolean finalCloseIn(PaperMarket market, LocalDate week) {
        Optional<PaperStore.NavRow> row = store.navSeries(market.claudeBook()).stream()
                .filter(r -> week.equals(r.tradingDate())).findFirst();
        if (row.isEmpty()) {
            return false;   // 장부가 아직 그 세션을 반영하지 않음 — 지금 열면 계좌 비교가 전부 null로 굳습니다(클래스 설명)
        }
        if (row.get().pricesFinal()) {
            return true;
        }
        return reader.quietly(() -> marketData.quotes(market)).map(q -> PaperDecisionJob.closesFor(market, q, week))
                .orElse(false);
    }

    private void record(PaperMarket market, Instant started, String outcome, Map<String, Object> detail) {
        try {
            store.recordJobRun(market.jobName(JOB), started, clock.instant(), outcome, mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            // 기록 실패가 복기(이미 커밋됨)를 오류로 바꾸지 않게 로그만 남깁니다.
            log.warn("주간 복기 작업 기록을 남기지 못했습니다: {}", e.toString());
        }
    }

    private static String message(RuntimeException e) {
        return e.getClass().getSimpleName() + " " + e.getMessage();
    }
}
