package com.macrodash.analytics;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.IntPredicate;

/**
 * 🧪 Claude 재량 책이 제안한 주문의 하드 규칙 검사(명세 C4·C9·C11·D7·D8·D11, 설계 §5-4) — 순수 계산.
 *
 * <p>Claude는 주문을 <b>제안</b>만 하고, 집행 여부는 이 검사기가 정합니다(C4 "제안과 집행 분리"). 주문마다 통과·거절과 사유
 * 코드 하나를 돌려주며, 결과 목록은 입력 목록과 같은 순서·같은 길이입니다. 같은 입력이면 같은 결과입니다 — 맵·집합의 순회 순서가
 * 결과에 끼어들지 않게 합계는 티커 순으로 더하고, 처리 순서는 아래처럼 고정합니다.
 *
 * <p><b>검사 순서</b>(주문 하나에 사유는 하나 — 앞 단계에서 걸리면 뒤는 보지 않음):
 * <ol start="0">
 *   <li>{@link #STALE_INPUT} — {@code inputsStale}(종목 저장본 24시간 초과 또는 확정 종가 전)이면 매도까지 <b>모든</b> 주문.
 *       오래된 가격으로 정한 주문은 어느 것도 믿을 수 없어서입니다.</li>
 * </ol>
 * 1단계 — 주문마다 따로(다른 주문을 보지 않음):
 * <ol>
 *   <li>{@link #MALFORMED} — 주문·티커 없음, side가 BUY/SELL이 아님, timing이 NEXT_OBSERVATION/NEXT_CLOSE가 아님, 매수에
 *       targetWeightPct가 없음·숫자 아님·0~100 밖, 매도 sellFraction이 숫자 아님·0 이하·1 초과, 매도에 sellFraction 없이
 *       targetWeightPct(0 초과)만 있음(아래 "매도 비율"). 그 결정에서 닫힌 시점({@link Market#closed} — 미국 Claude 계좌2: 조기 폐장일
 *       마감 뒤 시각은 {@link #MALFORMED}, 지금 + 60초 안에 지나는 시각은 {@link #LATE_FOR_TIMING})도 이 자리에서 그 사유로 거절합니다.</li>
 *   <li>{@link #DUPLICATE_TICKER} — 같은 티커가 목록 앞에 이미 있음. 같은 종목에 주문이 둘이면 어느 쪽이 뜻인지 모르므로 첫 주문만
 *       보고 뒤의 것은 거절합니다(앞 주문이 거절됐어도 마찬가지 — 결과가 앞 주문의 판정에 따라 바뀌지 않게).</li>
 *   <li>{@link #OUT_OF_UNIVERSE} — 유니버스 밖. 단 <b>보유 중인 종목의 매도</b>는 예외입니다 — 설정에서 유니버스를 줄여도 이미
 *       든 종목에서 빠져나올 수 있어야 해서입니다.</li>
 *   <li>{@link #NOT_HELD}(매도: 보유 없음) / {@link #LOCKED_OUT}(매수: 트레일링 스탑 뒤 재진입 금지 중) → {@link #UNFILLABLE}(매수:
 *       지금 체결할 수 없는 종목 — 한국만, 아래 "한국 칸").</li>
 *   <li>{@link #NO_PRICE} — 가격이 없거나 오래된 티커(매수·매도 모두 — 체결 가격을 정할 수 없음). 한국 정수 주 칸이 있으면 기준 가격이
 *       없는 매수도.</li>
 *   <li>{@link #MIN_HOLD}(매도: 보유 거래일 &lt; 최소 보유일, 보유 거래일을 모르면 거절) → {@link #BELOW_ONE_SHARE}(매도: 아래
 *       "매도 비율"의 1주 미만) / {@link #WEIGHT_CAP}(매수: 목표 비중 &gt; 종목 상한, ETF면 ETF 상한).</li>
 *   <li>{@link #MIN_NOTIONAL}(매수: 증가분 금액 = (목표 − 현재 비중) × 순자산이 최소 금액 미만, 또는 목표가 현재 비중 이하라 살
 *       금액이 없음) → {@link #BUY_BELOW_ONE_SHARE}(매수: 증가분 금액으로 1주도 못 삼 — 한국만, 아래 "한국 칸").</li>
 * </ol>
 * 2단계 — 1단계를 통과한 주문 사이(처리 순서 = <b>매도를 목록 순으로 먼저</b>, 그다음 <b>매수를 목표 비중 큰 순</b>, 같으면 목록 순):
 * <ol start="8">
 *   <li>{@link #MONTHLY_CAP} — 이달 누계 + 이번에 받은 건수가 월 상한 이상. 거절된 주문은 집행되지 않으므로 자리를 쓰지 않습니다.</li>
 *   <li>{@link #MAX_POSITIONS}(매수) — 매도 뒤 남는 종목 + 앞서 받은 신규 매수 + 이 주문이 최대 종목 수 초과. 이미 보유한 종목의
 *       추가 매수는 종목 수를 늘리지 않습니다. 종목 수도 아래 "체결 시점"대로 셉니다 — NEXT_OBSERVATION 신규 매수는 그 시점에 이미
 *       체결된 NEXT_OBSERVATION 전량 매도만 자리를 비운 것으로 봅니다(일반 규칙은 "체결 시점"의 순위).</li>
 *   <li>{@link #OVER_ALLOCATED}(매수) — 매도 뒤 남는 보유 비중 + 앞서 받은 매수 증가분 + 이 주문 증가분이 100% 초과(C11 "큰 비중부터
 *       받고 나머지는 거절"). 넘치는 주문만 거절하므로 그 뒤의 더 작은 매수는 남은 자리에 들어갈 수 있습니다. 합은 아래 "체결
 *       시점"대로 매수가 체결될 때 이미 체결된 매도만으로 셉니다.</li>
 * </ol>
 * 매도를 먼저 처리하는 이유: 매수의 100% 검사가 "매도 뒤 남는 보유"를 쓰므로 어느 매도가 통과했는지가 먼저 정해져야 하고(매수부터
 * 받으면 뒤에 월 상한으로 거절된 매도 때문에 이미 받은 매수가 100%를 넘을 수 있음), 매도는 위험을 줄이고 현금을 만드는 쪽이라
 * 월 상한 자리도 먼저 받는 것이 안전합니다.
 *
 * <p><b>체결 시점</b>: 장부는 NEXT_OBSERVATION 주문을 다음 세션의 첫 관측치에, NEXT_CLOSE 주문을 확정 종가 관측치에 체결하고, 같은
 * 관측치 안에서는 매도를 먼저 체결합니다. 그래서 NEXT_CLOSE 매도는 NEXT_OBSERVATION 매수보다 늦게 체결돼 그 매수의 현금을 만들지
 * 못합니다 — 그대로 통과시키면 매수가 현금 부족으로 줄어든 채(cashLimited) 체결로 끝납니다. 100% 검사는 두 시점에서 봅니다:
 * 확정 종가 뒤(모든 매도 + 모든 매수 증가분)와, NEXT_OBSERVATION 매수면 다음 관측치(NEXT_OBSERVATION 매도만 + 앞서 받은
 * NEXT_OBSERVATION 매수 증가분)도. NEXT_CLOSE 매수는 모든 매도 뒤라 확정 종가 쪽만 봅니다. 최대 종목 수도 같은 두 시점입니다 —
 * NEXT_CLOSE 전량 매도가 비울 자리를 NEXT_OBSERVATION 신규 매수가 먼저 쓰면 그 사이(다음 세션 장중~마감) 상한 + 1종목이 되고, 그 매도가
 * 체결되지 않으면(보유 미확인·만료·다음 결정이 대신함) 그대로 굳습니다.
 *
 * <p>일반 규칙은 <b>시점 순위</b>입니다({@link Market#ranks}, 계좌2 명세 §10-5 — 작을수록 이른 시점, 같은 순위는 같은 때 체결). 매도는 <b>순위가
 * 같거나 늦은</b> 매수에만 현금(비중 합 — {@link #OVER_ALLOCATED})과 종목 자리({@link #MAX_POSITIONS})를 만들고, 두 검사는 마지막 순위(모든
 * 매도가 체결된 뒤 — 미국 확정 종가)를 먼저 본 뒤 그 매수의 순위부터 마지막 앞까지 <b>매수가 있는 순위마다</b>(앞서 받은 매수의 순위와 이 매수의
 * 순위 — 매수가 없는 순위에서는 매도만 체결돼 합이 줄 뿐) 그 순위까지 체결된 매도·매수로 봅니다. 위 두 시점은 순위를 따로 주지 않은 시장의 두
 * 갈래(이른 시점 0·나머지 1 — {@link Market#Market(List, String, Map, Money)})이고, 판정·사유·근거 문구가 순위 전과 글자까지 같습니다.
 * 뒤 순위(앞서 받은 매수가 있는 순위)에서 걸리면 근거 문구의 '그 시점' 자리에 그 순위의 시점 표기를 적습니다(예: '— 12:00(AT_1200) 시점 남는
 * 보유') — 10:00 매수가 12:00 시점 합으로 걸린 것을 10:00 시점으로 읽지 않게. 두 갈래 시장은 늘 그 매수의 순위에서 걸려 '그 시점' 그대로입니다.
 *
 * <p><b>매수 목표 비중</b>: Claude 응답의 매수 {@code targetWeightPct}는 <b>체결 뒤 그 종목의 목표 비중</b>(순자산 대비 %)입니다.
 * 이미 보유한 종목이면 증가분 = 목표 − 현재 비중만 새로 삽니다({@link #buyIncrementPct}). 장부의 매수 주문 targetWeightPct는 "살
 * 금액(체결 시점 순자산 대비 %)"이라 서비스는 목표가 아니라 이 증가분을 주문에 넣어야 목표보다 더 사지 않습니다.
 *
 * <p><b>매도 비율</b>: {@code sellFraction}이 null이면 전량입니다(장부 규칙과 같음). 그래서 sellFraction 없이 targetWeightPct만 준
 * 매도("5%까지 줄여라")를 그대로 넘기면 장부가 전량 매도로 집행합니다 — Claude가 뜻하지 않은 청산이라 MALFORMED로 거절합니다.
 * targetWeightPct가 0이면 "0%까지" = 전량이라 뜻이 같으므로 통과시킵니다. 같은 이유로 1 미만의 비율인데 보유 수량 × 비율이 1주
 * 미만이면({@link #BELOW_ONE_SHARE}) 거절합니다 — 장부는 그런 매도를 '1주 미만이면 전량'으로 집행해(PaperLedger.sellQty, 명세 §3-1)
 * 5% 트림이 전량 청산이 되고, 검증 문구·예상 노출·종목 수도 실제와 어긋납니다. 전량을 뜻하면 sellFraction 1(또는 null)입니다.
 *
 * <p><b>현금성(SHY 등, {@code cashLike})은 현금처럼</b> 다룹니다: 비중 상한이 없고(D8 "SHY 무제한"), 최대 종목 수에 세지 않으며,
 * 최소 보유일을 보지 않습니다 — SHY는 남는 현금의 자리라, 사흘 전에 산 SHY를 팔아 종목을 사는 것은 판단을 뒤집는 매매가 아니고,
 * 막으면 그 매도로 자리를 만들려던 매수까지 OVER_ALLOCATED로 함께 막힙니다. 최소 금액·월 상한·가격 없음·유니버스는 그대로 봅니다.
 *
 * <p><b>검사하지 않는 것(D7)</b>: 현금 비중·주식 노출(0%든 100%든 거절 사유가 아님), 매크로 게이트 조건, 응답의
 * targetEquityExposurePct와 주문의 어긋남(서비스가 exposureMismatch로 기록 — 숫자를 맞추지 않음). 노출은 Claude가 정합니다(C11).
 *
 * <p><b>한국 칸</b>(2단계 명세 §4-7·사용자 결정 v2, E2a): 문맥의 {@code unfillable}·{@code wholeShares}는 한국 Claude 계좌만 채웁니다
 * (미국 문맥은 비워 두어 검사 순서·결과·문구가 이 묶음 전 그대로). {@code unfillable}(종목 → 사유)의 <b>매수</b>는 {@link #UNFILLABLE} —
 * 규칙 계좌의 매수 건너뛰기와 같은 판정(이번 관측치에 봉 없음·기준 거래일 거래정지·미처리 기업행위 보유)이고, 그 종목 보유의 매도는 받습니다
 * (장부가 대기로 두고 풀리면 체결 — 규칙 계좌와 같은 조건). 그 매도는 다음 시가에 체결되지 않으므로 2단계의 비중 합·종목 수에서 <b>자리를
 * 만들지 않습니다</b>(위 "체결 시점"의 늦은 매도와 같은 방식 — 규칙 계좌가 그 매도 대금을 다음 시가 현금 어림에서 빼는 것과 같은 조건, 사용자 결정 v2
 * '같은 조건', 묶음 E 리뷰). 장부는 그런 매도가 비울 자리를 쓴 매수를 현금 부족으로 줄이거나 취소하고 종목 수 상한을 보지 않으므로, 받으면 실제와
 * 어긋납니다. {@code wholeShares}(기준 가격·요율)가 있으면 매수는 정수 주로 체결되므로
 * 증가분 금액으로 살 수 있는 수량({@link KrxCosts#affordableQty} — 장부가 체결 때 쓰는 함수, 수수료·슬리피지 원 미만 절사)이 1주 미만이면
 * {@link #BUY_BELOW_ONE_SHARE}, 기준 가격이 없으면 {@link #NO_PRICE}입니다. 예전에는 장부가 체결 때 '목표 금액으로 1주도 살 수 없습니다'로
 * 취소했습니다 — 검증 때 거절해야 결정 기록에 사유가 남습니다. 매도는 정수 주 칸을 보지 않습니다(1주 미만 부분 매도는 {@link #BELOW_ONE_SHARE}).
 *
 * <p><b>시장</b>(2단계 명세 §9 A7): 검사 계산은 시장 중립이고, 받는 체결 시점·이른 시점·근거 문구의 시점 이름과 금액 표기만
 * 시장이 정합니다({@link Market}). 위 설명의 NEXT_OBSERVATION·NEXT_CLOSE·'$'는 미국 값({@link Market#US})이고, 시장을 받지 않는
 * {@link #validate(List, Context, Limits)}가 그 값으로 검사합니다. 다른 시장에서는 NEXT_OBSERVATION 자리가 그 시장의 이른 시점,
 * NEXT_CLOSE 자리가 나머지 시점입니다(시점 순위를 주면 위 "체결 시점"의 순위대로).
 */
