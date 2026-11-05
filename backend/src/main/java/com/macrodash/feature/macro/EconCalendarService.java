package com.macrodash.feature.macro;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 경제 캘린더 — 미국·한국 지표 일정과 예상치·이전치·실제치·중요도(운영자 화면 전용, ADR 0026).
 *
 * <p>수집기가 차단 통과 수집 계층으로 받아 둔 저장본({@link Datasets#SNAP_ECON_CALENDAR_TV})을 <b>읽기만</b> 합니다. 다른 매크로 조회처럼
 * 태스크 이름을 넘겨 읽으면 저장본이 오래됐을 때 화면 조회만으로 수집을 요청하게 되는데, 그러면 그 출처의 비주기 일정과 하루 예산을
 * 화면이 건너뜁니다 — 그래서 {@link StoreReader#readStored}만 씁니다. 저장본이 없거나 오래됐으면 있는 그대로(없음·수집 시각) 보여 줍니다.
 *
 * <p>모의 매매 패킷은 이 저장본을 읽지 않습니다(패킷의 캘린더는 FRED 릴리스·FOMC 상수와 Nasdaq 컨센서스 그대로).
 */
@Service
public class EconCalendarService {

    private final StoreReader store;

    public EconCalendarService(StoreReader store) {
        this.store = store;
    }

    /**
     * @return {@code available}(저장본이 있고 일정 목록이 있는가)·수집 시각·출처·통과한 계층({@code fetchTier} — 화면의 '우회 수집' 표기)·
     *         {@code events}(수집기가 저장한 그대로 — 없는 값은 null)
     */
    public Map<String, Object> calendar() {
        Optional<Snapshot> snapshot = store.readStored(Datasets.SNAP_ECON_CALENDAR_TV);
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode payload = snapshot.map(Snapshot::payload).orElse(null);
        JsonNode events = payload == null ? null : payload.get("events");
        if (events == null || !events.isArray()) {
            out.put("available", false);
            out.put("events", List.of());
            return out;
        }
        out.put("available", true);
        snapshot.get().putFreshness(out);
        out.put("source", Json.asText(payload, "source"));
        out.put("sourceUrl", Json.asText(payload, "sourceUrl"));
        out.put("sourceNote", Json.asText(payload, "sourceNote"));
        out.put("fetchTier", Json.asText(payload, "fetchTier"));
        out.put("window", payload.get("window"));
        out.put("events", events);
        return out;
    }
}
