package com.macrodash.feature.institution;

import com.macrodash.read.ComputedCache;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 기관 13F 포트폴리오 · 13F 교집합 · 기관 13F 스타일·위험.
 *
 * <pre>
 *  GET /api/sec13f/*   기관 목록·포트폴리오·교집합·공통 신규 매수
 *  GET /api/guru/*     기관 성격·유사도·보유 기관 검색·위험 (경로는 호환을 위해 guru 유지)
 * </pre>
 */
@RestController
@RequestMapping("/api")
public class InstitutionController {

    private final Sec13FService sec13f;
    private final GuruService guru;

    private final ComputedCache cache;

    public InstitutionController(Sec13FService sec13f, GuruService guru, ComputedCache cache) {
        this.sec13f = sec13f;
        this.guru = guru;
        this.cache = cache;
    }

    // ------------------------------------------------------- 13F
    @GetMapping("/sec13f/institutions")
    public Map<String, Object> institutions() {
        return Institutions.list();
    }

    @GetMapping("/sec13f/portfolio")
    public Map<String, Object> portfolio(@RequestParam String cik,
                                         @RequestParam(defaultValue = "8") int quarters,
                                         @RequestParam(defaultValue = "30") int topN) {
        // 비중 추이가 8분기 전체 보유를 증권 단위로 묶어(QA-112·121) 요청마다 계산이 커서, 같은 저장본이면 다시 계산하지 않습니다.
        // 추적하지 않는 CIK는 예외(400)라 캐시에 남지 않습니다.
        return cache.get("sec13f.portfolio:" + cik + ":" + quarters + ":" + topN,
                () -> sec13f.portfolio(cik, quarters, topN));
    }

    @GetMapping("/sec13f/consensus")
    public Map<String, Object> consensus(
            @RequestParam(required = false) String ciks,
            @RequestParam(required = false) String reportDate,
            @RequestParam(defaultValue = "2") int minHolders,
            @RequestParam(defaultValue = "30") int topN) {
        List<String> selected = selectedCiks(ciks);
        return cache.get("sec13f.consensus:" + selected + ":" + reportDate + ":" + minHolders + ":" + topN,
                () -> sec13f.consensus(selected, reportDate, minHolders, topN));
    }

    /** 이번 분기에 여러 기관이 함께 새로 담은 종목. */
    @GetMapping("/sec13f/new-buys")
    public Map<String, Object> newBuys(
            @RequestParam(required = false) String ciks,
            @RequestParam(required = false) String reportDate,
            @RequestParam(defaultValue = "3") int minHolders) {
        List<String> selected = selectedCiks(ciks);
        return cache.get("sec13f.newBuys:" + selected + ":" + reportDate + ":" + minHolders,
                () -> sec13f.newBuys(selected, reportDate, minHolders));
    }

    // ------------------------------------------------- 기관 스타일·위험
    /** 기관별 성격 요약 (집중도·유효 종목 수·회전율). */
    @GetMapping("/guru/profiles")
    public Map<String, Object> guruProfiles() {
        return cache.get("guru.profiles", guru::profiles);
    }

    /** 기관 간 유사도 행렬 (겹침 비중 + 코사인). */
    @GetMapping("/guru/similarity")
    public Map<String, Object> guruSimilarity() {
        return cache.get("guru.similarity", guru::similarity);
    }

    /** 이 종목을 누가 들고 있나 (13F 공시 이름 일부로 검색). */
    @GetMapping("/guru/holders")
    public Map<String, Object> guruHolders(@RequestParam(required = false) String q) {
        // 응답은 검색어마다 달라 캐시하지 않고, 검색어와 상관없는 보유 목록만 캐시합니다. 예전에는 요청마다 12개 기관
        // 저장본을 다시 읽어 걸렀고, 파싱 캐시가 빈 재기동 직후에는 서로 다른 검색어가 몰리면 각자 13F 저장본(약 17.7MB)을
        // 다시 풀었습니다(QA-133). 빈 검색어는 안내 문구만 내므로 목록을 만들지 않습니다.
        List<GuruService.HoldingRow> index = q == null || q.isBlank()
                ? List.of()
                : cache.get("guru.holders.index", guru::holdersIndex);
        return guru.holders(index, q);
    }

    /**
     * 구루 포트폴리오의 위험 지표.
     *
     * <p>13F에는 티커가 없어 이름으로 가격을 찾습니다. 매핑표에 없는 종목은
     * 빠지며, 덮은 비중이 응답의 coverage에 항상 들어 있습니다.
     */
    @GetMapping("/guru/risk")
    public Map<String, Object> guruRisk(
            @RequestParam String cik,
            @RequestParam(defaultValue = "SPY") String benchmark,
            @RequestParam(defaultValue = "1") int years) {
        return cache.get("guru.risk:" + cik + ":" + benchmark + ":" + years, () -> guru.risk(cik, benchmark, years));
    }

    /** 쉼표로 구분한 CIK 목록. 비어 있으면 추적하는 기관 전체입니다. */
    private static List<String> selectedCiks(String ciks) {
        return (ciks == null || ciks.isBlank())
                ? Institutions.ciks()
                : Arrays.stream(ciks.split(",")).map(String::trim).filter(s -> !s.isBlank()).toList();
    }
}