public final class OrderValidator {

    private OrderValidator() {
    }

    /** 주문 방향·시점(설계 §5-3 decision.schema.json, paper_orders CHECK와 같은 문자열). */
    public static final String BUY = "BUY";
    public static final String SELL = "SELL";
    public static final String NEXT_OBSERVATION = "NEXT_OBSERVATION";
    public static final String NEXT_CLOSE = "NEXT_CLOSE";

    /** 거절 사유 코드(설계 §5-4 표) — 결정 기록 {@code response.validation}과 주문 {@code reject_reason}에 그대로 남습니다. */
    public static final String STALE_INPUT = "STALE_INPUT";
    public static final String MALFORMED = "MALFORMED";
    public static final String DUPLICATE_TICKER = "DUPLICATE_TICKER";
    public static final String OUT_OF_UNIVERSE = "OUT_OF_UNIVERSE";
    public static final String NOT_HELD = "NOT_HELD";
    public static final String LOCKED_OUT = "LOCKED_OUT";
    public static final String NO_PRICE = "NO_PRICE";
    public static final String MIN_HOLD = "MIN_HOLD";
    public static final String BELOW_ONE_SHARE = "BELOW_ONE_SHARE";
    public static final String WEIGHT_CAP = "WEIGHT_CAP";
    public static final String MIN_NOTIONAL = "MIN_NOTIONAL";
    public static final String MONTHLY_CAP = "MONTHLY_CAP";
    public static final String MAX_POSITIONS = "MAX_POSITIONS";
    public static final String OVER_ALLOCATED = "OVER_ALLOCATED";
    /** 한국만(클래스 설명의 "한국 칸") — 지금 체결할 수 없는 종목의 매수. */
    public static final String UNFILLABLE = "UNFILLABLE";
    /** 한국만(클래스 설명의 "한국 칸") — 매수 증가분 금액이 1주 체결 금액(수수료·슬리피지 포함)보다 작음. */
    public static final String BUY_BELOW_ONE_SHARE = "BUY_BELOW_ONE_SHARE";
    /**
     * 미국 Claude 계좌2만(계좌2 명세 §6-2·§10-5) — 시각 지정 시점의 기준 시각 T가 주문 생성 + 60초 이전(지난 시각·곧 지날 시각). 마감 뒤 결정은
     * 개장 전 컷오프로 보통 생기지 않습니다. 장부가 체결 때 다시 봅니다(조건 ⑤).
     */
    public static final String LATE_FOR_TIMING = "LATE_FOR_TIMING";
    /**
     * 미국 Claude 계좌2 장중 확인 판만(계좌2 명세 §9-5·§10-5) — 아침 결정의 장중 확인 요청({@code checkpoint})이 시각·감시 목록·피드 규칙에 맞지 않음.
     * 주문이 아니라 요청 칸의 사유라 이 검증기는 내지 않고, 검사는 {@code feature.paper.CheckpointRequest}가 합니다(이 패키지는 java.*만). 아침 주문
     * 판정은 그대로이고 그 세션의 장중 확인 행만 건너뜁니다.
     */
    public static final String CHECKPOINT_INVALID = "CHECKPOINT_INVALID";

