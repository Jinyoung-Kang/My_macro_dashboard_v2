package com.macrodash.feature.institution;

import com.macrodash.store.Sec13FFavoriteStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * 13F 화면이 보는 기관 = 기본 12곳(상수 {@link Institutions} — 그대로) + 즐겨찾기(운영자가 더한 기관, ADR 0048 — 표 {@code sec13f_favorites}).
 *
 * <p>모의 매매(feature.paper)·AI 리포트 원문(feature.snapshot)·AI(feature.ai)는 이 빈을 쓰지 않고 지금처럼 {@link Institutions}만 봅니다 — 즐겨찾기가
 * 패킷·원문에 끼지 않게(ArchitectureRulesTest가 막음). 표가 아직 없거나(마이그레이션 전) 읽지 못하면 즐겨찾기 없음으로 봅니다(기본 12곳은 그대로).
 */
@Service
public class InstitutionCatalog {

    /** 즐겨찾기 상한(ADR 0048 — 스타일·교집합 최악 경우의 메모리·응답 시간을 재어 정함). */
    public static final int FAVORITE_LIMIT = 20;

    private static final Logger log = LoggerFactory.getLogger(InstitutionCatalog.class);

    private final Sec13FFavoriteStore store;

    public InstitutionCatalog(Sec13FFavoriteStore store) {
        this.store = store;
    }

    /** 즐겨찾기 표를 보지 않는 카탈로그(기본 12곳만) — 시험·즐겨찾기를 모르는 호출용. */
    public static InstitutionCatalog defaultsOnly() {
        return new InstitutionCatalog(null);
    }

    /** 기본 12곳의 CIK인가. */
    public boolean isDefault(String cik) {
        return Institutions.isKnownCik(cik);
    }

    /** 즐겨찾기 전부(더한 차례). 표가 없거나 읽지 못하면 빈 목록. */
    public List<Sec13FFavoriteStore.Favorite> favorites() {
        if (store == null) {
            return List.of();
        }
        try {
            return store.ready() ? store.all() : List.of();
        } catch (DataAccessException e) {
            log.warn("13F 즐겨찾기를 읽지 못해 기본 12곳만 봅니다: {}", e.getClass().getSimpleName());
            return List.of();
        }
    }

    public Optional<Sec13FFavoriteStore.Favorite> favorite(String cik) {
        if (cik == null) {
            return Optional.empty();
        }
        return favorites().stream().filter(favorite -> favorite.cik().equals(cik)).findFirst();
    }

    public boolean isFavorite(String cik) {
        return favorite(cik).isPresent();
    }
}
