package com.macrodash.feature.security;

import com.macrodash.feature.security.ProductAliases.Alias;
import com.macrodash.feature.security.Verdict.Match;
import com.macrodash.feature.security.Verdict.ProductVerdict;
import com.macrodash.feature.security.Verdict.Reason;
import com.macrodash.feature.security.Verdict.Status;
import com.macrodash.store.SecurityStore;
import com.macrodash.support.InvalidRequestException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 보안 공지 화면({@code /security}, ADR 0046) — 수집기가 받아 둔 보호나라 공지와 버전 목록을 <b>읽기만</b> 하고, 판정은 읽을 때마다
 * {@link NoticeJudge}로 계산합니다(결정 5 — 저장하지 않음). 스냅숏을 읽지 않으므로 화면 조회가 수집을 일으키지 않습니다.
 *
 * <p>버전 목록이 없으면(로컬·QA, 서버에서 아직 받지 않음) 판정에 {@code null}을 넘겨 제품이 맞는 공지는 모두 확인 필요({@code NO_INVENTORY})가
 * 됩니다(결정 8). 모르는 값은 null로 내립니다(지어내지 않음). 시각은 ISO(UTC, 초까지) 글자, 날짜는 {@code yyyy-MM-dd}입니다.
 * 설치 버전 문자열은 운영자 화면의 응답에만 싣고 로그에 남기지 않습니다.
 */
@Service
public class SecurityService {

    /** 수집기 태스크 이름(collector/app/tasks/security.py TASK_NAME). */
    static final String TASK = "kisa_security_notices";
    static final int DEFAULT_SIZE = 20;
    static final int MAX_SIZE = 100;
    /** 검색어 상한(글자) — 넘으면 앞부분만 씁니다. */
    static final int MAX_QUERY = 100;
    /** 버전 목록이 이보다 오래되면 {@code stale}(화면 경고 — 계획 커밋 10 '2일 넘게 오래됐으면 경고'). */
    static final Duration INVENTORY_STALE_AFTER = Duration.ofDays(2);

    private static final Pattern CVE = Pattern.compile("CVE-\\d{4}-\\d{4,}", Pattern.CASE_INSENSITIVE);
    private static final List<String> STATUS_CODES = Arrays.stream(Status.values()).map(Status::code).toList();
    private static final List<String> REASON_CODES = Arrays.stream(Reason.values()).map(Reason::name).toList();

    /** 공지 한 건과 그 표 행·판정. */
    public record Judged(SecurityStore.Notice notice, List<SecurityStore.NoticeRow> rows, Verdict verdict) {
    }

    private final SecurityStore store;
    private final ProductAliases aliases;
    private final Clock clock;

    @Autowired
    public SecurityService(SecurityStore store) {
        this(store, ProductAliases.defaults(), Clock.systemUTC());
    }

    SecurityService(SecurityStore store, ProductAliases aliases, Clock clock) {
        this.store = store;
        this.aliases = aliases;
        this.clock = clock;
    }

    /** 공지 표가 있는가(수집기가 V40을 적용했나). */
    public boolean ready() {
        return store.ready();
    }

    // ------------------------------------------------------------------ 판정 (알림 작업도 씀)

