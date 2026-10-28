package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.RegimeLogStore;
import com.macrodash.store.StoreRepository;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 Claude 계좌 시험 재료(2단계 명세 §4-7·§4-8·§4-10, E2b) — <b>실제</b> {@link ClaudeBookService}(운영 결정 문맥 둘 — 한국 패킷
 * {@link KrPacketBuilder}·한국 스키마·한국 렌더링·{@link KrClaudeValidation})에 가짜 AI(Mockito — 외부 호출 없음, 받은 요청을 남김)를 붙입니다.
 * 결정 작업·출발 시험이 한국 Claude 경로를 흉내 내지 않고 그대로 돌게.
 */
final class KrClaudeFixtures {

    private KrClaudeFixtures() {
    }

    /** 받은 요청 하나 — 모델·시스템 프롬프트·사용자 메시지(패킷 글자)·API 스키마·effort·대기 한도(초). */
    record Request(String model, String system, String user, Map<String, Object> schema, String effort,
                   int timeoutSeconds) {
    }

    /** 가짜 AI — 줄 세운 응답을 차례로 돌려주고(없으면 API 오류 500), 받은 요청을 남깁니다. */
    static final class FakeAi {

        final AiService ai = mock(AiService.class);
        final Deque<AiService.StructuredResult> answers = new ArrayDeque<>();
        final List<Request> requests = new CopyOnWriteArrayList<>();
        /** 부르는 사이에 할 일(시계를 기한 뒤로 옮기기 등) — 한 번 쓰고 비움. */
        volatile Runnable duringCall;

        @SuppressWarnings("unchecked")
        FakeAi() {
            when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                    .thenAnswer(invocation -> {
                        requests.add(new Request(invocation.getArgument(0), invocation.getArgument(1),
                                invocation.getArgument(2), (Map<String, Object>) invocation.getArgument(3),
                                invocation.getArgument(4), invocation.getArgument(5)));
                        Runnable hook = duringCall;
                        if (hook != null) {
                            duringCall = null;
                            hook.run();
                        }
                        synchronized (answers) {
                            return answers.isEmpty() ? failure("API_ERROR", "no answer queued") : answers.poll();
                        }
                    });
        }

        /** 정상 응답 하나(스키마를 지킨 JSON). */
        FakeAi answer(String json) {
            synchronized (answers) {
                answers.add(new AiService.StructuredResult(true, json, "end_turn", null, null, true, 21_000L, 3_100L,
                        7_800L, 0L, 1_234L));
            }
            return this;
        }

        /** 실패 응답 하나({@code API_ERROR}·{@code REFUSAL}·{@code RATE_LIMIT} 등 — 과금됨으로 둠). */
        FakeAi fail(String kind, String message) {
            synchronized (answers) {
                answers.add(failure(kind, message));
            }
            return this;
        }

        /** 429 하나 — 운영 분류({@code RATE_LIMIT}, 과금 안 됨)와 같은 모양(사용자 결정 w12의 기다린 재시도 시험). */
        FakeAi rateLimited() {
            synchronized (answers) {
                answers.add(new AiService.StructuredResult(false, null, null, ClaudeBookService.RATE_LIMIT_KIND,
                        "호출 한도에 걸렸습니다(429). 잠시 후 다시 시도하거나 다른 엔진을 고르세요.", false, null, null, null, null, 40L));
            }
            return this;
        }

        private static AiService.StructuredResult failure(String kind, String message) {
            return new AiService.StructuredResult(false, null, null, kind, message, true, null, null, null, null, 50L);
        }
    }

    /**
     * 실제 한국 결정 문맥의 Claude 계좌 서비스 — 대기 한도 300초(운영 기본값), 한국 패킷의 국면 기록은 비어 있음(가짜 — '없음'과 사유).
     *
     * @param ledger 결정 작업과 같은 장부(같은 잠금 — 시험이 넘김)
     */
    static ClaudeBookService service(FakePaperStore store, StoreReader reader, StoreRepository repository,
                                     PaperMarketData marketData, PaperLedgerService ledger, PaperConfig config,
                                     Clock clock, AiService ai) {
        return service(store, reader, repository, marketData, ledger, config, clock, ai, new FakeSleeper(clock));
    }

