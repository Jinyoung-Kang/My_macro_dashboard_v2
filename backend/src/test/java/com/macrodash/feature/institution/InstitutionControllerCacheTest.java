package com.macrodash.feature.institution;

import com.macrodash.read.ComputedCache;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 포트폴리오도 같은 저장본이면 다시 계산하지 않는다 — 교집합·신규 편입·위험 분석과 같은 응답 캐시.
 *
 * <p>QA-112·121로 비중 추이가 8분기 전체 보유를 증권 단위로 집계하게 되면서 요청 하나의 계산이 늘었습니다
 * (QA 스택 측정: 캐시 없는 첫 요청 13→22ms, 동시 50명 p95 9→28ms). 이 경로만 캐시를 거치지 않아
 * 부하 중 다른 요청까지 느려졌습니다.
 *
 * <p>보유 기관 검색(QA-133)은 응답이 검색어마다 달라, 응답 대신 검색어와 상관없는 최신 분기 보유 목록을 같은 캐시에
 * 둡니다. 캐시를 거치지 않던 때는 재기동 직후 요청마다 12개 기관의 13F 저장본(약 17.7MB)을 각자 다시 풀었습니다.
 */
class InstitutionControllerCacheTest {

    @Test
    @DisplayName("같은 기관·조건의 포트폴리오는 저장본이 그대로면 한 번만 계산한다")
    void portfolioIsComputedOncePerSnapshotVersion() {
        StoreRepository repository = mock(StoreRepository.class);
        when(repository.latestCollectedAt()).thenReturn(Instant.parse("2026-10-12T06:43:12Z"));
        Sec13FService sec13f = mock(Sec13FService.class);
        when(sec13f.portfolio("0001608046", 8, 30)).thenReturn(Map.of("available", true));
        InstitutionController controller = new InstitutionController(sec13f, mock(GuruService.class), mock(Sec13FFavoriteService.class), new ComputedCache(repository));

        Map<String, Object> first = controller.portfolio("0001608046", 8, 30);
        Map<String, Object> second = controller.portfolio("0001608046", 8, 30);

        assertThat(second).isSameAs(first);
        verify(sec13f, times(1)).portfolio("0001608046", 8, 30);
        // 조건이 다르면 따로 계산합니다.
        controller.portfolio("0001608046", 4, 30);
        verify(sec13f, times(1)).portfolio("0001608046", 4, 30);
    }

    @Test
    @DisplayName("QA-133 보유 기관 검색은 검색어가 달라도 13F 저장본을 한 번만 읽는다 — 빈 검색어는 아예 읽지 않는다")
    void holdersReadFilingsOncePerSnapshotVersion() {
        StoreRepository repository = mock(StoreRepository.class);
        when(repository.latestCollectedAt()).thenReturn(Instant.parse("2026-10-12T06:43:12Z"));
        ObjectNode filings = new ObjectMapper().createObjectNode();
        ArrayNode holdings = filings.putArray("quarters").addObject()
                .put("reportDate", "2026-06-30").put("filingDate", "2026-08-14")
                .putArray("holdings");
        holdings.addObject().put("name", "APPLE INC").put("cusip", "037833100").put("weight", 30.0).put("value", 30.0);
        holdings.addObject().put("name", "NVIDIA CORP").put("cusip", "67066G104").put("weight", 60.0).put("value", 60.0);
        String filingName = Datasets.sec13f(Institutions.ciks().get(0), Datasets.MAX_TRACKED_QUARTERS);
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        when(store.read(eq(filingName), anyLong(), anyString()))
                .thenReturn(Optional.of(new Snapshot(filingName, filings, "json", "ok", null, Instant.now())));
        InstitutionController controller = new InstitutionController(
                mock(Sec13FService.class), new GuruService(store), mock(Sec13FFavoriteService.class), new ComputedCache(repository));

        // 빈 검색어는 안내 문구만 — 13F 저장본을 읽지 않습니다.
        assertThat(controller.guruHolders(" ").get("message")).isEqualTo("찾을 종목명을 입력하세요.");
        verify(store, never()).read(anyString(), anyLong(), anyString());

        Map<String, Object> apple = controller.guruHolders("APPLE");
        Map<String, Object> nvidia = controller.guruHolders("nvidia");

        assertThat((List<?>) apple.get("rows")).singleElement()
                .satisfies(row -> assertThat(((Map<?, ?>) row).get("name")).isEqualTo("APPLE INC"));
        assertThat((List<?>) nvidia.get("rows")).singleElement()
                .satisfies(row -> assertThat(((Map<?, ?>) row).get("name")).isEqualTo("NVIDIA CORP"));
        // 재기동 직후 서로 다른 검색어가 몰려도 수 MB 저장본을 요청마다 다시 풀지 않습니다 — 검색어와 상관없는 보유 목록은
        // 같은 저장본 버전·60초 안에서는 한 번만 만듭니다.
        verify(store, times(1)).read(eq(filingName), anyLong(), anyString());
    }
}
