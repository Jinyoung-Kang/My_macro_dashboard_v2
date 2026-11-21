package com.macrodash.feature.security;

import com.macrodash.feature.security.EnvInventory.Component;
import com.macrodash.feature.security.ProductAliases.Alias;
import com.macrodash.feature.security.ProductAliases.Family;
import com.macrodash.feature.security.ProductAliases.Kind;
import com.macrodash.feature.security.ProductAliases.ProductName;
import com.macrodash.feature.security.SecurityNotice.Row;
import com.macrodash.feature.security.Verdict.Basis;
import com.macrodash.feature.security.Verdict.Match;
import com.macrodash.feature.security.Verdict.ProductVerdict;
import com.macrodash.feature.security.Verdict.Reason;
import com.macrodash.feature.security.Verdict.Status;
import com.macrodash.feature.security.VersionOrder.Version;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 공지 판정(ADR 0046 결정 6·9) — 공지 한 건 × 버전 목록의 순수 함수입니다(저장하지 않고 읽을 때 계산 — 결정 5). AI를 쓰지 않습니다.
 *
 * <p>제품(별칭)마다:
 * <ol>
 *   <li>공지 표의 제품명이 별칭에 맞는 행을 모읍니다. 맞는 행이 없으면 제목·본문에 별칭이 나오는지 봅니다(나오면 확인 필요 —
 *       표가 없는 공지는 {@code NO_VERSION_TABLE}, 표가 있는데 그 제품 행이 없거나 상세 전이면 {@code NAME_MATCH}).</li>
 *   <li>버전 목록이 없으면 확인 필요 {@code NO_INVENTORY}. 별칭의 구역을 모두 모았는데 구성 요소가 없으면 설치돼 있지 않은 것(무관),
 *       모으지 못한 구역이 있으면 그 구역은 {@code NO_INVENTORY}.</li>
 *   <li>배포판 패키지({@link Kind#DISTRO}): 호스트 패키지가 apt 보류 목록에 보안으로 있으면 해당. 없으면 공지 표에서 그 제품 행의 CVE가
 *       모두 그 패키지(원본·버전)의 변경 기록에 있을 때 패치됨(근거 {@link Basis#CHANGELOG} — ADR 0046 덧붙임 2026-11-21), 그 밖은
 *       {@code DISTRO_NO_PENDING}. 실행 중인 것만 보는 별칭({@link ProductAliases.Alias#runningOnly()} — 커널)은 런타임 구성 요소가 있으면
 *       그것만 변경 기록으로 판정하고 패키지 줄은 보류(해당)에만 씁니다. 컨테이너 안 패키지는 보류 목록·변경 기록이 없어 늘
 *       {@code DISTRO_NO_PENDING}. 공지의 버전 표와 비교하지 않습니다.</li>
 *   <li>PPA 판 규칙({@link ProductAliases.Alias#distroUnlessPpa()} — Git, QA-979): 상류 번호 별칭의 dpkg 구성 요소는 판이 PPA면 그 상류 판으로
 *       아래 상류 번호 판정을, 배포판 판이면 위 배포판 패키지 판정을 받습니다.</li>
 *   <li>상류 번호({@link Kind#UPSTREAM}): 행마다 — 제조사가 다르면 {@code VENDOR_DIFFERS}, 영향 칸을 못 읽으면 {@code PARSE_FAILED},
 *       설치 버전이 영향 구간 안이면 해당(아래 끝이 없는 구간은 위 끝의 계열로 좁힘 — {@link VersionRange#scopedToFamily}, QA-975). 그 밖에는 같은 계열의 행일 때만 — 해결 칸을 못 읽으면 {@code PARSE_FAILED}, 설치 버전이
 *       해결 버전 이상이면 패치됨, 아니면 {@code OUT_OF_TABLE}. 다른 계열의 행은 판정에 쓰지 않고, 같은 계열의 행이 하나도 없으면
 *       {@code OUT_OF_TABLE}(16.x 행만 있는데 17.x를 쓰면 확인 필요).</li>
 *   <li>제품 판정 = 근거들의 최댓값. 표 밖 {@code ※} 조건 문장(관용 문장 제외)이 있으면 — 해당은 그대로 두고 '조건 문장 있음'
 *       ({@code CONDITION_NOTE})을 붙이고, 패치됨은 확인 필요로 내립니다(결정 9의 1).</li>
 * </ol>
 * 공지 판정은 제품 판정의 최댓값(해당 &gt; 확인 필요 &gt; 패치됨 &gt; 무관)이고, 맞는 제품이 없으면 무관입니다.
 * 모르는 것(해석 실패·버전 목록 없음·계열 밖)은 패치됨·무관으로 두지 않습니다.
 */
public final class NoticeJudge {

    /**
     * 판정에 쓰지 않는 관용 {@code ※} 문장 — 거의 모든 제품 공지 끝에 붙는 '하단의 참고 사이트를 확인하여 업데이트 수행 [1]' 꼴과
     * 참고 번호만 남은 조각. 이것까지 조건으로 치면 모든 패치됨이 확인 필요가 됩니다.
     */
    private static final Pattern BOILERPLATE = Pattern.compile(
            "^(?:하단의\\s*)?참고\\s*(?:사이트|자료)[^※]{0,40}?업데이트(?:\\s*(?:수행|권고|필요|바람))?[\\s\\[\\]\\d~,.\\-]*$");
    private static final Pattern REFERENCES_ONLY = Pattern.compile("^[\\s\\[\\]\\d~,.\\-]*$");
    /**
     * 판정에 쓰지 않는 관용 {@code ※} 문장 둘째 — 운영체제 공지 끝의 '보안 업데이트가 공개된 운영체제를 운영하고 있을 경우, 참고 사이트의 내용을
     * 참조하여 보안 조치 또는 업데이트 수행(…)' 꼴(조건이 아니라 안내 — ADR 0046 덧붙임 2026-11-21).
     */
    private static final Pattern OS_UPDATE_GUIDE = Pattern.compile(
            "^보안\\s*업데이트가\\s*공개된\\s*운영\\s*체제를\\s*운영하고\\s*있을\\s*경우[,\\s]*참고\\s*사이트의\\s*내용을\\s*참조하여\\s*"
                    + "보안\\s*조치\\s*또는\\s*업데이트\\s*수행(?:\\s*\\([^()]{0,80}\\))?[\\s\\[\\]\\d~,.\\-]*$");
    private static final Pattern CVE_ID = Pattern.compile("CVE-\\d{4}-\\d{4,7}(?!\\d)", Pattern.CASE_INSENSITIVE);

    private NoticeJudge() {
    }

    /** 처음 별칭 표({@link ProductAliases#defaults()})로 판정합니다. {@code inventory}가 {@code null}이면 버전 목록 없음. */
    public static Verdict judge(SecurityNotice notice, List<Row> rows, EnvInventory inventory) {
        return judge(notice, rows, inventory, ProductAliases.defaults());
    }

    public static Verdict judge(SecurityNotice notice, List<Row> rows, EnvInventory inventory, ProductAliases aliases) {
        List<Row> tableRows = rows == null ? List.of() : rows;
        List<String> notes = conditionNotes(notice.conditionNotes());
        String text = notice.title() + "\n" + (notice.bodyText() == null ? "" : notice.bodyText());

        List<ProductVerdict> products = new ArrayList<>();
        List<Match> matches = new ArrayList<>();
        for (Alias alias : aliases.aliases()) {
            List<Row> hit = new ArrayList<>();
            for (Row row : tableRows) {
                if (alias.matchProduct(row.product()).isPresent()) {
                    hit.add(row);
                }
            }
            List<Match> found;
            if (!hit.isEmpty()) {
                found = judgeRows(alias, hit, inventory);
            } else if (alias.mentionedIn(text)) {
                found = judgeMention(alias, mentionReason(notice, tableRows), inventory);
            } else {
                continue;
            }
            products.add(productVerdict(alias, found, notes));
            matches.addAll(found);
        }

        Status status = Status.UNRELATED;
        for (ProductVerdict product : products) {
            status = Status.max(status, product.status());
        }
        Set<Reason> reasons = EnumSet.noneOf(Reason.class);
        for (ProductVerdict product : products) {
            if (product.status() == status) {
                reasons.addAll(product.reasons());
            }
        }
        return new Verdict(status, reasons, products, matches, notes);
    }

    /** 판정에 쓰는 {@code ※} 조건 문장 — 문장마다 {@code ※}로 더 나누고, 관용 문장·참고 번호만 남은 조각·겹침을 뺍니다. */
    public static List<String> conditionNotes(List<String> raw) {
        Set<String> out = new LinkedHashSet<>();
        if (raw == null) {
            return List.of();
        }
        for (String note : raw) {
            if (note == null) {
                continue;
            }
            for (String piece : note.split("※")) {
                String text = ProductAliases.normalizeText(piece);
                if (text.isEmpty() || REFERENCES_ONLY.matcher(text).matches() || BOILERPLATE.matcher(text).matches()
                        || OS_UPDATE_GUIDE.matcher(text).matches()) {
                    continue;
                }
                out.add(text);
            }
        }
        return List.copyOf(out);
    }

    // ---- 제품 하나 ---------------------------------------------------------------------------------------------

    private static Reason mentionReason(SecurityNotice notice, List<Row> rows) {
        if (!rows.isEmpty() || notice.template() == null) {
            // 표가 있는데 그 제품 행이 없음, 또는 상세를 아직 받지 못해 제목만 봄.
            return Reason.NAME_MATCH;
        }
        return Reason.NO_VERSION_TABLE;
    }

    private static ProductVerdict productVerdict(Alias alias, List<Match> found, List<String> notes) {
        Status status = Status.UNRELATED;
        for (Match m : found) {
            if (!m.otherFamily()) {
                status = Status.max(status, m.status());
            }
        }
        Set<Reason> reasons = EnumSet.noneOf(Reason.class);
        for (Match m : found) {
            if (!m.otherFamily() && m.status() == status && m.reason() != null) {
                reasons.add(m.reason());
            }
        }
        if (!notes.isEmpty() && status != Status.UNRELATED) {
            if (status == Status.PATCHED) {
                status = Status.CHECK;
            }
            reasons.add(Reason.CONDITION_NOTE);
        }
        return new ProductVerdict(alias.id(), alias.label(), status, reasons);
    }

    private record Coverage(List<Component> components, List<String> missingSections) {
    }

    private static Coverage coverage(Alias alias, EnvInventory inventory) {
        List<Component> components = new ArrayList<>();
        for (Component c : inventory.components()) {
            if (alias.matchesComponent(c)) {
                components.add(c);
            }
        }
        List<String> missing = new ArrayList<>();
        for (String section : alias.sections()) {
            if (!inventory.sectionOk(section)) {
                missing.add(section);
            }
        }
        return new Coverage(components, missing);
    }

    private static List<Match> judgeMention(Alias alias, Reason reason, EnvInventory inventory) {
        List<Match> out = new ArrayList<>();
        if (inventory == null) {
            out.add(aliasLevel(alias, null, Status.CHECK, reason));
            out.add(aliasLevel(alias, null, Status.CHECK, Reason.NO_INVENTORY));
            return out;
        }
        Coverage cov = coverage(alias, inventory);
        for (String section : cov.missingSections()) {
            out.add(aliasLevel(alias, section, Status.CHECK, Reason.NO_INVENTORY));
        }
        for (Component c : cov.components()) {
            out.add(componentLevel(alias, c, Status.CHECK, reason));
        }
        return out;
    }

    private static List<Match> judgeRows(Alias alias, List<Row> rows, EnvInventory inventory) {
        List<Match> out = new ArrayList<>();
        if (inventory == null) {
            out.add(aliasLevel(alias, null, Status.CHECK, Reason.NO_INVENTORY));
            return out;
        }
        Coverage cov = coverage(alias, inventory);
        for (String section : cov.missingSections()) {
            out.add(aliasLevel(alias, section, Status.CHECK, Reason.NO_INVENTORY));
        }
        if (alias.kind() == Kind.DISTRO) {
            Set<String> cves = rowCves(rows);
            boolean running = alias.runningOnly()
                    && cov.components().stream().anyMatch(c -> ProductAliases.ECO_RUNTIME.equals(c.ecosystem()));
            for (Component c : cov.components()) {
                if (!running || ProductAliases.ECO_RUNTIME.equals(c.ecosystem())) {
                    out.add(distro(alias, c, inventory, cves));
                } else if (pendingSecurity(c, inventory)) {
                    // 실행 중인 것만 보는 별칭(커널)의 패키지 줄 — 보안 보류면 해당, 그 밖은 근거로 남기지 않음(옛 판·서명·메타 패키지).
                    out.add(componentLevel(alias, c, Status.AFFECTED, null));
                }
            }
            return out;
        }
        Set<String> cves = null;
        for (Component c : cov.components()) {
            if (alias.distroUnlessPpa() && ProductAliases.ECO_DPKG.equals(c.ecosystem())) {
                // dpkg 판이 PPA면 상류 판으로 공지 표와, 배포판 판이면 배포판 경로로(QA-979 — Git).
                Optional<String> ppa = DistroVersion.ppaUpstream(c.version());
                if (ppa.isPresent()) {
                    out.addAll(upstream(alias, c, ppa.get(), rows));
                } else {
                    if (cves == null) {
                        cves = rowCves(rows);
                    }
                    out.add(distro(alias, c, inventory, cves));
                }
                continue;
            }
            out.addAll(upstream(alias, c, c.version(), rows));
        }
        return out;
    }

    /**
     * 배포판 패키지 — 버전 표가 아니라 apt 보류(보안) 목록과 변경 기록으로. 둘 다 호스트에만 있습니다.
     * 보안 보류면 해당, 아니면 {@code cves}(그 제품 행의 CVE 전부)가 그 패키지 원본·버전(실행 중인 커널은 {@code kernel}·{@code uname -r})의
     * 변경 기록에 모두 있을 때 패치됨, 그 밖은 확인 필요 {@code DISTRO_NO_PENDING}(변경 기록에 없다고 취약하다는 뜻은 아님).
     */
    private static Match distro(Alias alias, Component c, EnvInventory inventory, Set<String> cves) {
        if (!ProductAliases.SECTION_HOST.equals(c.source())) {
            return componentLevel(alias, c, Status.CHECK, Reason.DISTRO_NO_PENDING);
        }
        if (!inventory.sectionOk(ProductAliases.SECTION_HOST)) {
            return componentLevel(alias, c, Status.CHECK, Reason.NO_INVENTORY);
        }
        if (pendingSecurity(c, inventory)) {
            return componentLevel(alias, c, Status.AFFECTED, null);
        }
        if (inventory.changelogHasAll(c.sourcePackageName().orElse(c.name()), c.version(), cves)) {
            return new Match(alias.id(), null, null, null, c.source(), c.name(), c.version(), Status.PATCHED, null, false,
                    Basis.CHANGELOG);
        }
        return componentLevel(alias, c, Status.CHECK, Reason.DISTRO_NO_PENDING);
    }

    private static boolean pendingSecurity(Component c, EnvInventory inventory) {
        for (EnvInventory.Pending p : inventory.pending()) {
            if (p.security() && c.name().equals(p.pkg())) {
                return true;
            }
        }
        return false;
    }

    /** 그 제품 행들의 CVE 번호 전부(대문자). 번호를 읽지 못한 행이 하나라도 있으면 빈 집합 — 변경 기록으로 판정하지 않습니다. */
    static Set<String> rowCves(List<Row> rows) {
        Set<String> out = new LinkedHashSet<>();
        for (Row row : rows) {
            boolean found = false;
            Matcher m = CVE_ID.matcher(row.cve() == null ? "" : row.cve());
            while (m.find()) {
                out.add(m.group().toUpperCase(Locale.ROOT));
                found = true;
            }
            if (!found) {
                return Set.of();
            }
        }
        return out;
    }

    /**
     * 상류 번호 — 행마다 비교하고, 같은 계열의 행이 하나도 없으면 {@code OUT_OF_TABLE}을 더합니다. {@code version}은 견줄 설치 버전
     * (보통 구성 요소의 버전, PPA 판이면 그 상류 판 — 근거의 설치 버전은 원문 그대로 남깁니다).
     */
    private static List<Match> upstream(Alias alias, Component c, String version, List<Row> rows) {
        List<Match> out = new ArrayList<>();
        if (!alias.versionComparable()) {
            out.add(componentLevel(alias, c, Status.CHECK, Reason.NAME_MATCH));
            return out;
        }
        Optional<Version> installed = VersionOrder.parse(version);
        if (installed.isEmpty()) {
            out.add(componentLevel(alias, c, Status.CHECK, Reason.PARSE_FAILED));
            return out;
        }
        boolean anySameFamily = false;
        for (Row row : rows) {
            Match m = upstreamRow(alias, c, installed.get(), row);
            anySameFamily |= !m.otherFamily();
            out.add(m);
        }
        if (!anySameFamily) {
            out.add(componentLevel(alias, c, Status.CHECK, Reason.OUT_OF_TABLE));
        }
        return out;
    }

    private static Match upstreamRow(Alias alias, Component c, Version installed, Row row) {
        ProductName name = alias.matchProduct(row.product()).orElseThrow();
        if (alias.vendorDiffers(name)) {
            return rowLevel(alias, c, row, Status.CHECK, Reason.VENDOR_DIFFERS, false);
        }
        Optional<VersionRange> parsed = VersionRange.parse(row.affected());
        if (parsed.isEmpty()) {
            return rowLevel(alias, c, row, Status.CHECK, Reason.PARSE_FAILED, false);
        }
        // 아래 끝이 없는 구간은 위 끝의 계열만 다룹니다(QA-975 — '32.9.1 미만'이 30.x를 품지 않게).
        VersionRange affected = parsed.get().scopedToFamily(alias.family().depth());
        if (affected.contains(installed)) {
            return rowLevel(alias, c, row, Status.AFFECTED, null, false);
        }
        Optional<VersionRange.Fixed> fixed = VersionRange.parseFixed(row.fixed());
        if (!sameFamily(alias.family(), installed, affected, fixed)) {
            return rowLevel(alias, c, row, Status.UNRELATED, null, true);
        }
        if (fixed.isEmpty()) {
            return rowLevel(alias, c, row, Status.CHECK, Reason.PARSE_FAILED, false);
        }
        if (patched(alias.family(), installed, fixed.get())) {
            return rowLevel(alias, c, row, Status.PATCHED, null, false);
        }
        return rowLevel(alias, c, row, Status.CHECK, Reason.OUT_OF_TABLE, false);
    }

    /** 이 행이 설치 버전의 계열을 다루는지 — 영향 구간이 그 계열과 겹치거나 해결 버전이 그 계열 안. SINGLE은 늘 같은 계열. */
    static boolean sameFamily(Family family, Version installed, VersionRange affected, Optional<VersionRange.Fixed> fixed) {
        if (family == Family.SINGLE) {
            return true;
        }
        Version from = installed.prefix(family.depth());
        Version to = installed.nextPrefix(family.depth());
        if (affected.overlaps(from, to)) {
            return true;
        }
        if (fixed.isPresent()) {
            for (Version v : fixed.get().minimums()) {
                if (inFamily(v, from, to)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 설치 버전이 해결 버전 이상인지 — 해결 버전이 여럿이면 같은 계열의 것(없으면 전부) 가운데 가장 낮은 것과 비교. 해결 버전 없음({@code -})은 아님. */
    static boolean patched(Family family, Version installed, VersionRange.Fixed fixed) {
        if (fixed.none()) {
            return false;
        }
        List<Version> candidates = new ArrayList<>();
        if (family != Family.SINGLE) {
            Version from = installed.prefix(family.depth());
            Version to = installed.nextPrefix(family.depth());
            for (Version v : fixed.minimums()) {
                if (inFamily(v, from, to)) {
                    candidates.add(v);
                }
            }
        }
        if (candidates.isEmpty()) {
            candidates.addAll(fixed.minimums());
        }
        Version lowest = candidates.get(0);
        for (Version v : candidates) {
            if (v.compareTo(lowest) < 0) {
                lowest = v;
            }
        }
        return installed.compareTo(lowest) >= 0;
    }

    private static boolean inFamily(Version v, Version from, Version toExclusive) {
        return v.compareTo(from) >= 0 && v.compareTo(toExclusive) < 0;
    }

    // ---- 근거 만들기 ---------------------------------------------------------------------------------------------

    private static Match aliasLevel(Alias alias, String section, Status status, Reason reason) {
        return new Match(alias.id(), null, null, null, section, null, null, status, reason, false, null);
    }

    private static Match componentLevel(Alias alias, Component c, Status status, Reason reason) {
        return new Match(alias.id(), null, null, null, c.source(), c.name(), c.version(), status, reason, false, null);
    }

    private static Match rowLevel(Alias alias, Component c, Row row, Status status, Reason reason, boolean otherFamily) {
        return new Match(alias.id(), row.index(), row.cve(), row.product(), c.source(), c.name(), c.version(), status, reason,
                otherFamily, null);
    }
}
