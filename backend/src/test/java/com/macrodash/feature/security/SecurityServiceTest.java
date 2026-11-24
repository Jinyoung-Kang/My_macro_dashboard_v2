package com.macrodash.feature.security;

import com.macrodash.store.SecurityStore;
import com.macrodash.store.SecurityTrackerStore;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 보안 공지 화면의 서비스(ADR 0046) — 읽을 때 판정을 계산해 건수·거르기·쪽을 내고, 버전 목록이 없으면 제품이 맞는 공지를 확인 필요로 둔다.
 * 저장소는 대역이고, 공지·표 행·버전은 모두 가짜(운영 서버의 실제 버전 목록과 무관)입니다.
 */
class SecurityServiceTest {

    /** 2026-11-21 12:00 KST. */
    static final Instant NOW = Instant.parse("2026-11-21T03:00:00Z");
    static final Instant COLLECTED = Instant.parse("2026-11-20T22:20:00Z");

    private SecurityStore store;
    private SecurityService service;
    private final List<SecurityStore.Notice> notices = new ArrayList<>();
    private final List<SecurityStore.NoticeRow> rows = new ArrayList<>();

    static SecurityStore.Notice notice(long id, String title, String postedOn, String status, String layout, List<String> notes,
                                       String body) {
        return new SecurityStore.Notice(id, (int) (id % 1000), title, LocalDate.parse(postedOn),
                "https://boho.example/view?nttId=" + id, false, status, "ok".equals(status) ? 1 : 0, null, layout,
                List.of(), notes, body, NOW.minusSeconds(86_400), "ok".equals(status) ? NOW.minusSeconds(3_600) : null);
    }

    static SecurityStore.NoticeRow row(long id, int no, String cve, String product, String affected, String fixed) {
        return new SecurityStore.NoticeRow(id, no, cve, product, affected, fixed);
    }

