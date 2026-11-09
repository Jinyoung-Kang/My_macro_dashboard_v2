package com.macrodash.feature.realtrade;

/**
 * ISA 계좌 API의 거절(ADR 0029 — 명세 §5) — HTTP 상태와 사유 코드(400 {@code invalid-request}·{@code ledger-invalid}, 404 {@code not-found},
 * 409 {@code already-started}·{@code not-started}·{@code already-recorded} — 직접 입력한 체결이 이미 묶인 지시에 새 행을 묶음).
 * {@link ManualAccountController}가 {@code {ok:false, error:<코드>, message}}로 옮깁니다.
 * 메시지는 화면에 그대로 보이므로 예외 원문·계좌 값을 담지 않습니다.
 */
class ManualAccountException extends RuntimeException {

    static final String INVALID_REQUEST = "invalid-request";
    static final String LEDGER_INVALID = "ledger-invalid";
    /** 고치기·지우기가 현금을 음수로 만듦 — 사용자가 확인하면 저장할 수 있는 거절(QA-337). */
    static final String LEDGER_CASH_NEGATIVE = "ledger-cash-negative";
    static final String NOT_FOUND = "not-found";
    static final String ALREADY_STARTED = "already-started";
    static final String NOT_STARTED = "not-started";
    static final String ALREADY_RECORDED = "already-recorded";

    private final int status;
    private final String code;

    ManualAccountException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    static ManualAccountException invalid(String message) {
        return new ManualAccountException(400, INVALID_REQUEST, message);
    }

    static ManualAccountException ledgerInvalid(String message) {
        return new ManualAccountException(400, LEDGER_INVALID, message);
    }

    static ManualAccountException ledgerCashNegative(String message) {
        return new ManualAccountException(400, LEDGER_CASH_NEGATIVE, message);
    }

    static ManualAccountException notFound(String message) {
        return new ManualAccountException(404, NOT_FOUND, message);
    }

    int status() {
        return status;
    }

    String code() {
        return code;
    }
}
