package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperTelegram;
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
 * (정수)·세션 날짜뿐입니다. 서식은 모의 알림과 같은 텔레그램 MarkdownV2(굵은 제목, 본문은 이스케이프해 넣음 — {@code PaperTelegram}이 서식
 * 거절 때 평문으로 다시 보냄). 이모지 없음. 토스 실제 매매 알림({@link RealTradeNotices} — 건수·상태만)과 다른 예외입니다.
 */
final class ManualAccountNotices {

    private ManualAccountNotices() {
    }

    static final String PREFIX = "[ISA 계좌] ";
    private static final Pattern SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");
    /** 장전 동시호가 길이 — 개장 30분 전부터(보통 08:30~09:00, 장 시간 변경일은 그 개장 시각 기준). */
    private static final long AUCTION_MINUTES = 30;
    /** 매매 뒤 할 일(이 시스템은 다른 증권사의 실제 매매를 볼 수 없음). */
    private static final String CONFIRM_GUIDE = "매매했으면 ISA 계좌 탭에서 '확인'을 누르세요 — 체결 값이 다르면 매매 내역의 '고치기'로 고치세요.";

    /**
     * 지시 글(개장 전 08:00 한 통). {@code at}이 있으면 시각 맞추기 지시(ADR 0033 결정 7 — 제목 'MM/DD(요일) HH:MM 매매 지시', 끝줄 'HH:MM 이후 시장가'), 없으면 시가 지시 글.
     *
     * @param session 매매할 세션(제목의 날짜)
     * @param open    그 세션 개장 시각(KST 벽시계 — 장전 동시호가 안내), 모르면 null(기본 09:00)
     * @param at      지시 시각(KST 벽시계 — 규칙 계좌가 체결하는 시각, 보통 날 09:10), 시가 지시면 null
     * @param items   지시(만든 순서 — 매도 → 매수)
     * @param names   종목 코드 → 이름(모르면 코드만)
     */
    static String text(LocalDate session, LocalTime open, LocalTime at, List<Instruction> items, Map<String, String> names) {
        return text(session, open, at, items, names, false);
    }

    /** 손절 매도 지시만 만든 세션(현금 음수 — QA-381 후속)의 지시 글에 덧붙는 안내 — 고정 문구(금액 없음). */
    private static final String STOP_ONLY_NOTE = "규칙 계좌가 트레일링 스탑(손절)으로 파는 종목입니다 — 손절 매도는 현금이 음수여도 지시합니다.\n"
            + "ISA 잔고의 현금이 음수라 나머지 매매 지시는 만들지 않았습니다.\n"
            + "ISA 계좌 탭에서 잔고(현금·보유)를 확인해 고치세요 — 개장 전에 고치면(반영에 10분쯤 걸림) 나머지 지시를 만들어 다시 알립니다.";

    /**
     * 지시 글 — {@code stopOnly}가 참이면 손절 매도 지시만 만든 세션의 글입니다(QA-381 후속 — ADR 0034 결정 5 개정의 덧붙임): 제목이 '시가 손절 매도 지시'·
     * 'HH:MM 손절 매도 지시'이고 지시 줄과 매매 안내 사이에 '현금이 음수라 나머지 지시는 만들지 않았다'는 고정 안내가 들어갑니다. 줄 형식(방향·종목 코드·이름·수량)과
     * 매매 안내는 평소 지시 글 그대로입니다. 거짓이면 위 글과 같습니다.
     */
    static String text(LocalDate session, LocalTime open, LocalTime at, List<Instruction> items, Map<String, String> names, boolean stopOnly) {
        LocalTime start = open == null ? LocalTime.of(9, 0) : open;
        String label = stopOnly ? "손절 매도 지시" : "매매 지시";
        String title = title(session, at == null ? "시가 " + label : hhmm(at) + " " + label);
        StringBuilder lines = new StringBuilder();
        for (Instruction i : items) {
            if (i.symbol() == null || !SYMBOL.matcher(i.symbol()).matches() || i.quantity() <= 0) {
                continue;
            }
            String side = ManualAccountStore.SIDE_SELL.equals(i.side()) ? "매도" : ManualAccountStore.SIDE_BUY.equals(i.side()) ? "매수" : null;
            if (side == null) {
                continue;
            }
            lines.append(line(side, i.symbol(), names, i.quantity()));
        }
        String guide = at != null
                ? hhmm(at) + " 이후 시장가로 내면 규칙 계좌와 같은 때(" + hhmm(at) + ")에 체결됩니다.\n그때 서킷브레이커·VI가 걸려 있으면 풀린 뒤 시장가로 내세요.\n장중 스탑이 걸리면 따로 알립니다.\n" + CONFIRM_GUIDE
                : "장전 동시호가(" + hhmm(start.minusMinutes(AUCTION_MINUTES)) + "~" + hhmm(start) + ")에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다.\n" + CONFIRM_GUIDE;
        return message(title, lines.toString().strip() + "\n\n" + (stopOnly ? STOP_ONLY_NOTE + "\n\n" : "") + guide);
    }

    /** 지시 한 줄 — 방향·종목 코드·이름·수량(앞에 줄바꿈 없이 끝에 줄바꿈). */
    private static String line(String side, String symbol, Map<String, String> names, int quantity) {
        String name = names.get(symbol);
        return "• " + side + " " + symbol + (name != null && !name.isBlank() ? " " + name.strip() : "") + " " + quantity + "주\n";
    }

