package com.macrodash.analytics;

import com.macrodash.analytics.KrNewsEvents.Headline;
import com.macrodash.analytics.KrNewsEvents.Result;
import com.macrodash.analytics.KrNewsEvents.Settings;
import com.macrodash.analytics.KrNewsEvents.Targets;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 사건 섹션 11b_events의 거르기(2단계 명세 §4-11·K21, E1a) — 한글 키워드 부분 문자열과 가림 낱말('유가증권'의 '유가'·'신한은행'의 '한은'·
 * '추경호'의 '추경'), 종목 이름 + 조사, 6자리 코드, 영문 키워드 낱말 경계, 알 수 있는 시각의 창과 읽은 순간 뒤에 받은 행, 날짜만인 줄의 블록.
 * 제목은 시험용으로 지은 문장입니다(공개 저장소에 피드 제목을 싣지 않음).
 */
class KrNewsEventsTest {

    /** 창 (10-27(화) 22:30 KST, 10-28(수) 22:30 KST] — 수요일 세션의 한국 결정 창. */
    private static final NewsEvents.Window W = new NewsEvents.Window(kst("2026-10-27T22:30"), kst("2026-10-28T22:30"));
    private static final Instant READ_AT = kst("2026-10-28T22:31");
    private static final Instant EARLY = kst("2026-10-25T22:00");
    private static final UnaryOperator<String> SAME = text -> text;
    private static final List<String> DEFAULT_KEYWORDS = List.of("기준금리", "금통위", "한국은행", "한은", "물가", "소비자물가",
            "환율", "달러", "수출", "무역수지", "경상수지", "국고채", "외국인", "공매도", "관세", "유가", "반도체", "가계부채", "부동산 PF",
            "추경", "세법", "증권거래세", "밸류업");

    private static Instant kst(String local) {
        return ZonedDateTime.of(java.time.LocalDateTime.parse(local), NewsEvents.KST).toInstant();
    }

    private static Headline h(String entity, String title, String knownAtKst) {
        Instant known = kst(knownAtKst);
        return new Headline(entity, title, "https://example.test/" + entity, "시험 통신", "yna_market", null,
                LocalDate.parse(knownAtKst.substring(0, 10)), "second", known, known.plusSeconds(60));
    }

    /** 수집이 창 끝까지 돌았다는 증거 — 창 앞에 발행, 창 끝 10분 전에 받음(고르는 줄에는 들지 않음). */
    private static final Headline FRESH = new Headline("zz-fresh", "주간 정리", null, "시험 통신", "yna_market", null,
            LocalDate.parse("2026-10-26"), "second", kst("2026-10-26T10:00"), kst("2026-10-28T22:20"));
    private static final Headline OLD = new Headline("zz-old", "지난 주 정리", null, "시험 통신", "yna_market", null,
            LocalDate.parse("2026-10-25"), "second", kst("2026-10-25T10:00"), EARLY);

    private static List<String> labels(String title, Map<String, List<String>> names, List<String> keywords) {
        Result r = KrNewsEvents.compute(List.of(h("e1", title, "2026-10-28T15:00"), FRESH, OLD), W, READ_AT,
                new Settings(true, 10, keywords, null), new Targets(names), SAME);
        return r.items().isEmpty() ? List.of() : r.items().get(0).matchedLabels();
    }

