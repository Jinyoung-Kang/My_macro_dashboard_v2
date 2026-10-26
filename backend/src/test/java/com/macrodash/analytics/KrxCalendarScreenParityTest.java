package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 백엔드 한국 달력과 화면 달력이 같은 날을 쉰다고 보는지(2단계 명세 §9 B5 '화면 표 대조(2025~2028)').
 *
 * <p>화면 {@code frontend/src/lib/marketCalendar.ts}의 천문연 내장 표({@code KR_PUBLIC_HOLIDAYS})를 그대로 읽어 {@link KrxCalendar}에
 * 넣고, 평일 휴장일이 공유 고정본 {@code paper/kr-calendar/krx-closures-2025-2028.json}과 같은지 봅니다. 화면 쪽은
 * {@code marketCalendarKrxParity.test.ts}가 {@code krMarketHolidays}를 같은 고정본과 견줍니다 — 두 시험이 한 파일을 보므로 어느
 * 쪽 규칙이 바뀌어도 갈립니다(QA-142 전 화면은 2028-12-29를 거래일로 봤음). 고정본의 2026·2027은 KRX 공식 목록과도 같아야 합니다.
 */
class KrxCalendarScreenParityTest {

    private static final Path SCREEN = Path.of("../frontend/src/lib/marketCalendar.ts");
    private static final Pattern TABLE = Pattern.compile("const KR_PUBLIC_HOLIDAYS[^=]*=\\s*\\{(.*?)\\n\\};", Pattern.DOTALL);
    private static final Pattern YEAR = Pattern.compile("(\\d{4}):\\s*\\[(.*?)\\]", Pattern.DOTALL);
    private static final Pattern DATE = Pattern.compile("\"(\\d{4}-\\d{2}-\\d{2})\"");

    @Test
    @DisplayName("화면 내장 표(2025~2028)로 만든 KrxCalendar의 평일 휴장일 = 공유 고정본, 고정본 2026·2027 = KRX 공식 목록")
    void sameClosuresAsScreen() throws IOException {
        assumeTrue(Files.exists(SCREEN), "frontend/src/lib/marketCalendar.ts를 찾을 수 없습니다");
        Map<Integer, List<LocalDate>> table = screenTable(Files.readString(SCREEN));
        assertThat(table.keySet()).as("화면 내장 표의 해").containsExactly(2025, 2026, 2027, 2028);

        KrxCalendar calendar = new KrxCalendar(table, List.of());
        Map<Integer, List<LocalDate>> expected = sharedClosures();
        assertThat(expected.keySet()).containsExactly(2025, 2026, 2027, 2028);
        for (int year : expected.keySet()) {
            assertThat(KrxFixtures.weekdayClosures(calendar, year)).as(year + "년 평일 휴장일")
                    .containsExactlyElementsOf(expected.get(year));
        }
        assertThat(expected.get(2026)).containsExactlyElementsOf(KrxFixtures.krxClosures(2026).keySet());
        assertThat(expected.get(2027)).containsExactlyElementsOf(KrxFixtures.krxClosures(2027).keySet());
        assertThat(expected.get(2028)).contains(LocalDate.of(2028, 12, 29)).doesNotContain(LocalDate.of(2028, 12, 28));
    }

    private static Map<Integer, List<LocalDate>> screenTable(String source) {
        Matcher block = TABLE.matcher(source);
        assertThat(block.find()).as("marketCalendar.ts에 KR_PUBLIC_HOLIDAYS 표가 없습니다").isTrue();
        Map<Integer, List<LocalDate>> out = new TreeMap<>();
        Matcher year = YEAR.matcher(block.group(1));
        while (year.find()) {
            List<LocalDate> days = new ArrayList<>();
            Matcher date = DATE.matcher(year.group(2));
            while (date.find()) {
                days.add(LocalDate.parse(date.group(1)));
            }
            out.put(Integer.parseInt(year.group(1)), days);
        }
        return out;
    }

    private static Map<Integer, List<LocalDate>> sharedClosures() throws IOException {
        try (InputStream in = KrxCalendarScreenParityTest.class.getClassLoader()
                .getResourceAsStream("paper/kr-calendar/krx-closures-2025-2028.json")) {
            assertThat(in).as("공유 고정본이 없습니다").isNotNull();
            JsonNode years = new ObjectMapper().readTree(in).path("years");
            Map<Integer, List<LocalDate>> out = new TreeMap<>();
            for (Map.Entry<String, JsonNode> e : years.properties()) {
                List<LocalDate> days = new ArrayList<>();
                e.getValue().forEach(day -> days.add(LocalDate.parse(day.asString())));
                out.put(Integer.parseInt(e.getKey()), days);
            }
            return out;
        }
    }
}
