package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 모의 매매 텔레그램 알림의 글(사용자 요청 2026-11-02 — 체결 한 건마다 한 통, 결정마다 요약 한 통(그 결정이 낸 새 주문 포함), 결정 없이 생긴 주문 한 통).
 * 글은 서버 값 그대로이고(없는 숫자를 만들지 않음 — 모르면 '—'), 금액은 그 계좌 통화(미국 달러 소수 둘째, 한국 원 정수), 시각은 KST, 한국 종목은 이름(코드)로
 * 적습니다. 이모지를 쓰지 않습니다. DB·네트워크를 읽지 않는 순수 함수입니다.
 * 모델이 쓴 글(요약·주문 없음 사유·장중 확인 사유)과 주문 근거는 자르지 않습니다(QA-168 — 길면 보내는 쪽이 여러 통으로 나눔). 자르는 것은 진단 글인
 * 오류(300자)와 거절 사유(120자)뿐입니다.
 */
final class PaperNotifications {

    private PaperNotifications() {
    }

    static final String EMPTY = "—";
    /** 결정 요약에 적는 주문 줄 상한(넘으면 '외 N건'). */
    static final int ORDER_LINES = 15;

    /**
     * 체결 한 건.
     *
     * @param order    그 체결의 주문(없으면 null — 시점을 모름)
     * @param names    한국 종목 이름(코드 → 이름, 없으면 코드만)
     * @param linkBase 화면 주소의 앞부분(서버 공개 주소 — 없으면 링크 줄 없음)
     */
    static String fill(Fill f, Book book, Order order, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        List<String> lines = new ArrayList<>();
        lines.add("[모의매매 체결] " + label(book, f.bookCode()) + " (" + marketName(book) + ")");
        lines.add(sideName(f.side()) + " " + ticker(f.ticker(), names, korea) + " " + count(f.qty()) + "주 @ " + money(f.price(), korea, true)
                + " = " + money(f.gross(), korea, false));
        // 비용 칸(0이 아닌 것만 — 미국은 슬리피지가 체결가에 들어 있어 비용 칸이 0이고 bp만 적음).
        List<String> costs = new ArrayList<>();
        if (f.fee() != null && f.fee().signum() != 0) {
            costs.add("수수료 " + money(f.fee().doubleValue(), korea, false));
        }
        if (f.tax() != null && f.tax().signum() != 0) {
            costs.add("세금 " + money(f.tax().doubleValue(), korea, false));
        }
        if (f.slippageCost() != null && f.slippageCost().signum() != 0) {
            costs.add("슬리피지 " + money(f.slippageCost().doubleValue(), korea, false));
        } else if (f.slippageBp() > 0) {
            costs.add("슬리피지 " + plain(f.slippageBp()) + "bp(가격에 포함)");
        }
        if (!costs.isEmpty()) {
            lines.add("비용 " + String.join(" · ", costs));
        }
        String timing = order == null ? null : timingName(order.timing(), korea);
        lines.add("시점 " + (timing == null ? EMPTY : timing) + " · 가격 출처 " + (f.priceSource() == null ? EMPTY : f.priceSource())
                + (f.backfill() ? " · 사후 체결" : ""));
        lines.add("체결일 " + (f.observationDate() == null ? EMPTY : f.observationDate()) + " · 기록 "
                + (f.createdAt() == null ? EMPTY : Kst.stamp(f.createdAt())));
        link(lines, linkBase, book, "holdings");
        return String.join("\n", lines);
    }

