package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 판단 결정 종류(INTRADAY_&lt;순번&gt;)를 하나씩 박은 곳이 없게 지킵니다(ADR 0031 — 세션당 최대 3회, 그 전 2회). 순번이 늘 때
 * {@code INTRADAY_1·INTRADAY_2}만 적힌 목록(계좌2 소상한·실행 기록의 장중 교체 주문·알림 이름)은 셋째를 조용히 빠뜨립니다 — 소상한이 적게 세면 계좌2가
 * 상한보다 많이 부릅니다. 종류는 {@link RuleBookService#INTRADAY_KINDS}·{@link RuleBookService#intraday}·{@link RuleBookService#intradayKind}로만 셉니다.
 * 화면 쪽 같은 시험은 frontend/src/lib/__tests__/intradayKinds.test.ts입니다.
 */
class IntradayKindsLockTest {

    private static final Path MAIN = Path.of("src/main/java");
    private static final Pattern KIND = Pattern.compile("\\bINTRADAY_\\d+\\b");

    @Test
    @DisplayName("백엔드 코드(주석 제외)는 RuleBookService 밖에서 INTRADAY_<숫자>를 적지 않음 — 종류 목록·판정 함수로 셈")
    void noHardCodedIntradayKindsOutsideRuleBookService() throws IOException {
        List<String> found = new ArrayList<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).sorted().toList()) {
                if (file.getFileName().toString().equals("RuleBookService.java")) {
                    continue;
                }
                List<String> lines = Files.readAllLines(file);
                for (int i = 0; i < lines.size(); i++) {
                    String code = codePart(lines.get(i));
                    Matcher m = KIND.matcher(code);
                    if (m.find()) {
                        found.add(MAIN.relativize(file) + ":" + (i + 1) + " " + m.group());
                    }
                }
            }
        }
        assertThat(found).as("INTRADAY_KINDS·intraday(kind)·intradayKind(slot)로 바꿀 곳").isEmpty();
    }

    @Test
    @DisplayName("RuleBookService의 INTRADAY_<숫자> 상수는 모두 종류 목록에 순번 순으로 있고, 목록 길이 = 코드가 부를 수 있는 순번 수")
    void everyIntradayConstantIsInTheList() throws IllegalAccessException {
        List<String> constants = new ArrayList<>();
        for (Field field : RuleBookService.class.getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) && field.getType() == String.class && KIND.matcher(field.getName()).matches()) {
                constants.add((String) field.get(null));
            }
        }
        assertThat(constants).containsExactlyInAnyOrderElementsOf(RuleBookService.INTRADAY_KINDS);
        assertThat(RuleBookService.INTRADAY_KINDS).hasSize(RuleBookService.INTRADAY_MAX);
        for (int slot = 1; slot <= RuleBookService.INTRADAY_MAX; slot++) {
            assertThat(RuleBookService.INTRADAY_KINDS.get(slot - 1)).isEqualTo("INTRADAY_" + slot);
        }
    }

    @Test
    @DisplayName("결정 종류를 이름으로 옮기는 알림은 종류마다 '장중 판단 <순번>'")
    void notificationNamesEveryKind() {
        for (int slot = 1; slot <= RuleBookService.INTRADAY_MAX; slot++) {
            assertThat(PaperNotifications.kindName(RuleBookService.intradayKind(slot))).isEqualTo("장중 판단 " + slot);
        }
        assertThat(PaperNotifications.kindName("INTRADAY_4")).as("모르는 종류는 받은 글자 그대로").isEqualTo("INTRADAY_4");
        assertThat(PaperNotifications.kindName(RuleBookService.CHECKPOINT)).isEqualTo("장중 확인");
    }

    /** 한 줄에서 주석을 뺀 코드 — 문서 주석·블록 주석 줄('*'·'/*'로 시작)은 통째로, 줄 끝 '//' 주석은 그 뒤만 뺍니다(글자 안의 '//'는 드묾). */
    private static String codePart(String line) {
        String trimmed = line.strip();
        if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) {
            return "";
        }
        int comment = line.indexOf("//");
        return comment >= 0 ? line.substring(0, comment) : line;
    }
}
