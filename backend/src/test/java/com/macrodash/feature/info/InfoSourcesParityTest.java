package com.macrodash.feature.info;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** 출처 표가 수집기 태스크 목록과 같다 — 모든 태스크가 한 줄씩(보류한 saveticker 하나만 수집기에 없음), 블로그 줄은 수집기 블로그 표와 같은 이름·주소. */
class InfoSourcesParityTest {

    private static final Path BLOGS = Path.of("../collector/app/services/info_blogs.py");
    private static final Path REGISTRY = Path.of("../collector/app/tasks/registry.py");

    private static List<String> blogRows() throws IOException {
        Matcher matcher = Pattern.compile("Blog\\(\"([^\"]+)\", \"([^\"]+)\", \"([^\"]+)\",\\s*\"([^\"]+)\"")
                .matcher(Files.readString(BLOGS));
        List<String> collector = new ArrayList<>();
        while (matcher.find()) {
            collector.add(matcher.group(2) + "|" + matcher.group(1) + "|" + matcher.group(3) + "|" + matcher.group(4));
        }
        return collector;
    }

    @Test
    @DisplayName("블로그 줄이 수집기와 같다")
    void blogsMatchCollector() throws IOException {
        assumeTrue(Files.exists(BLOGS), "collector/app/services/info_blogs.py를 찾을 수 없습니다");
        List<String> backend = InfoSources.ALL.stream().filter(s -> s.kind().equals(InfoSources.BLOG))
                .map(s -> s.task() + "|" + s.key() + "|" + s.label() + "|" + s.siteUrl()).toList();

        assertThat(blogRows()).hasSize(14);
        assertThat(backend).containsExactlyElementsOf(blogRows());
    }

    @Test
    @DisplayName("수집기의 모든 태스크가 출처 표에 있고, 표에만 있는 줄은 보류한 saveticker뿐")
    void everyTaskHasARow() throws IOException {
        assumeTrue(Files.exists(REGISTRY), "collector/app/tasks/registry.py를 찾을 수 없습니다");
        Set<String> tasks = new TreeSet<>();
        Matcher matcher = Pattern.compile("Task\\(\"([a-z0-9_]+)\"").matcher(Files.readString(REGISTRY));
        while (matcher.find()) {
            tasks.add(matcher.group(1));
        }
        blogRows().forEach(row -> tasks.add(row.split("\\|")[0]));
        Set<String> table = new TreeSet<>();
        InfoSources.ALL.forEach(source -> table.add(source.task()));

        assertThat(tasks).hasSize(65);
        assertThat(table).containsAll(tasks);
        Set<String> extra = new TreeSet<>(table);
        extra.removeAll(tasks);
        assertThat(extra).containsExactly(InfoSources.SAVETICKER);
        assertThat(InfoSources.ALL).allSatisfy(source -> assertThat(InfoSources.TABS).contains(source.tab()));
    }
}