    /**
     * 결정 하나의 요약 — 그 결정이 낸 주문(대기·취소로 남긴 것 모두)을 줄마다.
     *
     * @param orders 그 결정의 주문(번호 순)
     */
    static String decision(Decision d, Book book, List<Order> orders, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        JsonNode r = d.response();
        List<String> lines = new ArrayList<>();
        lines.add("[모의매매 결정] " + label(book, d.bookCode()) + " (" + marketName(book) + ") · 기준일 " + d.asOfTradingDate() + " "
                + kindName(d.kind()) + " · " + statusName(d.status()) + (d.retryCount() > 0 ? "(재시도 " + d.retryCount() + "회)" : ""));
        String action = Json.asText(r, "action");
        if (action != null) {
            lines.add("장중 확인 " + ("REPLACE".equals(action) ? "대신함(REPLACE)" : "KEEP".equals(action) ? "그대로 둠(KEEP)" : action)
                    + (r.path("supersededOrders").isArray() && !r.path("supersededOrders").isEmpty()
                    ? " · 대신한 대기 주문 " + r.path("supersededOrders").size() + "건" : ""));
        }
        String summary = Json.asText(r, "summary");
        if (summary != null && !summary.isBlank()) {
            lines.add("요약: " + summary.strip());
        }
        Double target = Json.asDouble(r, "targetEquityExposurePct");
        if (target != null) {
            lines.add("목표 주식 노출 " + plain(target) + "%");
        }
        String noTrade = Json.asText(r, "noTradeReason");
        if (orders.isEmpty()) {
            lines.add("새 주문 없음" + (noTrade == null || noTrade.isBlank() ? "" : " — " + noTrade.strip()));
        } else {
            lines.add("새 주문 " + orders.size() + "건");
            for (int i = 0; i < Math.min(orders.size(), ORDER_LINES); i++) {
                lines.add("- " + orderLine(orders.get(i), names, korea));
            }
            if (orders.size() > ORDER_LINES) {
                lines.add("- 외 " + (orders.size() - ORDER_LINES) + "건");
            }
        }
        JsonNode plan = r == null ? null : r.get("checkpointPlan");
        if (plan != null && plan.isObject() && plan.hasNonNull("status")) {
            String at = Json.asText(plan, "atKst") != null ? Json.asText(plan, "atKst") + " KST"
                    : Json.asText(plan, "atEt") != null ? Json.asText(plan, "atEt") + " ET" : EMPTY;
            lines.add("장중 확인 요청: 세션 " + Json.asText(plan, "session") + " " + at + " · " + Json.asText(plan, "status")
                    + (Json.asText(plan, "reason") == null ? "" : " — " + Json.asText(plan, "reason")));
        }
        if (d.error() != null && !d.error().isBlank()) {
            lines.add("오류: " + clip(d.error().strip(), 300));
        }
        link(lines, linkBase, book, "decisions");
        return String.join("\n", lines);
    }

    /** 결정 없이 생긴 주문 하나(스탑 매도 등). */
    static String order(Order o, Book book, Map<String, String> names, String linkBase) {
        boolean korea = korea(book);
        List<String> lines = new ArrayList<>();
        lines.add("[모의매매 주문] " + label(book, o.bookCode()) + " (" + marketName(book) + ")"
                + (PaperBooks.SOURCE_STOP.equals(o.source()) ? " · 스탑" : o.source() == null ? "" : " · " + o.source()));
        lines.add(orderLine(o, names, korea));
        String note = o.reason() == null ? null : firstText(o.reason(), "note", "summary", "trigger", "basis");
        if (note != null) {
            lines.add("근거: " + note);
        }
        link(lines, linkBase, book, "holdings");
        return String.join("\n", lines);
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
        String timing = timingName(o.timing(), korea);
        String status = PaperBooks.ORDER_PENDING.equals(o.status()) ? "" : " · " + orderStatusName(o.status())
                + (o.rejectReason() == null ? "" : "(" + clip(o.rejectReason(), 120) + ")");
        return sideName(o.side()) + " " + ticker(o.ticker(), names, korea) + " " + size + " · " + (timing == null ? EMPTY : timing) + status;
    }

    // ------------------------------------------------------------------ 이름
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
            default -> kind;
        };
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

    /** 화면 링크 한 줄 — 서버 공개 주소가 있을 때만. */
    private static void link(List<String> lines, String linkBase, Book book, String tab) {
        if (linkBase == null || linkBase.isBlank()) {
            return;
        }
        String base = linkBase.strip().replaceAll("/+$", "");
        lines.add(base + "/paper/" + (korea(book) ? "kr" : "us") + "/" + tab);
    }
}
