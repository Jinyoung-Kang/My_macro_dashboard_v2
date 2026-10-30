package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 🧪 아침 결정의 장중 확인 요청({@code checkpoint}) 의미 검사 — 계좌2 명세 §9-5·§10-5의 {@link OrderValidator#CHECKPOINT_INVALID}(시각·감시 목록·피드).
 * 스키마가 칸의 모양(시각 enum·피드 enum·감시 ≤10·질문 ≤300자)을 보고, 여기서는 조건부 규칙과 그 세션에 맞는지를 봅니다 — API용 스키마는 제약을
 * 걷어 내므로(ADR 0018 결정 1) 스키마가 막는 것도 다시 봅니다.
 *
 * <ul>
 *   <li>시각: 고를 수 있는 시각({@link ExecutionSection#CHECKPOINT_TIMES})이고, 그 세션 마감 − 30분 이하(조기 폐장일 12:30까지), 시각 + 2분(호출 창
 *       시작)이 아직 오지 않음(늦은 수동 결정).</li>
 *   <li>감시 목록: MINUTE면 한 개 이상, 중복 없음, 유니버스(관측치 종목 + 보유) 안, {@value ExecutionSection#WATCH_MAX}개 이하.</li>
 *   <li>피드: MINUTE · HOURLY. 질문은 공백만이 아님.</li>
 * </ul>
 *
 * <p>실패해도 아침 주문 판정은 그대로이고, 그 세션의 장중 확인 행만 SKIPPED({@code CHECKPOINT_INVALID — 사유})입니다
 * ({@link ClaudeBookService}의 계획 쓰기). 순수 함수입니다(시계·저장소를 읽지 않음).
 */
final class CheckpointRequest {

    private CheckpointRequest() {
    }

    /**
     * 검사 결과.
     *
     * @param reasons 거절 사유(한국어 한 줄씩) — 비면 통과
     */
    record Verdict(List<String> reasons) {

        Verdict {
            reasons = List.copyOf(reasons);
        }

        boolean accepted() {
            return reasons.isEmpty();
        }

        /** 계획 행의 사유 — {@code CHECKPOINT_INVALID — 사유1; 사유2}. 통과면 null. */
        String reason() {
            return accepted() ? null : OrderValidator.CHECKPOINT_INVALID + " — " + String.join("; ", reasons);
        }
    }

    /**
     * 요청 하나를 봅니다.
     *
     * @param checkpoint 응답의 checkpoint 객체
     * @param session    목표 세션 E
     * @param calendar   미국 달력(시장 묶음의 것)
     * @param universe   감시할 수 있는 티커(관측치 종목 + 보유)
     * @param now        검사 시각(결정을 쓰는 때)
     */
    static Verdict validate(JsonNode checkpoint, LocalDate session, TradingCalendar calendar, Set<String> universe,
                            Instant now) {
        List<String> reasons = new ArrayList<>();
        String atText = text(checkpoint, "atEt");
        LocalTime at = null;
        try {
            at = atText == null ? null : LocalTime.parse(atText);
        } catch (DateTimeParseException e) {
            at = null;
        }
        if (at == null || !ExecutionSection.CHECKPOINT_TIMES.contains(at)) {
            reasons.add("확인 시각 " + atText + "은 고를 수 있는 시각(10:00~15:00 ET 30분 단위)이 아님");
        } else {
            Instant target = ZonedDateTime.of(session, at, calendar.zone()).toInstant();
            Instant last = calendar.closeInstant(session).minus(ExecutionSection.CHECKPOINT_BEFORE_CLOSE);
            if (target.isAfter(last)) {
                reasons.add("확인 시각 " + atText + " ET가 " + session + " 마감 30분 전("
                        + CheckpointPacket.clock(last.atZone(calendar.zone()).toLocalTime()) + " ET"
                        + (calendar.isEarlyClose(session) ? " — 조기 폐장일" : "") + ") 뒤");
            }
            if (!target.plus(PaperCheckpointJob.WINDOW_START).isAfter(now)) {
                reasons.add("확인 시각 " + atText + " ET + " + PaperCheckpointJob.WINDOW_START_MINUTES
                        + "분(호출 창 시작)이 이미 지남");
            }
        }
        String feed = text(checkpoint, "feed");
        if (!ExecutionSection.FEEDS.contains(feed)) {
            reasons.add("피드 " + feed + "는 MINUTE·HOURLY가 아님");
        }
        List<String> watch = new ArrayList<>();
        JsonNode list = checkpoint == null ? null : checkpoint.get("watch");
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
        String question = text(checkpoint, "question");
        if (question == null || question.isBlank()) {
            reasons.add("질문이 비어 있음");
        }
        return new Verdict(reasons);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || v.isNull() ? null : v.isString() ? v.asString() : v.toString();
    }
}
