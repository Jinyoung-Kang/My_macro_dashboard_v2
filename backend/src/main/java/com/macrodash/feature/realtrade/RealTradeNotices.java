package com.macrodash.feature.realtrade;

import com.macrodash.store.RealTradeStore;
import tools.jackson.databind.JsonNode;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * 실제 매매 텔레그램 글(명세 §7.4 — 사용자 결정 2026-11-06 '건수·상태만'). 글은 고정 문구 + 상태 + 건수 + 사유 코드뿐이고 <b>종목·수량·금액·계좌 식별자를
 * 쓰지 않습니다</b> — 이벤트 detail에 무엇이 들어 있든 여기서 읽는 칸은 사유 코드(코드 모양일 때만)·창 이름·건수(정수)뿐입니다. 서식은 모의 알림과 같은
 * 텔레그램 HTML(한 줄 안의 {@code <b>}만 — {@code PaperTelegram}이 서식 거절 때 평문으로 다시 보냄). 이모지 없음.
 */
final class RealTradeNotices {

    private RealTradeNotices() {
    }

    static final String PREFIX = "[실제 매매] ";
    /** 이벤트 종류 — 저장소 목록 밖에 이 기능이 쓰는 것. */
    static final String EVENT_STOPPED = "STOPPED";
    static final String EVENT_SKIPPED = "SKIPPED";
    /** 취소를 상한까지 보내도 이 기능의 토스 주문이 살아 있음 — 사람이 앱에서 취소(건수만). */
    static final String EVENT_CANCEL_GAVE_UP = "CANCEL_GAVE_UP";
    /** 장중 스탑 매도(ADR 0033 초안 결정 2) — 한 주기의 보냄·막힘·놓침 건수만(종목·수량 없음). */
    static final String EVENT_STOP_SELL = "STOP_SELL";

    private static final Pattern CODE = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern KIND = Pattern.compile("^[A-Z][A-Z_]{1,39}$");

    /** 창 요약의 창 이름(명세 §7.4 예 '시가 맞추기'). */
    private static final Map<String, String> WINDOW_LABEL = Map.of(
            RealTradePlanner.WINDOW_SYNC, "시가 맞추기",
            RealTradePlanner.WINDOW_SYNC_AT, "개장 10분 뒤 맞추기",
            RealTradePlanner.WINDOW_FOLLOWUP, "시가 뒤 마무리",
            RealTradePlanner.WINDOW_MIRROR, "장중 따라 하기",
            RealTradePlanner.WINDOW_CLOSE, "종가 따라 하기");

    /** 이벤트 → 글. 알릴 글이 없는 종류면 null(보낸 것으로 표시). */
    static String text(RealTradeStore.Event event) {
        JsonNode detail = event.detail();
        String kind = event.kind() == null ? "" : event.kind();
        return switch (kind) {
            case RealTradeStore.EVENT_HALT -> title("멈춤") + "\n사유: " + code(detail, "reason");
            case RealTradeStore.EVENT_BUYS_PAUSED -> title("매수 멈춤") + "\n사유: " + code(detail, "reason");
            case RealTradeStore.EVENT_SKIP_DAY -> title("오늘 쉼") + "\n사유: " + code(detail, "reason");
            case RealTradeStore.EVENT_WINDOW_SUMMARY -> title(windowLabel(detail)) + "\n" + counts(detail);
            case RealTradeStore.EVENT_ENABLE -> title("켜짐") + "\n다음 맞추기부터 따라 합니다";
            case RealTradeStore.EVENT_DISABLE -> title("끄기") + "\n새 주문 멈춤 · 미체결 취소 중";
            case EVENT_STOPPED -> title("꺼짐") + "\n" + stopped(detail) + unresolved(detail);
            case EVENT_STOP_SELL -> title("스탑 매도") + "\n보냄 " + count(detail, "sent") + " · 막힘 " + count(detail, "blocked") + " · 놓침 "
                    + count(detail, "missed");
            case EVENT_CANCEL_GAVE_UP -> title("취소 못 함") + "\n" + count(detail, "count") + "건 — 토스증권 앱에서 직접 취소하세요";
            case RealTradeStore.EVENT_UPDATE -> title("설정 바뀜");
            case RealTradeStore.EVENT_RESUME -> title("멈춤 해제");
            case RealTradeStore.EVENT_RESTORED -> title("복원 뒤 멈춤") + "\n사유: restored";
            case RealTradeStore.EVENT_PASSWORD_FAILED -> title("비밀번호 틀림") + "\n연속 " + count(detail, "consecutive") + "회"
                    + (detail != null && detail.path("locked").asBoolean(false) ? " · 30분 잠금" : "");
            case EVENT_SKIPPED -> title("건너뜀") + "\n사유: " + code(detail, "reason") + " · " + count(detail, "count") + "건";
            default -> KIND.matcher(kind).matches() ? title(kind) : null;
        };
    }

    private static String title(String label) {
        return "<b>" + PREFIX + label + "</b>";
    }

    private static String windowLabel(JsonNode detail) {
        String window = detail == null ? null : detail.path("window").asString(null);
        return window == null ? "창 요약" : WINDOW_LABEL.getOrDefault(window, "창 요약");
    }

    private static String counts(JsonNode detail) {
        return "접수 " + count(detail, "accepted") + " · 체결 " + count(detail, "filled") + " · 놓침 " + count(detail, "missed")
                + " · 건너뜀 " + count(detail, "skipped") + " · 막힘 " + count(detail, "blocked") + " · 미룸 " + count(detail, "deferred");
    }

    /** 끈 뒤 끝난 이 기능의 주문을 끝난 방식으로 나눈 건수(정리 결과를 단정하지 않게 — '그 밖'은 있을 때만). */
    private static String stopped(JsonNode detail) {
        int other = count(detail, "other");
        return "취소로 끝남 " + count(detail, "canceled") + " · 체결로 끝남 " + count(detail, "filled") + (other > 0 ? " · 그 밖 " + other : "");
    }

    private static String unresolved(JsonNode detail) {
        int n = count(detail, "unresolved");
        return n > 0 ? "\n확인 필요 " + n + "건" : "";
    }

    /** 정수 건수 — 정수가 아니면 0(글에 다른 값이 실리지 않게). */
    private static int count(JsonNode detail, String field) {
        JsonNode node = detail == null ? null : detail.get(field);
        return node != null && node.isIntegralNumber() && node.canConvertToInt() ? Math.max(0, node.asInt()) : 0;
    }

    /** 사유 코드 — 코드 모양일 때만(아니면 'unknown'). */
    private static String code(JsonNode detail, String field) {
        JsonNode node = detail == null ? null : detail.get(field);
        if (node == null || !node.isString()) {
            return "unknown";
        }
        String value = node.asString();
        return CODE.matcher(value).matches() ? value : "unknown";
    }
}