    /** 버전 목록 한 벌 — 표가 없거나 받은 적이 없으면 비어 있음. */
    public Optional<EnvInventory> loadInventory() {
        if (!store.inventoryReady()) {
            return Optional.empty();
        }
        Optional<SecurityStore.Inventory> head = store.inventory();
        if (head.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(toInventory(head.get(), store.components(), store.pending()));
    }

    static EnvInventory toInventory(SecurityStore.Inventory head, List<SecurityStore.Component> components,
                                    List<SecurityStore.Pending> pending) {
        Map<String, EnvInventory.SectionStatus> sections = new LinkedHashMap<>();
        for (SecurityStore.Section section : head.sections()) {
            sections.put(section.name(), EnvInventory.SectionStatus.fromDb(section.status()));
        }
        return new EnvInventory(sections,
                components.stream().map(c -> new EnvInventory.Component(c.source(), c.ecosystem(), c.name(), c.version(),
                        c.sourcePackage())).toList(),
                pending.stream().map(p -> new EnvInventory.Pending(p.pkg(), p.installed(), p.candidate(), p.security())).toList());
    }

    /** 공지 전부를 판정합니다(게시일 최근부터). {@code inventory}가 {@code null}이면 버전 목록 없음. */
    public List<Judged> judgeAll(EnvInventory inventory) {
        Map<Long, List<SecurityStore.NoticeRow>> rowsByNotice = store.rows().stream()
                .collect(Collectors.groupingBy(SecurityStore.NoticeRow::nttId, LinkedHashMap::new, Collectors.toList()));
        List<Judged> out = new ArrayList<>();
        for (SecurityStore.Notice notice : store.notices()) {
            List<SecurityStore.NoticeRow> rows = rowsByNotice.getOrDefault(notice.nttId(), List.of());
            out.add(new Judged(notice, rows, judge(notice, rows, inventory)));
        }
        return out;
    }

    Verdict judge(SecurityStore.Notice notice, List<SecurityStore.NoticeRow> rows, EnvInventory inventory) {
        SecurityNotice input = new SecurityNotice(notice.nttId(), notice.title(),
                SecurityNotice.Template.fromDb(notice.layout()).orElse(null), notice.notes(), notice.bodyText());
        List<SecurityNotice.Row> tableRows = rows.stream()
                .map(r -> new SecurityNotice.Row(r.rowNo(), r.cve(), r.product(), r.affected(), r.fixed())).toList();
        return NoticeJudge.judge(input, tableRows, inventory, aliases);
    }

    /** 판정이 '해당'인 제품의 이름(별칭 표 순서) — 알림 글에 씁니다. */
    public static List<String> affectedLabels(Verdict verdict) {
        return verdict.products().stream().filter(p -> p.status() == Status.AFFECTED).map(ProductVerdict::label).distinct().toList();
    }

    /**
     * '해당'인 제품의 표 행에 적힌 CVE 번호 수(겹침 없이). 그 행들에 CVE 번호 꼴의 글이 하나도 없으면 null(셀 수 없음 — 0으로 두지 않음).
     */
    public Integer affectedCveCount(Judged judged) {
        Set<String> affected = judged.verdict().products().stream().filter(p -> p.status() == Status.AFFECTED)
                .map(ProductVerdict::aliasId).collect(Collectors.toSet());
        List<SecurityStore.NoticeRow> rows = judged.rows().stream()
                .filter(row -> aliases.forProduct(row.product()).stream().anyMatch(a -> affected.contains(a.id()))).toList();
        return cveCount(rows);
    }

    /** 행들의 CVE 번호 수(겹침 없이) — 하나도 없으면 null. */
    static Integer cveCount(Collection<SecurityStore.NoticeRow> rows) {
        Set<String> ids = new LinkedHashSet<>();
        for (SecurityStore.NoticeRow row : rows) {
            Matcher m = CVE.matcher(row.cve() == null ? "" : row.cve());
            while (m.find()) {
                ids.add(m.group().toUpperCase(Locale.ROOT));
            }
        }
        return ids.isEmpty() ? null : ids.size();
    }

    // ------------------------------------------------------------------ GET /api/security/notices

    /**
     * 공지 목록. 건수({@code counts})는 검색어로 거른 뒤·판정으로 거르기 전, 사유별 건수({@code reasonCounts})는 판정까지 거른 뒤·사유로 거르기 전입니다.
     *
     * @param verdict affected·check·patched·unrelated(비면 전부)
     * @param reason  사유 코드 하나(비면 전부) — 공지 판정의 사유에 그 코드가 있는 것만
     * @param query   제목·공지 제품명·CVE·판정 제품 이름 검색(대소문자 무시)
     */
    public Map<String, Object> notices(String verdict, String reason, String query, Integer page, Integer size) {
        Status wanted = parseVerdict(verdict);
        Reason wantedReason = parseReason(reason);
        String q = normalizeQuery(query);
        Paging paging = Paging.of(page, size);
        Instant now = clock.instant();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", store.ready());
        out.put("checkedAt", iso(now));
        if (!store.ready()) {
            out.put("inventory", null);
            out.put("collection", null);
            out.put("counts", null);
            out.put("reasonCounts", null);
            out.put("items", List.of());
            paging.put(out, 0);
            return out;
        }
        Optional<SecurityStore.Inventory> head = store.inventoryReady() ? store.inventory() : Optional.empty();
        EnvInventory inventory = head.map(h -> toInventory(h, store.components(), store.pending())).orElse(null);
        List<Judged> all = judgeAll(inventory);

        List<Judged> searched = q == null ? all : all.stream().filter(j -> matchesQuery(j, q)).toList();
        Map<String, Object> counts = new LinkedHashMap<>();
        for (Status status : Status.values()) {
            counts.put(status.code(), searched.stream().filter(j -> j.verdict().status() == status).count());
        }
        counts.put("total", searched.size());

        List<Judged> byVerdict = wanted == null ? searched : searched.stream().filter(j -> j.verdict().status() == wanted).toList();
        Map<String, Object> reasonCounts = new LinkedHashMap<>();
        for (Reason r : Reason.values()) {
            reasonCounts.put(r.name(), byVerdict.stream().filter(j -> j.verdict().reasons().contains(r)).count());
        }
        List<Judged> filtered = wantedReason == null ? byVerdict
                : byVerdict.stream().filter(j -> j.verdict().reasons().contains(wantedReason)).toList();

        out.put("inventory", head.map(h -> inventorySummary(h, now)).orElse(null));
        out.put("collection", collection(all.stream().map(Judged::notice).toList()));
        out.put("counts", counts);
        out.put("reasonCounts", reasonCounts);
        int from = Math.min(paging.offset(), filtered.size());
        int to = Math.min(from + paging.size(), filtered.size());
        out.put("items", filtered.subList(from, to).stream().map(this::summary).toList());
        paging.put(out, filtered.size());
        return out;
    }

    // ------------------------------------------------------------------ GET /api/security/notices/{nttId}

    /**
     * 공지 한 건 — 틀 종류·{@code ※} 문장·표 행마다 판정과 근거(설치 버전 포함). 없으면 404.
     */
    public Map<String, Object> notice(long nttId) {
        if (!store.ready()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "보안 공지 표가 아직 없습니다.");
        }
        SecurityStore.Notice notice = store.notice(nttId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "그 번호의 보안 공지가 없습니다."));
        Instant now = clock.instant();
        Optional<SecurityStore.Inventory> head = store.inventoryReady() ? store.inventory() : Optional.empty();
        EnvInventory inventory = head.map(h -> toInventory(h, store.components(), store.pending())).orElse(null);
        List<SecurityStore.NoticeRow> rows = store.rows(nttId);
        Verdict verdict = judge(notice, rows, inventory);
        Judged judged = new Judged(notice, rows, verdict);

