package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.StopInstruction;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.TextStyle;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * ISA 계좌 지시 알림 글(ADR 0029 결정 4 — 명세 §4, 사용자 결정 2026-11-06 'ISA 지시에 한해 종목 코드·이름·수량 포함'). 글은 고정 문구 + 줄마다 방향·종목
 * 코드·이름·수량뿐이고 <b>금액·평가액·현금·기준가를 쓰지 않습니다</b> — 지시 행에 무엇이 들어 있든 여기서 읽는 칸은 방향·종목 코드(코드 모양일 때만)·수량
 * (정수)·세션 날짜뿐입니다. 서식은 모의 알림과 같은 텔레그램 HTML(한 줄 안의 {@code <b>}만, 이름은 엔티티로 바꿔 넣음 — {@code PaperTelegram}이 서식
 * 거절 때 평문으로 다시 보냄). 이모지 없음. 토스 실제 매매 알림({@link RealTradeNotices} — 건수·상태만)과 다른 예외입니다.
 */
final class ManualAccountNotices {

    private ManualAccountNotices() {
    }

    static final String PREFIX = "[ISA 계좌] ";
    private static final Pattern SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");
    /** 장전 동시호가 길이 — 개장 30분 전부터(보통 08:30~09:00, 장 시간 변경일은 그 개장 시각 기준). */
    private static final long AUCTION_MINUTES = 30;

    /**
     * 지시 글.
     *
     * @param session 매매할 세션(제목의 날짜)
     * @param open    그 세션 개장 시각(KST 벽시계 — 장전 동시호가 안내), 모르면 null(기본 09:00)
     * @param items   지시(만든 순서 — 매도 → 매수)
     * @param names   종목 코드 → 이름(모르면 코드만)
     */
    static String text(LocalDate session, LocalTime open, List<Instruction> items, Map<String, String> names) {
        return text(session, open, items, names, false);
    }

    /**
     * 지시 글 — {@code recalculated}면 장부를 고쳐 다시 계산한 지시(ISA-R4 — 제목에 '(다시 계산)'과 앞서 보낸 지시 대신이라는 줄).
     */
    static String text(LocalDate session, LocalTime open, List<Instruction> items, Map<String, String> names, boolean recalculated) {
        return text(session, open, null, items, names, recalculated);
    }

    /**
     * 지시 글. {@code at}이 있으면 시각 맞추기 지시(ADR 0033 결정 7 — 제목 'MM/DD(요일) HH:MM 매매 지시', 끝줄 'HH:MM 이후 시장가'), 없으면 예전 시가
     * 지시 글(바이트까지 그대로).
     *
     * @param at 지시 시각(KST 벽시계 — 규칙 계좌가 체결하는 시각, 보통 날 09:10), 시가 지시면 null
     */
    static String text(LocalDate session, LocalTime open, LocalTime at, List<Instruction> items, Map<String, String> names,
                       boolean recalculated) {
        LocalTime start = open == null ? LocalTime.of(9, 0) : open;
        StringBuilder out = new StringBuilder(at == null ? title(session, recalculated) : title(session, hhmm(at) + " 매매 지시", recalculated));
        if (recalculated) {
            out.append('\n').append("장부가 바뀌어 다시 계산한 지시입니다 — 앞서 보낸 지시 대신 이 지시를 따르세요.");
        }
        for (Instruction i : items) {
            if (i.symbol() == null || !SYMBOL.matcher(i.symbol()).matches() || i.quantity() <= 0) {
                continue;
            }
            String side = ManualAccountStore.SIDE_SELL.equals(i.side()) ? "매도" : ManualAccountStore.SIDE_BUY.equals(i.side()) ? "매수" : null;
            if (side == null) {
                continue;
            }
            String name = names.get(i.symbol());
            out.append('\n').append(side).append(' ').append(i.symbol());
            if (name != null && !name.isBlank()) {
                out.append(' ').append(escape(name.strip()));
            }
            out.append(' ').append(i.quantity()).append("주");
        }
        if (at != null) {
            out.append('\n').append(hhmm(at)).append(" 이후 시장가로 내면 규칙 계좌와 같은 때(").append(hhmm(at))
                    .append(")에 체결됩니다. 장중 스탑이 걸리면 따로 알립니다. 다르게 매매했으면 화면에서 고치세요.");
            return out.toString();
        }
        out.append('\n').append("장전 동시호가(").append(hhmm(start.minusMinutes(AUCTION_MINUTES))).append('~').append(hhmm(start))
                .append(")에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 다르게 매매했으면 화면에서 고치세요.");
        return out.toString();
    }

    /** 종가 단일가 시간 — 정규장 마감 이만큼 전부터(보통 15:20~15:30, 장 시간 변경일은 그 마감 기준). */
    private static final long CLOSING_AUCTION_MINUTES = 10;
    /** 장중 체결 첫 분 — 개장 이만큼 뒤(보통 09:10 — ADR 0031·0033). */
    private static final long OPEN_OFFSET_MINUTES = 10;

