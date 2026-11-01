package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 규칙 책의 13F 신호와 배분(명세 R2·R4·D27, 설계 §4-1·§4-2) — 순수 계산.
 *
 * <p>신호 풀(그룹 A 7년 트랙레코드 상위 5 ∪ 그룹 B 기존 13F 메뉴 2년 상위 4, 겹치면 한 번) 기관 각각의 최신 분기와 바로 앞
 * 분기를 <b>티커 단위로</b> 대조해 신규 편입(NEW)·주식 수 확대(ADDED)·전량 매도(CLOSED) 이벤트를 만들고, 서로 다른 기관 여러
 * 곳이 같은 분기에 함께 사들인 종목만 매수 후보로 올립니다. 한 기관의 매수는 그 기관 사정(자금 유입·리밸런싱)일 수 있지만,
 * 성과가 좋았던 기관 둘 이상이 같은 종목을 새로 사거나 크게 늘렸다면 우연보다 확신에 가깝다는 것이 규칙 책의 가정입니다.
 *
 * <p><b>두 그룹 섞기(D27)</b>: 후보를 "몇 곳이 샀나"만으로 줄 세우면 분산형 기관(수백 종목)의 0.1% 신규 편입과 집중형 기관
 * (수십 종목)의 15% 신규 편입이 같은 한 표가 됩니다. 그래서 후보 점수 = Σ 매수 기관의 <b>기관 가중</b>({@link #blendWeights} —
 * 그룹 순위 가중을 섞은 값, 합 1) × <b>확신도</b>(그 종목이 그 기관 13F 총액에서 차지하는 비중을 상한으로 자른 값, 0~1)이고,
 * 배분도 점수에 비례합니다({@link #allocate}, {@link Mode#CONVICTION}). 성과 좋은 기관의 고확신 종목은 상한까지, 작은 신규
 * 편입은 작게 — 집중형과 분산형의 장점을 함께 쓰는 규칙입니다.
 *
 * <p><b>매크로 게이트는 입력이 아닙니다(D19).</b> 규칙 책은 "스마트 머니 신호만" 따르는 대조군이라, 게이트 지표가 무엇이든 신호가
 * 있으면 상한 안에서 사고 남는 현금은 서비스가 SHY에 둡니다. 그래서 이 클래스는 {@link GateIndicator}를 모릅니다.
 *
 * <p><b>왜 {@link HoldingsDiff}를 그대로 쓰지 않나</b>: HoldingsDiff는 CUSIP(없으면 이름+종류)으로 보유분을 잇고 비중 변화(%p)로
 * 확대·축소를 나눕니다 — 화면이 "기관이 무엇을 했나"를 보이는 데 맞습니다. 신호는 "어떤 티커를 살까"라서 티커로 묶어야 하고
 * (같은 티커로 매핑되는 여러 줄 — 클래스가 다른 줄 등 — 은 한 종목), 확대는 비중이 아니라 <b>주식 수</b>로 판정합니다(R2 "+30%") —
 * 비중은 기관이 손대지 않아도 다른 종목 가격이 움직이면 바뀌기 때문입니다. 무엇을 "직전 분기"로 볼지는 서비스가
 * {@link HoldingsDiff#previousQuarterEnd}로 정합니다(분기가 빠진 기관을 6개월 전 공시와 비교하지 않게, QA-085).
 *
 * <p>평가액 0인 줄은 보유가 아닌 것으로 봅니다(양쪽 분기 모두) — 직전 분기 평가액 0을 "있던 보유"로 읽으면 늘리지도 않은 종목에
 * 확대·전량 매도가 붙고, 이번 분기 평가액 0을 보유로 읽으면 0% 비중으로 "신규 매수" 신호가 납니다.
 *
 * <p><b>주식 분할</b>: 13F 주식 수는 보고일 그때의 주식 수라, 두 분기 사이에 2:1 분할이 있으면 손대지 않은 보유도 주식 수가 두
 * 배입니다(정방향 분할은 CUSIP·티커가 그대로라 같은 종목으로 이어짐). 이것을 "+100% 확대"로 읽으면 분할 종목을 들고 있던 기관들이
 * 한꺼번에 '동시 매수'로 잡혀 진짜 신호보다 위에 섭니다. 그래서 {@link AdjustedCloses}(수정주가)를 받으면 13F 1주당 가격
 * (평가액/주식 수)의 변화와 수정주가의 변화를 견줘 분할 배수를 찾고({@link SplitDetector#detect}), 직전 주식 수를 분할 뒤 기준으로
 * 맞춘 다음 확대를 판정합니다({@link #splitBetween}). 수정주가가 없는 티커는 보정하지 않습니다.
 */
public final class Signal13F {

    /** 직전 분기에 없던(또는 평가액 0) 티커를 이번 분기에 보유. */
    public static final String NEW = "NEW";
    /** 두 분기 모두 보유하고 주식 수가 기준(기본 +30%) 이상 늘어남. */
    public static final String ADDED = "ADDED";
    /** 직전 분기에 있었는데 이번 분기에 없음. */
    public static final String CLOSED = "CLOSED";

    public static final String SKIP_OUTSIDE_UNIVERSE = "유니버스 밖";
    public static final String SKIP_LOCKED_OUT = "재진입 금지";
    public static final String SKIP_DUPLICATE = "중복 후보";
    /** 확신도 비례 목표 비중이 minTargetPct 미만(또는 점수 0) — 사도 의미 없는 크기라 뺍니다. */
    public static final String SKIP_LOW_CONVICTION = "확신도 낮음";

    /**
     * 확대 비율 비교 여유. 나눗셈은 정확히 반올림되므로 (130−100)/100과 30/100은 같은 double이지만, 기준값이 30이 아닌 설정
     * (예: 33.3)에서 끝자리 차이로 경계값이 빠지지 않게 둡니다. 주식 수는 정수라 실제로 다른 두 비율의 차이(≥ 1/직전 주식 수,
     * 직전이 1천억 주여도 1e-11)보다 훨씬 작습니다.
     */
    private static final double RATIO_EPSILON = 1e-12;

    /**
     * 점수 비교 눈금(1e-12). 기관 가중은 1/15·1/30 같은 분수라, 수학적으로 같은 점수(예: 1위+5위 = 2위+4위)가 더하는 순서에 따라
     * 끝자리만 다르게 나옵니다(0.19999999999999998 대 0.2). 그대로 비교하면 "같은 점수는 기관 수 → 티커 순"이 그 잡음으로 뒤집히므로
     * 이 눈금으로 반올림한 정수로 비교합니다 — 반올림은 함수라 정렬이 일관되고(허용 오차 비교와 달리 추이성이 깨지지 않음), 점수는
     * 0~1이라 실제로 다른 두 점수가 같은 눈금에 들어갈 일은 없습니다.
     */
    private static final double SCORE_SCALE = 1e12;

    /**
     * 목표 비중 하한 비교 여유(%p). 상한 × 점수 / 최고 점수가 수학적으로 정확히 하한(1%)인데 끝자리로 0.9999999999999999가 되는
     * 경우(예: 10 × 0.09 / 0.9)를 "확신도 낮음"으로 빼지 않게 둡니다.
     */
    private static final double TARGET_EPSILON = 1e-9;

    private Signal13F() {
    }

    /**
     * 수정주가(분할을 과거로 맞춘 종가) 조회 — 분할 보정(클래스 설명)에 씁니다.
     *
     * <p>그 티커의 그날(보고일) 무렵 수정 종가를 돌려주고, 모르면 null입니다(그 티커는 보정하지 않음). 보고일이 휴장일이면 그 전
     * 마지막 거래일 값이면 됩니다. 두 보고일의 <b>비율</b>만 쓰므로 그 뒤의 분할·배당으로 계열 전체가 다시 쓰여도 결과는 같습니다.
     */
    @FunctionalInterface
    public interface AdjustedCloses {
        Double close(String ticker, LocalDate date);
    }

    /**
     * 한 분기·한 기관·한 티커의 보유.
     *
     * <p>같은 티커가 여러 줄이면 {@link #collect}가 더합니다(평가액 합, 주식 수는 한 줄이라도 null이면 null — 모르는 줄을 0으로
     * 더하면 주식 수가 줄어든 것처럼 보입니다). 그래서 서비스는 13F 줄을 그대로 넘겨도 됩니다.
     *
     * @param ticker 야후 티커. null·빈 문자열이면 티커를 붙이지 못한 줄 — 신호는 만들지 않고 분기 평가액 합에만 들어갑니다
     * @param value  평가액(달러). 숫자가 아니거나 음수인 줄은 계산에서 뺍니다(합에도 넣지 않음). 평가액을 모르는 줄을 0으로 넣으면
     *               "보유 아님"으로 읽히니 서비스가 빼세요
     * @param shares 주식 수. 모르면 null(NaN·음수도 모르는 값으로 봄)
     */
    public record Row(String ticker, double value, Double shares) {
    }

    /**
     * 신호 풀 기관 하나의 최신 분기와 바로 앞 분기.
     *
     * @param rankA      그룹 A 순위(1부터). 그룹 A에 없으면 null — 표시(메모의 "A2·B1")에만 쓰고 계산은 weight로 합니다
     * @param rankB      그룹 B 순위(1부터). 그룹 B에 없으면 null
     * @param weight     기관 가중({@link #blendWeights}의 값, 풀 전체 합 1). 0 이상의 유한한 수 — 0이면 매수 기관 수에는 들지만
     *                   점수에는 아무것도 더하지 않습니다(groupWeightA = 1처럼 한 그룹을 끈 설정)
     * @param totalValue 최신 분기 13F 총평가액(티커 없는 줄 포함) — 이벤트 weightPct의 분모. 0 이하이거나 숫자가 아니면 최신 분기
     *                   줄 평가액 합으로 대신합니다
     * @param current    최신 분기 줄. null이면 빈 목록
     * @param previous   바로 앞 분기({@link HoldingsDiff#previousQuarterEnd}) 줄. <b>null = 그 분기 공시가 없음</b> — 이 기관은
     *                   이벤트를 만들지 않습니다(빈 목록은 "공시는 있는데 보유가 없음"이라 이번 분기 보유가 모두 NEW입니다).
     *                   직전 분기 총액은 받지 않으므로 previousWeightPct의 분모는 이 목록의 평가액 합입니다 — 13F 총액 기준으로
     *                   맞추려면 티커 없는 줄도 ticker null로 넘기세요
     * @throws IllegalArgumentException weight가 음수·NaN·무한대 — 가중을 모르는 기관을 0이나 임의 값으로 넣으면 점수가 조용히
     *                                  바뀌므로, 모르면 서비스가 그 기관을 빼고 메모를 남기세요
     */
    public record FilerQuarter(String cik, Integer rankA, Integer rankB, double weight, LocalDate reportDate,
                               LocalDate filingDate, double totalValue, List<Row> current, List<Row> previous) {
        public FilerQuarter {
            if (!(weight >= 0) || Double.isInfinite(weight)) {
                throw new IllegalArgumentException("기관 가중은 0 이상의 유한한 수여야 합니다: " + cik + " " + weight);
            }
            current = current == null ? List.of() : withoutNulls(current);
            previous = previous == null ? null : withoutNulls(previous);
        }
    }

    /**
     * 한 기관의 한 티커 이벤트.
     *
     * @param action            {@link #NEW}·{@link #ADDED}·{@link #CLOSED}
     * @param sharesChangePct   주식 수 변화(%). ADDED는 (현재−직전)/직전×100, CLOSED는 −100(보유가 0이 됨), NEW는 null(분모 없음)
     * @param weightPct         이번 분기 평가액 / 그 기관 13F 총액 × 100 — 매수 이벤트의 확신도 입력. CLOSED는 0(이번 분기에 보유
     *                          없음)
     * @param previousWeightPct 직전 분기 평가액 / 직전 분기 줄 평가액 합 × 100. NEW는 null(직전 분기에 보유 없음)
     */
    public record Event(String cik, String ticker, String action, Double sharesChangePct, double weightPct,
                        Double previousWeightPct) {
    }

    /**
     * 매수 기관 하나가 후보 점수에 더한 몫.
     *
     * @param filerWeight 그 기관의 가중({@link FilerQuarter#weight})
     * @param conviction  확신도 = min(weightPct, convictionCapPct) / convictionCapPct(0 초과 1 이하)
     * @param points      filerWeight × conviction
     */
    public record Contribution(String cik, double filerWeight, double conviction, double points) {
    }

    /**
     * 매수 후보 — 서로 다른 기관 minHolders곳 이상이 NEW·ADDED한 티커.
     *
     * <p>buyerCiks·contributions·events는 같은 순서(기관 가중 ↓, CIK ↑)라 같은 자리끼리 같은 기관입니다 — 서비스가 기관 이름·그룹을
     * 붙여 "어느 기관(그룹·순위·가중)이 NEW/+30%였나"(수용 기준)를 남길 때 그대로 짝지으면 됩니다.
     *
     * @param score             Σ contributions.points — 후보 정렬과 확신도 비례 배분의 기준
     * @param combinedWeightPct 매수 기관들의 이번 분기 weightPct 합(참고 — 점수에는 확신도 상한을 거친 값만 들어감)
     * @param events            그 티커의 NEW·ADDED 이벤트
     */
    public record Candidate(String ticker, List<String> buyerCiks, double score, List<Contribution> contributions,
                            double combinedWeightPct, List<Event> events) {
        public Candidate {
            buyerCiks = buyerCiks == null ? List.of() : List.copyOf(buyerCiks);
            contributions = contributions == null ? List.of() : List.copyOf(contributions);
            events = events == null ? List.of() : List.copyOf(events);
        }
    }

    /**
     * @param events        모든 이벤트(기관 가중 ↓, CIK ↑, 티커 ↑)
     * @param buyCandidates 매수 후보(정렬됨 — {@link #CANDIDATE_ORDER})
     * @param closedBy      티커 → CLOSED한 기관(기관 가중 ↓, CIK ↑). 티커 순. 기관 수와 상관없이 다 담습니다
     * @param notes         이벤트를 만들지 못한 기관·분할 보정 등 사람이 읽을 메모
     */
    public record Signals(List<Event> events, List<Candidate> buyCandidates, Map<String, List<String>> closedBy,
                          List<String> notes) {
        public Signals {
            events = events == null ? List.of() : List.copyOf(events);
            buyCandidates = buyCandidates == null ? List.of() : List.copyOf(buyCandidates);
            // Map.copyOf는 순서를 지키지 않으므로(티커 순으로 보여야 함) 순서 있는 복사본을 감쌉니다.
            closedBy = closedBy == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(closedBy));
            notes = notes == null ? List.of() : List.copyOf(notes);
        }
    }

    /**
     * 후보 정렬(R4·D27): 점수 ↓(1e-12 눈금 — {@link #SCORE_SCALE}), 매수 기관 수 ↓, 티커 ↑. 점수가 같으면 더 여러 곳이 확인한
     * 종목이 앞섭니다.
     */
    public static final Comparator<Candidate> CANDIDATE_ORDER = Comparator
            .comparingLong((Candidate c) -> scoreKey(c.score())).reversed()
            .thenComparing(Comparator.comparingInt((Candidate c) -> c.buyerCiks().size()).reversed())
            .thenComparing(Candidate::ticker, Comparator.nullsLast(Comparator.naturalOrder()));

    /** 기관을 훑는 순서 — 이벤트·매수 기관 목록이 가중 큰 기관부터 나오게(점수에 많이 보탠 기관이 먼저 보임). */
    private static final Comparator<FilerQuarter> FILER_ORDER = Comparator.comparingDouble(FilerQuarter::weight)
            .reversed()
            .thenComparing(FilerQuarter::cik, Comparator.nullsLast(Comparator.naturalOrder()));

    /**
     * 기관 가중(설계 §4-1): w_f = g·a(rankA) + (1−g)·b(rankB), a(r) = (nA+1−r) / (nA(nA+1)/2), b(r) = (nB+1−r) / (nB(nB+1)/2).
     * 그 그룹에 없으면 그 항은 0이고, 두 그룹에 모두 있는 기관(2026-10-23 기준 Duquesne)은 둘 다 받습니다 — 두 방법 모두에서
     * 성과가 좋았다는 뜻이라 가장 큰 가중을 받는 것이 의도입니다.
     *
     * <p>nA·nB는 실제로 뽑힌 수입니다 — 자격 기관이 topN보다 모자라면 있는 순위로만 정규화해(3곳이면 3/6·2/6·1/6) 그 그룹 몫이
     * 줄지 않게 합니다. 한 그룹이 비면(수집 중·자격 기관 없음) 다른 그룹이 1을 다 받습니다(g와 상관없이) — 빈 그룹 몫을 버리면
     * 가중 합이 1보다 작아 점수의 눈금이 선정마다 달라집니다.
     *
     * @param groupA       그룹 A 순위 순 CIK(1위 먼저). null·빈 목록이면 비어 있음. null 원소는 건너뛰고, 같은 CIK가 두 번이면
     *                     앞의 순위만 씁니다
     * @param groupB       그룹 B 순위 순 CIK
     * @param groupWeightA g(blend.groupWeightA, 기본 0.5). 0 이상 1 이하
     * @return CIK → 가중(합 1). 순서는 그룹 A 순서 뒤에 그룹 B에만 있는 기관(선정 행의 selected_ciks와 같은 순서). g = 1·0처럼
     *         한 그룹 몫이 0이면 그 그룹에만 있는 기관도 0으로 들어 있습니다. 두 그룹 모두 비면 빈 맵
     * @throws IllegalArgumentException groupWeightA가 범위 밖·NaN
     */
    public static Map<String, Double> blendWeights(List<String> groupA, List<String> groupB, double groupWeightA) {
        if (!(groupWeightA >= 0 && groupWeightA <= 1)) {
            throw new IllegalArgumentException("그룹 A 가중은 0 이상 1 이하여야 합니다: " + groupWeightA);
        }
        List<String> a = distinct(groupA);
        List<String> b = distinct(groupB);
        double g = a.isEmpty() ? 0.0 : b.isEmpty() ? 1.0 : groupWeightA;
        Map<String, Double> weights = new LinkedHashMap<>();
        for (int i = 0; i < a.size(); i++) {
            weights.merge(a.get(i), g * rankWeight(i + 1, a.size()), Double::sum);
        }
        for (int i = 0; i < b.size(); i++) {
            weights.merge(b.get(i), (1 - g) * rankWeight(i + 1, b.size()), Double::sum);
        }
        return Collections.unmodifiableMap(weights);
    }

    /** 순위 가중 (n+1−r) / (n(n+1)/2) — 1위가 n, 꼴찌가 1의 비율이고 합 1. */
    private static double rankWeight(int rank, int n) {
        return (n + 1.0 - rank) / (n * (n + 1) / 2.0);
    }

    /** null을 빼고 처음 나온 순서대로 한 번씩. */
    private static List<String> distinct(List<String> ciks) {
        if (ciks == null) {
            return List.of();
        }
        Set<String> seen = new LinkedHashSet<>();
        ciks.stream().filter(Objects::nonNull).forEach(seen::add);
        return List.copyOf(seen);
    }

    /**
     * 신호 풀 기관들의 분기 대조 → 이벤트·매수 후보·전량 매도 기관(분할 보정 없음).
     * {@link #collect(List, int, double, double, AdjustedCloses)}에 closes = null.
     */
    public static Signals collect(List<FilerQuarter> filers, int minHolders, double addThresholdPct,
                                  double convictionCapPct) {
        return collect(filers, minHolders, addThresholdPct, convictionCapPct, null);
    }

    /**
     * 신호 풀 기관들의 분기 대조 → 이벤트·매수 후보·전량 매도 기관.
     *
     * <p>NEW = 직전 분기에 없던(또는 평가액 0) 티커. ADDED = 두 분기 모두 shares가 있고 (현재−직전)/직전 ≥ addThresholdPct/100
     * (그보다 덜 늘었거나 줄인 종목은 이벤트가 없습니다). CLOSED = 직전에 있었는데 현재 없음(또는 평가액 0). previous가 null인
     * 기관은 이벤트 없이 notes에 "○○: 직전 분기 공시 없음" — 비교 상대가 없는데 이번 보유를 모두 신규로 읽으면 가짜 매수 신호가
     * 쏟아집니다. 같은 CIK가 두 번 들어오면 가중이 큰(같으면 앞선) 것만 씁니다(한 기관이 두 표를 내지 않게 — 두 그룹에 모두 있는
     * 기관은 서비스가 한 줄로, 가중을 합쳐 넘깁니다).
     *
     * <p>두 분기 모두 보유한 티커는 closes가 있으면 직전 분기 보고일({@link HoldingsDiff#previousQuarterEnd})과 이번 보고일의
     * 수정주가로 분할 배수를 찾아 직전 주식 수에 곱한 뒤 확대를 판정합니다. 보정한 티커는 notes에 "○○ 2:1 분할 …"로 남습니다.
     *
     * <p>매수 후보 = NEW·ADDED 이벤트의 서로 다른 기관 수 ≥ minHolders. 점수 = Σ 매수 기관의 weight × 확신도,
     * 확신도 = min(weightPct, convictionCapPct) / convictionCapPct. 정렬은 {@link #CANDIDATE_ORDER}.
     * closedBy는 티커 → CLOSED한 기관 목록이며, 매도 신호 판정(보유 종목에 대해 ≥ minHolders)은 서비스가 합니다 —
     * 이 클래스는 장부의 보유를 모릅니다.
     *
     * @param minHolders       매수 후보가 되는 최소 기관 수(기본 2). 1 이상
     * @param addThresholdPct  확대로 보는 주식 수 증가율(%, 기본 30). 0 초과 — 0이면 그대로 들고 있기만 한 종목도 확대가 됩니다
     * @param convictionCapPct 확신도 상한(%, blend.convictionCapPct 기본 10). 0 초과 100 이하 — 기관 내 비중이 이 값 이상이면
     *                         확신도 1(그보다 큰 비중은 더 쳐주지 않음: 한 종목 40%인 집중형 기관 하나가 점수를 독차지하지 않게)
     * @param closes           수정주가. null이면 분할을 보정하지 않음
     * @throws IllegalArgumentException minHolders·addThresholdPct·convictionCapPct가 범위 밖
     */
    public static Signals collect(List<FilerQuarter> filers, int minHolders, double addThresholdPct,
                                  double convictionCapPct, AdjustedCloses closes) {
        if (minHolders < 1) {
            throw new IllegalArgumentException("최소 기관 수는 1 이상이어야 합니다: " + minHolders);
        }
        if (!(addThresholdPct > 0) || Double.isInfinite(addThresholdPct)) {
            throw new IllegalArgumentException("확대 기준(%)은 0보다 큰 수여야 합니다: " + addThresholdPct);
        }
        if (!(convictionCapPct > 0) || convictionCapPct > 100) {
            throw new IllegalArgumentException("확신도 상한(%)은 0 초과 100 이하여야 합니다: " + convictionCapPct);
        }
        double threshold = addThresholdPct / 100.0;

        List<FilerQuarter> ordered = new ArrayList<>();
        if (filers != null) {
            filers.stream().filter(Objects::nonNull).forEach(ordered::add);
        }
        ordered.sort(FILER_ORDER);

        List<Event> events = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        Map<String, Double> weightByCik = new HashMap<>();
        // 티커 → 분할 비율 → 그 비율로 보정한 기관 수(기관마다 한 줄씩 쓰면 같은 분할이 여러 번 적힘).
        Map<String, Map<String, Integer>> splits = new TreeMap<>();
        for (FilerQuarter filer : ordered) {
            if (weightByCik.containsKey(filer.cik())) {
                notes.add(label(filer) + ": 같은 기관이 두 번 들어와 뒤의 것은 쓰지 않음");
                continue;
            }
            weightByCik.put(filer.cik(), filer.weight());
            if (filer.previous() == null) {
                notes.add(label(filer) + ": 직전 분기 공시 없음");
                continue;
            }
            events.addAll(compare(filer, threshold, closes, splits));
        }
        splits.forEach((ticker, ratios) -> ratios.forEach((ratio, count) -> notes.add(ticker + " " + ratio
                + " 분할 — 직전 분기 주식 수를 분할 뒤 기준으로 맞춰 확대를 판정(기관 " + count + "곳)")));

        Map<String, List<Event>> buysByTicker = new TreeMap<>();
        Map<String, List<String>> closedBy = new TreeMap<>();
        for (Event event : events) {
            if (CLOSED.equals(event.action())) {
                closedBy.computeIfAbsent(event.ticker(), t -> new ArrayList<>()).add(event.cik());
            } else {
                buysByTicker.computeIfAbsent(event.ticker(), t -> new ArrayList<>()).add(event);
            }
        }

        List<Candidate> candidates = new ArrayList<>();
        for (Map.Entry<String, List<Event>> entry : buysByTicker.entrySet()) {
            List<Event> buys = entry.getValue();
            // 기관마다 티커당 이벤트는 하나이고 CIK는 위에서 겹치지 않게 했으므로, 이벤트 수가 곧 서로 다른 기관 수입니다.
            if (buys.size() < minHolders) {
                continue;
            }
            List<String> buyers = new ArrayList<>(buys.size());
            List<Contribution> contributions = new ArrayList<>(buys.size());
            double score = 0.0;
            double combined = 0.0;
            for (Event buy : buys) {
                double filerWeight = weightByCik.get(buy.cik());
                // 매수 이벤트의 weightPct는 0보다 큽니다(평가액 0인 줄은 보유가 아님) — 확신도는 0 초과 1 이하.
                double conviction = Math.min(buy.weightPct(), convictionCapPct) / convictionCapPct;
                double points = filerWeight * conviction;
                buyers.add(buy.cik());
                contributions.add(new Contribution(buy.cik(), filerWeight, conviction, points));
                score += points;
                combined += buy.weightPct();
            }
            candidates.add(new Candidate(entry.getKey(), buyers, score, contributions, combined, buys));
        }
        candidates.sort(CANDIDATE_ORDER);

        Map<String, List<String>> closedCopy = new LinkedHashMap<>();
        closedBy.forEach((ticker, ciks) -> closedCopy.put(ticker, Collections.unmodifiableList(ciks)));
        return new Signals(events, candidates, closedCopy, notes);
    }

    /** 배분 방식(blend.allocation). */
    public enum Mode {
        /** 확신도 비례(D27 기본): 목표 = 종목 상한 × 점수 / 최고 점수. */
        CONVICTION,
        /** 동일 비중(단계 2 첫 판): 목표 = min(100 / maxNames, 종목 상한). 점수는 순서에만 씁니다. */
        EQUAL
    }

    /** 한 종목의 목표 비중과 그 근거(매수 기관·가중·확신도·이벤트). */
    public record Allocation(String ticker, double targetWeightPct, String reason) {
    }

    /**
     * @param allocations 고른 종목(후보 순서 그대로)
     * @param skipped     고르지 못한 후보: 티커 → 사유("유니버스 밖"·"재진입 금지"·"상위 N 밖"·"확신도 낮음"·"중복 후보"), 후보 순서
     */
    public record Plan(List<Allocation> allocations, List<Map.Entry<String, String>> skipped) {
        public Plan {
            allocations = allocations == null ? List.of() : List.copyOf(allocations);
            skipped = skipped == null ? List.of() : List.copyOf(skipped);
        }
    }

    /**
     * 정렬된 후보에서 매수 종목과 목표 비중을 고릅니다(R3·R4·D27).
     *
     * <p>상위 후보부터 universe 안·lockedOut 밖인 것만 maxNames개를 고릅니다. 유니버스 밖·재진입 금지 후보는 자리를 차지하지
     * 않습니다 — 살 수 없는 종목 때문에 살 수 있는 다음 후보가 밀려나지 않게. 종목 상한 cap(t)는 ETF(etfs)면 maxWeightEtfPct,
     * 아니면 maxWeightStockPct입니다.
     * <ul>
     *   <li>{@link Mode#CONVICTION}: 목표 = cap(t) × score / 최고 점수. 최고 점수는 <b>고른 종목 중</b> 최고라(유니버스 밖 후보가
     *       더 높아도) 살 수 있는 가장 강한 후보가 상한을 받습니다. 목표가 minTargetPct 미만이거나 점수가 0 이하이면
     *       "확신도 낮음"으로 뺍니다 — 자리는 상위 N을 고른 뒤 빼는 것이라 다음 후보가 대신 올라오지 않습니다(점수 순 상위 N이
     *       "가장 강한 신호 N개"이고, 그 뒤 후보는 점수가 더 낮음).</li>
     *   <li>{@link Mode#EQUAL}: 목표 = min(100 / maxNames, cap(t)). 확신도를 쓰지 않으므로 "확신도 낮음"도 없습니다.</li>
     * </ul>
     * <b>예산은 없습니다(D19)</b>: 고른 비중의 합이 100% 미만이면(후보가 적거나 상한·확신도에 걸림) 남는 현금을 SHY에 둘지·이미
     * 보유한 후보의 부족분만 살지는 서비스가 정합니다.
     *
     * @param sorted            {@link #collect}의 buyCandidates(이미 정렬됨 — 다시 정렬하지 않음)
     * @param maxNames          최대 종목 수(기본 10). 1 이상
     * @param maxWeightStockPct 개별 종목 상한(%, 기본 10). 0 초과 100 이하
     * @param maxWeightEtfPct   ETF 상한(%, 기본 20). 0 초과 100 이하
     * @param etfs              ETF 티커. null이면 없음
     * @param universe          살 수 있는 티커
     * @param lockedOut         재진입 금지 중인 티커. null이면 없음
     * @param mode              배분 방식
     * @param minTargetPct      CONVICTION의 최소 목표 비중(%, blend.minTargetPct 기본 1.0). 0 이상 100 이하
     * @throws IllegalArgumentException 숫자 인자가 범위 밖이거나 universe·mode가 null
     */
    public static Plan allocate(List<Candidate> sorted, int maxNames, double maxWeightStockPct, double maxWeightEtfPct,
                                Set<String> etfs, Set<String> universe, Set<String> lockedOut, Mode mode,
                                double minTargetPct) {
        if (maxNames < 1) {
            throw new IllegalArgumentException("최대 종목 수는 1 이상이어야 합니다: " + maxNames);
        }
        if (!(maxWeightStockPct > 0) || maxWeightStockPct > 100) {
            throw new IllegalArgumentException("종목당 상한(%)은 0 초과 100 이하여야 합니다: " + maxWeightStockPct);
        }
        if (!(maxWeightEtfPct > 0) || maxWeightEtfPct > 100) {
            throw new IllegalArgumentException("ETF 상한(%)은 0 초과 100 이하여야 합니다: " + maxWeightEtfPct);
        }
        if (!(minTargetPct >= 0) || minTargetPct > 100) {
            throw new IllegalArgumentException("최소 목표 비중(%)은 0 이상 100 이하여야 합니다: " + minTargetPct);
        }
        if (universe == null) {
            // 빈 집합과 달리 null은 호출 실수입니다 — 조용히 "전부 유니버스 밖"으로 만들면 매수가 사라진 이유가 안 보입니다.
            throw new IllegalArgumentException("유니버스가 없습니다");
        }
        if (mode == null) {
            throw new IllegalArgumentException("배분 방식이 없습니다");
        }
        Set<String> locked = lockedOut == null ? Set.of() : lockedOut;
        Set<String> etfSet = etfs == null ? Set.of() : etfs;
        String beyondTop = "상위 " + maxNames + " 밖";

        // 1) 자리 고르기 — 사유가 null인 후보가 상위 N. 건너뛴 사유는 후보 순서대로 남깁니다.
        List<Slot> slots = new ArrayList<>();
        Set<String> handled = new HashSet<>();
        int chosen = 0;
        double maxScore = 0.0;
        if (sorted != null) {
            for (Candidate candidate : sorted) {
                if (candidate == null || candidate.ticker() == null) {
                    continue;
                }
                String ticker = candidate.ticker();
                String skip = null;
                if (!handled.add(ticker)) {
                    skip = SKIP_DUPLICATE;
                } else if (!universe.contains(ticker)) {
                    skip = SKIP_OUTSIDE_UNIVERSE;
                } else if (locked.contains(ticker)) {
                    skip = SKIP_LOCKED_OUT;
                } else if (chosen >= maxNames) {
                    skip = beyondTop;
                } else {
                    chosen++;
                    if (Double.isFinite(candidate.score()) && candidate.score() > maxScore) {
                        maxScore = candidate.score();
                    }
                }
                slots.add(new Slot(candidate, skip));
            }
        }

        // 2) 목표 비중.
        List<Allocation> allocations = new ArrayList<>();
        List<Map.Entry<String, String>> skipped = new ArrayList<>();
        for (Slot slot : slots) {
            Candidate candidate = slot.candidate();
            if (slot.skip() != null) {
                skipped.add(Map.entry(candidate.ticker(), slot.skip()));
                continue;
            }
            double cap = etfSet.contains(candidate.ticker()) ? maxWeightEtfPct : maxWeightStockPct;
            double target;
            if (mode == Mode.EQUAL) {
                target = Math.min(100.0 / maxNames, cap);
            } else {
                double score = Double.isFinite(candidate.score()) ? candidate.score() : 0.0;
                target = maxScore > 0 ? cap * score / maxScore : 0.0;
                if (!(target > 0) || target < minTargetPct - TARGET_EPSILON) {
                    skipped.add(Map.entry(candidate.ticker(), SKIP_LOW_CONVICTION));
                    continue;
                }
            }
            allocations.add(new Allocation(candidate.ticker(), target, describe(candidate)));
        }
        return new Plan(allocations, skipped);
    }

    /**
     * 후보의 근거 한 줄 — 예: "2곳 동시 매수(점수 0.4333): 0001067983 신규(가중 0.3667 × 확신도 1.00),
     * 0000102909 +35.0%(가중 0.1333 × 확신도 0.50)". 주문 reason·결정 기록에 들어가 "어느 기관이 NEW/+30%였고 점수에 얼마를
     * 보탰나"를 남깁니다(수용 기준). 기관 이름·그룹·순위는 서비스가 압니다.
     */
    static String describe(Candidate candidate) {
        StringBuilder text = new StringBuilder()
                .append(candidate.buyerCiks().size()).append("곳 동시 매수(점수 ")
                .append(String.format(Locale.ROOT, "%.4f", candidate.score())).append("): ");
        for (int i = 0; i < candidate.events().size(); i++) {
            Event event = candidate.events().get(i);
            if (i > 0) {
                text.append(", ");
            }
            text.append(event.cik()).append(' ');
            if (NEW.equals(event.action()) || event.sharesChangePct() == null) {
                text.append("신규");
            } else {
                text.append(String.format(Locale.ROOT, "%+.1f%%", event.sharesChangePct()));
            }
            if (i < candidate.contributions().size()) {
                Contribution contribution = candidate.contributions().get(i);
                text.append(String.format(Locale.ROOT, "(가중 %.4f × 확신도 %.2f)", contribution.filerWeight(),
                        contribution.conviction()));
            }
        }
        return text.toString();
    }

    /** 배분 첫 단계의 후보 하나 — skip이 null이면 상위 N에 든 자리. */
    private record Slot(Candidate candidate, String skip) {
    }

    /** 정렬 키 — {@link #SCORE_SCALE} 눈금으로 반올림. 숫자가 아닌 점수는 맨 뒤. */
    private static long scoreKey(double score) {
        return Double.isFinite(score) ? Math.round(score * SCORE_SCALE) : Long.MIN_VALUE;
    }

    /** 한 기관의 분기 대조 — 티커 순으로 이벤트를 냅니다. 분할로 보정한 티커는 splits에 셉니다. */
    private static List<Event> compare(FilerQuarter filer, double threshold, AdjustedCloses closes,
                                       Map<String, Map<String, Integer>> splits) {
        Quarter now = Quarter.of(filer.current());
        Quarter before = Quarter.of(filer.previous());
        LocalDate previousReport = filer.reportDate() == null ? null
                : HoldingsDiff.previousQuarterEnd(filer.reportDate());
        double total = filer.totalValue();
        // 총액을 모르면 줄 합으로 — 이벤트가 있다면 그 줄의 평가액이 0보다 크므로 줄 합도 0보다 큽니다.
        double nowDenominator = total > 0 && Double.isFinite(total) ? total : now.total();

        Set<String> tickers = new TreeSet<>(now.byTicker().keySet());
        tickers.addAll(before.byTicker().keySet());
        List<Event> events = new ArrayList<>();
        for (String ticker : tickers) {
            Line cur = now.byTicker().get(ticker);
            Line prev = before.byTicker().get(ticker);
            boolean held = cur != null && cur.value() > 0;
            boolean heldBefore = prev != null && prev.value() > 0;
            if (held && !heldBefore) {
                events.add(new Event(filer.cik(), ticker, NEW, null, percent(cur.value(), nowDenominator), null));
            } else if (held) {
                SplitDetector.Ratio split = closes == null || previousReport == null ? null
                        : splitBetween(prev.value(), prev.shares(), cur.value(), cur.shares(),
                                closes.close(ticker, previousReport), closes.close(ticker, filer.reportDate()))
                        .orElse(null);
                if (split != null) {
                    splits.computeIfAbsent(ticker, t -> new TreeMap<>()).merge(split.label(), 1, Integer::sum);
                }
                Double ratio = sharesRatio(cur, prev, split);
                if (ratio != null && ratio >= threshold - RATIO_EPSILON) {
                    events.add(new Event(filer.cik(), ticker, ADDED, ratio * 100.0,
                            percent(cur.value(), nowDenominator), percent(prev.value(), before.total())));
                }
            } else if (heldBefore) {
                events.add(new Event(filer.cik(), ticker, CLOSED, -100.0, 0.0, percent(prev.value(), before.total())));
            }
        }
        return events;
    }

    /**
     * (현재−직전)/직전 주식 수. split이 있으면 직전 주식 수를 분할 뒤 기준(× 분자/분모)으로 맞춥니다. 한쪽이라도 모르거나 직전이
     * 0이면 null — 모르는 주식 수로 확대를 단정하지 않습니다.
     */
    private static Double sharesRatio(Line cur, Line prev, SplitDetector.Ratio split) {
        if (cur.shares() == null || prev.shares() == null || !(prev.shares() > 0)) {
            return null;
        }
        double before = split == null ? prev.shares() : prev.shares() * split.numerator() / split.denominator();
        return (cur.shares() - before) / before;
    }

    /**
     * 두 보고일 사이의 분할 배수(클래스 설명). 13F 1주당 가격은 분할을 거꾸로 맞추지 않은 그때 가격이고 수정주가는 맞춘 값이라,
     * r = (직전 1주당 / 이번 1주당) / (직전 수정 종가 / 이번 수정 종가)에 분할 배수만 남습니다 — 2:1 분할이면 13F 1주당 가격은
     * 절반이 되는데 수정주가는 그대로라 r = 2. 판정은 {@link SplitDetector#detect}(±10% 안은 배당 등으로 보고 분할이 아님,
     * 가장 단순한 분수).
     *
     * @return 값 하나라도 모르거나 0 이하이면 empty(보정하지 않음)
     */
    static Optional<SplitDetector.Ratio> splitBetween(double previousValue, Double previousShares, double currentValue,
                                                      Double currentShares, Double previousClose,
                                                      Double currentClose) {
        if (previousShares == null || currentShares == null || previousClose == null || currentClose == null
                || !(previousShares > 0) || !(currentShares > 0) || !(previousValue > 0) || !(currentValue > 0)
                || !(previousClose > 0) || !(currentClose > 0)) {
            return Optional.empty();
        }
        double reportedChange = (previousValue / previousShares) / (currentValue / currentShares);
        double adjustedChange = previousClose / currentClose;
        return SplitDetector.detect(reportedChange, adjustedChange);
    }

    private static double percent(double value, double denominator) {
        return value / denominator * 100.0;
    }

    /** "0001067983(A1·B1)" — 그룹 순위가 없으면 CIK만. */
    private static String label(FilerQuarter filer) {
        List<String> groups = new ArrayList<>(2);
        if (filer.rankA() != null) {
            groups.add("A" + filer.rankA());
        }
        if (filer.rankB() != null) {
            groups.add("B" + filer.rankB());
        }
        return groups.isEmpty() ? String.valueOf(filer.cik()) : filer.cik() + "(" + String.join("·", groups) + ")";
    }

    private static <T> List<T> withoutNulls(List<T> list) {
        return list.stream().filter(Objects::nonNull).toList();
    }

    /** 티커로 합친 한 줄. shares null = 합친 줄 중 하나라도 주식 수를 모름. */
    private record Line(double value, Double shares) {
    }

    /** 한 분기를 티커별로 합친 것. total은 티커 없는 줄까지 포함한 평가액 합. */
    private record Quarter(Map<String, Line> byTicker, double total) {
        static Quarter of(List<Row> rows) {
            Map<String, Line> byTicker = new LinkedHashMap<>();
            double total = 0.0;
            if (rows != null) {
                for (Row row : rows) {
                    if (!(row.value() >= 0) || Double.isInfinite(row.value())) {
                        continue;
                    }
                    total += row.value();
                    String ticker = row.ticker() == null ? "" : row.ticker().strip();
                    if (ticker.isEmpty()) {
                        continue;
                    }
                    Double shares = row.shares() != null && row.shares() >= 0 && Double.isFinite(row.shares())
                            ? row.shares() : null;
                    // 같은 티커 여러 줄(클래스가 다른 줄이 같은 티커로 매핑된 경우 등)은 한 종목 — 평가액·주식 수를 더합니다.
                    byTicker.merge(ticker, new Line(row.value(), shares), (a, b) -> new Line(a.value() + b.value(),
                            a.shares() == null || b.shares() == null ? null : a.shares() + b.shares()));
                }
            }
            return new Quarter(byTicker, total);
        }
    }
}
