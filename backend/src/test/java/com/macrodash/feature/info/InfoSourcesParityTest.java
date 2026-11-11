package com.macrodash.feature.info;

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

/** 출처 표의 블로그 줄이 수집기의 블로그 표(collector/app/services/info_blogs.py BLOGS)와 같다 — 태스크·출처 키·이름·사이트 주소. */
class InfoSourcesParityTest {

    private static final Path BLOGS = Path.of("../collector/app/services/info_blogs.py");
    private static final Path REGISTRY = Path.of("../collector/app/tasks/info.py");

    @Test
    @DisplayName("블로그 줄이 수집기와 같다")
    void blogsMatchCollector() throws IOException {
        assumeTrue(Files.exists(BLOGS), "collector/app/services/info_blogs.py를 찾을 수 없습니다");
        Matcher matcher = Pattern.compile("Blog\\(\"([^\"]+)\", \"([^\"]+)\", \"([^\"]+)\",\\s*\"([^\"]+)\"")
                .matcher(Files.readString(BLOGS));
        List<String> collector = new ArrayList<>();
        while (matcher.find()) {
            collector.add(matcher.group(2) + "|" + matcher.group(1) + "|" + matcher.group(3) + "|" + matcher.group(4));
        }
        List<String> backend = InfoSources.ALL.stream().filter(s -> s.category().equals(InfoSources.BLOG))
                .map(s -> s.task() + "|" + s.key() + "|" + s.label() + "|" + s.siteUrl()).toList();

        assertThat(collector).hasSize(14);
        assertThat(backend).containsExactlyElementsOf(collector);
    }

    @Test
    @DisplayName("waedge·네이버 태스크 이름이 수집기와 같다")
    void otherTasksMatchCollector() throws IOException {
        assumeTrue(Files.exists(REGISTRY), "collector/app/tasks/info.py를 찾을 수 없습니다");
        String source = Files.readString(REGISTRY);
        for (String task : List.of("info_waedge_brief", "info_waedge_people", "info_waedge_blogs", "info_naver_flows")) {
            assertThat(InfoSources.byTask(task)).as(task).isPresent();
            assertThat(source).contains("\"" + task + "\"");
        }
    }
}
