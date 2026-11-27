package com.macrodash.read;

import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 응답 캐시의 입력 규칙(QA-1040, ADR 0052) — 그 계산이 읽는 입력의 판이 같은 동안은 다른 저장본이 새로 수집돼도, 60초가 지나도 다시 계산하지 않는다.
 *
 * <p>예전 규칙(저장본 어느 것이든 새로 쓰이면 모두 버림 + 60초)에서는 5분 주기 태스크가 도는 운영에서 13F 계열 화면을 열 때 거의 매번 다시 계산했습니다
 * (스타일 요약 100 ms·유사도 250~280 ms, 즐겨찾기 19곳의 QA 500~600 ms). 예전 규칙을 쓰는 경로({@link ComputedCache#get(String, java.util.function.Supplier)})는
 * 그대로입니다({@code ComputedCacheTest}).
 */
class ComputedCacheInputRuleTest {

    private final StoreRepository repository = mock(StoreRepository.class);
    private final Instant t0 = Instant.parse("2026-11-27T00:00:00Z");

    private static final class MovableClock extends Clock {
        private volatile Instant now;

        MovableClock(Instant now) {
            this.now = now;
        }

        void plus(Duration amount) {
            now = now.plus(amount);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @Test
    @DisplayName("입력의 판이 같으면 5분 뒤에도, 다른 저장본이 새로 수집돼도 다시 계산하지 않는다 — 저장본 버전을 묻지도 않는다")
    void sameInputsSurviveTimeAndUnrelatedCollections() {
        MovableClock clock = new MovableClock(t0);
        ComputedCache cache = new ComputedCache(repository, clock);
        AtomicInteger computed = new AtomicInteger();

        Map<String, Object> first = cache.get("guru.profiles", "v1", () -> { computed.incrementAndGet(); return new HashMap<>(); });
        clock.plus(Duration.ofMinutes(5));
        when(repository.latestCollectedAt()).thenReturn(t0.plusSeconds(200));   // 다른 저장본이 새로 수집됨 — 이 규칙에서는 보지 않음
        Map<String, Object> second = cache.get("guru.profiles", "v1", () -> { computed.incrementAndGet(); return new HashMap<>(); });
        clock.plus(Duration.ofHours(6));
        Map<String, Object> third = cache.get("guru.profiles", "v1", () -> { computed.incrementAndGet(); return new HashMap<>(); });

        assertThat(computed.get()).isEqualTo(1);
        assertThat(second).isSameAs(first);
        assertThat(third).isSameAs(first);
        verify(repository, never()).latestCollectedAt();
    }

    @Test
    @DisplayName("입력의 판이 바뀌면 다음 요청에 다시 계산하고, 옛 판으로 돌아가도 옛 값을 주지 않는다")
    void changedInputsRecompute() {
        ComputedCache cache = new ComputedCache(repository, new MovableClock(t0));
        AtomicInteger computed = new AtomicInteger();

        cache.get("k", "v1", computed::incrementAndGet);
        cache.get("k", "v2", computed::incrementAndGet);
        cache.get("k", "v2", computed::incrementAndGet);
        cache.get("k", "v1", computed::incrementAndGet);

        assertThat(computed.get()).isEqualTo(3);
    }

    @Test
    @DisplayName("판이 같아도 하루(상한)가 지나면 다시 계산한다 — 판에 적지 못한 입력이 있을 때 옛 결과가 남는 시간을 묶음")
    void expiresAtTheUpperBound() {
        MovableClock clock = new MovableClock(t0);
        ComputedCache cache = new ComputedCache(repository, clock);
        AtomicInteger computed = new AtomicInteger();

        cache.get("k", "v1", computed::incrementAndGet);
        clock.plus(Duration.ofSeconds(ComputedCache.INPUT_MAX_AGE_SECONDS - 1));
        cache.get("k", "v1", computed::incrementAndGet);
        clock.plus(Duration.ofSeconds(2));
        cache.get("k", "v1", computed::incrementAndGet);

        assertThat(ComputedCache.INPUT_MAX_AGE_SECONDS).isEqualTo(24 * 60 * 60);
        assertThat(computed.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("판이 null이면(입력을 다 알 수 없음) 예전 규칙 그대로 — 저장본 버전이 바뀌거나 60초가 지나면 다시 계산한다")
    void nullInputsFallBackToSnapshotVersionRule() {
        MovableClock clock = new MovableClock(t0);
        ComputedCache cache = new ComputedCache(repository, clock);
        AtomicInteger computed = new AtomicInteger();
        when(repository.latestCollectedAt()).thenReturn(t0);

        cache.get("k", null, computed::incrementAndGet);
        cache.get("k", null, computed::incrementAndGet);
        assertThat(computed.get()).isEqualTo(1);

        clock.plus(Duration.ofSeconds(ComputedCache.MAX_AGE_SECONDS + 1));
        cache.get("k", null, computed::incrementAndGet);
        assertThat(computed.get()).isEqualTo(2);

        when(repository.latestCollectedAt()).thenReturn(t0.plusSeconds(300));
        cache.get("k", null, computed::incrementAndGet);
        assertThat(computed.get()).isEqualTo(3);
    }

    @Test
    @DisplayName("같은 키를 두 규칙이 번갈아 써도 서로의 값을 주지 않는다")
    void theTwoRulesDoNotShareEntries() {
        ComputedCache cache = new ComputedCache(repository, new MovableClock(t0));
        AtomicInteger computed = new AtomicInteger();
        when(repository.latestCollectedAt()).thenReturn(t0);

        cache.get("k", "v1", computed::incrementAndGet);
        cache.get("k", computed::incrementAndGet);
        cache.get("k", "v1", computed::incrementAndGet);

        assertThat(computed.get()).isEqualTo(3);
    }

    @Test
    @DisplayName("계산이 예외를 던지면 아무것도 저장하지 않는다 — 다음 요청이 다시 계산한다")
    void exceptionsAreNotCached() {
        ComputedCache cache = new ComputedCache(repository, new MovableClock(t0));
        AtomicInteger computed = new AtomicInteger();

        assertThatThrownBy(() -> cache.get("k", "v1", () -> { computed.incrementAndGet(); throw new IllegalArgumentException("400"); }))
                .isInstanceOf(IllegalArgumentException.class);
        cache.get("k", "v1", computed::incrementAndGet);

        assertThat(computed.get()).isEqualTo(2);
        assertThat(cache.size()).isEqualTo(1);
    }

    @Test
    @DisplayName("같은 키·같은 판을 함께 놓친 요청은 계산 하나를 기다려 같은 값을 받는다(예전 규칙과 같은 약속)")
    void sameKeyAndInputsShareOneComputation() throws Exception {
        ComputedCache cache = new ComputedCache(repository, new MovableClock(t0), 1, Duration.ofSeconds(2), 8);
        AtomicInteger computed = new AtomicInteger();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            Future<Object> lead = pool.submit(() -> cache.get("k", "v@1", () -> {
                computed.incrementAndGet();
                entered.countDown();
                await(release);
                return new Object();
            }));
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            Future<Object> followerA = pool.submit(() -> cache.get("k", "v@1", () -> { computed.incrementAndGet(); return new Object(); }));
            Future<Object> followerB = pool.submit(() -> cache.get("k", "v@1", () -> { computed.incrementAndGet(); return new Object(); }));
            while (cache.followers() < 2) {
                Thread.sleep(10);
            }
            release.countDown();

            Object value = lead.get(5, TimeUnit.SECONDS);
            assertThat(followerA.get(5, TimeUnit.SECONDS)).isSameAs(value);
            assertThat(followerB.get(5, TimeUnit.SECONDS)).isSameAs(value);
            assertThat(computed.get()).isEqualTo(1);
            assertThat(cache.inflight()).isZero();
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("판이 다른 요청은 앞선 계산을 따르지 않고 따로 계산한다 — 새 입력을 본 요청이 옛 입력의 결과를 받지 않는다")
    void differentInputsDoNotFollowEachOther() throws Exception {
        ComputedCache cache = new ComputedCache(repository, new MovableClock(t0), 2, Duration.ofSeconds(2), 8);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> old = pool.submit(() -> cache.get("k", "v1", () -> {
                entered.countDown();
                await(release);
                return "옛 입력";
            }));
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();

            assertThat(cache.<String>get("k", "v2", () -> "새 입력")).isEqualTo("새 입력");

            release.countDown();
            assertThat(old.get(5, TimeUnit.SECONDS)).isEqualTo("옛 입력");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