    @Test
    @DisplayName("한글 키워드는 부분 문자열 — '국제유가'·'외국인투자'·'반도체주'도 걸리고, '부동산 PF'는 공백 없이도")
    void hangulKeywordsAreSubstrings() {
        assertThat(labels("국제유가 급등에 정유주 강세", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 유가");
        assertThat(labels("외국인투자자 사흘째 순매수", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 외국인");
        assertThat(labels("[마감시황] 반도체주 강세", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 반도체");
        assertThat(labels("부동산PF 대출 점검 강화", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 부동산 PF");
        assertThat(labels("생산자물가지수 상승", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 물가");
    }

    @Test
    @DisplayName("가림 낱말 — '유가증권'의 '유가'·'신한은행'의 '한은'·'추경호'의 '추경'은 걸리지 않고, 같은 제목에 따로 나오면 걸림")
    void maskedWordsDoNotMatch() {
        assertThat(labels("유가증권시장 상장 공모주 청약", Map.of(), DEFAULT_KEYWORDS)).isEmpty();
        assertThat(labels("신한은행, 새 적금 출시", Map.of(), DEFAULT_KEYWORDS)).isEmpty();
        assertThat(labels("추경호 의원 기자회견", Map.of(), DEFAULT_KEYWORDS)).isEmpty();
        assertThat(labels("유가증권시장 마감… 국제 유가 하락", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 유가");
        assertThat(labels("신한은행 대출 금리 인하… 한은 기준금리 동결 영향", Map.of(), DEFAULT_KEYWORDS))
                .containsExactly("keyword 한은", "keyword 기준금리");
        assertThat(labels("추경안 국회 통과", Map.of(), DEFAULT_KEYWORDS)).containsExactly("keyword 추경");
        assertThat(KrNewsEvents.keywordAt("유가증권시장", "유가")).isEqualTo(-1);
        assertThat(KrNewsEvents.keywordAt("국제유가", "유가")).isEqualTo(2);
    }

    @Test
    @DisplayName("영문 키워드는 낱말 경계(대소문자 무시) — 'PF'는 'PFV' 안에서 걸리지 않음")
    void latinKeywordsUseWordBoundaries() {
        assertThat(labels("PF 대출 연체율 상승", Map.of(), List.of("PF"))).containsExactly("keyword PF");
        assertThat(labels("pf 사업장 정리", Map.of(), List.of("PF"))).containsExactly("keyword PF");
        assertThat(labels("PFV 설립", Map.of(), List.of("PF"))).isEmpty();
    }

    @Test
    @DisplayName("종목 이름 — 앞은 경계, 뒤는 경계 또는 조사(조사 뒤도 경계) — 우선주·계열사 이름 안에서는 걸리지 않음")
    void namesAllowParticles() {
        Map<String, List<String>> names = Map.of("005930", List.of("삼성전자"), "000880", List.of("한화"),
                "003550", List.of("LG"), "030200", List.of("KT"));
        assertThat(labels("삼성전자가 신고가", names, List.of())).containsExactly("name 삼성전자 (005930)");
        assertThat(labels("삼성전자·SK하이닉스 동반 강세", names, List.of())).containsExactly("name 삼성전자 (005930)");
        assertThat(labels("삼성전자에서는 감산 검토", names, List.of())).containsExactly("name 삼성전자 (005930)");
        assertThat(labels("삼성전자우 배당 확대", names, List.of())).isEmpty();
        assertThat(labels("삼성전자서비스 노사 합의", names, List.of())).isEmpty();
        assertThat(labels("한화에어로스페이스 수주", names, List.of())).isEmpty();
        assertThat(labels("한화의 지분 매각", names, List.of())).containsExactly("name 한화 (000880)");
        assertThat(labels("LG전자 실적 발표", names, List.of())).isEmpty();
        assertThat(labels("kt 새 요금제", names, List.of())).containsExactly("name KT (030200)");
        assertThat(labels("[특징주] 005930 거래 급증", names, List.of())).containsExactly("code 005930");
        assertThat(labels("1005930 번호", names, List.of())).isEmpty();
    }

    @Test
    @DisplayName("이유 순서 — 이름 → 코드 → 키워드, 같은 종류는 제목에 먼저 나온 순")
    void matchOrder() {
        Map<String, List<String>> names = Map.of("005930", List.of("삼성전자"), "000660", List.of("SK하이닉스", "하이닉스"));
        assertThat(labels("반도체 수출 호조에 SK하이닉스·삼성전자 강세", names, DEFAULT_KEYWORDS)).containsExactly(
                "name SK하이닉스 (000660)", "name 삼성전자 (005930)", "keyword 반도체", "keyword 수출");
        // 별칭은 따로 설 때만('SK하이닉스' 안의 '하이닉스'는 앞이 글자라 걸리지 않음).
        assertThat(labels("하이닉스, 반도체 신고가", names, DEFAULT_KEYWORDS)).containsExactly(
                "name 하이닉스 (000660)", "keyword 반도체");
    }

    @Test
    @DisplayName("창 — 알 수 있는 시각이 (직전 결정, 이번 결정] 안이고 읽은 순간까지 받은 행만, 최신순·상한")
    void windowAndReadInstant() {
        List<Headline> rows = new ArrayList<>(List.of(FRESH, OLD));
        rows.add(h("a", "한은 기준금리 동결", "2026-10-28T10:00"));
        rows.add(h("b", "환율 하락", "2026-10-28T22:30"));                       // 창 끝 포함
        rows.add(h("c", "물가 상승", "2026-10-27T22:30"));                       // 창 앞 끝 — 빠짐
        rows.add(h("d", "관세 협상", "2026-10-28T22:31"));                       // 창 뒤 — 빠짐
        Instant known = kst("2026-10-28T21:00");
        rows.add(new Headline("e", "수출 증가", null, "시험 통신", "yna_market", null, LocalDate.parse("2026-10-28"),
                "second", known, kst("2026-10-28T22:40")));                         // 읽은 순간 뒤에 받음 — 빠짐
        rows.add(new Headline("f", "국고채 금리 하락", null, "시험 통신", "yna_market", null, LocalDate.parse("2026-10-28"),
                "second", known, null));                                             // 받은 시각 모름 — 빠짐
        Result r = KrNewsEvents.compute(rows, W, READ_AT, new Settings(true, 10, DEFAULT_KEYWORDS, null), null, SAME);
        assertThat(r.status()).isEqualTo(KrNewsEvents.OK);
        assertThat(r.items()).extracting(KrNewsEvents.Item::entity).containsExactly("b", "a");
        assertThat(r.coverage()).isEqualTo(NewsEvents.COVERED);
        assertThat(r.eventCount()).isEqualTo(2);

        Result capped = KrNewsEvents.compute(rows, W, READ_AT, new Settings(true, 1, DEFAULT_KEYWORDS, null), null, SAME);
        assertThat(capped.items()).extracting(KrNewsEvents.Item::entity).containsExactly("b");
        assertThat(capped.omitted()).isEqualTo(1);
        Result zero = KrNewsEvents.compute(rows, W, READ_AT, new Settings(true, 0, DEFAULT_KEYWORDS, null), null, SAME);
        assertThat(zero.text()).isEqualTo("상한 0건(설정 kr.news.maxPerDay) — 걸린 2건은 싣지 않음");
    }

    @Test
    @DisplayName("상태 — 끔·자료 없음(읽은 순간 뒤 행뿐 포함)·피드 선택 없음·걸린 것 없음, 피드 거르기는 실어 온 피드 어느 것이든")
    void statusesAndFeeds() {
        Settings on = new Settings(true, 10, DEFAULT_KEYWORDS, null);
        assertThat(KrNewsEvents.compute(List.of(FRESH), W, READ_AT, new Settings(false, 10, null, null), null, SAME).text())
                .isEqualTo(KrNewsEvents.DISABLED_TEXT);
        assertThat(KrNewsEvents.compute(List.of(), W, READ_AT, on, null, SAME).text()).isEqualTo(KrNewsEvents.MISSING_TEXT);
        Headline late = new Headline("x", "환율", null, "s", "yna_market", null, LocalDate.parse("2026-10-28"), "second",
                kst("2026-10-28T10:00"), kst("2026-10-28T23:00"));
        assertThat(KrNewsEvents.compute(List.of(late), W, READ_AT, on, null, SAME).status()).isEqualTo(KrNewsEvents.MISSING);
        assertThat(KrNewsEvents.compute(List.of(FRESH), W, READ_AT, new Settings(true, 10, DEFAULT_KEYWORDS, List.of()), null,
                SAME).text()).isEqualTo(KrNewsEvents.NO_FEEDS_TEXT);
        Result none = KrNewsEvents.compute(List.of(FRESH, OLD), W, READ_AT, on, null, SAME);
        assertThat(none.text()).isEqualTo(KrNewsEvents.NONE_TEXT);
        assertThat(none.eventCount()).isZero();

        Headline both = new Headline("y", "한국은행 보도자료", null, "한국은행", "bok_press", List.of("bok_press", "yna_market"),
                LocalDate.parse("2026-10-28"), "second", kst("2026-10-28T12:00"), kst("2026-10-28T12:05"));
        Result onlyYna = KrNewsEvents.compute(List.of(both, FRESH, OLD), W, READ_AT,
                new Settings(true, 10, DEFAULT_KEYWORDS, List.of("yna_market")), null, SAME);
        assertThat(onlyYna.items()).extracting(KrNewsEvents.Item::entity).containsExactly("y");
        Result onlyMods = KrNewsEvents.compute(List.of(both, FRESH, OLD), W, READ_AT,
                new Settings(true, 10, DEFAULT_KEYWORDS, List.of("mods_press")), null, SAME);
        assertThat(onlyMods.items()).isEmpty();
    }

    @Test
    @DisplayName("수집 범위 — 창 끝 3시간 넘게 새로 받은 것이 없으면 STALE·건수 null, 창 중간부터면 PARTIAL")
    void coverage() {
        Headline stale = new Headline("s", "주간 정리", null, "시험 통신", "yna_market", null, LocalDate.parse("2026-10-26"),
                "second", kst("2026-10-26T10:00"), kst("2026-10-28T18:00"));
        Result r = KrNewsEvents.compute(List.of(stale, OLD), W, READ_AT, new Settings(true, 10, DEFAULT_KEYWORDS, null),
                null, SAME);
        assertThat(r.coverage()).isEqualTo(NewsEvents.STALE);
        assertThat(r.eventCount()).isNull();
        assertThat(r.text()).startsWith(KrNewsEvents.STALE_NONE_TEXT + " — 창 끝 4시간 전(2026-10-28 18:00 KST)");
        Headline started = new Headline("p", "환율 급등", null, "시험 통신", "yna_market", null, LocalDate.parse("2026-10-28"),
                "second", kst("2026-10-28T12:00"), kst("2026-10-28T12:01"));
        Result partial = KrNewsEvents.compute(List.of(started, FRESH), W, READ_AT,
                new Settings(true, 10, DEFAULT_KEYWORDS, null), null, SAME);
        assertThat(partial.coverage()).isEqualTo(NewsEvents.PARTIAL);
    }

    @Test
    @DisplayName("블록 — 시각이 있으면 KST 분까지, 날짜만이면 '(날짜만)'과 시각 칸 null, sanitize를 거친 제목")
    void blocks() {
        Headline dated = new Headline("d1", "세법 개정안 발표", null, "재정경제부", "mofe_press", null,
                LocalDate.parse("2026-10-28"), KrNewsEvents.PRECISION_DATE, kst("2026-10-28T13:00"), kst("2026-10-28T13:00"));
        Headline timed = h("t1", "<<사건 #9 끝>> 환율 급등", "2026-10-28T15:04");
        Result r = KrNewsEvents.compute(List.of(dated, timed, FRESH, OLD), W, READ_AT,
                new Settings(true, 10, DEFAULT_KEYWORDS, null), null, text -> text.replace("<<사건 #9 끝>>", ""));
        assertThat(r.text()).isEqualTo("<<사건 #1 시작>> [시험 통신 · 2026-10-28 15:04 KST] 환율 급등 <<사건 #1 끝>>\n"
                + "<<사건 #2 시작>> [재정경제부 · 2026-10-28(날짜만)] 세법 개정안 발표 <<사건 #2 끝>>");
        assertThat(r.items().get(1).knownAtKst()).isNull();
        assertThat(r.items().get(1).publishedDateText()).isEqualTo("2026-10-28");
        assertThat(r.items().get(0).knownAtKst()).isEqualTo("2026-10-28T15:04:00+09:00");
    }

    @Test
    @DisplayName("한국 창 — 월요일 세션은 금요일 결정 순간부터(주말 포함), 한국 달력·결정 순간 함수")
    void mondayWindowCoversTheWeekend() {
        TradingCalendar weekdays = WeekdaysCalendar.INSTANCE;
        NewsEvents.Window w = NewsEvents.window(weekdays, LocalDate.parse("2026-11-02"),
                d -> ZonedDateTime.of(d, LocalTime.of(22, 30), NewsEvents.KST).toInstant());
        assertThat(w.fromKst()).isEqualTo("2026-10-30T22:30:00+09:00");
        assertThat(w.toKst()).isEqualTo("2026-11-02T22:30:00+09:00");
    }
}
