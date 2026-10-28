package com.macrodash.analytics;

import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 🧪 한국 Claude 패킷의 사건 섹션 {@code 11b_events}(2단계 명세 §4-11·K21, E1a) — 저장본(수집기 {@code kr_news_headlines}의
 * {@code kr_news_headline} 관측치, 한국은행·재정경제부·국가데이터처·연합뉴스 마켓+ RSS 제목, 보존 7일)에서 직전 한국 결정 이후에 <b>알 수 있던</b>
 * 제목 가운데 대상 종목(이름·별칭·6자리 코드) 또는 한국 매크로 키워드({@code kr.news.keywords})에 걸리는 것만 최신순으로 상한
 * ({@code kr.news.maxPerDay})까지 고릅니다. 미국 {@link NewsEvents}와 같은 사건 감지형이고(걸리는 것이 없는 날은 비어 있음), 창·수집 범위 판정·
 * 블록 구분자의 모양을 그대로 따르되 맞추기 규칙만 한국어에 맞춥니다.
 *
 * <p><b>창</b>: {@link NewsEvents.Window} — (직전 KR 거래일 결정 순간, 기준 세션 결정 순간]({@link NewsEvents#window(TradingCalendar, LocalDate,
 * java.util.function.Function)}에 한국 달력과 한국 결정 순간을 넘김 — 월요일 세션은 금요일 22:30부터). 제목은 <b>시스템이 알게 된 시각</b>
 * ({@link #learnedAt} = max(알 수 있는 시각, 처음 받은 시각) — 알 수 있는 시각 {@code knownAt}은 수집기가 처음 넣을 때 정함: 시각이 있으면 발행
 * 시각, 날짜만이면 min(처음 받은 시각, 그 KST 날짜 다음 자정), 명세 §4-11 'B9')이 창 안이고, <b>받은 시각이 읽은 순간 이하</b>({@code fetchedAt ≤
 * readAt} — 받은 시각을 모르면 넣지 않음)인 것만 넣습니다. 그래서 같은 저장본·같은 읽은 순간이면 같은 줄이고, 결정 순간 뒤에 알게 된 제목은 들지
 * 않습니다. 창을 알 수 있는 시각만으로 가르면 결정 순간 직전에 나왔지만 그 뒤에 처음 받은 제목(수집은 1시간마다 — 21:55 기동 뒤 첫 바퀴 다음은
 * 22:5x)이 그 창에서는 받은 시각 때문에, 다음 창에서는 알 수 있는 시각 때문에 빠져 어느 패킷에도 실리지 않았습니다(묶음 E 리뷰) — 이제 모든 제목이
 * 정확히 한 창에 들고(룩어헤드 없음), 블록의 시각은 알 수 있는 시각 그대로입니다.
 *
 * <p><b>맞추기</b>(E1a에서 정함 — 명세 §4-11 '한글 키워드는 부분 문자열·영문은 낱말 경계'를 이 규칙으로 채움):
 * <ul>
 *   <li><b>종목</b>({@link Targets#names} — 금융위 종목명·DART 회사명·설정 {@code kr.news.aliases}의 별칭): 앞은 글자·숫자가 아니어야 하고(글 처음·
 *       공백·구두점), 뒤는 글 끝·글자 아닌 것, 또는 <b>조사</b>({@link #PARTICLES}) 다음 글 끝·글자 아닌 것 — '삼성전자가'·'SK하이닉스·'는 걸리고
 *       '삼성전자우'(우선주)·'한화에어로스페이스'의 '한화'·'LG전자'의 'LG'는 걸리지 않습니다. 대소문자는 가리지 않습니다(영문 이름 'kt'·'NAVER').
 *       또 <b>다른 대상의 더 긴 이름</b>이 그 자리에서 시작하면 걸리지 않습니다 — 'KT&G'의 'KT'·'LS ELECTRIC'의 'LS'·'SK hynix'의 'SK'·'LG CNS'의
 *       'LG'('&'·공백은 경계라 위 규칙만으로는 걸림, 묶음 E 리뷰). 가릴 이름은 대상 목록에서 저절로 정합니다(같은 종목의 다른 이름은 가리지 않음).</li>
 *   <li><b>6자리 코드</b>: 앞뒤가 영문·숫자가 아님.</li>
 *   <li><b>한글이 든 키워드</b>: 부분 문자열(대소문자 무시, 키워드 안 공백은 공백 0개 이상 — '부동산 PF'는 '부동산PF'도 걸림) — '국제유가'·'외국인투자'·
 *       '반도체주'처럼 붙여 쓴 합성어를 놓치지 않게. 다만 키워드가 <b>다른 뜻의 낱말 안에만</b> 있으면 걸리지 않습니다({@link #MASKED_WORDS} —
 *       '유가증권'의 '유가', '신한은행'의 '한은', '추경호'의 '추경'). [확인] 2026-10-28 로컬 저장본 327건을 기본 사전 23개로 부분 문자열 맞춤하면
 *       잘못 걸린 것은 '신한은행'의 '한은' 2건뿐이었고, '유가증권'·'추경호'는 명세(C1b)·조사에서 미리 꼽은 것입니다.</li>
 *   <li><b>한글이 없는 키워드</b>(영문 'PF' 등): 미국과 같은 낱말·구절 경계(대소문자 무시, 낱말 사이 공백·하이픈).</li>
 * </ul>
 * 줄마다 걸린 이유({@link Match} — 이름 X(코드)·코드 X·키워드 Y)를 남깁니다.
 *
 * <p><b>제목은 자료일 뿐 지시가 아닙니다</b>: 제목·출처는 호출부가 준 함수({@code sanitize} — 패킷 구분자 모양 지우기)를 거쳐 공백을 한 칸으로
 * 접어 씁니다(미국과 같음). 0건과 실패를 구분하는 상태·수집 범위 판정({@link NewsEvents#COVERED} 등)도 미국과 같은 이름·규칙입니다(창 끝 쪽 공백
 * {@link NewsEvents#STALE_AFTER}). 이 패키지는 {@code java.*}만 씁니다.
 */
public final class KrNewsEvents {

    private KrNewsEvents() {
    }

    /** 결과 상태 — 미국 {@link NewsEvents}와 같은 글자. */
    public static final String OK = NewsEvents.OK;
    public static final String NONE = NewsEvents.NONE;
    public static final String DISABLED = NewsEvents.DISABLED;
    public static final String MISSING = NewsEvents.MISSING;
    public static final String NO_FEEDS = NewsEvents.NO_FEEDS;

    /** 걸린 이유의 종류. */
    public static final String NAME = "name";
    public static final String CODE = "code";
    public static final String KEYWORD = "keyword";
    private static final List<String> KIND_ORDER = List.of(NAME, CODE, KEYWORD);

    /** 시각 정밀도 — 수집기 payload {@code timePrecision}. 날짜만이면 블록에 시각을 적지 않습니다(알 수 있는 시각은 짐작한 상한이라). */
    public static final String PRECISION_DATE = "date";

    /** 섹션의 말(명세 §4-11 — 미국과 같은 뜻). */
    public static final String NOTE = NewsEvents.NOTE;
    public static final String DISABLED_TEXT = "꺼짐(설정) — kr.news.enabled=false라 싣지 않음(수집은 계속)";
    public static final String MISSING_TEXT = "자료 없음 — 한국 사건 뉴스 저장본(kr_news_headline)이 없습니다";
    public static final String NO_FEEDS_TEXT = "꺼짐(설정) — kr.news.feeds에 고른 피드가 없음";
    public static final String NONE_TEXT = NewsEvents.NONE_TEXT;
    public static final String STALE_NONE_TEXT = NewsEvents.STALE_NONE_TEXT;

    /**
     * 종목 이름 뒤에 붙어도 이름으로 보는 조사 — 그 뒤가 글 끝·글자 아닌 것이어야 합니다('삼성전자서비스'의 '서'·'한화에어로'의 '에'는 조사가 아님).
     * 긴 것부터 맞춥니다.
     */
    public static final List<String> PARTICLES = List.of(
            "에서는", "에서도", "으로는", "으로도", "에게서",
            "에서", "으로", "에게", "까지", "부터", "보다", "처럼", "이나", "이며", "이다", "마저", "조차", "에도", "에는", "와의", "과의",
            "은", "는", "이", "가", "을", "를", "의", "에", "도", "와", "과", "만", "로", "나");

    /**
     * 키워드가 이 낱말 <b>안에만</b> 있으면 걸리지 않습니다(한글 부분 문자열 맞춤의 예외 — 클래스 설명). 키워드를 담은 다른 뜻의 낱말이라 코드
     * 상수입니다(설정 아님 — 사전을 바꿔도 이 예외는 그 낱말에만 걸림).
     */
    public static final List<String> MASKED_WORDS = List.of("유가증권", "신한은행", "추경호");

    private static final DateTimeFormatter DISPLAY = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(NewsEvents.KST);
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_OFFSET_DATE_TIME.withZone(NewsEvents.KST);
    private static final Pattern SPACES = Pattern.compile("[\\p{Z}\\p{Cc}]+");
    private static final Pattern HANGUL = Pattern.compile("[\\p{IsHangul}]");
    private static final Pattern CODE_PATTERN = Pattern.compile("^[0-9A-Z]{6}$");
    private static final String WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
    private static final String WORD_AFTER = "(?![\\p{L}\\p{N}])";
    private static final String PHRASE_GAP = "[ \\-\\u2010\\u2011]+";
    private static final String NAME_AFTER;

    static {
        List<String> quoted = new ArrayList<>();
        PARTICLES.forEach(p -> quoted.add(Pattern.quote(p)));
        NAME_AFTER = "(?=$|[^\\p{L}\\p{N}]|(?:" + String.join("|", quoted) + ")(?:$|[^\\p{L}\\p{N}]))";
    }

    /**
     * 저장본 한 행({@code kr_news_headline} payload — 수집기 B9).
     *
     * @param entity        제목 정규화 해시(같은 제목은 한 행)
     * @param feed          처음 실어 온 피드 키
     * @param feeds         그 제목을 실어 온 피드 키 전부(없으면 null)
     * @param publishedDate 발행 KST 날짜(날짜만 주는 피드도 있음)
     * @param timePrecision second·minute·date
     * @param knownAt       알 수 있는 시각(클래스 설명 '창'). 없으면 창에 들지 않음
     * @param fetchedAt     처음 받은 시각. 없으면 넣지 않음(결정 전에 받았는지 모름)
     */
    public record Headline(String entity, String title, String link, String source, String feed, List<String> feeds,
                           LocalDate publishedDate, String timePrecision, Instant knownAt, Instant fetchedAt) {

        public Headline {
            feeds = feeds == null ? null : feeds.stream().filter(Objects::nonNull).toList();
        }

        /** 실어 온 피드 키 — {@code feed}와 {@code feeds}를 합친 것(미국 {@link NewsEvents.Headline#carriers}와 같은 규칙). */
        public Set<String> carriers() {
            Set<String> out = new LinkedHashSet<>();
            if (feed != null && !feed.isBlank()) {
                out.add(feed.strip());
            }
            if (feeds != null) {
                feeds.stream().filter(f -> !f.isBlank()).map(String::strip).forEach(out::add);
            }
            return out;
        }
    }

    /**
     * 설정({@code kr.news.*}).
     *
     * @param maxPerDay 상한 — null이면 {@link NewsEvents#DEFAULT_MAX_PER_DAY}, 0~{@link NewsEvents#MAX_PER_DAY_LIMIT} 밖은 그 끝으로
     * @param keywords  키워드(빈 값·대소문자만 다른 중복은 앞의 것만)
     * @param feeds     패킷에 넣을 피드 키 — null이면 전부, 비었으면 {@link #NO_FEEDS}
     */
    public record Settings(boolean enabled, Integer maxPerDay, List<String> keywords, Collection<String> feeds) {

        public Settings {
            List<String> words = new ArrayList<>();
            Set<String> seen = new LinkedHashSet<>();
            if (keywords != null) {
                for (String k : keywords) {
                    String w = k == null ? "" : clean(Normalizer.normalize(k, Normalizer.Form.NFC));
                    if (!w.isEmpty() && seen.add(w.toLowerCase(Locale.ROOT))) {
                        words.add(w);
                    }
                }
            }
            keywords = List.copyOf(words);
            if (feeds != null) {
                TreeSet<String> keys = new TreeSet<>();
                for (String f : feeds) {
                    if (f != null && !f.isBlank()) {
                        keys.add(f.strip());
                    }
                }
                feeds = Collections.unmodifiableSet(keys);
            }
        }

        /** 실제로 쓰는 상한(클램프). */
        public int cap() {
            int value = maxPerDay == null ? NewsEvents.DEFAULT_MAX_PER_DAY : maxPerDay;
            return Math.max(0, Math.min(NewsEvents.MAX_PER_DAY_LIMIT, value));
        }
    }

    /**
     * 걸 대상 — 6자리 코드 → 이름들(금융위 종목명·DART 회사명·별칭). 코드는 대문자로 맞추고 6자리 영문 대문자·숫자가 아니면 버립니다. 이름은 NFC·공백
     * 접기 뒤 빈 것을 뺍니다.
     */
    public record Targets(Map<String, ? extends Collection<String>> names) {

        public Targets {
            Map<String, List<String>> out = new TreeMap<>();
            if (names != null) {
                names.forEach((code, list) -> {
                    String key = code == null ? "" : code.strip().toUpperCase(Locale.ROOT);
                    if (!CODE_PATTERN.matcher(key).matches()) {
                        return;
                    }
                    TreeSet<String> cleaned = new TreeSet<>();
                    if (list != null) {
                        for (String name : list) {
                            String c = name == null ? "" : clean(Normalizer.normalize(name, Normalizer.Form.NFC));
                            if (!c.isEmpty()) {
                                cleaned.add(c);
                            }
                        }
                    }
                    out.merge(key, List.copyOf(cleaned), (a, b) -> {
                        TreeSet<String> merged = new TreeSet<>(a);
                        merged.addAll(b);
                        return List.copyOf(merged);
                    });
                });
            }
            names = Collections.unmodifiableMap(out);
        }
    }

    /**
     * 걸린 이유 하나.
     *
     * @param kind  {@link #NAME}·{@link #CODE}·{@link #KEYWORD}
     * @param value 걸린 이름·코드·키워드(설정·저장본의 철자)
     * @param code  이름·코드면 그 종목 코드, 키워드면 null
     */
    public record Match(String kind, String value, String code) {

        /** 예: {@code name 삼성전자 (005930)}·{@code code 005930}·{@code keyword 기준금리}. */
        public String label() {
            return NAME.equals(kind) ? kind + " " + value + " (" + code + ")" : kind + " " + value;
        }
    }

    /** 섹션 한 줄 — 제목·출처는 sanitize·공백 접기를 거친 글. */
    public record Item(int k, String entity, String title, String link, String source, String feed, Instant knownAt,
                       LocalDate publishedDate, String timePrecision, List<Match> matched) {

        public Item {
            matched = List.copyOf(matched);
        }

        /** 날짜만 주는 피드인가(알 수 있는 시각은 짐작한 상한 — 시각을 적지 않음). */
        public boolean dateOnly() {
            return PRECISION_DATE.equals(timePrecision);
        }

        /** 알 수 있는 시각(ISO KST) — 날짜만이면 null. */
        public String knownAtKst() {
            return dateOnly() ? null : ISO.format(knownAt);
        }

        /** 발행 날짜(KST) — 날짜만인 줄에만. */
        public String publishedDateText() {
            return dateOnly() && publishedDate != null ? publishedDate.toString() : null;
        }

        public List<String> matchedLabels() {
            return matched.stream().map(Match::label).toList();
        }

        /**
         * {@code <<사건 #k 시작>> [출처 · yyyy-MM-dd HH:mm KST] 제목 <<사건 #k 끝>>} — 날짜만인 줄은 {@code [출처 · yyyy-MM-dd(날짜만)]}.
         */
        public String block() {
            String when = dateOnly()
                    ? (publishedDate == null ? "날짜 모름" : publishedDate + "(날짜만)")
                    : DISPLAY.format(knownAt) + " KST";
            return "<<사건 #" + k + " 시작>> [" + source + " · " + when + "] " + title + " <<사건 #" + k + " 끝>>";
        }
    }

    /**
     * 계산 결과 — 칸의 뜻은 미국 {@link NewsEvents.Result}와 같습니다(상태·실은 줄·창 안 제목 수·걸린 수·뺀 수·상한·수집 범위).
     *
     * @param lastFetchedAt 받은 시각이 창 끝 이하인 행 가운데 가장 늦은 받은 시각
     */
    public record Result(String status, NewsEvents.Window window, List<Item> items, Integer candidates, Integer matched,
                         Integer omitted, int cap, String coverage, Instant collectedSince, Instant lastFetchedAt) {

        public Result {
            items = List.copyOf(items);
        }

        /** 측정 태그 {@code hasEvents} — 미국 {@link NewsEvents.Result#eventCount}와 같은 규칙. */
        public Integer eventCount() {
            if (NONE.equals(status) && (NewsEvents.STALE.equals(coverage)
                    || NewsEvents.BEFORE_COLLECTION.equals(coverage))) {
                return null;
            }
            return OK.equals(status) || NONE.equals(status) ? items.size() : null;
        }

        /** 측정 태그 {@code eventIds} — 실은 줄의 entity, 섹션 순서. */
        public List<String> eventIds() {
            return items.stream().map(Item::entity).filter(Objects::nonNull).toList();
        }

        /** 창이 수집 범위를 다 덮지 못했을 때의 말(미국과 같은 문장). */
        public String coverageNote() {
            if (coverage == null || NewsEvents.COVERED.equals(coverage)) {
                return null;
            }
            String since = collectedSince == null ? null : DISPLAY.format(collectedSince) + " KST";
            return switch (coverage) {
                case NewsEvents.PARTIAL -> "창 중간(" + since + ")부터 수집한 자료 — 그 전 사건은 빠졌을 수 있음";
                case NewsEvents.BEFORE_COLLECTION -> "창이 저장본의 가장 이른 수집(" + since
                        + ")보다 앞 — 수집 전이거나 보존 7일 밖이라 이 창의 사건은 빠졌을 수 있음(피드는 최근 항목만 줌)";
                case NewsEvents.STALE -> "창 끝 " + Duration.between(lastFetchedAt, window.to()).toHours() + "시간 전("
                        + DISPLAY.format(lastFetchedAt) + " KST)부터 새로 받은 제목 없음 — 수집이 멈췄거나 피드가 실패해 그 뒤 사건은 "
                        + "빠졌을 수 있음";
                default -> "받은 시각이 없어 수집 범위를 모름";
            };
        }

        /** 패킷에 싣는 글 — 줄마다 {@link Item#block}, 줄이 없으면 상태의 말. */
        public String text() {
            return switch (status) {
                case DISABLED -> DISABLED_TEXT;
                case MISSING -> MISSING_TEXT;
                case NO_FEEDS -> NO_FEEDS_TEXT;
                case NONE -> coverageNote() == null ? NONE_TEXT
                        : (NewsEvents.STALE.equals(coverage) ? STALE_NONE_TEXT : NONE_TEXT) + " — " + coverageNote();
                default -> items.isEmpty()
                        ? "상한 0건(설정 kr.news.maxPerDay) — 걸린 " + matched + "건은 싣지 않음"
                        : String.join("\n", items.stream().map(Item::block).toList());
            };
        }
    }

    /**
     * 창 안의 사건(클래스 설명).
     *
     * @param stored   저장본 전체(창 밖도 — 가장 이른 수집 시각으로 수집 범위를 정함). null·빈 목록이면 {@link #MISSING}
     * @param window   (직전 KR 거래일 결정 순간, 기준 세션 결정 순간]
     * @param readAt   읽은 순간 — 받은 시각이 이 뒤인 행은 넣지 않음
     * @param settings null이면 켬·기본 상한·키워드 없음·피드 전부
     * @param targets  null이면 없음(키워드만)
     * @param sanitize 제목·출처에서 구분자 모양을 지우는 함수(호출부)
     */
    public static Result compute(List<Headline> stored, NewsEvents.Window window, Instant readAt, Settings settings,
                                 Targets targets, UnaryOperator<String> sanitize) {
        Objects.requireNonNull(window, "창이 없습니다");
        Objects.requireNonNull(readAt, "읽은 순간이 없습니다");
        Objects.requireNonNull(sanitize, "구분자 지우기 함수가 없습니다");
        Settings s = settings == null ? new Settings(true, null, null, null) : settings;
        Targets t = targets == null ? new Targets(null) : targets;
        int cap = s.cap();
        if (!s.enabled()) {
            return new Result(DISABLED, window, List.of(), null, null, null, cap, null, null, null);
        }
        // 읽은 순간 뒤에 받은 행은 없는 것으로 봅니다 — 저장본 전체가 그런 행뿐이면 '자료 없음'(그 순간에는 수집 증거가 없음).
        List<Headline> known = stored == null ? List.of() : stored.stream().filter(Objects::nonNull)
                .filter(h -> h.fetchedAt() != null && !h.fetchedAt().isAfter(readAt)).toList();
        if (known.isEmpty()) {
            return new Result(MISSING, window, List.of(), null, null, null, cap, null, null, null);
        }
        if (s.feeds() != null && s.feeds().isEmpty()) {
            return new Result(NO_FEEDS, window, List.of(), null, null, null, cap, null, null, null);
        }

        Instant since = known.stream().map(Headline::fetchedAt).min(Comparator.naturalOrder()).orElse(null);
        Instant last = known.stream().map(Headline::fetchedAt).filter(at -> !at.isAfter(window.to()))
                .max(Comparator.naturalOrder()).orElse(null);
        String coverage = since == null ? NewsEvents.UNKNOWN
                : since.isAfter(window.to()) ? NewsEvents.BEFORE_COLLECTION
                : last.isBefore(window.to().minus(NewsEvents.STALE_AFTER)) ? NewsEvents.STALE
                : !since.isAfter(window.from()) ? NewsEvents.COVERED
                : NewsEvents.PARTIAL;

        Map<Object, Headline> distinct = new LinkedHashMap<>();
        known.stream()
                .filter(h -> window.contains(learnedAt(h)))
                .filter(h -> s.feeds() == null || h.carriers().stream().anyMatch(s.feeds()::contains))
                .sorted(ORDER)
                .forEach(h -> distinct.putIfAbsent(h.entity() == null ? new Object() : h.entity(), h));

        List<Compiled> patterns = compile(t, s.keywords());
        List<Item> hits = new ArrayList<>();
        for (Headline h : distinct.values()) {
            String title = display(h.title(), sanitize);
            List<Match> matched = match(title, patterns);
            if (matched.isEmpty()) {
                continue;
            }
            String source = display(h.source(), sanitize);
            if (source.isEmpty()) {
                source = h.feed() == null || h.feed().isBlank() ? "출처 미상" : h.feed().strip();
            }
            hits.add(new Item(hits.size() + 1, h.entity(), title, h.link(), source, h.feed(), h.knownAt(),
                    h.publishedDate(), h.timePrecision(), matched));
        }
        List<Item> shown = hits.subList(0, Math.min(cap, hits.size()));
        return new Result(hits.isEmpty() ? NONE : OK, window, shown, distinct.size(), hits.size(),
                hits.size() - shown.size(), cap, coverage, since, last);
    }

    /**
     * 시스템이 그 제목을 알게 된 시각 = max(알 수 있는 시각, 처음 받은 시각) — 창 판정에 씁니다(클래스 설명 '창'). 알 수 있는 시각이 없으면 null(창에
     * 들지 않음).
     */
    static Instant learnedAt(Headline h) {
        if (h.knownAt() == null) {
            return null;
        }
        return h.fetchedAt() != null && h.fetchedAt().isAfter(h.knownAt()) ? h.fetchedAt() : h.knownAt();
    }

    /** 알 수 있는 시각 내림차순 → entity → 피드 → 링크 → 제목(null은 뒤). */
    static final Comparator<Headline> ORDER = Comparator
            .comparing(Headline::knownAt, Comparator.reverseOrder())
            .thenComparing(Headline::entity, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Headline::feed, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Headline::link, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Headline::title, Comparator.nullsLast(Comparator.naturalOrder()));

    /**
     * 제목에 그 키워드가 걸리나(클래스 설명 '맞추기' — 시험·설명용으로 엽니다). 걸린 첫 자리, 없으면 −1.
     */
    public static int keywordAt(String title, String keyword) {
        String t = clean(Normalizer.normalize(title == null ? "" : title, Normalizer.Form.NFC));
        String k = clean(Normalizer.normalize(keyword == null ? "" : keyword, Normalizer.Form.NFC));
        if (k.isEmpty()) {
            return -1;
        }
        return find(keywordPattern(k), t, HANGUL.matcher(k).find() ? k : null);
    }

    /** 제목에 그 종목 이름이 걸리나(클래스 설명 '맞추기' — 조사 허용). 걸린 첫 자리, 없으면 −1. */
    public static int nameAt(String title, String name) {
        return nameAt(title, name, List.of());
    }

    /**
     * {@link #nameAt(String, String)}에 다른 대상의 이름을 더한 것 — 그중 이 이름으로 시작하는 더 긴 이름('KT'에 'KT&G')이 그 자리에서 시작하면 그
     * 자리는 건너뜁니다(클래스 설명 '맞추기'의 '다른 대상의 더 긴 이름').
     */
    public static int nameAt(String title, String name, Collection<String> otherNames) {
        String t = clean(Normalizer.normalize(title == null ? "" : title, Normalizer.Form.NFC));
        String n = clean(Normalizer.normalize(name == null ? "" : name, Normalizer.Form.NFC));
        if (n.isEmpty()) {
            return -1;
        }
        List<String> others = new ArrayList<>();
        if (otherNames != null) {
            otherNames.forEach(o -> others.add(clean(Normalizer.normalize(o == null ? "" : o, Normalizer.Form.NFC))));
        }
        return find(namePattern(n), t, null, longerNames(n, others));
    }

    /**
     * 맞출 패턴 하나 — 종류·값·코드·패턴, 한글 키워드면 가림 판정에 쓰는 키워드 글, 이름이면 그 이름으로 시작하는 다른 대상의 더 긴 이름(그 자리에서
     * 시작하면 건너뜀).
     */
    private record Compiled(String kind, String value, String code, Pattern pattern, String hangulKeyword,
                            List<String> longer) {
    }

    private static List<Compiled> compile(Targets targets, List<String> keywords) {
        List<Compiled> out = new ArrayList<>();
        targets.names().forEach((code, names) -> {
            // 다른 대상(다른 코드)의 이름 — 같은 종목의 다른 이름은 가리지 않습니다(그 이름이 걸리지 않으면 종목을 놓침).
            List<String> others = new ArrayList<>();
            targets.names().forEach((other, list) -> {
                if (!other.equals(code)) {
                    others.addAll(list);
                }
            });
            for (String name : names) {
                out.add(new Compiled(NAME, name, code, namePattern(name), null, longerNames(name, others)));
            }
            out.add(new Compiled(CODE, code, code,
                    Pattern.compile("(?<![0-9A-Za-z])" + Pattern.quote(code) + "(?![0-9A-Za-z])"), null, List.of()));
        });
        for (String keyword : keywords) {
            boolean hangul = HANGUL.matcher(keyword).find();
            out.add(new Compiled(KEYWORD, keyword, null, keywordPattern(keyword), hangul ? keyword : null, List.of()));
        }
        return out;
    }

    /** {@code name}으로 시작하는(대소문자 무시) 더 긴 이름 — 'KT' → 'KT&G', 'LS' → 'LS ELECTRIC'. */
    private static List<String> longerNames(String name, Collection<String> others) {
        String prefix = name.toLowerCase(Locale.ROOT);
        List<String> out = new ArrayList<>();
        for (String other : others) {
            if (other.length() > name.length() && other.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                out.add(other);
            }
        }
        return out;
    }

    private static Pattern namePattern(String name) {
        return Pattern.compile(WORD_BEFORE + Pattern.quote(name) + NAME_AFTER,
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    /** 한글이 든 키워드는 부분 문자열(키워드 안 공백 = 공백 0개 이상), 아니면 낱말·구절 경계 — 둘 다 대소문자 무시. */
    private static Pattern keywordPattern(String keyword) {
        List<String> parts = new ArrayList<>();
        for (String w : keyword.split(" ")) {
            parts.add(Pattern.quote(w));
        }
        String regex = HANGUL.matcher(keyword).find()
                ? String.join("\\s*", parts)
                : WORD_BEFORE + String.join(PHRASE_GAP, parts) + WORD_AFTER;
        return Pattern.compile(regex, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    /** 패턴이 처음 걸린 자리 — 한글 키워드면 {@link #MASKED_WORDS} 안에만 있는 자리는 건너뜀. 없으면 −1. */
    private static int find(Pattern pattern, String title, String hangulKeyword) {
        return find(pattern, title, hangulKeyword, List.of());
    }

    /** {@link #find(Pattern, String, String)}에 더해 {@code longer}의 이름 하나가 그 자리에서 시작하면(대소문자 무시) 건너뜀. */
    private static int find(Pattern pattern, String title, String hangulKeyword, List<String> longer) {
        Matcher m = pattern.matcher(title);
        while (m.find()) {
            if ((hangulKeyword == null || !masked(title, m.start(), m.end())) && !startsLonger(title, m.start(), longer)) {
                return m.start();
            }
        }
        return -1;
    }

    private static boolean startsLonger(String title, int at, List<String> longer) {
        for (String name : longer) {
            if (title.regionMatches(true, at, name, 0, name.length())) {
                return true;
            }
        }
        return false;
    }

    /** [start, end)가 가림 낱말 하나의 안에 들어가나. */
    private static boolean masked(String title, int start, int end) {
        for (String word : MASKED_WORDS) {
            int from = Math.max(0, end - word.length());
            int to = Math.min(start, title.length() - word.length());
            for (int at = from; at <= to; at++) {
                if (title.startsWith(word, at)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static List<Match> match(String title, List<Compiled> patterns) {
        record Hit(Match match, int kindRank, int at) {
        }
        List<Hit> hits = new ArrayList<>();
        for (Compiled c : patterns) {
            int at = find(c.pattern(), title, c.hangulKeyword(), c.longer());
            if (at >= 0) {
                hits.add(new Hit(new Match(c.kind(), c.value(), c.code()), KIND_ORDER.indexOf(c.kind()), at));
            }
        }
        hits.sort(Comparator.comparingInt(Hit::kindRank).thenComparingInt(Hit::at)
                .thenComparing(h -> h.match().value()));
        return hits.stream().map(Hit::match).toList();
    }

    /** 패킷에 보일 글 — NFC → 공백 접기 → sanitize → 다시 접기(미국과 같음). */
    private static String display(String text, UnaryOperator<String> sanitize) {
        if (text == null) {
            return "";
        }
        String once = clean(Normalizer.normalize(text, Normalizer.Form.NFC));
        String stripped = sanitize.apply(once);
        return clean(stripped == null ? "" : stripped);
    }

    static String clean(String text) {
        return SPACES.matcher(text).replaceAll(" ").strip();
    }
}