    /**
     * {@link #service(FakePaperStore, StoreReader, StoreRepository, PaperMarketData, PaperLedgerService, PaperConfig, Clock, AiService)}에
     * 출발 재시도 전 기다림({@link ClaudeBookService.Sleeper})을 넘긴 것 — 시험이 기다린 시간을 봅니다(실제로 기다리지 않음).
     */
    static ClaudeBookService service(FakePaperStore store, StoreReader reader, StoreRepository repository,
                                     PaperMarketData marketData, PaperLedgerService ledger, PaperConfig config,
                                     Clock clock, AiService ai, FakeSleeper sleeper) {
        PaperSettingsService settings = PaperFixtures.settings(store);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        RegimeLogStore regimeLog = mock(RegimeLogStore.class);
        KrPacketBuilder packets = ClaudeBookService.krPackets(store, reader, repository, regimeLog, marketData,
                new NoteService(store, settings), ledger, config, MAPPER, clock);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger, config, MAPPER,
                clock);
        ClaudeBookService service = new ClaudeBookService(store, reader, marketData, mock(PaperSelectionService.class),
                ledger, admin, mock(PacketBuilder.class), new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock),
                calls, ai, settings, config, MAPPER, ClaudeBookService.DEFAULT_TIMEOUT_SECONDS, clock, packets);
        service.sleeper(sleeper);
        return service;
    }

    /**
     * 가짜 기다림 — 실제로 기다리지 않고 받은 기다림을 차례로 남기며, 시계가 {@link KrFixtures.MovableClock}이면 그만큼 옮깁니다(429 뒤 30초 —
     * 사용자 결정 w12. 기다린 뒤의 남은 시간을 시험이 시계로 봄). {@link #overshoot}만큼 더 옮기면 늦게 끝난 기다림(운영의 {@code Thread.sleep}),
     * {@link #interrupt}면 기다리다 끊김({@link InterruptedException} — 종료·재배포)을 흉내 냅니다.
     */
    static final class FakeSleeper implements ClaudeBookService.Sleeper {

        final List<Duration> sleeps = new CopyOnWriteArrayList<>();
        private final Clock clock;
        /** 요청받은 시간보다 더 흐르는 시간(기본 0 — 기다림이 늦게 끝남). */
        volatile Duration overshoot = Duration.ZERO;
        /** true면 기다림을 남긴 뒤 시계를 옮기지 않고 끊김. */
        volatile boolean interrupt;

        FakeSleeper(Clock clock) {
            this.clock = clock;
        }

        @Override
        public void sleep(Duration duration) throws InterruptedException {
            sleeps.add(duration);
            if (interrupt) {
                throw new InterruptedException("시험용 — 기다리다 끊김");
            }
            if (clock instanceof KrFixtures.MovableClock movable) {
                movable.set(movable.instant().plus(duration).plus(overshoot));
            }
        }
    }

    /** 한국 결정 응답(결정 스키마 v2 — 한국 파일 {@value ClaudeBookService#KR_SCHEMA_RESOURCE}). */
    static String decision(double exposure, String noTradeReason, String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"NEUTRAL\",\"targetEquityExposurePct\":" + exposure
                + ",\"exposureRationale\":\"수급 확인\",\"summary\":\"한국 판단 요약\",\"orders\":["
                + String.join(",", orders) + "],\"noTradeReason\":"
                + (noTradeReason == null ? "null" : "\"" + noTradeReason + "\"")
                + ",\"watchlist\":[{\"ticker\":\"005930\",\"condition\":\"외국인 순매수 전환\"}],\"confidence\":0.5}";
    }

    /** 한국 주문 한 줄(timing NEXT_OPEN — 한국이 받는 시점뿐). */
    static String order(String ticker, String side, Double target, Double fraction) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"" + side + "\",\"targetWeightPct\":" + target
                + ",\"sellFraction\":" + fraction + ",\"timing\":\"NEXT_OPEN\",\"thesis\":\"" + ticker
                + " 논거\",\"labels\":[\"사실\",\"가설\"],\"invalidation\":\"수급 반전\"}";
    }
}
