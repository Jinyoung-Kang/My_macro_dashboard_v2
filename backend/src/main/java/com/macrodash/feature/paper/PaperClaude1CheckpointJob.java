package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.SettingsRow;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 미국 Claude 계좌1 장중 확인(사용자 결정 2026-11-02 — '없음' → '세션당 한 번', {@link Claude1Checkpoint}). 정한 시각(뉴욕 {@code claude.checkpointAtEt},
 * 기본 12:00) 뒤에 그날 세션의 시간별 관측치가 저장되면 계좌1의 결정을 한 번 더 냅니다({@link ClaudeBookService#decideCheckpoint} — 종류
 * {@code CHECKPOINT}, 기준 거래일 = 그 세션 앞 거래일 d — 아침 결정과 같은 d).
 *
 * <p>부르는 조건: 설정을 켰고, 오늘(뉴욕)이 거래일이고, 지금이 [정한 시각, 마감 30분 전) 안이고, 계좌1이 운용 중이며 출발일이 d 이전이고, d의 아침
 * 정기 결정이 있고, d의 장중 확인 결정이 아직 없고, 지금 관측치 저장본이 정한 시각 뒤에 받은 그날 세션 판(최빈 봉 날짜 = 오늘)일 때. 창 안에서 자료를
 * 기다리는 동안은 아무것도 쓰지 않고 다음 주기에 다시 봅니다(5분마다). 창을 넘기면 그 세션은 건너뜁니다(기록 없음 — 결정 행이 없다는 것이 사실).
 *
 * <p>계좌2의 장중 확인({@link PaperCheckpointJob} — 아침 결정이 시각·자료를 고르는 시각 지정 체결용)과 따로 돌고, 계좌2의 기록·체결 시점 실험에는
 * 영향이 없습니다. 결정 작업의 잠금과 따로이고 장부를 바꾸는 쓰기는 결정 기록이 장부 잠금 안에서 합니다.
 */
@Component
public class PaperClaude1CheckpointJob {

    static final String JOB = "claude1-checkpoint";
    /** 마감 이만큼 전부터는 부르지 않습니다 — 통과 주문이 다음 시간별 관측치에 체결될 시간을 남김. */
    static final Duration BEFORE_CLOSE = Duration.ofMinutes(30);

    private static final Logger log = LoggerFactory.getLogger(PaperClaude1CheckpointJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final ClaudeBookService claude;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final TradingCalendar calendar = UsPaperMarket.INSTANCE.calendar();
    private final ReentrantLock running = new ReentrantLock();

    @Autowired
    PaperClaude1CheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
                              PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, claude, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperClaude1CheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
                              PaperConfig config, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.claude = claude;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /** 한 주기의 결과 — 부른 결정(없으면 null)과 부르지 않은 사유(부르면 null). */
    record Outcome(Decision decision, String reason) {
    }

    /** 정기 실행(5분마다) — 꺼져 있으면 아무것도 하지 않습니다. 예외는 로그로만. */
    @Scheduled(initialDelayString = "${dashboard.paper.claude1-checkpoint-initial-delay-ms:175000}",
            fixedDelayString = "${dashboard.paper.claude1-checkpoint-interval-ms:300000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            run();
        } catch (RuntimeException e) {
            log.warn("계좌1 장중 확인 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    Outcome run() {
        if (!running.tryLock()) {
            return new Outcome(null, "앞 주기가 도는 중");
        }
        try {
            return cycle();
        } finally {
            running.unlock();
        }
    }

    private Outcome cycle() {
        if (!store.ready()) {
            return new Outcome(null, "테이블 없음");
        }
        SettingsRow row = store.settings().orElse(null);
        Claude1Checkpoint settings = Claude1Checkpoint.from(row == null ? null : row.body());
        if (!settings.enabled()) {
            return new Outcome(null, "꺼짐(claude.checkpoint)");
        }
        Instant now = clock.instant();
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        if (!calendar.isTradingDay(session)) {
            return new Outcome(null, "거래일 아님");
        }
        Instant at = session.atTime(settings.atEt()).atZone(calendar.zone()).toInstant();
        Instant last = calendar.closeInstant(session).minus(BEFORE_CLOSE);
        if (now.isBefore(at) || !now.isBefore(last)) {
            return new Outcome(null, "창 밖(" + settings.atEt() + " ET ~ 마감 30분 전)");
        }
        Optional<Book> book = store.book(PaperBooks.CLAUDE);
        LocalDate asOf = calendar.previousTradingDay(session);
        if (book.isEmpty() || !PaperBooks.ACTIVE.equals(book.get().status()) || book.get().startedOn() == null
                || !book.get().startedOn().isBefore(session)) {
            return new Outcome(null, "계좌1이 운용 중이 아니거나 오늘 출발");
        }
        if (store.decisionFor(PaperBooks.CLAUDE, asOf, RuleBookService.SCHEDULED).isEmpty()) {
            return new Outcome(null, asOf + " 아침 결정 없음");
        }
        if (store.decisionFor(PaperBooks.CLAUDE, asOf, RuleBookService.CHECKPOINT).isPresent()) {
            return new Outcome(null, "이미 확인함");
        }
        Optional<Quotes> quotes = reader.quietly(marketData::quotes);
        if (quotes == null || quotes.isEmpty() || quotes.get().collectedAt() == null || quotes.get().collectedAt().isBefore(at)
                || !session.equals(quotes.get().modalBarDate())) {
            return new Outcome(null, "그 시각 뒤 그날 시간별 관측치 기다림");
        }
        Instant started = clock.instant();
        Decision decision = claude.decideCheckpoint(UsPaperMarket.INSTANCE, asOf);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("session", session.toString());
        detail.put("asOfTradingDate", asOf.toString());
        detail.put("atEt", settings.atEt().toString());
        detail.put("quotesCollectedAt", quotes.get().collectedAt().toString());
        detail.put("decisionId", decision.id());
        detail.put("status", decision.status());
        try {
            store.recordJobRun(JOB, started, clock.instant(), "OK", mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            log.warn("계좌1 장중 확인 작업 기록 실패: {}", e.toString());
        }
        log.info("Claude 계좌1 장중 확인 {} {} ET: {} — 결정 {}", session, settings.atEt(), decision.status(), decision.id());
        return new Outcome(decision, null);
    }
}
