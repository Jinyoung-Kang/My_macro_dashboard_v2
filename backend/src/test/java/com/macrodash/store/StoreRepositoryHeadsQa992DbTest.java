package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-992 — 기관 목록(13F 즐겨찾기)이 저장본 머리({@link StoreRepository#readSnapshotHeads})를 읽을 때마다 저장본 JSONB 전체를 풀어 첫 분기 보고 기준일
 * 한 칸을 꺼냄(운영 110~120 ms). 시간이 아니라 꼴로 봅니다: 같은 이름을 두 번 읽으면 둘째에는 본문({@code payload})을 푸는 질의가 나가지 않아야 합니다.
 * 고친 뒤(수집 시각이 같으면 기억한 기준일): 새로 수집된 저장본은 다음 읽기에 새 기준일이 보이고, 처음 보는 이름(즐겨찾기를 더한 직후)은 그 이름만 다시 읽습니다.
 * 테스트 DB의 이름표({@code t.…}) 저장본만 만들고 지웁니다.
 */
class StoreRepositoryHeadsQa992DbTest {

    private static final String Q8 = "t.sec.13f.0000000992.q8";
    private static final String Q30 = "t.sec.13f.0000000992.q30";

    private SqlRecorder recorder;
    private JdbcTemplate jdbc;
    private StoreRepository repository;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        recorder = new SqlRecorder(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(recorder.dataSource());
        repository = new StoreRepository(jdbc, new ObjectMapper());
        cleanUp();
        put(Q8, "2026-09-30");
        put(Q30, "2026-06-30");
        recorder.clear();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM snapshots WHERE name LIKE 't.%'");
    }

    private void put(String name, String reportDate) {
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb) ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, "
                        + "collected_at = clock_timestamp()",
                name, "{\"quarters\":[{\"reportDate\":\"" + reportDate + "\",\"holdings\":[]},{\"reportDate\":\"2026-03-31\",\"holdings\":[]}]}");
    }

    @Test
    @DisplayName("QA-992: 같은 저장본 머리를 두 번 읽으면 둘째에는 본문을 푸는 질의가 나가지 않는다")
    void secondReadDoesNotUnpackPayload() {
        List<String> names = List.of(Q8, Q30, "t.sec.13f.0000000992.missing");

        Map<String, StoreRepository.SnapshotHead> first = repository.readSnapshotHeads(names);
        long unpackedFirst = recorder.count("payload");
        recorder.clear();
        Map<String, StoreRepository.SnapshotHead> second = repository.readSnapshotHeads(names);

        assertThat(first.keySet()).containsExactlyInAnyOrder(Q8, Q30);
        assertThat(first.get(Q8).firstReportDate()).isEqualTo("2026-09-30");
        assertThat(second).isEqualTo(first);
        assertThat(unpackedFirst).as("처음에는 기준일을 읽음").isPositive();
        assertThat(recorder.count("payload")).as("둘째에는 본문을 풀지 않음").isZero();
    }

    @Test
    @DisplayName("저장본이 새로 수집되면 다음 읽기에 새 기준일이 보이고, 그 이름만 본문을 다시 읽는다")
    void recollectedSnapshotShowsNewReportDate() {
        repository.readSnapshotHeads(List.of(Q8, Q30));
        put(Q8, "2026-12-31");
        recorder.clear();

        Map<String, StoreRepository.SnapshotHead> heads = repository.readSnapshotHeads(List.of(Q8, Q30));

        assertThat(heads.get(Q8).firstReportDate()).isEqualTo("2026-12-31");
        assertThat(heads.get(Q30).firstReportDate()).isEqualTo("2026-06-30");
        assertThat(recorder.statements()).filteredOn(sql -> sql.contains("payload")).hasSize(1);
    }

    @Test
    @DisplayName("처음 보는 이름(즐겨찾기를 더한 직후)과 지워진 저장본 — 새 이름은 바로 보이고, 없어진 이름은 빠진다")
    void addedAndRemovedNames() {
        repository.readSnapshotHeads(List.of(Q8));
        String added = "t.sec.13f.0000000993.q8";
        put(added, "2026-09-30");
        jdbc.update("DELETE FROM snapshots WHERE name = ?", Q8);

        Map<String, StoreRepository.SnapshotHead> heads = repository.readSnapshotHeads(List.of(Q8, Q30, added));

        assertThat(heads.keySet()).containsExactlyInAnyOrder(Q30, added);
        assertThat(heads.get(added).firstReportDate()).isEqualTo("2026-09-30");
        assertThat(repository.readSnapshotHeads(List.of())).isEmpty();
    }
}
