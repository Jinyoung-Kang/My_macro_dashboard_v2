package com.macrodash.feature.search;

import com.macrodash.Kst;
import com.macrodash.store.AlertStore;
import com.macrodash.store.SearchWatchStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * 정보 검색 관심 대상의 새 글 알림(계약 docs/specs/2026-11-14-info-search-contract.md §9-5) — 15분마다 알림을 켠 줄({@code notify})을 보고, 새 글(§6-4의
 * 새 글 수와 같은 규칙) 가운데 지난 알림 뒤에 처음 받았고 처음 받은 지 {@link #FRESH} 안인 글이 한 건 이상이면 알림 사건 하나(종류 {@link #KIND})와 그 사용자의
 * 알림함 한 줄을 만들고 알린 시각을 고칩니다.
 *
 * <ul>
 *   <li>수집기가 모은 글 표({@code search_watch_items})를 읽기만 합니다 — 저장본({@code StoreReader})을 읽지 않으니 수집을 일으키지 않습니다
 *       ({@code StoreReader.quietly}와 같은 뜻, ADR 0008).</li>
 *   <li>알린 시각 고치기 → 사건 → 알림함을 한 트랜잭션으로 합니다. 중간에 실패하면 모두 되돌려 다음 실행이 같은 글로 다시 알립니다(두 번 알리지도, 잃지도
 *       않게). 알린 시각은 그 줄이 아직 켜져 있고 후보를 읽을 때의 값 그대로일 때만 고쳐(비교 후 설정), 그 사이 끈 줄·껐다 켠 줄·다른 실행이 먼저 알린 줄에는
 *       다시 알리지 않습니다.</li>
 *   <li>실행마다 배달이 남지 않은 이 종류의 사건(알림함 90일 정리·탈퇴 뒤)을 지웁니다 — 관심 대상 이름·글 제목이 든 한 사람의 내용이 전역 사건 표에 남지
 *       않게.</li>
 *   <li>회원에게는 운영자 전용 출처(수집 글·거장 견해·속보)의 글을 세지 않습니다(새 글 수와 같음). 텔레그램은 보내지 않고 알림함에만 넣으며, 읽지 않은 수에
 *       셉니다(지난 사건 아님). 모의 매매의 입력이 아닙니다.</li>
 *   <li>로그에는 줄 번호와 건수·예외 종류만 — 대상 키·이름·제목은 남기지 않습니다(결정 12).</li>
 * </ul>
 */
@Service
public class SearchWatchAlertJob {

    static final String KIND = "SEARCH_WATCH";
    /** 알리는 글 — 처음 받은 지 이만큼 안(오래 쌓인 새 글을 뒤늦게 알리지 않게). */
    static final Duration FRESH = Duration.ofHours(6);
    /** 본문 제목 한 줄의 상한(글자). */
    static final int MAX_TITLE = 200;

    private static final Logger log = LoggerFactory.getLogger(SearchWatchAlertJob.class);

    private final SearchWatchStore watches;
    private final AlertStore alerts;
    private final Clock clock;

    @Autowired
    public SearchWatchAlertJob(SearchWatchStore watches, AlertStore alerts) {
        this(watches, alerts, Clock.systemUTC());
    }

    SearchWatchAlertJob(SearchWatchStore watches, AlertStore alerts, Clock clock) {
        this.watches = watches;
        this.alerts = alerts;
        this.clock = clock;
    }

    /** 정기 실행(15분, 처음엔 알림 평가와 같은 90초 뒤). 예외는 로그 한 줄로만 — 다음 주기에 다시 봅니다. */
    @Scheduled(initialDelayString = "${dashboard.search.watch-alert-initial-delay-ms:90000}",
            fixedDelayString = "${dashboard.search.watch-alert-interval-ms:900000}")
    public void scheduledRun() {
        try {
            int delivered = run();
            if (delivered > 0) {
                log.info("관심 대상 새 글 알림 {}건을 알림함에 넣었습니다.", delivered);
            }
        } catch (RuntimeException e) {
            log.warn("관심 대상 새 글 알림 실패 — 다음 주기에 다시 봅니다: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * 한 번 봅니다. 줄마다 따로 실패합니다(한 줄의 예외가 다른 사용자의 알림을 막지 않게). DB에 닿지 못하는 실패는 나머지 줄도 같은 이유로 실패하므로 그대로
     * 던져 그 주기를 멈춥니다(알림 평가 {@code AlertEvaluator}와 같은 방식).
     *
     * @return 이번에 알림함에 넣은 건수
     */
    synchronized int run() {
        if (!watches.notifyReady() || !alerts.ready()) {
            return 0;               // V38 전에는 이 종류의 사건도 없음
        }
        // 사건 키·알린 시각에 같은 값을 쓰려고 초 단위로 맞춥니다(그 뒤 몇 분의 1초에 받은 글은 다음 실행에 셈).
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        List<SearchWatchStore.NotifyCandidate> candidates =
                watches.notifyCandidates(List.copyOf(SearchService.OWNER_ONLY_SOURCES), now.minus(FRESH), now);
        int delivered = 0;
        for (SearchWatchStore.NotifyCandidate candidate : candidates) {
            try {
                if (notify(candidate, now)) {
                    delivered++;
                }
            } catch (DataAccessResourceFailureException e) {
                throw e;
            } catch (RuntimeException e) {
                log.warn("관심 대상 알림 한 줄 실패(번호 {}) — 다음 주기에 다시 봅니다: {}", candidate.watchId(), e.getClass().getSimpleName());
            }
        }
        purgeUndelivered();
        return delivered;
    }

    /** 배달이 남지 않은 이 종류의 사건을 지움 — 실패해도 이번 알림은 그대로 두고 다음 실행에 다시 지웁니다. */
    private void purgeUndelivered() {
        try {
            alerts.purgeUndeliveredEvents(KIND);
        } catch (RuntimeException e) {
            log.warn("관심 대상 알림 사건 정리 실패 — 다음 주기에 다시 지웁니다: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * 한 줄 — 알린 시각을 먼저 고쳐 그 줄을 잠그고(후보를 읽은 뒤 끄거나 다른 실행이 먼저 알렸으면 거짓), 사건과 알림함 한 줄을 같은 트랜잭션에서 만듭니다.
     */
    private boolean notify(SearchWatchStore.NotifyCandidate candidate, Instant now) {
        String eventKey = "search_watch:" + candidate.watchId() + ":" + now;
        String title = "관심 대상 '%s' 새 글 %d건".formatted(candidate.name(), candidate.fresh());
        ObjectNode payload = JsonNodeFactory.instance.objectNode().put("href", href(candidate.entityKey()));
        LocalDate occurredOn = LocalDate.ofInstant(now, Kst.ZONE);
        Boolean done = watches.atomically(() -> {
            if (!watches.markNotified(candidate.watchId(), candidate.notifiedAt(), now)) {
                return false;
            }
            Optional<Long> event = alerts.insertEvent(KIND, eventKey, occurredOn, title, body(candidate.titles()), payload);
            if (event.isEmpty()) {
                // 같은 줄·같은 시각의 사건이 이미 있음 — 알린 시각을 되돌리려고 던집니다.
                throw new IllegalStateException("같은 사건 키가 이미 있습니다");
            }
            alerts.deliverInbox(event.get(), candidate.userId());
            return true;
        });
        return Boolean.TRUE.equals(done);
    }

    /** 그 대상의 타임라인 주소 — 키는 인자로 인코딩합니다(콜론은 그대로 둬 읽기 쉽게, 공백은 %20). */
    static String href(String entityKey) {
        String encoded = URLEncoder.encode(entityKey, StandardCharsets.UTF_8).replace("+", "%20").replace("%3A", ":");
        return "/search?e=" + encoded + "&tab=timeline";
    }

    /** 본문 — 최근 제목 {@link SearchWatchStore#NOTIFY_TITLES}개까지 한 줄씩(앞뒤 공백을 떼고 {@link #MAX_TITLE}자까지). */
    static String body(List<String> titles) {
        return titles.stream().limit(SearchWatchStore.NOTIFY_TITLES).map(String::strip).map(SearchWatchAlertJob::cut)
                .collect(Collectors.joining("\n"));
    }

    private static String cut(String text) {
        return text.codePointCount(0, text.length()) <= MAX_TITLE ? text : text.substring(0, text.offsetByCodePoints(0, MAX_TITLE));
    }
}
