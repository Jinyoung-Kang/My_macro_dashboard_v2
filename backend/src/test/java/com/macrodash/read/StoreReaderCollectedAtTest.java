package com.macrodash.read;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 수집 시각만 읽는 길({@link StoreReader#collectedAt})은 본문을 읽지 않지만, 낡은 저장본을 보면 {@link StoreReader#read}와 같은 규칙으로 수집을 요청한다(QA-1040).
 *
 * <p>계산 결과를 입력이 바뀔 때까지 기억하면 계산(=저장본 읽기)을 건너뛰게 됩니다. 그래도 화면을 열면 낡은 13F의 수집을 깨우던 동작이 남아야 합니다.
 */
class StoreReaderCollectedAtTest {

    private static final long DAY = 24 * 60 * 60L;
    private static final List<String> NAMES = List.of("sec.13f.0000000001.q8", "sec.13f.0000000002.q8");

    /** runTask(name, wait) 호출을 기록하는 가짜 수집기. */
    private static class RecordingCollector extends CollectorClient {
        final List<String> calls = new CopyOnWriteArrayList<>();

        RecordingCollector() {
            super(properties("auto"));
        }

        @Override
        public Optional<JsonNode> runTask(String taskName, boolean wait) {
            calls.add(taskName + (wait ? ":wait" : ":async"));
            return Optional.empty();
        }
    }

    private static AppProperties properties(String mode) {
        AppProperties props = new AppProperties();
        props.setCollectorUrl("http://localhost:1");
        props.setCollectorTimeoutSeconds(1);
        props.setReadMode(mode);
        return props;
    }

    private final StoreRepository repository = mock(StoreRepository.class);
    private final RecordingCollector collector = new RecordingCollector();

    private StoreReader reader(String mode) {
        return new StoreReader(repository, collector, properties(mode));
    }

    private void stored(Instant first, Instant second) {
        Map<String, Instant> rows = new LinkedHashMap<>();
        rows.put(NAMES.get(0), first);
        if (second != null) {
            rows.put(NAMES.get(1), second);
        }
        when(repository.readCollectedAt(NAMES)).thenReturn(rows);
    }

    @Test
    @DisplayName("모두 신선하면 수집 시각만 돌려주고 수집을 요청하지 않는다")
    void freshSnapshotsDoNotTrigger() {
        Instant now = Instant.now();
        stored(now.minusSeconds(60), now.minusSeconds(120));

        Map<String, Instant> out = reader("auto").collectedAt(NAMES, DAY, "sec_13f");

        assertThat(out).containsOnlyKeys(NAMES.get(0), NAMES.get(1));
        assertThat(collector.calls).isEmpty();
    }

    @Test
    @DisplayName("하나라도 오래됐으면 그 태스크를 기다리지 않고 요청한다 — 같은 태스크는 30초 안에 한 번만")
    void staleSnapshotTriggersOnceWithoutWaiting() {
        Instant now = Instant.now();
        stored(now.minusSeconds(60), now.minus(Duration.ofDays(3)));
        StoreReader reader = reader("auto");

        reader.collectedAt(NAMES, DAY, "sec_13f");
        reader.collectedAt(NAMES, DAY, "sec_13f");

        assertThat(collector.calls).containsExactly("sec_13f:async");
    }

    @Test
    @DisplayName("수동 새로고침 기준보다 먼저 수집된 저장본이면 신선해도 요청한다 — 다만 분기 공시는 받은 지 6시간 안이면 다시 받지 않는다(read와 같은 규칙)")
    void supersededByRefreshTriggers() {
        Instant now = Instant.now();
        when(repository.refreshRequestedAt("global")).thenReturn(now.minusSeconds(30));

        stored(now.minus(Duration.ofHours(3)), now.minus(Duration.ofHours(3)));
        reader("auto").collectedAt(NAMES, DAY, "sec_13f");
        assertThat(collector.calls).as("3시간 전에 받은 13F는 새로고침을 눌러도 다시 받지 않음(Datasets.minRefetchSeconds)").isEmpty();

        stored(now.minus(Duration.ofHours(3)), now.minus(Duration.ofHours(7)));
        reader("auto").collectedAt(NAMES, DAY, "sec_13f");
        assertThat(collector.calls).containsExactly("sec_13f:async");
    }

    @Test
    @DisplayName("store_only·조용히 읽기·태스크 없음이면 낡았어도 요청하지 않는다")
    void quietPathsNeverTrigger() {
        Instant old = Instant.now().minus(Duration.ofDays(3));
        stored(old, old);

        reader("store_only").collectedAt(NAMES, DAY, "sec_13f");
        StoreReader auto = reader("auto");
        auto.quietly(() -> auto.collectedAt(NAMES, DAY, "sec_13f"));
        auto.collectedAt(NAMES, DAY, null);
        assertThat(auto.readStoredCollectedAt(NAMES)).hasSize(2);

        assertThat(collector.calls).isEmpty();
    }

    @Test
    @DisplayName("live_only는 신선해도 요청한다(read와 같음)")
    void liveOnlyAlwaysTriggers() {
        Instant now = Instant.now();
        stored(now.minusSeconds(5), now.minusSeconds(5));

        reader("live_only").collectedAt(NAMES, DAY, "sec_13f");

        assertThat(collector.calls).containsExactly("sec_13f:async");
    }

    @Test
    @DisplayName("없는 이름은 결과에 없고, 여기서는 수집을 기다리지 않는다 — 그것은 계산이 read로 읽을 때의 일")
    void missingNamesAreAbsentAndNotAwaited() {
        stored(Instant.now().minusSeconds(60), null);

        Map<String, Instant> out = reader("auto").collectedAt(NAMES, DAY, "sec_13f");

        assertThat(out).containsOnlyKeys(NAMES.get(0));
        assertThat(collector.calls).isEmpty();
    }
}
