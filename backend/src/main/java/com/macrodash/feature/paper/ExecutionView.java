package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.ExecutionTiming;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 🧪 GET /api/paper/books/{code}/execution — 실행 감사 응답(미국 Claude 계좌2 실험 단계 0, 명세 docs/specs/2026-10-30-claude-book2-timing-design.md
 * §13-1·§14-2, ADR 0022). 감사 행({@code paper_order_exec} — {@link PaperExecutionAuditJob}이 씀)·주문·체결을 읽기만 해서 주문별 줄과 시점별 요약을
 * 만듭니다(화면은 계산하지 않음 — ADR 0004). 저장본은 읽지 않습니다.
 *
 * <p><b>주문별 줄</b>: 고른 시점·기준 거래일·목표 세션 E·목표 시각, 체결(원가격·체결가·체결 봉·관측 시각), 시점마다의 반사실 {@code {raw, at, rung,
 * isProxy}}(못 구했으면 null), 메뉴 시점마다 계좌1식 대비 차이 bp({@link ExecutionTiming#advantageBp}), 지연·늦게 풂·실행 메모. NEXT_OPEN은
 * {@code isProxy:true}입니다 — Yahoo 1분봉 첫 봉 시가이고 공식 개장 경매가와 같은지 확인하지 못했습니다(명세 §19 X2).
 *
 * <p><b>요약</b>(§14-2 M2의 계좌1 기준 분포): 메뉴 여덟 시점마다 차이의 체결 금액 가중 평균과 결정일 묶음 부트스트랩 90% 구간
 * ({@link ExecutionTiming#summarize} — 주문 &lt; 10이거나 결정일 &lt; 5면 null). 계좌1식 기준(실제 체결 원가격)이나 체결 금액이 없는 주문은
 * {@code excludedNoBaseline}, 그 시점 값이 없는 주문은 {@code excludedNoPrice}로 따로 셉니다(빼고 셈 — 0으로 채우지 않음).
 *
 * <p><b>고른 시점</b>({@code summary.chosen} — §14-2 M1, 주 판정): 계좌2가 고른 시점의 실제 체결 원가격 대비 계좌1식 — 메뉴 줄과 같은 식에 P_시점
 * 대신 체결 원가격(슬리피지 전)을 넣고 같은 {@link ExecutionTiming#summarize}(문턱·부트스트랩 반복·씨앗 같음)로 셉니다. 체결된 주문만 세고, 대체 체결
 * (사다리 칸 {@link UsTimedFills#FALLBACK_RUNGS})은 본 줄에서 빼 {@code fallback}에 따로 셉니다(§14-3 'N ≥ 30(대체 체결 제외)'). 계좌1(시각 지정 체결이
 * 아닌 계좌)은 고른 시점이 곧 계좌1식 기준이라 null입니다. 판정 문턱(§14-3)은 코드에 두지 않습니다 — 8주 뒤 사람이 문서의 문턱으로 읽습니다.
 */
final class ExecutionView {

    private ExecutionView() {
    }

    /**
     * 실행 감사가 있는 계좌인가 — 미국 Claude 계좌({@link ExecutionAudit#auditedBooks} — {@code claude}·{@code claude2})만, 그 밖의 코드는 400.
     *
     * @throws InvalidRequestException 미국 Claude 계좌가 아님
     */
    static void requireAudited(String code) {
        List<String> audited = ExecutionAudit.auditedBooks();
        if (code == null || !audited.contains(code)) {
            throw new InvalidRequestException("실행 감사는 미국 Claude 계좌만 있습니다: " + Params.echo(code) + " ("
                    + String.join(" · ", audited) + ")");
        }
    }

    /** 응답 전체(클래스 설명). 주문은 감사 행이 있는 결정 주문만, 주문 최근 순으로 {@code limit}건 — 요약은 limit과 상관없이 그 계좌 전부. */
    static Map<String, Object> render(PaperStore store, Book book, int limit, TradingCalendar calendar) {
        List<OrderExec> execs = store.orderExecs(book.code());
        Map<Long, Order> orders = new HashMap<>();
        for (Order order : store.executionOrders(book.code(), null)) {
            orders.put(order.id(), order);
        }
        List<OrderExec> audited = execs.stream().filter(e -> orders.containsKey(e.orderId())).toList();
        Map<Long, ExecFill> fills = new HashMap<>();
        for (ExecFill f : store.fillsForOrders(audited.stream().map(OrderExec::orderId).toList())) {
            fills.put(f.fill().orderId(), f);
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (OrderExec exec : audited.subList(0, Math.min(limit, audited.size()))) {
            rows.add(row(exec, orders.get(exec.orderId()), fills.get(exec.orderId()), calendar));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("book", book.code());
        out.put("timings", ExecutionAudit.TIMINGS);
        out.put("limit", limit);
        out.put("orders", rows);
        out.put("summary", summary(book, audited, orders, fills));
        return out;
    }

    private static Map<String, Object> row(OrderExec exec, Order order, ExecFill fill, TradingCalendar calendar) {
        LocalDate session = ExecutionAudit.targetSession(order, calendar);
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("orderId", order.id());
        row.put("decisionId", order.decisionId());
        row.put("ticker", order.ticker());
        row.put("side", order.side());
        row.put("status", order.status());
        row.put("timing", order.timing());
        row.put("asOfTradingDate", text(order.asOfTradingDate()));
        row.put("targetSession", text(session));
        row.put("targetAtKst", stamp(exec.targetAt()));
        row.put("createdAtKst", stamp(order.createdAt()));
        row.put("fill", fill == null ? null : fillRow(fill));
        Map<String, Object> cf = new LinkedHashMap<>();
        for (String timing : ExecutionAudit.TIMINGS) {
            cf.put(timing, price(exec.cf().get(timing), timing));
        }
        row.put("cf", cf);
        Map<String, Object> advantage = new LinkedHashMap<>();
        Double baseline = raw(exec.cf(), ExecutionAudit.NEXT_OBSERVATION);
        for (String timing : menu()) {
            Double bp = ExecutionTiming.advantageBp(sign(order), baseline, raw(exec.cf(), timing));
            advantage.put(timing, PaperQueryService.round2(bp));
        }
        row.put("advantageBp", advantage);
        row.put("lagSeconds", exec.lagSeconds());
        row.put("lateResolved", exec.lateResolved());
        row.put("executionNote", Json.asText(order.reason(), "executionNote"));   // 계좌2부터 — 계좌1 주문은 null
        row.put("auditedAtKst", stamp(exec.updatedAt()));
        return row;
    }

    private static Map<String, Object> fillRow(ExecFill execFill) {
        Fill f = execFill.fill();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("qty", f.qty());
        out.put("rawPrice", PaperQueryService.round4(f.rawPrice()));
        out.put("price", PaperQueryService.round4(f.price()));
        out.put("slippageBp", f.slippageBp());
        out.put("gross", PaperQueryService.round2(f.gross()));
        out.put("observedAtKst", stamp(f.observedAt()));
        out.put("observationDate", text(f.observationDate()));
        out.put("barAtKst", stamp(execFill.barAt()));
        out.put("fillRung", execFill.fillRung());
        return out;
    }

    /** 저장된 반사실 하나 → 응답 칸(없으면 null). */
    private static Map<String, Object> price(JsonNode stored, String timing) {
        Double raw = stored == null ? null : Json.asDouble(stored, "raw");
        if (raw == null) {
            return null;
        }
        String at = Json.asText(stored, "at");
        Instant moment = null;
        try {
            moment = at == null ? null : Instant.parse(at);
        } catch (java.time.format.DateTimeParseException e) {
            // 모르는 시각 표기 — 시각 칸만 비움(값은 그대로)
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("raw", PaperQueryService.round4(raw));
        out.put("at", at);
        out.put("atKst", stamp(moment));
        out.put("rung", Json.asText(stored, "rung"));
        out.put("isProxy", PaperBooks.NEXT_OPEN.equals(timing));
        return out;
    }

    private static Map<String, Object> summary(Book book, List<OrderExec> audited, Map<Long, Order> orders,
                                               Map<Long, ExecFill> fills) {
        List<Map<String, Object>> timings = new ArrayList<>();
        for (String timing : menu()) {
            List<ExecutionTiming.Sample> samples = new ArrayList<>();
            int noBaseline = 0;
            int noPrice = 0;
            for (OrderExec exec : audited) {
                Order order = orders.get(exec.orderId());
                ExecFill fill = fills.get(exec.orderId());
                Double baseline = raw(exec.cf(), ExecutionAudit.NEXT_OBSERVATION);
                double weight = fill == null ? Double.NaN : fill.fill().gross();
                if (baseline == null || !(weight > 0) || order.asOfTradingDate() == null) {
                    noBaseline++;
                    continue;
                }
                Double bp = ExecutionTiming.advantageBp(sign(order), baseline, raw(exec.cf(), timing));
                if (bp == null) {
                    noPrice++;
                    continue;
                }
                samples.add(new ExecutionTiming.Sample(order.asOfTradingDate(), order.id(), weight, bp));
            }
            ExecutionTiming.Summary s = ExecutionTiming.summarize(samples);
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("timing", timing);
            line.put("n", s.n());
            line.put("days", s.days());
            line.put("excludedNoBaseline", noBaseline);
            line.put("excludedNoPrice", noPrice);
            line.put("meanBp", PaperQueryService.round2(s.meanBp()));
            line.put("lowBp", PaperQueryService.round2(s.lowBp()));
            line.put("highBp", PaperQueryService.round2(s.highBp()));
            line.put("isProxy", PaperBooks.NEXT_OPEN.equals(timing));
            timings.add(line);
        }
        Map<String, Object> interval = new LinkedHashMap<>();
        interval.put("level", 90);
        interval.put("method", "결정일(기준 거래일) 묶음 부트스트랩");
        interval.put("resamples", ExecutionTiming.RESAMPLES);
        interval.put("seed", ExecutionTiming.SEED);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("baseline", ExecutionAudit.NEXT_OBSERVATION);
        out.put("formula", "s × (P_NEXT_OBSERVATION − P_시점) ÷ P_NEXT_OBSERVATION × 10⁴ bp — s 매수 +1·매도 −1, 원가격(슬리피지 전), "
                + "양수면 그 시점이 계좌1식보다 유리");
        out.put("weighting", "체결 금액(gross) 가중 평균");
        out.put("interval", interval);
        out.put("minOrders", ExecutionTiming.MIN_ORDERS);
        out.put("minDays", ExecutionTiming.MIN_DAYS);
        out.put("audited", audited.size());
        out.put("chosen", chosen(book, audited, orders, fills));
        out.put("timings", timings);
        return out;
    }

    /**
     * 고른 시점(§14-2 M1 — 클래스 설명). 시각 지정 체결 계좌(계좌2)가 아니면 null. 체결이 없는 주문(대기·만료·취소)은 {@code notFilled}, 계좌1식 기준이나
     * 체결 금액이 없는 체결은 본 줄·대체 체결 줄 각각의 {@code excludedNoBaseline}으로 셉니다(빼고 셈 — 0으로 채우지 않음). {@code excludedFallback}은
     * 본 줄에서 뺀 대체 체결 전부(= 대체 체결 줄의 n + excludedNoBaseline)입니다.
     */
    private static Map<String, Object> chosen(Book book, List<OrderExec> audited, Map<Long, Order> orders,
                                              Map<Long, ExecFill> fills) {
        if (!PaperBooks.find(book.code()).map(PaperBooks.Definition::timed).orElse(false)) {
            return null;                                   // 계좌1 — 고른 시점이 곧 계좌1식 기준
        }
        List<ExecutionTiming.Sample> primary = new ArrayList<>();
        List<ExecutionTiming.Sample> fallback = new ArrayList<>();
        int[] noBaseline = new int[2];                     // {본 줄, 대체 체결}
        boolean proxy = false;
        int notFilled = 0;
        for (OrderExec exec : audited) {
            Order order = orders.get(exec.orderId());
            ExecFill fill = fills.get(exec.orderId());
            if (fill == null) {
                notFilled++;
                continue;
            }
            int group = fill.fillRung() != null && UsTimedFills.FALLBACK_RUNGS.contains(fill.fillRung()) ? 1 : 0;
            Double bp = ExecutionTiming.advantageBp(sign(order), raw(exec.cf(), ExecutionAudit.NEXT_OBSERVATION),
                    fill.fill().rawPrice());
            double weight = fill.fill().gross();
            if (bp == null || !(weight > 0) || order.asOfTradingDate() == null) {
                noBaseline[group]++;
                continue;
            }
            (group == 0 ? primary : fallback).add(new ExecutionTiming.Sample(order.asOfTradingDate(), order.id(), weight, bp));
            // 시가 체결가는 1분봉 첫 봉 시가(R1·R2 — 공식 개장가와 같은지 확인 전, X2). 대체 체결의 늦은 봉·종가는 시가를 대신하지 않음.
            proxy |= group == 0 && PaperBooks.NEXT_OPEN.equals(order.timing());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("formula", "s × (P_NEXT_OBSERVATION − P_체결) ÷ P_NEXT_OBSERVATION × 10⁴ bp — 계좌2가 고른 시점의 체결 원가격(슬리피지 전), "
                + "양수면 고른 시점의 체결이 계좌1식보다 유리");
        out.putAll(chosenLine(ExecutionTiming.summarize(primary), noBaseline[0], proxy));
        out.put("excludedFallback", fallback.size() + noBaseline[1]);
        out.put("notFilled", notFilled);
        out.put("fallback", chosenLine(ExecutionTiming.summarize(fallback), noBaseline[1], false));
        return out;
    }

    private static Map<String, Object> chosenLine(ExecutionTiming.Summary s, int noBaseline, boolean proxy) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("n", s.n());
        line.put("days", s.days());
        line.put("excludedNoBaseline", noBaseline);
        line.put("meanBp", PaperQueryService.round2(s.meanBp()));
        line.put("lowBp", PaperQueryService.round2(s.lowBp()));
        line.put("highBp", PaperQueryService.round2(s.highBp()));
        line.put("isProxy", proxy);
        return line;
    }

    /** 메뉴 여덟 시점(계좌1식 기준을 뺀 반사실 시점), 응답 순서. */
    private static List<String> menu() {
        return ExecutionAudit.TIMINGS.subList(1, ExecutionAudit.TIMINGS.size());
    }

    private static Double raw(JsonNode cf, String timing) {
        JsonNode stored = cf.get(timing);
        return stored == null || stored.isNull() ? null : Json.asDouble(stored, "raw");
    }

    private static int sign(Order order) {
        return PaperBooks.SELL.equals(order.side()) ? -1 : 1;
    }

    private static String stamp(Instant moment) {
        return moment == null ? null : Kst.stamp(moment);
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