    /**
     * 비중(%p) 비교 여유. 비중은 평가액/순자산 × 100이라 끝자리 잡음이 있고(예: 합이 100.00000000000001), Claude가 정확히 상한
     * 10이나 합 100을 주문했는데 그 잡음으로 거절되면 안 됩니다. 1e-9%p는 순자산 10만 달러에서 1백만분의 1달러라 실제로 다른
     * 주문을 가르지 못합니다.
     */
    private static final double WEIGHT_EPSILON = 1e-9;
    /** 금액(장부 통화 — 미국은 달러) 비교 여유 — 0.5% × 100,000처럼 정확히 500달러인 주문이 499.99999999999994로 거절되지 않게. */
    private static final double MONEY_EPSILON = 1e-6;

    /**
     * 근거 문구의 금액 표기 — 앞붙이 + 세 자리마다 쉼표(Locale.ROOT) + 뒷붙이. 정확한 금액(최소 주문 금액 거절 문구)은
     * {@code exactDecimals} 자리, 대략 금액(통과한 매수의 '약 …')은 소수 없이 적습니다.
     *
     * @param prefix        금액 앞 글자(미국 "$"). null 불가
     * @param suffix        금액 뒤 글자(미국 ""). null 불가
     * @param exactDecimals 정확한 금액의 소수 자리(미국 2). 0~6
     */
    public record Money(String prefix, String suffix, int exactDecimals) {

        /** 미국 달러 — 이 묶음 전 문구의 "$%,.2f"·"$%,.0f" 그대로. */
        public static final Money USD = new Money("$", "", 2);

        public Money {
            if (prefix == null || suffix == null) {
                throw new IllegalArgumentException("금액 앞뒤 글자가 없습니다(빈 글자는 \"\")");
            }
            if (exactDecimals < 0 || exactDecimals > 6) {
                throw new IllegalArgumentException("정확한 금액의 소수 자리는 0~6이어야 합니다: " + exactDecimals);
            }
        }

        /** 정확한 금액(예: 미국 $1,234.50). */
        public String exact(double amount) {
            return prefix + String.format(Locale.ROOT, "%,." + exactDecimals + "f", amount) + suffix;
        }

        /** 대략 금액, 소수 없이(예: 미국 $1,235). */
        public String rounded(double amount) {
            return prefix + String.format(Locale.ROOT, "%,.0f", amount) + suffix;
        }
    }

