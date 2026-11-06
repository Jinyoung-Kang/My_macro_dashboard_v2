package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 자유 시점 판의 장중 판단 예약(ADR 0027 결정 3·ADR 0031, 명세 docs/specs/2026-11-05-free-fill-timing.md §7) — 결정 응답의 {@code checkpoints[]}와 장중 판단
 * 응답의 {@code nextCheckpoint}의 의미 검사. 스키마 검사기는 모양(시각 글자·감시 목록 상한·질문 길이)만 보므로, 받는 범위·간격·횟수·감시 목록의
 * 유니버스는 여기서 봅니다. 어긴 항목만 버리고(사유를 남김) 나머지 예약과 그 결정의 주문 판정은 그대로입니다.
 *
 * <p>규칙: 시각은 그 시장 현지 시각 'HH:MM'(분 단위)이고 목표 세션의 개장 {@link #AFTER_OPEN} 뒤부터 장중 시장가를 받는 끝({@link #window} — 미국은
 * 마감, 한국은 종가 단일가 시작)의 {@link #BEFORE_CLOSE} 전까지(양 끝 포함 — 보통 날 미국 09:40~15:30 ET·한국 09:10~14:50 KST, 조기 폐장·개장 시각
 * 변경일은 그날의 개장·마감), 호출 창 시작(시각 + {@link PaperCheckpointJob#WINDOW_START})이 지금보다 뒤, 같은 계좌의 다른
 * 판단 시각과 {@link #MIN_GAP} 이상 떨어짐(호출 창 시각 + 2분 ~ + 20분이 겹치지 않게 — 창 길이 18분 ≤ 간격 20분), 세션당 {@code max}번까지(이른 시각부터
 * 받음 — 코드가 부를 수 있는 순번은 {@link RuleBookService#INTRADAY_MAX} 셋).
 * 감시 목록은 {@link ExecutionSection#WATCH_MAX}개 이하·중복 없음·유니버스 안, 감시 1분봉(MINUTE)이면 비어 있지 않음. 한국은 늘 MINUTE입니다.
 * 순수 함수입니다(시계·저장소를 읽지 않음).
 */
final class IntradayRequest {

    private IntradayRequest() {
    }

    /** 가장 이른 판단 시각은 개장 이만큼 뒤 — 체결 창과 같은 개장 10분 뒤({@link SessionWindows#OPEN_OFFSET}, 사용자 결정 2026-11-06 — 그 전은 5분). */
    static final Duration AFTER_OPEN = SessionWindows.OPEN_OFFSET;
    /**
     * 가장 늦은 판단 시각은 그 시장의 장중 거래가 끝나는 때(미국 마감, 한국 종가 단일가 시작 — 마감 {@link KrTimedLadder#CLOSING_AUCTION} 전)보다
     * 이만큼 앞(끈 판의 장중 확인과 같은 30분 — 호출 창 + 응답 뒤 장중 시장가가 들어갈 여유).
     */
    static final Duration BEFORE_CLOSE = ExecutionSection.CHECKPOINT_BEFORE_CLOSE;
    /** 같은 계좌의 두 판단 시각 사이의 최소 간격(사용자 결정 2026-11-06 — 20분, 그 전은 30분). 호출 창 길이(2~20분, 18분)보다 길어 두 창이 겹치지 않습니다. */
    static final Duration MIN_GAP = Duration.ofMinutes(20);

    /**
     * 받은 예약 하나.
     *
     * @param at    확인 시각(그 시장 현지 시각)
     * @param feed  볼 자료(MINUTE·HOURLY)
     * @param watch 감시 목록(받은 순서)
     */
    record Item(LocalTime at, String feed, List<String> watch, String question) {

        Item {
            watch = List.copyOf(watch);
        }
    }

    /** 버린 예약 하나 — 받은 시각 글자(없으면 null)와 사유. */
    record Rejected(String at, String reason) {
    }

    /**
     * 검사 결과 — 받은 예약(시각 순)과 버린 예약.
     */
    record Verdict(List<Item> accepted, List<Rejected> rejected) {

        Verdict {
            accepted = List.copyOf(accepted);
            rejected = List.copyOf(rejected);
        }
    }

    /** 그 세션에서 장중 판단 시각으로 받는 범위 — {@code first} 이상 {@code last} 이하. */
    record Window(Instant first, Instant last) {

        boolean accepts(Instant at) {
            return at != null && !at.isBefore(first) && !at.isAfter(last);
        }
    }

    static Window window(LocalDate session, TradingCalendar calendar, boolean korea) {
        Instant end = korea ? calendar.closeInstant(session).minus(KrTimedLadder.CLOSING_AUCTION) : calendar.closeInstant(session);
        return new Window(calendar.openInstant(session).plus(AFTER_OPEN), end.minus(BEFORE_CLOSE));
    }

    /**
     * 예약 목록을 봅니다.
     *
     * @param requests 응답의 {@code checkpoints} 배열(또는 {@code nextCheckpoint} 하나를 담은 배열) — null·배열이 아니면 예약 없음
     * @param session  목표 세션 E
     * @param universe 감시할 수 있는 티커(관측치 종목 + 보유)
     * @param now      검사 시각(결정을 쓰는 때)
     * @param max      이번에 받을 수 있는 예약 수(세션당 횟수에서 이미 끝났거나 남겨 둘 판단을 뺀 수 — 0이면 모두 버림)
     * @param taken    그 세션에서 이미 정해진 판단 시각(끝난 판단·남겨 둘 예약) — 새 예약은 이 시각들과도 간격을 지켜야 함
     * @param korea    한국 계좌인가(피드는 늘 MINUTE, 사유 문구의 시간대)
     */
    static Verdict validate(JsonNode requests, LocalDate session, TradingCalendar calendar, Set<String> universe, Instant now,
                            int max, List<LocalTime> taken, boolean korea) {
        List<Item> accepted = new ArrayList<>();
        List<Rejected> rejected = new ArrayList<>();
        if (requests == null || !requests.isArray()) {
            return new Verdict(accepted, rejected);
        }
        String zone = korea ? " KST" : " ET";
        Window window = window(session, calendar, korea);
        List<Item> candidates = new ArrayList<>();
        for (JsonNode request : requests) {
            String atText = text(request, "at");
            LocalTime at = FreeTiming.parse(atText);
            List<String> reasons = new ArrayList<>();
            if (at == null) {
                reasons.add("확인 시각 " + atText + "은 HH:MM 모양이 아님");
            } else {
                Instant target = FreeTiming.at(session, at, calendar);
                if (!window.accepts(target)) {
                    reasons.add("확인 시각 " + atText + zone + "가 " + session + " 받는 범위("
                            + FreeTiming.label(window.first().atZone(calendar.zone()).toLocalTime()) + "~"
                            + FreeTiming.label(window.last().atZone(calendar.zone()).toLocalTime()) + zone + ") 밖");
                } else if (!target.plus(PaperCheckpointJob.WINDOW_START).isAfter(now)) {
                    reasons.add("확인 시각 " + atText + zone + " + " + PaperCheckpointJob.WINDOW_START_MINUTES + "분(호출 창 시작)이 이미 지남");
                }
            }
            String feed = korea ? ExecutionSection.FEED_MINUTE : text(request, "feed");
            if (feed == null || !ExecutionSection.FEEDS.contains(feed)) {
                reasons.add("피드 " + feed + "는 MINUTE·HOURLY가 아님");
            }
            List<String> watch = new ArrayList<>();
            JsonNode list = request == null ? null : request.get("watch");
            if (list != null && list.isArray()) {
                list.forEach(t -> watch.add(t.isString() ? t.asString() : t.toString()));
            }
            if (ExecutionSection.FEED_MINUTE.equals(feed) && watch.isEmpty()) {
                reasons.add("MINUTE인데 감시 목록이 비어 있음");
            }
            if (watch.size() > ExecutionSection.WATCH_MAX) {
                reasons.add("감시 목록 " + watch.size() + "개 — " + ExecutionSection.WATCH_MAX + "개 초과");
            }
            Set<String> seen = new HashSet<>();
            List<String> duplicated = new ArrayList<>();
            List<String> outside = new ArrayList<>();
            for (String ticker : watch) {
                if (!seen.add(ticker)) {
                    if (!duplicated.contains(ticker)) {
                        duplicated.add(ticker);
                    }
                } else if (!universe.contains(ticker)) {
                    outside.add(ticker);
                }
            }
            if (!duplicated.isEmpty()) {
                reasons.add("감시 목록 중복: " + String.join(", ", duplicated));
            }
            if (!outside.isEmpty()) {
                reasons.add("감시 목록의 유니버스 밖 티커: " + String.join(", ", outside));
            }
            String question = text(request, "question");
            if (question == null || question.isBlank()) {
                reasons.add("질문이 비어 있음");
            }
            if (reasons.isEmpty()) {
                candidates.add(new Item(at, feed, watch, question));
            } else {
                rejected.add(new Rejected(atText, OrderValidator.CHECKPOINT_INVALID + " — " + String.join("; ", reasons)));
            }
        }
        // 이른 시각부터 받습니다 — 이미 정해진 시각·앞서 받은 시각과 MIN_GAP 이상 떨어져야 하고, 횟수를 넘는 것은 버립니다.
        candidates.sort(Comparator.comparing(Item::at));
        List<LocalTime> fixed = new ArrayList<>(taken);
        for (Item item : candidates) {
            LocalTime near = fixed.stream().filter(t -> Duration.between(t, item.at()).abs().compareTo(MIN_GAP) < 0).findFirst()
                    .orElse(null);
            if (near != null) {
                rejected.add(new Rejected(FreeTiming.label(item.at()), OrderValidator.CHECKPOINT_INVALID + " — 확인 시각 "
                        + FreeTiming.label(item.at()) + zone + "가 다른 판단 시각 " + FreeTiming.label(near) + "과 " + MIN_GAP.toMinutes()
                        + "분 안"));
            } else if (accepted.size() >= max) {
                rejected.add(new Rejected(FreeTiming.label(item.at()), OrderValidator.CHECKPOINT_INVALID + " — 세션당 장중 판단 횟수("
                        + (taken.size() + max) + "번, 남은 " + max + "번)를 넘음"));
            } else {
                accepted.add(item);
                fixed.add(item.at());
            }
        }
        return new Verdict(accepted, rejected);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || v.isNull() ? null : v.isString() ? v.asString() : v.toString();
    }
}