    /**
     * 장중 스탑 매도 지시 글(ADR 0033 결정 7 — ADR 0029 결정 4의 예외 안: 종목 코드·이름·수량만, 금액·기준가·평가액 없음). 제목 'MM/DD(요일) 스탑 매도
     * 지시', 장중 STOP 줄 다음에 '지금 시장가로 매도'(개장 10분 전이면 그 시각 이후), 종가 STOP({@code NEXT_CLOSE}) 줄 다음에 '종가 단일가(마감 10분 전~마감
     * — 보통 15:20~15:30)에 시장가로 매도'(통합 검토 R12 — 장 시간 변경일은 그날 마감 기준, 화면 매도 창 lib/isa stopWindowText와 같음).
     *
     * @param open  그 세션 개장(KST 벽시계, 모르면 09:00)
     * @param close 그 세션 마감(KST 벽시계, 모르면 15:30)
     */
    static String stop(LocalDate session, LocalTime open, LocalTime close, List<StopInstruction> items, Map<String, String> names) {
        LocalTime start = (open == null ? LocalTime.of(9, 0) : open).plusMinutes(OPEN_OFFSET_MINUTES);
        LocalTime end = close == null ? LocalTime.of(15, 30) : close;
        StringBuilder intraday = new StringBuilder();
        StringBuilder closing = new StringBuilder();
        for (StopInstruction s : items) {
            if (s.symbol() == null || !SYMBOL.matcher(s.symbol()).matches() || s.quantity() <= 0) {
                continue;
            }
            StringBuilder line = "NEXT_CLOSE".equals(s.timing()) ? closing : intraday;
            line.append('\n').append("매도 ").append(s.symbol());
            String name = names.get(s.symbol());
            if (name != null && !name.isBlank()) {
                line.append(' ').append(escape(name.strip()));
            }
            line.append(' ').append(s.quantity()).append("주");
        }
        StringBuilder out = new StringBuilder(title(session, "스탑 매도 지시", false));
        if (!intraday.isEmpty()) {
            out.append(intraday).append('\n').append("규칙 계좌가 트레일링 스탑으로 팔았습니다 — 지금 시장가로 매도하세요(개장 10분 전이면 ")
                    .append(hhmm(start)).append(" 이후).");
        }
        if (!closing.isEmpty()) {
            out.append(closing).append('\n').append("규칙 계좌가 트레일링 스탑으로 오늘 종가에 팝니다 — 종가 단일가(")
                    .append(hhmm(end.minusMinutes(CLOSING_AUCTION_MINUTES))).append('~').append(hhmm(end)).append(")에 시장가로 매도하세요.");
        }
        out.append('\n').append("다르게 매매했으면 화면에서 고치세요.");
        return out.toString();
    }

    /** 장부를 고쳐 다시 계산했더니 그 세션에 할 매매가 없음(앞서 보낸 지시를 내지 않게 — ISA-R4). 종목·수량도 없습니다. */
    static String noTrades(LocalDate session) {
        return noTrades(session, null);
    }

    /**
     * {@link #noTrades(LocalDate)}에 지시 시각을 — 개장 10분 뒤 시각 맞추기 세션(세션 기록 {@code targetAt}, ADR 0033 결정 7)이면 제목 '11/10(화) 09:10 매매
     * 지시(다시 계산)'와 '이 세션에 할 매매가 없습니다'(QA-324 — 예전에는 그날도 '시가 매매 지시'·'이 세션 시가에'), {@code at}이 null이면 시가 글 그대로.
     */
    static String noTrades(LocalDate session, LocalTime at) {
        if (at == null) {
            return title(session, true) + "\n장부가 바뀌어 다시 계산했더니 이 세션 시가에 할 매매가 없습니다 — 앞서 보낸 지시는 내지 마세요.";
        }
        return title(session, hhmm(at) + " 매매 지시", true) + "\n장부가 바뀌어 다시 계산했더니 이 세션에 할 매매가 없습니다 — 앞서 보낸 지시는 내지 마세요.";
    }

    private static String title(LocalDate session, boolean recalculated) {
        return title(session, "시가 매매 지시", recalculated);
    }

    private static String title(LocalDate session, String label, boolean recalculated) {
        return "<b>" + PREFIX + String.format(Locale.ROOT, "%02d/%02d", session.getMonthValue(), session.getDayOfMonth()) + '('
                + session.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.KOREAN) + ") " + label + (recalculated ? "(다시 계산)" : "")
                + "</b>";
    }

    /** 개장 순간 → KST 벽시계(모르면 null). */
    static LocalTime wallClock(Instant open) {
        return open == null ? null : open.atZone(Kst.ZONE).toLocalTime();
    }

    static String hhmm(LocalTime time) {
        return String.format(Locale.ROOT, "%02d:%02d", time.getHour(), time.getMinute());
    }

    /** 텔레그램 HTML 엔티티(종목 이름에 &·&lt;·&gt;가 있어도 서식이 깨지지 않게). */
    private static String escape(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