    /**
     * 시장마다 다른 검증기의 체결 시점과 표기(2단계 명세 §9 A7). 검사 계산은 그대로이고 어느 시점 이름을 받는지(MALFORMED), 시점마다
     * 체결 순위(클래스 설명의 "체결 시점" — 매도는 순위가 같거나 늦은 매수의 자리만 만듦, 계좌2 명세 §10-5), 근거 문구에 시점과 금액을
     * 어떻게 적는지만 정합니다. 순위를 따로 주지 않으면 두 갈래(이른 시점 0·나머지 1 — 이른 시점의 매수는 같은 시점 매도만 자리를 만든 것으로
     * 봄, 나머지 시점은 모든 매도 뒤)입니다. 목록·맵은 복사해 둡니다.
     *
     * @param timings     받는 체결 시점(주문의 timing — {@code paper_orders.timing}과 같은 문자열), 이른 것부터. 비어 있거나 겹치면 안 됨
     * @param earlyTiming 이른 시점. {@code timings} 안에 있어야 하고 순위가 가장 작아야 함
     * @param timingNames 시점 → 근거 문구의 이름(미국 NEXT_OBSERVATION → "다음 관측치"). 받는 시점마다 있어야 하고, 그 밖의 항목은 버림
     * @param money       근거 문구의 금액 표기
     * @param ranks       시점 → 체결 순위(0 이상, 작을수록 이른 시점, 같은 순위는 같은 때 체결). 받는 시점마다 있어야 하고, 그 밖의 항목은
     *                    버림. null이면 두 갈래(이른 시점 0·나머지 1)
     * @param closed      받는 시점 가운데 이 결정에서 닫힌 것 → 거절 사유(미국 Claude 계좌2 — 조기 폐장·지난 시각, {@link Closed}). null이면
     *                    없음. 받지 않는 시점을 넣으면 안 됨
     * @throws IllegalArgumentException 위 조건 밖(호출 실수 — 조용히 미국 값으로 바꾸지 않고 막습니다)
     */
    public record Market(List<String> timings, String earlyTiming, Map<String, String> timingNames, Money money,
                         Map<String, Integer> ranks, Map<String, Closed> closed) {

        /** 미국 — 시점 NEXT_OBSERVATION·NEXT_CLOSE(이른 시점 NEXT_OBSERVATION), 달러. 이 묶음 전의 상수·문구 그대로입니다. */
        public static final Market US = new Market(List.of(NEXT_OBSERVATION, NEXT_CLOSE), NEXT_OBSERVATION,
                Map.of(NEXT_OBSERVATION, "다음 관측치", NEXT_CLOSE, "확정 종가"), Money.USD);

        public Market {
            if (timings == null || timings.isEmpty()) {
                throw new IllegalArgumentException("받는 체결 시점이 없습니다");
            }
            if (timingNames == null) {
                throw new IllegalArgumentException("체결 시점 이름이 없습니다");
            }
            if (money == null) {
                throw new IllegalArgumentException("금액 표기가 없습니다");
            }
            Map<String, String> names = new LinkedHashMap<>();
            for (String timing : timings) {
                if (timing == null || timing.isBlank()) {
                    throw new IllegalArgumentException("빈 체결 시점: " + timings);
                }
                String name = timingNames.get(timing);
                if (name == null || name.isBlank()) {
                    throw new IllegalArgumentException("체결 시점 이름이 없습니다: " + timing);
                }
                if (names.put(timing, name) != null) {
                    throw new IllegalArgumentException("겹치는 체결 시점: " + timings);
                }
            }
            if (earlyTiming == null || !names.containsKey(earlyTiming)) {
                throw new IllegalArgumentException("이른 시점이 받는 체결 시점에 없습니다: " + earlyTiming + " ∉ " + timings);
            }
            Map<String, Integer> order = new LinkedHashMap<>();
            for (String timing : names.keySet()) {
                Integer rank = ranks != null ? ranks.get(timing) : Integer.valueOf(timing.equals(earlyTiming) ? 0 : 1);
                if (rank == null || rank < 0) {
                    throw new IllegalArgumentException("체결 시점의 순위가 없거나 음수입니다: " + timing + "=" + rank);
                }
                order.put(timing, rank);
            }
            int earliest = order.get(earlyTiming);
            for (Map.Entry<String, Integer> e : order.entrySet()) {
                if (e.getValue() < earliest) {
                    throw new IllegalArgumentException("이른 시점(" + earlyTiming + ")보다 이른 순위의 시점이 있습니다: " + e);
                }
            }
            Map<String, Closed> shut = new LinkedHashMap<>();
            if (closed != null) {
                for (String timing : names.keySet()) {
                    Closed reason = closed.get(timing);
                    if (reason != null) {
                        shut.put(timing, reason);
                    }
                }
                if (shut.size() != closed.size()) {
                    throw new IllegalArgumentException("닫힌 시점은 받는 체결 시점이어야 합니다: " + closed.keySet() + " ⊄ " + timings);
                }
            }
            timings = List.copyOf(timings);
            timingNames = Collections.unmodifiableMap(names);
            ranks = Collections.unmodifiableMap(order);
            closed = Collections.unmodifiableMap(shut);
        }

        /** 순위를 따로 주지 않은 시장 — 두 갈래(이른 시점 0·나머지 1, 클래스 설명의 "체결 시점"). */
        public Market(List<String> timings, String earlyTiming, Map<String, String> timingNames, Money money) {
            this(timings, earlyTiming, timingNames, money, null, null);
        }

        /** 닫힌 시점이 없는 시장(그 결정의 시각과 상관없이 받는 시점을 모두 받음 — 계좌2 밖의 모든 계좌). */
        public Market(List<String> timings, String earlyTiming, Map<String, String> timingNames, Money money,
                      Map<String, Integer> ranks) {
            this(timings, earlyTiming, timingNames, money, ranks, null);
        }

        /** 같은 시점·이름·표기·닫힌 시점에 체결 순위만 바꾼 시장(Claude 계좌 프로필의 시점 순위 — 계좌2 명세 §10-5). */
        public Market withRanks(Map<String, Integer> ranks) {
            return new Market(timings, earlyTiming, timingNames, money, ranks, closed);
        }

        /** 같은 시장에 그 결정에서 닫힌 시점만 바꾼 것(미국 Claude 계좌2 — 결정 파이프라인이 기준 거래일·지금으로 정함). */
        public Market withClosed(Map<String, Closed> closed) {
            return new Market(timings, earlyTiming, timingNames, money, ranks, closed);
        }

        /** 받는 체결 시점인가(null이면 아님). */
        boolean accepts(String timing) {
            return timing != null && timingNames.containsKey(timing);
        }

        /** 받는 시점의 체결 순위. */
        int rank(String timing) {
            return ranks.get(timing);
        }

        /** 근거 문구의 시점 표기 — 이름(시점), 예: 다음 관측치(NEXT_OBSERVATION). */
        String label(String timing) {
            return timingNames.get(timing) + "(" + timing + ")";
        }

        /** 이른 시점보다 늦은 순위의 시점들의 표기(받는 순서, 둘 이상이면 '·'로 이음) — 미국은 확정 종가(NEXT_CLOSE). */
        String lateLabel() {
            return laterLabel(rank(earlyTiming));
        }

        /** 그 순위보다 늦은 시점들의 표기(받는 순서, 둘 이상이면 '·'로 이음, 없으면 빈 글자). */
        String laterLabel(int rank) {
            List<String> labels = new ArrayList<>();
            for (String timing : timings) {
                if (rank(timing) > rank) {
                    labels.add(label(timing));
                }
            }
            return String.join("·", labels);
        }

        /** 그 순위 시점들의 표기(받는 순서, 둘 이상이면 '·'로 이음) — 계좌2의 12:00 순위면 다음 세션 12:00(AT_1200). */
        String labelsAt(int rank) {
            List<String> labels = new ArrayList<>();
            for (String timing : timings) {
                if (rank(timing) == rank) {
                    labels.add(label(timing));
                }
            }
            return String.join("·", labels);
        }

        /** 그 순위까지(같은 순위 포함) 시점들의 이름(받는 순서, 둘 이상이면 '·'로 이음) — 두 갈래 순위 0이면 이른 시점의 이름. */
        String namesUpTo(int rank) {
            List<String> out = new ArrayList<>();
            for (String timing : timings) {
                if (rank(timing) <= rank) {
                    out.add(timingNames.get(timing));
                }
            }
            return String.join("·", out);
        }

        /** 받는 시점들의 순위(겹치지 않게, 작은 것부터). */
        int[] distinctRanks() {
            return new TreeSet<>(ranks.values()).stream().mapToInt(Integer::intValue).toArray();
        }
    }

    /**
     * 그 결정에서 닫힌 체결 시점의 거절({@link Market#closed}) — 사유 코드({@link #MALFORMED}: 조기 폐장일 마감 뒤 시각 · {@link #LATE_FOR_TIMING}:
     * 지금 + 60초 안에 지나는 시각)와 근거 문구.
     *
     * @throws IllegalArgumentException 사유가 둘 밖이거나 문구가 비었음
     */
    public record Closed(String reason, String detail) {
        public Closed {
            if (!MALFORMED.equals(reason) && !LATE_FOR_TIMING.equals(reason)) {
                throw new IllegalArgumentException("닫힌 시점의 사유는 MALFORMED · LATE_FOR_TIMING입니다: " + reason);
            }
            if (detail == null || detail.isBlank()) {
                throw new IllegalArgumentException("닫힌 시점의 근거 문구가 없습니다");
            }
        }
    }

    /**
     * 정수 주 매수의 재료(클래스 설명의 "한국 칸") — 종목마다 1주 체결 금액을 셀 기준 가격과 체결 비용 요율.
     *
     * @param prices 종목 → 기준 가격(원 — 결정이 본 관측치의 기준 거래일 종가, 패킷 8_prices와 같은 값). 없거나 0 이하이면 그 종목 매수는
     *               {@link #NO_PRICE}. 복사해 둡니다
     * @param rates  체결 비용 요율(장부가 체결 때 쓰는 판 — 수수료·슬리피지)
     * @throws IllegalArgumentException 요율이 없음
     */
    public record WholeShares(Map<String, BigDecimal> prices, KrxCosts.Rates rates) {
        public WholeShares {
            if (rates == null) {
                throw new IllegalArgumentException("정수 주 검사의 체결 비용 요율이 없습니다");
            }
            prices = copy(prices);
        }

        /** 기준 가격(0보다 큰 값만). 없으면 null. */
        BigDecimal price(String ticker) {
            BigDecimal price = prices.get(ticker);
            return price != null && price.signum() > 0 ? price : null;
        }
    }

    /**
     * Claude가 제안한 주문 한 줄(decision.schema.json의 orders[] 중 검사에 쓰는 필드).
     *
     * @param targetWeightPct 매수: 체결 뒤 목표 비중(순자산 대비 %, 0~100). 매도에는 쓰지 않음(클래스 설명의 "매도 비율")
     * @param sellFraction    매도: 보유 중 팔 비율(0 초과 1 이하). null이면 전량. 매수에는 쓰지 않음
     * @param timing          체결 시점 — 시장이 받는 것({@link Market#timings}, 미국 NEXT_OBSERVATION · NEXT_CLOSE)
     */
    public record Proposed(String ticker, String side, Double targetWeightPct, Double sellFraction, String timing) {
    }

