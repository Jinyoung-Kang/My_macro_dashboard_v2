package com.macrodash.analytics;

import com.macrodash.analytics.KrxCorporateActions.Assessment;
import com.macrodash.analytics.KrxCorporateActions.Condition;
import com.macrodash.analytics.KrxCorporateActions.DailyBar;
import com.macrodash.analytics.KrxCorporateActions.Kind;
import com.macrodash.analytics.KrxCorporateActions.ListedShares;
import com.macrodash.analytics.KrxCorporateActions.Listing;
import com.macrodash.analytics.KrxCorporateActions.Presence;
import com.macrodash.analytics.KrxCorporateActions.Signal;
import com.macrodash.analytics.SplitDetector.Ratio;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.UnaryOperator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 기업행위 감지(2단계 명세 §4-2·K32, §5 '기업행위 — 3중 조건을 채운 분할·병합만 수량을 고치고, 못 채운 큰 변동·사라진 종목은
 * 미처리'). 분할 사례는 토스 실제 응답(삼성전자 2018 50:1 — {@code paper/kr-corporate-actions/}, 출처는 파일의 {@code _source})이고,
 * 나머지 갈래는 그 모양을 본뜬 가상 봉입니다. 미국 분할 경로({@link SplitDetector})는 {@code SplitDetectorTest} 그대로입니다.
 */
class KrxCorporateActionsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final LocalDate APR_25 = LocalDate.of(2018, 4, 25);
    private static final LocalDate APR_27 = LocalDate.of(2018, 4, 27);
    private static final LocalDate APR_30 = LocalDate.of(2018, 4, 30);
    private static final LocalDate MAY_02 = LocalDate.of(2018, 5, 2);
    private static final LocalDate MAY_03 = LocalDate.of(2018, 5, 3);
    private static final LocalDate MAY_04 = LocalDate.of(2018, 5, 4);
    private static final LocalDate MAY_08 = LocalDate.of(2018, 5, 8);
    private static final LocalDate NOV_02 = LocalDate.of(2026, 11, 2);
    private static final LocalDate NOV_03 = LocalDate.of(2026, 11, 3);
    private static final LocalDate NOV_04 = LocalDate.of(2026, 11, 4);
    private static final LocalDate NOV_05 = LocalDate.of(2026, 11, 5);

    // ------------------------------------------------------------------ 실제 분할(삼성전자 2018-05-04 50:1)

    @Test
    @DisplayName("[확인] 삼성전자 50:1 분할 밤(05-04): 비율 0.02 → 1, 3중 조건 충족 — 10주 → 500주, 그날 주문 보류, 보류 표시는 없음")
    void samsungSplitIsConfirmed() {
        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 10, samsung(APR_27, MAY_04), Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.SPLIT);
        assertThat(a.ratio()).isEqualTo(new Ratio(50, 1));
        assertThat(a.effectiveDate()).isEqualTo(MAY_04);
        assertThat(a.newQty()).isEqualTo(500);
        assertThat(a.signals()).containsExactly(Signal.ADJ_RATIO_CHANGE);   // 원시가 −98% 변동은 분할로 설명됨
        assertThat(a.failed()).isEmpty();
        assertThat(a.holdOrders()).isTrue();
        assertThat(a.needsHold()).isFalse();
        // 가격비 2,650,000 / 51,900 = 51.06 · 거래량비 39,565,391 / 606,216 = 65.27 · 순자산 500 × 51,900 / (10 × 2,650,000) = 0.979
        assertThat(a.details()).containsExactly("2018-05-04 50:1 분할·병합 확인 — 가격비 ×51.06(2018-04-27 2,650,000 → "
                + "2018-05-04 51,900)·거래량비 ×65.27·순자산 ×0.979, 10주 → 500주");
    }

    @Test
    @DisplayName("거래량비의 분모는 분할 전 관측들의 중앙값 — 창이 넓으면(04-25~) 332,292·360,931·606,216의 가운데 360,931")
    void volumeRatioUsesMedianOfPreEventObservations() {
        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 10, samsung(APR_25, MAY_04), Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.SPLIT);
        assertThat(a.details().get(0)).contains("거래량비 ×109.62");   // 39,565,391 / 360,931
    }

    @Test
    @DisplayName("[확인] 분할 정지일(거래량 0, 시고저종 = 전일 종가)은 관측이 아니다 — 정지 중 밤에는 신호 없음, 마지막 관측은 04-27")
    void suspensionBarsAreNotObservations() {
        List<DailyBar> bars = samsung(APR_25, MAY_03);

        assertThat(bars.stream().filter(b -> !b.observed()).map(DailyBar::date)).containsExactly(APR_30, MAY_02, MAY_03);
        assertThat(KrxCorporateActions.lastObservation(bars)).hasValueSatisfying(b -> assertThat(b.date()).isEqualTo(APR_27));
        Assessment a = KrxCorporateActions.assess(MAY_03, APR_27, 10, bars, Listing.UNKNOWN);
        assertThat(a.kind()).isEqualTo(Kind.NONE);
        assertThat(a.holdOrders()).isFalse();
        assertThat(a.newQty()).isEqualTo(10);

        assertThat(KrxCorporateActions.observed(0L)).isFalse();
        assertThat(KrxCorporateActions.observed(null)).as("거래량 모름").isFalse();
        assertThat(KrxCorporateActions.observed(1L)).isTrue();
        assertThat(KrxCorporateActions.lastObservation(List.of())).isEmpty();
    }

    @Test
    @DisplayName("분할을 반영한 뒤(since = 05-04) 다음 밤에는 같은 비율 변화·원시가 변동을 다시 보지 않는다")
    void processedSplitIsNotSeenAgain() {
        Assessment a = KrxCorporateActions.assess(MAY_08, MAY_04, 500, samsung(APR_30, MAY_08), Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.NONE);
        assertThat(a.signals()).isEmpty();
    }

    @Test
    @DisplayName("수정 비율을 모르면(봉마다 null) 분할을 확인할 수 없다 — 원시가 −98% 변동이 가격제한폭 밖이라 미처리(가짜 손실·스탑 방지)")
    void withoutRatiosASplitIsAnUnprocessedBigMove() {
        List<DailyBar> bars = samsung(APR_27, MAY_04).stream()
                .map(b -> new DailyBar(b.date(), b.close(), b.volume(), null)).toList();

        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 10, bars, Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(a.signals()).containsExactly(Signal.PRICE_LIMIT);
        assertThat(a.details()).containsExactly("2018-05-04 가격제한폭(±30%) 밖 변동 -98.0%(2018-04-27 2,650,000 → 2018-05-04 51,900)");
        assertThat(a.newQty()).as("수량은 그대로").isEqualTo(10);
    }

    @Test
    @DisplayName("정지 중에 비율이 바뀌면 판정 대기(그날 주문만 보류) — 다음 밤 첫 관측으로 3중 조건을 보고 분할 확인(since는 마지막 관측 그대로)")
    void ratioChangedDuringSuspensionWaitsForAnObservation() {
        List<DailyBar> rewritten = new ArrayList<>();
        for (DailyBar b : samsung(APR_25, MAY_04)) {
            boolean early = b.date().equals(MAY_02) || b.date().equals(MAY_03);
            rewritten.add(early ? new DailyBar(b.date(), b.close() / 50, b.volume(), 1.0) : b);
        }
        List<DailyBar> night0503 = rewritten.stream().filter(b -> !b.date().isAfter(MAY_03)).toList();

        Assessment waiting = KrxCorporateActions.assess(MAY_03, APR_27, 10, night0503, Listing.UNKNOWN);
        assertThat(waiting.kind()).isEqualTo(Kind.PENDING);
        assertThat(waiting.ratio()).isEqualTo(new Ratio(50, 1));
        assertThat(waiting.effectiveDate()).isEqualTo(MAY_02);
        assertThat(waiting.holdOrders()).isTrue();
        assertThat(waiting.needsHold()).isFalse();
        assertThat(waiting.newQty()).isEqualTo(10);
        assertThat(waiting.details()).containsExactly("2018-05-02 50:1 분할·병합 신호 — 그 뒤 관측(거래량 > 0 봉)을 기다림");

        Assessment next = KrxCorporateActions.assess(MAY_04, APR_27, 10, rewritten, Listing.UNKNOWN);
        assertThat(next.kind()).isEqualTo(Kind.SPLIT);
        assertThat(next.effectiveDate()).isEqualTo(MAY_02);
        assertThat(next.newQty()).isEqualTo(500);
    }

    @Test
    @DisplayName("거래량이 비율만큼 늘지 않으면 거래량비 불충족 — 미처리, 수량 그대로")
    void volumeThatDidNotScaleFailsTheVolumeRatio() {
        List<DailyBar> bars = replace(samsung(APR_27, MAY_04), MAY_04, b -> new DailyBar(b.date(), b.close(), 600_000L,
                b.adjRatio()));

        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 10, bars, Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(a.failed()).containsExactly(Condition.VOLUME_RATIO);
        assertThat(a.ratio()).isEqualTo(new Ratio(50, 1));
        assertThat(a.newQty()).isEqualTo(10);
        assertThat(a.signals()).containsExactly(Signal.ADJ_RATIO_CHANGE, Signal.PRICE_LIMIT);   // 분할이 아니어서 변동도 설명 안 됨
        assertThat(a.details().get(0)).startsWith("2018-05-04 50:1 분할·병합 신호 — 3중 조건 불충족(거래량비): ");
    }

    @Test
    @DisplayName("비율은 50:1인데 원시가가 뛰지 않으면 가격비·순자산 연속성 불충족 — 미처리")
    void priceThatDidNotJumpFailsPriceRatioAndNavContinuity() {
        List<DailyBar> bars = replace(samsung(APR_27, MAY_04), MAY_04, b -> new DailyBar(b.date(), 2_600_000, b.volume(),
                b.adjRatio()));

        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 10, bars, Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(a.failed()).containsExactly(Condition.PRICE_RATIO, Condition.NAV_CONTINUITY);
        assertThat(a.signals()).containsExactly(Signal.ADJ_RATIO_CHANGE);   // −1.9%라 가격제한폭 안
    }

    @Test
    @DisplayName("1:10 병합 — 95주는 9주(단주 버림), 5주는 0주가 되어 순자산 연속성 불충족·미처리(미국처럼 보유를 지우지 않음)")
    void reverseSplit() {
        List<DailyBar> bars = List.of(
                new DailyBar(NOV_02, 1_000, 1_000_000L, 10.0),
                new DailyBar(NOV_03, 1_010, 900_000L, 10.0),
                new DailyBar(NOV_04, 1_010, 0L, 10.0),            // 정지
                new DailyBar(NOV_05, 10_200, 100_000L, 1.0));

        Assessment kept = KrxCorporateActions.assess(NOV_05, NOV_03, 95, bars, Listing.UNKNOWN);
        assertThat(kept.kind()).isEqualTo(Kind.SPLIT);
        assertThat(kept.ratio()).isEqualTo(new Ratio(1, 10));
        assertThat(kept.newQty()).isEqualTo(9);   // 9 × 10,200 / (95 × 1,010) = 0.957

        Assessment vanishing = KrxCorporateActions.assess(NOV_05, NOV_03, 5, bars, Listing.UNKNOWN);
        assertThat(vanishing.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(vanishing.failed()).containsExactly(Condition.NAV_CONTINUITY);
        assertThat(vanishing.newQty()).isEqualTo(5);
        assertThat(vanishing.details().get(0)).contains("순자산 ×0.000");
    }

    @Test
    @DisplayName("한국 분할·병합(액면 변경)이 아닌 비율(6:5 — 0.2주 무상증자 꼴)은 3중 조건을 보지 않고 미처리")
    void bonusIssueLikeRatioIsNotASplit() {
        List<DailyBar> bars = List.of(
                new DailyBar(NOV_02, 12_000, 500_000L, 1 / 1.2),
                new DailyBar(NOV_03, 10_100, 600_000L, 1.0));

        Assessment a = KrxCorporateActions.assess(NOV_03, NOV_02, 100, bars, Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(a.ratio()).isEqualTo(new Ratio(6, 5));
        assertThat(a.failed()).isEmpty();
        assertThat(a.newQty()).isEqualTo(100);
        assertThat(a.details()).containsExactly("2026-11-03 수정주가 비율 6:5 — 한국 분할·병합(액면 변경) 비율이 아님(무상·유상증자 등)");
    }

    @Test
    @DisplayName("±10% 안의 비율 변화(증자·배당 조정 꼴 ×1.0309)는 분할로 읽히지 않아 미처리, 0.5% 안(반올림 잡음)은 신호가 아님")
    void smallRatioChanges() {
        Assessment adjusted = KrxCorporateActions.assess(NOV_03, NOV_02, 100, List.of(
                new DailyBar(NOV_02, 10_000, 500_000L, 0.97),
                new DailyBar(NOV_03, 9_800, 500_000L, 1.0)), Listing.UNKNOWN);
        assertThat(adjusted.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(adjusted.ratio()).isNull();
        assertThat(adjusted.details()).containsExactly(
                "2026-11-03 수정주가 비율 변화 ×1.0309 — 분할·병합 비율로 읽히지 않음(증자·배당 조정 등)");

        Assessment noise = KrxCorporateActions.assess(NOV_03, NOV_02, 100, List.of(
                new DailyBar(NOV_02, 10_000, 500_000L, 0.998),
                new DailyBar(NOV_03, 9_800, 500_000L, 1.0)), Listing.UNKNOWN);
        assertThat(noise.kind()).isEqualTo(Kind.NONE);
    }

    @Test
    @DisplayName("QA-144: ETF는 ±10% 안의 비율 변화(분배락 조정)를 건너뜀 — 같은 변화가 주식이면 미처리, ETF도 ±10% 밖·2:1 분할은 주식과 같은 판정")
    void fundDistributionBand() {
        List<DailyBar> distribution = List.of(
                new DailyBar(NOV_02, 10_000, 500_000L, 0.9934),
                new DailyBar(NOV_03, 9_950, 500_000L, 1.0));
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 100, distribution, Listing.UNKNOWN, true).kind())
                .as("ETF 분배락 ×1.0066").isEqualTo(Kind.NONE);
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 100, distribution, Listing.UNKNOWN, false).kind())
                .as("주식이면 그대로 미처리").isEqualTo(Kind.UNPROCESSED);
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 100, distribution, Listing.UNKNOWN).kind())
                .as("옛 시그니처 = 주식").isEqualTo(Kind.UNPROCESSED);

        Assessment wide = KrxCorporateActions.assess(NOV_03, NOV_02, 100, List.of(
                new DailyBar(NOV_02, 10_000, 500_000L, 0.88),
                new DailyBar(NOV_03, 8_900, 500_000L, 1.0)), Listing.UNKNOWN, true);
        assertThat(wide.kind()).as("±10% 밖(×1.1364)은 ETF도 미처리").isEqualTo(Kind.UNPROCESSED);

        Assessment split = KrxCorporateActions.assess(NOV_04, NOV_02, 100, List.of(
                new DailyBar(NOV_02, 20_000, 500_000L, 0.5),
                new DailyBar(NOV_03, 10_000, 1_000_000L, 1.0),
                new DailyBar(NOV_04, 10_050, 1_000_000L, 1.0)), Listing.UNKNOWN, true);
        assertThat(split.kind()).as("ETF 2:1 분할은 3중 조건으로").isEqualTo(Kind.SPLIT);
        assertThat(split.newQty()).isEqualTo(200);
    }

    @Test
    @DisplayName("새 비율 변화가 둘이면 미처리, 분할 전 관측이 창에 없으면(정지일부터 시작) 3중 조건을 볼 수 없어 미처리")
    void ambiguousRatioChanges() {
        Assessment twice = KrxCorporateActions.assess(NOV_04, NOV_02, 100, List.of(
                new DailyBar(NOV_02, 10_000, 500_000L, 0.25),
                new DailyBar(NOV_03, 20_000, 500_000L, 0.5),
                new DailyBar(NOV_04, 40_000, 500_000L, 1.0)), Listing.UNKNOWN);
        assertThat(twice.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(twice.details().get(0)).isEqualTo("수정주가 비율이 창 안에서 2번 바뀜(2026-11-03·2026-11-04)");

        Assessment noPre = KrxCorporateActions.assess(MAY_04, APR_27, 10, samsung(APR_30, MAY_04), Listing.UNKNOWN);
        assertThat(noPre.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(noPre.ratio()).isEqualTo(new Ratio(50, 1));
        assertThat(noPre.details()).containsExactly(
                "2018-05-04 50:1 분할·병합 신호 — 그 전 관측(거래량 > 0 봉)이 창에 없어 3중 조건을 볼 수 없음");
    }

    @Test
    @DisplayName("가격제한폭: 정확히 ±30%는 안쪽, 밖이면 미처리, 이미 반영한 날의 변동은 다시 보지 않음, 정지일 봉의 가격은 건너뜀")
    void priceLimitMoves() {
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(
                new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_03, 13_000, 1L, 1.0)), Listing.UNKNOWN).kind())
                .as("+30% 상한가").isEqualTo(Kind.NONE);
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(
                new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_03, 7_000, 1L, 1.0)), Listing.UNKNOWN).kind())
                .as("−30% 하한가").isEqualTo(Kind.NONE);

        List<DailyBar> crash = List.of(new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_03, 6_999, 1L, 1.0));
        Assessment a = KrxCorporateActions.assess(NOV_03, NOV_02, 10, crash, Listing.UNKNOWN);
        assertThat(a.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(a.signals()).containsExactly(Signal.PRICE_LIMIT);
        assertThat(a.details()).containsExactly("2026-11-03 가격제한폭(±30%) 밖 변동 -30.0%(2026-11-02 10,000 → 2026-11-03 6,999)");
        assertThat(KrxCorporateActions.assess(NOV_04, NOV_03, 10, crash, Listing.UNKNOWN).kind())
                .as("반영한 날(since = 11-03)").isEqualTo(Kind.NONE);

        assertThat(KrxCorporateActions.assess(NOV_04, NOV_02, 10, List.of(
                new DailyBar(NOV_02, 10_000, 1L, 1.0),
                new DailyBar(NOV_03, 20_000, 0L, 1.0),            // 정지일 봉 — 가격을 보지 않음
                new DailyBar(NOV_04, 10_500, 1L, 1.0)), Listing.UNKNOWN).kind()).isEqualTo(Kind.NONE);
    }

    @Test
    @DisplayName("금융위 상장주식수: +25%는 미처리, 자사주 소각 꼴 −2%는 넘김, 창 안 50:1 분할과 맞는 ×50은 설명됨(반영한 분할·이번에 확인한 분할)")
    void listedSharesChanges() {
        List<DailyBar> quiet = List.of(new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_03, 10_100, 1L, 1.0));
        Assessment grown = KrxCorporateActions.assess(NOV_03, NOV_02, 10, quiet, Listing.listed(
                new ListedShares(NOV_02, 1_000_000), new ListedShares(NOV_03, 1_250_000)));
        assertThat(grown.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(grown.signals()).containsExactly(Signal.LISTED_SHARES);
        assertThat(grown.details()).containsExactly("금융위 상장주식수 +25.0%(2026-11-02 1,000,000주 → 2026-11-03 1,250,000주)");

        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 10, quiet, Listing.listed(
                new ListedShares(NOV_02, 1_000_000), new ListedShares(NOV_03, 980_000))).kind()).isEqualTo(Kind.NONE);

        // 금융위는 하루 늦게 들어옴 — 05-08 밤에 05-04 기준일의 ×50이 보이고, 창 안의 반영한 분할(05-04)이 설명
        Listing afterSplit = Listing.listed(new ListedShares(MAY_03, 128_000_000), new ListedShares(MAY_04, 6_400_000_000L));
        assertThat(KrxCorporateActions.assess(MAY_08, MAY_04, 500, samsung(APR_30, MAY_08), afterSplit).kind())
                .isEqualTo(Kind.NONE);
        Listing sameNight = Listing.listed(new ListedShares(APR_27, 128_000_000), new ListedShares(MAY_04, 6_400_000_000L));
        assertThat(KrxCorporateActions.assess(MAY_04, APR_27, 10, samsung(APR_27, MAY_04), sameNight).kind())
                .isEqualTo(Kind.SPLIT);
        Listing unrelated = Listing.listed(new ListedShares(MAY_03, 128_000_000), new ListedShares(MAY_04, 160_000_000));
        assertThat(KrxCorporateActions.assess(MAY_08, MAY_04, 500, samsung(APR_30, MAY_08), unrelated).signals())
                .as("×1.25는 50:1과 맞지 않음").containsExactly(Signal.LISTED_SHARES);
    }

    @Test
    @DisplayName("사라진 종목: 토스·금융위 모두 없을 때만(봉이 없어도) 미처리 — 한쪽이 모름·있음이면 신호가 아님(가격 없음은 부르는 쪽)")
    void vanishedListing() {
        Assessment gone = KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(),
                new Listing(Presence.ABSENT, Presence.ABSENT, null, null));
        assertThat(gone.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(gone.signals()).containsExactly(Signal.VANISHED);
        assertThat(gone.details()).containsExactly("토스·금융위 모두 종목 없음(상장폐지·합병·변경상장 거래정지 등)");

        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(),
                new Listing(Presence.ABSENT, Presence.UNKNOWN, null, null)).kind()).isEqualTo(Kind.NONE);
        assertThat(KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(),
                new Listing(Presence.LISTED, Presence.ABSENT, null, null)).kind()).isEqualTo(Kind.NONE);
    }

    @Test
    @DisplayName("긴 거래정지: 최근 5봉이 이어서 거래량 0이면 미처리(마지막 관측 날짜를 적음), 4봉(분할 정지 꼴)은 신호가 아님")
    void longSuspension() {
        List<DailyBar> bars = new ArrayList<>();
        bars.add(new DailyBar(NOV_02, 10_000, 1_000L, 1.0));
        for (LocalDate d : List.of(NOV_03, NOV_04, NOV_05, LocalDate.of(2026, 11, 6), LocalDate.of(2026, 11, 9))) {
            bars.add(new DailyBar(d, 10_000, 0L, 1.0));
        }

        Assessment five = KrxCorporateActions.assess(LocalDate.of(2026, 11, 9), NOV_02, 10, bars, Listing.UNKNOWN);
        assertThat(five.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(five.signals()).containsExactly(Signal.LONG_SUSPENSION);
        assertThat(five.details()).containsExactly("최근 5봉 이어서 거래량 0(거래정지 — 마지막 관측 2026-11-02)");

        Assessment four = KrxCorporateActions.assess(LocalDate.of(2026, 11, 6), NOV_02, 10, bars.subList(0, 5),
                Listing.UNKNOWN);
        assertThat(four.kind()).isEqualTo(Kind.NONE);
    }

    @Test
    @DisplayName("[한계] 정지 4봉 + 재상장 봉이 paper.kr.quotes 5봉에 다 들면 E 전 관측 P가 창 밖이라 미처리 — P(그 보유가 반영한 마지막 관측)를 이어 붙이면 분할 확인")
    void fourBarSuspensionNeedsTheLastObservationBeyondTheFiveBarWindow() {
        // 50:1 분할 꼴: P(11-02) 2,650,000원·30만 주, 정지 4봉(11-03~06, 거래량 0·비율 0.02), 재상장 Q(11-09) 53,000원·2천만 주·비율 1.
        DailyBar p = new DailyBar(NOV_02, 2_650_000, 300_000L, 0.02);
        List<DailyBar> window = new ArrayList<>();
        for (LocalDate d : List.of(NOV_03, NOV_04, NOV_05, LocalDate.of(2026, 11, 6))) {
            window.add(new DailyBar(d, 2_650_000, 0L, 0.02));
        }
        window.add(new DailyBar(LocalDate.of(2026, 11, 9), 53_000, 20_000_000L, 1.0));
        assertThat(window).hasSize(5);   // collector KR_QUOTES_BARS — 스냅샷에 실리는 최근 봉 수

        Assessment fromSnapshot = KrxCorporateActions.assess(LocalDate.of(2026, 11, 9), NOV_02, 10, window, Listing.UNKNOWN);
        assertThat(fromSnapshot.kind()).isEqualTo(Kind.UNPROCESSED);
        assertThat(fromSnapshot.details()).containsExactly(
                "2026-11-09 50:1 분할·병합 신호 — 그 전 관측(거래량 > 0 봉)이 창에 없어 3중 조건을 볼 수 없음");

        List<DailyBar> withLastObservation = new ArrayList<>(window);
        withLastObservation.add(0, p);
        Assessment withP = KrxCorporateActions.assess(LocalDate.of(2026, 11, 9), NOV_02, 10, withLastObservation, Listing.UNKNOWN);
        assertThat(withP.kind()).isEqualTo(Kind.SPLIT);
        assertThat(withP.ratio()).isEqualTo(new Ratio(50, 1));
        assertThat(withP.newQty()).isEqualTo(500);
    }

    @Test
    @DisplayName("거래량을 모르는 봉(null)은 정지로 세지 않는다 — 최근 5봉이 모두 null이면 신호 없음, 정지 봉 뒤에 null이 오면 거기서 멈춤")
    void unknownVolumeIsNotASuspension() {
        List<LocalDate> days = List.of(NOV_03, NOV_04, NOV_05, LocalDate.of(2026, 11, 6), LocalDate.of(2026, 11, 9));
        List<DailyBar> unknown = days.stream().map(d -> new DailyBar(d, 10_000, null, 1.0)).toList();

        Assessment a = KrxCorporateActions.assess(LocalDate.of(2026, 11, 9), NOV_02, 10, unknown, Listing.UNKNOWN);
        assertThat(a.kind()).as("B4 계약 '모르면 null — 0은 정지일': 모름을 신호로 읽지 않음").isEqualTo(Kind.NONE);
        assertThat(a.signals()).isEmpty();

        List<DailyBar> zerosThenUnknown = new ArrayList<>(days.stream().map(d -> new DailyBar(d, 10_000, 0L, 1.0)).toList());
        zerosThenUnknown.add(new DailyBar(LocalDate.of(2026, 11, 10), 10_000, null, 1.0));
        assertThat(KrxCorporateActions.assess(LocalDate.of(2026, 11, 10), NOV_02, 10, zerosThenUnknown, Listing.UNKNOWN)
                .kind()).as("가장 최근 봉의 거래량을 모르면 이어진 정지를 셀 수 없음").isEqualTo(Kind.NONE);
    }

    @Test
    @DisplayName("보유가 없는 종목(주문만 있음)도 판정한다 — 분할이면 그날 주문 보류, 순자산 연속성은 한 주로")
    void noPositionStillHoldsOrders() {
        Assessment a = KrxCorporateActions.assess(MAY_04, APR_27, 0, samsung(APR_27, MAY_04), Listing.UNKNOWN);

        assertThat(a.kind()).isEqualTo(Kind.SPLIT);
        assertThat(a.newQty()).isZero();
        assertThat(a.holdOrders()).isTrue();
        assertThat(KrxCorporateActions.navChange(0, 2_650_000, 51_900, new Ratio(50, 1)))
                .isEqualTo(50.0 * 51_900 / 2_650_000);
    }

    @Test
    @DisplayName("보류 사유: 'yyyy-MM-dd 기업행위 확인 필요 — 근거; 근거', 머리 날짜를 다시 읽음, 500자에서 자름, 미처리가 아니면 거절")
    void holdReason() {
        Assessment a = KrxCorporateActions.assess(NOV_03, NOV_02, 10, List.of(
                new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_03, 6_000, 1L, 1.0)),
                Listing.listed(new ListedShares(NOV_02, 1_000_000), new ListedShares(NOV_03, 1_250_000)));

        String reason = KrxCorporateActions.holdReason(NOV_03, a);
        assertThat(reason).isEqualTo("2026-11-03 기업행위 확인 필요 — 2026-11-03 가격제한폭(±30%) 밖 변동 -40.0%(2026-11-02 10,000 → "
                + "2026-11-03 6,000); 금융위 상장주식수 +25.0%(2026-11-02 1,000,000주 → 2026-11-03 1,250,000주)");
        assertThat(KrxCorporateActions.holdSince(reason)).contains(NOV_03);

        Assessment longOne = new Assessment(Kind.UNPROCESSED, List.of(), null, null, 0, List.of(), List.of("가".repeat(600)));
        String cut = KrxCorporateActions.holdReason(NOV_03, longOne);
        assertThat(cut).hasSize(KrxCorporateActions.HOLD_REASON_MAX).endsWith("…").startsWith("2026-11-03 ");

        assertThat(KrxCorporateActions.holdSince(null)).isEmpty();
        assertThat(KrxCorporateActions.holdSince("가격제한폭 밖 변동 — 확인 필요")).as("날짜 머리 없음").isEmpty();
        assertThat(KrxCorporateActions.holdSince("2026-11")).isEmpty();
        Assessment split = KrxCorporateActions.assess(MAY_04, APR_27, 10, samsung(APR_27, MAY_04), Listing.UNKNOWN);
        assertThatThrownBy(() -> KrxCorporateActions.holdReason(MAY_04, split))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("운영 알림: 보류가 걸린 날은 빼고 5거래일을 넘기면 — 11-02(월)에 걸리면 11-09는 아직, 11-10부터(받은 달력으로 셈)")
    void alertAfterFiveTradingDays() {
        assertThat(KrxCorporateActions.alertDue(WeekdaysCalendar.INSTANCE, NOV_02, LocalDate.of(2026, 11, 9))).isFalse();
        assertThat(KrxCorporateActions.alertDue(WeekdaysCalendar.INSTANCE, NOV_02, LocalDate.of(2026, 11, 10))).isTrue();
        assertThat(KrxCorporateActions.alertDue(WeekdaysCalendar.INSTANCE, NOV_02, NOV_02)).isFalse();
    }

    @Test
    @DisplayName("3중 조건의 경계: 1보다 k에 가까운가(√k 양쪽), 가격제한폭 ±30% 포함, 한국 분할·병합 비율은 k ≥ 2 또는 ≤ 1/2")
    void conditionBoundaries() {
        Ratio fifty = new Ratio(50, 1);
        assertThat(KrxCorporateActions.closerToRatio(51.06, fifty)).isTrue();
        assertThat(KrxCorporateActions.closerToRatio(7.0, fifty)).as("가운데 √50 = 7.07의 1 쪽").isFalse();
        assertThat(KrxCorporateActions.closerToRatio(7.2, fifty)).as("가운데의 k 쪽").isTrue();
        assertThat(KrxCorporateActions.closerToRatio(1.0, new Ratio(2, 1))).isFalse();
        assertThat(KrxCorporateActions.closerToRatio(0.099, new Ratio(1, 10))).isTrue();
        assertThat(KrxCorporateActions.closerToRatio(0.0, fifty)).isFalse();
        assertThat(KrxCorporateActions.closerToRatio(Double.NaN, fifty)).isFalse();

        assertThat(KrxCorporateActions.withinLimit(0.7)).isTrue();
        assertThat(KrxCorporateActions.withinLimit(1.3)).isTrue();
        assertThat(KrxCorporateActions.withinLimit(0.6999)).isFalse();
        assertThat(KrxCorporateActions.withinLimit(1.3001)).isFalse();
        assertThat(KrxCorporateActions.withinLimit(Double.NaN)).isFalse();

        for (Ratio r : List.of(new Ratio(2, 1), new Ratio(5, 2), new Ratio(50, 1), new Ratio(1, 2), new Ratio(1, 10))) {
            assertThat(KrxCorporateActions.faceValueRatio(r)).as(r.label()).isTrue();
        }
        for (Ratio r : List.of(new Ratio(3, 2), new Ratio(6, 5), new Ratio(5, 4), new Ratio(2, 3))) {
            assertThat(KrxCorporateActions.faceValueRatio(r)).as(r.label()).isFalse();
        }
    }

    @Test
    @DisplayName("입력 검사: 수량 음수·같은 날짜 두 봉·종가 0 이하·거래량 음수·비율 0 이하·상장주식수 0·기준일 순서는 거절")
    void rejectsMalformedInput() {
        List<DailyBar> one = List.of(new DailyBar(NOV_02, 10_000, 1L, 1.0));
        assertThatThrownBy(() -> KrxCorporateActions.assess(NOV_02, NOV_02, -1, one, Listing.UNKNOWN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrxCorporateActions.assess(NOV_02, NOV_02, 1, List.of(
                new DailyBar(NOV_02, 10_000, 1L, 1.0), new DailyBar(NOV_02, 10_100, 1L, 1.0)), Listing.UNKNOWN))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("2026-11-02");
        assertThatThrownBy(() -> new DailyBar(NOV_02, 0, 1L, 1.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DailyBar(NOV_02, Double.NaN, 1L, 1.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DailyBar(NOV_02, 10_000, -1L, 1.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DailyBar(NOV_02, 10_000, 1L, 0.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ListedShares(NOV_02, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Listing.listed(new ListedShares(NOV_03, 1), new ListedShares(NOV_02, 1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Listing(null, Presence.UNKNOWN, null, null)).isInstanceOf(NullPointerException.class);
    }

    // ------------------------------------------------------------------ 시험 자료

    /** 토스 실제 응답(삼성전자 2018-04-25~05-10)의 [from, to] 봉 — 원시 종가·원시 거래량, 비율 = 수정 종가 ÷ 원시 종가. */
    private static List<DailyBar> samsung(LocalDate from, LocalDate to) {
        JsonNode root = read("paper/kr-corporate-actions/toss-005930-2018-split.json");
        Map<LocalDate, Double> adjusted = new TreeMap<>();
        for (JsonNode c : root.path("adjusted")) {
            adjusted.put(date(c), Double.parseDouble(c.path("closePrice").asString()));
        }
        Map<LocalDate, DailyBar> out = new TreeMap<>();
        for (JsonNode c : root.path("raw")) {
            LocalDate d = date(c);
            double close = Double.parseDouble(c.path("closePrice").asString());
            if (!d.isBefore(from) && !d.isAfter(to)) {
                out.put(d, new DailyBar(d, close, Long.parseLong(c.path("volume").asString()), adjusted.get(d) / close));
            }
        }
        assertThat(out).as("시험 자료 범위").isNotEmpty();
        return List.copyOf(out.values());
    }

    private static LocalDate date(JsonNode candle) {
        return LocalDate.parse(candle.path("timestamp").asString().substring(0, 10));
    }

    private static List<DailyBar> replace(List<DailyBar> bars, LocalDate date,
                                          UnaryOperator<DailyBar> change) {
        return bars.stream().map(b -> b.date().equals(date) ? change.apply(b) : b).toList();
    }

    private static JsonNode read(String path) {
        try (InputStream in = KrxCorporateActionsTest.class.getClassLoader().getResourceAsStream(path)) {
            if (in == null) {
                throw new IllegalStateException("시험 자료가 없습니다: " + path);
            }
            return MAPPER.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