        Map<String, Object> detail = summary(judged);
        detail.put("listNo", notice.listNo());
        detail.put("firstSeenAt", iso(notice.firstSeenAt()));
        detail.put("detailFetchedAt", iso(notice.detailFetchedAt()));
        detail.put("detailAttempts", notice.detailAttempts());
        detail.put("detailError", notice.detailError());
        detail.put("noticeProducts", notice.products());
        detail.put("notes", notice.notes());
        detail.put("conditionNotes", verdict.conditionNotes());
        detail.put("bodyText", notice.bodyText());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("checkedAt", iso(now));
        out.put("inventory", head.map(h -> inventorySummary(h, now)).orElse(null));
        out.put("notice", detail);
        out.put("rows", rows.stream().map(row -> rowJson(row, verdict)).toList());
        out.put("generalMatches", verdict.matches().stream().filter(m -> m.rowIndex() == null).map(this::matchJson).toList());
        return out;
    }

    // ------------------------------------------------------------------ GET /api/security/inventory

    /** 버전 목록 한 벌 — 구역 상태·구성 요소·apt 보류 목록. 받은 적이 없으면 {@code present: false}. */
    public Map<String, Object> inventory() {
        Instant now = clock.instant();
        Map<String, Object> out = new LinkedHashMap<>();
        boolean ready = store.inventoryReady();
        Optional<SecurityStore.Inventory> head = ready ? store.inventory() : Optional.empty();
        out.put("available", ready);
        out.put("checkedAt", iso(now));
        out.put("present", head.isPresent());
        if (head.isEmpty()) {
            out.put("collectedAt", null);
            out.put("receivedAt", null);
            out.put("ageSeconds", null);
            out.put("stale", null);
            out.put("hostIncluded", null);
            out.put("aptListsAt", null);
            out.put("sections", List.of());
            out.put("counts", null);
            out.put("components", List.of());
            out.put("pending", List.of());
            return out;
        }
        SecurityStore.Inventory inv = head.get();
        List<SecurityStore.Component> components = store.components();
        List<SecurityStore.Pending> pending = store.pending();
        out.putAll(inventoryTimes(inv, now));
        out.put("sections", orderedSections(inv.sections()).stream().map(s -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", s.name());
            row.put("status", s.status());
            row.put("count", s.count());
            row.put("reason", s.reason());
            return row;
        }).toList());
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("components", components.size());
        counts.put("pending", pending.size());
        counts.put("pendingSecurity", pending.stream().filter(SecurityStore.Pending::security).count());
        out.put("counts", counts);
        out.put("components", components.stream().map(c -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("source", c.source());
            row.put("ecosystem", c.ecosystem());
            row.put("name", c.name());
            row.put("version", c.version());
            row.put("sourcePackage", c.sourcePackage());
            return row;
        }).toList());
        out.put("pending", pending.stream().map(p -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("package", p.pkg());
            row.put("arch", p.arch());
            row.put("installed", p.installed());
            row.put("candidate", p.candidate());
            row.put("repos", p.repos());
            row.put("security", p.security());
            return row;
        }).toList());
        return out;
    }

    // ------------------------------------------------------------------ JSON 조각

    private Map<String, Object> summary(Judged judged) {
        SecurityStore.Notice notice = judged.notice();
        Verdict verdict = judged.verdict();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("nttId", notice.nttId());
        row.put("title", notice.title());
        row.put("postedOn", notice.postedOn() == null ? null : notice.postedOn().toString());
        row.put("url", notice.url());
        row.put("pinned", notice.pinned());
        row.put("detailStatus", notice.detailStatus());
        row.put("layout", notice.layout());
        row.put("verdict", verdict.status().code());
        row.put("reasons", reasonCodes(verdict.reasons()));
        row.put("conditionNote", verdict.reasons().contains(Reason.CONDITION_NOTE));
        row.put("products", verdict.products().stream().map(p -> {
            Map<String, Object> product = new LinkedHashMap<>();
            product.put("aliasId", p.aliasId());
            product.put("label", p.label());
            product.put("status", p.status().code());
            product.put("reasons", reasonCodes(p.reasons()));
            return product;
        }).toList());
        boolean table = "product_table".equals(notice.layout());
        row.put("rowCount", table ? judged.rows().size() : null);
        row.put("cveCount", table ? cveCount(judged.rows()) : null);
        return row;
    }

    /** 표 행 하나 — 그 행의 제품(별칭)·판정·사유·행 단위 근거. 행 단위 근거가 없으면 그 제품의 판정을 따릅니다(배포판·버전 목록 없음 등). */
    private Map<String, Object> rowJson(SecurityStore.NoticeRow row, Verdict verdict) {
        List<Alias> rowAliases = aliases.forProduct(row.product());
        List<Match> own = verdict.matches().stream().filter(m -> m.rowIndex() != null && m.rowIndex() == row.rowNo()).toList();
        Status status;
        Set<Reason> reasons = new LinkedHashSet<>();
        List<Match> counted = own.stream().filter(m -> !m.otherFamily()).toList();
        if (!counted.isEmpty()) {
            status = Status.UNRELATED;
            for (Match m : counted) {
                status = Status.max(status, m.status());
            }
            for (Match m : counted) {
                if (m.status() == status && m.reason() != null) {
                    reasons.add(m.reason());
                }
            }
        } else if (!own.isEmpty() || rowAliases.isEmpty()) {
            status = Status.UNRELATED;          // 다른 계열의 행뿐이거나, 이 스택이 쓰지 않는 제품
        } else {
            status = Status.UNRELATED;
            for (ProductVerdict p : verdict.products()) {
                if (rowAliases.stream().anyMatch(a -> a.id().equals(p.aliasId()))) {
                    if (p.status().rank() > status.rank()) {
                        status = p.status();
                        reasons.clear();
                    }
                    if (p.status() == status) {
                        reasons.addAll(p.reasons());
                    }
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("index", row.rowNo());
        out.put("cve", row.cve());
        out.put("product", row.product());
        out.put("affected", row.affected());
        out.put("fixed", row.fixed());
        out.put("aliases", rowAliases.stream().map(a -> {
            Map<String, Object> alias = new LinkedHashMap<>();
            alias.put("aliasId", a.id());
            alias.put("label", a.label());
            return alias;
        }).toList());
        out.put("status", status.code());
        out.put("reasons", reasonCodes(reasons));
        out.put("matches", own.stream().map(this::matchJson).toList());
        return out;
    }

    private Map<String, Object> matchJson(Match m) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("aliasId", m.aliasId());
        out.put("label", aliases.byId(m.aliasId()).map(Alias::label).orElse(null));
        out.put("rowIndex", m.rowIndex());
        out.put("cve", m.cve());
        out.put("rowProduct", m.rowProduct());
        out.put("source", m.source());
        out.put("component", m.component());
        out.put("installedVersion", m.installedVersion());
        out.put("status", m.status().code());
        out.put("reason", m.reason() == null ? null : m.reason().name());
        out.put("otherFamily", m.otherFamily());
        return out;
    }

    private static List<String> reasonCodes(Collection<Reason> reasons) {
        EnumMap<Reason, Boolean> ordered = new EnumMap<>(Reason.class);
        reasons.forEach(r -> ordered.put(r, true));
        return ordered.keySet().stream().map(Reason::name).toList();
    }

    /** 목록·한 건 응답의 버전 목록 요약 — 기준 시각과 제대로 모으지 못한 구역 이름. */
    private static Map<String, Object> inventorySummary(SecurityStore.Inventory inv, Instant now) {
        Map<String, Object> out = inventoryTimes(inv, now);
        out.put("notOkSections", orderedSections(inv.sections()).stream()
                .filter(s -> !EnvInventory.SectionStatus.OK.dbValue().equals(s.status())).map(SecurityStore.Section::name).toList());
        return out;
    }

    private static Map<String, Object> inventoryTimes(SecurityStore.Inventory inv, Instant now) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("collectedAt", iso(inv.collectedAt()));
        out.put("receivedAt", iso(inv.receivedAt()));
        Long age = inv.collectedAt() == null ? null : Math.max(0, Duration.between(inv.collectedAt(), now).getSeconds());
        out.put("ageSeconds", age);
        out.put("stale", age == null ? null : age > INVENTORY_STALE_AFTER.getSeconds());
        out.put("hostIncluded", inv.hostIncluded());
        out.put("aptListsAt", iso(inv.aptListsAt()));
        return out;
    }

    /** 구역 순서 — 별칭 표의 구역 순서(host·postgres·backend·frontend·collector·browser·caddy) 다음 나머지 이름순. */
    private static List<SecurityStore.Section> orderedSections(List<SecurityStore.Section> sections) {
        Map<String, SecurityStore.Section> byName = new TreeMap<>();
        sections.forEach(s -> byName.put(s.name(), s));
        List<SecurityStore.Section> out = new ArrayList<>();
        for (String name : ProductAliases.ALL_SECTIONS) {
            SecurityStore.Section s = byName.remove(name);
            if (s != null) {
                out.add(s);
            }
        }
        out.addAll(byName.values());
        return out;
    }

    /** 수집 상태 — 출처 판정(없으면 {@code recorded: false}와 null 칸)과 받아 둔 공지 수. */
    private Map<String, Object> collection(List<SecurityStore.Notice> notices) {
        Optional<SecurityStore.SourceState> state = store.sourceState(TASK);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("task", TASK);
        out.put("recorded", state.isPresent());
        out.put("status", state.map(SecurityStore.SourceState::status).orElse(null));
        out.put("streak", state.map(SecurityStore.SourceState::streak).orElse(null));
        out.put("reason", state.map(SecurityStore.SourceState::reason).orElse(null));
        out.put("lastOkAt", state.map(s -> iso(s.lastOkAt())).orElse(null));
        out.put("lastRunAt", state.map(s -> iso(s.lastRunAt())).orElse(null));
        out.put("staleAfterMinutes", state.map(SecurityStore.SourceState::staleAfterMinutes).orElse(null));
        out.put("notices", notices.size());
        Map<String, Object> details = new LinkedHashMap<>();
        for (String status : List.of("pending", "ok", "failed", "skipped")) {
            details.put(status, notices.stream().filter(n -> status.equals(n.detailStatus())).count());
        }
        out.put("details", details);
        out.put("oldestPostedOn", notices.stream().map(SecurityStore.Notice::postedOn).filter(d -> d != null)
                .min(LocalDate::compareTo).map(LocalDate::toString).orElse(null));
        out.put("newestPostedOn", notices.stream().map(SecurityStore.Notice::postedOn).filter(d -> d != null)
                .max(LocalDate::compareTo).map(LocalDate::toString).orElse(null));
        return out;
    }

    // ------------------------------------------------------------------ 인자

    private static Status parseVerdict(String verdict) {
        if (verdict == null || verdict.isBlank()) {
            return null;
        }
        String code = verdict.strip();
        for (Status status : Status.values()) {
            if (status.code().equals(code)) {
                return status;
            }
        }
        throw new InvalidRequestException("verdict는 " + String.join(" · ", STATUS_CODES) + " 가운데 하나여야 합니다");
    }

    private static Reason parseReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return null;
        }
        String code = reason.strip();
        for (Reason r : Reason.values()) {
            if (r.name().equals(code)) {
                return r;
            }
        }
        throw new InvalidRequestException("reason은 " + String.join(" · ", REASON_CODES) + " 가운데 하나여야 합니다");
    }

    private static String normalizeQuery(String query) {
        if (query == null || query.isBlank()) {
            return null;
        }
        String q = query.strip().toLowerCase(Locale.ROOT);
        return q.length() > MAX_QUERY ? q.substring(0, MAX_QUERY) : q;
    }

    private static boolean matchesQuery(Judged judged, String q) {
        if (contains(judged.notice().title(), q)) {
            return true;
        }
        if (judged.notice().products().stream().anyMatch(p -> contains(p, q))) {
            return true;
        }
        if (judged.rows().stream().anyMatch(r -> contains(r.cve(), q) || contains(r.product(), q))) {
            return true;
        }
        return judged.verdict().products().stream().anyMatch(p -> contains(p.label(), q));
    }

    private static boolean contains(String text, String q) {
        return text != null && text.toLowerCase(Locale.ROOT).contains(q);
    }

    /** ISO 시각(UTC, 초까지 — {@code 2026-11-21T03:00:00Z}). 없으면 null. */
    static String iso(Instant at) {
        return at == null ? null : at.truncatedTo(ChronoUnit.SECONDS).toString();
    }

    /** 쪽 나누기 — page는 1부터, size는 1~{@value #MAX_SIZE}(기본 {@value #DEFAULT_SIZE}). */
    record Paging(int page, int size) {
        static Paging of(Integer page, Integer size) {
            int s = size == null ? DEFAULT_SIZE : Math.max(1, Math.min(size, MAX_SIZE));
            int p = page == null ? 1 : Math.max(1, Math.min(page, 10_000));
            return new Paging(p, s);
        }

        int offset() {
            return (page - 1) * size;
        }

        void put(Map<String, Object> out, int total) {
            out.put("page", page);
            out.put("size", size);
            out.put("total", total);
            out.put("pages", Math.max(1, (total + size - 1) / size));
        }
    }
}
