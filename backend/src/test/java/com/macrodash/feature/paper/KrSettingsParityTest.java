package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 한국 설정 키(C1b)가 기대는 수집기 상수와 대조합니다 — 수집기는 백엔드 설정을 읽지 않아(ADR 0008) 한쪽만 고치면 조용히 틀립니다.
 * <ul>
 *   <li>{@code kr.news.feeds}의 피드 키 = 수집기 {@code services.news.KR_FEEDS}(저장본 payload의 {@code feed}) — 수집기에만 있으면 고를 수
 *       없고, 백엔드에만 있으면 늘 빔(미국 판은 {@link NewsFeedsParityTest})</li>
 *   <li>{@code kr.cashLikeTickers}가 받는 ETF = 수집기 {@code tasks.kr_paper.KR_SCOPE_ETFS}(늘 받는 수집 범위)</li>
 *   <li>{@code kr.calendar.openTimeOverrides}가 받는 개장 + 1분 = 수집기 {@code KR_OPEN_PROBE_LABELS}(1분봉 개장 봉 라벨, 계약 1)</li>
 * </ul>
 */
class KrSettingsParityTest {

    private static final Path NEWS = Path.of("../collector/app/services/news.py");
    private static final Path KR_PAPER = Path.of("../collector/app/tasks/kr_paper.py");

    @Test
    @DisplayName("한국 피드 키가 수집기 services.news.KR_FEEDS의 키와 같고 순서도 같다")
    void krFeedKeysMatchCollector() throws IOException {
        assumeTrue(Files.exists(NEWS), "collector/app/services/news.py를 찾을 수 없습니다");
        String source = Files.readString(NEWS);
        Matcher block = Pattern.compile("\\nKR_FEEDS\\s*(?::[^=]*)?=\\s*\\((.*?)\\n\\)", Pattern.DOTALL).matcher(source);
        assertThat(block.find()).as("KR_FEEDS를 찾지 못했습니다").isTrue();
        List<String> collector = new ArrayList<>();
        Matcher key = Pattern.compile("Feed\\(\\s*\"([a-z_]+)\"").matcher(block.group(1).replaceAll("#[^\\n]*", ""));
        while (key.find()) {
            collector.add(key.group(1));
        }
        assertThat(collector).as("수집기 한국 피드 키").isNotEmpty().doesNotHaveDuplicates();
        assertThat(collector).isEqualTo(PaperSettingsService.KR_NEWS_FEEDS);
        assertThat(PaperSettingKeys.find("kr.news.feeds").orElseThrow().options()).isEqualTo(collector);
    }

    @Test
    @DisplayName("현금성으로 받는 ETF가 수집기 KR_SCOPE_ETFS(늘 받는 수집 범위)와 같다")
    void scopeEtfsMatchCollector() throws IOException {
        assumeTrue(Files.exists(KR_PAPER), "collector/app/tasks/kr_paper.py를 찾을 수 없습니다");
        assertThat(tuple(Files.readString(KR_PAPER), "KR_SCOPE_ETFS")).isEqualTo(PaperSettingKeys.KR_SCOPE_ETFS);
        assertThat(PaperSettingKeys.KR_SCOPE_ETFS).containsAll(PaperSettingsService.KR_DEFAULT_CASH_LIKE);
    }

    @Test
    @DisplayName("장 시간 변경일의 개장 + 1분이 수집기 1분봉 개장 봉 라벨(KR_OPEN_PROBE_LABELS)과 같다")
    void overrideOpensMatchCollectorLabels() throws IOException {
        assumeTrue(Files.exists(KR_PAPER), "collector/app/tasks/kr_paper.py를 찾을 수 없습니다");
        List<String> labels = tuple(Files.readString(KR_PAPER), "KR_OPEN_PROBE_LABELS");
        assertThat(PaperSettingKeys.KR_OVERRIDE_OPENS.stream().map(open -> LocalTime.parse(open).plusMinutes(1).toString())
                .toList()).isEqualTo(labels);
    }

    /** 파이썬 상수 {@code NAME = ("a", "b")}의 글자 목록. */
    private static List<String> tuple(String source, String name) {
        Matcher m = Pattern.compile("\\n" + name + "\\s*(?::[^=]*)?=\\s*\\(([^)]*)\\)").matcher(source);
        assertThat(m.find()).as(name + "를 찾지 못했습니다").isTrue();
        List<String> out = new ArrayList<>();
        Matcher item = Pattern.compile("\"([^\"]*)\"").matcher(m.group(1));
        while (item.find()) {
            out.add(item.group(1));
        }
        return out;
    }
}
