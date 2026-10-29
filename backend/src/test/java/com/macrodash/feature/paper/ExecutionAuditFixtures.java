package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;

/**
 * 실행 감사 시험의 재료 — 1분봉 저장본은 수집기 모양(contract 1, {@code collector/app/tasks/paper_bars.py} 머리말)을 손으로 만듭니다(외부 호출
 * 없음). 날짜는 실제 미국 달력입니다: 2026-10-26(월)이 기준 거래일이면 목표 세션 E는 10-27(화, EDT — 09:30 ET = 13:30Z), 10-30(금)이면 11-02(월,
 * EST — 서머타임이 11-01에 끝나 09:30 ET = 14:30Z), 11-25(수)면 11-27(금, 추수감사절 다음 날 13:00 조기 폐장).
 */
final class ExecutionAuditFixtures {

    private ExecutionAuditFixtures() {
    }

    static final LocalDate MON = LocalDate.of(2026, 10, 26);
    static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    /** 화요일 결정(월요일 세션 다음 KST 날 07:31)에 만든 주문 시각. */
    static final Instant MON_DECIDED = Instant.parse("2026-10-26T22:31:00Z");

    static final LocalDate FRI_EDT = LocalDate.of(2026, 10, 30);
    static final LocalDate MON_EST = LocalDate.of(2026, 11, 2);
    static final Instant FRI_DECIDED = Instant.parse("2026-10-30T22:31:00Z");

    static final LocalDate WED_BEFORE_THANKSGIVING = LocalDate.of(2026, 11, 25);
    static final LocalDate EARLY_CLOSE = LocalDate.of(2026, 11, 27);
    static final Instant WED_DECIDED = Instant.parse("2026-11-25T22:31:00Z");

    /** Claude 계좌1 결정 주문(출처 CLAUDE, 목표 비중 매수 또는 매도 비율). */
    static Order claudeOrder(String ticker, String side, String timing, String status, LocalDate asOf,
                             Instant createdAt) {
        boolean buy = PaperBooks.BUY.equals(side);
        return new Order(0, PaperBooks.CLAUDE, 1L, ticker, side, null, buy ? 5.0 : null, buy ? null : 0.5, timing,
                "CLAUDE", status, null, null, asOf, createdAt, UsMarketCalendar.addTradingDays(asOf, 3), null);
    }

    /** 계좌1식 체결(관측치 원가격 그대로, 슬리피지 5bp를 얹은 체결가). */
    static Fill observationFill(long orderId, String ticker, String side, int qty, double raw, Instant observedAt,
                                LocalDate observationDate) {
        double price = PaperBooks.BUY.equals(side) ? raw * 1.0005 : raw * 0.9995;
        return new Fill(0, orderId, PaperBooks.CLAUDE, ticker, side, qty, price, raw, 5, qty * price, observedAt,
                observationDate, PaperBooks.SOURCE_QUOTES, false, null);
    }

    /** 그 세션 날짜의 뉴욕 시각 → 순간. */
    static Instant et(LocalDate day, int hour, int minute) {
        return ZonedDateTime.of(day, LocalTime.of(hour, minute), UsMarketCalendar.NEW_YORK).toInstant();
    }

    /**
     * 1분봉 저장본(수집기 contract 1 모양)을 만드는 도우미. 봉은 넣은 순서와 상관없이 창·마지막 봉에 들어가고, 창 시각마다 T 뒤(T 포함) 그 세션의 첫
     * 거래 봉({@code firstTradeAfter} — 수집기 {@code session_entries}와 같은 규칙, 거래량 &gt; 0만)을 다시 셉니다.
     */
    static final class Bars {

        private final ObjectNode root = MAPPER.createObjectNode();
        private final Instant fetched;

        Bars(Instant fetched) {
            this.fetched = fetched;
            root.put("contract", 1).put("source", "Yahoo(yfinance) 1분봉 — 정규장·원시가").put("barLabel", "START")
                    .put("reference", "SPY").put("fetchedAt", fetched.toString());
            ObjectNode menu = root.putObject("menu");
            ExecutionAudit.MENU.forEach((timing, at) -> menu.put(timing, ExecutionAudit.label(at)));
            root.putNull("lagSeconds");
            root.putNull("declaredDelayMin");
            root.putObject("tickers");
        }

        /** 그 종목·세션의 1분봉 한 줄 — 메뉴 창(T ~ T+4분) 안이면 그 창에, 마지막 봉은 늘 다시 셈(창 밖 봉은 마지막 봉으로만). */
        Bars bar(String ticker, LocalDate day, Instant start, double open, Double volume) {
            return put(windowOf(day, start), ticker, day, start, open, volume);
        }

