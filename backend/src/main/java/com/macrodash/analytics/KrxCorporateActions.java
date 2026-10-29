package com.macrodash.analytics;

import com.macrodash.analytics.SplitDetector.Ratio;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * 🧪 한국 책의 기업행위 감지 — 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-1·§4-2·K32, §5 '기업행위'. 미국 책은 쓰지 않습니다
 * (미국은 {@link SplitDetector}가 수정주가 이력의 다시 쓰임으로 잽니다 — 그 경로·시험은 그대로).
 *
 * <p><b>입력</b>은 종목 하나의 토스 일봉(원시가 {@code adjusted=false} — 금융위 원시 종가와 같은 판)과 봉마다의 수정 비율
 * {@code adjRatio} = {@code adjusted=true} 종가 ÷ {@code adjusted=false} 종가, 금융위 최근 두 기준일의 상장주식수, 두 출처에 그
 * 종목이 있는지입니다. [확인] 삼성전자 50:1 분할(변경상장 2018-05-04) 토스 응답: 분할 전 봉의 비율은 정확히 0.02, 분할 뒤 봉은 1,
 * 분할 정지일(04-30·05-02·05-03)은 거래량 0·시고저종 = 전일 종가 봉이었습니다(시험 자료 {@code paper/kr-corporate-actions/}).
 * [확인 — G16, 2026-10-29] 토스 수정주가는 주식 배당을 조정하지 않아 비율이 바뀌면 분할·병합류(또는 증자) 신호입니다. ETF 분배금은
 * 조정하므로 ETF는 {@link #FUND_DISTRIBUTION_BAND} 안의 변화를 건너뜁니다(QA-144).
 *
 * <p><b>거래량 0 봉은 관측이 아닙니다</b>({@link #observed}): 정지일 봉의 가격은 전일 종가를 이어 쓴 값이라 체결·평가·비율 계산에
 * 쓰지 않습니다. 거래량을 모르는 봉(null)도 관측이 아닙니다(짐작하지 않음).
 *
 * <p><b>판정</b>({@link #assess}) — {@code since}(그 보유 수량이 이미 반영한 마지막 관측 날짜) 뒤의 일만 새 사건으로 봅니다:
 * <ol>
 *   <li><b>수정 비율 변화</b>(이웃한 봉의 비율이 {@link #RATIO_NOISE} 넘게 다름, 새 날짜 E): 비율 k = 뒤 비율 ÷ 앞 비율을
 *       {@link SplitDetector#detect}의 '가장 단순한 분수'로 읽습니다. 못 읽거나(±10% 안 — 증자·배당 조정 등, 분자·분모 50 초과)
 *       한국 분할·병합 비율이 아니면(k가 1/2과 2 사이 — {@link #MIN_SPLIT_FACTOR}) 미처리입니다. 읽히면 E 전 마지막 관측 P와 E 이후
 *       첫 관측 Q로 <b>3중 조건</b>을 봅니다:
 *       <ul>
 *         <li>가격비 — 원시 종가 비 P/Q가 1보다 k에 가깝다(로그 거리): 원시가가 실제로 k배 뛰었다</li>
 *         <li>거래량비 — 원시 거래량 비 Q/중앙값(E 전 관측들)이 1보다 k에 가깝다. <b>토스 거래량 한 출처로만</b> 잽니다
 *             (NXT 종목 토스 거래량은 금융위의 약 1.7배라 섞으면 비가 틀어짐 — 조사 노트 toss.md)</li>
 *         <li>순자산 연속성 — 고친 수량으로 본 보유 가치 floor(수량 × k) × Q ÷ (수량 × P)가 가격제한폭 ±30% 안(보유가 없으면 한 주로
 *             k × Q/P). 단주 버림으로 0주가 되는 병합도 여기서 걸립니다</li>
 *       </ul>
 *       셋을 채우면 {@link Kind#SPLIT}(수량 floor(수량 × k), 평단·최고가는 부르는 쪽이 {@link SplitDetector#adjustPrice}),
 *       하나라도 못 채우면 미처리. E 이후 관측이 아직 없으면(정지 중) {@link Kind#PENDING} — 그날 주문만 보류하고 다음 관측을 기다립니다.
 *       새 변화가 둘 이상이면 미처리.</li>
 *   <li><b>가격제한폭 밖 변동</b>: 이웃한 두 관측(거래량 0 봉은 건너뜀)의 원시 종가 변화가 ±{@link #PRICE_LIMIT} 밖. 확인된 분할의 그
 *       구간이면 설명된 것이고, 아니면 미처리입니다(정리매매·감자·출처 오류 등).</li>
 *   <li><b>상태 신호</b>(since와 상관없이 그 상태면 매번): 금융위 상장주식수가 ±{@link #LISTED_SHARES_CHANGE} 넘게 바뀜(창 안 비율 변화의
 *       k와 맞으면 설명됨 — 금융위는 하루 늦게 들어옴), 토스·금융위 모두 종목 없음, 최근 {@link #LONG_SUSPENSION_BARS}봉 이상 이어진
 *       거래량 0(긴 거래정지 — 인적분할 변경상장·합병·상장폐지 등. 거래량을 모르는 봉(null)은 세지 않습니다 — 모름은 정지 신호가 아님).
 *       보유의 보류 표시는 한 번 걸면 사람이 풀 때까지 남으므로 같은 신호가 밤마다 다시 나와도 됩니다.</li>
 * </ol>
 *
 * <p><b>결과를 쓰는 쪽</b>(장부 연결은 C2): {@link Assessment#holdOrders()}면 그 종목 주문을 그날 보류, {@link Kind#SPLIT}이면 수량을
 * 고치고, {@link Kind#UNPROCESSED}면 보유에 '미처리 기업행위' 사유({@link #holdReason} → {@code paper_positions.corp_action_hold})를
 * 걸어 평가를 마지막 확정가로 묶고 스탑을 걸지 않으며 주문을 보류합니다. 보류가 {@link #ALERT_AFTER_TRADING_DAYS}거래일 넘게
 * 이어지면 운영 알림({@link #alertDue}). 인적분할 신주·유무상증자 권리·합병 신주는 자동으로 반영하지 않습니다(§6).
 *
 * <p>순수 계산입니다(이 패키지는 {@code java.*}만). 문턱값은 명세가 정하지 않은 자리를 B7에서 정한 것입니다(명세 §4-2 'B7에서 정한 것').
 */
public final class KrxCorporateActions {

    private KrxCorporateActions() {
    }

    /** KRX 정규장 가격제한폭(전일 종가 ±30%, [2차] 조사 노트 rules-costs.md). 순자산 연속성·큰 변동의 문턱입니다. */
    public static final double PRICE_LIMIT = 0.30;
    /** 가격제한폭 경계의 부동소수 여유 — 정확히 ±30%는 안쪽(상·하한가)입니다. */
    private static final double LIMIT_SLACK = 1e-9;
    /** 이웃한 봉의 수정 비율이 이만큼(상대값) 넘게 다를 때만 '바뀜' — 정수 원으로 반올림한 수정가의 잡음을 버립니다. */
    public static final double RATIO_NOISE = 0.005;
    /**
     * ETF(펀드)의 수정 비율 변화 중 이만큼(상대값, 경계 포함) 안은 분배락 조정 — 사건이 아닙니다(QA-144). [확인 — G16, 2026-10-29] 토스
     * 수정주가는 주식 배당은 조정하지 않지만 ETF 분배금은 조정합니다(069500 분기 0.11~0.44%·153130 매달 약 0.2%). 장부는 분배금을 반영하지
     * 않으므로(명세 §4-2) 그 변화로 보유를 묶지 않고, 이 밖(분할 k ≥ 2 등)은 주식과 같은 판정입니다. ±10%는 {@link SplitDetector}의 '분할 아님' 폭과 같습니다.
     */
    public static final double FUND_DISTRIBUTION_BAND = 0.10;
    /** 한국 분할·병합(액면 변경)으로 읽는 최소 배율 — k ≥ 2 또는 k ≤ 1/2. 그 사이(6:5·3:2 등)는 증자 조정으로 보고 미처리. */
    public static final int MIN_SPLIT_FACTOR = 2;
    /**
     * 최근 봉이 이만큼 이상 이어서 거래량 0이면 긴 거래정지 — 미처리. 거래량을 모르는 봉(null)은 세지 않습니다(B4 계약 '모르면 null — 0은
     * 정지일'). [확인] 2018 삼성전자 분할 정지는 3봉.
     */
    public static final int LONG_SUSPENSION_BARS = 5;
    /** 금융위 상장주식수가 이만큼(상대값) 이상 바뀌면 신호 — 자사주 소각·전환사채 전환 같은 작은 변화는 넘깁니다. */
    public static final double LISTED_SHARES_CHANGE = 0.10;
    /** 보류가 걸린 날 뒤로 이 거래일 수를 넘기면 운영 알림({@link #alertDue}). */
    public static final int ALERT_AFTER_TRADING_DAYS = 5;
    /** 보류 사유의 최대 길이 — 행이 끝없이 길어지지 않게(미국 split_note 상한과 같음). */
    public static final int HOLD_REASON_MAX = 500;
    /** 보류 사유 머리의 날짜 길이(yyyy-MM-dd). */
    private static final int DATE_LENGTH = 10;

    /** 판정 종류. */
    public enum Kind {
        /** 새 신호 없음 — 평소대로. */
        NONE("없음"),
        /** 수정 비율이 분할·병합으로 바뀌었는데 그 뒤 관측(거래량 > 0 봉)이 아직 없음 — 그날 주문만 보류, 수량 그대로. */
        PENDING("판정 대기"),
        /** 3중 조건을 채운 분할·병합 — 수량을 고치고 그날 주문 보류. */
        SPLIT("분할·병합"),
        /** 미처리 기업행위 — 보유 보류 표시·평가 묶음·스탑 없음·주문 보류·사람 확인. */
        UNPROCESSED("미처리 기업행위");

        private final String label;

        Kind(String label) {
            this.label = label;
        }

        public String label() {
            return label;
        }
    }

    /** 판정에 걸린 신호(설명된 것은 빠짐 — 확인된 분할의 가격 변동·그 분할과 맞는 상장주식수 변화). */
    public enum Signal {
        /** 토스 수정 비율(adjusted ÷ raw)이 새로 바뀜. */
        ADJ_RATIO_CHANGE("수정주가 비율 변화"),
        /** 이웃한 두 관측의 원시 종가 변화가 가격제한폭 밖. */
        PRICE_LIMIT("가격제한폭 밖 변동"),
        /** 금융위 상장주식수의 큰 변화. */
        LISTED_SHARES("상장주식수 변화"),
        /** 토스·금융위 모두 종목 없음. */
        VANISHED("사라진 종목"),
        /** 긴 거래정지(최근 봉이 이어서 거래량 0). */
        LONG_SUSPENSION("긴 거래정지");

        private final String label;

        Signal(String label) {
            this.label = label;
        }

        public String label() {
            return label;
        }
    }

    /** 분할·병합 3중 조건. */
    public enum Condition {
        PRICE_RATIO("가격비"),
        VOLUME_RATIO("거래량비"),
        NAV_CONTINUITY("순자산 연속성");

        private final String label;

        Condition(String label) {
            this.label = label;
        }

        public String label() {
            return label;
        }
    }

    /** 한 출처에 그 종목이 있는가. */
    public enum Presence {
        /** 출처가 답했고 그 종목이 있음. */
        LISTED,
        /** 출처가 끝까지 답했는데 그 종목이 없음. */
        ABSENT,
        /** 출처가 실패했거나 아직 모름 — '사라짐'으로 읽지 않음(가격 없음은 부르는 쪽의 price_stale). */
        UNKNOWN
    }

    /**
     * 토스 일봉 하나(원시가 판).
     *
     * @param date     거래일
     * @param close    원시 종가({@code adjusted=false})
     * @param volume   원시 거래량. 0이면 관측 아님(정지일), null이면 모름(관측 아님)
     * @param adjRatio 같은 날의 수정 종가 ÷ 원시 종가. null이면 모름(그 봉은 비율 비교에서 빠짐)
     * @throws IllegalArgumentException 날짜 없음, 종가가 양수가 아님, 거래량 음수, 비율이 양수가 아님
     */
    public record DailyBar(LocalDate date, double close, Long volume, Double adjRatio) {
        public DailyBar {
            Objects.requireNonNull(date, "봉 날짜가 없습니다");
            if (!(close > 0) || Double.isInfinite(close)) {
                throw new IllegalArgumentException("종가는 양수여야 합니다: " + date + " " + close);
            }
            if (volume != null && volume < 0) {
                throw new IllegalArgumentException("거래량은 음수일 수 없습니다: " + date + " " + volume);
            }
            if (adjRatio != null && (!(adjRatio > 0) || Double.isInfinite(adjRatio))) {
                throw new IllegalArgumentException("수정 비율은 양수여야 합니다: " + date + " " + adjRatio);
            }
        }

        /** 관측인가(거래량 > 0). */
        public boolean observed() {
            return KrxCorporateActions.observed(volume);
        }
    }

    /**
     * 금융위 한 기준일의 상장주식수.
     *
     * @throws IllegalArgumentException 기준일 없음, 주식수가 양수가 아님
     */
    public record ListedShares(LocalDate basDt, long shares) {
        public ListedShares {
            Objects.requireNonNull(basDt, "기준일이 없습니다");
            if (shares <= 0) {
                throw new IllegalArgumentException("상장주식수는 양수여야 합니다: " + basDt + " " + shares);
            }
        }
    }

    /**
     * 출처별 상장 상태.
     *
     * @param toss         토스 일봉 응답에 그 종목이 있는가
     * @param fsc          금융위 최신 기준일(ETF는 증권상품시세)에 그 종목이 있는가
     * @param sharesBefore 금융위 직전 기준일 상장주식수(모르면 null — 상장주식수 신호를 보지 않음)
     * @param sharesAfter  금융위 최신 기준일 상장주식수(모르면 null)
     * @throws IllegalArgumentException 출처 상태 null, 두 기준일이 뒤바뀌거나 같음
     */
    public record Listing(Presence toss, Presence fsc, ListedShares sharesBefore, ListedShares sharesAfter) {

        /** 아무것도 모름 — 상태 신호를 보지 않습니다. */
        public static final Listing UNKNOWN = new Listing(Presence.UNKNOWN, Presence.UNKNOWN, null, null);

        public Listing {
            Objects.requireNonNull(toss, "토스 상장 상태가 없습니다");
            Objects.requireNonNull(fsc, "금융위 상장 상태가 없습니다");
            if (sharesBefore != null && sharesAfter != null && !sharesBefore.basDt().isBefore(sharesAfter.basDt())) {
                throw new IllegalArgumentException("상장주식수 기준일은 직전 < 최신이어야 합니다: " + sharesBefore.basDt()
                        + " · " + sharesAfter.basDt());
            }
        }

        /** 두 출처 모두 그 종목이 있고 상장주식수는 이 두 기준일 값. */
        public static Listing listed(ListedShares before, ListedShares after) {
            return new Listing(Presence.LISTED, Presence.LISTED, before, after);
        }
    }

    /**
     * 판정.
     *
     * @param kind          종류
     * @param signals       걸린 신호(설명된 것은 빠짐)
     * @param ratio         새 수정 비율 변화의 분할·병합 비율(SPLIT·PENDING, 그리고 비율을 읽은 미처리) — 그 밖에는 null
     * @param effectiveDate 새 수정 비율 변화의 날짜 E(비율이 바뀐 첫 봉) — 없으면 null
     * @param newQty        SPLIT이면 고친 수량 floor(수량 × k), 아니면 받은 수량 그대로
     * @param failed        못 채운 3중 조건(조건을 본 경우만)
     * @param details       사람이 읽는 근거 — 보류 사유({@link #holdReason})·작업 기록용
     */
    public record Assessment(Kind kind, List<Signal> signals, Ratio ratio, LocalDate effectiveDate, int newQty,
                             List<Condition> failed, List<String> details) {
        public Assessment {
            Objects.requireNonNull(kind, "판정 종류가 없습니다");
            signals = List.copyOf(signals);
            failed = List.copyOf(failed);
            details = List.copyOf(details);
        }

        /** 그 종목 주문을 그날 보류해야 하는가(신호가 하나라도 있으면). */
        public boolean holdOrders() {
            return kind != Kind.NONE;
        }

        /** 보유에 '미처리 기업행위' 표시를 걸어야 하는가. */
        public boolean needsHold() {
            return kind == Kind.UNPROCESSED;
        }
    }

    /** 거래량으로 본 관측 여부 — 0(정지일 봉)·null(모름)은 관측이 아닙니다. 체결·평가·비율 계산은 관측만 씁니다. */
    public static boolean observed(Long volume) {
        return volume != null && volume > 0;
    }

    /** 날짜가 가장 늦은 관측(거래량 > 0 봉). 없으면 empty. */
    public static Optional<DailyBar> lastObservation(List<DailyBar> bars) {
        List<DailyBar> sorted = sorted(bars);
        for (int i = sorted.size() - 1; i >= 0; i--) {
            if (sorted.get(i).observed()) {
                return Optional.of(sorted.get(i));
            }
        }
        return Optional.empty();
    }

    /**
     * 종목 하나의 기업행위 판정(클래스 설명).
     *
     * @param asOf    판정하는 관측의 기준 거래일 — 근거 문장과 보류 사유의 날짜
     * @param since   그 보유 수량이 이미 반영한 마지막 <b>관측</b> 날짜(보유가 없으면 그 종목 주문의 기준 거래일). 이 날짜 뒤의 비율
     *                변화·가격 변동만 새 사건입니다 — 정지일(거래량 0 봉)은 관측이 아니므로 이 날짜를 거기까지 옮기지 않습니다(그래야 정지 중
     *                바뀐 비율이 다음 관측 때 판정됨)
     * @param qty     지금 보유 수량(고치기 전, 보유가 없으면 0)
     * @param bars    그 종목의 토스 일봉(순서 상관없음, 날짜는 겹치지 않음). 이어 쓴(stale) 저장본은 넘기지 않습니다
     * @param listing 출처별 상장 상태(모르면 {@link Listing#UNKNOWN})
     * @throws IllegalArgumentException 인자 null, 수량 음수, 같은 날짜의 봉이 둘
     */
    public static Assessment assess(LocalDate asOf, LocalDate since, int qty, List<DailyBar> bars, Listing listing) {
        return assess(asOf, since, qty, bars, listing, false);
    }

    /**
     * 종목 하나의 기업행위 판정 — {@code fund}(ETF)면 {@link #FUND_DISTRIBUTION_BAND} 안의 수정 비율 변화를 분배락 조정으로 보고 건너뜁니다(QA-144).
     *
     * @param fund 그 종목이 ETF인가(부르는 쪽의 ETF 목록 — 한국은 설정 현금성 ∪ 벤치마크 종목)
     * @see #assess(LocalDate, LocalDate, int, List, Listing)
     */
    public static Assessment assess(LocalDate asOf, LocalDate since, int qty, List<DailyBar> bars, Listing listing,
                                    boolean fund) {
        Objects.requireNonNull(asOf, "기준 거래일이 없습니다");
        Objects.requireNonNull(since, "반영한 마지막 관측 날짜가 없습니다");
        Objects.requireNonNull(listing, "상장 상태가 없습니다(모르면 Listing.UNKNOWN)");
        if (qty < 0) {
            throw new IllegalArgumentException("보유 수량은 0 이상이어야 합니다: " + qty);
        }
        List<DailyBar> sorted = sorted(bars);
        Set<Signal> signals = EnumSet.noneOf(Signal.class);
        List<String> details = new ArrayList<>();
        boolean unresolved = false;

        // ① 사라진 종목·긴 거래정지(상태)
        if (listing.toss() == Presence.ABSENT && listing.fsc() == Presence.ABSENT) {
            signals.add(Signal.VANISHED);
            details.add("토스·금융위 모두 종목 없음(상장폐지·합병·변경상장 거래정지 등)");
            unresolved = true;
        }
        int suspended = trailingSuspensionBars(sorted);
        if (suspended >= LONG_SUSPENSION_BARS) {
            signals.add(Signal.LONG_SUSPENSION);
            details.add("최근 %d봉 이어서 거래량 0(거래정지 — 마지막 관측 %s)".formatted(suspended,
                    lastObservation(sorted).map(b -> b.date().toString()).orElse("창 안에 없음")));
            unresolved = true;
        }

        // ② 새 수정 비율 변화 — 하나면 분할·병합 후보(3중 조건)
        List<Step> steps = ratioSteps(sorted, fund);
        List<Step> fresh = steps.stream().filter(s -> s.date().isAfter(since)).toList();
        Ratio ratio = null;
        LocalDate effective = null;
        int newQty = qty;
        boolean split = false;
        boolean pending = false;
        List<Condition> failed = new ArrayList<>();
        if (fresh.size() > 1) {
            signals.add(Signal.ADJ_RATIO_CHANGE);
            details.add("수정주가 비율이 창 안에서 %d번 바뀜(%s)".formatted(fresh.size(),
                    String.join("·", fresh.stream().map(s -> s.date().toString()).toList())));
            unresolved = true;
        } else if (fresh.size() == 1) {
            Step step = fresh.get(0);
            signals.add(Signal.ADJ_RATIO_CHANGE);
            effective = step.date();
            Optional<Ratio> read = step.read();
            if (read.isEmpty()) {
                details.add("%s 수정주가 비율 변화 ×%s — 분할·병합 비율로 읽히지 않음(증자·배당 조정 등)"
                        .formatted(effective, decimal(step.factor(), 4)));
                unresolved = true;
            } else if (!faceValueRatio(read.get())) {
                ratio = read.get();
                details.add("%s 수정주가 비율 %s — 한국 분할·병합(액면 변경) 비율이 아님(무상·유상증자 등)"
                        .formatted(effective, ratio.label()));
                unresolved = true;
            } else {
                ratio = read.get();
                DailyBar pre = lastObservationBefore(sorted, effective);
                DailyBar post = firstObservationFrom(sorted, effective);
                if (pre == null) {
                    details.add("%s %s 분할·병합 신호 — 그 전 관측(거래량 > 0 봉)이 창에 없어 3중 조건을 볼 수 없음"
                            .formatted(effective, ratio.label()));
                    unresolved = true;
                } else if (post == null) {
                    pending = true;
                    details.add("%s %s 분할·병합 신호 — 그 뒤 관측(거래량 > 0 봉)을 기다림".formatted(effective, ratio.label()));
                } else {
                    double priceRatio = pre.close() / post.close();
                    double volumeRatio = post.volume() / medianVolumeBefore(sorted, effective);
                    double nav = navChange(qty, pre.close(), post.close(), ratio);
                    if (!closerToRatio(priceRatio, ratio)) {
                        failed.add(Condition.PRICE_RATIO);
                    }
                    if (!closerToRatio(volumeRatio, ratio)) {
                        failed.add(Condition.VOLUME_RATIO);
                    }
                    if (!withinLimit(nav)) {
                        failed.add(Condition.NAV_CONTINUITY);
                    }
                    String evidence = "가격비 ×%s(%s %s → %s %s)·거래량비 ×%s·순자산 ×%s".formatted(
                            decimal(priceRatio, 2), pre.date(), won(pre.close()), post.date(), won(post.close()),
                            decimal(volumeRatio, 2), decimal(nav, 3));
                    if (failed.isEmpty()) {
                        split = true;
                        newQty = SplitDetector.adjustQty(qty, ratio);
                        details.add("%s %s 분할·병합 확인 — %s, %d주 → %d주".formatted(effective, ratio.label(), evidence,
                                qty, newQty));
                    } else {
                        details.add("%s %s 분할·병합 신호 — 3중 조건 불충족(%s): %s".formatted(effective, ratio.label(),
                                String.join("·", failed.stream().map(Condition::label).toList()), evidence));
                        unresolved = true;
                    }
                }
            }
        }

        // ③ 가격제한폭 밖 변동 — 확인된 분할의 그 구간만 설명됨
        for (Move move : bigMoves(sorted, since)) {
            boolean explained = split && move.from().date().isBefore(effective) && !move.to().date().isBefore(effective);
            if (!explained) {
                signals.add(Signal.PRICE_LIMIT);
                details.add("%s 가격제한폭(±30%%) 밖 변동 %s%%(%s %s → %s %s)".formatted(move.to().date(),
                        signedPercent(move.change() - 1), move.from().date(), won(move.from().close()), move.to().date(),
                        won(move.to().close())));
                unresolved = true;
            }
        }

        // ④ 금융위 상장주식수(상태) — 창 안 비율 변화의 비율과 맞으면 설명됨
        ListedShares before = listing.sharesBefore();
        ListedShares after = listing.sharesAfter();
        if (before != null && after != null) {
            double change = (double) after.shares() / before.shares();
            if (Math.abs(change - 1) >= LISTED_SHARES_CHANGE) {
                LocalDate splitDate = split ? effective : null;
                boolean explained = steps.stream().anyMatch(s -> explainsShares(s, change, before, after)
                        && (!s.date().isAfter(since) || s.date().equals(splitDate)));
                if (!explained) {
                    signals.add(Signal.LISTED_SHARES);
                    details.add("금융위 상장주식수 %s%%(%s %s주 → %s %s주)".formatted(signedPercent(change - 1),
                            before.basDt(), count(before.shares()), after.basDt(), count(after.shares())));
                    unresolved = true;
                }
            }
        }

        Kind kind = unresolved ? Kind.UNPROCESSED : split ? Kind.SPLIT : pending ? Kind.PENDING : Kind.NONE;
        return new Assessment(kind, List.copyOf(signals), ratio, effective, kind == Kind.SPLIT ? newQty : qty, failed,
                details);
    }

    /**
     * 보유에 거는 '미처리 기업행위' 사유 — {@code "yyyy-MM-dd 기업행위 확인 필요 — 근거; 근거"}. 머리 날짜는 보류가 걸린 날이고
     * {@link #holdSince}가 다시 읽어 알림 기한을 셉니다. {@link #HOLD_REASON_MAX}자를 넘으면 자르고 '…'를 붙입니다.
     *
     * @throws IllegalArgumentException 미처리 판정이 아님
     */
    public static String holdReason(LocalDate asOf, Assessment assessment) {
        Objects.requireNonNull(asOf, "기준 거래일이 없습니다");
        if (!assessment.needsHold()) {
            throw new IllegalArgumentException("미처리 기업행위가 아닌 판정에는 보류 사유가 없습니다: " + assessment.kind());
        }
        String text = asOf + " 기업행위 확인 필요 — " + String.join("; ", assessment.details());
        return text.length() <= HOLD_REASON_MAX ? text : text.substring(0, HOLD_REASON_MAX - 1) + "…";
    }

    /** 보류 사유 머리의 날짜(보류가 걸린 날). 그 꼴이 아니면 empty — 부르는 쪽은 걸린 날을 모르는 보류로 다룹니다. */
    public static Optional<LocalDate> holdSince(String reason) {
        if (reason == null || reason.length() < DATE_LENGTH) {
            return Optional.empty();
        }
        try {
            return Optional.of(LocalDate.parse(reason.substring(0, DATE_LENGTH)));
        } catch (DateTimeParseException e) {
            return Optional.empty();
        }
    }

    /**
     * 보류가 {@link #ALERT_AFTER_TRADING_DAYS}거래일 넘게 이어졌는가 — 걸린 날은 빼고 오늘까지 센 거래일 수가 5를 넘으면 참
     * (예: 2026-11-02 월요일에 걸리면 11-09는 5거래일이라 아직, 11-10부터 알림).
     *
     * @throws CalendarUnavailableException 달력이 모르는 해의 평일에 닿음
     */
    public static boolean alertDue(TradingCalendar calendar, LocalDate since, LocalDate today) {
        return calendar.tradingDaysBetween(since, today) > ALERT_AFTER_TRADING_DAYS;
    }

    // ------------------------------------------------------------------ 3중 조건(패키지 안 시험용)

    /** 관측한 비(가격비·거래량비)가 1보다 k에 가까운가 — 로그 거리. 정확히 가운데(√k)는 아님. */
    static boolean closerToRatio(double observed, Ratio ratio) {
        if (!(observed > 0) || Double.isInfinite(observed)) {
            return false;
        }
        double log = Math.log(observed);
        return Math.abs(log - Math.log(ratio.value())) < Math.abs(log);
    }

    /** 고친 수량으로 본 보유 가치의 변화(보유가 없으면 한 주의 k × 뒤/앞). 0주가 되면 0. */
    static double navChange(int qty, double preClose, double postClose, Ratio ratio) {
        if (qty == 0) {
            return ratio.value() * postClose / preClose;
        }
        int adjusted = SplitDetector.adjustQty(qty, ratio);
        return (double) adjusted * postClose / ((double) qty * preClose);
    }

    /** 변화(뒤 ÷ 앞)가 가격제한폭 안인가 — ±30% 경계 포함. */
    static boolean withinLimit(double change) {
        return change >= 1 - PRICE_LIMIT - LIMIT_SLACK && change <= 1 + PRICE_LIMIT + LIMIT_SLACK;
    }

    /** 한국 분할·병합(액면 변경) 비율인가 — k ≥ 2 또는 k ≤ 1/2. */
    static boolean faceValueRatio(Ratio ratio) {
        return ratio.numerator() >= (long) MIN_SPLIT_FACTOR * ratio.denominator()
                || ratio.denominator() >= (long) MIN_SPLIT_FACTOR * ratio.numerator();
    }

    // ------------------------------------------------------------------ 내부

    /** 수정 비율이 바뀐 자리: date = 새 비율의 첫 봉, before·after = 앞·뒤 비율. */
    private record Step(LocalDate date, double before, double after) {
        /** k = 뒤 ÷ 앞(분할 전 봉은 수정가 = 원시가 / k라 비율이 1/k). */
        double factor() {
            return after / before;
        }

        Optional<Ratio> read() {
            return SplitDetector.detect(after, before);
        }
    }

    /** 이웃한 두 관측. */
    private record Move(DailyBar from, DailyBar to) {
        double change() {
            return to.close() / from.close();
        }
    }

    private static List<DailyBar> sorted(List<DailyBar> bars) {
        Objects.requireNonNull(bars, "봉 목록이 없습니다");
        List<DailyBar> out = new ArrayList<>(bars);
        out.sort(Comparator.comparing(DailyBar::date));
        for (int i = 1; i < out.size(); i++) {
            if (out.get(i).date().equals(out.get(i - 1).date())) {
                throw new IllegalArgumentException("같은 날짜의 봉이 둘입니다: " + out.get(i).date());
            }
        }
        return out;
    }

    /**
     * 최근 봉부터 거슬러 센, 이어진 거래량 0 봉(정지일) 수. 거래량을 모르는 봉(null)을 만나면 멈춥니다 — 모르는 값을 정지로 읽으면
     * 거래량이 비어 온 날마다 '긴 거래정지' 보류(한 번 걸면 남음)가 걸리고 근거 문장도 사실과 달리 '거래량 0'이라고 적습니다.
     */
    private static int trailingSuspensionBars(List<DailyBar> sorted) {
        int count = 0;
        for (int i = sorted.size() - 1; i >= 0; i--) {
            Long volume = sorted.get(i).volume();
            if (volume == null || volume.longValue() != 0L) {
                break;
            }
            count++;
        }
        return count;
    }

    private static List<Step> ratioSteps(List<DailyBar> sorted, boolean fund) {
        List<Step> out = new ArrayList<>();
        DailyBar previous = null;
        for (DailyBar bar : sorted) {
            if (bar.adjRatio() == null) {
                continue;
            }
            double change = previous == null ? 0 : Math.abs(bar.adjRatio() / previous.adjRatio() - 1);
            if (change > RATIO_NOISE && !(fund && change <= FUND_DISTRIBUTION_BAND + LIMIT_SLACK)) {
                out.add(new Step(bar.date(), previous.adjRatio(), bar.adjRatio()));
            }
            previous = bar;
        }
        return out;
    }

    private static List<Move> bigMoves(List<DailyBar> sorted, LocalDate since) {
        List<Move> out = new ArrayList<>();
        DailyBar previous = null;
        for (DailyBar bar : sorted) {
            if (!bar.observed()) {
                continue;
            }
            if (previous != null && bar.date().isAfter(since) && !withinLimit(bar.close() / previous.close())) {
                out.add(new Move(previous, bar));
            }
            previous = bar;
        }
        return out;
    }

    private static DailyBar lastObservationBefore(List<DailyBar> sorted, LocalDate date) {
        DailyBar out = null;
        for (DailyBar bar : sorted) {
            if (bar.date().isBefore(date) && bar.observed()) {
                out = bar;
            }
        }
        return out;
    }

    private static DailyBar firstObservationFrom(List<DailyBar> sorted, LocalDate date) {
        for (DailyBar bar : sorted) {
            if (!bar.date().isBefore(date) && bar.observed()) {
                return bar;
            }
        }
        return null;
    }

    /** E 전 관측들의 거래량 중앙값(짝수면 가운데 둘의 평균). 부르는 쪽이 E 전 관측이 있음을 확인한 뒤 부릅니다. */
    private static double medianVolumeBefore(List<DailyBar> sorted, LocalDate date) {
        List<Long> volumes = new ArrayList<>();
        for (DailyBar bar : sorted) {
            if (bar.date().isBefore(date) && bar.observed()) {
                volumes.add(bar.volume());
            }
        }
        volumes.sort(Comparator.naturalOrder());
        int n = volumes.size();
        return n % 2 == 1 ? volumes.get(n / 2) : (volumes.get(n / 2 - 1) + (double) volumes.get(n / 2)) / 2;
    }

    /** 이 비율 변화가 상장주식수 변화를 설명하는가 — 날짜가 두 기준일 사이(직전 < E ≤ 최신)이고 배율이 k와 10% 안. */
    private static boolean explainsShares(Step step, double change, ListedShares before, ListedShares after) {
        if (!step.date().isAfter(before.basDt()) || step.date().isAfter(after.basDt())) {
            return false;
        }
        Optional<Ratio> read = step.read();
        return read.isPresent() && Math.abs(change / read.get().value() - 1) < LISTED_SHARES_CHANGE;
    }

    private static String decimal(double value, int scale) {
        return String.format(Locale.ROOT, "%." + scale + "f", value);
    }

    private static String signedPercent(double fraction) {
        return String.format(Locale.ROOT, "%+.1f", fraction * 100);
    }

    private static String won(double value) {
        return String.format(Locale.ROOT, "%,.0f", value);
    }

    private static String count(long value) {
        return String.format(Locale.ROOT, "%,d", value);
    }
}
