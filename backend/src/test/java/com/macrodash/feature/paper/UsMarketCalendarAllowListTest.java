package com.macrodash.feature.paper;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.macrodash.analytics.TradingCalendar;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
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
 *
 * <p>이름 검사만으로는 <b>달력 인자 없는 옛 시그니처</b>(A2 — 안에서 미국 달력으로 위임)를 부르는 코어 호출을 못 봅니다(호출하는 줄에
 * {@code UsMarketCalendar}가 없음). 그래서 코어 파일은 그 옛 시그니처도 부르지 못하게 따로 봅니다: analytics에서 첫 인자가
 * {@link TradingCalendar}인 판과 이름이 같고 달력 인자가 없는 판을 리플렉션으로 찾아(표를 손으로 두지 않음 — 새 위임 판도 저절로
 * 들어옴), 코어 코드의 {@code 클래스.메서드(…)} 호출을 최상위 인자 수로 가립니다(같은 이름의 두 판이 인자 수가 같으면 가를 수
 * 없어 그 자체로 실패). 정적 import로 클래스 이름을 숨기는 것도 코어에서는 막습니다.
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

    /**
     * analytics 클래스 이름 → 메서드 이름 → 달력 인자 없이 미국 달력으로 위임하는 판의 인자 수. 같은 이름에 첫 인자가
     * {@link TradingCalendar}인 판이 있고 그 판은 달력을 받지 않는 메서드만 셉니다(A2의 옛 시그니처).
     */
    private static Map<String, Map<String, Set<Integer>>> usDelegatingOverloads() throws ClassNotFoundException {
        Map<String, Map<String, Set<Integer>>> out = new TreeMap<>();
        for (String path : CODE.keySet()) {
            if (!path.startsWith("analytics/") || path.indexOf('/', "analytics/".length()) >= 0) {
                continue;
            }
            String simple = path.substring("analytics/".length(), path.length() - ".java".length());
            Method[] methods = Class.forName("com.macrodash.analytics." + simple).getDeclaredMethods();
            Map<String, Set<Integer>> withCalendar = new TreeMap<>();
            for (Method m : methods) {
                if (m.getParameterCount() > 0 && m.getParameterTypes()[0] == TradingCalendar.class) {
                    withCalendar.computeIfAbsent(m.getName(), k -> new TreeSet<>()).add(m.getParameterCount());
                }
            }
            for (Method m : methods) {
                boolean takesCalendar = Arrays.asList(m.getParameterTypes()).contains(TradingCalendar.class);
                if (!takesCalendar && withCalendar.containsKey(m.getName()) && !m.isSynthetic()) {
                    int arity = m.getParameterCount();
                    assertThat(withCalendar.get(m.getName())).as(simple + "." + m.getName() + " — 달력 판과 옛 판의 인자 수가 "
                            + arity + "로 같아 호출을 인자 수로 가를 수 없음(이름을 바꾸거나 이 검사를 고치세요)")
                            .doesNotContain(arity);
                    out.computeIfAbsent(simple, k -> new TreeMap<>())
                            .computeIfAbsent(m.getName(), k -> new TreeSet<>()).add(arity);
                }
            }
        }
        return out;
    }

    /**
     * {@code code}의 {@code from}(여는 괄호 바로 뒤)부터 짝이 맞는 닫는 괄호까지의 최상위 인자 수 — 빈 괄호면 0. 문자열·글자 상수
     * 안의 괄호·쉼표는 세지 않습니다.
     */
    static int arity(String code, int from) {
        int depth = 0;
        int commas = 0;
        boolean any = false;
        for (int i = from; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '"' || c == '\'') {
                i = endOfLiteral(code, i);
                any = true;
                continue;
            }
            if (c == ')' || c == ']' || c == '}') {
                if (depth == 0) {
                    return any ? commas + 1 : 0;
                }
                depth--;
            } else if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ',' && depth == 0) {
                commas++;
            }
            if (!Character.isWhitespace(c)) {
                any = true;
            }
        }
        throw new IllegalStateException("닫는 괄호가 없습니다: " + code.substring(from, Math.min(code.length(), from + 80)));
    }

    /** {@code start}의 따옴표로 시작하는 문자열·글자 상수(텍스트 블록 포함)의 닫는 따옴표 위치. */
    private static int endOfLiteral(String code, int start) {
        char quote = code.charAt(start);
        if (quote == '"' && code.startsWith("\"\"\"", start)) {
            int end = code.indexOf("\"\"\"", start + 3);
            return end < 0 ? code.length() : end + 2;
        }
        for (int i = start + 1; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '\\') {
                i++;
            } else if (c == quote) {
                return i;
            }
        }
        return code.length();
    }

    @Test
    @DisplayName("인자 수 세기 — 중첩 괄호·문자열 속 쉼표·빈 괄호")
    void arityCounting() {
        String code = "f(a, g(b, c), \"x, (y\", 'd') + h() + k(new int[]{1, 2}, m -> m.of(1, 2))";
        assertThat(arity(code, 2)).isEqualTo(4);
        assertThat(arity(code, code.indexOf("h(") + 2)).isZero();
        assertThat(arity(code, code.indexOf("k(") + 2)).isEqualTo(2);
    }

    @Test
    @DisplayName("시장 중립 코어는 달력 인자 없는 옛 시그니처(안에서 미국 달력으로 위임 — A2)를 부르지 않는다 — 그 시장 달력을 넘기는 판만")
    void marketCoreCallsNoUsDelegatingOverload() throws ClassNotFoundException {
        Map<String, Map<String, Set<Integer>>> delegating = usDelegatingOverloads();
        assertThat(delegating).as("A2의 옛 시그니처를 리플렉션으로 찾음")
                .containsKeys("TrailingStop", "PaperStats", "ReviewFacts", "CalendarWindow", "NewsEvents");
        assertThat(delegating.get("TrailingStop").get("lockoutUntil")).containsExactly(2);
        assertThat(delegating.get("PaperStats").get("compute")).containsExactly(3);

        List<String> violations = new ArrayList<>();
        for (String path : MARKET_CORE) {
            String code = CODE.get(path);
            Matcher staticImport = Pattern.compile("import\\s+static\\s+com\\.macrodash\\.analytics\\.(\\w+)\\.")
                    .matcher(code);
            while (staticImport.find()) {
                if (delegating.containsKey(staticImport.group(1))) {
                    violations.add(path + ": 정적 import " + staticImport.group(1) + " — 호출에서 클래스 이름이 사라져 검사할 수 없음");
                }
            }
            delegating.forEach((type, methods) -> methods.forEach((method, arities) -> {
                Matcher call = Pattern.compile("\\b" + type + "\\s*\\.\\s*" + method + "\\s*\\(").matcher(code);
                while (call.find()) {
                    int n = arity(code, call.end());
                    if (arities.contains(n)) {
                        violations.add(path + ": " + type + "." + method + "(인자 " + n + "개) — 미국 달력으로 위임하는 옛 "
                                + "시그니처. 그 시장 달력을 첫 인자로 넘기세요");
                    }
                }
            }));
        }
        assertThat(violations).as("코어의 달력 없는 옛 시그니처 호출").isEmpty();
    }
}