        /** 창 키를 직접 정해 넣습니다 — 창 시각을 고정 UTC 오프셋으로 잘못 셈한 저장본(서머타임 시험). */
        Bars barIn(String label, String ticker, LocalDate day, Instant start, double open, Double volume) {
            return put(label, ticker, day, start, open, volume);
        }

        /** 그 종목을 이번에 받지 못해 직전 값을 이어받은 항목으로 표시(isStale). */
        Bars stale(String ticker) {
            ((ObjectNode) root.get("tickers").get(ticker)).put("isStale", true).put("staleReason", "시험");
            return this;
        }

        /** 그 세션 항목을 받은 시각(세션마다의 fetchedAt — 합쳐 둔 옛 세션은 저장본 시각보다 앞)을 바꿉니다. */
        Bars sessionFetchedAt(String ticker, LocalDate day, Instant at) {
            session(ticker, day).put("fetchedAt", at.toString());
            return this;
        }

        /** 첫 거래 봉 칸을 직접 정합니다 — 수집기 값이 틀린 저장본(장부 재검사 시험). */
        Bars firstTradeAfter(String label, String ticker, LocalDate day, Instant start, double open, double volume) {
            ((ObjectNode) session(ticker, day).get("firstTradeAfter")).set(label, MAPPER.createObjectNode()
                    .put("t", start.toString()).put("o", open).put("v", volume));
            return this;
        }

        JsonNode payload() {
            return root;
        }

        Snapshot snapshot() {
            return new Snapshot(Datasets.SNAP_PAPER_BARS_US, root, "json", "ok", null, fetched);
        }

        private Bars put(String label, String ticker, LocalDate day, Instant start, double open, Double volume) {
            ObjectNode session = session(ticker, day);
            ObjectNode bar = MAPPER.createObjectNode().put("t", start.toString()).put("o", open).put("h", open)
                    .put("l", open).put("c", open);
            if (volume == null) {
                bar.putNull("v");
            } else {
                bar.put("v", volume);
            }
            if (label != null) {
                ObjectNode windows = (ObjectNode) session.get("windows");
                JsonNode existing = windows.get(label);
                ArrayNode rows = existing == null || existing.isNull() ? windows.putArray(label) : (ArrayNode) existing;
                rows.add(bar);
            }
            JsonNode last = session.get("lastBar");
            if (last == null || last.isNull() || Instant.parse(last.get("t").asString()).isBefore(start)) {
                session.set("lastBar", bar.deepCopy());
            }
            session.put("barCount", session.path("barCount").asInt(0) + 1);
            ObjectNode first = (ObjectNode) session.get("firstTradeAfter");
            boolean traded = volume != null && volume > 0;
            for (LocalTime at : ExecutionAudit.MENU.values()) {
                String key = ExecutionAudit.label(at);
                Instant begin = ZonedDateTime.of(day, at, UsMarketCalendar.NEW_YORK).toInstant();
                JsonNode current = first.get(key);
                boolean earlier = current == null || current.isNull()
                        || start.isBefore(Instant.parse(current.get("t").asString()));
                if (traded && !start.isBefore(begin) && earlier) {
                    first.set(key, MAPPER.createObjectNode().put("t", start.toString()).put("o", open).put("v", volume));
                } else if (current == null) {
                    first.putNull(key);
                }
            }
            return this;
        }

        private ObjectNode session(String ticker, LocalDate day) {
            ObjectNode tickers = (ObjectNode) root.get("tickers");
            ObjectNode entry = tickers.has(ticker) ? (ObjectNode) tickers.get(ticker) : tickers.putObject(ticker);
            if (!entry.has("fetchedAt")) {
                entry.put("fetchedAt", fetched.toString());
            }
            ObjectNode sessions = entry.has("sessions") ? (ObjectNode) entry.get("sessions") : entry.putObject("sessions");
            String key = day.toString();
            if (!sessions.has(key)) {
                ObjectNode session = sessions.putObject(key).put("fetchedAt", fetched.toString()).put("barCount", 0);
                ObjectNode windows = session.putObject("windows");
                for (Map.Entry<String, LocalTime> menu : ExecutionAudit.MENU.entrySet()) {
                    windows.putNull(ExecutionAudit.label(menu.getValue()));
                }
                session.putObject("firstTradeAfter");
                session.putNull("lastBar");
                session.putNull("dailyOpen");
            }
            return (ObjectNode) sessions.get(key);
        }

        private static String windowOf(LocalDate day, Instant start) {
            for (LocalTime at : ExecutionAudit.MENU.values()) {
                Instant begin = ZonedDateTime.of(day, at, UsMarketCalendar.NEW_YORK).toInstant();
                if (!start.isBefore(begin) && start.isBefore(begin.plus(ExecutionAudit.WINDOW))) {
                    return ExecutionAudit.label(at);
                }
            }
            return null;
        }
    }
}
