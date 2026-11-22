package com.macrodash.feature.institution;

import com.macrodash.collector.CollectorClient;
import com.macrodash.read.ComputedCache;
import com.macrodash.read.StoreReader;
import com.macrodash.store.AlertStore;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 13F 즐겨찾기 기관(ADR 0048) — 목록(기관 목록 응답의 {@code favorites}), 이름 검색·더하기·지우기(운영자).
 *
 * <p>더하기: CIK 검사(숫자 1~10자리 → 10자리, 기본 12곳·중복·상한) → SEC submissions로 등록 이름과 원본 13F-HR 공시가 있는지(수집기 한 번) → 표에 넣음 →
 * 저장본(q30·q8)이 없으면 그 기관 하나만 수집을 기다림(수집기 단건 수집 — 시간 상한 {@link CollectorClient#FAVORITE_COLLECT_READ_TIMEOUT}).
 * 수집이 실패를 돌려주면 줄을 지우고 사유를 돌려줍니다(넣지 않은 것과 같음). 시간 상한을 넘기거나 수집기에 닿지 못하면 줄은 남기고 '수집 중'으로
 * 답합니다 — 수집기는 그 호출을 끝까지 돌려 저장하고, 화면은 목록을 다시 읽어 저장본이 생긴 것을 봅니다(브라우저 요청 강제 상한 100초 — QA-416).
 * 쓰기 뒤에는 응답 캐시를 비웁니다(기관 목록·포트폴리오).
 */
@Service
public class Sec13FFavoriteService {

    public record Result(int status, Map<String, Object> body) {
    }

    static final int MAX_DISPLAY_NAME = 60;
    static final int MAX_DESCRIPTION = 200;
    private static final Pattern CIK = Pattern.compile("\\d{1,10}");
    private static final Pattern CONTROL = Pattern.compile("\\p{Cntrl}");

    private final InstitutionCatalog catalog;
    private final Sec13FFavoriteStore favorites;
    private final StoreReader store;
    private final CollectorClient collector;
    private final ComputedCache cache;
    /** 13F 신규 편입 알림 규칙 — 즐겨찾기를 지우면 그 기관의 규칙도 함께 지움(ADR 0048 단계 3). 없으면(시험) 건드리지 않음. */
    private final AlertStore alerts;

    public Sec13FFavoriteService(InstitutionCatalog catalog, Sec13FFavoriteStore favorites, StoreReader store,
                                 CollectorClient collector, ComputedCache cache) {
        this(catalog, favorites, store, collector, cache, null);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public Sec13FFavoriteService(InstitutionCatalog catalog, Sec13FFavoriteStore favorites, StoreReader store,
                                 CollectorClient collector, ComputedCache cache, AlertStore alerts) {
        this.catalog = catalog;
        this.favorites = favorites;
        this.store = store;
        this.collector = collector;
        this.cache = cache;
        this.alerts = alerts;
    }

    /** 숫자 1~10자리 → 10자리 CIK. 그 밖은 400. */
    static String normalizeCik(String raw) {
        String text = raw == null ? "" : raw.strip();
        if (!CIK.matcher(text).matches() || Long.parseLong(text) == 0) {
            throw new InvalidRequestException("CIK는 숫자 1~10자리입니다.");
        }
        return "0".repeat(10 - text.length()) + text;
    }

    /**
     * 기관 목록 응답의 즐겨찾기 줄 — {cik, key, name, secName, desc, stored, source, latestReportDate}. {@code stored}는 저장본(q30 또는 q8)이 있는지,
     * {@code source}는 화면이 읽는 저장본(q30이 있으면 'q30', 아니면 'q8', 없으면 null), 최신 보고 기준일은 그 저장본의 첫 분기.
     */
    public List<Map<String, Object>> listEntries() {
        return listEntries(false);
    }

    /**
     * 기관 목록 응답의 즐겨찾기 줄. {@code withAlertRules}(운영자에게만)면 줄마다 그 기관의 13F 신규 편입 알림 규칙 수({@code alertRules} — 모든 사용자,
     * 지울 때 함께 지워지는 수)를 더합니다.
     */
    public List<Map<String, Object>> listEntries(boolean withAlertRules) {
        List<Sec13FFavoriteStore.Favorite> rows = catalog.favorites();
        if (rows.isEmpty()) {
            return List.of();
        }
        List<String> names = new ArrayList<>();
        for (Sec13FFavoriteStore.Favorite row : rows) {
            names.add(Datasets.sec13f(row.cik(), Datasets.TRACK_RECORD_QUARTERS));
            names.add(Datasets.sec13f(row.cik(), Datasets.MAX_TRACKED_QUARTERS));
        }
        Map<String, StoreRepository.SnapshotHead> heads = store.readStoredHeads(names);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Sec13FFavoriteStore.Favorite row : rows) {
            StoreRepository.SnapshotHead q30 = heads.get(Datasets.sec13f(row.cik(), Datasets.TRACK_RECORD_QUARTERS));
            StoreRepository.SnapshotHead q8 = heads.get(Datasets.sec13f(row.cik(), Datasets.MAX_TRACKED_QUARTERS));
            StoreRepository.SnapshotHead head = q30 != null ? q30 : q8;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("cik", row.cik());
            entry.put("key", "fav-" + row.cik());
            entry.put("name", row.name());
            entry.put("secName", row.secName());
            entry.put("desc", row.description() == null ? "" : row.description());
            entry.put("stored", head != null);
            entry.put("source", q30 != null ? "q30" : q8 != null ? "q8" : null);
            entry.put("latestReportDate", head == null ? null : head.firstReportDate());
            if (withAlertRules) {
                entry.put("alertRules", alertRuleCount(row.cik()));
            }
            out.add(entry);
        }
        return out;
    }

    /** 이름 검색(운영자) — 수집기가 EDGAR 회사 검색(13F-HR 제출자)을 한 번 부릅니다. 후보마다 기본 12곳·즐겨찾기인지. */
    public Result search(CurrentUser user, String q) {
        if (user == null || !user.isOwner()) {
            return failure(403, "즐겨찾기는 운영자만 바꿀 수 있습니다.");
        }
        String text = q == null ? "" : String.join(" ", q.strip().split("\\s+"));
        if (text.codePointCount(0, text.length()) < 2 || text.codePointCount(0, text.length()) > MAX_DISPLAY_NAME
                || CONTROL.matcher(text).find()) {
            throw new InvalidRequestException("검색어는 2~" + MAX_DISPLAY_NAME + "자입니다.");
        }
        Optional<JsonNode> answer = collector.sec13fSearch(text);
        if (answer.isEmpty()) {
            return failure(502, "수집기에 닿지 못해 SEC를 찾지 못했습니다 — 잠시 뒤 다시 찾거나 CIK를 직접 입력하세요.");
        }
        String error = Json.asText(answer.get(), "error");
        if (error != null && !error.isBlank()) {
            return failure(502, "SEC 이름 검색이 실패했습니다(" + error + ") — CIK를 직접 입력하세요.");
        }
        List<Map<String, Object>> candidates = new ArrayList<>();
        for (JsonNode node : Json.array(answer.get(), "candidates")) {
            String cik = Json.asText(node, "cik");
            String name = Json.asText(node, "name");
            if (cik == null || name == null || !cik.matches("\\d{10}")) {
                continue;
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("cik", cik);
            row.put("name", name);
            row.put("status", catalog.isDefault(cik) ? "default" : catalog.isFavorite(cik) ? "favorite" : null);
            candidates.add(row);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("query", text);
        body.put("candidates", candidates);
        return new Result(200, body);
    }

    /** 더하기(운영자). */
    public Result add(CurrentUser user, String rawCik, String rawDisplayName, String rawDescription) {
        if (user == null || !user.isOwner()) {
            return failure(403, "즐겨찾기는 운영자만 바꿀 수 있습니다.");
        }
        String cik = normalizeCik(rawCik);
        String displayName = optionalText(rawDisplayName, MAX_DISPLAY_NAME, "표시 이름");
        String description = optionalText(rawDescription, MAX_DESCRIPTION, "설명");
        if (!favorites.ready()) {
            return failure(503, "즐겨찾기 표가 아직 없습니다 — 수집기를 다시 띄워 마이그레이션을 적용하세요.");
        }
        if (catalog.isDefault(cik)) {
            return failure(409, "기본 12곳에 이미 있는 기관입니다.");
        }
        if (favorites.find(cik).isPresent()) {
            return failure(409, "이미 즐겨찾기에 있는 기관입니다.");
        }
        if (favorites.count() >= InstitutionCatalog.FAVORITE_LIMIT) {
            return failure(409, "즐겨찾기는 " + InstitutionCatalog.FAVORITE_LIMIT + "곳까지입니다 — 하나를 지운 뒤 더하세요.");
        }
        Optional<JsonNode> filer = collector.sec13fFiler(cik);
        if (filer.isEmpty()) {
            return failure(502, "수집기에 닿지 못해 SEC에서 이 CIK를 확인하지 못했습니다 — 잠시 뒤 다시 더하세요.");
        }
        String filerError = Json.asText(filer.get(), "error");
        if (filerError != null && !filerError.isBlank()) {
            return failure(422, "SEC에서 이 CIK를 확인하지 못했습니다: " + filerError);
        }
        String secName = Json.asText(filer.get(), "name");
        JsonNode latest = filer.get().get("latest13F");
        if (secName == null || secName.isBlank()) {
            return failure(422, "SEC 응답에 기관 이름이 없습니다.");
        }
        if (latest == null || latest.isNull()) {
            return failure(422, "이 CIK는 SEC 최근 공시 목록에 13F-HR(원본) 공시가 없습니다 — 13F 보고 기관인지 확인하세요.");
        }
        Optional<Sec13FFavoriteStore.Favorite> inserted = favorites.insert(cik, secName.strip(), displayName, description, user.id());
        if (inserted.isEmpty()) {
            return failure(409, "이미 즐겨찾기에 있는 기관입니다.");
        }
        cache.clear();

        String collection;
        String message;
        if (hasStored(cik)) {
            collection = "stored";
            message = "즐겨찾기에 더했습니다. 이미 있는 13F 저장본을 씁니다.";
        } else {
            Optional<JsonNode> collected = collector.sec13fCollectFavorite(cik);
            if (collected.isEmpty()) {
                collection = "collecting";
                message = "즐겨찾기에 더했습니다. 13F를 모으는 중입니다 — 끝나면 목록에 보입니다(정기 수집도 이 기관을 모읍니다).";
            } else if ("track_record".equals(Json.asText(collected.get(), "refused"))) {
                collection = "waiting";
                message = "즐겨찾기에 더했습니다. 모의 매매 트랙레코드 후보 기관이라 그 수집이 저장본을 만듭니다.";
            } else if (Json.asText(collected.get(), "error") != null && !Json.asText(collected.get(), "error").isBlank()) {
                favorites.delete(cik);
                cache.clear();
                return failure(422, "13F를 모으지 못해 더하지 않았습니다: " + Json.asText(collected.get(), "error"));
            } else {
                collection = "collected";
                message = "즐겨찾기에 더하고 13F를 모았습니다.";
            }
            cache.clear();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("collection", collection);
        body.put("message", message);
        body.put("favorite", Map.of("cik", cik, "name", inserted.get().name(), "secName", inserted.get().secName()));
        body.put("latest13F", Json.asText(latest, "filingDate") == null ? null
                : Map.of("filingDate", Json.asText(latest, "filingDate")));
        return new Result(200, body);
    }

    /** 지우기(운영자) — 없는 CIK는 404. 13F 저장본은 지우지 않습니다(다시 더하면 바로 보임). */
    public Result remove(CurrentUser user, String rawCik) {
        if (user == null || !user.isOwner()) {
            return failure(403, "즐겨찾기는 운영자만 바꿀 수 있습니다.");
        }
        String cik = normalizeCik(rawCik);
        if (!favorites.ready()) {
            return failure(503, "즐겨찾기 표가 아직 없습니다.");
        }
        if (favorites.delete(cik) != 1) {
            return failure(404, "즐겨찾기에 없는 기관입니다.");
        }
        // 그 기관의 13F 신규 편입 알림 규칙도 함께(모든 사용자 — 대상이 목록에서 빠지면 규칙을 고칠 길이 없음). 받은 알림함 기록은 그대로.
        int removedRules = alerts != null && alerts.ready() ? alerts.deleteInstitutionRules(cik) : 0;
        cache.clear();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("removedAlertRules", removedRules);
        body.put("message", "즐겨찾기에서 지웠습니다" + (removedRules > 0 ? "(13F 신규 편입 알림 규칙 " + removedRules + "개도 함께)" : "")
                + ". 13F 저장본은 남겨 둡니다(다시 더하면 바로 보입니다).");
        return new Result(200, body);
    }

    private int alertRuleCount(String cik) {
        return alerts != null && alerts.ready() ? alerts.countInstitutionRules(cik) : 0;
    }

    private boolean hasStored(String cik) {
        Map<String, StoreRepository.SnapshotHead> heads = store.readStoredHeads(List.of(
                Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS), Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS)));
        return !heads.isEmpty();
    }

    /** 선택 글 칸 — 비면 null, 제어 글자·상한 초과는 400. */
    static String optionalText(String raw, int max, String label) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String text = raw.strip();
        if (text.codePointCount(0, text.length()) > max || CONTROL.matcher(text).find()) {
            throw new InvalidRequestException(label + "은(는) 제어 글자 없이 " + max + "자까지입니다.");
        }
        return text;
    }

    private static Result failure(int status, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("message", message);
        return new Result(status, body);
    }
}
