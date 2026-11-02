package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
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
 * 한국 Claude 계좌2 밤 결정의 장중 확인 요청({@code checkpoint}) 의미 검사 — 단계 2b(명세 docs/specs/2026-11-02-kr-claude2-stage2.md §5·§10). 미국
 * {@link CheckpointRequest}의 한국판이고 결과 모양({@link CheckpointRequest.Verdict} — 사유 {@code CHECKPOINT_INVALID — …})이 같습니다. 스키마가 칸의
 * 모양(시각 enum·감시 ≤10·질문 ≤300자)을 보고, 여기서는 조건부 규칙과 그 세션에 맞는지를 봅니다 — API용 스키마는 제약을 걷어 내므로 다시 봅니다.
 *
 * <ul>
 *   <li>시각({@code atKst}): {@link #TIMES}(10:00~15:00 KST 30분 단위)이고, 그날 개장 + 30분 이상·마감 − 30분 이하(장 시간 변경일 — 그 실행 달력),
 *       시각 + 2분(호출 창 시작)이 아직 오지 않음.</li>
 *   <li>감시 목록: 한 개 이상(한국 확인은 늘 1분봉 — 시간별 관측치가 없음), {@value ExecutionSection#WATCH_MAX}개 이하, 중복 없음, 유니버스(관측치 종목 +
 *       보유) 안.</li>
 *   <li>질문은 공백만이 아님.</li>
 * </ul>
 *
 * <p>실패해도 밤 주문 판정은 그대로이고, 그 세션의 장중 확인 행만 SKIPPED입니다. 순수 함수입니다(시계·저장소를 읽지 않음).
 */
final class KrCheckpointRequest {

    private KrCheckpointRequest() {
    }

    /** 요청의 시각 칸 이름. */
    static final String AT_FIELD = "atKst";
    /** 한국 확인의 피드 — 늘 감시 1분봉(행의 feed 칸 값). */
    static final String FEED = ExecutionSection.FEED_MINUTE;
    /** 고를 수 있는 확인 시각(KST) — 10:00~15:00 30분 단위. 응답 스키마의 enum·고정 문단과 같은 목록입니다. */
    static final List<LocalTime> TIMES = times();
    /** 개장 뒤 이만큼 지나야 확인 시각으로 받음(장 시간 변경일 — 1분봉이 쌓일 여유). */
    static final Duration AFTER_OPEN = Duration.ofMinutes(30);
    /** 마감 이만큼 전까지만(미국 {@link ExecutionSection#CHECKPOINT_BEFORE_CLOSE}와 같은 30분). */
    static final Duration BEFORE_CLOSE = ExecutionSection.CHECKPOINT_BEFORE_CLOSE;

    private static List<LocalTime> times() {
        List<LocalTime> out = new ArrayList<>();
        for (LocalTime t = LocalTime.of(10, 0); !t.isAfter(LocalTime.of(15, 0)); t = t.plusMinutes(30)) {
            out.add(t);
        }
        return List.copyOf(out);
    }

    /** 확인 시각 T(그 세션 날짜의 서울 시각). */
    static Instant targetAt(LocalDate session, LocalTime at) {
        return ZonedDateTime.of(session, at, KrxCalendar.SEOUL).toInstant();
    }

    /**
     * 요청 하나를 봅니다.
     *
     * @param checkpoint 응답의 checkpoint 객체
     * @param session    목표 세션 E(기준 거래일 다음 KRX 거래일)
     * @param calendar   한국 달력(그 실행의 것 — 장 시간 변경일 포함)
     * @param universe   감시할 수 있는 종목(관측치 종목 + 보유)
     * @param now        검사 시각(결정을 쓰는 때)
     */
    static CheckpointRequest.Verdict validate(JsonNode checkpoint, LocalDate session, TradingCalendar calendar,
                                              Set<String> universe, Instant now) {
        List<String> reasons = new ArrayList<>();
        String atText = Json.asText(checkpoint, AT_FIELD);
        LocalTime at;
        try {
            at = atText == null ? null : LocalTime.parse(atText);
        } catch (DateTimeParseException e) {
            at = null;
        }
        if (at == null || !TIMES.contains(at)) {
            reasons.add("확인 시각 " + atText + "은 고를 수 있는 시각(10:00~15:00 KST 30분 단위)이 아님");
        } else {
            Instant target = targetAt(session, at);
            Instant first = calendar.openInstant(session).plus(AFTER_OPEN);
            Instant last = calendar.closeInstant(session).minus(BEFORE_CLOSE);
            if (target.isBefore(first)) {
                reasons.add("확인 시각 " + atText + " KST가 " + session + " 개장 30분 뒤(" + clock(first) + " KST) 전");
            }
            if (target.isAfter(last)) {
                reasons.add("확인 시각 " + atText + " KST가 " + session + " 마감 30분 전(" + clock(last) + " KST) 뒤");
            }
            if (!target.plus(PaperCheckpointJob.WINDOW_START).isAfter(now)) {
                reasons.add("확인 시각 " + atText + " KST + " + PaperCheckpointJob.WINDOW_START_MINUTES + "분(호출 창 시작)이 이미 지남");
            }
        }
        List<String> watch = new ArrayList<>();
        JsonNode list = checkpoint == null ? null : checkpoint.get("watch");
        if (list != null && list.isArray()) {
            list.forEach(t -> watch.add(t.isString() ? t.asString() : t.toString()));
        }
        if (watch.isEmpty()) {
            reasons.add("감시 목록이 비어 있음(한국 장중 확인은 감시 종목의 1분봉으로 봄)");
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
            reasons.add("감시 목록의 유니버스 밖 종목: " + String.join(", ", outside));
        }
        String question = Json.asText(checkpoint, "question");
        if (question == null || question.isBlank()) {
            reasons.add("질문이 비어 있음");
        }
        return new CheckpointRequest.Verdict(reasons);
    }

    private static String clock(Instant instant) {
        return KrTimedLadder.label(instant.atZone(KrxCalendar.SEOUL).toLocalTime());
    }
}
