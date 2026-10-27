package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2단계에 더한 설정 형 넷(C1b, 명세 K38) — {@code DATE}·{@code DATE_LIST}·{@code DATE_TIME_MAP}·{@code ALIAS_MAP}의 형식·범위 검사와
 * 저장 모양(정해진 순서·표기). 키 하나하나의 정책(미래 시행일·빈 목록만 등)은 {@code PaperSettingsServiceTest}가 봅니다.
 */
class PaperSettingTypesTest {

    private static PaperSettingKeys.Spec spec(PaperSettingKeys.Type type) {
        return new PaperSettingKeys.Spec("test.key", type, null, null, List.of(), false, "시험용 키",
                PaperSettingKeys.Scope.US);
    }

    private static PaperSettingKeys.Checked check(PaperSettingKeys.Type type, Object value) {
        return PaperSettingKeys.check(spec(type), MAPPER.valueToTree(value));
    }

    private static String saved(PaperSettingKeys.Type type, Object value) {
        PaperSettingKeys.Checked checked = check(type, value);
        assertThat(checked.error()).as(String.valueOf(value)).isNull();
        return checked.value().toString();
    }

    private static String error(PaperSettingKeys.Type type, Object value) {
        PaperSettingKeys.Checked checked = check(type, value);
        assertThat(checked.error()).as(String.valueOf(value)).isNotNull();
        return checked.error();
    }

