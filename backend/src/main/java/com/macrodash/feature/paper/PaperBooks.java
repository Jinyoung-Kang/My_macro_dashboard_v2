package com.macrodash.feature.paper;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 네 책의 정의와 장부에서 쓰는 상태 값(DB CHECK와 같은 문자열, V8).
 *
 * <p>책은 넷으로 고정입니다(명세 L1): 규칙 책(대조군) · Claude 재량 책(실험군) · 벤치마크 둘. 벤치마크는 시작할 때 정한 비중으로
 * 한 번 사고 그대로 들고 갑니다(단계 1은 리밸런싱하지 않음 — bench_mix의 60/40은 시간이 지나며 벌어집니다).
 */
final class PaperBooks {

    private PaperBooks() {
    }

    static final String RULES = "rules";
    static final String CLAUDE = "claude";
    static final String BENCH_SPY = "bench_spy";
    static final String BENCH_MIX = "bench_mix";

    /** 책 종류(paper_books.kind). */
    static final String KIND_RULES = "RULES";
    static final String KIND_CLAUDE = "CLAUDE";
    static final String KIND_BENCHMARK = "BENCHMARK";

    /** 책 상태(paper_books.status). */
    static final String NOT_STARTED = "NOT_STARTED";
    static final String ACTIVE = "ACTIVE";
    static final String PAUSED = "PAUSED";

    /** 주문 상태(paper_orders.status). */
    static final String ORDER_PENDING = "PENDING";
    static final String ORDER_FILLED = "FILLED";
    static final String ORDER_CANCELLED = "CANCELLED";

    /** 주문 시점(paper_orders.timing). */
    static final String NEXT_CLOSE = "NEXT_CLOSE";
    static final String IMMEDIATE = "IMMEDIATE";
    static final String BACKFILL = "BACKFILL";

    /** 주문 출처(paper_orders.source). */
    static final String SOURCE_STOP = "STOP";
    static final String SOURCE_BENCHMARK = "BENCHMARK";

    static final String BUY = "BUY";
    static final String SELL = "SELL";

    /** 체결 가격 출처(paper_fills.price_source). */
    static final String SOURCE_QUOTES = "paper.quotes";
    static final String SOURCE_HISTORY = "equity_close";

    /**
     * 책 하나의 정의.
     *
     * @param weights 벤치마크의 종목 → 비중(%). 규칙·Claude 책은 비어 있음(무엇을 살지는 결정이 정함)
     */
    record Definition(String code, String kind, String label, Map<String, Double> weights) {
        boolean benchmark() {
            return KIND_BENCHMARK.equals(kind);
        }
    }

    /**
     * 화면 이름(paper_books.label) — 이 상수 한 곳에서 정합니다. 이름은 초기화 때 행에 들어가고 그 뒤로는 다시 쓰지 않으므로, 바꾸면
     * {@link #LEGACY_LABELS}에 옛 이름을 남겨 이미 만든 행도 맞춥니다({@link PaperAdminService#reconcileLabels}).
     */
    static final String RULES_LABEL = "규칙 계좌";
    static final String CLAUDE_LABEL = "Claude 계좌";
    static final String BENCH_SPY_LABEL = "SPY 계좌";
    static final String BENCH_MIX_LABEL = "60/40 계좌";

    /**
     * 옛 화면 이름 — 2026-10-25에 '책'을 '계좌'로 바꾸기 전의 초기화가 행에 넣은 값. 지금 행 이름이 이 값 그대로일 때만 새 이름으로
     * 바꿉니다(손으로 고친 이름은 그대로). 벤치마크의 옛 이름은 구성 비중이었습니다 — 구성은 정의의 {@code weights}에 그대로 있습니다.
     */
    static final Map<String, String> LEGACY_LABELS = Map.of(
            RULES, "규칙 책",
            CLAUDE, "Claude 재량 책",
            BENCH_SPY, "SPY 100%",
            BENCH_MIX, "SPY 60% · SHY 40%");

    /** 화면에 보이는 순서이기도 합니다. */
    static final List<Definition> ALL = List.of(
            new Definition(RULES, KIND_RULES, RULES_LABEL, Map.of()),
            new Definition(CLAUDE, KIND_CLAUDE, CLAUDE_LABEL, Map.of()),
            new Definition(BENCH_SPY, KIND_BENCHMARK, BENCH_SPY_LABEL, weights("SPY", 100.0)),
            new Definition(BENCH_MIX, KIND_BENCHMARK, BENCH_MIX_LABEL, weights("SPY", 60.0, "SHY", 40.0)));

    static Optional<Definition> find(String code) {
        return ALL.stream().filter(d -> d.code().equals(code)).findFirst();
    }

    /** 통계(초과·베타)의 비교 기준 책. SPY 100% 책 자신은 기준이 없습니다(null). */
    static String benchmarkOf(String code) {
        return BENCH_SPY.equals(code) ? null : BENCH_SPY;
    }

    /**
     * 그 책 정의 목록의 순서(모르는 코드는 뒤, 코드 순) — 시장 묶음의 {@link PaperMarket#bookOrder}가 그 시장 책 정의로 만듭니다.
     */
    static Comparator<String> orderOf(List<Definition> definitions) {
        List<String> codes = definitions.stream().map(Definition::code).toList();
        return Comparator.<String>comparingInt(code -> {
            int i = codes.indexOf(code);
            return i < 0 ? codes.size() : i;
        }).thenComparing(Comparator.naturalOrder());
    }

    /** 미국 책의 정의 순서(모르는 코드는 뒤, 코드 순) — {@link #ALL}로 만든 {@link #orderOf}. */
    static final Comparator<String> ORDER = orderOf(ALL);

    private static Map<String, Double> weights(Object... tickerAndPct) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (int i = 0; i < tickerAndPct.length; i += 2) {
            out.put((String) tickerAndPct[i], (Double) tickerAndPct[i + 1]);
        }
        return java.util.Collections.unmodifiableMap(out);
    }
}
