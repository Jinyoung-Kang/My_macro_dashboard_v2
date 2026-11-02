package com.macrodash.feature.live;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * 화면 실시간 시세(ADR 0024) — 모의 매매 장중 카드·보유 표·종목 상세가 사용자가 고른 주기(5초~3시간)로 받는 가격.
 *
 * <p>저장하지 않습니다. 수집기 {@code /live/prices}(출처 순서·3초 캐시)를 그대로 전하고, SSE 구독이면 고른 주기마다 서버가 밀어 줍니다
 * (사용자 결정 2026-11-03 — 화면이 묻는 대신). 장부(체결·스탑·통계·결정)는 이 값을 쓰지 않습니다 — 그쪽은 기존 저장본(60초 하한)입니다.
 *
 * <ul>
 *   <li><b>주기</b>: {@link #INTERVALS}만. 구독하면 바로 한 번 보내고 그 뒤 주기마다. 받은 종목이 모두 장이 닫혀 있으면(CLOSED·모름) 다음은
 *       {@link #CLOSED_INTERVAL} 이상으로 늦춥니다 — 밤새 열어 둔 화면이 같은 값을 5초마다 묻지 않게.</li>
 *   <li><b>연결</b>: 연결 상한 {@link #MAX_STREAMS}, 25초마다 주석 줄(하트비트 — 끊긴 연결을 알아채고 앞단이 유휴로 끊지 않게), 연결 시간은
 *       주기 + 5분(브라우저 EventSource가 다시 잇고, 다시 이으면 바로 한 번 보냄).</li>
 *   <li><b>store_only</b>(저장본만 읽는 배포): 외부 호출을 일으키지 않고 {@code available:false}(DetailService와 같은 약속).</li>
 * </ul>
 */
@Service
public class LivePriceService {

    private static final Logger log = LoggerFactory.getLogger(LivePriceService.class);

    /** 미국·해외 — Yahoo 심볼 형식(^GSPC·KRW=X·BRK-B). */
    static final Pattern US_CODE = Pattern.compile("^[A-Z0-9^=.\\-]{1,24}$");
    /** 국내 — 6자리 대문자 영숫자(0088M0 같은 신규 코드 포함). */
    static final Pattern KR_CODE = Pattern.compile("^[0-9A-Z]{6}$");
    /** 트레이딩뷰 '거래소:심볼'(TVC:DXY·CME_MINI:ES1! — 시장 메뉴 카드). */
    static final Pattern TV_CODE = Pattern.compile("^[A-Z0-9_]{1,20}:[A-Z0-9_.!]{1,20}$");
    /** 네이버 해외 지수 로이터 코드(.INX·.NDX). */
    static final Pattern NI_CODE = Pattern.compile("^\\.[A-Z0-9]{1,10}$");
    static final int MAX_ITEMS = 60;
    /** 고를 수 있는 주기(초) — 화면의 선택지(lib/livePrices)와 같은 목록. */
    static final List<Integer> INTERVALS = List.of(5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 10800);
    static final Duration CLOSED_INTERVAL = Duration.ofMinutes(5);
    static final Duration HEARTBEAT = Duration.ofSeconds(25);
    static final Duration STREAM_SLACK = Duration.ofMinutes(5);
    static final int MAX_STREAMS = 20;

    private final StoreReader store;
    private final CollectorClient collector;
    private final ScheduledExecutorService scheduler;
    private final Set<Stream> streams = ConcurrentHashMap.newKeySet();

    public LivePriceService(StoreReader store, CollectorClient collector) {
        this.store = store;
        this.collector = collector;
        AtomicInteger counter = new AtomicInteger();
        this.scheduler = Executors.newScheduledThreadPool(4, runnable -> {
            Thread thread = new Thread(runnable, "live-prices-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    @PreDestroy
    void shutdown() {
        streams.forEach(Stream::close);
        scheduler.shutdownNow();
    }

    /**
     * 'US:AAPL,KR:005930,TV:TVC:DXY,NI:.INX' → 검사한 목록(시장은 대문자, 같은 것은 하나, 순서 유지). 시장은 US(Yahoo 심볼)·KR(6자리)·
     * TV(트레이딩뷰 '거래소:심볼')·NI(네이버 해외 지수).
     *
     * @throws InvalidRequestException 형식이 틀리거나 비었거나 {@link #MAX_ITEMS}를 넘음(400)
     */
    static List<String> items(String raw) {
        Set<String> out = new LinkedHashSet<>();
        for (String part : (raw == null ? "" : raw).split(",")) {
            String item = part.strip().toUpperCase(Locale.ROOT);
            if (item.isEmpty()) {
                continue;
            }
            int colon = item.indexOf(':');
            String market = colon < 0 ? "" : item.substring(0, colon);
            String code = colon < 0 ? "" : item.substring(colon + 1);
            boolean valid = (market.equals("US") && US_CODE.matcher(code).matches())
                    || (market.equals("KR") && KR_CODE.matcher(code).matches())
                    || (market.equals("TV") && TV_CODE.matcher(code).matches())
                    || (market.equals("NI") && NI_CODE.matcher(code).matches());
            if (!valid) {
                throw new InvalidRequestException("종목은 'US:심볼'·'KR:6자리'·'TV:거래소:심볼'·'NI:.지수'입니다.");
            }
            out.add(market + ":" + code);
        }
        if (out.isEmpty()) {
            throw new InvalidRequestException("종목이 없습니다.");
        }
        if (out.size() > MAX_ITEMS) {
            throw new InvalidRequestException("한 번에 " + MAX_ITEMS + "개까지입니다.");
        }
        return new ArrayList<>(out);
    }

    /** @throws InvalidRequestException 고를 수 있는 주기가 아님(400) */
    static int interval(Integer seconds) {
        if (seconds == null || !INTERVALS.contains(seconds)) {
            throw new InvalidRequestException("주기는 " + INTERVALS + "초 가운데 하나입니다.");
        }
        return seconds;
    }

    /** 지금 가격 한 번 → {@code {available, prices}}(수집기 응답 그대로) 또는 {@code {available:false, message}}. */
    public Map<String, Object> snapshot(String rawItems) {
        return read(String.join(",", items(rawItems)));
    }

    /** 구독 — 바로 한 번, 그 뒤 고른 주기마다 'prices' 이벤트로 {@link #snapshot}과 같은 본문을 보냅니다. */
    public SseEmitter stream(String rawItems, Integer seconds) {
        List<String> list = items(rawItems);
        int every = interval(seconds);
        if (streams.size() >= MAX_STREAMS) {
            throw new TooManyRequestsException("실시간 시세 연결이 너무 많습니다 — 다른 탭을 닫고 다시 여세요.", Duration.ofSeconds(30));
        }
        SseEmitter emitter = new SseEmitter(Duration.ofSeconds(every).plus(STREAM_SLACK).toMillis());
        Stream stream = new Stream(emitter, String.join(",", list), every);
        streams.add(stream);
        emitter.onCompletion(stream::close);
        emitter.onTimeout(stream::close);
        emitter.onError(error -> stream.close());
        stream.start();
        return emitter;
    }

    /** 지금 열린 구독 수(상태 화면·시험). */
    int openStreams() {
        return streams.size();
    }

    private Map<String, Object> read(String items) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (store.readMode() == AppProperties.ReadMode.STORE_ONLY) {
            out.put("available", false);
            out.put("message", "store_only 모드에서는 외부 시세를 조회하지 않습니다.");
            return out;
        }
        Optional<JsonNode> payload = collector.livePrices(items);
        if (payload.isEmpty()) {
            out.put("available", false);
            out.put("message", "수집기에서 응답을 받지 못했습니다.");
            return out;
        }
        out.put("available", true);
        out.put("prices", payload.get());
        return out;
    }

    /** 받은 종목 가운데 장이 열린(정규장·시간 외) 것이 하나라도 있으면 true — 없으면 다음 보내기를 늦춥니다. */
    static boolean anyTrading(Map<String, Object> body) {
        if (!(body.get("prices") instanceof JsonNode prices)) {
            return false;
        }
        for (JsonNode item : prices.path("items")) {
            String status = item.path("status").asString("");
            if (status.equals("OPEN") || status.equals("PRE") || status.equals("POST")) {
                return true;
            }
        }
        return false;
    }

    /** 다음 보내기까지(초) — 장이 닫혀 있으면 {@link #CLOSED_INTERVAL} 이상. */
    static long nextDelaySeconds(int every, boolean trading) {
        return trading ? every : Math.max(every, CLOSED_INTERVAL.toSeconds());
    }

    /** 구독 하나 — 주기 실행과 하트비트를 들고, 닫히면 둘 다 멈추고 목록에서 뺍니다. */
    private final class Stream {
        private final SseEmitter emitter;
        private final String items;
        private final int every;
        private final AtomicBoolean closed = new AtomicBoolean();
        private volatile ScheduledFuture<?> next;
        private volatile ScheduledFuture<?> heartbeat;

        Stream(SseEmitter emitter, String items, int every) {
            this.emitter = emitter;
            this.items = items;
            this.every = every;
        }

        void start() {
            next = scheduler.schedule(this::tick, 0, TimeUnit.SECONDS);
            heartbeat = scheduler.scheduleAtFixedRate(this::beat, HEARTBEAT.toSeconds(), HEARTBEAT.toSeconds(), TimeUnit.SECONDS);
        }

        private void tick() {
            if (closed.get()) {
                return;
            }
            Map<String, Object> body;
            try {
                body = read(items);
            } catch (RuntimeException e) {
                log.warn("실시간 시세 읽기 실패: {}", e.getMessage());
                body = Map.of("available", false, "message", "시세를 읽지 못했습니다.");
            }
            try {
                emitter.send(SseEmitter.event().name("prices").data(body, MediaType.APPLICATION_JSON));
            } catch (IOException | IllegalStateException e) {
                close();   // 브라우저가 닫았거나 연결이 끊김
                return;
            }
            if (!closed.get()) {
                next = scheduler.schedule(this::tick, nextDelaySeconds(every, anyTrading(body)), TimeUnit.SECONDS);
            }
        }

        private void beat() {
            try {
                emitter.send(SseEmitter.event().comment("keepalive"));
            } catch (IOException | IllegalStateException e) {
                close();
            }
        }

        void close() {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            streams.remove(this);
            ScheduledFuture<?> pending = next;
            if (pending != null) {
                pending.cancel(false);
            }
            ScheduledFuture<?> beating = heartbeat;
            if (beating != null) {
                beating.cancel(false);
            }
            try {
                emitter.complete();
            } catch (RuntimeException ignored) {
                // 이미 끝난 연결
            }
        }
    }
}