    /** 굵은 제목 + 빈 줄 + 이스케이프한 본문. */
    private static String message(String title, String body) {
        return title + "\n\n" + PaperTelegram.esc(body);
    }

    /** 확인 알림의 한 줄 — 방향·종목 코드·수량. */
    record ReminderLine(String side, String symbol, int quantity) {
    }

    /**
     * 장 중반·마감 30분 전 매매 확인 알림 글(ADR 0034 — ADR 0029 결정 4의 예외 안: 종목 코드·이름·수량만, 금액·기준가·평가액 없음). 제목 'MM/DD(요일) 매매 확인'(마감 전이면
     * '마감 전 매매 확인'), 줄마다 '매도 코드 이름 n주', 끝에 할 일. 보일 줄이 없으면 null(보내지 않음).
     */
    static String reminder(LocalDate session, boolean preclose, List<ReminderLine> items, Map<String, String> names) {
        StringBuilder lines = new StringBuilder();
        for (ReminderLine i : items) {
            if (i.symbol() == null || !SYMBOL.matcher(i.symbol()).matches() || i.quantity() <= 0) {
                continue;
            }
            String side = ManualAccountStore.SIDE_SELL.equals(i.side()) ? "매도" : ManualAccountStore.SIDE_BUY.equals(i.side()) ? "매수" : null;
            if (side == null) {
                continue;
            }
            lines.append(line(side, i.symbol(), names, i.quantity()));
        }
        if (lines.isEmpty()) {
            return null;
        }
        return message(title(session, preclose ? "마감 전 매매 확인" : "매매 확인"), (preclose ? "마감 30분 전까지" : "장 중반까지") + " '확인'을 누르지 않은 지시입니다.\n\n" + lines.toString().strip()
                + "\n\n아직 안 했으면 지금 시장가로 내세요.\n이미 했으면 ISA 계좌 탭에서 '확인'을 누르세요(이 시스템은 실제 매매를 볼 수 없습니다).");
    }

    /**
     * 현금이 음수라 그 세션의 매매 지시를 만들지 않았다는 글(QA-381 — ADR 0034 결정 5 개정). 고정 문구와 세션 날짜뿐입니다 — 현금·평가액·종목·수량을 받지도 쓰지도
     * 않습니다(ADR 0029 결정 4). 손절 매도 지시는 현금이 음수여도 만들므로(QA-381 후속) 이 글은 그 안내를 실어 보낼 지시 글이 없는 세션에만 갑니다:
     * {@code stopOnly}가 거짓이면 지시할 손절 매도가 없던 세션('매매 지시 없음'), 참이면 손절 지시는 만들었지만 알림 전에 모두 닫힌 세션('나머지 매매 지시 없음').
     */
    static String cashNegative(LocalDate session, boolean stopOnly) {
        if (stopOnly) {
            return message(title(session, "나머지 매매 지시 없음"), "ISA 잔고의 현금이 음수라 이 세션은 손절 매도 지시만 만들고 나머지 매매 지시는 만들지 않았습니다.\n"
                    + "ISA 계좌 탭에서 잔고(현금·보유)를 확인해 고치세요 — 개장 전에 고치면(반영에 10분쯤 걸림) 나머지 지시를 만들어 알립니다.\n"
                    + "장중 스탑 매도 지시는 감지되면 그대로 알립니다.");
        }
        return message(title(session, "매매 지시 없음"), "ISA 잔고의 현금이 음수라 이 세션의 매매 지시를 만들지 않았습니다.\n"
                + "ISA 계좌 탭에서 잔고(현금·보유)를 확인해 고치세요 — 개장 전에 고치면(반영에 10분쯤 걸림) 지시를 만들어 다시 알립니다.\n"
                + "규칙 계좌의 손절(트레일링 스탑) 매도는 현금이 음수여도 지시합니다 — 지금은 이 세션에 지시할 손절 매도가 없습니다. 장중 스탑 매도 지시도 감지되면 그대로 알립니다.");
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
            ("NEXT_CLOSE".equals(s.timing()) ? closing : intraday).append(line("매도", s.symbol(), names, s.quantity()));
        }
        StringBuilder out = new StringBuilder();
        if (!intraday.isEmpty()) {
            out.append(intraday.toString().strip()).append("\n규칙 계좌가 트레일링 스탑으로 팔았습니다 — 지금 시장가로 매도하세요(개장 10분 전이면 ")
                    .append(hhmm(start)).append(" 이후).\n\n");
        }
        if (!closing.isEmpty()) {
            out.append(closing.toString().strip()).append("\n규칙 계좌가 트레일링 스탑으로 오늘 종가에 팝니다 — 종가 단일가(")
                    .append(hhmm(end.minusMinutes(CLOSING_AUCTION_MINUTES))).append('~').append(hhmm(end)).append(")에 시장가로 매도하세요.\n\n");
        }
        out.append(CONFIRM_GUIDE);
        return message(title(session, "스탑 매도 지시"), out.toString());
    }

    private static String title(LocalDate session, String label) {
        return PaperTelegram.bold(PREFIX + String.format(Locale.ROOT, "%02d/%02d", session.getMonthValue(), session.getDayOfMonth()) + '('
                + session.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.KOREAN) + ") " + label);
    }

    /** 개장 순간 → KST 벽시계(모르면 null). */
    static LocalTime wallClock(Instant open) {
        return open == null ? null : open.atZone(Kst.ZONE).toLocalTime();
    }

    static String hhmm(LocalTime time) {
        return String.format(Locale.ROOT, "%02d:%02d", time.getHour(), time.getMinute());
    }
}