    /** 일곱 구역 모두 ok, 가짜 PostgreSQL 16.42·Node.js 22.20. */
    static void fakeInventory(SecurityStore store, Instant collectedAt) {
        List<SecurityStore.Section> sections = new ArrayList<>();
        for (String name : List.of("caddy", "host", "postgres", "backend", "frontend", "collector", "browser")) {
            sections.add(new SecurityStore.Section(name, "ok", 1, null));
        }
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.of(new SecurityStore.Inventory(collectedAt, collectedAt.plusSeconds(5), true,
                null, sections)));
        when(store.components()).thenReturn(List.of(
                new SecurityStore.Component("frontend", "runtime", "node", "22.20.0", null),
                new SecurityStore.Component("postgres", "runtime", "postgres", "16.42", null)));
        when(store.pending()).thenReturn(List.of(
                new SecurityStore.Pending("fake-lib", "amd64", "1.0-1", "1.0-2", "noble-security", true),
                new SecurityStore.Pending("fake-tool", "amd64", "2.0", "2.1", "noble", false)));
    }

    /** 다섯 공지 — 해당(PostgreSQL)·패치됨(Node.js)·무관·확인 필요(표 없는 공지에 PostgreSQL)·확인 필요(상세 전, 제목에 Node.js). */
    void fiveNotices() {
        notices.add(notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9001, 0, "CVE-2099-1001", "PostgreSQL", "16 이상 16.50 미만", "16.50 이상"));
        rows.add(row(9001, 1, "CVE-2099-1002, CVE-2099-1003", "PostgreSQL", "15 이상 15.70 미만", "15.70 이상"));
        notices.add(notice(9002, "가짜 Node.js 보안 업데이트 권고", "2026-11-19", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9002, 0, "CVE-2099-2001", "Node.js", "22 이상 22.10 미만", "22.10 이상"));
        notices.add(notice(9003, "가짜 사무용 제품 보안 업데이트 권고", "2026-11-18", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9003, 0, "CVE-2099-3001", "가짜 사무용 제품", "1.0 이상 1.5 미만", "1.5 이상"));
        notices.add(notice(9004, "가짜 안내 — PostgreSQL 사용자 주의", "2026-11-17", "ok", "no_table", List.of(), "가짜 안내 본문"));
        notices.add(notice(9005, "가짜 Node.js 취약점 안내", "2026-11-16", "pending", null, List.of(), null));
    }

    @BeforeEach
    void setUp() {
        store = mock(SecurityStore.class);
        when(store.ready()).thenReturn(true);
        when(store.notices()).thenAnswer(call -> List.copyOf(notices));
        when(store.rows()).thenAnswer(call -> List.copyOf(rows));
        when(store.rows(anyLong())).thenAnswer(call -> rows.stream().filter(r -> r.nttId() == (long) call.getArgument(0)).toList());
        when(store.notice(anyLong())).thenAnswer(call -> notices.stream().filter(n -> n.nttId() == (long) call.getArgument(0)).findFirst());
        when(store.sourceState("kisa_security_notices")).thenReturn(Optional.of(new SecurityStore.SourceState("ok", 1, null,
                NOW.minusSeconds(600), NOW.minusSeconds(600), 1080)));
        service = new SecurityService(store, ProductAliases.defaults(), Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> items(Map<String, Object> out) {
        return (List<Map<String, Object>>) out.get("items");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Test
    @DisplayName("판정별 건수와 공지마다의 판정·사유·제품, 버전 목록 기준 시각(ISO)·수집 상태를 낸다")
    void countsAndItems() {
        fiveNotices();
        fakeInventory(store, COLLECTED);

        Map<String, Object> out = service.notices(null, null, null, null, null);

        assertThat(out.get("available")).isEqualTo(true);
        assertThat(out.get("checkedAt")).isEqualTo("2026-11-21T03:00:00Z");
        assertThat(map(out.get("counts"))).containsEntry("affected", 1L).containsEntry("check", 2L)
                .containsEntry("patched", 1L).containsEntry("unrelated", 1L).containsEntry("total", 5);
        assertThat(items(out)).extracting(i -> i.get("nttId")).containsExactly(9001L, 9002L, 9003L, 9004L, 9005L);
        assertThat(items(out)).extracting(i -> i.get("verdict")).containsExactly("affected", "patched", "unrelated", "check", "check");
        Map<String, Object> first = items(out).get(0);
        assertThat(first.get("postedOn")).isEqualTo("2026-11-20");
        assertThat(first.get("rowCount")).isEqualTo(2);
        assertThat(first.get("cveCount")).as("한 칸에 둘 — 겹침 없이 셋").isEqualTo(3);
        assertThat(first.get("conditionNote")).isEqualTo(false);
        assertThat((List<Map<String, Object>>) first.get("products")).singleElement()
                .satisfies(p -> assertThat(p).containsEntry("aliasId", "postgresql").containsEntry("status", "affected"));
        assertThat(items(out).get(3).get("reasons")).isEqualTo(List.of("NO_VERSION_TABLE"));
        assertThat(items(out).get(3).get("cveCount")).as("표 없는 공지는 셀 수 없음").isNull();
        assertThat(items(out).get(4).get("reasons")).isEqualTo(List.of("NAME_MATCH"));
        assertThat(first).doesNotContainKey("bodyText");

        Map<String, Object> inventory = map(out.get("inventory"));
        assertThat(inventory).containsEntry("collectedAt", "2026-11-20T22:20:00Z").containsEntry("ageSeconds", 16_800L)
                .containsEntry("stale", false).containsEntry("hostIncluded", true).containsEntry("aptListsAt", null)
                .containsEntry("notOkSections", List.of());
        Map<String, Object> collection = map(out.get("collection"));
        assertThat(collection).containsEntry("recorded", true).containsEntry("status", "ok").containsEntry("notices", 5)
                .containsEntry("oldestPostedOn", "2026-11-16").containsEntry("newestPostedOn", "2026-11-20")
                .containsEntry("lastOkAt", "2026-11-21T02:50:00Z");
        assertThat(map(collection.get("details"))).containsEntry("ok", 4L).containsEntry("pending", 1L).containsEntry("failed", 0L);
    }

    @Test
    @DisplayName("판정·사유로 거르면 건수(counts)는 그대로, 목록·total만 줄고, 사유별 건수는 판정까지 거른 뒤의 수")
    void filterByVerdictAndReason() {
        fiveNotices();
        fakeInventory(store, COLLECTED);

        Map<String, Object> check = service.notices("check", null, null, null, null);
        assertThat(items(check)).extracting(i -> i.get("nttId")).containsExactly(9004L, 9005L);
        assertThat(check.get("total")).isEqualTo(2);
        assertThat(map(check.get("counts"))).containsEntry("total", 5);
        assertThat(map(check.get("reasonCounts"))).containsEntry("NO_VERSION_TABLE", 1L).containsEntry("NAME_MATCH", 1L)
                .containsEntry("NO_INVENTORY", 0L);

        Map<String, Object> reason = service.notices("check", "NO_VERSION_TABLE", null, null, null);
        assertThat(items(reason)).extracting(i -> i.get("nttId")).containsExactly(9004L);

        assertThatThrownBy(() -> service.notices("safe", null, null, null, null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.notices(null, "no_inventory", null, null, null)).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("검색어는 제목·제품명·CVE·판정 제품 이름에서 대소문자 없이 찾고, 건수도 검색 결과로 센다")
    void query() {
        fiveNotices();
        fakeInventory(store, COLLECTED);

        Map<String, Object> node = service.notices(null, null, "  NODE.JS ", null, null);
        assertThat(items(node)).extracting(i -> i.get("nttId")).containsExactly(9002L, 9005L);
        assertThat(map(node.get("counts"))).containsEntry("total", 2).containsEntry("patched", 1L).containsEntry("check", 1L);

        assertThat(items(service.notices(null, null, "cve-2099-1003", null, null))).extracting(i -> i.get("nttId"))
                .containsExactly(9001L);
    }

    @Test
    @DisplayName("쪽 나누기 — page·size(상한 100)와 total·pages")
    void paging() {
        fiveNotices();
        fakeInventory(store, COLLECTED);

        Map<String, Object> second = service.notices(null, null, null, 2, 2);
        assertThat(items(second)).extracting(i -> i.get("nttId")).containsExactly(9003L, 9004L);
        assertThat(second).containsEntry("page", 2).containsEntry("size", 2).containsEntry("total", 5).containsEntry("pages", 3);

        Map<String, Object> beyond = service.notices(null, null, null, 9, 2);
        assertThat(items(beyond)).isEmpty();
        assertThat(service.notices(null, null, null, null, 5_000)).containsEntry("size", 100);
    }

    @Test
    @DisplayName("버전 목록이 없으면 제품이 맞는 공지는 모두 확인 필요(NO_INVENTORY)이고 해당·패치됨은 0, inventory는 null")
    void noInventory() {
        fiveNotices();
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.empty());

        Map<String, Object> out = service.notices(null, null, null, null, null);

        assertThat(out.get("inventory")).isNull();
        assertThat(map(out.get("counts"))).containsEntry("affected", 0L).containsEntry("patched", 0L).containsEntry("check", 4L)
                .containsEntry("unrelated", 1L);
        assertThat(items(out).get(0)).containsEntry("verdict", "check").containsEntry("reasons", List.of("NO_INVENTORY"));
        assertThat(items(out).get(1)).containsEntry("verdict", "check").containsEntry("reasons", List.of("NO_INVENTORY"));
        assertThat(service.loadInventory()).isEmpty();
    }

    @Test
    @DisplayName("버전 목록이 2일보다 오래됐으면 stale, 제대로 모으지 못한 구역은 notOkSections")
    void staleInventory() {
        fiveNotices();
        fakeInventory(store, NOW.minusSeconds(3 * 86_400));
        when(store.inventory()).thenReturn(Optional.of(new SecurityStore.Inventory(NOW.minusSeconds(3 * 86_400), NOW, true, null,
                List.of(new SecurityStore.Section("host", "ok", 3, null), new SecurityStore.Section("postgres", "failed", null, "가짜 사유"),
                        new SecurityStore.Section("browser", "skipped", 0, null)))));

        Map<String, Object> inventory = map(service.notices(null, null, null, null, null).get("inventory"));

        assertThat(inventory).containsEntry("stale", true).containsEntry("notOkSections", List.of("postgres", "browser"));
    }

    @Test
    @DisplayName("한 건 — 틀 종류·※ 문장·표 행마다 판정·사유·설치 버전, 행에 매이지 않는 근거는 generalMatches")
    @SuppressWarnings("unchecked")
    void detail() {
        fiveNotices();
        notices.set(0, notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok", "product_table",
                List.of("※ 가짜 확장 기능을 켠 경우에만 해당"), "가짜 개요"));
        fakeInventory(store, COLLECTED);

        Map<String, Object> out = service.notice(9001);

        Map<String, Object> notice = map(out.get("notice"));
        assertThat(notice).containsEntry("nttId", 9001L).containsEntry("layout", "product_table").containsEntry("verdict", "affected")
                .containsEntry("conditionNote", true).containsEntry("reasons", List.of("CONDITION_NOTE"))
                .containsEntry("conditionNotes", List.of("가짜 확장 기능을 켠 경우에만 해당"))
                .containsEntry("bodyText", "가짜 개요").containsEntry("detailFetchedAt", "2026-11-21T02:00:00Z");
        List<Map<String, Object>> tableRows = (List<Map<String, Object>>) out.get("rows");
        assertThat(tableRows).hasSize(2);
        assertThat(tableRows.get(0)).containsEntry("index", 0).containsEntry("status", "affected").containsEntry("affected", "16 이상 16.50 미만");
        List<Map<String, Object>> matches = (List<Map<String, Object>>) tableRows.get(0).get("matches");
        assertThat(matches).singleElement().satisfies(m -> assertThat(m).containsEntry("installedVersion", "16.42")
                .containsEntry("component", "postgres").containsEntry("source", "postgres").containsEntry("label", "PostgreSQL")
                .containsEntry("status", "affected").containsEntry("reason", null).containsEntry("otherFamily", false));
        assertThat(tableRows.get(1)).as("다른 계열(15.x) 행 — 판정에 쓰지 않음").containsEntry("status", "unrelated");
        assertThat((List<Map<String, Object>>) tableRows.get(1).get("aliases")).singleElement()
                .satisfies(a -> assertThat(a).containsEntry("aliasId", "postgresql"));
        assertThat((List<?>) out.get("generalMatches")).isEmpty();
    }

    @Test
    @DisplayName("QA-1001 한 건 — 별칭 표에 없는 설치 패키지와 이름이 같은 행은 확인 필요(NAME_MATCH)이고, 근거·제품의 이름은 구성 요소 이름")
    @SuppressWarnings("unchecked")
    void detailUnlistedComponent() {
        notices.add(notice(9101, "가짜 압축 도구 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9101, 0, "CVE-2099-9101", "Fake Zip Utils", "95.0 이상 95.6 미만", "95.6"));
        fakeInventory(store, COLLECTED);
        when(store.components()).thenReturn(List.of(new SecurityStore.Component("host", "dpkg", "fake-zip-utils", "95.5-1fake1", "fake-zip-utils")));

        Map<String, Object> listed = items(service.notices(null, null, null, null, null)).get(0);
        assertThat(listed.get("verdict")).isEqualTo("check");
        assertThat((List<Map<String, Object>>) listed.get("products")).singleElement().satisfies(p -> {
            assertThat(p.get("aliasId")).isEqualTo("component:dpkg:fake-zip-utils");
            assertThat(p.get("label")).isEqualTo("fake-zip-utils");
        });

        Map<String, Object> out = service.notice(9101);
        Map<String, Object> row = ((List<Map<String, Object>>) out.get("rows")).get(0);
        assertThat(row.get("status")).isEqualTo("check");
        assertThat((List<String>) row.get("reasons")).containsExactly("NAME_MATCH");
        assertThat((List<Map<String, Object>>) row.get("matches")).singleElement().satisfies(m -> {
            assertThat(m.get("aliasId")).isEqualTo("component:dpkg:fake-zip-utils");
            assertThat(m.get("label")).isEqualTo("fake-zip-utils");
            assertThat(m.get("component")).isEqualTo("fake-zip-utils");
            assertThat(m.get("installedVersion")).isEqualTo("95.5-1fake1");
        });
    }

    @Test
    @DisplayName("한 건 — 버전 목록이 없으면 행은 제품 판정(확인 필요 NO_INVENTORY)을 따르고 근거는 generalMatches에")
    @SuppressWarnings("unchecked")
    void detailWithoutInventory() {
        fiveNotices();
        when(store.inventoryReady()).thenReturn(false);

        Map<String, Object> out = service.notice(9001);

        assertThat(out.get("inventory")).isNull();
        List<Map<String, Object>> tableRows = (List<Map<String, Object>>) out.get("rows");
        assertThat(tableRows).allSatisfy(r -> assertThat(r).containsEntry("status", "check").containsEntry("reasons", List.of("NO_INVENTORY")));
        assertThat((List<Map<String, Object>>) out.get("generalMatches")).singleElement()
                .satisfies(m -> assertThat(m).containsEntry("reason", "NO_INVENTORY").containsEntry("installedVersion", null));
    }

    @Test
    @DisplayName("한 건 — 배포판 패키지가 변경 기록 근거로 패치됨이면 근거 줄에 basis CHANGELOG(ADR 0046 덧붙임 2026-11-21)")
    @SuppressWarnings("unchecked")
    void detailChangelogBasis() {
        fakeInventory(store, Instant.parse("2026-11-21T07:20:00Z"));
        when(store.components()).thenReturn(List.of(
                new SecurityStore.Component("host", "runtime", "kernel", "9.9.0-3-fake", null),
                new SecurityStore.Component("host", "dpkg", "linux-generic", "9.9.0.3.3", "linux-meta")));
        when(store.changelogCves()).thenReturn(List.of(new SecurityStore.ChangelogCve("kernel", "9.9.0-3-fake", "CVE-2099-7777")));
        notices.add(notice(9101, "가짜 Linux 제품 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9101, 0, "CVE-2099-7777", "Linux Kernel", "9.0 이상 9.9.5 미만", "9.9.5"));

        Map<String, Object> out = service.notice(9101);

        assertThat((Map<String, Object>) out.get("notice")).containsEntry("verdict", "patched");
        assertThat((List<Map<String, Object>>) out.get("generalMatches")).singleElement()
                .satisfies(m -> assertThat(m).containsEntry("component", "kernel").containsEntry("status", "patched")
                        .containsEntry("basis", "CHANGELOG").containsEntry("reason", null));
    }

    /** 호스트 Ubuntu(가짜 코드명)·collector Debian 구역에 배포판 패키지 — 추적기 시험용(판은 모두 가짜). */
    private void trackerInventory() {
        List<SecurityStore.Section> sections = new ArrayList<>();
        for (String name : List.of("caddy", "postgres", "backend", "frontend", "browser")) {
            sections.add(new SecurityStore.Section(name, "ok", 1, null));
        }
        sections.add(new SecurityStore.Section("host", "ok", 3, null, new SecurityStore.Os("ubuntu", "99.04", "fakenoble")));
        sections.add(new SecurityStore.Section("collector", "ok", 1, null, new SecurityStore.Os("debian", "99", "fakeforky")));
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.of(new SecurityStore.Inventory(COLLECTED, COLLECTED.plusSeconds(5), true, null,
                sections)));
        when(store.components()).thenReturn(List.of(
                new SecurityStore.Component("host", "dpkg", "libssl9t64", "9.9.9-0fake1.2", "openssl"),
                new SecurityStore.Component("host", "dpkg", "curl", "9.1.0-1fake1", "curl"),
                new SecurityStore.Component("collector", "dpkg", "libbrotli1", "9.1.0-2fake1", "brotli")));
        when(store.pending()).thenReturn(List.of(new SecurityStore.Pending("curl", "amd64", "9.1.0-1fake1", "9.1.0-1fake2",
                "fakenoble-security", true)));
        when(store.changelogCves()).thenReturn(List.of(new SecurityStore.ChangelogCve("openssl", "9.9.9-0fake1.2", "CVE-2099-5001")));
        when(store.trackerStatuses()).thenReturn(List.of(
                new SecurityStore.TrackerStatus("ubuntu", "fakenoble", "openssl", "CVE-2099-5002", "fixed", "9.9.9-0fake1.3", "released",
                        Instant.parse("2026-11-21T06:00:00Z")),
                new SecurityStore.TrackerStatus("debian", "fakeforky", "brotli", "CVE-2099-6001", "open", null, "(unfixed)",
                        Instant.parse("2026-11-21T06:01:00Z"))));
        // 9101: OpenSSL — 5001은 변경 기록, 5002는 추적기에서 고친 판이 설치 판보다 높음(해당), 5003은 아직 묻지 않음.
        notices.add(notice(9101, "가짜 OpenSSL 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9101, 0, "CVE-2099-5001, CVE-2099-5002, CVE-2099-5003", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
        // 9102: curl — 보안 보류로 해당(추적기에 묻지 않음).
        notices.add(notice(9102, "가짜 curl 보안 업데이트 권고", "2026-11-19", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9102, 0, "CVE-2099-5101", "curl", "9.0 이상 9.2 미만", "9.2"));
        // 9103: Brotli — 추적기에 열림(확인 필요 DISTRO_OPEN).
        notices.add(notice(9103, "가짜 Brotli 보안 업데이트 권고", "2026-11-18", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9103, 0, "CVE-2099-6001", "Brotli", "9.1.1 미만", "9.1.1"));
        // 9104: 상세 실패 공지에 남은 행(물어볼 것에 넣지 않음).
        notices.add(notice(9104, "가짜 OpenSSL 보안 업데이트 권고 2", "2026-11-17", "failed", "product_table", List.of(), null));
        rows.add(row(9104, 0, "CVE-2099-5901", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
    }

    @Test
    @DisplayName("한 건 — 배포판 추적기 근거(tracker: distro·suite·package·CVE마다 상태·고친 판·확인 시각, 묻지 않은 것은 none), 근거 TRACKER")
    @SuppressWarnings("unchecked")
    void detailTracker() {
        trackerInventory();

        Map<String, Object> out = service.notice(9101);

        assertThat((Map<String, Object>) out.get("notice")).containsEntry("verdict", "affected").containsEntry("reasons", List.of());
        Map<String, Object> match = ((List<Map<String, Object>>) out.get("generalMatches")).stream()
                .filter(m -> "libssl9t64".equals(m.get("component"))).findFirst().orElseThrow();
        assertThat(match).containsEntry("status", "affected").containsEntry("basis", "TRACKER").containsEntry("reason", null);
        Map<String, Object> tracker = (Map<String, Object>) match.get("tracker");
        assertThat(tracker).containsEntry("distro", "ubuntu").containsEntry("suite", "fakenoble").containsEntry("package", "openssl");
        List<Map<String, Object>> cves = (List<Map<String, Object>>) tracker.get("cves");
        assertThat(cves).extracting(c -> c.get("cve")).as("변경 기록에 있는 5001은 넣지 않음").containsExactly("CVE-2099-5002", "CVE-2099-5003");
        assertThat(cves.get(0)).containsEntry("status", "fixed").containsEntry("fixedVersion", "9.9.9-0fake1.3")
                .containsEntry("checkedAt", "2026-11-21T06:00:00Z");
        assertThat(cves.get(1)).containsEntry("status", "none").containsEntry("fixedVersion", null).containsEntry("checkedAt", null);

        Map<String, Object> curl = service.notice(9102);
        assertThat(((List<Map<String, Object>>) curl.get("generalMatches"))).singleElement()
                .satisfies(m -> assertThat(m).containsEntry("status", "affected").containsEntry("tracker", null).containsEntry("basis", null));
    }

    @Test
    @DisplayName("배포판 패키지의 표 행 판정 — 행의 CVE마다(변경 기록 = 패치됨, 추적기 뒤처짐 = 해당, 묻지 않음 = 확인 필요, 열림 = DISTRO_OPEN), 제품 판정을 모든 행에 붙이지 않음")
    @SuppressWarnings("unchecked")
    void distroRowsPerCve() {
        trackerInventory();
        notices.add(notice(9105, "가짜 OpenSSL 보안 업데이트 권고 3", "2026-11-16", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(row(9105, 0, "CVE-2099-5001", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
        rows.add(row(9105, 1, "CVE-2099-5002", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
        rows.add(row(9105, 2, "CVE-2099-5003", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));

        List<Map<String, Object>> out = (List<Map<String, Object>>) service.notice(9105).get("rows");

        assertThat(out).extracting(r -> r.get("status")).containsExactly("patched", "affected", "check");
        assertThat(out.get(2)).containsEntry("reasons", List.of("DISTRO_NO_PENDING"));
        List<Map<String, Object>> merged = (List<Map<String, Object>>) service.notice(9101).get("rows");
        assertThat(merged).singleElement().satisfies(r -> assertThat(r).as("한 칸에 CVE 여럿이면 가장 높은 판정").containsEntry("status", "affected"));
        List<Map<String, Object>> open = (List<Map<String, Object>>) service.notice(9103).get("rows");
        assertThat(open).singleElement().satisfies(r -> assertThat(r).containsEntry("status", "check").containsEntry("reasons", List.of("DISTRO_OPEN")));
    }

    @Test
    @DisplayName("사유 DISTRO_OPEN — 사유별 건수와 거르기 인자에 들어감")
    void distroOpenReason() {
        trackerInventory();

        Map<String, Object> check = service.notices("check", null, null, null, null);
        assertThat(map(check.get("reasonCounts"))).containsEntry("DISTRO_OPEN", 1L);
        Map<String, Object> open = service.notices(null, "DISTRO_OPEN", null, null, null);
        assertThat(items(open)).extracting(i -> i.get("nttId")).containsExactly(9103L);
        assertThat(items(open).get(0)).containsEntry("verdict", "check").containsEntry("reasons", List.of("DISTRO_OPEN"));
    }

    @Test
    @DisplayName("물어볼 것 — 상세 ok 공지의 추적기 근거 CVE 전부(변경 기록으로 덮인 것·보안 보류로 해당인 구성 요소·상세 실패 공지 빼고)")
    void trackerWants() {
        trackerInventory();
        List<SecurityService.Judged> judged = service.judgeAll(service.loadInventory().orElseThrow());

        Set<SecurityTrackerStore.Want> wants = SecurityService.trackerWants(judged);

        assertThat(wants).containsExactlyInAnyOrder(
                new SecurityTrackerStore.Want("ubuntu", "fakenoble", "openssl", "CVE-2099-5002"),
                new SecurityTrackerStore.Want("ubuntu", "fakenoble", "openssl", "CVE-2099-5003"),
                new SecurityTrackerStore.Want("debian", "fakeforky", "brotli", "CVE-2099-6001"));
        assertThat(SecurityService.trackerWants(List.of())).isEmpty();
    }

    @Test
    @DisplayName("없는 번호·표가 없으면 404, 표가 없으면 목록은 available:false")
    void notFound() {
        fiveNotices();
        assertThatThrownBy(() -> service.notice(1234)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(404));

        when(store.ready()).thenReturn(false);
        assertThatThrownBy(() -> service.notice(9001)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        Map<String, Object> out = service.notices(null, null, null, null, null);
        assertThat(out).containsEntry("available", false).containsEntry("counts", null).containsEntry("total", 0);
        assertThat(items(out)).isEmpty();
    }

    @Test
    @DisplayName("버전 목록 — 구역(정해진 순서)·건수·구성 요소·apt 보류, 받은 적이 없으면 present:false")
    @SuppressWarnings("unchecked")
    void inventory() {
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.empty());
        Map<String, Object> empty = service.inventory();
        assertThat(empty).containsEntry("available", true).containsEntry("present", false).containsEntry("collectedAt", null)
                .containsEntry("counts", null).containsEntry("components", List.of());

        fakeInventory(store, COLLECTED);
        Map<String, Object> out = service.inventory();
        assertThat(out).containsEntry("present", true).containsEntry("collectedAt", "2026-11-20T22:20:00Z")
                .containsEntry("receivedAt", "2026-11-20T22:20:05Z").containsEntry("stale", false);
        assertThat((List<Map<String, Object>>) out.get("sections")).extracting(s -> s.get("name"))
                .containsExactly("host", "postgres", "backend", "frontend", "collector", "browser", "caddy");
        assertThat(map(out.get("counts"))).containsEntry("components", 2).containsEntry("pending", 2).containsEntry("pendingSecurity", 1L);
        assertThat((List<Map<String, Object>>) out.get("components")).first()
                .satisfies(c -> assertThat(c).containsEntry("name", "node").containsEntry("version", "22.20.0").containsEntry("sourcePackage", null));
        assertThat((List<Map<String, Object>>) out.get("pending")).first()
                .satisfies(p -> assertThat(p).containsEntry("package", "fake-lib").containsEntry("security", true));
    }

    @Test
    @DisplayName("알림용 — 해당 제품 이름과 실제로 해당인 행의 CVE 수(다른 계열 행은 세지 않음, 번호가 없으면 null)")
    void affectedHelpers() {
        fiveNotices();
        fakeInventory(store, COLLECTED);
        List<SecurityService.Judged> judged = service.judgeAll(service.loadInventory().orElseThrow());

        SecurityService.Judged pg = judged.get(0);
        assertThat(SecurityService.affectedLabels(pg.verdict())).containsExactly("PostgreSQL");
        // 0행(16.x — 해당) CVE 하나만 — 1행(15.x)은 다른 계열이라 세지 않음(QA 스택 확인에서 '2건'으로 부풀던 것).
        assertThat(service.affectedCveCount(pg)).isEqualTo(1);
        assertThat(SecurityService.cveCount(List.of(row(1, 0, "", "x", "", ""), row(1, 1, "번호 없음", "x", "", "")))).isNull();
    }
}
