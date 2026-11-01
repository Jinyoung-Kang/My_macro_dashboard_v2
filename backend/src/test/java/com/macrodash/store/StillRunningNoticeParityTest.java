package com.macrodash.store;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 좀비가 도는 동안의 empty 안내 행 앞머리를 수집기(Python)와 백엔드가 같게 쓰는지 대조합니다(QA-139).
 *
 * <p>한쪽만 바뀌면 백엔드의 '현재 오류'가 다시 그 안내 행을 최근 결과로 골라, 멈춘 태스크가 오류 목록에서 빠집니다.
 */
class StillRunningNoticeParityTest {

    private static final Path COLLECTOR_STORE = Path.of("../collector/app/store.py");

    @Test
    @DisplayName("STILL_RUNNING_PREFIX가 collector/app/store.py와 같다")
    void prefixMatchesCollector() throws IOException {
        assumeTrue(Files.exists(COLLECTOR_STORE), "collector/app/store.py를 찾을 수 없습니다");
        Matcher matcher = Pattern.compile("(?m)^STILL_RUNNING_PREFIX\\s*=\\s*\"([^\"]+)\"")
                .matcher(Files.readString(COLLECTOR_STORE));
        assertThat(matcher.find()).as("collector/app/store.py에 STILL_RUNNING_PREFIX가 있어야 함").isTrue();
        assertThat(matcher.group(1)).isEqualTo(StoreRepository.STILL_RUNNING_PREFIX);
    }
}
