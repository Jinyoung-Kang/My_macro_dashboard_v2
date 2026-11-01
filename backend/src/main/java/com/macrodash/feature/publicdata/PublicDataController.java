package com.macrodash.feature.publicdata;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 국내 공공 API(공공데이터포털·Open DART)로 모은 데이터.
 *
 * <p>메뉴별 컨트롤러와 나눈 이유 — 출처와 키가 같은 것끼리 묶어 두면, 키가 없을 때
 * 어떤 화면이 비는지가 이 파일 하나로 보입니다.
 */
@RestController
@RequestMapping("/api")
public class PublicDataController {

    private final CalendarService calendar;
    private final KrFundamentalsService fundamentals;
    private final KrMarketService market;
    private final PublicApiStatusService publicApis;

    public PublicDataController(CalendarService calendar,
                                KrFundamentalsService fundamentals,
                                KrMarketService market,
                                PublicApiStatusService publicApis) {
        this.calendar = calendar;
        this.fundamentals = fundamentals;
        this.market = market;
        this.publicApis = publicApis;
    }

    /** 한국 공휴일 (천문연 특일정보) — 시계의 KRX 휴장 판정용. */
    @GetMapping("/calendar/kr-holidays")
    public Map<String, Object> krHolidays() {
        return calendar.krHolidays();
    }

    /**
     * 국내 종목 재무 안정성·성장성 (DART 사업보고서).
     *
     * @param codes 쉼표로 구분한 6자리 종목코드 (최대 60개, 형식이 틀린 코드는 무시)
     */
    @GetMapping("/kr/fundamentals")
    public Map<String, Object> krFundamentals(@RequestParam(defaultValue = "") String codes) {
        return fundamentals.fundamentals(codes);
    }

    /**
     * 시장별 시가총액·거래대금 합계 (금융위 공식 시세).
     *
     * @param days 조회 기간(일, 20~400)
     */
    @GetMapping("/kr/market-totals")
    public Map<String, Object> krMarketTotals(@RequestParam(defaultValue = "180") int days) {
        return market.totals(days);
    }

    /**
     * 국내 공공 API 연결 진단 — 키를 넣은 뒤 어느 서비스가 승인됐는지 확인용.
     *
     * <p>누를 때마다 API당 1회씩 실제로 호출합니다(화면이 자동으로 부르지 않음).
     * 응답에는 키가 없고, 설정 여부와 키가 지워진 실패 사유만 있습니다.
     */
    @GetMapping("/status/public-apis")
    public Map<String, Object> publicApiDiagnostics() {
        return publicApis.diagnostics();
    }
}
