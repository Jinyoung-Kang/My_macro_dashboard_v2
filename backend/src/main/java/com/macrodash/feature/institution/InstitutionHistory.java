package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.Snapshot;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
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

    /**
     * 13F 계열 계산(스타일 요약·유사도·보유 색인·교집합·공통 신규 매수)이 읽는 입력의 판 — 응답 캐시의 입력 규칙({@code ComputedCache.get(key, inputs, …)},
     * QA-1040)에 넘깁니다. 같은 입력이면 같은 글이고, 아래 가운데 하나라도 바뀌면 달라집니다.
     * <ul>
     *   <li>기본 12곳의 13F 저장본(q{@value Datasets#MAX_TRACKED_QUARTERS}) 수집 시각 — {@link #read}가 {@code store.read}로 읽는 것.
     *       수집 시각을 볼 때 그 읽기와 같은 규칙으로 낡은 저장본의 수집을 요청합니다({@link StoreReader#collectedAt} — 계산을 건너뛰어도 화면이
     *       수집을 깨우던 동작이 남게).</li>
     *   <li>즐겨찾기 목록(더한 차례의 CIK·보일 이름·설명)과 그 기관마다 두 저장본(q{@value Datasets#TRACK_RECORD_QUARTERS}·q8)의 수집 시각 —
     *       {@link #read}가 q30을, 없으면 q8을 수집 없이 읽습니다. 저장본이 아직 없으면(모으는 중) '없음'으로 적혀, 생기면 판이 바뀝니다.</li>
     * </ul>
     * 기본 12곳의 이름·설명은 코드 상수라 프로세스 안에서 바뀌지 않습니다. 13F 저장본의 본문은 수집기가 새로 쓸 때마다 수집 시각도 새로 적습니다
     * (수집기 {@code store.put_snapshot} — ADR 0049 결정 5와 같은 근거).
     *
     * @return 판(16진 글), 또는 null — 기본 12곳 가운데 저장본이 없는 곳이 있거나(계산이 수집을 기다리는 경우 — 예전 규칙대로 60초만 기억) DB를 읽지 못함
     */
    public String inputVersion() {
        try {
            List<String> defaults = Institutions.ciks().stream()
                    .map(cik -> Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS)).toList();
            Map<String, Instant> tracked = store.collectedAt(defaults, Datasets.MAX_AGE_SLOW, "sec_13f");
            if (tracked.size() < defaults.size()) {
                return null;
            }
            List<Sec13FFavoriteStore.Favorite> favorites = catalog.favorites().stream()
                    .filter(favorite -> !Institutions.isKnownCik(favorite.cik())).toList();
            List<String> favoriteNames = new ArrayList<>();
            for (Sec13FFavoriteStore.Favorite favorite : favorites) {
                favoriteNames.add(Datasets.sec13f(favorite.cik(), Datasets.TRACK_RECORD_QUARTERS));
                favoriteNames.add(Datasets.sec13f(favorite.cik(), Datasets.MAX_TRACKED_QUARTERS));
            }
            Map<String, Instant> stored = store.readStoredCollectedAt(favoriteNames);

            StringBuilder text = new StringBuilder("13f-inputs-1");
            for (String name : defaults) {
                text.append('\n').append(name).append('=').append(tracked.get(name));
            }
            for (Sec13FFavoriteStore.Favorite favorite : favorites) {
                text.append("\nfav ").append(favorite.cik())
                        .append('\u001f').append(favorite.name())
                        .append('\u001f').append(favorite.description() == null ? "" : favorite.description())
                        .append('\u001f').append(stored.get(Datasets.sec13f(favorite.cik(), Datasets.TRACK_RECORD_QUARTERS)))
                        .append('\u001f').append(stored.get(Datasets.sec13f(favorite.cik(), Datasets.MAX_TRACKED_QUARTERS)));
            }
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (DataAccessException e) {
            return null;
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 쓸 수 없습니다", e);
        }
    }

    private static Entry favoriteEntry(Sec13FFavoriteStore.Favorite favorite) {
        return new Entry(favorite.cik(), "fav-" + favorite.cik(), favorite.name(),
                favorite.description() == null ? "" : favorite.description(), true);
    }
}
