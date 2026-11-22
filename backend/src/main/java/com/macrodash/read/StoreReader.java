package com.macrodash.read;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 읽기 모드에 따른 저장본 접근 (구버전 {@code store.cached_or_live}에 해당).
 *
 * <p>규칙
 * <ul>
 *   <li><b>auto</b> — 저장본이 신선하면 그대로 씁니다. 오래됐으면 수집기에
 *       해당 태스크를 요청하되(기다리지 않음) 기존 저장본을 바로 돌려줍니다. 저장본이
 *       아예 없을 때만 수집을 기다린 뒤 다시 읽습니다. <b>오래된 저장본이라도 돌려줍니다</b>
 *       — 외부 장애 때 화면이 비는 것보다 낫고, 화면에는 수집 시각이 함께 표시되므로
 *       오해 여지가 없습니다.</li>
 *   <li><b>store_only</b> — 저장본만 씁니다. 오래됐어도 그대로 주고, 없으면
 *       비어 있다고 답합니다. "화면이 절대 외부를 기다리지 않는다"는 약속이
 *       신선도보다 우선입니다.</li>
 *   <li><b>live_only</b> — auto와 같되 신선한 저장본도 오래된 것으로 봅니다. 읽을 때마다 수집을
 *       비동기로 요청하고(같은 태스크는 {@link #TRIGGER_COOLDOWN_MS} 동안 한 번, 태스크가 없는 읽기는
 *       요청 없음) 저장본이 있으면 그대로 돌려줍니다. '수집한 뒤 읽기'가 아닙니다(디버깅용).</li>
 * </ul>
 *
 * <p>저장본이 아예 없어 수집을 기다렸는데도 여전히 없으면(키가 없거나 외부가 막힘,
 * 없는 CIK·시계열 등), 같은 태스크는 {@link #MISSING_RETRY_MS} 동안 다시 기다리지 않습니다.
 * 예전에는 요청마다 전체 수집을 다시 기다려, 없는 CIK 3개를 넣은 요청 하나가 13F 수집을
 * 6번 붙잡았습니다(수집기 대기 한도 90초씩, 그때마다 SEC 재크롤링).
 *
 * <p>수동 새로고침은 저장본을 지우지 않습니다. "이 시각 이전 저장본은 낡은
 * 것으로 본다"는 기준({@code refresh_requests})만 세웁니다. 저장본을 지우면
 * 수집이 실패했을 때 보여 줄 값이 아예 없어지기 때문입니다.
 */
@Service
public class StoreReader {

    /**
     * 같은 태스크 재요청을 억제하는 시간.
     *
     * <p>수집 자체가 보통 수 초~수십 초 걸리므로, 그 안에 다시 요청해 봐야
     * 같은 수집을 기다리게 될 뿐입니다.
     */
    private static final long TRIGGER_COOLDOWN_MS = 30_000;

    /**
     * 저장본이 없어 수집을 기다렸던 태스크를 다시 기다리기까지의 간격.
     *
     * <p>기다린 뒤에도 없던 데이터셋은 곧바로 다시 기다려도 결과가 같습니다. 이 시간이 지나면
     * (키를 넣었다든지 상황이 바뀌었을 수 있어) 다시 한 번 기다립니다. 그 사이에도 스케줄러는
     * 주기대로 수집하므로, 데이터가 생기면 다음 조회에서 바로 보입니다.
     */
    static final long MISSING_RETRY_MS = 10 * 60_000L;

    private final Map<String, Long> lastTriggeredAt = new ConcurrentHashMap<>();

    /** 태스크별 "저장본이 없어 기다린" 수집이 끝난 시각(ms). */
    private final Map<String, Long> lastAwaitedAt = new ConcurrentHashMap<>();

    /** 지금 기다리는 중인 수집. 같은 태스크를 기다리는 요청은 여기에 합류합니다. */
    private final Map<String, CompletableFuture<Boolean>> inFlightWaits = new ConcurrentHashMap<>();

    private static final Logger log = LoggerFactory.getLogger(StoreReader.class);

    private final StoreRepository repository;
    private final CollectorClient collector;
    private final AppProperties properties;
    private final Clock clock;

    @Autowired
    public StoreReader(StoreRepository repository,
                       CollectorClient collector,
                       AppProperties properties) {
        this(repository, collector, properties, Clock.systemUTC());
    }

    /** 테스트가 시각을 움직일 수 있게 시계를 받습니다. */
    StoreReader(StoreRepository repository,
                CollectorClient collector,
                AppProperties properties,
                Clock clock) {
        this.repository = repository;
        this.collector = collector;
        this.properties = properties;
        this.clock = clock;
    }

    public AppProperties.ReadMode readMode() {
        return properties.resolvedReadMode();
    }

    /** 이 스레드가 {@link #quietly}로 읽는 중인가. */
    private static final ThreadLocal<Boolean> QUIET = ThreadLocal.withInitial(() -> false);

    /**
     * 수집을 요청하지 않고 저장본만 읽는 구간(읽기 모드 {@code store_only}와 같은 동작).
     *
     * <p>정기 작업(판정 기록·알림 평가)용입니다. auto 모드에서는 저장본이 오래됐으면 <b>읽기만 해도</b>
     * 수집을 요청하므로, 정기 작업이 보통 경로로 읽으면 몇 분마다 수집기를 깨웁니다(ADR 0008).
     * 오래된 저장본을 어떻게 다룰지는 부르는 쪽이 정합니다.
     */
    public <T> T quietly(java.util.function.Supplier<T> work) {
        boolean outer = QUIET.get();
        QUIET.set(true);
        try {
            return work.get();
        } finally {
            QUIET.set(outer);
        }
    }

    /**
     * 저장본을 읽습니다. 필요하면 수집기에 수집을 요청합니다.
     *
     * @param name         데이터셋 이름
     * @param maxAgeSeconds 이 시간보다 오래되면 다시 수집
     * @param taskName     수집을 맡길 수집기 태스크 이름 (null이면 요청하지 않음)
     */
    public Optional<Snapshot> read(String name, long maxAgeSeconds, String taskName) {
        AppProperties.ReadMode mode = readMode();
        Optional<Snapshot> stored = repository.readSnapshot(name);

        if (mode == AppProperties.ReadMode.STORE_ONLY || QUIET.get()) {
            return stored;
        }

        boolean stale = stored.isEmpty()
                || !stored.get().isFresh(maxAgeSeconds)
                || supersededByRefresh(stored.get(), maxAgeSeconds);

        if (mode == AppProperties.ReadMode.AUTO && !stale) {
            return stored;
        }

        if (taskName == null) {
            return stored;
        }

        // ── 보여 줄 저장본이 이미 있으면 기다리지 않습니다 ──────────────
        // 이 프로젝트의 규칙입니다: "화면은 수집을 기다리지 않습니다."
        // 예전에는 수집이 끝날 때까지 붙잡고 있어서, 화면 한 번 여는 데
        // sec_13f 31.8초 · fred_series 11.5초가 그대로 대기 시간이 됐습니다.
        // 저장본은 신선도 배지가 "언제 수집한 값인지"를 이미 보여 주고,
        // 수집이 끝나면 다음 조회에서 새 값이 나옵니다.
        if (stored.isPresent()) {
            if (shouldTrigger(taskName)) {
                log.info("저장본이 오래됐습니다({}). 수집기에 '{}'를 요청하고, "
                        + "화면에는 기존 저장본을 먼저 보여 줍니다.", name, taskName);
                collector.runTask(taskName, false);
            }
            return stored;
        }

        // 보여 줄 것이 아예 없을 때만 기다립니다. 빈 화면보다는 나은 선택입니다.
        // 다만 방금 기다렸던 태스크면 다시 기다리지 않습니다 — 결과는 같고 시간만 버립니다.
        // 그 사이 수집이 끝났을 수 있으니 저장본은 한 번 더 읽습니다.
        if (awaitedRecently(taskName)) {
            log.debug("저장본이 없습니다({}). '{}'는 방금 기다렸으므로 다시 기다리지 않습니다.",
                    name, taskName);
            return repository.readSnapshot(name);
        }

        log.info("저장본이 없습니다({}). 수집기에 '{}' 태스크를 요청하고 기다립니다.",
                name, taskName);
        boolean accepted = awaitCollection(taskName);

        Optional<Snapshot> refreshed = repository.readSnapshot(name);
        if (refreshed.isPresent()) {
            return refreshed;
        }

        if (!accepted) {
            log.warn("수집 요청 실패({}). 남아 있는 저장본으로 대체합니다.", name);
        }
        return stored;
    }

    /**
     * 태스크 수집이 끝날 때까지 기다립니다. 같은 태스크를 이미 기다리는 요청이 있으면
     * 새로 요청하지 않고 그 수집에 합류합니다(첫 화면에서 여러 카드가 동시에 비어 있을 때).
     *
     * @return 수집기가 요청을 받았으면 true
     */
    private boolean awaitCollection(String taskName) {
        CompletableFuture<Boolean> mine = new CompletableFuture<>();
        CompletableFuture<Boolean> running = inFlightWaits.putIfAbsent(taskName, mine);
        if (running != null) {
            return running.join();
        }
        boolean accepted = false;
        try {
            accepted = collector.runTask(taskName, true).isPresent();
            return accepted;
        } finally {
            // 순서가 중요합니다: 끝난 시각을 먼저 남겨야, 그 사이에 들어온 요청이
            // 합류할 곳도 없고 "방금 기다림"도 못 보는 틈이 생기지 않습니다.
            lastAwaitedAt.put(taskName, clock.millis());
            inFlightWaits.remove(taskName, mine);
            mine.complete(accepted);
        }
    }

    private boolean awaitedRecently(String taskName) {
        Long finished = lastAwaitedAt.get(taskName);
        return finished != null && clock.millis() - finished < MISSING_RETRY_MS;
    }

    /**
     * 같은 태스크를 짧은 시간에 반복 요청하지 않도록 거릅니다.
     *
     * <p>화면 하나가 여러 스냅샷을 병렬로 읽으면 같은 태스크 요청이 그만큼
     * 나갑니다. 실제 로그에서 한 번의 페이지 로드에 fred_series 요청이
     * 7건이었습니다. 수집기가 합쳐 주기는 하지만, 애초에 보내지 않는 편이
     * 왕복과 실행 기록을 아낍니다.
     */
    private boolean shouldTrigger(String taskName) {
        long now = clock.millis();
        Long previous = lastTriggeredAt.get(taskName);
        if (previous != null && now - previous < TRIGGER_COOLDOWN_MS) {
            return false;
        }
        // 동시에 들어온 요청 중 하나만 통과시킵니다.
        Long raced = lastTriggeredAt.put(taskName, now);
        return raced == null || now - raced >= TRIGGER_COOLDOWN_MS;
    }

    /** 수집 요청 없이 저장본만 읽습니다. */
    public Optional<Snapshot> readStored(String name) {
        return repository.readSnapshot(name);
    }

    /**
     * 큰 배열 키 하나를 뺀 메타 정보만 — 수집을 요청하지 않고 캐시하지 않습니다({@link StoreRepository#readSnapshotMeta}).
     * 정기 작업·화면 어디서 불러도 수집기를 깨우지 않습니다.
     */
    public Optional<Snapshot> readStoredMeta(String name, String droppedKey) {
        return repository.readSnapshotMeta(name, droppedKey);
    }

    /** 저장본 여러 개의 머리(수집 시각·첫 분기 보고 기준일)만 — 수집을 요청하지 않고 캐시하지 않습니다({@link StoreRepository#readSnapshotHeads}). */
    public java.util.Map<String, StoreRepository.SnapshotHead> readStoredHeads(java.util.Collection<String> names) {
        return repository.readSnapshotHeads(names);
    }

    /**
     * 13F 형식 저장본의 보유 열만 — 수집을 요청하지 않고 캐시하지 않습니다({@link StoreRepository#readQuarterHoldings}).
     * 트랙레코드처럼 30분기 × 수천 줄을 읽는 곳이 씁니다.
     */
    public List<StoreRepository.HoldingRow> readStoredHoldings(String name) {
        return repository.readQuarterHoldings(name);
    }

    /**
     * 수동 새로고침 기준 시각 — HTTP 요청 하나 안에서는 한 번만 조회합니다.
     *
     * <p>신선한 저장본을 읽을 때마다 refresh_requests를 조회했습니다. 원본 텍스트 한 번에
     * 저장본 ~45개를 읽으니 같은 한 줄을 ~45번 읽었습니다. 요청 속성에 기억해 두면 같은
     * 요청의 반복 조회만 사라지고, 다음 요청은 새 값을 봅니다(시간 기반 캐시처럼 새로고침
     * 직후 옛 값을 볼 일이 없음). 요청 밖(테스트·배치)에서는 매번 조회합니다.
     */
    static final String REFRESH_MEMO_ATTRIBUTE = StoreReader.class.getName() + ".refreshRequestedAt";

    private Instant refreshRequestedAt() {
        RequestAttributes request = RequestContextHolder.getRequestAttributes();
        if (request == null) {
            return repository.refreshRequestedAt("global");
        }
        Object memo = request.getAttribute(REFRESH_MEMO_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
        if (memo instanceof Optional<?> cached) {
            return (Instant) cached.orElse(null);
        }
        Instant value = repository.refreshRequestedAt("global");
        request.setAttribute(REFRESH_MEMO_ATTRIBUTE, Optional.ofNullable(value), RequestAttributes.SCOPE_REQUEST);
        return value;
    }

    /**
     * 이 저장본이 수동 새로고침 요청보다 먼저 수집됐는지.
     *
     * <p>store_only 모드에서는 이 검사를 하지 않습니다. 외부를 부르지 않는다는
     * 약속이 우선이기 때문입니다(그 모드에서 새로고침은 저장본 재조회입니다).
     */
    private boolean supersededByRefresh(Snapshot snapshot, long maxAgeSeconds) {
        Instant requestedAt = refreshRequestedAt();
        if (requestedAt == null || snapshot.collectedAt() == null) {
            return false;
        }
        if (!snapshot.collectedAt().isBefore(requestedAt)) {
            return false;
        }
        // 방금 받은 것을 새로고침 버튼 때문에 또 받지는 않습니다.
        // (Datasets.minRefetchSeconds 주석에 이유를 적어 두었습니다.)
        return snapshot.ageSeconds() >= Datasets.minRefetchSeconds(maxAgeSeconds);
    }
}
