package com.macrodash.feature.realtrade;

/**
 * 실제 매매 API의 거절(명세 §7.2) — HTTP 상태와 사유 코드({@code not-supported}·{@code version-conflict}·{@code confirm-mismatch}·
 * {@code password-invalid}·{@code password-locked} …). {@link RealTradeController}가 {@code {ok:false, error:<코드>, message}}로 옮깁니다.
 * 메시지는 화면에 그대로 보이므로 예외 원문·금액·계좌 값을 담지 않습니다.
 */
class RealTradeException extends RuntimeException {

    private final int status;
    private final String code;

    RealTradeException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    int status() {
        return status;
    }

    String code() {
        return code;
    }
}
