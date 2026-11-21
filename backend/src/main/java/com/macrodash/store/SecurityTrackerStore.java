package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 배포판 보안 추적기에 물어볼 것({@code security_tracker_wants}, V42 — ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기'). 백엔드가 쓰는 표입니다
 * (ADR 0008 — 수집기는 읽기만 하고, 물어 본 결과는 수집기 표 {@code distro_cve_status}).
 *
 * <p>보안 공지 알림 작업이 주기마다 판정에서 모은 집합으로 표를 통째로 맞춥니다 — 빠진 행은 지우고, 새 행은 넣고, 있는 행은 처음 넣은 시각
 * ({@code wanted_at})을 그대로 둡니다. 표의 CHECK(배포판·스위트·패키지·CVE 모양)에 맞지 않는 값은 넣지 않고 건너뜁니다(한 행 때문에 맞추기 전체가
 * 되돌려지지 않게). 값은 배포판·스위트·패키지 이름·CVE 번호뿐이고 설치 판은 들지 않습니다.
 */
@Repository
public class SecurityTrackerStore {

    /** 물어볼 것 한 벌 — 표의 기본 키(배포판·스위트·원본 패키지·CVE). */
    public record Want(String distro, String suite, String pkg, String cve) {
    }

    /** 맞춘 결과 — 새로 넣은 행·지운 행·모양이 틀려 건너뛴 값의 수. */
    public record SyncResult(int inserted, int deleted, int skipped) {
    }

    private static final Set<String> DISTROS = Set.of("ubuntu", "debian", "alpine");
    private static final Pattern SUITE = Pattern.compile("[a-z0-9][a-z0-9.+-]{0,31}");
    private static final Pattern PACKAGE = Pattern.compile("[a-z0-9][a-z0-9.+-]{0,99}");
    private static final Pattern CVE = Pattern.compile("CVE-[0-9]{4}-[0-9]{4,7}");

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;
    private final TransactionTemplate transactions;

    public SecurityTrackerStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /** 표가 있는가 — 수집기가 아직 V42를 적용하지 않았으면 false. */
    public boolean ready() {
        return schema.tableExists("security_tracker_wants");
    }

    /** 물어볼 것 전부(배포판·스위트·패키지·CVE 순). */
    public List<Want> wants() {
        return jdbc.query("SELECT distro, suite, package, cve FROM security_tracker_wants ORDER BY distro, suite, package, cve",
                (rs, rowNum) -> new Want(rs.getString("distro"), rs.getString("suite"), rs.getString("package"), rs.getString("cve")));
    }

    /**
     * 표를 {@code wanted}로 맞춥니다(한 트랜잭션) — 빠진 행을 지우고 새 행을 넣습니다. 있는 행은 건드리지 않습니다(처음 넣은 시각 그대로).
     * 모양이 틀린 값은 건너뜁니다.
     */
    public SyncResult replaceAll(Collection<Want> wanted) {
        Set<Want> valid = new LinkedHashSet<>();
        int skipped = 0;
        for (Want want : wanted) {
            if (valid(want)) {
                valid.add(want);
            } else {
                skipped++;
            }
        }
        int skippedCount = skipped;
        return transactions.execute(status -> {
            Set<Want> existing = new HashSet<>(wants());
            List<Object[]> deletes = new ArrayList<>();
            for (Want want : existing) {
                if (!valid.contains(want)) {
                    deletes.add(new Object[]{want.distro(), want.suite(), want.pkg(), want.cve()});
                }
            }
            List<Object[]> inserts = new ArrayList<>();
            for (Want want : valid) {
                if (!existing.contains(want)) {
                    inserts.add(new Object[]{want.distro(), want.suite(), want.pkg(), want.cve()});
                }
            }
            if (!deletes.isEmpty()) {
                jdbc.batchUpdate("DELETE FROM security_tracker_wants WHERE distro = ? AND suite = ? AND package = ? AND cve = ?", deletes);
            }
            if (!inserts.isEmpty()) {
                jdbc.batchUpdate("INSERT INTO security_tracker_wants (distro, suite, package, cve) VALUES (?, ?, ?, ?) "
                        + "ON CONFLICT (distro, suite, package, cve) DO NOTHING", inserts);
            }
            return new SyncResult(inserts.size(), deletes.size(), skippedCount);
        });
    }

    /** 표의 CHECK와 같은 모양인지. */
    static boolean valid(Want want) {
        return want != null && want.distro() != null && DISTROS.contains(want.distro())
                && want.suite() != null && SUITE.matcher(want.suite()).matches()
                && want.pkg() != null && PACKAGE.matcher(want.pkg()).matches()
                && want.cve() != null && CVE.matcher(want.cve()).matches();
    }
}