    /**
     * 검사 시점의 장부와 자료 상태. 집합·맵은 복사해 두므로 호출한 쪽이 나중에 고쳐도 결과가 바뀌지 않습니다.
     *
     * @param nav                순자산(달러). 0 초과 — 최소 금액 검사가 증가분 비중을 금액으로 바꿀 때 씁니다
     * @param cash               현금(달러). <b>검사에는 쓰지 않습니다</b> — 현금 비중은 하드 규칙이 아니고(D7), 100% 검사는 보유
     *                           비중으로 합니다. 거절 문구에 현금 비중을 함께 보이는 데만 씁니다
     * @param currentWeightPct   티커 → 현재 비중(평가액/순자산 × 100, 현금성 포함). 값이 null·숫자 아님·0 이하인 항목은 보유가
     *                           아닌 것으로 봅니다. null이면 보유 없음
     * @param heldTradingDays    티커 → 보유 거래일(최소 보유일 검사). null이면 없음
     * @param universe           살 수 있는 티커. null이면 호출 실수로 보고 막습니다(조용히 "전부 유니버스 밖"이 되지 않게)
     * @param etfs               ETF 티커(ETF 상한). null이면 없음
     * @param cashLike           현금성 티커(기본 SHY — 상한·종목 수·최소 보유일 제외). null이면 없음
     * @param lockedOut          재진입 금지 중인 티커. null이면 없음
     * @param noPrice            가격이 없거나 오래된 티커. null이면 없음
     * @param monthlyOrdersSoFar 이달(미국 거래일 기준 달) 이미 받은 재량 주문 수. 0 이상
     * @param inputsStale        종목 저장본 24시간 초과 또는 확정 종가 전(blockWhenNotFinal) — true면 전부 STALE_INPUT
     * @param heldQty            티커 → 보유 수량(주, 1주 미만 매도 검사 — 클래스 설명의 "매도 비율"). null이거나 그 티커가 없으면(또는 0
     *                           이하) 수량을 모르는 것으로 보고 그 검사를 하지 않습니다
     * @param unfillable         티커 → 지금 체결할 수 없는 사유(한국만 — 클래스 설명의 "한국 칸"). null이면 없음(미국)
     * @param wholeShares        정수 주 매수 검사의 재료(한국만). null이면 그 검사를 하지 않음(미국)
     */
    public record Context(double nav, double cash, Map<String, Double> currentWeightPct,
                          Map<String, Integer> heldTradingDays, Set<String> universe, Set<String> etfs,
                          Set<String> cashLike, Set<String> lockedOut, Set<String> noPrice, int monthlyOrdersSoFar,
                          boolean inputsStale, Map<String, Integer> heldQty, Map<String, String> unfillable,
                          WholeShares wholeShares) {
        public Context {
            if (!(nav > 0) || Double.isInfinite(nav)) {
                throw new IllegalArgumentException("순자산은 0보다 큰 숫자여야 합니다: " + nav);
            }
            if (!Double.isFinite(cash)) {
                throw new IllegalArgumentException("현금이 숫자가 아닙니다: " + cash);
            }
            if (universe == null) {
                throw new IllegalArgumentException("유니버스가 없습니다");
            }
            if (monthlyOrdersSoFar < 0) {
                throw new IllegalArgumentException("이달 주문 수는 0 이상이어야 합니다: " + monthlyOrdersSoFar);
            }
            currentWeightPct = copy(currentWeightPct);
            heldTradingDays = copy(heldTradingDays);
            universe = copy(universe);
            etfs = copy(etfs);
            cashLike = copy(cashLike);
            lockedOut = copy(lockedOut);
            noPrice = copy(noPrice);
            heldQty = copy(heldQty);
            unfillable = copy(unfillable);
        }

        /** 한국 칸 없이(미국 — 클래스 설명의 "한국 칸"). */
        public Context(double nav, double cash, Map<String, Double> currentWeightPct,
                       Map<String, Integer> heldTradingDays, Set<String> universe, Set<String> etfs,
                       Set<String> cashLike, Set<String> lockedOut, Set<String> noPrice, int monthlyOrdersSoFar,
                       boolean inputsStale, Map<String, Integer> heldQty) {
            this(nav, cash, currentWeightPct, heldTradingDays, universe, etfs, cashLike, lockedOut, noPrice,
                    monthlyOrdersSoFar, inputsStale, heldQty, null, null);
        }

        /** 보유 수량 없이(1주 미만 매도 검사를 하지 않음 — 수량을 모르는 호출·시험). */
        public Context(double nav, double cash, Map<String, Double> currentWeightPct,
                       Map<String, Integer> heldTradingDays, Set<String> universe, Set<String> etfs,
                       Set<String> cashLike, Set<String> lockedOut, Set<String> noPrice, int monthlyOrdersSoFar,
                       boolean inputsStale) {
            this(nav, cash, currentWeightPct, heldTradingDays, universe, etfs, cashLike, lockedOut, noPrice,
                    monthlyOrdersSoFar, inputsStale, null);
        }

        /** 보유 비중(%). 보유가 아니면(없음·null·숫자 아님·0 이하) null. */
        Double weightOf(String ticker) {
            Double weight = currentWeightPct.get(ticker);
            return weight != null && Double.isFinite(weight) && weight > 0 ? weight : null;
        }
    }

    /**
     * 하드 규칙 한도(설정 §4-4 — maxWeightStockPct 10, maxWeightEtfPct 20, maxPositions 20, minOrderNotional 500,
     * maxDiscretionaryOrdersPerMonth 20, minHoldTradingDaysForSell 5가 기본).
     *
     * @param maxWeightStockPct              개별 종목 목표 비중 상한(%). 0 초과 100 이하
     * @param maxWeightEtfPct                ETF 목표 비중 상한(%). 0 초과 100 이하
     * @param maxPositions                   매수 뒤 최대 종목 수(현금성 제외). 1 이상
     * @param minOrderNotional               매수 증가분의 최소 금액(달러). 0 이상 — 0이면 금액 하한 없음(살 금액이 0 이하인 매수는 그래도 거절)
     * @param maxDiscretionaryOrdersPerMonth 월 재량 주문 상한. 0 이상 — 0이면 재량 주문을 받지 않음
     * @param minHoldTradingDaysForSell      재량 매도 전 최소 보유 거래일. 0 이상 — 0이면 검사 안 함
     * @throws IllegalArgumentException 범위 밖(설정 실수 — 조용히 기본값으로 바꾸지 않고 막습니다)
     */
    public record Limits(double maxWeightStockPct, double maxWeightEtfPct, int maxPositions, double minOrderNotional,
                         int maxDiscretionaryOrdersPerMonth, int minHoldTradingDaysForSell) {
        public Limits {
            if (!(maxWeightStockPct > 0) || maxWeightStockPct > 100) {
                throw new IllegalArgumentException("종목 상한(%)은 0 초과 100 이하여야 합니다: " + maxWeightStockPct);
            }
            if (!(maxWeightEtfPct > 0) || maxWeightEtfPct > 100) {
                throw new IllegalArgumentException("ETF 상한(%)은 0 초과 100 이하여야 합니다: " + maxWeightEtfPct);
            }
            if (maxPositions < 1) {
                throw new IllegalArgumentException("최대 종목 수는 1 이상이어야 합니다: " + maxPositions);
            }
            if (!(minOrderNotional >= 0) || Double.isInfinite(minOrderNotional)) {
                throw new IllegalArgumentException("최소 주문 금액은 0 이상인 숫자여야 합니다: " + minOrderNotional);
            }
            if (maxDiscretionaryOrdersPerMonth < 0) {
                throw new IllegalArgumentException("월 주문 상한은 0 이상이어야 합니다: " + maxDiscretionaryOrdersPerMonth);
            }
            if (minHoldTradingDaysForSell < 0) {
                throw new IllegalArgumentException("최소 보유일은 0 이상이어야 합니다: " + minHoldTradingDaysForSell);
            }
        }
    }

    /**
     * 주문 하나의 판정.
     *
     * @param order        입력 주문 그대로(null 주문이면 null)
     * @param rejectReason 거절 사유 코드. 통과면 null
     * @param detail       사람이 읽는 근거 한 줄(통과: 현재 → 목표·금액 또는 매도 비율, 거절: 걸린 숫자)
     */
    public record Verdict(Proposed order, boolean accepted, String rejectReason, String detail) {

        static Verdict accept(Proposed order, String detail) {
            return new Verdict(order, true, null, detail);
        }

        static Verdict reject(Proposed order, String reason, String detail) {
            return new Verdict(order, false, reason, detail);
        }
    }

