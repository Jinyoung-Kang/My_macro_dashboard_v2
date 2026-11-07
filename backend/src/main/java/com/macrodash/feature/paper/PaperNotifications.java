package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 모의 매매 텔레그램 알림의 글(사용자 요청 2026-11-02 — 체결 한 건마다 한 통, 결정마다 요약 한 통(그 결정이 낸 새 주문 포함), 결정 없이 생긴 주문 한 통).
 * 글은 서버 값 그대로이고(없는 숫자를 만들지 않음 — 모르면 '—'), 금액은 그 계좌 통화(미국 달러 소수 둘째, 한국 원 정수), 시각은 KST, 한국 종목은 이름(코드)로
 * 적습니다. 이모지를 쓰지 않습니다. DB·네트워크를 읽지 않는 순수 함수입니다.
 * 모델이 쓴 글(요약·주문 없음 사유·장중 확인 사유)과 주문 근거는 자르지 않습니다(QA-168 — 길면 보내는 쪽이 여러 통으로 나눔). 자르는 것은 진단 글인
 * 오류(300자)와 거절 사유(120자)뿐입니다.
 *
 * <p>서식(사용자 요청 2026-11-03 — 가독성·문단 구분): 텔레그램 HTML 서식(parse_mode HTML — 보내기는 {@link PaperTelegram})으로 제목 줄과 항목 이름만
 * 굵게 하고, 항목 사이는 빈 줄로 나눕니다. 모델이 쓴 글은 문장마다 한 줄로 보입니다({@link #paragraphs} — 문장 끝과 원 숫자 목록 앞의 공백만 줄바꿈으로
 * 바꾸고 글자는 그대로). 서버 값·모델 글·종목 이름은 모두 {@link #esc}로 HTML 엔티티를 바꿔 넣고, 태그는 이 클래스가 붙이는 {@code <b>}뿐이며 한 줄
 * 안에서 닫힙니다(나눠 보내도 태그가 갈라지지 않음).
 */
final class PaperNotifications {

    private PaperNotifications() {
    }

    static final String EMPTY = "—";
    /** 결정 요약에 적는 주문 줄 상한(넘으면 '외 N건'). */
    static final int ORDER_LINES = 15;
    /** 원 숫자 목록(① 브렌트 …) 앞의 공백 — 그 자리에서 줄을 바꿉니다('①과 ②를'처럼 글 안의 참조는 뒤에 공백이 없어 그대로). */
    private static final Pattern BEFORE_LIST_ITEM = Pattern.compile("[ \\t]+(?=[\u2460-\u2473][ \\t])");
    /** 문장 끝 — 한글·닫는 괄호·%·%p(…다.·…[사실].·…44%.·…3.44%p.) 다음 마침표 뒤의 공백. 소수점·'U.S.' 같은 약어는 건드리지 않습니다. */
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=(?:[가-힣\\]\\)%]|%p)\\.)[ \\t]+");

    /**
     * 체결 한 건.
     *
     * @param order    그 체결의 주문(없으면 null — 시점을 모름)
     * @param names    한국 종목 이름(코드 → 이름, 없으면 코드만)
     * @param linkBase 화면 주소의 앞부분(서버 공개 주소 — 없으면 링크 줄 없음)
     */
    static String fill(Fill f, Book book, Order order, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        List<String> blocks = new ArrayList<>();
        blocks.add(bold("[모의매매 체결] " + label(book, f.bookCode()) + " (" + marketName(book) + ")") + "\n"
                + esc(sideName(f.side()) + " " + ticker(f.ticker(), names, korea) + " " + count(f.qty()) + "주 @ " + money(f.price(), korea, true)
                + " = " + money(f.gross(), korea, false)));
        List<String> details = new ArrayList<>();
        // 비용 칸(0이 아닌 것만 — 미국은 슬리피지가 체결가에 들어 있어 슬리피지 칸이 0이고 bp만 적음. 미국 수수료·매도 제비용(SEC fee + FINRA
        // TAF — 세금 칸에 저장)은 ADR 0030부터 칸에 있음, 이름은 화면·패킷처럼 '제비용').
        List<String> costs = new ArrayList<>();
        if (f.fee() != null && f.fee().signum() != 0) {
            costs.add("수수료 " + money(f.fee().doubleValue(), korea, false));
        }
        if (f.tax() != null && f.tax().signum() != 0) {
            costs.add((korea ? "세금 " : "제비용 ") + money(f.tax().doubleValue(), korea, false));
        }
        if (f.slippageCost() != null && f.slippageCost().signum() != 0) {
            costs.add("슬리피지 " + money(f.slippageCost().doubleValue(), korea, false));
        } else if (f.slippageBp() > 0) {
            costs.add("슬리피지 " + plain(f.slippageBp()) + "bp(가격에 포함)");
        }
        if (!costs.isEmpty()) {
            details.add("비용 " + String.join(" · ", costs));
        }
        String timing = timingName(order, korea);
        details.add("시점 " + (timing == null ? EMPTY : timing) + " · 가격 출처 " + (f.priceSource() == null ? EMPTY : f.priceSource())
                + (f.backfill() ? " · 사후 체결" : ""));
        details.add("체결일 " + (f.observationDate() == null ? EMPTY : f.observationDate()) + " · 기록 "
                + (f.createdAt() == null ? EMPTY : Kst.stamp(f.createdAt())));
        blocks.add(esc(String.join("\n", details)));
        link(blocks, linkBase, book, "holdings");
        return String.join("\n\n", blocks);
    }

    /**
     * 결정 하나의 요약 — 그 결정이 낸 주문(대기·취소로 남긴 것 모두)을 줄마다.
     *
     * @param orders 그 결정의 주문(번호 순)
     */
    static String decision(Decision d, Book book, List<Order> orders, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        JsonNode r = d.response();
        List<String> blocks = new ArrayList<>();
        List<String> head = new ArrayList<>();
        head.add("기준일 " + d.asOfTradingDate() + " · " + kindName(d.kind()) + originTail(r) + " · " + statusName(d.status())
                + (d.retryCount() > 0 ? "(재시도 " + d.retryCount() + "회)" : ""));
        String action = Json.asText(r, "action");
        if (action != null) {
            head.add("장중 확인 " + ("REPLACE".equals(action) ? "대신함(REPLACE)" : "KEEP".equals(action) ? "그대로 둠(KEEP)" : action)
                    + (r.path("supersededOrders").isArray() && !r.path("supersededOrders").isEmpty()
                    ? " · 대신한 대기 주문 " + r.path("supersededOrders").size() + "건" : ""));
        }
        blocks.add(bold("[모의매매 결정] " + label(book, d.bookCode()) + " (" + marketName(book) + ")") + "\n" + esc(String.join("\n", head)));
        String summary = Json.asText(r, "summary");
        if (summary != null && !summary.isBlank()) {
            blocks.add(section("요약", paragraphs(summary)));
        }
        Double target = Json.asDouble(r, "targetEquityExposurePct");
        if (target != null) {
            blocks.add(bold("목표 주식 노출") + " " + esc(plain(target) + "%"));
        }
        String noTrade = Json.asText(r, "noTradeReason");
        if (orders.isEmpty()) {
            blocks.add(noTrade == null || noTrade.isBlank() ? bold("새 주문 없음") : section("새 주문 없음", paragraphs(noTrade)));
        } else {
            List<String> lines = new ArrayList<>();
            for (int i = 0; i < Math.min(orders.size(), ORDER_LINES); i++) {
                lines.add("- " + orderLine(orders.get(i), names, korea));
            }
            if (orders.size() > ORDER_LINES) {
                lines.add("- 외 " + (orders.size() - ORDER_LINES) + "건");
            }
            blocks.add(section("새 주문 " + orders.size() + "건", String.join("\n", lines)));
        }
        JsonNode plan = r == null ? null : r.get("checkpointPlan");
        if (plan != null && plan.isObject() && plan.hasNonNull("status")) {
            String at = Json.asText(plan, "atKst") != null ? Json.asText(plan, "atKst") + " KST"
                    : Json.asText(plan, "atEt") != null ? Json.asText(plan, "atEt") + " ET" : EMPTY;
            String reason = Json.asText(plan, "reason");
            blocks.add(section("장중 확인 요청", "세션 " + Json.asText(plan, "session") + " " + at + " · " + Json.asText(plan, "status")
                    + (reason == null || reason.isBlank() ? "" : "\n" + paragraphs(reason))));
        }
        if (d.error() != null && !d.error().isBlank()) {
            blocks.add(section("오류", clip(d.error().strip(), 300)));
        }
        link(blocks, linkBase, book, "decisions");
        return String.join("\n\n", blocks);
    }

    /** 결정 없이 생긴 주문 하나(스탑 매도 등). */
    static String order(Order o, Book book, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        List<String> blocks = new ArrayList<>();
        blocks.add(bold("[모의매매 주문] " + label(book, o.bookCode()) + " (" + marketName(book) + ")"
                + (PaperBooks.SOURCE_STOP.equals(o.source()) ? " · 스탑" : o.source() == null ? "" : " · " + o.source()))
                + "\n" + esc(orderLine(o, names, korea)));
        String note = o.reason() == null ? null : firstText(o.reason(), "note", "summary", "trigger", "basis");
        if (note != null) {
            blocks.add(section("근거", paragraphs(note)));
        }
        link(blocks, linkBase, book, "holdings");
        return String.join("\n\n", blocks);
    }

    /** 주문 한 줄 — 쪽·종목·크기·시점·상태(대기가 아니면). */
    static String orderLine(Order o, Map<String, String> names, boolean korea) {
        String size;
        if (o.qty() != null) {
            size = count(o.qty()) + "주";
        } else if (PaperBooks.BUY.equals(o.side())) {
            size = o.targetWeightPct() == null ? EMPTY : "목표 " + plain(o.targetWeightPct()) + "%";
        } else {
            size = o.sellFraction() == null || o.sellFraction() >= 1.0 ? "전량" : plain(o.sellFraction() * 100) + "%";
        }
        String timing = timingName(o, korea);
        String status = PaperBooks.ORDER_PENDING.equals(o.status()) ? "" : " · " + orderStatusName(o.status())
                + (o.rejectReason() == null ? "" : "(" + clip(o.rejectReason(), 120) + ")");
        return sideName(o.side()) + " " + ticker(o.ticker(), names, korea) + " " + size + " · " + (timing == null ? EMPTY : timing) + status;
    }

    // ------------------------------------------------------------------ 이름
    /**
     * 주문의 체결 시점 이름 — 분 단위 지정 시각({@value PaperBooks#AT_MINUTE})은 그 주문의 시각까지 적습니다('지정 시각 10:47 ET'). 아침(밤) 결정의
     * 주문이면 다음 세션의, 장중 판단의 주문이면 그날의 시각이라 세션 말은 붙이지 않습니다. 장중 감시가 낸 STOP({@link StopWatch#intradayStop} —
     * ADR 0032)은 감지한 그 세션에 팔리므로 종가는 '그날 종가', 시장가는 기준 시각까지('장중 시장가 10:07 KST' — {@link ExecutionAudit#marketTarget})
     * 적습니다(QA-312 — 시점 이름만 보면 '다음 거래일 종가'가 되어 같은 알림의 근거 메모 '그날 종가 매도'와 엇갈림). 다음 세션 첫 분이 지난 처리가 낸
     * 한국 밤 대체 STOP의 장중 시장가·종가도 처리한 그 세션에 팔려 같게 적습니다({@link StopWatch#sameSessionStop}, QA-327). 만료일·기준일로 가리지
     * 않는 것은 결정의 종가 주문도 만료일이 목표 세션이라 구분되지 않기 때문입니다. 그 밖은 {@link #timingName(String, boolean)}.
     */
    static String timingName(Order order, boolean korea) {
        if (order == null) {
            return null;
        }
        if (PaperBooks.AT_MINUTE.equals(order.timing())) {
            return order.targetLocal() == null ? "지정 시각(시각 없음)"
                    : "지정 시각 " + String.format(Locale.ROOT, "%02d:%02d", order.targetLocal().getHour(),
                            order.targetLocal().getMinute()) + (korea ? " KST" : " ET");
        }
        if (StopWatch.sameSessionStop(order)) {
            if (PaperBooks.NEXT_CLOSE.equals(order.timing())) {
                return "그날 종가";
            }
            if (PaperBooks.MARKET.equals(order.timing()) && order.createdAt() != null) {
                LocalTime at = ExecutionAudit.marketTarget(order.createdAt())
                        .atZone(korea ? KrxCalendar.SEOUL : UsPaperMarket.INSTANCE.calendar().zone()).toLocalTime();
                return "장중 시장가 " + String.format(Locale.ROOT, "%02d:%02d", at.getHour(), at.getMinute()) + (korea ? " KST" : " ET");
            }
        }
        return timingName(order.timing(), korea);
    }

    static String timingName(String timing, boolean korea) {
        if (timing == null) {
            return null;
        }
        String zone = korea ? " KST" : " ET";
        String session = korea ? "다음 거래일" : "다음 세션";
        return switch (timing) {
            case PaperBooks.NEXT_OPEN -> session + " 시가";
            case PaperBooks.NEXT_CLOSE -> session + " 종가";
            case PaperBooks.MARKET -> "장중 시장가";
            case "NEXT_OBSERVATION" -> "다음 관측치";
            case "BACKFILL" -> "출발일 종가(사후 체결)";
            case "IMMEDIATE" -> "즉시";
            default -> timing.startsWith("AT_") && timing.length() == 7
                    ? session + " " + timing.substring(3, 5) + ":" + timing.substring(5) + zone : timing;
        };
    }

    static String kindName(String kind) {
        if (kind == null) {
            return EMPTY;
        }
        return switch (kind) {
            case RuleBookService.SCHEDULED -> "정기 결정";
            case RuleBookService.MANUAL -> "수동 결정";
            case RuleBookService.INITIAL -> "출발 결정";
            case RuleBookService.REBALANCE -> "재선정";
            case RuleBookService.CHECKPOINT -> "장중 확인";
            // 자유 시점 판의 장중 판단(INTRADAY_<순번> — 종류 목록의 순서가 순번).
            default -> RuleBookService.intraday(kind) ? "장중 판단 " + (RuleBookService.INTRADAY_KINDS.indexOf(kind) + 1) : kind;
        };
    }

    /**
     * 코드가 만든 장중 판단의 꼬리(ADR 0031 — 응답 {@code checkpoint.origin}) — 보장이면 '(코드 보장)', 사건이면 '(사건)', 그 밖(예약·다음 예약·
     * 운영자·장중 판단이 아닌 결정)은 없음.
     */
    static String originTail(JsonNode response) {
        JsonNode checkpoint = response == null ? null : response.get("checkpoint");
        String origin = checkpoint != null && checkpoint.isObject() ? Json.asText(checkpoint, "origin") : null;
        if (IntradayPlan.ORIGIN_GUARANTEE.equals(origin)) {
            return "(코드 보장)";
        }
        return IntradayPlan.ORIGIN_EVENT.equals(origin) ? "(사건)" : "";
    }

    static String statusName(String status) {
        if (status == null) {
            return EMPTY;
        }
        return switch (status) {
            case ClaudeBookService.STATUS_OK -> "주문 있음(OK)";
            case ClaudeBookService.STATUS_NO_TRADE -> "주문 없음(NO_TRADE)";
            case ClaudeBookService.STATUS_SKIPPED -> "건너뜀(SKIPPED)";
            case ClaudeBookService.STATUS_API_ERROR -> "API 오류(API_ERROR)";
            case ClaudeBookService.STATUS_FORMAT_ERROR -> "형식 오류(FORMAT_ERROR)";
            case ClaudeBookService.STATUS_REFUSED -> "거절(REFUSED)";
            default -> status;
        };
    }

    static String orderStatusName(String status) {
        if (status == null) {
            return EMPTY;
        }
        return switch (status) {
            case PaperBooks.ORDER_PENDING -> "대기";
            case PaperBooks.ORDER_FILLED -> "체결";
            case PaperBooks.ORDER_CANCELLED -> "취소";
            case PaperBooks.ORDER_EXPIRED -> "만료";
            default -> status;
        };
    }

    private static String sideName(String side) {
        return PaperBooks.BUY.equals(side) ? "매수" : PaperBooks.SELL.equals(side) ? "매도" : side == null ? EMPTY : side;
    }

    private static String ticker(String code, Map<String, String> names, boolean korea) {
        String name = korea && names != null ? names.get(code) : null;
        return name == null || name.isBlank() ? code : name + "(" + code + ")";
    }

    private static boolean korea(Book book) {
        return book != null && Book.MARKET_KR.equals(book.market());
    }

    private static String marketName(Book book) {
        return korea(book) ? "한국" : "미국";
    }

    private static String label(Book book, String code) {
        return book == null || book.label() == null ? code : book.label();
    }

    /** 금액 — 미국 '$1,234.56'(가격이면 소수 넷째까지 있는 만큼), 한국 '1,234원'. */
    static String money(double value, boolean korea, boolean price) {
        if (!Double.isFinite(value)) {
            return EMPTY;
        }
        if (korea) {
            return format("#,##0", value) + "원";
        }
        return (value < 0 ? "-$" : "$") + format(price ? "#,##0.00##" : "#,##0.00", Math.abs(value));
    }

    private static String count(int value) {
        return format("#,##0", value);
    }

    private static String plain(double value) {
        return format("#,##0.##", value);
    }

    private static String format(String pattern, double value) {
        DecimalFormat f = new DecimalFormat(pattern, DecimalFormatSymbols.getInstance(Locale.ROOT));
        return f.format(BigDecimal.valueOf(value));
    }

    private static String clip(String text, int max) {
        return text.length() > max ? text.substring(0, max - 1) + "…" : text;
    }

    private static String firstText(JsonNode node, String... fields) {
        for (String field : fields) {
            String value = Json.asText(node, field);
            if (value != null && !value.isBlank()) {
                return value.strip();
            }
        }
        return null;
    }

    /** 화면 링크 문단 — 서버 공개 주소가 있을 때만. */
    private static void link(List<String> blocks, String linkBase, Book book, String tab) {
        if (linkBase == null || linkBase.isBlank()) {
            return;
        }
        String base = linkBase.strip().replaceAll("/+$", "");
        blocks.add(esc(base + "/paper/" + (korea(book) ? "kr" : "us") + "/" + tab));
    }

    // ------------------------------------------------------------------ 서식

    /** HTML 서식의 글자 — {@code &}·{@code <}·{@code >}를 엔티티로(텔레그램 HTML 서식이 요구하는 셋). */
    static String esc(String text) {
        return text == null ? "" : text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** 굵은 글씨 한 줄(제목·항목 이름). */
    private static String bold(String text) {
        return "<b>" + esc(text) + "</b>";
    }

    /** 항목 하나 — 굵은 이름 줄과 그 아래 글. */
    private static String section(String heading, String body) {
        return bold(heading) + "\n" + esc(body);
    }

    /**
     * 모델이 쓴 글을 문장마다 한 줄로 — 원 숫자 목록(①…) 앞과 문장 끝(한글·닫는 괄호·% 다음 마침표) 뒤의 공백만 줄바꿈으로 바꿉니다. 글자는 더하거나
     * 빼지 않고, 원래 있던 줄바꿈은 그대로(빈 줄은 하나까지)입니다.
     */
    static String paragraphs(String text) {
        String out = BEFORE_LIST_ITEM.matcher(text.strip()).replaceAll("\n");
        out = SENTENCE_END.matcher(out).replaceAll("\n");
        return out.replaceAll("\n{3,}", "\n\n");
    }
}