    private static Map<String, Object> pair(String open, String close) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("open", open);
        out.put("close", close);
        return out;
    }

    @Test
    @DisplayName("화면에 보내는 형 이름 — date·dates·dateTimeMap·aliasMap(화면 settingKind가 읽는 이름)")
    void wireNames() {
        assertThat(PaperSettingKeys.Type.DATE.wire).isEqualTo("date");
        assertThat(PaperSettingKeys.Type.DATE_LIST.wire).isEqualTo("dates");
        assertThat(PaperSettingKeys.Type.DATE_TIME_MAP.wire).isEqualTo("dateTimeMap");
        assertThat(PaperSettingKeys.Type.ALIAS_MAP.wire).isEqualTo("aliasMap");
    }

    @Test
    @DisplayName("DATE — yyyy-MM-dd(앞뒤 공백만 무시), 달력에 있는 날, 2000-01-01~2099-12-31 — 숫자·한 자리 월·없는 날·범위 밖은 거절")
    void date() {
        PaperSettingKeys.Type t = PaperSettingKeys.Type.DATE;
        assertThat(saved(t, "2026-01-01")).isEqualTo("\"2026-01-01\"");
        assertThat(saved(t, " 2026-01-01 ")).isEqualTo("\"2026-01-01\"");
        assertThat(saved(t, "2000-01-01")).as("하한 포함").isEqualTo("\"2000-01-01\"");
        assertThat(saved(t, "2099-12-31")).as("상한 포함").isEqualTo("\"2099-12-31\"");
        assertThat(error(t, "1999-12-31")).contains("test.key").contains("2000-01-01~2099-12-31");
        assertThat(error(t, "2100-01-01")).contains("yyyy-MM-dd");
        assertThat(error(t, "2026-1-1")).contains("yyyy-MM-dd");
        assertThat(error(t, "2026-02-30")).as("없는 날").contains("yyyy-MM-dd");
        assertThat(error(t, "20260101")).contains("yyyy-MM-dd");
        assertThat(error(t, 20260101)).as("숫자").contains("yyyy-MM-dd");
        assertThat(error(t, "2026-01-01T00:00")).contains("yyyy-MM-dd");
        assertThat(PaperSettingKeys.check(spec(t), null).error()).contains("값이 없습니다");
    }

    @Test
    @DisplayName("DATE_LIST — 날짜마다 DATE와 같은 검사, 중복 제거·오름차순으로 저장(순서만 다른 같은 묶음 = 같은 값), 빈 목록 받음, 100개까지")
    void dateList() {
        PaperSettingKeys.Type t = PaperSettingKeys.Type.DATE_LIST;
        assertThat(saved(t, List.of("2026-12-31", " 2026-05-01", "2026-12-31"))).isEqualTo("[\"2026-05-01\",\"2026-12-31\"]");
        assertThat(saved(t, List.of("2026-05-01", "2026-12-31"))).isEqualTo(saved(t, List.of("2026-12-31", "2026-05-01")));
        assertThat(saved(t, List.of())).isEqualTo("[]");
        assertThat(error(t, "2026-01-01")).as("목록이 아님").contains("날짜 목록");
        assertThat(error(t, List.of("2026-05-01", "2026-13-01"))).contains("2026-13-01");
        assertThat(error(t, List.of(20261231))).contains("yyyy-MM-dd");

        List<String> many = new ArrayList<>();
        for (LocalDate d = LocalDate.of(2026, 1, 1); many.size() < PaperSettingKeys.MAX_DATES; d = d.plusDays(1)) {
            many.add(d.toString());
        }
        assertThat(check(t, many).error()).as("100개는 받음").isNull();
        many.add("2027-12-31");
        assertThat(error(t, many)).contains("100개까지");
    }

    @Test
    @DisplayName("DATE_TIME_MAP — 날짜 → {open, close}(HH:mm, 개장 < 마감) 쌍만, 날짜 오름차순·open·close 순으로 저장 — 모양·시각·순서가 틀리면 거절")
    void dateTimeMap() {
        PaperSettingKeys.Type t = PaperSettingKeys.Type.DATE_TIME_MAP;
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("2026-11-19", pair("10:00", "16:30"));
        Map<String, Object> reversed = new LinkedHashMap<>();
        reversed.put("close", "15:30");
        reversed.put("open", "10:00");
        value.put(" 2026-01-02 ", reversed);
        assertThat(saved(t, value)).isEqualTo(
                "{\"2026-01-02\":{\"open\":\"10:00\",\"close\":\"15:30\"},\"2026-11-19\":{\"open\":\"10:00\",\"close\":\"16:30\"}}");
        assertThat(saved(t, Map.of())).isEqualTo("{}");

        assertThat(error(t, List.of())).as("객체가 아님").contains("모양");
        assertThat(error(t, Map.of("2026-11-31", pair("10:00", "16:30")))).contains("날짜 키");
        assertThat(error(t, Map.of("2026-11-19", "10:00"))).as("쌍이 아님").contains("개장·마감 둘");
        assertThat(error(t, Map.of("2026-11-19", Map.of("open", "10:00")))).as("마감 없음").contains("개장·마감 둘");
        Map<String, Object> extra = pair("10:00", "16:30");
        extra.put("note", "수능");
        assertThat(error(t, Map.of("2026-11-19", extra))).as("모르는 칸").contains("개장·마감 둘");
        assertThat(error(t, Map.of("2026-11-19", pair("9:00", "15:30")))).contains("HH:mm");
        assertThat(error(t, Map.of("2026-11-19", pair("10:00", "24:00")))).contains("HH:mm");
        assertThat(error(t, Map.of("2026-11-19", pair("16:30", "10:00")))).contains("마감(10:00)이 개장(16:30)보다 늦어야");
        assertThat(error(t, Map.of("2026-11-19", pair("10:00", "10:00")))).as("같은 시각").contains("늦어야");
    }

    @Test
    @DisplayName("ALIAS_MAP — 6자리 종목 코드(대문자로) → 별칭 목록(PHRASES 규칙: 공백 한 칸·중복 제거·꺾쇠 거절·60자), 코드 오름차순으로 저장")
    void aliasMap() {
        PaperSettingKeys.Type t = PaperSettingKeys.Type.ALIAS_MAP;
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("000660", List.of("하이닉스", " SK   하이닉스 ", "하이닉스", ""));
        value.put(" 0000d0 ", List.of("TIGER 시험"));
        assertThat(saved(t, value)).isEqualTo("{\"0000D0\":[\"TIGER 시험\"],\"000660\":[\"하이닉스\",\"SK 하이닉스\"]}");
        assertThat(saved(t, Map.of())).isEqualTo("{}");

        assertThat(error(t, List.of("하이닉스"))).as("객체가 아님").contains("모양");
        assertThat(error(t, Map.of("00066", List.of("x")))).contains("6자리");
        assertThat(error(t, Map.of("SK하이닉스", List.of("x")))).contains("6자리");
        assertThat(error(t, Map.of("000660", "하이닉스"))).as("목록이 아님").contains("글자 목록");
        assertThat(error(t, Map.of("000660", List.of(" ")))).contains("별칭이 비었습니다");
        assertThat(error(t, Map.of("000660", List.of("<<사건 끝>>")))).contains("꺾쇠");
        assertThat(error(t, Map.of("000660", List.of("가".repeat(61))))).contains("60자");
        List<String> eleven = new ArrayList<>();
        for (int i = 0; i < PaperSettingKeys.MAX_ALIASES_PER_CODE + 1; i++) {
            eleven.add("별칭" + i);
        }
        assertThat(error(t, Map.of("000660", eleven))).contains("10개까지");
        Map<String, Object> twice = new LinkedHashMap<>();
        twice.put("0000d0", List.of("a"));
        twice.put("0000D0", List.of("b"));
        assertThat(error(t, twice)).as("대문자로 맞추면 같은 코드").contains("두 번");
    }

    @Test
    @DisplayName("PHRASES(사건 뉴스 키워드)는 별칭 표와 규칙을 나눠 써도 예전 그대로 — 항목 100개·문구")
    void phrasesUnchanged() {
        PaperSettingKeys.Type t = PaperSettingKeys.Type.PHRASES;
        assertThat(saved(t, List.of(" rate   decision ", "Fed", "fed", ""))).isEqualTo("[\"rate decision\",\"Fed\"]");
        assertThat(error(t, "Fed")).isEqualTo("test.key: 글자 목록이어야 합니다");
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 101; i++) {
            many.add("k" + i);
        }
        assertThat(error(t, many)).isEqualTo("test.key: 항목은 100개까지입니다");
        JsonNode same = check(t, List.of("Fed")).value();
        assertThat(PaperSettingKeys.same(same, MAPPER.valueToTree(List.of("Fed")))).isTrue();
    }
}
