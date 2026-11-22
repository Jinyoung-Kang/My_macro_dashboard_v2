package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.Snapshot;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 교집합·스타일·알림이 기관 13F 분기 이력을 읽는 한 길(ADR 0048 단계 3) — 기본 12곳은 지금 그대로(q8, 없거나 오래면 수집을 부름 — StoreReader.read),
 * 13F 즐겨찾기는 트랙레코드 저장본(q30)이 있으면 그 앞 {@value Datasets#MAX_TRACKED_QUARTERS}분기만(DB에서 잘라 캐시 없이 — 30분기를 통째로 풀지 않게),
 * 없으면 q8을 — 둘 다 수집을 부르지 않습니다(포트폴리오와 같은 규칙, 더하기 때 단건 수집·정기 sec_13f가 모음).
 *
 * <p>모의 매매·AI 리포트 원문은 이 빈을 쓰지 않습니다(ArchitectureRulesTest — 즐겨찾기 자료).
 */
@Service
public class InstitutionHistory {

    /** 대상 기관 한 곳 — 기본 12곳이면 {@code favorite=false}. */
    public record Entry(String cik, String key, String name, String desc, boolean favorite) {

        /** 응답에 싣는 모양 — 기본 12곳은 지금 그대로(key·name·cik·desc), 즐겨찾기는 {@code favorite: "true"}를 더함. */
        public Map<String, String> asMap() {
            Map<String, String> out = new LinkedHashMap<>();
            out.put("key", key);
            out.put("name", name);
            out.put("cik", cik);
            out.put("desc", desc);
            if (favorite) {
                out.put("favorite", "true");
            }
            return out;
        }
    }

    private final StoreReader store;
    private final InstitutionCatalog catalog;

    public InstitutionHistory(StoreReader store, InstitutionCatalog catalog) {
        this.store = store;
        this.catalog = catalog;
    }

    /** 기본 12곳(상수 차례) 다음 즐겨찾기(더한 차례). */
    public List<Entry> entries() {
        List<Entry> out = new ArrayList<>();
        for (Map<String, String> institution : Institutions.ALL) {
            out.add(new Entry(institution.get("cik"), institution.get("key"), institution.get("name"), institution.get("desc"), false));
        }
        for (Sec13FFavoriteStore.Favorite favorite : catalog.favorites()) {
            if (!Institutions.isKnownCik(favorite.cik())) {
                out.add(favoriteEntry(favorite));
            }
        }
        return out;
    }

    /** 기본 12곳 또는 즐겨찾기면 그 기관, 아니면 empty. */
    public Optional<Entry> entry(String cik) {
        if (Institutions.isKnownCik(cik)) {
            Map<String, String> institution = Institutions.byCik(cik);
            return Optional.of(new Entry(cik, institution.get("key"), institution.get("name"), institution.get("desc"), false));
        }
        return catalog.favorite(cik).map(InstitutionHistory::favoriteEntry);
    }

    /** 이름(기본 12곳은 상수의 이름, 즐겨찾기는 표시 이름 — 없으면 SEC 등록 이름, 그 밖은 CIK). */
    public String name(String cik) {
        return entry(cik).map(Entry::name).orElse(cik);
    }

    /** 분기 이력(최신이 앞) — 위 규칙. 기본 12곳·즐겨찾기가 아니면 empty(읽지 않음). */
    public Optional<Snapshot> read(String cik) {
        if (Institutions.isKnownCik(cik)) {
            return store.read(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), Datasets.MAX_AGE_SLOW, "sec_13f");
        }
        if (!catalog.isFavorite(cik)) {
            return Optional.empty();
        }
        Optional<Snapshot> q30 = store.readStoredFirstQuarters(Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS), Datasets.MAX_TRACKED_QUARTERS);
        if (q30.isPresent() && q30.get().payload() != null) {
            return q30;
        }
        return store.quietly(() -> store.read(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), Datasets.MAX_AGE_SLOW, "sec_13f"));
    }

    private static Entry favoriteEntry(Sec13FFavoriteStore.Favorite favorite) {
        return new Entry(favorite.cik(), "fav-" + favorite.cik(), favorite.name(),
                favorite.description() == null ? "" : favorite.description(), true);
    }
}
