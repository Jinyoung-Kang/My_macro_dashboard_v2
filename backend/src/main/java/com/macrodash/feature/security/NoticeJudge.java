package com.macrodash.feature.security;

import com.macrodash.feature.security.EnvInventory.Component;
import com.macrodash.feature.security.ProductAliases.Alias;
import com.macrodash.feature.security.ProductAliases.Family;
import com.macrodash.feature.security.ProductAliases.Kind;
import com.macrodash.feature.security.ProductAliases.ProductName;
import com.macrodash.feature.security.SecurityNotice.Row;
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
import java.util.Set;
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
 *   <li>배포판 패키지({@link Kind#DISTRO}): 호스트 패키지가 apt 보류 목록에 보안으로 있으면 해당, 없으면 {@code DISTRO_NO_PENDING}.
 *       컨테이너 안 패키지는 보류 목록이 없어 늘 {@code DISTRO_NO_PENDING}. 공지의 버전 표와 비교하지 않습니다.</li>
 *   <li>상류 번호({@link Kind#UPSTREAM}): 행마다 — 제조사가 다르면 {@code VENDOR_DIFFERS}, 영향 칸을 못 읽으면 {@code PARSE_FAILED},
 *       설치 버전이 영향 구간 안이면 해당. 그 밖에는 같은 계열의 행일 때만 — 해결 칸을 못 읽으면 {@code PARSE_FAILED}, 설치 버전이
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
                if (text.isEmpty() || REFERENCES_ONLY.matcher(text).matches() || BOILERPLATE.matcher(text).matches()) {
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
        for (Component c : cov.components()) {
            if (alias.kind() == Kind.DISTRO) {
                out.add(distro(alias, c, inventory));
            } else {
                out.addAll(upstream(alias, c, rows));
            }
        }
        return out;
    }

    /** 배포판 패키지 — 버전 표가 아니라 apt 보류(보안) 목록으로. 보류 목록은 호스트에만 있습니다. */
    private static Match distro(Alias alias, Component c, EnvInventory inventory) {
        if (!ProductAliases.SECTION_HOST.equals(c.source())) {
            return componentLevel(alias, c, Status.CHECK, Reason.DISTRO_NO_PENDING);
        }
        if (!inventory.sectionOk(ProductAliases.SECTION_HOST)) {
            return componentLevel(alias, c, Status.CHECK, Reason.NO_INVENTORY);
        }
        for (EnvInventory.Pending p : inventory.pending()) {
            if (p.security() && c.name().equals(p.pkg())) {
                return componentLevel(alias, c, Status.AFFECTED, null);
            }
        }
        return componentLevel(alias, c, Status.CHECK, Reason.DISTRO_NO_PENDING);
    }

    /** 상류 번호 — 행마다 비교하고, 같은 계열의 행이 하나도 없으면 {@code OUT_OF_TABLE}을 더합니다. */
    private static List<Match> upstream(Alias alias, Component c, List<Row> rows) {
        List<Match> out = new ArrayList<>();
        if (!alias.versionComparable()) {
            out.add(componentLevel(alias, c, Status.CHECK, Reason.NAME_MATCH));
            return out;
        }
        Optional<Version> installed = VersionOrder.parse(c.version());
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
        Optional<VersionRange> affected = VersionRange.parse(row.affected());
        if (affected.isEmpty()) {
            return rowLevel(alias, c, row, Status.CHECK, Reason.PARSE_FAILED, false);
        }
        if (affected.get().contains(installed)) {
            return rowLevel(alias, c, row, Status.AFFECTED, null, false);
        }
        Optional<VersionRange.Fixed> fixed = VersionRange.parseFixed(row.fixed());
        if (!sameFamily(alias.family(), installed, affected.get(), fixed)) {
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
        return new Match(alias.id(), null, null, null, section, null, null, status, reason, false);
    }

    private static Match componentLevel(Alias alias, Component c, Status status, Reason reason) {
        return new Match(alias.id(), null, null, null, c.source(), c.name(), c.version(), status, reason, false);
    }

    private static Match rowLevel(Alias alias, Component c, Row row, Status status, Reason reason, boolean otherFamily) {
        return new Match(alias.id(), row.index(), row.cve(), row.product(), c.source(), c.name(), c.version(), status, reason,
                otherFamily);
    }
}
