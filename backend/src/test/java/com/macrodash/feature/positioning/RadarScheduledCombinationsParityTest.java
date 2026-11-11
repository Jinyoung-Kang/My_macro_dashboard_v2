package com.macrodash.feature.positioning;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 백엔드가 '수집기가 주기적으로 다시 받는 레이더 조합'으로 아는 목록이 수집기의 실제 스케줄 조합과 같은지 대조합니다(QA-395).
 *
 * <p>백엔드는 이 목록의 조합만 저장본을 먼저 돌려주고, 그 밖은 조회할 때마다 지금 받습니다. 한쪽만 바뀌면 — 수집기가 조합을 빼면
 * 그 저장본이 다시 갱신되지 않은 채 먼저 나가고, 더하면 이미 주기적으로 받는 조합을 조회마다 또 받습니다.
 * ({@code DatasetsParityTest}가 수집기 파일을 읽는 것과 같은 방식입니다.)
 */
class RadarScheduledCombinationsParityTest {

    private static final Path BASE = Path.of("../collector/app/tasks/base.py");

    @Test
    @DisplayName("스케줄 조합 목록이 수집기 RADAR_COMBINATIONS와 같다")
    void scheduledCombinationsMatchCollector() throws IOException {
        assumeTrue(Files.exists(BASE), "collector/app/tasks/base.py를 찾을 수 없습니다");
        String source = Files.readString(BASE);

        Matcher block = Pattern.compile("(?s)RADAR_COMBINATIONS\\s*=\\s*\\((.*?)\\n\\)").matcher(source);
        assertThat(block.find()).as("base.py에서 RADAR_COMBINATIONS 정의를 찾지 못했습니다").isTrue();

        List<List<String>> collector = new ArrayList<>();
        Matcher row = Pattern.compile("\\(\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*\\)")
                .matcher(block.group(1));
        while (row.find()) {
            collector.add(List.of(row.group(1), row.group(2), row.group(3), row.group(4)));
        }

        assertThat(collector).as("수집기 조합을 하나도 읽지 못했습니다").isNotEmpty();
        assertThat(RadarService.SCHEDULED_COMBINATIONS).containsExactlyInAnyOrderElementsOf(collector);
    }
}
