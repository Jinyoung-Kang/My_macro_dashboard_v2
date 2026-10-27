package com.macrodash.feature.paper;

import com.macrodash.analytics.NewsEvents;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 🧪 화면에서 바꿀 수 있는 설정 키(설계 §4-4, 명세 S1~S3) — 키(설정 본문 안의 점 경로)마다 형·범위·고를 수 있는 값·규칙 책 영향.
 *
 * <p>범위는 읽는 쪽({@link PaperSettings}·{@code RuleSettings}·{@code TrackRecordSettings}·{@code PacketBuilder.Limits}·
 * {@link ClaudeBookService.ClaudeSettings})이 받는 범위 <b>안</b>으로 잡았습니다 — 쓰기 API를 지난 값이 읽을 때 기본값으로 바뀌는 일이
 * 없게. 읽는 쪽보다 좁은 곳(슬리피지 100bp, 스탑 50% 등)은 실험이 뜻을 잃는 값을 막으려는 것입니다.
 *
 * <p><b>규칙 책 영향</b>({@code affectsRules}, S3): 규칙 책(대조군)의 코드가 읽는 키 전부입니다 — 트랙레코드·섞기·배분·스탑·재진입
 * 금지·비중 상한·최소 금액·유니버스 ETF·현금성 종목·슬리피지. 계약이 적은 목록(trackRecord.*·minHolders·rulesMaxNames·trailingStopPct·
 * maxWeight*)과 설계 §4-4의 blend.*에 더해, 규칙 책 계획·장부가 실제로 읽는 나머지 키도 넣었습니다(바꾸면 대조군의 조건이 바뀌는 것은
 * 같아서).
 *
 * <p><b>시장 범위</b>({@link Scope}, 2단계 명세 §4-13 — 설정은 한 행이고 한국 키는 {@code kr.*} 묶음): 키마다 어느 책이 읽는지 —
 * 두 책 공통({@code model}·{@code effort}·{@code apiDailyCallCap}·{@code pricing.*}·{@code frameworkTokenBudget}과 그 뒤 공통 키),
 * 미국 책, 한국 책({@code kr.} 접두어와 같음 — 접두어와 범위가 어긋나면 클래스가 올라오지 않음). {@code affectsRules}는 <b>그 시장</b> 규칙
 * 계좌가 읽는 키이고, 저장 경고({@link #rulesWarning})도 그 시장 규칙 계좌 이름으로 냅니다 — 미국 키만 바꾸면 지금 문장 그대로입니다.
 */
final class PaperSettingKeys {

    private PaperSettingKeys() {
    }

    /** 미국 규칙 책 영향 키를 바꿨을 때의 경고(명세 S3) — 화면의 확인 문구와 같은 문장입니다. */
    static final String RULES_FROZEN_WARNING = "규칙 계좌는 동결된 대조군입니다 — 이 변경은 실험 조건을 바꿉니다";

    /** 한국 규칙 계좌({@code kr_rules}, 2단계 명세 K1) 영향 키를 바꿨을 때의 경고 — 화면 확인 문구와 같은 문장입니다. */
    static final String KR_RULES_FROZEN_WARNING =
            "한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다";

    /**
     * 키를 읽는 책(시장 범위). {@link #market}은 화면에 보내는 값({@code paper_books.market}과 같은 US·KR, 두 책 공통이면 null)이고
     * {@link #prefix}는 그 범위 키의 접두어입니다(한국 {@code kr.} — 미국·공통은 접두어 없음).
     */
    enum Scope {
        SHARED(null, ""), US("US", ""), KR("KR", "kr.");

        final String market;
        final String prefix;

        Scope(String market, String prefix) {
            this.market = market;
            this.prefix = prefix;
        }

        /** 키 이름으로 정한 기본 범위 — {@code kr.}로 시작하면 한국, 아니면 미국(공통 키는 {@link #shared}로 따로 표시). */
        static Scope ofKey(String key) {
            return key.startsWith(KR.prefix) ? KR : US;
        }
    }

    /**
     * 값의 형. {@link #wire}는 화면에 보내는 이름(frontend lib/paper.ts settingKind가 읽는 이름). {@code PHRASES}는 낱말·구절 목록
     * (사건 뉴스 키워드 — "rate decision"처럼 공백이 든 항목)이라 화면이 공백으로 나누지 않게 {@code list}와 다른 이름입니다. {@code FEEDS}는
     * 정해진 피드 키({@link Spec#options})만 받는 목록입니다 — 화면에는 {@code list}로 보냅니다(선택지가 있으면 화면이 한 값 고르기로 그림).
     *
     * <p>2단계(C1b, 명세 K38)에 더한 넷 — 모두 저장할 때 정해진 모양으로 맞춰(순서·표기) 같은 값이 다른 글자로 저장되지 않게 합니다:
     * {@code DATE} 날짜 하나({@code "yyyy-MM-dd"}, {@value #DATE_MIN_TEXT}~{@value #DATE_MAX_TEXT}) ·
     * {@code DATE_LIST} 날짜 목록(중복 제거·오름차순) ·
     * {@code DATE_TIME_MAP} 날짜 → 개장·마감 쌍({@code {"2026-11-19": {"open": "10:00", "close": "16:30"}}} — 둘 다 HH:mm, 개장 &lt; 마감,
     * 날짜 오름차순; 명세 §9 묶음 B 리뷰 메모 '수능일 마감 16:30' — 개장만이 아니라 마감도 바뀌는 날이 있어 쌍으로 둠) ·
     * {@code ALIAS_MAP} 한국 종목 코드 → 별칭 목록({@code {"000660": ["하이닉스"]}} — 코드 6자리 영문 대문자·숫자, 별칭은 {@code PHRASES}와 같은
     * 규칙, 코드 오름차순).
     */
    enum Type {
        NUMBER("number"), INTEGER("integer"), BOOLEAN("boolean"), CHOICE("string"), TIME("time"), TICKERS("list"),
        CIKS("list"), PHRASES("phrases"), FEEDS("list"), DATE("date"), DATE_LIST("dates"), DATE_TIME_MAP("dateTimeMap"),
        ALIAS_MAP("aliasMap");

        final String wire;

        Type(String wire) {
            this.wire = wire;
        }
    }

    /**
     * 키 하나.
     *
     * @param key     설정 본문 안의 점 경로(예: {@code trackRecord.windowYears}) — 바뀐 키 목록·이력에도 이 이름
     * @param min     숫자 키의 최솟값(포함). 아니면 null
     * @param max     숫자 키의 최댓값(포함). 아니면 null
     * @param options 고를 수 있는 값(CHOICE — 하나, FEEDS — 여럿). 아니면 빈 목록
     * @param affectsRules 그 시장({@code scope}) 규칙 계좌가 읽는 키 — 바꾸면 그 시장 경고({@link #rulesWarning})
     * @param scope   키를 읽는 책 — 두 책 공통·미국·한국. 한국 범위 ⇔ {@code kr.} 접두어(어긋나면 예외)
     * @throws IllegalStateException 접두어와 범위가 어긋남(한국 키가 아닌데 {@code kr.}로 시작하거나 그 반대)
     */
    record Spec(String key, Type type, Double min, Double max, List<String> options, boolean affectsRules,
                String description, Scope scope) {

        Spec {
            options = List.copyOf(options);
            if ((scope == Scope.KR) != key.startsWith(Scope.KR.prefix)) {
                throw new IllegalStateException("설정 키의 시장 범위와 접두어가 어긋납니다: " + key + " · " + scope);
            }
        }

        /** 시장 범위를 바꾼 사본(공통 키 표시 — {@link #shared}). */
        Spec withScope(Scope other) {
            return new Spec(key, type, min, max, options, affectsRules, description, other);
        }

        /** 화면에 보내는 모양 {@code {key, type, min, max, affectsRules, market, description, options}}. */
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("key", key);
            out.put("type", type.wire);
            out.put("min", min);
            out.put("max", max);
            out.put("affectsRules", affectsRules);
            // 키를 읽는 책 — US·KR, 두 책 공통이면 null. 화면은 affectsRules 경고를 이 시장의 규칙 계좌로 적습니다.
            out.put("market", scope.market);
            out.put("description", description);
            // 선택지는 한 값 고르기(CHOICE)에만 보냅니다 — 화면은 선택지가 있으면 선택 상자 하나로 그려, 여럿을 고르는 피드 목록이
            // 한 값으로 저장됩니다. 피드 키는 설명(description)에 적습니다.
            out.put("options", type != Type.CHOICE || options.isEmpty() ? null : options);
            return out;
        }
    }

    // 만드는 함수의 시장 범위는 키 이름으로(kr. → 한국, 아니면 미국) — 두 책 공통 키는 shared(…)로 감쌉니다.
    private static Spec number(String key, double min, double max, boolean rules, String description) {
        return new Spec(key, Type.NUMBER, min, max, List.of(), rules, description, Scope.ofKey(key));
    }

    private static Spec integer(String key, int min, int max, boolean rules, String description) {
        return new Spec(key, Type.INTEGER, (double) min, (double) max, List.of(), rules, description, Scope.ofKey(key));
    }

    private static Spec choice(String key, List<String> options, boolean rules, String description) {
        return new Spec(key, Type.CHOICE, null, null, options, rules, description, Scope.ofKey(key));
    }

    private static Spec of(String key, Type type, boolean rules, String description) {
        return new Spec(key, type, null, null, List.of(), rules, description, Scope.ofKey(key));
    }

    /** 두 책 공통 키(명세 §4-13 공유 키) — 규칙 계좌 영향이 없는 키만 받습니다(어느 시장의 대조군인지 정할 수 없어서). */
    private static Spec shared(Spec spec) {
        if (spec.affectsRules()) {
            throw new IllegalStateException("두 책 공통 키는 규칙 계좌 영향이 없어야 합니다: " + spec.key());
        }
        return spec.withScope(Scope.SHARED);
    }

    /** 화면에 보이는 순서이기도 합니다(점 경로의 첫 마디로 묶음). */
    static final List<Spec> ALL = List.of(
            shared(choice("model", ClaudeBookService.MODELS, false,
                    "Claude 계좌 모델(D5) — 거절·오류 때 다른 모델로 자동 전환하지 않음")),
            shared(choice("effort", ClaudeBookService.EFFORTS, false, "Claude 계좌 effort(C2 기본 high)")),
            shared(integer("apiDailyCallCap", 0, ClaudeBookService.MAX_DAILY_CALL_CAP, false,
                    "하루(KST) Claude 호출 상한(D18) — 정기·수동 결정·재시도·미리보기·시작을 모두 셈. 0이면 부르지 않음")),
            shared(integer("apiScheduledReserve", 0, ClaudeBookService.MAX_DAILY_CALL_CAP, false,
                    "정기 작업 몫 예약(2단계 K18, 두 책 공통) — 수동 호출(미리보기·프레임 제안·수동 실행)은 그날 호출이 상한 − 예약 "
                            + "미만일 때만, 정기 작업은 상한까지. 기본 7, claude.figureCheck를 켜면 9 권장. 예약이 상한 이상이면 수동 "
                            + "호출은 늘 막힘. 지금은 읽는 코드가 없음(한국 Claude 계좌 E2에서 연결 — 그 전에는 바꿔도 동작 같음)")),
            of("decisionTimeKst", Type.TIME, false, "결정 시각(KST, HH:mm) — 미국 세션 다음 날 이 시각부터 그 거래일 결정(C1)"),
            of("decisionDeadlineKst", Type.TIME, false,
                    "확정 종가를 기다리는 기한(KST, HH:mm) — 지나면 있는 값으로 진행하고 pricesFinal=false"),
            number("slippageBp", 0, 100, true, "체결 슬리피지(bp) — 네 계좌 공통(D9)"),
            number("maxWeightStockPct", 1, 100, true, "종목당 비중 상한(%) — Claude 검증기·규칙 계좌(D8)"),
            number("maxWeightEtfPct", 1, 100, true, "ETF 비중 상한(%) — Claude 검증기·규칙 계좌(D8)"),
            integer("maxPositions", 1, 100, false, "매수 뒤 최대 종목 수(현금성 제외) — Claude 검증기"),
            number("trailingStopPct", 1, 50, true, "트레일링 스탑(%) — 최고가 대비 이만큼 떨어지면 전량 매도(D10)"),
            integer("lockoutTradingDays", 0, 250, true, "스탑 뒤 재진입 금지 거래일(D10)"),
            integer("maxDiscretionaryOrdersPerMonth", 0, 200, false, "Claude 재량 주문 월 상한(C9)"),
            integer("minHoldTradingDaysForSell", 0, 60, false, "Claude 재량 매도 전 최소 보유 거래일(C9, 스탑 제외)"),
            number("minOrderNotional", 0, 100_000, true, "주문 최소 금액(달러) — Claude 검증기·규칙 계좌 매수(C9)"),
            integer("minHolders", 1, 12, true, "규칙 계좌 매수 후보·매도 신호가 되는 최소 기관 수(R2)"),
            integer("rulesMaxNames", 1, 50, true, "규칙 계좌 매수 종목 수 상한(R4)"),
            of("parkCashInShy", Type.BOOLEAN, true, "규칙 계좌가 남는 현금을 SHY에 둠(R3)"),
            of("universeExtraTickers", Type.TICKERS, true, "유니버스에 늘 넣는 ETF(D8) — ETF 비중 상한을 받는 종목"),
            of("cashLikeTickers", Type.TICKERS, true, "현금성 종목(스탑·비중 상한·종목 수 제외, 기본 SHY)"),
            integer("notesDefaultExpiryTradingDays", 1, 60, false, "시황 메모 기본 만료(거래일, F6)"),
            integer("notesMaxCharsInPacket", 0, 20_000, false, "패킷에 싣는 유효 메모 합계 글자 수(F6)"),
            shared(integer("frameworkTokenBudget", 1_000, 50_000, false,
                    "프레임 렌더링 크기 예산(토큰 어림, F4 — 넘으면 경고)")),
            shared(number("pricing.sonnet.inputUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Sonnet 입력 단가(달러/100만 토큰, 추정 비용 C8). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.sonnet.outputUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Sonnet 출력 단가(달러/100만 토큰, 사고 포함). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.sonnet.cacheReadUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Sonnet 캐시 읽기 단가(달러/100만 토큰). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.sonnet.cacheWriteUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Sonnet 캐시 쓰기 단가(달러/100만 토큰). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.haiku.inputUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Haiku 입력 단가(달러/100만 토큰, 프롬프트 100K 토큰 이하 단가). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.haiku.outputUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Haiku 출력 단가(달러/100만 토큰, 프롬프트 100K 토큰 이하 단가). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.haiku.cacheReadUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Haiku 캐시 읽기 단가(달러/100만 토큰, 프롬프트 100K 토큰 이하 단가). " + PaperApiCalls.PRICE_NOTE)),
            shared(number("pricing.haiku.cacheWriteUsdPerMTok", 0, PaperApiCalls.MAX_PRICE, false,
                    "Haiku 캐시 쓰기 단가(달러/100만 토큰, 프롬프트 100K 토큰 이하 단가). " + PaperApiCalls.PRICE_NOTE)),
            integer("trackRecord.windowYears", 1, 7, true, "그룹 A 트랙레코드 창(년, D6)"),
            integer("trackRecord.topN", 1, 50, true, "그룹 A 선정 수(R1)"),
            choice("trackRecord.metric", List.of("CAGR", "EXCESS_VS_SPY", "SHARPE"), true, "순위 기준(R10, D20)"),
            integer("trackRecord.minPeriods", 0, 30, true, "자격: 창 안 최소 구간 수(R9)"),
            number("trackRecord.minCoverage", 0, 1, true, "자격: 모든 구간의 최소 커버리지(0~1, R9)"),
            number("trackRecord.avgCoverage", 0, 1, true, "자격: 평균 커버리지(0~1, R9)"),
            of("trackRecord.candidateCiks", Type.CIKS, true, "후보 기관 CIK 목록(D21) — 바꾸면 그룹 A 순위가 달라짐"),
            number("rules.parkCashThresholdPct", 0, 20, true, "재선정일이 아닌 날 남는 현금을 SHY에 두는 기준(순자산 %)"),
            integer("blend.groupB.topN", 1, 12, true, "그룹 B 선정 수(D27)"),
            integer("blend.groupB.windowYears", 1, 2, true, "그룹 B 트랙레코드 창(년, D27)"),
            integer("blend.groupB.minPeriods", 1, 8, true, "그룹 B 자격: 최소 구간 수(D27)"),
            number("blend.groupWeightA", 0, 1, true, "기관 가중에서 그룹 A 몫(0~1, D27)"),
            number("blend.convictionCapPct", 1, 50, true, "확신도 상한(그 종목의 기관 내 비중 %, D27)"),
            choice("blend.allocation", List.of("CONVICTION", "EQUAL"), true, "규칙 계좌 배분 방식(확신도 비례·동일 비중, D27)"),
            number("blend.minTargetPct", 0, 10, true, "확신도 비례 배분의 최소 목표 비중(%, D27)"),
            number("gate.us10yStage1", 0, 20, false, "OS 게이트 참고 — 10년물 1단계(%) · 구속하지 않음(D7)"),
            number("gate.us10yFull", 0, 20, false, "OS 게이트 참고 — 10년물 전면(%) · 구속하지 않음(D7)"),
            number("gate.brentMax", 0, 500, false, "OS 게이트 참고 — 브렌트 상한(달러) · 구속하지 않음"),
            number("gate.wtiMax", 0, 500, false, "OS 게이트 참고 — WTI 상한(달러) · 구속하지 않음"),
            number("gate.usdjpyMin", 50, 400, false, "OS 게이트 참고 — 달러/엔 하한 · 구속하지 않음"),
            integer("gate.confirmDays", 1, 60, false, "OS 게이트 참고 — 연속 확인 거래일"),
            of("news.enabled", Type.BOOLEAN, false,
                    "Claude 계좌 패킷에 사건 뉴스 섹션 11b_events를 넣음(2단계 B) — 꺼도 수집은 계속, 패킷에서만 뺌"),
            integer("news.maxPerDay", 0, NewsEvents.MAX_PER_DAY_LIMIT, false,
                    "패킷에 싣는 사건 헤드라인 상한(직전 결정 이후 — 평일 24시간, 주말·휴장 뒤는 그 사이 전부, 최신순 — B4)"),
            of("news.keywords", Type.PHRASES, false,
                    "매크로 키워드(영어 낱말·구절, 대소문자 무시, 쉼표·줄바꿈으로 나눔 — B3). 보유·후보·watchlist 티커는 따로 잡음"),
            new Spec("news.feeds", Type.FEEDS, null, null, NewsEvents.DEFAULT_FEEDS, false,
                    "패킷에 넣을 피드 키(수집은 여덟 피드 모두) — " + String.join(" · ", NewsEvents.DEFAULT_FEEDS), Scope.US),
            // 3단계 스위치(2단계 명세 K22·K37) — 한국 책 출발일 S에 설정 저장 한 번으로 함께 켜 두 책이 같은 날 같은 판이 됩니다.
            // 지금은 읽는 코드가 없습니다(꺼짐 = 미국 packetVersion 5·스키마·프롬프트 바이트 그대로 — PacketBuilderTest·FrameworkServiceTest).
            shared(of("calendar.consensus", Type.BOOLEAN, false,
                    "Claude 패킷 1b_calendar에 미국 컨센서스(Nasdaq — forecast·previous·unit) 열을 실음(2단계 K22, 두 책 공통) — "
                            + "켜면 미국 packetVersion 6. 한국 책 출발일에 claude.* 스위치와 같은 저장으로 켬. 지금은 읽는 코드가 "
                            + "없음(E1에서 연결)")),
            shared(of("claude.schemaV3", Type.BOOLEAN, false,
                    "Claude 결정 스키마 v3(bearCase, 3단계 — 2단계 K37, 두 책 공통). 한국 책 출발일에 함께 켬. 지금은 읽는 코드가 없음")),
            shared(of("claude.figureCheck", Type.BOOLEAN, false,
                    "Claude 응답의 숫자 근거 검사 + 교정 재호출(3단계 — 2단계 K37, 두 책 공통, 결정마다 호출 +1 — "
                            + "apiScheduledReserve 9 권장). 한국 책 출발일에 함께 켬. 지금은 읽는 코드가 없음")));

    private static final Map<String, Spec> BY_KEY;

    static {
        Map<String, Spec> byKey = new LinkedHashMap<>();
        for (Spec spec : ALL) {
            if (byKey.put(spec.key(), spec) != null) {
                throw new IllegalStateException("설정 키가 두 번 있습니다: " + spec.key());
            }
        }
        BY_KEY = Collections.unmodifiableMap(byKey);
    }

    private static final Pattern TIME = Pattern.compile("([01]\\d|2[0-3]):[0-5]\\d");
    /** 날짜 형(DATE·DATE_LIST·DATE_TIME_MAP)이 받는 범위 — 자리 수 오타(0202-…·2206-…)를 막는 값이고 뜻 있는 한계는 아닙니다. */
    static final String DATE_MIN_TEXT = "2000-01-01";
    static final String DATE_MAX_TEXT = "2099-12-31";
    private static final LocalDate DATE_MIN = LocalDate.parse(DATE_MIN_TEXT);
    private static final LocalDate DATE_MAX = LocalDate.parse(DATE_MAX_TEXT);
    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    /** 날짜 목록·날짜별 시각 표의 항목 수 상한 — 임시휴장·장 시간 변경일은 한 해 몇 날이라 넉넉합니다. */
    static final int MAX_DATES = 100;
    /** 한국 종목 코드(토스·금융위와 같은 대문자 규칙 — 명세 §4-5, B2 {@code ^A?([0-9A-Z]{6})$}의 6자리). */
    static final Pattern KR_CODE = Pattern.compile("[0-9A-Z]{6}");
    /** 별칭 표의 종목 수·종목당 별칭 수 상한 — 약칭·우선주 별칭(명세 §4-11)은 종목마다 몇 개라 넉넉합니다. */
    static final int MAX_ALIAS_CODES = 200;
    static final int MAX_ALIASES_PER_CODE = 10;
    private static final Pattern TICKER = Pattern.compile("[A-Z0-9][A-Z0-9.\\-]{0,9}");
    private static final int MAX_TICKERS = 50;
    private static final int MAX_CIKS = 100;
    /** 키워드 수·한 항목 글자 수 상한 — 기본 사전이 24개라 넉넉하고, 패킷의 걸린 이유(matched)에 그대로 실리는 글이라 짧게. */
    private static final int MAX_PHRASES = 100;
    private static final int MAX_PHRASE_CHARS = 60;
    /** 키워드 안 공백·보이지 않는 글자 묶음 — 한 칸으로 접습니다(NewsEvents가 낱말 사이를 공백 하나로 읽음). */
    private static final Pattern PHRASE_SPACES = Pattern.compile("[\\s\\p{Z}\\p{Cf}]+");
    /** 키워드에 받지 않는 글자 — 꺾쇠(패킷 구분자 모양)·제어 문자. */
    private static final Pattern PHRASE_FORBIDDEN = Pattern.compile("[<>\\uFF1C\\uFF1E\\uFE64\\uFE65\\p{Cc}]");

    static Optional<Spec> find(String key) {
        return Optional.ofNullable(BY_KEY.get(key));
    }

    /**
     * 바뀐 키에 규칙 계좌 영향 키가 있으면 그 시장 규칙 계좌의 경고 — 미국 키는 {@link #RULES_FROZEN_WARNING}(지금 문장 그대로),
     * 한국 키는 {@link #KR_RULES_FROZEN_WARNING}, 둘 다면 미국 · 한국 순으로 잇습니다. 없으면 null.
     */
    static String rulesWarning(List<Spec> changed) {
        boolean us = changed.stream().anyMatch(spec -> spec.affectsRules() && spec.scope() == Scope.US);
        boolean kr = changed.stream().anyMatch(spec -> spec.affectsRules() && spec.scope() == Scope.KR);
        if (us && kr) {
            return RULES_FROZEN_WARNING + " · " + KR_RULES_FROZEN_WARNING;
        }
        return us ? RULES_FROZEN_WARNING : kr ? KR_RULES_FROZEN_WARNING : null;
    }

    /** 이 경로 아래에 키가 있는 묶음인가({@code blend} → {@code blend.groupB.topN}이 있으니 참). */
    static boolean isGroup(String path) {
        String prefix = path + ".";
        return BY_KEY.keySet().stream().anyMatch(key -> key.startsWith(prefix));
    }

    /** 검사 결과 — 정규화한 값 또는 사유. */
    record Checked(JsonNode value, String error) {
    }

    /**
     * 값 하나를 그 키의 형·범위로 검사하고 저장할 모양으로 맞춥니다(정수 키는 정수, 선택 값은 정해진 표기, 티커는 대문자·중복 제거,
     * CIK는 10자리). 틀리면 무엇을 고칠지 적은 사유.
     */
    static Checked check(Spec spec, JsonNode value) {
        JsonNodeFactory f = JsonNodeFactory.instance;
        String key = spec.key();
        if (value == null || value.isNull()) {
            return error(key + ": 값이 없습니다");
        }
        switch (spec.type()) {
            case NUMBER, INTEGER -> {
                if (!value.isNumber() || !Double.isFinite(value.asDouble())) {
                    return error(key + ": 숫자여야 합니다");
                }
                double v = value.asDouble();
                if (spec.type() == Type.INTEGER && v != Math.rint(v)) {
                    return error(key + ": 정수여야 합니다 — " + value);
                }
                if (v < spec.min() || v > spec.max()) {
                    return error(key + ": " + plain(spec.min()) + "~" + plain(spec.max()) + " 범위여야 합니다 — " + value);
                }
                return new Checked(spec.type() == Type.INTEGER ? f.numberNode((int) v) : f.numberNode(v), null);
            }
            case BOOLEAN -> {
                return value.isBoolean() ? new Checked(f.booleanNode(value.asBoolean()), null)
                        : error(key + ": 예·아니오(true·false)여야 합니다");
            }
            case CHOICE -> {
                if (!value.isString()) {
                    return error(key + ": " + String.join(" · ", spec.options()) + " 가운데 하나여야 합니다");
                }
                String text = value.asString("").strip();
                for (String option : spec.options()) {
                    if (option.equalsIgnoreCase(text)) {
                        return new Checked(f.stringNode(option), null);
                    }
                }
                return error(key + ": " + String.join(" · ", spec.options()) + " 가운데 하나여야 합니다 — " + shown(text));
            }
            case TIME -> {
                String text = value.isString() ? value.asString("").strip() : "";
                return TIME.matcher(text).matches() ? new Checked(f.stringNode(text), null)
                        : error(key + ": HH:mm 형식(00:00~23:59)이어야 합니다 — " + shown(value.toString()));
            }
            case TICKERS -> {
                if (!value.isArray()) {
                    return error(key + ": 티커 목록이어야 합니다");
                }
                Set<String> tickers = new LinkedHashSet<>();
                for (JsonNode item : value) {
                    String text = item.isString() ? item.asString("").strip().toUpperCase(Locale.ROOT) : "";
                    if (!TICKER.matcher(text).matches()) {
                        return error(key + ": 티커 형식이 아닙니다 — " + shown(item.toString()));
                    }
                    tickers.add(text);
                }
                if (tickers.size() > MAX_TICKERS) {
                    return error(key + ": 티커는 " + MAX_TICKERS + "개까지입니다");
                }
                ArrayNode out = f.arrayNode();
                tickers.forEach(out::add);
                return new Checked(out, null);
            }
            case CIKS -> {
                if (!value.isArray()) {
                    return error(key + ": CIK 목록이어야 합니다");
                }
                Set<String> ciks = new LinkedHashSet<>();
                for (JsonNode item : value) {
                    String text = item.isString() ? item.asString("") : item.isIntegralNumber() ? item.asString("") : null;
                    String cik = PaperSelectionService.normalizeCik(text);
                    if (cik == null) {
                        return error(key + ": CIK는 10자리 이하 숫자여야 합니다 — " + shown(item.toString()));
                    }
                    ciks.add(cik);
                }
                if (ciks.isEmpty()) {
                    return error(key + ": 후보 기관이 비면 선정할 수 없습니다");
                }
                if (ciks.size() > MAX_CIKS) {
                    return error(key + ": 후보 기관은 " + MAX_CIKS + "곳까지입니다");
                }
                ArrayNode out = f.arrayNode();
                ciks.forEach(out::add);
                return new Checked(out, null);
            }
            case PHRASES -> {
                return phrases(key, value, MAX_PHRASES);
            }
            case FEEDS -> {
                if (!value.isArray()) {
                    return error(key + ": 피드 키 목록이어야 합니다 — " + String.join(" · ", spec.options()));
                }
                Set<String> feeds = new LinkedHashSet<>();
                for (JsonNode item : value) {
                    String text = item.isString() ? item.asString("").strip().toLowerCase(Locale.ROOT) : "";
                    if (!spec.options().contains(text)) {
                        return error(key + ": 모르는 피드 키 — " + shown(item.toString()) + " (" + String.join(" · ",
                                spec.options()) + ")");
                    }
                    feeds.add(text);
                }
                // 빈 목록도 받습니다 — 패킷 섹션이 '꺼짐(설정) — 고른 피드 없음'으로 적습니다(수집은 계속).
                // 저장은 피드 순서(선택지 순)로 맞춥니다 — 고른 피드는 묶음이라 순서에 뜻이 없는데, 받은 순서대로 두면 같은 묶음이 다른
                // 값으로 비교돼 설정 버전·이력이 늘고 화면이 '기본값과 다름'으로 봅니다.
                ArrayNode out = f.arrayNode();
                spec.options().stream().filter(feeds::contains).forEach(out::add);
                return new Checked(out, null);
            }
            case DATE -> {
                LocalDate date = date(value);
                return date != null ? new Checked(f.stringNode(date.toString()), null)
                        : error(key + ": " + DATE_FORMAT + "이어야 합니다 — " + shown(value.toString()));
            }
            case DATE_LIST -> {
                if (!value.isArray()) {
                    return error(key + ": 날짜 목록이어야 합니다(" + DATE_FORMAT + ")");
                }
                // 날짜 묶음이라 순서에 뜻이 없습니다 — 오름차순으로 맞춰 저장해 순서만 다른 같은 묶음이 설정 판을 올리지 않게.
                java.util.TreeSet<LocalDate> dates = new java.util.TreeSet<>();
                for (JsonNode item : value) {
                    LocalDate date = date(item);
                    if (date == null) {
                        return error(key + ": " + DATE_FORMAT + "이 아닙니다 — " + shown(item.toString()));
                    }
                    dates.add(date);
                }
                if (dates.size() > MAX_DATES) {
                    return error(key + ": 날짜는 " + MAX_DATES + "개까지입니다");
                }
                ArrayNode out = f.arrayNode();
                dates.forEach(date -> out.add(date.toString()));
                return new Checked(out, null);
            }
            case DATE_TIME_MAP -> {
                String shape = key + ": {\"yyyy-MM-dd\": {\"open\": \"HH:mm\", \"close\": \"HH:mm\"}} 모양이어야 합니다";
                if (!value.isObject()) {
                    return error(shape);
                }
                java.util.TreeMap<LocalDate, String[]> entries = new java.util.TreeMap<>();
                for (Map.Entry<String, JsonNode> entry : value.properties()) {
                    LocalDate date = date(entry.getKey());
                    if (date == null) {
                        return error(key + ": 날짜 키가 " + DATE_FORMAT + "이 아닙니다 — " + shown(entry.getKey()));
                    }
                    JsonNode pair = entry.getValue();
                    Set<String> names = new LinkedHashSet<>();
                    if (pair != null && pair.isObject()) {
                        pair.propertyNames().forEach(names::add);
                    }
                    if (!names.equals(Set.of("open", "close"))) {
                        return error(key + ": " + date + " — 개장·마감 둘({\"open\": \"HH:mm\", \"close\": \"HH:mm\"})만 받습니다");
                    }
                    String open = time(pair.get("open"));
                    String close = time(pair.get("close"));
                    if (open == null || close == null) {
                        return error(key + ": " + date + " — 개장·마감은 HH:mm 형식(00:00~23:59)이어야 합니다 — "
                                + shown(pair.toString()));
                    }
                    if (open.compareTo(close) >= 0) {
                        return error(key + ": " + date + " — 마감(" + close + ")이 개장(" + open + ")보다 늦어야 합니다");
                    }
                    entries.put(date, new String[]{open, close});
                }
                if (entries.size() > MAX_DATES) {
                    return error(key + ": 날짜는 " + MAX_DATES + "개까지입니다");
                }
                ObjectNode out = f.objectNode();
                entries.forEach((date, pair) -> out.putObject(date.toString()).put("open", pair[0]).put("close", pair[1]));
                return new Checked(out, null);
            }
            case ALIAS_MAP -> {
                if (!value.isObject()) {
                    return error(key + ": {\"종목 코드\": [\"별칭\", …]} 모양이어야 합니다");
                }
                java.util.TreeMap<String, JsonNode> codes = new java.util.TreeMap<>();
                for (Map.Entry<String, JsonNode> entry : value.properties()) {
                    String code = entry.getKey().strip().toUpperCase(Locale.ROOT);
                    if (!KR_CODE.matcher(code).matches()) {
                        return error(key + ": 종목 코드는 6자리 영문 대문자·숫자여야 합니다 — " + shown(entry.getKey()));
                    }
                    if (codes.containsKey(code)) {
                        return error(key + ": 같은 종목 코드가 두 번 있습니다 — " + code);
                    }
                    Checked aliases = phrases(key + " " + code, entry.getValue(), MAX_ALIASES_PER_CODE);
                    if (aliases.error() != null) {
                        return aliases;
                    }
                    if (aliases.value().isEmpty()) {
                        return error(key + " " + code + ": 별칭이 비었습니다 — 그 종목 줄을 지우세요");
                    }
                    codes.put(code, aliases.value());
                }
                if (codes.size() > MAX_ALIAS_CODES) {
                    return error(key + ": 종목은 " + MAX_ALIAS_CODES + "개까지입니다");
                }
                ObjectNode out = f.objectNode();
                codes.forEach(out::set);
                return new Checked(out, null);
            }
            default -> {
                return error(key + ": 바꿀 수 없는 키입니다");
            }
        }
    }

    /** 날짜 형의 안내 문구. */
    private static final String DATE_FORMAT = "날짜 yyyy-MM-dd(" + DATE_MIN_TEXT + "~" + DATE_MAX_TEXT + ")";

    /** 글자 하나(또는 글자 노드)를 날짜로 — 형식(yyyy-MM-dd)·달력에 있는 날·범위가 아니면 null. */
    private static LocalDate date(JsonNode value) {
        return value != null && value.isString() ? date(value.asString("")) : null;
    }

    private static LocalDate date(String text) {
        String trimmed = text == null ? "" : text.strip();
        if (!DATE.matcher(trimmed).matches()) {
            return null;
        }
        try {
            LocalDate date = LocalDate.parse(trimmed);
            return date.isBefore(DATE_MIN) || date.isAfter(DATE_MAX) ? null : date;
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    /** HH:mm 글자 노드 — 아니면 null. */
    private static String time(JsonNode value) {
        String text = value != null && value.isString() ? value.asString("").strip() : "";
        return TIME.matcher(text).matches() ? text : null;
    }

    /**
     * 낱말·구절 목록(PHRASES — 사건 뉴스 키워드, 별칭 표의 별칭): 공백은 한 칸으로 접고, 꺾쇠·제어 문자는 거절, 빈 항목은 빼고, 한 항목
     * {@value #MAX_PHRASE_CHARS}자·{@code maxItems}개까지, 대소문자만 다른 중복은 앞의 것만.
     */
    private static Checked phrases(String key, JsonNode value, int maxItems) {
        JsonNodeFactory f = JsonNodeFactory.instance;
        if (value == null || !value.isArray()) {
            return error(key + ": 글자 목록이어야 합니다");
        }
        List<String> phrases = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode item : value) {
            if (!item.isString()) {
                return error(key + ": 글자 목록이어야 합니다 — " + shown(item.toString()));
            }
            // 공백(줄바꿈·탭 포함)을 먼저 한 칸으로 접고 남은 글자를 봅니다.
            String text = PHRASE_SPACES.matcher(item.asString("")).replaceAll(" ").strip();
            if (PHRASE_FORBIDDEN.matcher(text).find()) {
                return error(key + ": 꺾쇠(<>)·제어 문자는 쓸 수 없습니다 — " + shown(text));
            }
            if (text.isEmpty()) {
                continue;
            }
            if (text.length() > MAX_PHRASE_CHARS) {
                return error(key + ": 한 항목은 " + MAX_PHRASE_CHARS + "자까지입니다 — " + shown(text));
            }
            // 대소문자만 다른 항목은 앞의 것만 — 맞추기가 대소문자를 무시해 같은 키워드입니다.
            if (seen.add(text.toLowerCase(Locale.ROOT))) {
                phrases.add(text);
            }
        }
        if (phrases.size() > maxItems) {
            return error(key + ": 항목은 " + maxItems + "개까지입니다");
        }
        ArrayNode out = f.arrayNode();
        phrases.forEach(out::add);
        return new Checked(out, null);
    }

    /** 같은 값인가 — 숫자는 값으로(5와 5.0은 같음), 나머지는 JSON 그대로. 둘 다 없으면 같음. */
    static boolean same(JsonNode a, JsonNode b) {
        boolean aMissing = a == null || a.isNull() || a.isMissingNode();
        boolean bMissing = b == null || b.isNull() || b.isMissingNode();
        if (aMissing || bMissing) {
            return aMissing && bMissing;
        }
        if (a.isNumber() && b.isNumber()) {
            return Double.compare(a.asDouble(), b.asDouble()) == 0;
        }
        return a.equals(b);
    }

    /** 키 설명 전부(화면용). */
    static List<Map<String, Object>> views() {
        List<Map<String, Object>> out = new ArrayList<>();
        ALL.forEach(spec -> out.add(spec.view()));
        return out;
    }

    private static Checked error(String message) {
        return new Checked(null, message);
    }

    private static String plain(double value) {
        return value == Math.rint(value) ? String.valueOf((long) value) : String.valueOf(value);
    }

    private static String shown(String text) {
        return text.length() <= 40 ? text : text.substring(0, 40) + "…";
    }
}
