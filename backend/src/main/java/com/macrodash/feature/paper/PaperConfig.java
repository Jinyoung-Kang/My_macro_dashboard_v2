package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Objects;

/**
 * 🧪 모의 매매의 배포 설정({@code dashboard.paper.*}, application.yml) — 재기동해야 바뀌는 값만.
 *
 * <p>슬리피지·스탑 비율처럼 화면에서 바꾸는 값은 여기가 아니라 DB 설정 한 행({@link PaperSettingsService})입니다.
 * 여기에는 "언제·얼마로 시작하나"와 "정기 작업을 돌리나"만 둡니다 — 이 둘을 화면에서 바꾸면 이미 쌓인 장부와 맞지 않습니다.
 *
 * <p>값이 틀리면 기동하지 않습니다(RegimeLogService의 기록 시각과 같은 방식). 출발일이 휴장일이면 그날 종가가 없어 벤치마크가
 * 영영 시작하지 않고, 초기 현금이 0 이하면 모든 책이 빈 책이 됩니다 — 조용히 지나가면 몇 주 뒤에야 알게 됩니다.
 *
 * <p><b>한국 책</b>(2단계 명세 §4-13·K25·K38, C1b): {@code dashboard.paper.kr.start-date}(.env {@code PAPER_KR_START_DATE})는 기본값이
 * 없고 비워 둘 수 있습니다 — 비면 한국 초기화·출발이 막히고({@link #krStartDate} null) 미국 기동은 그대로입니다. 기동 때는 <b>형식만</b>
 * 봅니다: 거래일 검사는 한국 초기화와 출발 작업 때 {@code StoreReader.quietly}로 읽은 공휴일 저장본({@code kr_holidays}) +
 * {@code KrxCalendar}로 합니다(기동 때 저장본을 읽으면 DB·수집기에 기대고, 수집을 깨울 수도 있음). 미국 출발일의
 * {@link UsMarketCalendar} 거래일 검사는 미국 키에만 남습니다.
 *
 * @param enabled       false면 정기 작업(리스크 점검·결정·출발일 종가 얼리기)이 일하지 않습니다. 수동 실행(POST run/risk·
 *                      run/decision)은 상관없이 돕니다
 * @param startDate     네 책의 출발(사후 체결) 거래일 — 명세 D2(2026-10-23). 미국 동부 세션 날짜
 * @param initialCash   책마다 시작 현금(달러) — 명세 D1
 * @param krStartDate   한국 네 계좌의 출발 거래일 S(S 22:30 결정 → S+1 시가, K28) — null이면 한국 초기화·출발 막힘
 * @param krInitialCash 한국 계좌마다 시작 현금(원, 정수 원 — 기본 1억, K1)
 */
@Component
public record PaperConfig(boolean enabled, LocalDate startDate, double initialCash, LocalDate krStartDate,
                          BigDecimal krInitialCash) {

    /** 한국 계좌마다 시작 현금 기본값 — 1억 원(명세 K1, 사용자 결정 V3). */
    public static final BigDecimal DEFAULT_KR_INITIAL_CASH = BigDecimal.valueOf(100_000_000);
    /** 장부 금액 열(NUMERIC(18,4), V8)이 담는 정수 자리의 상한 — 이 이상은 저장할 수 없습니다. */
    private static final BigDecimal KR_CASH_LIMIT = BigDecimal.TEN.pow(14);
    /** 한국 출발일이 비었을 때 한국 초기화·출발이 남기는 사유. */
    public static final String KR_START_MISSING = "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 "
            + "비어 있어 한국 초기화·출발을 하지 않습니다";

    public PaperConfig {
        if (startDate == null || !UsMarketCalendar.isTradingDay(startDate)) {
            throw new IllegalStateException("dashboard.paper.start-date는 미국 증시 거래일이어야 합니다: " + startDate);
        }
        if (!(initialCash > 0) || Double.isInfinite(initialCash)) {
            throw new IllegalStateException("dashboard.paper.initial-cash는 0보다 커야 합니다: " + initialCash);
        }
        // 한국 출발일은 null(미정)도 받습니다 — 형식은 문자열을 읽을 때(parseKrStart) 봤고, 거래일 검사는 한국 초기화·출발 때.
        Objects.requireNonNull(krInitialCash, "dashboard.paper.kr.initial-cash가 없습니다");
        if (krInitialCash.signum() <= 0 || krInitialCash.stripTrailingZeros().scale() > 0
                || krInitialCash.compareTo(KR_CASH_LIMIT) >= 0) {
            throw new IllegalStateException("dashboard.paper.kr.initial-cash는 0보다 크고 " + KR_CASH_LIMIT.toPlainString()
                    + "보다 작은 정수(원)여야 합니다: " + krInitialCash.toPlainString());
        }
    }

    /** 미국 값만 정하는 판 — 한국 출발일 미정(한국 초기화·출발 막힘)·한국 초기 현금 기본 1억 원. */
    public PaperConfig(boolean enabled, LocalDate startDate, double initialCash) {
        this(enabled, startDate, initialCash, null, DEFAULT_KR_INITIAL_CASH);
    }

    /**
     * 스프링이 쓰는 생성자. 날짜·금액은 문자열로 받아 직접 읽습니다 — 형식이 틀렸을 때 변환기 오류 대신 무엇을 고칠지 알려 주려고.
     */
    @Autowired
    public PaperConfig(@Value("${dashboard.paper.enabled:true}") boolean enabled,
                       @Value("${dashboard.paper.start-date:2026-10-23}") String startDate,
                       @Value("${dashboard.paper.initial-cash:100000}") double initialCash,
                       @Value("${dashboard.paper.kr.start-date:}") String krStartDate,
                       @Value("${dashboard.paper.kr.initial-cash:100000000}") String krInitialCash) {
        this(enabled, parse(startDate), initialCash, parseKrStart(krStartDate), parseKrCash(krInitialCash));
    }

    /** 한국 출발일이 정해졌는가 — 아니면 한국 초기화·출발을 막습니다(사유 {@link #KR_START_MISSING}, 막는 쪽은 C1c). */
    public boolean krStartConfigured() {
        return krStartDate != null;
    }

    private static LocalDate parse(String text) {
        try {
            return LocalDate.parse(text.trim());
        } catch (DateTimeParseException | NullPointerException e) {
            throw new IllegalStateException("dashboard.paper.start-date 형식이 올바르지 않습니다(예: 2026-10-23): " + text);
        }
    }

    /** 비었으면 null(미정). 아니면 yyyy-MM-dd — 틀리면 기동하지 않습니다(조용히 '미정'으로 읽으면 출발이 왜 막혔는지 모름). */
    static LocalDate parseKrStart(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.trim());
        } catch (DateTimeParseException e) {
            throw new IllegalStateException("dashboard.paper.kr.start-date(PAPER_KR_START_DATE) 형식이 올바르지 않습니다"
                    + "(예: 2026-11-30, 비우면 한국 책 출발을 막음): " + text);
        }
    }

    private static BigDecimal parseKrCash(String text) {
        try {
            return new BigDecimal(text.trim());
        } catch (NumberFormatException | NullPointerException e) {
            throw new IllegalStateException("dashboard.paper.kr.initial-cash 형식이 올바르지 않습니다(예: 100000000): " + text);
        }
    }
}