    /**
     * 주문 목록을 미국 시장의 체결 시점·표기로 판정합니다({@link #validate(List, Context, Limits, Market)}에 {@link Market#US}).
     *
     * @param orders 제안 주문(응답 순서). null·빈 목록이면 빈 결과. 원소가 null이면 그 자리는 MALFORMED
     * @return 입력과 같은 순서·같은 길이의 판정(바꿀 수 없는 목록)
     * @throws IllegalArgumentException ctx·limits가 null
     */
    public static List<Verdict> validate(List<Proposed> orders, Context ctx, Limits limits) {
        return validate(orders, ctx, limits, Market.US);
    }

    /**
     * 주문 목록을 하드 규칙으로 판정합니다(검사 순서는 클래스 설명).
     *
     * @param orders 제안 주문(응답 순서). null·빈 목록이면 빈 결과. 원소가 null이면 그 자리는 MALFORMED
     * @param market 받는 체결 시점·이른 시점·근거 문구의 시점 이름과 금액 표기(클래스 설명의 "시장")
     * @return 입력과 같은 순서·같은 길이의 판정(바꿀 수 없는 목록)
     * @throws IllegalArgumentException ctx·limits·market이 null
     */
    public static List<Verdict> validate(List<Proposed> orders, Context ctx, Limits limits, Market market) {
        if (ctx == null) {
            throw new IllegalArgumentException("검사 문맥(장부 상태)이 없습니다");
        }
        if (limits == null) {
            throw new IllegalArgumentException("하드 규칙 한도가 없습니다");
        }
        if (market == null) {
            throw new IllegalArgumentException("검증기의 시장(체결 시점·표기)이 없습니다");
        }
        if (orders == null || orders.isEmpty()) {
            return List.of();
        }
        int n = orders.size();
        Verdict[] out = new Verdict[n];

        // 0) 자료가 오래됐으면 그날 재량 주문 전부(매도 포함).
        if (ctx.inputsStale()) {
            for (int i = 0; i < n; i++) {
                out[i] = Verdict.reject(orders.get(i), STALE_INPUT,
                        "입력 자료가 오래됨(종목 저장본 24시간 초과 또는 확정 종가 전) — 그날 재량 주문 전부 거절");
            }
            return List.of(out);
        }

        // 1) 주문마다 따로. null로 남은 자리가 2단계 후보입니다.
        Map<String, Integer> firstIndex = new HashMap<>();
        for (int i = 0; i < n; i++) {
            out[i] = checkAlone(orders.get(i), i, firstIndex, ctx, limits, market);
        }

        // 2-a) 매도 — 목록 순으로 월 상한 자리를 먼저 받습니다(클래스 설명).
        int slots = Math.max(0, limits.maxDiscretionaryOrdersPerMonth() - ctx.monthlyOrdersSoFar());
        int used = 0;
        // 받은 매도의 비율과 체결 순위(티커마다 하나 — 같은 티커 두 번은 1단계가 거절). 매도는 순위가 같거나 늦은 매수의 자리만 만듭니다
        // (클래스 설명의 "체결 시점").
        Map<String, Double> soldFraction = new HashMap<>();
        Map<String, Integer> soldRank = new HashMap<>();
        // 받았지만 지금 체결할 수 없어 자리를 만들지 않는 매도(한국 칸 — 거절 문구용): 그 비중(%p)과 전량 매도 종목 수.
        double blockedFreedPct = 0;
        int blockedPositions = 0;
        List<Integer> buys = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            if (out[i] != null) {
                continue;
            }
            Proposed order = orders.get(i);
            if (BUY.equals(order.side())) {
                buys.add(i);
                continue;
            }
            if (used >= slots) {
                out[i] = Verdict.reject(order, MONTHLY_CAP, monthlyDetail(ctx, limits, used));
                continue;
            }
            used++;
            double fraction = order.sellFraction() == null ? 1.0 : Math.min(1.0, order.sellFraction());
            if (ctx.unfillable().containsKey(order.ticker())) {
                // 한국 칸 — 지금 체결할 수 없는 보유의 매도는 받아 대기로 두지만 그 시점에 체결되지 않으므로 같은 시점 매수의 현금·종목
                // 자리를 만들지 않습니다(클래스 설명의 "한국 칸" — 규칙 계좌가 그 매도 대금을 현금 어림에서 빼는 것과 같은 조건).
                Double weight = ctx.weightOf(order.ticker());
                blockedFreedPct += weight == null ? 0.0 : weight * fraction;
                if (fraction >= 1.0 && !ctx.cashLike().contains(order.ticker())) {
                    blockedPositions++;
                }
                out[i] = Verdict.accept(order, sellDetail(weight, fraction) + UNFILLABLE_SELL_NOTE);
                continue;
            }
            soldFraction.put(order.ticker(), fraction);
            soldRank.put(order.ticker(), market.rank(order.timing()));
            out[i] = Verdict.accept(order, sellDetail(ctx.weightOf(order.ticker()), fraction));
        }

        // 순위마다(작은 것부터) 그 순위까지 체결된 매도 뒤 남는 보유 비중과 종목 수 — 티커 순으로 더해 맵 순회 순서와 관계없이 같은 합.
        // 마지막 순위 = 모든 매도가 체결된 뒤(미국 확정 종가), 두 갈래 시장이면 순위 0 = 이른 시점(그 시점 매도만 체결 — 클래스 설명의 "체결 시점").
        int[] ranks = market.distinctRanks();
        int last = ranks.length - 1;
        double[] residual = new double[ranks.length];
        int[] positions = new int[ranks.length];
        int[] laterFreed = new int[ranks.length];   // 그 순위 뒤의 전량 매도로만 비는 자리(거절 문구용)
        for (String ticker : heldTickers(ctx)) {
            double weight = ctx.weightOf(ticker);
            double fraction = soldFraction.getOrDefault(ticker, 0.0);
            Integer soldAt = soldRank.get(ticker);
            for (int k = 0; k < ranks.length; k++) {
                double done = soldAt != null && soldAt <= ranks[k] ? fraction : 0.0;
                residual[k] += weight * (1.0 - done);
                if (!ctx.cashLike().contains(ticker) && done < 1.0) {
                    positions[k]++;
                    if (fraction >= 1.0) {
                        laterFreed[k]++;
                    }
                }
            }
        }
        double[] allocated = residual.clone();
        boolean[] bought = new boolean[ranks.length];   // 앞서 받은 매수가 있는 순위
        double cashPct = ctx.cash() / ctx.nav() * 100.0;

