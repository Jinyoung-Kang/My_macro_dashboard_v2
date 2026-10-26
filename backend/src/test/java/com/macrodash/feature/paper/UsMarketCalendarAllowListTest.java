package com.macrodash.feature.paper;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 미국 달력({@code analytics.UsMarketCalendar}) 직접 참조 허용 목록(2단계 명세 §9 A8, 선행 조사 R2). 장부 코어는 시장 묶음의 달력
 * ({@link PaperMarket#calendar()}, 또는 달력을 인자로 받는 판)만 써야 같은 표에 한국 책이 들어와도 미국 달력이 조용히 섞이지 않습니다.
 * 직접 참조는 정의 자신, 달력 인자 없는 옛 시그니처를 미국 달력으로 위임하는 함수(A2), 미국 전용 파일·단계(13F·미국 패킷·게이트·
 * 규칙 책·미국 출발일)에만 둡니다.
 *
 * <p>목록 밖 파일이 직접 부르면 실패합니다 — 시장 문맥 코드면 시장 묶음의 달력을 쓰고, 정말 미국 전용이면 이유와 함께 목록에
 * 올립니다. 목록의 파일이 더는 부르지 않아도 실패합니다(목록이 낡지 않게 — 그 줄을 지움). 주석은 빼고 코드만 봅니다
 * ({@code ArchitectureRulesTest}와 같은 방식, 새 라이브러리 없음). 작업 디렉터리는 backend입니다.
 */
class UsMarketCalendarAllowListTest {

    private static final Path MAIN = Path.of("src/main/java/com/macrodash");
    private static final Pattern REFERENCE = Pattern.compile("\\bUsMarketCalendar\\b");

    /** {@link #MAIN} 기준 경로 → 미국 달력을 직접 불러도 되는 이유. */
    private static final Map<String, String> ALLOWED = allowed();

    /**
     * 시장 중립 코어 — 시장 묶음으로 도는 파일(A5·A6·A7)과 달력 인터페이스. 허용 목록에 올릴 수 없습니다(올리면 실패). 미국 전용
     * 분기가 필요하면 미국 전용 파일·시장 묶음({@link UsPaperMarket}) 쪽에 둡니다.
     */
    private static final List<String> MARKET_CORE = List.of(
            "analytics/TradingCalendar.java",
            "analytics/OrderValidator.java",
            "analytics/PaperLedger.java",
            "feature/paper/PaperMarket.java",
            "feature/paper/PaperMarkets.java",
            "feature/paper/PaperLedgerService.java",
            "feature/paper/PaperRiskJob.java",
            "feature/paper/ClaudeBookService.java",
            "feature/paper/ClaudeDecisionPipeline.java",
            "feature/paper/FrameworkService.java",
            "feature/paper/ReviewService.java",
            "feature/paper/PaperReviewJob.java",
            "feature/paper/NoteService.java",
            "feature/paper/PaperQueryService.java",
            "feature/paper/PaperAdminService.java");

    /** 경로 → 주석을 뺀 본문. */
    private static final Map<String, String> CODE = new TreeMap<>();

    private static Map<String, String> allowed() {
        Map<String, String> m = new TreeMap<>();
        m.put("analytics/UsMarketCalendar.java", "정의 — NYSE 규칙·13F 기한·SEC 영업일 정적 함수와 어댑터 CALENDAR");
        m.put("analytics/CalendarWindow.java", "달력 인자 없는 옛 시그니처를 미국 달력으로 위임(A2)");
        m.put("analytics/NewsEvents.java", "달력 인자 없는 옛 시그니처를 미국 달력으로 위임(A2)");
        m.put("analytics/PaperStats.java", "달력 인자 없는 옛 시그니처를 미국 달력으로 위임(A2)");
        m.put("analytics/ReviewFacts.java", "달력 인자 없는 옛 시그니처를 미국 달력으로 위임(A2)");
        m.put("analytics/TrailingStop.java", "달력 인자 없는 옛 시그니처를 미국 달력으로 위임(A2)");
        m.put("analytics/TrackRecord13F.java", "13F 공시일 다음 거래일 기준 복제 수익률 — 미국 전용");
        m.put("feature/paper/UsPaperMarket.java", "미국 시장 묶음 — calendar()가 어댑터 CALENDAR를 돌려줌");
        m.put("feature/paper/PaperMarketData.java",
                "미국 확정 판정의 옛 정적 함수 isFinal — UsPaperMarketTest가 시장 묶음의 판정과 대조");
        m.put("feature/paper/PaperConfig.java", "미국 출발일(dashboard.paper.start-date)이 미국 거래일인지 — 한국 출발일은 C1");
        m.put("feature/paper/PaperDecisionJob.java", "규칙 책 13F 재선정일 — 미국 전용 단계");
        m.put("feature/paper/PacketBuilder.java", "미국 결정 패킷(일정·휴장·조기 폐장·13F 분기·보유 거래일)");
        m.put("feature/paper/PaperGate.java", "미국 게이트 지표의 뉴욕 날짜");
        m.put("feature/paper/PaperSelectionService.java", "13F 기관 선정");
        m.put("feature/paper/RuleBookService.java", "미국 규칙 책(13F 재선정·출발일 마감·주문 만료·체결일)");
        return Collections.unmodifiableMap(m);
    }

    @BeforeAll
    static void readSources() throws IOException {
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                String text = Files.readString(file);
                String code = text.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\\n]*", "");
                CODE.put(MAIN.relativize(file).toString().replace(File.separatorChar, '/'), code);
            }
        }
        assertThat(CODE).as("소스를 찾지 못했습니다(작업 디렉터리가 backend여야 합니다)").isNotEmpty();
    }

    /** 코드(주석 제외)에서 미국 달력을 직접 부르는 파일. */
    private static Set<String> referencing() {
        Set<String> out = new TreeSet<>();
        CODE.forEach((path, code) -> {
            if (REFERENCE.matcher(code).find()) {
                out.add(path);
            }
        });
        return out;
    }

    @Test
    @DisplayName("미국 달력 직접 참조는 허용 목록의 파일에만 — 시장 문맥 코드는 시장 묶음의 달력(PaperMarket.calendar())을 쓴다")
    void onlyAllowListedFilesReferenceTheUsCalendar() {
        Set<String> outside = new TreeSet<>(referencing());
        outside.removeAll(ALLOWED.keySet());
        assertThat(outside).as("허용 목록 밖에서 UsMarketCalendar를 직접 부름 — 시장 묶음의 달력을 쓰거나, 미국 전용이면 이유와 함께 "
                + "ALLOWED에 올리세요").isEmpty();
    }

    @Test
    @DisplayName("허용 목록이 낡지 않음 — 목록의 파일은 모두 있고 지금도 미국 달력을 직접 부른다(안 부르면 그 줄을 지움)")
    void allowListIsCurrent() {
        assertThat(CODE.keySet()).as("허용 목록의 파일이 없음(이름이 바뀌었으면 목록도)").containsAll(ALLOWED.keySet());
        Set<String> stale = new TreeSet<>(ALLOWED.keySet());
        stale.removeAll(referencing());
        assertThat(stale).as("더는 UsMarketCalendar를 부르지 않는 허용 목록 항목 — 지우세요").isEmpty();
        ALLOWED.forEach((path, reason) -> assertThat(reason).as(path + "의 이유").isNotBlank());
    }

    @Test
    @DisplayName("시장 중립 코어(장부·리스크·결정·복기·메모·조회·관리·Claude 결정·프롬프트 렌더링·검증기·달력 인터페이스)는 미국 달력을 직접 부르지 않고 허용 목록에도 없다")
    void marketCoreStaysMarketNeutral() {
        assertThat(CODE.keySet()).as("코어 파일이 없음(이름이 바뀌었으면 목록도)").containsAll(MARKET_CORE);
        assertThat(ALLOWED.keySet()).as("코어 파일은 허용 목록에 올릴 수 없음").doesNotContainAnyElementsOf(MARKET_CORE);
        assertThat(referencing()).doesNotContainAnyElementsOf(MARKET_CORE);
    }
}
