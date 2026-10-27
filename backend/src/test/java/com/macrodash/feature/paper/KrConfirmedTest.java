package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCorporateActions.ListedShares;
import com.macrodash.analytics.KrxCorporateActions.Presence;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 확정 시세 읽기(C2c — {@link KrConfirmed}·{@link PaperMarketData#krConfirmed}·{@link KrPaperMarket#confirmedPrices}): 금융위 저장값(float)을
 * 종가·거래량·상장주식수로, 거래량 0 행은 확정 종가가 아님, 상장 상태(있음·없음·모름)와 최근 두 기준일 상장주식수, 읽는 범위, ETF는 증권상품시세.
 */
class KrConfirmedTest {

    private static final LocalDate MON = LocalDate.of(2026, 11, 2);
    private static final LocalDate TUE = LocalDate.of(2026, 11, 3);
    private static final LocalDate WED = LocalDate.of(2026, 11, 4);

    private StoreRepository repository;
    private PaperMarketData data;

    @BeforeEach
    void setUp() {
        repository = mock(StoreRepository.class);
        data = new PaperMarketData(mock(StoreReader.class), repository);
    }

    /** 수집기 normalize 모양({@code to_float} — 정수도 소수점 붙은 float) + 읽기가 붙이는 {@code obsDate}. */
    private static JsonNode row(LocalDate date, Double close, Double volume, String listedField, Double listed) {
        ObjectNode row = PaperFixtures.MAPPER.createObjectNode();
        row.put("obsDate", date.toString());
        if (close == null) {
            row.putNull("close");
        } else {
            row.put("close", close);
        }
        if (volume == null) {
            row.putNull("volume");
        } else {
            row.put("volume", volume);
        }
        if (listed != null) {
            row.put(listedField, listed);
        }
        return row;
    }

    @Test
    @DisplayName("주식시세 행 → 종가·거래량·상장주식수, 거래량 0(정지일 — 종가는 전날 값)·모름은 확정 종가가 아님, 최근 두 기준일 상장주식수, 최신 기준일에 행이 있으면 '있음'")
    void stockSeries() {
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(WED);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_PRICE), anyCollection(), eq(WED.minusDays(14))))
                .thenReturn(Map.of("005930", List.of(
                        row(WED, 71_300.0, 17_213_072.0, "listedShares", 5_919_637_922.0),
                        row(TUE, 71_300.0, 0.0, "listedShares", 5_919_637_922.0),
                        row(MON, 70_000.0, null, "listedShares", 5_969_782_550.0))));

        KrConfirmed.Series samsung = data.krConfirmed(List.of("005930", "088980"), List.of(), null).of("005930");

        assertThat(samsung.source()).isEqualTo(KrConfirmed.SOURCE_FSC);
        assertThat(samsung.closeOn(WED)).hasValueSatisfying(c -> assertThat(c).isEqualByComparingTo("71300"));
        assertThat(samsung.closeOn(TUE)).as("거래량 0 — 그 종가는 전날 값").isEmpty();
        assertThat(samsung.closeOn(MON)).as("거래량 모름").isEmpty();
        assertThat(samsung.on(TUE)).hasValueSatisfying(d -> assertThat(d.volume()).isZero());
        assertThat(samsung.observedFrom(MON)).extracting(KrConfirmed.Day::date).containsExactly(WED);
        assertThat(samsung.presence()).isEqualTo(Presence.LISTED);
        assertThat(samsung.sharesAfter()).isEqualTo(new ListedShares(WED, 5_919_637_922L));
        assertThat(samsung.sharesBefore()).as("그 종목의 직전 기준일").isEqualTo(new ListedShares(TUE, 5_919_637_922L));
    }

    @Test
    @DisplayName("받은 종목에 최신 기준일 행이 없으면 '없음'(출처는 하루치를 끝까지 받은 날만 저장), 출처가 아무것도 받지 않았거나 읽지 않은 종목은 '모름'")
    void presence() {
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(WED);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_PRICE), anyCollection(), eq(WED.minusDays(14))))
                .thenReturn(Map.of("123450", List.of(row(TUE, 5_000.0, 10.0, "listedShares", 1_000.0))));
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenReturn(null);

        KrConfirmed confirmed = data.krConfirmed(List.of("123450", "999990"), List.of("069500"), null);

        assertThat(confirmed.of("123450").presence()).as("최신 기준일에 행 없음(상장폐지 등)").isEqualTo(Presence.ABSENT);
        assertThat(confirmed.of("123450").sharesAfter()).isNull();
        assertThat(confirmed.of("123450").sharesBefore()).as("최신 행이 없으면 비교하지 않음").isNull();
        assertThat(confirmed.of("999990").presence()).as("행이 하나도 없음").isEqualTo(Presence.ABSENT);
        assertThat(confirmed.of("069500").presence()).as("증권상품시세를 아직 아무것도 받지 않음").isEqualTo(Presence.UNKNOWN);
        assertThat(confirmed.of("069500").source()).isEqualTo(KrConfirmed.SOURCE_FSC_ETF);
        assertThat(confirmed.of("000660").presence()).as("읽지 않은 종목").isEqualTo(Presence.UNKNOWN);
        assertThat(KrConfirmed.NONE.of("005930")).isEqualTo(KrConfirmed.Series.UNKNOWN);
        verify(repository, never()).readObservationSeries(eq(Datasets.OBS_FSC_ETF_PRICE), anyCollection(),
                org.mockito.ArgumentMatchers.any());
    }

    @Test
    @DisplayName("읽는 범위 = from과 (최신 기준일 − 14일) 중 이른 날부터 — since가 오래된 보유의 최고가 종가까지")
    void readsFromTheEarlierStart() {
        LocalDate old = LocalDate.of(2026, 9, 1);
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(WED);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_PRICE), anyCollection(), eq(old)))
                .thenReturn(Map.of("005930", List.of(row(old, 60_000.0, 1.0, "listedShares", null))));

        KrConfirmed.Series series = data.krConfirmed(List.of("005930"), List.of(), old).of("005930");

        assertThat(series.closeOn(old)).hasValueSatisfying(c -> assertThat(c).isEqualByComparingTo("60000"));
        assertThat(series.sharesAfter()).as("최신 행 없음").isNull();
        // from이 최신 − 14일보다 늦으면 최신 − 14일부터(직전 기준일 상장주식수를 찾는 창).
        data.krConfirmed(List.of("005930"), List.of(), WED);
        verify(repository).readObservationSeries(eq(Datasets.OBS_FSC_PRICE), anyCollection(), eq(WED.minusDays(14)));
    }

    @Test
    @DisplayName("증권상품시세 행 → 상장좌수(listedUnits), 소수가 붙은 거래량·0 이하 상장 수는 모름(0으로 채우지 않음)")
    void etfSeriesAndMalformedNumbers() {
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenReturn(WED);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_ETF_PRICE), anyCollection(), eq(WED.minusDays(14))))
                .thenReturn(Map.of("069500", List.of(row(WED, 87_075.0, 32_381_043.0, "listedUnits", 120_000_000.0),
                        row(TUE, 86_000.0, 1.5, "listedUnits", 0.0))));

        KrConfirmed.Series kodex = data.krConfirmed(List.of(), List.of("069500"), null).of("069500");

        assertThat(kodex.closeOn(WED)).hasValueSatisfying(c -> assertThat(c).isEqualByComparingTo("87075"));
        assertThat(kodex.sharesAfter()).isEqualTo(new ListedShares(WED, 120_000_000L));
        assertThat(kodex.on(TUE)).hasValueSatisfying(day -> {
            assertThat(day.volume()).as("소수 거래량").isNull();
            assertThat(day.listed()).as("0 상장좌수").isNull();
        });
        assertThat(kodex.sharesBefore()).as("직전 행의 상장 수를 모름").isNull();
    }

    @Test
    @DisplayName("한국 묶음은 ETF 목록(설정 현금성 ∪ 벤치마크 종목)을 증권상품시세로, 나머지를 주식시세로 읽음 — 비용 종목 구분과 같은 목록")
    void krMarketRoutesEtfs() {
        PaperMarketData spy = mock(PaperMarketData.class);
        when(spy.krConfirmed(anyCollection(), anyCollection(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(KrConfirmed.NONE);
        PaperSettings settings = PaperSettings.defaults(KrPaperMarket.INSTANCE);

        KrPaperMarket.INSTANCE.confirmedPrices(spy, List.of("153130", "005930", "069500", "000660"), settings, MON);

        verify(spy).krConfirmed(List.of("000660", "005930"), List.of("069500", "153130"), MON);
        assertThat(UsPaperMarket.INSTANCE.confirmedPrices(spy, List.of("SPY"), PaperSettings.defaults(), MON))
                .as("미국은 확정 시세를 쓰지 않음").isSameAs(KrConfirmed.NONE);
        verify(spy, never()).fscMarkets(anyCollection());
        verify(repository, never()).latestObservationDate(anyString());
    }
}