        // 2-b) 매수 — 목표 비중 큰 순(C11), 같으면 목록 순.
        buys.sort((a, b) -> {
            int byTarget = Double.compare(orders.get(b).targetWeightPct(), orders.get(a).targetWeightPct());
            return byTarget != 0 ? byTarget : Integer.compare(a, b);
        });
        for (int i : buys) {
            Proposed order = orders.get(i);
            String ticker = order.ticker();
            Double current = ctx.weightOf(ticker);
            double increment = buyIncrementPct(order, ctx);
            boolean newName = current == null && !ctx.cashLike().contains(ticker);
            int at = Arrays.binarySearch(ranks, market.rank(order.timing()));
            // 마지막 순위 앞에서 걸리는 순위(이 매수의 순위부터, 매수가 있는 순위마다 — 클래스 설명의 "체결 시점"). 없으면 −1.
            int crowded = newName ? firstBreach(at, last, bought, k -> positions[k] + 1 > limits.maxPositions()) : -1;
            int overfull = firstBreach(at, last, bought, k -> allocated[k] + increment > 100.0 + WEIGHT_EPSILON);
            if (used >= slots) {
                out[i] = Verdict.reject(order, MONTHLY_CAP, monthlyDetail(ctx, limits, used));
            } else if (newName && positions[last] + 1 > limits.maxPositions()) {
                out[i] = Verdict.reject(order, MAX_POSITIONS, String.format(Locale.ROOT,
                        "매수 뒤 종목 수 %d > 상한 %d(현금성 제외)", positions[last] + 1, limits.maxPositions())
                        + blockedPositionsNote(blockedPositions));
            } else if (crowded >= 0) {
                out[i] = Verdict.reject(order, MAX_POSITIONS, String.format(Locale.ROOT,
                        "%s 매수인데 %s 전량 매도 %d종목은 그 뒤에 체결돼 자리를 "
                                + "비우지 못함 — %s 종목 수 %d > 상한 %d(현금성 제외)",
                        market.label(order.timing()), market.laterLabel(ranks[crowded]), laterFreed[crowded],
                        breachPoint(market, ranks, crowded, at), positions[crowded] + 1, limits.maxPositions())
                        + blockedPositionsNote(blockedPositions));
            } else if (allocated[last] + increment > 100.0 + WEIGHT_EPSILON) {
                out[i] = Verdict.reject(order, OVER_ALLOCATED, String.format(Locale.ROOT,
                        "매도 뒤 남는 보유 %.2f%% + 앞서 받은 매수 %.2f%%p + 이 주문 %.2f%%p = %.2f%% > 100%% (현재 현금 %.2f%%)",
                        residual[last], allocated[last] - residual[last], increment, allocated[last] + increment,
                        cashPct) + blockedFreedNote(blockedFreedPct));
            } else if (overfull >= 0) {
                out[i] = Verdict.reject(order, OVER_ALLOCATED, String.format(Locale.ROOT,
                        "%s 매수인데 %s 매도 %.2f%%p는 그 뒤에 체결돼 자리를 만들지 "
                                + "못함 — %s 남는 보유 %.2f%% + 앞서 받은 %s 매수 %.2f%%p + 이 주문 %.2f%%p = %.2f%% "
                                + "> 100%% (현재 현금 %.2f%%)",
                        market.label(order.timing()), market.laterLabel(ranks[overfull]),
                        residual[overfull] - residual[last], breachPoint(market, ranks, overfull, at), residual[overfull],
                        market.namesUpTo(ranks[overfull]),
                        allocated[overfull] - residual[overfull], increment, allocated[overfull] + increment, cashPct)
                        + blockedFreedNote(blockedFreedPct));
            } else {
                used++;
                // 받은 매수는 그 순위부터 끝까지 남습니다 — 그 뒤 순위의 비중 합·종목 수에 모두 더합니다.
                for (int k = at; k < ranks.length; k++) {
                    allocated[k] += increment;
                    if (newName) {
                        positions[k]++;
                    }
                }
                bought[at] = true;
                out[i] = Verdict.accept(order, buyDetail(current, order.targetWeightPct(), increment, ctx.nav(),
                        market.money()));
            }
        }
        return List.of(out);
    }

    /**
     * 매수 증가분(%p) = 목표 비중 − 현재 비중(보유 아니면 0). 통과한 매수는 늘 0보다 큽니다(MIN_NOTIONAL이 0 이하를 거절).
     * 장부에 낼 매수 주문의 targetWeightPct("살 금액" — 순자산 대비 %)는 이 값입니다(클래스 설명의 "매수 목표 비중").
     *
     * @throws IllegalArgumentException 매수가 아니거나 targetWeightPct가 없음·숫자 아님, ctx가 null
     */
    public static double buyIncrementPct(Proposed order, Context ctx) {
        if (order == null || !BUY.equals(order.side()) || order.targetWeightPct() == null
                || !Double.isFinite(order.targetWeightPct())) {
            throw new IllegalArgumentException("목표 비중이 있는 매수 주문이 아닙니다: " + order);
        }
        if (ctx == null) {
            throw new IllegalArgumentException("검사 문맥(장부 상태)이 없습니다");
        }
        Double current = ctx.weightOf(order.ticker());
        return order.targetWeightPct() - (current == null ? 0.0 : current);
    }

    /**
     * 시점 거절 문구의 시점 — 걸린 순위가 그 매수의 순위({@code at})면 '그 시점', 뒤 순위(앞서 받은 매수가 있는 순위)면 그 순위의 시점 표기 +
     * ' 시점'(예: '다음 세션 12:00(AT_1200) 시점'). 두 갈래 시장은 늘 그 매수의 순위에서 걸립니다(클래스 설명의 "체결 시점").
     */
    private static String breachPoint(Market market, int[] ranks, int breached, int at) {
        return breached == at ? "그 시점" : market.labelsAt(ranks[breached]) + " 시점";
    }

    /**
     * 매수 순위 자리 {@code at}부터 마지막 순위 앞까지, 매수가 있는 순위(이 매수 자신의 순위와 앞서 받은 매수의 순위 — {@code bought}) 가운데
     * 처음 {@code breached}에 걸리는 순위의 자리. 없으면 −1. 매수가 없는 순위에서는 매도만 체결돼 비중 합·종목 수가 줄 뿐이라 따로 보지 않습니다.
     */
    private static int firstBreach(int at, int last, boolean[] bought, IntPredicate breached) {
        for (int k = at; k < last; k++) {
            if ((k == at || bought[k]) && breached.test(k)) {
                return k;
            }
        }
        return -1;
    }

    /** 1단계 — 다른 주문을 보지 않는 검사. 통과면 null. firstIndex에 티커의 첫 자리를 남깁니다. */
    private static Verdict checkAlone(Proposed order, int index, Map<String, Integer> firstIndex, Context ctx,
                                      Limits limits, Market market) {
        if (order == null) {
            return Verdict.reject(null, MALFORMED, "주문이 비어 있음");
        }
        String ticker = order.ticker();
        if (ticker == null || ticker.isBlank()) {
            return Verdict.reject(order, MALFORMED, "티커가 없음");
        }
        // 모양이 틀린 주문도 티커 자리는 잡습니다 — 같은 티커의 뒤 주문이 앞 주문의 판정에 따라 통과·거절이 갈리지 않게.
        Integer earlier = firstIndex.putIfAbsent(ticker, index);
        String malformed = malformed(order, market);
        if (malformed != null) {
            return Verdict.reject(order, MALFORMED, malformed);
        }
        Closed closed = market.closed().get(order.timing());
        if (closed != null) {
            return Verdict.reject(order, closed.reason(), closed.detail());   // 계좌2 — 그 결정에서 닫힌 시점
        }
        if (earlier != null) {
            return Verdict.reject(order, DUPLICATE_TICKER,
                    "같은 티커의 앞선 주문(" + (earlier + 1) + "번째)이 있음 — 첫 주문만 봄");
        }
        boolean buy = BUY.equals(order.side());
        Double current = ctx.weightOf(ticker);
        if (!ctx.universe().contains(ticker) && (buy || current == null)) {
            return Verdict.reject(order, OUT_OF_UNIVERSE, "유니버스 밖 티커: " + ticker);
        }
        if (buy && ctx.lockedOut().contains(ticker)) {
            return Verdict.reject(order, LOCKED_OUT, "트레일링 스탑 뒤 재진입 금지 중");
        }
        if (!buy && current == null) {
            return Verdict.reject(order, NOT_HELD, "보유하지 않은 종목은 팔 수 없음");
        }
        String unfillable = buy ? ctx.unfillable().get(ticker) : null;
        if (unfillable != null) {
            return Verdict.reject(order, UNFILLABLE, "지금 체결할 수 없는 종목 — " + unfillable
                    + " · 매수만 거절(보유 매도는 받음)");
        }
        if (ctx.noPrice().contains(ticker)) {
            return Verdict.reject(order, NO_PRICE, "가격이 없거나 오래됨 — 체결 가격을 정할 수 없음");
        }
        if (buy && ctx.wholeShares() != null && ctx.wholeShares().price(ticker) == null) {
            return Verdict.reject(order, NO_PRICE, "기준 가격이 없음 — 정수 주로 살 1주 체결 금액을 정할 수 없음");
        }
        boolean cashLike = ctx.cashLike().contains(ticker);
        if (!buy) {
            int minHold = limits.minHoldTradingDaysForSell();
            if (minHold > 0 && !cashLike) {
                Integer days = ctx.heldTradingDays().get(ticker);
                if (days == null) {
                    // 모르는 보유일을 '충분함'으로 읽으면 과매매 억제(C9)가 조용히 꺼집니다 — 거절하고 이유를 남깁니다.
                    return Verdict.reject(order, MIN_HOLD, "보유 거래일을 알 수 없음 — 최소 " + minHold + "거래일 확인 불가");
                }
                if (days < minHold) {
                    return Verdict.reject(order, MIN_HOLD, "보유 " + days + "거래일 < 최소 " + minHold + "거래일");
                }
            }
            Double fraction = order.sellFraction();
            Integer held = ctx.heldQty().get(ticker);
            // 장부와 같은 계산(PaperLedger.sellQty) — 1 미만의 비율인데 1주 미만이면 장부가 보유 전체를 팝니다(클래스 설명의 "매도 비율").
            if (fraction != null && fraction < 1.0 && held != null && held > 0
                    && PaperLedger.sellQty(held, fraction) >= held) {
                return Verdict.reject(order, BELOW_ONE_SHARE, "보유 " + held + "주의 "
                        + BigDecimal.valueOf(fraction).stripTrailingZeros().toPlainString()
                        + "는 1주 미만 — 장부가 전량으로 집행하므로 거절, 전량이면 sellFraction 1");
            }
            return null;
        }
        double target = order.targetWeightPct();
        if (!cashLike) {
            boolean etf = ctx.etfs().contains(ticker);
            double cap = etf ? limits.maxWeightEtfPct() : limits.maxWeightStockPct();
            if (target > cap + WEIGHT_EPSILON) {
                return Verdict.reject(order, WEIGHT_CAP, String.format(Locale.ROOT, "목표 %.2f%% > %s 상한 %.2f%%",
                        target, etf ? "ETF" : "종목", cap));
            }
        }
        double now = current == null ? 0.0 : current;
        double increment = target - now;
        if (!(increment > WEIGHT_EPSILON)) {
            return Verdict.reject(order, MIN_NOTIONAL, String.format(Locale.ROOT,
                    "목표 비중이 현재 비중 이하 — 살 금액 없음(현재 %.2f%% → 목표 %.2f%%)", now, target));
        }
        double amount = increment / 100.0 * ctx.nav();
        if (amount < limits.minOrderNotional() - MONEY_EPSILON) {
            return Verdict.reject(order, MIN_NOTIONAL, String.format(Locale.ROOT,
                    "매수 증가분 약 %s < 최소 %s(현재 %.2f%% → 목표 %.2f%%)", market.money().exact(amount),
                    market.money().exact(limits.minOrderNotional()), now, target));
        }
        WholeShares shares = ctx.wholeShares();
        if (shares != null) {
            BigDecimal price = shares.price(ticker);
            // 장부가 체결 때 쓰는 것과 같은 함수(PaperLedgerService — 목표 금액으로 살 수 있는 수량, 비용 원 미만 절사)로 셉니다.
            if (KrxCosts.affordableQty(BigDecimal.valueOf(amount), price, shares.rates()) < 1) {
                return Verdict.reject(order, BUY_BELOW_ONE_SHARE, String.format(Locale.ROOT,
                        "매수 증가분 약 %s < 1주 체결 금액 %s(기준 가격 %s + 수수료·슬리피지) — 정수 주라 1주도 살 수 없음"
                                + "(현재 %.2f%% → 목표 %.2f%%)", market.money().exact(amount),
                        market.money().exact(KrxCosts.oneShareOutflow(price, shares.rates()).doubleValue()),
                        market.money().exact(price.doubleValue()), now, target));
            }
        }
        return null;
    }

    /** MALFORMED 사유 문구. 모양이 맞으면 null. */
    private static String malformed(Proposed order, Market market) {
        String side = order.side();
        if (!BUY.equals(side) && !SELL.equals(side)) {
            return "side는 BUY 또는 SELL이어야 함: " + side;
        }
        String timing = order.timing();
        if (!market.accepts(timing)) {
            return "timing은 " + String.join(" 또는 ", market.timings()) + "여야 함: " + timing;
        }
        Double target = order.targetWeightPct();
        if (BUY.equals(side)) {
            if (target == null) {
                return "매수에 targetWeightPct가 없음";
            }
            if (!Double.isFinite(target) || target < 0 || target > 100) {
                return "targetWeightPct는 0~100이어야 함: " + target;
            }
            return null;
        }
        Double fraction = order.sellFraction();
        if (fraction == null) {
            if (target != null && !(target == 0.0)) {
                // NaN도 여기로 옵니다(NaN == 0.0은 거짓) — 뜻을 모르는 숫자이므로 같이 거절합니다.
                return "매도에 sellFraction 없이 targetWeightPct만 있음 — 비율 없는 매도는 장부가 전량으로 집행하므로 거절";
            }
            return null;
        }
        // 0을 받으면 장부의 '1주 미만이면 전량' 규칙과 만나 '안 팖'이 '전량 매도'로 뒤집힙니다(PaperLedger.sellQty).
        if (!Double.isFinite(fraction) || !(fraction > 0) || fraction > 1) {
            return "sellFraction은 0 초과 1 이하여야 함: " + fraction;
        }
        return null;
    }

    /** 보유 티커(티커 순). */
    private static TreeSet<String> heldTickers(Context ctx) {
        TreeSet<String> tickers = new TreeSet<>();
        for (String ticker : ctx.currentWeightPct().keySet()) {
            if (ticker != null && ctx.weightOf(ticker) != null) {
                tickers.add(ticker);
            }
        }
        return tickers;
    }

    /** 받은 매도의 근거 문구 뒤 — 지금 체결할 수 없는 보유의 매도(한국 칸): 대기로 두고 같은 시점 매수의 자리를 만들지 않음. */
    static final String UNFILLABLE_SELL_NOTE = " — 지금 체결할 수 없어 대기(풀리면 그 뒤 체결) · 이번 매수의 현금·종목 자리를 만들지 않음";

    /** OVER_ALLOCATED 문구 뒤 — 지금 체결할 수 없는 매도가 있었으면 그 비중이 자리를 만들지 못했다고(없으면 빈 글자 — 미국 문구 그대로). */
    private static String blockedFreedNote(double pct) {
        return pct > WEIGHT_EPSILON
                ? String.format(Locale.ROOT, " · 지금 체결할 수 없는 매도 %.2f%%p는 자리를 만들지 못함", pct) : "";
    }

    /** MAX_POSITIONS 문구 뒤 — 지금 체결할 수 없는 전량 매도가 있었으면 그 종목 수(없으면 빈 글자 — 미국 문구 그대로). */
    private static String blockedPositionsNote(int count) {
        return count > 0 ? " · 지금 체결할 수 없는 전량 매도 " + count + "종목은 자리를 비우지 못함" : "";
    }

    private static String monthlyDetail(Context ctx, Limits limits, int used) {
        return "이달 재량 주문 " + (ctx.monthlyOrdersSoFar() + used) + "건(이번 결정 " + used + "건 포함) — 상한 "
                + limits.maxDiscretionaryOrdersPerMonth() + "건";
    }

    private static String sellDetail(Double weight, double fraction) {
        String held = weight == null ? "—" : String.format(Locale.ROOT, "%.2f%%", weight);
        if (fraction >= 1.0) {
            return "보유 " + held + " 전량 매도";
        }
        return String.format(Locale.ROOT, "보유 %s 중 %.0f%% 매도", held, fraction * 100.0);
    }

    private static String buyDetail(Double current, double target, double increment, double nav, Money money) {
        return String.format(Locale.ROOT, "현재 %.2f%% → 목표 %.2f%%(+%.2f%%p, 약 %s)",
                current == null ? 0.0 : current, target, increment, money.rounded(increment / 100.0 * nav));
    }

    // 빈 값도 Map.of()·Set.of()가 아니라 HashMap·HashSet으로 둡니다 — 그 둘은 get(null)·contains(null)에서 예외를 던져, 받은
    // 맵에 null 키가 섞였는지에 따라 결과가 아니라 예외가 나는 일이 없게.
    private static <K, V> Map<K, V> copy(Map<K, V> map) {
        return Collections.unmodifiableMap(map == null ? new HashMap<>() : new HashMap<>(map));
    }

    private static <T> Set<T> copy(Set<T> set) {
        return Collections.unmodifiableSet(set == null ? new HashSet<>() : new HashSet<>(set));
    }
}
