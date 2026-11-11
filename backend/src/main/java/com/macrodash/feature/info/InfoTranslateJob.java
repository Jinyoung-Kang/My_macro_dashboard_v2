package com.macrodash.feature.info;

import com.macrodash.Kst;
import com.macrodash.store.TranslationStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 정보 수집 화면에 보일 제목을 미리 한국어로 번역해 두는 정기 작업(ADR 0037 결정 4).
 *
 * <ul>
 *   <li><b>대상</b>: 최근 사흘의 수집 글(블로그·속보 — 한국어 제목이 없는 것)과 미국 사건 뉴스 RSS 제목. 한글이 든 제목은 고르지 않습니다.</li>
 *   <li><b>묶음</b>: 한 번에 {@value InfoTranslator#TITLE_BATCH}개씩, 한 주기에 {@value #BATCHES_PER_RUN}묶음까지. 번역은 표에 저장되어 다시
 *       번역하지 않습니다.</li>
 *   <li><b>켜짐</b>: {@code dashboard.info.translate.enabled}(환경변수 INFO_TRANSLATE_ENABLED)가 켜진 곳에서만 — 운영 서버 덧붙임만 켭니다.
 *       같은 글을 두 곳에서 번역해 비용을 두 번 내지 않게. 화면의 번역 단추(수동)는 이 값과 무관합니다.</li>
 *   <li><b>실패</b>: 호출 실패(한도·시간 초과·키 없음 등)면 그 주기를 끝내고 {@value #BACKOFF_MINUTES}분 쉽니다. 모델이 거절했거나 응답을 읽지
 *       못한 묶음은 반으로 나눠 다시 보내 문제 제목 하나를 찾아내고, 그 제목은 재기동 전까지 다시 보내지 않습니다.</li>
 *   <li>수집기 표는 읽기만 합니다(ADR 0008). 수집을 일으키지 않습니다.</li>
 * </ul>
 */
@Service
public class InfoTranslateJob {

    static final int BATCHES_PER_RUN = 3;
    static final int LOOKBACK_DAYS = 3;
    static final int BACKOFF_MINUTES = 15;

    private static final Logger log = LoggerFactory.getLogger(InfoTranslateJob.class);
    /** 묶음을 나눠 다시 보낼 실패 — 내용 탓일 수 있는 것. 그 밖의 실패는 다시 보내도 같아 주기를 끝냅니다. */
    private static final Set<String> CONTENT_FAILURES = Set.of("REFUSAL", "PARSE", "MAX_TOKENS", "EMPTY");

    private final InfoTranslator translator;
    private final TranslationStore store;
    private final boolean enabled;
    private final Clock clock;
    /** 번역하지 못한 제목(이 프로세스 안) — 다시 보내지 않습니다. */
    private final Set<String> skipped = ConcurrentHashMap.newKeySet();
    private volatile Instant restUntil = Instant.EPOCH;

    @Autowired
    public InfoTranslateJob(InfoTranslator translator, TranslationStore store,
                            @Value("${dashboard.info.translate.enabled:false}") boolean enabled) {
        this(translator, store, enabled, Clock.systemUTC());
    }

    InfoTranslateJob(InfoTranslator translator, TranslationStore store, boolean enabled, Clock clock) {
        this.translator = translator;
        this.store = store;
        this.enabled = enabled;
        this.clock = clock;
    }

    /** 정기 실행 — 켜진 곳에서만. 예외는 로그로만. */
    @Scheduled(initialDelayString = "${dashboard.info.translate.initial-delay-ms:150000}",
            fixedDelayString = "${dashboard.info.translate.interval-ms:120000}")
    public void scheduledRun() {
        if (!enabled) {
            return;
        }
        try {
            run();
        } catch (RuntimeException e) {
            log.warn("제목 번역 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** @return 이번에 번역해 저장한 제목 수 */
    synchronized int run() {
        Instant now = clock.instant();
        if (now.isBefore(restUntil) || !store.ready()) {
            return 0;
        }
        List<String> pending = store.pendingTitles(now.minus(Duration.ofDays(LOOKBACK_DAYS)),
                        Kst.today(clock).minusDays(LOOKBACK_DAYS), InfoTranslator.TITLE_BATCH * BATCHES_PER_RUN + skipped.size())
                .stream().filter(title -> !skipped.contains(title) && title.length() <= InfoTranslator.TITLE_MAX_CHARS)
                .limit((long) InfoTranslator.TITLE_BATCH * BATCHES_PER_RUN).toList();
        int done = 0;
        for (int from = 0; from < pending.size(); from += InfoTranslator.TITLE_BATCH) {
            List<String> batch = pending.subList(from, Math.min(pending.size(), from + InfoTranslator.TITLE_BATCH));
            int got = translate(batch, now);
            if (got < 0) {
                break;
            }
            done += got;
        }
        if (done > 0) {
            log.info("정보 수집 제목 {}건을 한국어로 번역해 저장", done);
        }
        return done;
    }

    /** 묶음 하나 → 저장한 수. 주기를 끝내야 하는 실패면 -1(쉬는 시각을 정해 둠). */
    private int translate(List<String> batch, Instant now) {
        InfoTranslator.Titles result = translator.titles(batch);
        int got = (int) batch.stream().filter(result.translated()::containsKey).count();
        if (result.ok()) {
            // 응답에서 빠진 제목은 다음 주기에 다시 고릅니다 — 두 번 빠지지 않게 한 번 빠진 것은 건너뜁니다.
            batch.stream().filter(title -> !result.translated().containsKey(title)).forEach(skipped::add);
            return got;
        }
        if (!CONTENT_FAILURES.contains(result.errorKind())) {
            restUntil = now.plus(Duration.ofMinutes(BACKOFF_MINUTES));
            log.warn("제목 번역을 {}분 쉽니다: {} — {}", BACKOFF_MINUTES, result.errorKind(), result.error());
            return -1;
        }
        if (batch.size() == 1) {
            skipped.add(batch.get(0));
            log.warn("번역하지 못한 제목 하나를 건너뜁니다({}) — 재기동 전까지 다시 보내지 않음", result.errorKind());
            return got;
        }
        int half = batch.size() / 2;
        int left = translate(batch.subList(0, half), now);
        if (left < 0) {
            return -1;
        }
        int right = translate(batch.subList(half, batch.size()), now);
        return right < 0 ? -1 : left + right;
    }
}
