package com.macrodash.read;

import com.macrodash.store.StoreRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * 저장본에서 계산한 응답의 캐시 — 같은 저장본이면 다시 계산하지 않습니다.
 *
 * <p><b>왜</b> — 전체 스냅샷 텍스트·기관 유사도·스코어카드·교집합은 요청마다 수 MB 저장본을 훑어 계산합니다.
 * 저장본은 수집 주기(5분~하루)로만 바뀌는데 화면은 1분마다 다시 묻고, 동시 접속 50명에서 p95가 2~4초였습니다.
 *
 * <p><b>언제 버리는가</b> — 두 조건 중 하나면 다시 계산합니다.
 * <ol>
 *   <li><b>버전</b>: 저장본 전체의 최신 수집 시각({@link StoreRepository#latestCollectedAt()})이 바뀜. 어떤 저장본이든
 *       새로 쓰이면 모든 항목이 무효가 됩니다 — 어느 계산이 어느 저장본에 의존하는지 일일이 적지 않아도
 *       "새 데이터를 옛 계산으로 보여 주는" 일이 없습니다.</li>
 *   <li><b>시간</b>: {@value #MAX_AGE_SECONDS}초. 응답에는 {@code ageSeconds}·{@code stale} 같은 '지금 기준' 값이
 *       들어 있어, 오래 들고 있으면 신선도 표시가 그만큼 틀립니다. 화면의 자동 갱신(최소 60초)과 맞춥니다.</li>
 * </ol>
 * 항목 수는 {@value #MAX_ENTRIES}개까지(가장 오래 안 쓴 것부터 버림) — 스코어카드처럼 파라미터 조합이 많은 경로가
 * 메모리를 끝없이 늘리지 않게 합니다. 계산이 예외를 던지면 아무것도 저장하지 않습니다.
 *
 * <p><b>입력 규칙</b>(QA-1040, ADR 0052 — {@link #get(String, String, Supplier)}) — 위 두 조건은 넉넉하게 잡은 것이라, 혼자 쓰는 운영에서는 화면을 열 때
 * 거의 매번 다시 계산했습니다(5분 주기 태스크가 저장본 어느 하나를 새로 쓸 때마다 모두 무효, 그리고 60초). 13F 계열처럼 <b>읽는 입력을 다 적을 수 있고
 * 응답에 '지금 기준' 값이 없는</b> 계산은 컨트롤러가 그 입력의 판(입력 저장본들의 수집 시각·즐겨찾기 목록을 한 글로 줄인 것 — 서비스가 만듦)을 함께 넘깁니다.
 * 그 항목은 판이 같은 동안 {@value #INPUT_MAX_AGE_SECONDS}초(하루 — 판에 적지 못한 입력이 있을 때를 위한 상한)까지 그대로 쓰고, 다른 저장본이 새로
 * 쓰여도 버리지 않습니다. 판이 null이면(입력을 다 알 수 없음 — 저장본이 아직 없거나 DB 장애) 위의 두 조건으로 돌아갑니다. 같은 키는 한 번만 계산·동시
 * 실행 상한·429 규칙은 두 길이 같습니다. '지금 기준' 값({@code ageSeconds}·{@code stale})이나 오늘 날짜에 기대는 응답은 이 규칙을 쓰지 않습니다.
 *
 * <p><b>동시 실행 상한</b>(QA-131) — 캐시를 놓쳐 다시 계산하는 요청은 동시에 {@code dashboard.compute.max-concurrent}개
 * (0이면 자동: 코어 수의 절반, 최소 1)까지만 돕니다. 상한이 없을 때 QA 스택에서 캐시에 없는 서로 다른 조합을 초당
 * 50건 부르자 {@code /api/health}까지 20초 안에 답하지 못했습니다. 자리가 없으면 공정한 순서(먼저 온 요청 먼저)로
 * {@value #WAIT_SECONDS}초 기다리고, 그래도 없거나 이미 {@value #MAX_WAITING}건이 기다리고 있으면
 * {@link ComputeBusyException}(→ 429 + {@code Retry-After})을 던집니다. 거절된 요청은 아무것도 저장하지 않습니다.
 * <ul>
 *   <li><b>같은 키는 한 번만 계산</b>합니다. 같은 키·같은 저장본 버전을 놓친 요청이 겹치면 먼저 온 하나(앞선 계산)만
 *       자리를 잡아 계산하고, 나머지는 자리도 대기열 자리도 잡지 않고 그 결과를 {@value #FOLLOW_TIMEOUT_SECONDS}초까지
 *       기다려 같은 객체를 받습니다. 앞선 계산이 던진 예외도 그대로 받고, 아무것도 저장하지 않았으니 다음 요청은 다시
 *       계산합니다. 그 안에 끝나지 않으면 429입니다. 따르는 요청은 모든 키를 합쳐 {@value #MAX_FOLLOWERS}건까지만
 *       기다리고, 넘으면 바로 429입니다. 이것이 없을 때 QA 스택에서 재기동 직후 5명이 무거운 화면을 한꺼번에 열자
 *       (요청 45건, 키 9개) 같은 키 요청이 각자 줄을 서 14–37건이 429였습니다.
 *       버전이 다르면 따로 계산합니다 — 새 저장본을 본 요청이 옛 버전 계산의 결과를 받지 않습니다.</li>
 *   <li>앞선 계산이 자리를 얻지 못해 429가 되면, 자기 자리 대기 한도(도착 뒤 {@value #WAIT_SECONDS}초)가 남은 따르는
 *       요청은 그 429를 받지 않고 다시 시도합니다 — 계산을 새로 맡아 남은 시간만 자리를 기다리거나(대기열 끝에 서므로
 *       도착 순서보다 뒤로 밀림) 그사이 다른 요청이 맡은 계산을 따릅니다. 한도가 끝났으면 같은 429를 받습니다. 그래서
 *       따르는 요청이 앞선 계산의 자리 대기 때문에 자기 한도보다 먼저 거절되지는 않지만, 한도는 요청마다
 *       {@value #WAIT_SECONDS}초 그대로라 재기동 직후처럼 키가 그 안에 끝낼 수 있는 계산 수(상한 × {@value #WAIT_SECONDS}초
 *       ÷ 계산 시간)보다 많으면 남는 키의 요청은 여전히 429입니다.</li>
 *   <li>캐시 적중은 자리를 잡지 않고 앞선 계산도 기다리지 않습니다 — 계산이 몰려도 이미 계산한 화면은 그대로 빠릅니다.</li>
 *   <li>버전이 없는 경로(DB 장애·저장본 0개)도 상한 밖입니다. DB가 죽었을 때 이 계산은 첫 DB 접근에서 실패하는데,
 *       자리를 쥐고 연결 대기(5초)를 하면 다른 요청이 503 'DB 연결 불가'(QA-009) 대신 429 '몰려 있음'을 받아 원인을
 *       잘못 알게 됩니다.</li>
 *   <li>놓친 뒤 앞선 계산이 막 끝나 같은 키·같은 버전이 채워졌으면 자리를 잡지 않고 그 값을 씁니다.</li>
 *   <li>한계(고치지 않음): auto·live_only 모드에서 저장본이 일부만 있으면(버전은 있음) 계산이 읽는 데이터셋 중 저장본이
 *       아예 없는 것은 {@link StoreReader}가 계산 안에서 수집을 기다립니다(수집기 대기 한도
 *       {@code dashboard.collector-timeout-seconds}, 기본 90초). 그동안 자리를 쥐고, 같은 수집에 합류한 다른 키의 계산도
 *       각자 자리를 쥡니다. 상한이 1개면 그사이 다른 새 계산은 {@value #WAIT_SECONDS}초 뒤 429입니다. 그 계산을 따르는
 *       같은 키 요청은 상한과 상관없이 {@value #FOLLOW_TIMEOUT_SECONDS}초 뒤 429입니다 — 같은 키를 한 번만 계산하기
 *       전에는 상한이 2개 이상이면 각자 자리에서 같은 수집에 합류해 값을 받았으므로, 이 경우는 그때보다 나빠졌습니다.
 *       첫 기동처럼 저장본이 일부만 있을 때만 겪고(같은 태스크는 10분 동안 다시 기다리지 않음), store_only(AWS)는 수집을
 *       기다리지 않아 해당 없습니다.</li>
 * </ul>
 * <b>서비스(계산 안)에서 이 캐시를 부르지 마세요</b>(ADR 0001: 컨트롤러만 씀). 부르면 다른 키는 자리를 쥔 채 또 자리를
 * 기다려(상한이 1개면 자기 자신을) {@value #WAIT_SECONDS}초 뒤 429, 같은 키·같은 버전은 자기 계산을 따르는 쪽이 되어 자기
 * 자신이 끝나기를 기다리다 {@value #FOLLOW_TIMEOUT_SECONDS}초 뒤 429로 끝납니다(그동안 자리를 쥠). 교착은 아닙니다.
 *
 * <p>돌려주는 객체는 캐시가 공유합니다. <b>받은 쪽에서 바꾸지 마세요.</b> 컨트롤러가 그대로 직렬화하는 용도입니다.
 */
@Component
public class ComputedCache {

    private static final Logger log = LoggerFactory.getLogger(ComputedCache.class);

    public static final long MAX_AGE_SECONDS = 60;
    /**
     * 입력 규칙({@link #get(String, String, Supplier)})의 항목을 들고 있는 시간 상한 — 13F 저장본을 신선하다고 보는 시간({@code Datasets.MAX_AGE_SLOW})과
     * 같은 하루. 입력의 판이 같으면 결과도 같으므로 평소에는 판이 먼저 바뀌고, 이 상한은 판에 적지 못한 입력이 있었을 때 옛 결과가 남는 시간을 묶습니다.
     */
    public static final long INPUT_MAX_AGE_SECONDS = 24 * 60 * 60;
    public static final int MAX_ENTRIES = 256;

    /** 자리가 날 때까지 기다리는 시간. 상한이 1개일 때 한 화면의 비싼 요청 2–3개가 줄 서도 거절되지 않을 만큼. */
    static final long WAIT_SECONDS = 2;
    /**
     * 이만큼 기다리고 있으면 새 요청은 기다리지 않고 바로 거절 — 자리를 기다리거나 계산하는 요청 스레드를 상한+이 수로
     * 묶습니다. 앞선 계산을 따르는 같은 키 요청은 여기에 들지 않고 따로 {@value #MAX_FOLLOWERS}건까지라, 계산 경로가 쥐는
     * 요청 스레드는 모두 상한+{@value #MAX_WAITING}+{@value #MAX_FOLLOWERS}개 안팎입니다.
     */
    static final int MAX_WAITING = 32;
    /**
     * 앞선 계산을 따르며 기다리는 요청 수(모든 키 합계)의 상한 — 넘으면 기다리지 않고 바로 거절. 따르는 요청은 자리도
     * 대기열 자리도 잡지 않으므로, 이것이 없으면 캐시에 없는 키마다 같은 요청을 몇 건씩 겹쳐 보내 요청 스레드(Tomcat
     * 기본 200개)를 모두 묶을 수 있습니다. 재기동 직후 묶음(요청 45건·키 9개 → 따르는 요청 36건)과 항목이 만료되는 순간의
     * 자주 읽는 키는 넉넉히 들어가고, 계산 경로 전체(상한+{@value #MAX_WAITING}+이 수)를 빼도 200개의 절반가량이
     * 캐시 적중·health·로그인 몫으로 남습니다.
     */
    static final int MAX_FOLLOWERS = 64;
    /**
     * 같은 키를 계산 중인 앞선 요청의 결과를 기다리는 시간. 자리 대기({@value #WAIT_SECONDS}초)와 무거운 계산(수 초)은
     * 넉넉히 덮고, 수집기를 기다리는 계산(최대 90초)에 요청 스레드를 끝까지 묶지는 않습니다. 앞선 계산이 자리를 얻지
     * 못하면 그때 끝나고, 따르던 요청은 자기 자리 대기 한도 안에서 다시 시도합니다.
     */
    static final long FOLLOW_TIMEOUT_SECONDS = 30;
    static final Duration RETRY_AFTER = Duration.ofSeconds(2);
    static final String BUSY_MESSAGE = "요청이 몰려 지금은 계산하지 못했습니다. 잠시 후 다시 시도하세요.";
    /** 거절 경고 로그 간격 — 부하 중 요청마다 찍어 로그(json-file 10m×3)를 넘기지 않게 묶습니다. */
    private static final long WARN_INTERVAL_NANOS = TimeUnit.SECONDS.toNanos(60);

    /** @param version 저장본 전체의 최신 수집 시각({@link Instant}) 또는 입력의 판({@link InputVersion}) — 두 규칙의 항목은 서로 같다고 보지 않습니다 */
    private record Cached(Object version, Instant storedAt, Object value) {
    }

    /** 입력 규칙의 버전 — 서비스가 넘긴 판 글. {@link Instant}(저장본 버전)와 종류가 달라 같은 키라도 섞이지 않습니다. */
    private record InputVersion(String text) {

        /** 계산 중 표의 키에 붙일 글 — '@'를 바꿔 적어(되돌릴 수 있게) 마지막 '@'로 키와 버전이 갈리는 약속을 지킵니다. */
        @Override
        public String toString() {
            return "in:" + text.replace("%", "%25").replace("@", "%40");
        }
    }

    /**
     * 앞선 계산의 결과 — 값 또는 예외. 예외도 future를 예외로 끝내지 않고 값으로 넘깁니다: {@link CompletableFuture#get}은
     * {@code CompletionException}을 벗겨 원인을 던지므로, 그러면 앞선 요청과 따르는 요청이 다른 예외를 받습니다.
     *
     * @param noSlot 앞선 계산이 자리를 얻지 못해 계산하지 않았음({@code error}는 그 429). 따르는 요청은 자기 자리 대기
     *               한도가 남았으면 이 429를 받지 않고 다시 시도합니다
     */
    private record Outcome(Object value, Throwable error, boolean noSlot) {

        static Outcome of(Object value) {
            return new Outcome(value, null, false);
        }

        static Outcome failed(Throwable error) {
            return new Outcome(null, error, false);
        }

        static Outcome rejected(ComputeBusyException busy) {
            return new Outcome(null, busy, true);
        }
    }

    private final StoreRepository repository;
    private final Clock clock;
    private final int maxConcurrent;
    private final Semaphore slots;
    private final Duration wait;
    private final int maxWaiting;
    private final Duration followTimeout;
    /**
     * 자리 대기 시한을 재는 시계(나노초). 테스트가 시간을 움직여, 따르던 계산이 거절됐을 때 남은 한도에 따른 동작을 실제로
     * 기다리지 않고 확인할 때 바꿔 끼웁니다. 세마포어에서 기다리는 시간 자체는 실제 시간입니다.
     */
    LongSupplier nanoTime = System::nanoTime;
    /**
     * 지금 도는 계산 — 키+버전마다 하나. 같은 키·같은 버전을 놓친 요청은 새로 계산하지 않고 이 결과를 기다립니다.
     * 계산을 맡은 요청이 끝날 때(값·예외 모두) 지웁니다.
     */
    private final ConcurrentHashMap<String, CompletableFuture<Outcome>> inflight = new ConcurrentHashMap<>();
    /** 지금 앞선 계산을 따르며 기다리는 요청 수(모든 키 합계). */
    private final AtomicInteger followers = new AtomicInteger();
    private final AtomicLong rejected = new AtomicLong();
    private final AtomicLong rejectedAtLastWarn = new AtomicLong();
    private final AtomicLong lastWarnNanos = new AtomicLong(System.nanoTime() - WARN_INTERVAL_NANOS);
    private final Map<String, Cached> entries = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Cached> eldest) {
                    return size() > MAX_ENTRIES;
                }
            });

    /**
     * @param maxConcurrent 동시에 돌 수 있는 다시 계산 수({@code COMPUTE_MAX_CONCURRENT}). 0이면 자동(코어 수의 절반, 최소 1)
     * @throws IllegalStateException 음수일 때 — 기동할 때 멈춥니다
     */
    @Autowired
    public ComputedCache(StoreRepository repository,
                         @Value("${dashboard.compute.max-concurrent:0}") int maxConcurrent) {
        this(repository, Clock.systemUTC(), resolveSlots(maxConcurrent), Duration.ofSeconds(WAIT_SECONDS), MAX_WAITING);
        log.info("비싼 계산 동시 실행 상한 {}개({}, 코어 {}개, 대기 {}초, 대기열 {}건, 같은 키는 앞선 계산을 {}초까지 기다림 · "
                        + "따르는 요청 {}건까지)",
                this.maxConcurrent, maxConcurrent == 0 ? "자동" : "COMPUTE_MAX_CONCURRENT",
                Runtime.getRuntime().availableProcessors(), WAIT_SECONDS, MAX_WAITING, FOLLOW_TIMEOUT_SECONDS,
                MAX_FOLLOWERS);
    }

    /** 상한은 자동(코어 수의 절반, 최소 1). */
    public ComputedCache(StoreRepository repository) {
        this(repository, Clock.systemUTC());
    }

    ComputedCache(StoreRepository repository, Clock clock) {
        this(repository, clock, defaultSlots(), Duration.ofSeconds(WAIT_SECONDS), MAX_WAITING);
    }

    /** 테스트가 자리 수·대기 시간·대기열 상한을 바꿔 끼울 수 있게 합니다. */
    ComputedCache(StoreRepository repository, Clock clock, int slots, Duration wait, int maxWaiting) {
        this(repository, clock, slots, wait, maxWaiting, Duration.ofSeconds(FOLLOW_TIMEOUT_SECONDS));
    }

    /** 앞선 계산을 기다리는 시간까지 바꿔 끼웁니다(테스트용). */
    ComputedCache(StoreRepository repository, Clock clock, int slots, Duration wait, int maxWaiting,
                  Duration followTimeout) {
        this.repository = repository;
        this.clock = clock;
        this.maxConcurrent = slots;
        this.slots = new Semaphore(slots, true);
        this.wait = wait;
        this.maxWaiting = maxWaiting;
        this.followTimeout = followTimeout;
    }

    /** 자동 상한: 코어 수의 절반, 최소 1. vCPU 2개(AWS)면 1개 — 나머지 코어는 적중·health·GC 몫으로 남깁니다. */
    static int defaultSlots() {
        return Math.max(1, Runtime.getRuntime().availableProcessors() / 2);
    }

    static int resolveSlots(int configured) {
        if (configured < 0) {
            throw new IllegalStateException(
                    "dashboard.compute.max-concurrent(COMPUTE_MAX_CONCURRENT)는 0(자동) 이상이어야 합니다: " + configured);
        }
        return configured == 0 ? defaultSlots() : configured;
    }

    /**
     * {@code key}의 계산 결과. 저장본 버전과 시간이 유효하면 저장된 값을, 아니면 계산 자리를 얻어 {@code compute}로
     * 새로 계산해 저장한 값을 돌려줍니다. 같은 키·같은 버전을 이미 계산 중이면 자리 없이 그 결과를 기다려 받습니다.
     * 저장본이 하나도 없거나 버전 조회에 실패하면 캐시도 상한도 거치지 않고 계산만 합니다.
     *
     * @throws ComputeBusyException 도착 뒤 {@value #WAIT_SECONDS}초 안에 계산 자리가 나지 않았거나(따르던 앞선 계산이 자리를
     *         얻지 못해 다시 시도한 경우 포함) 대기열이 가득 참, 따르는 요청이 이미 {@value #MAX_FOLLOWERS}건임, 또는 따르던
     *         앞선 계산이 {@value #FOLLOW_TIMEOUT_SECONDS}초 안에 끝나지 않음(→ 429)
     */
    public <T> T get(String key, Supplier<T> compute) {
        Instant version = currentVersion();
        if (version == null) {
            return compute.get();
        }
        return resolve(key, version, MAX_AGE_SECONDS, compute);
    }

    /**
     * 입력 규칙(클래스 설명) — {@code inputs}(그 계산이 읽는 입력의 판)가 같은 동안 {@value #INPUT_MAX_AGE_SECONDS}초까지 저장된 값을 돌려주고, 다른
     * 저장본이 새로 쓰여도 다시 계산하지 않습니다. {@code inputs}가 null이면 {@link #get(String, Supplier)}와 같습니다.
     *
     * <p>판은 계산이 읽는 것을 <b>빠짐없이</b> 담아야 합니다 — 빠진 입력이 바뀌면 상한까지 옛 결과가 남습니다. 응답에 '지금 기준' 값이 있으면 쓰지 마세요.
     *
     * @param inputs 입력의 판(서비스가 만든 글 — 같은 입력이면 같은 글). null이면 저장본 버전·60초 규칙
     * @throws ComputeBusyException {@link #get(String, Supplier)}와 같은 경우
     */
    public <T> T get(String key, String inputs, Supplier<T> compute) {
        if (inputs == null) {
            return get(key, compute);
        }
        return resolve(key, new InputVersion(inputs), INPUT_MAX_AGE_SECONDS, compute);
    }

    @SuppressWarnings("unchecked")
    private <T> T resolve(String key, Object version, long maxAgeSeconds, Supplier<T> compute) {
        Cached hit = fresh(key, version, maxAgeSeconds, clock.instant());
        if (hit != null) {
            return (T) hit.value();
        }
        // 키에 버전을 붙여, 새 저장본을 본 요청이 옛 버전 계산을 따르지 않게 합니다. Instant 문자열과 입력 판의 글(InputVersion.toString)에는
        // '@'가 없어 마지막 '@'로 둘이 갈리므로 서로 다른 (키, 버전)이 같은 문자열이 되지 않습니다.
        String flightKey = key + '@' + version;
        // 이 요청이 자리를 기다릴 수 있는 시한(도착 뒤 wait). 따르던 앞선 계산이 자리를 얻지 못해 다시 시도할 때도 이 안에서만.
        long deadline = nanoTime.getAsLong() + wait.toNanos();
        while (true) {
            CompletableFuture<Outcome> flight = new CompletableFuture<>();
            CompletableFuture<Outcome> ahead = inflight.putIfAbsent(flightKey, flight);
            if (ahead == null) {
                return (T) unwrap(lead(key, version, maxAgeSeconds, flightKey, flight, compute, deadline));
            }
            Outcome outcome = follow(ahead);
            if (outcome.noSlot() && nanoTime.getAsLong() - deadline < 0) {
                // 앞선 계산은 자리를 얻지 못했지만 이 요청의 한도는 남음 — 그 429를 받지 않고 계산을 새로 맡거나(대기열 끝에
                // 서서 남은 시간만 기다림) 그사이 다른 요청이 맡은 계산을 따릅니다. 앞선 계산은 결과를 넘기기 전에 맵에서
                // 지우므로, 다시 찾을 때 이미 끝난 계산을 또 따르지 않습니다.
                continue;
            }
            if (outcome.error() instanceof ComputeBusyException) {
                countRejection(); // 앞선 계산이 429 — 이 요청도 429로 돌아가므로 같이 셉니다
            }
            return (T) unwrap(outcome);
        }
    }

    /** 이 키·버전의 계산을 맡습니다. 결과(값·예외)는 {@code flight}로 따르는 요청에게도 같은 것을 넘깁니다. */
    private Outcome lead(String key, Object version, long maxAgeSeconds, String flightKey, CompletableFuture<Outcome> flight,
                         Supplier<?> compute, long deadline) {
        Outcome outcome;
        boolean acquired = false;
        try {
            // 놓친 뒤 여기까지 오는 사이 앞선 계산이 끝나 채워 두었으면 자리 없이 그 값을 씁니다. 자리를 얻은 뒤에는 다시
            // 볼 필요가 없습니다 — 같은 키·같은 버전은 이 요청만 계산하고, 다른 요청은 이 결과를 기다립니다.
            Cached filled = fresh(key, version, maxAgeSeconds, clock.instant());
            if (filled != null) {
                outcome = Outcome.of(filled.value());
            } else if (acquire(deadline)) {
                acquired = true;
                // 기다린 만큼 항목 수명이 줄지 않게, 저장 시각은 자리를 얻은 뒤로 잡습니다.
                Instant now = clock.instant();
                Object value = compute.get();
                entries.put(key, new Cached(version, now, value));
                outcome = Outcome.of(value);
            } else {
                outcome = Outcome.rejected(reject());
            }
        } catch (Throwable e) {
            // 따르는 요청도 같은 예외를 받습니다(계산의 400·500 그대로). 아무것도 저장하지 않았으므로 다음 요청은 다시
            // 계산합니다. Error도 넘겨, 따르는 요청이 대기 시간(30초)을 헛기다리다 429를 받지 않게 합니다.
            outcome = Outcome.failed(e);
        } finally {
            if (acquired) {
                slots.release();
            }
            // 결과를 넘기기 전에 지웁니다 — 그사이 온 요청이 이미 끝난 계산을 따라 지난 예외를 받지 않고 새로 맡게.
            inflight.remove(flightKey, flight);
        }
        flight.complete(outcome);
        return outcome;
    }

    /**
     * 같은 키·같은 버전을 계산 중인 앞선 요청의 결과를 기다립니다 — 자리도 대기열 자리도 잡지 않습니다. 이미
     * {@value #MAX_FOLLOWERS}건이 따르고 있으면 기다리지 않고 거절합니다.
     */
    private Outcome follow(CompletableFuture<Outcome> ahead) {
        if (followers.incrementAndGet() > MAX_FOLLOWERS) {
            followers.decrementAndGet();
            throw reject();
        }
        try {
            return ahead.get(followTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw reject();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw reject();
        } catch (ExecutionException e) {
            // 일어나지 않음: 앞선 계산은 예외도 Outcome 값으로 넘깁니다.
            throw new IllegalStateException("앞선 계산이 결과 없이 끝났습니다", e);
        } finally {
            followers.decrementAndGet();
        }
    }

    /** 결과의 값을 돌려주거나, 예외를 감싸지 않고 같은 인스턴스로 던집니다 — 앞선 요청과 따르는 요청이 같은 것을 받게. */
    private static Object unwrap(Outcome outcome) {
        if (outcome.error() != null) {
            throw ComputedCache.<RuntimeException>sneakyThrow(outcome.error());
        }
        return outcome.value();
    }

    /**
     * 검사 예외도 감싸지 않고 던집니다. {@code Supplier}는 검사 예외를 선언하지 않지만 몰래 던질 수는 있어서, 앞선
     * 요청이 그런 예외를 그대로 다시 던지던 것과 따르는 요청을 맞춥니다.
     */
    @SuppressWarnings("unchecked")
    private static <E extends Throwable> E sneakyThrow(Throwable e) throws E {
        throw (E) e;
    }

    /** 저장된 항목 수(관측·테스트용). */
    public int size() {
        return entries.size();
    }

    public void clear() {
        entries.clear();
    }

    /** 동시에 돌 수 있는 다시 계산 수(관측·테스트용). */
    int maxConcurrent() {
        return maxConcurrent;
    }

    /** 자리를 기다리는 요청 수 — 추정치(관측·테스트용). */
    int waiting() {
        return slots.getQueueLength();
    }

    /** 기동 뒤 429로 돌려보낸 누적 건수 — 자리 거절과 앞선 계산 대기 초과·거절을 함께 셉니다(관측·테스트용). */
    long rejectedCount() {
        return rejected.get();
    }

    /** 지금 도는 계산 수 — 키+버전마다 하나(관측·테스트용). */
    int inflight() {
        return inflight.size();
    }

    /** 앞선 계산을 따르며 기다리는 요청 수(관측·테스트용). */
    int followers() {
        return followers.get();
    }

    private Cached fresh(String key, Object version, long maxAgeSeconds, Instant now) {
        Cached hit = entries.get(key);
        if (hit != null && version.equals(hit.version())
                && Duration.between(hit.storedAt(), now).getSeconds() < maxAgeSeconds) {
            return hit;
        }
        return null;
    }

    /**
     * 계산 자리를 얻으면 true. 대기열이 이미 가득 찼거나, {@code deadline}(나노초)까지 자리가 나지 않았거나, 기다리다
     * interrupt되면(표시는 되살림) false입니다.
     */
    private boolean acquire(long deadline) {
        if (slots.getQueueLength() >= maxWaiting) {
            return false;
        }
        try {
            return slots.tryAcquire(Math.max(0, deadline - nanoTime.getAsLong()), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private ComputeBusyException reject() {
        countRejection();
        return new ComputeBusyException(BUSY_MESSAGE, RETRY_AFTER);
    }

    private void countRejection() {
        long total = rejected.incrementAndGet();
        long now = System.nanoTime();
        long last = lastWarnNanos.get();
        if (now - last >= WARN_INTERVAL_NANOS && lastWarnNanos.compareAndSet(last, now)) {
            long since = total - rejectedAtLastWarn.getAndSet(total);
            log.warn("비싼 계산 자리가 없거나 앞선 계산이 늦어 {}건을 429로 돌려보냈습니다(직전 경고 뒤로, 누적 {}건 · 상한 {}개 · "
                    + "대기 {}건 · 계산 중인 키 {}개 · 따르는 요청 {}건). 이 경고는 60초에 한 번만 남깁니다",
                    since, total, maxConcurrent, slots.getQueueLength(), inflight.size(), followers.get());
        }
    }

    private Instant currentVersion() {
        try {
            return repository.latestCollectedAt();
        } catch (RuntimeException e) {
            log.debug("저장본 버전 조회 실패 — 캐시 없이 계산합니다: {}", e.getMessage());
            return null;
        }
    }
}
