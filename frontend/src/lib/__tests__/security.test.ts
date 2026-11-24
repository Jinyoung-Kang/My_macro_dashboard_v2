/**
 * 보안 공지 화면 모델(lib/security — ADR 0046). 값은 모두 가짜입니다(실제 서버 버전·실제 공지가 아님).
 * - 판정 넷의 글·톤, 모르는 판정은 안전한 쪽이 아니라 '확인 필요'
 * - 사유 코드 아홉(DISTRO_OPEN 포함)의 한국어 글·설명, 모르는 코드는 코드 그대로
 * - 추적기(Ubuntu·Debian·Alpine) 이름·상태 글·CVE 링크, 이 환경 판정 줄(같은 제품·구역·판정 묶음)과 사유·근거 한 줄, 패치됨·무관 줄 수, ※ 조건 문장 요약,
 *   공지 표 '이 스택 행만' 범위
 * - KPI 띠(해당·확인 필요·패치됨·버전 목록 기준 시각), 버전 목록 없음·오래됨
 * - 수집 상태 한 줄, 거르기 줄·인자, 알림함 링크(?ntt=) 해석
 */
import { describe, expect, it } from "vitest";
import {
  ALL,
  NO_INVENTORY_NOTE,
  REASON_ORDER,
  SECURITY_LIMIT_NOTE,
  collectionLine,
  filterComponents,
  filterParam,
  inventoryState,
  matchInstalledText,
  notOkSectionsText,
  parseNttParam,
  reasonDescription,
  reasonFilterItems,
  basisLabel,
  conditionSummary,
  distroLabel,
  environmentLines,
  evidenceReasonText,
  listText,
  reasonLabel,
  rowScopeItems,
  settledCountText,
  stackRows,
  trackerName,
  trackerStatusView,
  trackerUrl,
  reasonsText,
  safeExternalUrl,
  securityInboxHref,
  securityKpis,
  verdictFilterItems,
  verdictView,
} from "../security";
import { parseSecurityNoticeNo, securityNoticeHref } from "../detail";
import type { SecurityCollection, SecurityMatch, SecurityNoticeRow, SecurityNoticesResponse } from "../types";

const COLLECTION: SecurityCollection = {
  task: "kisa_security_notices",
  recorded: true,
  status: "ok",
  streak: 3,
  reason: null,
  lastOkAt: "2026-11-21T00:00:00Z",
  lastRunAt: "2026-11-21T00:00:00Z",
  staleAfterMinutes: 720,
  notices: 12,
  details: { pending: 2, ok: 9, failed: 1, skipped: 0 },
  oldestPostedOn: "2026-08-23",
  newestPostedOn: "2026-11-20",
};

function response(over: Partial<SecurityNoticesResponse> = {}): SecurityNoticesResponse {
  return {
    available: true,
    checkedAt: "2026-11-21T01:00:00Z",
    inventory: {
      collectedAt: "2026-11-20T15:00:00Z",
      receivedAt: "2026-11-20T15:00:05Z",
      ageSeconds: 36_000,
      stale: false,
      hostIncluded: true,
      aptListsAt: "2026-11-20T12:00:00Z",
      notOkSections: [],
    },
    collection: COLLECTION,
    counts: { affected: 1, check: 4, patched: 0, unrelated: 7, total: 12 },
    reasonCounts: { NO_INVENTORY: 0, CONDITION_NOTE: 2 },
    items: [],
    page: 1,
    size: 20,
    total: 12,
    pages: 1,
    ...over,
  };
}

describe("판정", () => {
  it("넷의 글·톤 — 해당 위험·확인 필요 주의·패치됨 정상·무관 중립", () => {
    expect(["affected", "check", "patched", "unrelated"].map((code) => [verdictView(code).label, verdictView(code).tone])).toEqual([
      ["해당", "danger"],
      ["확인 필요", "warn"],
      ["패치됨", "ok"],
      ["무관", "neutral"],
    ]);
  });

  it("모르는 판정·빈 값은 안전한 쪽(패치됨·무관)이 아니라 '확인 필요'", () => {
    for (const code of ["safe", "", null, undefined]) {
      expect(verdictView(code).label).toBe("확인 필요");
      expect(verdictView(code).tone).toBe("warn");
    }
  });
});

describe("사유", () => {
  it("아홉 코드 모두 한국어 글과 설명이 있고, 모르는 코드는 코드 그대로(설명 없음)", () => {
    expect(REASON_ORDER).toEqual([
      "PARSE_FAILED", "OUT_OF_TABLE", "DISTRO_NO_PENDING", "DISTRO_OPEN", "NO_INVENTORY", "CONDITION_NOTE", "NO_VERSION_TABLE", "NAME_MATCH",
      "VENDOR_DIFFERS",
    ]);
    for (const code of REASON_ORDER) {
      expect(reasonLabel(code)).not.toBe(code);
      expect(reasonLabel(code)).not.toMatch(/[A-Z_]{4,}/);
      expect(reasonDescription(code)).toBeTruthy();
    }
    expect(reasonLabel("NO_INVENTORY")).toBe("버전 목록 없음");
    expect(reasonLabel("CONDITION_NOTE")).toBe("조건 문장 있음");
    expect(reasonLabel("VENDOR_DIFFERS")).toBe("제조사 다름");
    expect(reasonLabel("DISTRO_OPEN")).toBe("배포판 미수정");
    expect(reasonDescription("DISTRO_OPEN")).toMatch(/^배포판 보안 추적기에 아직 고치지 않음으로 적혀 있습니다/);
    expect(reasonLabel("NEW_CODE")).toBe("NEW_CODE");
    expect(reasonDescription("NEW_CODE")).toBeNull();
  });

  it("판정 근거 종류 — 변경 기록·추적기는 한국어 글, 없으면 null, 모르는 코드는 코드 그대로", () => {
    expect(basisLabel("CHANGELOG")).toBe("변경 기록에 CVE 있음");
    expect(basisLabel("TRACKER")).toBe("추적기에서 고침 확인");
    expect(basisLabel("constructor")).toBe("constructor");
    expect(basisLabel(null)).toBeNull();
    expect(basisLabel(undefined)).toBeNull();
    expect(basisLabel("NEW_BASIS")).toBe("NEW_BASIS");
  });

  it("사유 목록 한 줄 — 없으면 null", () => {
    expect(reasonsText(["NO_INVENTORY", "CONDITION_NOTE"])).toBe("버전 목록 없음 · 조건 문장 있음");
    expect(reasonsText([])).toBeNull();
    expect(reasonsText(null)).toBeNull();
  });
});

describe("KPI 띠", () => {
  it("해당·확인 필요·패치됨 건수와 버전 목록 기준 시각(KST)·경과", () => {
    const items = securityKpis(response());
    expect(items.map((item) => [item.label, item.value])).toEqual([
      ["해당", 1],
      ["확인 필요", 4],
      ["패치됨", 0],
      ["버전 목록 기준", "2026-11-21 00:00"],
    ]);
    expect(items[3].note).toBe("10시간 전");
    expect(items[3].status).toBeUndefined();
    expect(items.every((item) => !item.pending)).toBe(true);
  });

  it("2일 넘게 오래된 버전 목록은 주의 상태 글", () => {
    const stale = response({ inventory: { ...response().inventory!, ageSeconds: 3 * 86_400, stale: true } });
    expect(securityKpis(stale)[3].status).toEqual({ tone: "warn", text: "2일 넘게 오래됨" });
  });

  it("버전 목록이 없으면 기준 시각은 '—'와 까닭(지어내지 않음), 표가 없으면 건수도 '—'", () => {
    const missing = securityKpis(response({ inventory: null }));
    expect(missing[3].value).toBeNull();
    expect(missing[3].emptyReason).toBe("버전 목록 없음");
    const noTable = securityKpis(response({ available: false, counts: null, inventory: null }));
    expect(noTable.slice(0, 3).map((item) => [item.value, item.emptyReason])).toEqual([
      [null, "표 없음"],
      [null, "표 없음"],
      [null, "표 없음"],
    ]);
  });

  it("읽는 중이면 모든 타일이 자리표시", () => {
    expect(securityKpis(null, true).every((item) => item.pending)).toBe(true);
  });
});

describe("버전 목록 안내", () => {
  it("없으면 '버전 목록 없음 — inventory.sh' 안내, 있으면 기준 시각·오래됨·모으지 못한 구역", () => {
    expect(inventoryState(null)).toEqual({ kind: "missing", text: NO_INVENTORY_NOTE });
    expect(NO_INVENTORY_NOTE).toBe("버전 목록 없음 — 서버에서 inventory.sh가 돈 뒤에 생깁니다.");
    const state = inventoryState({ ...response().inventory!, stale: true, notOkSections: ["browser", "host"] });
    expect(state).toMatchObject({ kind: "present", collectedAt: "2026-11-21 00:00", stale: true, notOkSections: ["browser", "host"] });
    expect(notOkSectionsText(["browser", "host"])).toBe("모으지 못한 구역: browser · 서버 호스트 — 그 구역의 제품은 확인 필요(버전 목록 없음)로 둡니다.");
    expect(notOkSectionsText([])).toBeNull();
  });

  it("한계 한 줄은 '일부만 다룬다·해당이 없어도 안전하다는 뜻이 아니다'", () => {
    expect(SECURITY_LIMIT_NOTE).toMatch(/보호나라는 이 스택의 일부만 다룹니다/);
    expect(SECURITY_LIMIT_NOTE).toMatch(/해당이 없어도 .*안전하다는 뜻은 아닙니다/);
  });
});

describe("수집 상태 한 줄", () => {
  it("정상 — 마지막 성공·받아 둔 공지·상세 받기 상태", () => {
    expect(collectionLine(COLLECTION, "2026-11-21T01:00:00Z")).toEqual({
      tone: "ok",
      text: "수집 정상 · 마지막 성공 2026-11-21 09:00 · 받아 둔 공지 12건(게시 2026-08-23 ~ 2026-11-20) · 상세 받음 9 · 대기 2 · 실패 1",
    });
  });

  it("실패가 이어지면 판정 글·연속 횟수·사유와 주의", () => {
    const failed = collectionLine({ ...COLLECTION, status: "failed", streak: 4, reason: "HTTP 503" }, null);
    expect(failed?.tone).toBe("warn");
    expect(failed?.text).toMatch(/^수집 받지 못함 4회 연속 — HTTP 503 · 마지막 성공 2026-11-21 09:00 · /);
    expect(collectionLine({ ...COLLECTION, status: "format", streak: 1, reason: null, lastOkAt: null }, null)?.text).toMatch(/^수집 형식 바뀜 · 성공 기록 없음/);
  });

  it("정상이어도 마지막 실행이 한도보다 오래되면 주의", () => {
    const late = collectionLine({ ...COLLECTION, staleAfterMinutes: 30 }, "2026-11-21T02:00:00Z");
    expect(late?.tone).toBe("warn");
    expect(late?.text).toContain("마지막 실행이 2시간 전입니다(한도 30분)");
  });

  it("판정 기록이 없으면 '수집 기록 없음'(중립), 응답에 칸이 없으면 null", () => {
    expect(collectionLine({ ...COLLECTION, recorded: false, status: null, notices: 0 }, null)).toEqual({
      tone: "neutral",
      text: "수집 기록 없음 — 수집기가 아직 이 출처를 돌리지 않았습니다 · 받아 둔 공지 없음",
    });
    expect(collectionLine(null)).toBeNull();
  });
});

describe("거르기", () => {
  it("판정 줄은 전체 + 넷(건수는 counts), 사유 줄은 전체 + 아홉(건수는 reasonCounts — 없으면 보조 글 없음)", () => {
    expect(verdictFilterItems(response().counts).map((item) => `${item.key}:${item.label}:${item.note}`)).toEqual([
      "all:전체:12건", "affected:해당:1건", "check:확인 필요:4건", "patched:패치됨:0건", "unrelated:무관:7건",
    ]);
    expect(verdictFilterItems(null).every((item) => item.note === null)).toBe(true);
    const reasons = reasonFilterItems(response().reasonCounts);
    expect(reasons).toHaveLength(10);
    expect(reasons.find((item) => item.key === "DISTRO_OPEN")).toEqual({ key: "DISTRO_OPEN", label: "배포판 미수정", note: null, noteSlot: "000건" });
    expect(reasons.find((item) => item.key === "CONDITION_NOTE")).toEqual({ key: "CONDITION_NOTE", label: "조건 문장 있음", note: "2건", noteSlot: "000건" });
    // QA-995: 건수 자리는 응답 전에도 세 자리 건수 폭(칩 폭이 응답 전후 같아 줄바꿈이 바뀌지 않음) — 사유 '전체'는 건수가 없어 자리도 없음.
    expect(verdictFilterItems(null).every((item) => item.noteSlot === "000건")).toBe(true);
    expect(reasons[0].noteSlot).toBeUndefined();
    expect(reasons.find((item) => item.key === "VENDOR_DIFFERS")?.note).toBeNull();
  });

  it("전체는 인자를 뺀다", () => {
    expect(filterParam(ALL)).toBeUndefined();
    expect(filterParam("check")).toBe("check");
  });

  it("버전 목록 구성 요소는 구역·이름(원본 패키지·버전 포함, 대소문자 무시)으로 화면 안에서 거른다", () => {
    const rows = [
      { source: "host", name: "libfake1", version: "9.9.9-0fake1", sourcePackage: "fakelib" },
      { source: "backend", name: "fake-core", version: "99.1.0", sourcePackage: null },
    ];
    expect(filterComponents(rows, { section: ALL, query: "" })).toHaveLength(2);
    expect(filterComponents(rows, { section: "backend", query: "" }).map((row) => row.name)).toEqual(["fake-core"]);
    expect(filterComponents(rows, { section: ALL, query: "FAKELIB" }).map((row) => row.name)).toEqual(["libfake1"]);
    expect(filterComponents(rows, { section: "host", query: "99.1" })).toEqual([]);
  });
});

describe("알림함 링크와 ?ntt=", () => {
  it("ntt 인자는 숫자만(앞 0은 뗌), 그 밖은 null — 상세 주소 조각(lib/detail)과 같은 규칙", () => {
    expect(parseNttParam("900001")).toBe("900001");
    expect(parseNttParam(" 0900001 ")).toBe("900001");
    for (const bad of ["", "0", "abc", "12a", "-1", "1234567890123", "%E0", null, undefined]) {
      expect(parseNttParam(bad)).toBeNull();
      expect(parseSecurityNoticeNo(bad)).toBeNull();
    }
    expect(parseSecurityNoticeNo("0900001")).toBe("900001");
    expect(securityNoticeHref("900001")).toBe("/security/900001");
    expect(securityNoticeHref(900001)).toBe("/security/900001");
  });

  it("SECURITY_NOTICE 알림의 payload.href가 보안 공지 화면 주소일 때만 링크", () => {
    expect(securityInboxHref({ kind: "SECURITY_NOTICE", payload: { href: "/security?ntt=900001" } })).toBe("/security?ntt=900001");
    expect(securityInboxHref({ kind: "SECURITY_NOTICE", payload: { href: "/security" } })).toBe("/security");
    for (const href of ["https://evil.example/security?ntt=1", "/security/x", "/securityx", "/security?ntt=1&x=2", "/security?ntt=abc"]) {
      expect(securityInboxHref({ kind: "SECURITY_NOTICE", payload: { href } })).toBeNull();
    }
    expect(securityInboxHref({ kind: "SECURITY_NOTICE", payload: null })).toBeNull();
    expect(securityInboxHref({ kind: "SEARCH_WATCH", payload: { href: "/security?ntt=1" } })).toBeNull();
  });

  it("원문 링크는 http(s)만", () => {
    expect(safeExternalUrl("https://example.invalid/view?nttId=1")).toBe("https://example.invalid/view?nttId=1");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("/relative")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe("근거의 설치 버전 글", () => {
  it("'구성 요소 버전(구역)', 다른 계열이면 표시, 구성 요소가 없으면 null", () => {
    const base = {
      aliasId: "postgres", label: "PostgreSQL", rowIndex: 0, cve: "CVE-2099-0001", rowProduct: "PostgreSQL", source: "postgres",
      component: "postgresql", installedVersion: "90.2", status: "affected" as const, reason: null, otherFamily: false,
    };
    expect(matchInstalledText(base)).toBe("postgresql 90.2(postgres)");
    expect(matchInstalledText({ ...base, source: "host", otherFamily: true })).toBe("postgresql 90.2(서버 호스트) · 다른 계열");
    expect(matchInstalledText({ ...base, component: null })).toBeNull();
  });
});

describe("배포판 보안 추적기", () => {
  it("배포판 이름·추적기 이름 — 셋 밖은 글자 그대로", () => {
    expect(["ubuntu", "debian", "alpine", "arch"].map(distroLabel)).toEqual(["Ubuntu", "Debian", "Alpine", "arch"]);
    expect(trackerName({ distro: "ubuntu", suite: "fakesuite" })).toBe("Ubuntu fakesuite");
    expect(trackerName({ distro: "alpine", suite: "" })).toBe("Alpine");
  });

  it("CVE 링크 — Ubuntu·Debian·Alpine 주소, CVE 모양이 아니거나 배포판이 셋 밖이면 null", () => {
    expect(trackerUrl("ubuntu", "CVE-2099-90001")).toBe("https://ubuntu.com/security/CVE-2099-90001");
    expect(trackerUrl("debian", " cve-2099-90001 ")).toBe("https://security-tracker.debian.org/tracker/CVE-2099-90001");
    expect(trackerUrl("alpine", "CVE-2099-1234567")).toBe("https://security.alpinelinux.org/vuln/CVE-2099-1234567");
    const bad: [string | null, string | null][] = [
      ["arch", "CVE-2099-90001"],
      ["ubuntu", "CVE-2099-1"],
      ["debian", "javascript:alert(1)"],
      ["constructor", "CVE-2099-90001"],
      [null, "CVE-2099-90001"],
      ["ubuntu", null],
    ];
    for (const [distro, cve] of bad) expect(trackerUrl(distro, cve)).toBeNull();
  });

  it("CVE 상태 글·톤 — 모르는 코드는 글자 그대로 주의", () => {
    expect(["fixed", "not_affected", "open", "unknown", "none"].map((code) => [trackerStatusView(code).label, trackerStatusView(code).tone])).toEqual([
      ["고침", "ok"],
      ["영향 없음", "neutral"],
      ["아직 고치지 않음", "warn"],
      ["추적기가 모름", "neutral"],
      ["아직 묻지 않음", "neutral"],
    ]);
    expect(trackerStatusView("released")).toEqual({ label: "released", tone: "warn" });
    expect(trackerStatusView(null)).toEqual({ label: "—", tone: "warn" });
  });
});

/** 가짜 근거 한 줄. */
function match(over: Partial<SecurityMatch>): SecurityMatch {
  return {
    aliasId: "postgres", label: "PostgreSQL", rowIndex: null, cve: null, rowProduct: null, source: "postgres", component: "postgresql",
    installedVersion: "90.2", status: "check", reason: null, otherFamily: false, basis: null, ...over,
  };
}

/** 가짜 공지 표 행. */
function row(index: number, fixed: string, matches: SecurityMatch[], aliases = [{ aliasId: "postgres", label: "PostgreSQL" }]): SecurityNoticeRow {
  return { index, cve: `CVE-2099-9000${index}`, product: "PostgreSQL", affected: "가짜 구간", fixed, aliases, status: "check", reasons: [], matches };
}

describe("이 환경 판정 줄", () => {
  it("같은 제품·구역·판정끼리 묶고, 해당 → 확인 필요 차례로 '걸린 것', 패치됨·무관은 따로", () => {
    const view = environmentLines({
      rows: [
        row(0, "90.5", [match({ rowIndex: 0, status: "affected" })]),
        row(1, "90.6", [match({ rowIndex: 1, status: "affected" })]),
        row(2, "89.9", [match({ rowIndex: 2, status: "unrelated", otherFamily: true })]),
        row(3, "1.0", [], []),
      ],
      generalMatches: [
        match({ aliasId: "openssl", label: "OpenSSL", source: "host", component: "libfake3", installedVersion: "9.9.9-0fake1", reason: "DISTRO_NO_PENDING" }),
        match({ aliasId: "openssl", label: "OpenSSL", source: "host", component: "fakessl", installedVersion: "9.9.9-0fake1", reason: "DISTRO_NO_PENDING" }),
        match({ aliasId: "kernel", label: "Linux 커널", source: "host", component: "kernel", installedVersion: "0.0.1-fake", status: "patched", basis: "CHANGELOG" }),
        match({ aliasId: "node", label: null, source: "frontend", component: null, installedVersion: null, status: "weird" as never }),
      ],
    });
    expect(view.exposed.map((line) => [line.product, line.source, line.status, line.installed, line.fixed, line.count])).toEqual([
      ["PostgreSQL", "postgres", "affected", ["postgresql 90.2"], ["90.5", "90.6"], 2],
      ["OpenSSL", "host", "check", ["libfake3 9.9.9-0fake1", "fakessl 9.9.9-0fake1"], [], 2],
      ["node", "frontend", "check", [], [], 1],
    ]);
    expect(view.patched.map((line) => [line.product, line.bases])).toEqual([["Linux 커널", ["CHANGELOG"]]]);
    expect(view.unrelated.map((line) => [line.product, line.otherFamily, line.fixed])).toEqual([["PostgreSQL", true, ["89.9"]]]);
    expect(settledCountText(view)).toBe("패치됨 1개 · 무관 1개");
  });

  it("추적기 근거 — 고침 CVE의 고친 판이 해결 판, 해당이면 '고친 판이 나왔는데 설치 판이 낮음'", () => {
    const tracker = {
      distro: "ubuntu",
      suite: "fakesuite",
      cves: [
        { cve: "CVE-2099-90001", status: "fixed", fixedVersion: "9.9.9-0fake2", checkedAt: "2026-11-21T00:00:00Z" },
        { cve: "CVE-2099-90002", status: "open", fixedVersion: null, checkedAt: "2026-11-21T00:00:00Z" },
        { cve: "CVE-2099-90003", status: "fixed", fixedVersion: "9.9.9-0fake2", checkedAt: null },
      ],
    };
    const [line] = environmentLines({
      rows: [],
      generalMatches: [
        match({ aliasId: "openssl", label: "OpenSSL", source: "host", component: "libfake3", installedVersion: "9.9.9-0fake1", status: "affected", basis: "TRACKER", tracker }),
      ],
    }).exposed;
    expect(line.fixed).toEqual(["9.9.9-0fake2"]);
    expect(line.pendingUpdate).toBe(false);
    expect(evidenceReasonText(line)).toBe("추적기: 고친 판이 나왔는데 설치 판이 낮음");
  });

  it("사유·근거 한 줄 — 사유 글, 근거 종류, apt 보안 대기, 다른 계열, 없으면 판정 기본 글", () => {
    const one = (over: Partial<SecurityMatch>) => {
      const view = environmentLines({ rows: [], generalMatches: [match(over)] });
      return [...view.exposed, ...view.patched, ...view.unrelated][0];
    };
    expect(evidenceReasonText(one({ reason: "DISTRO_OPEN" }))).toBe("배포판 미수정");
    expect(evidenceReasonText(one({ status: "patched", basis: "TRACKER" }))).toBe("추적기에서 고침 확인");
    expect(evidenceReasonText(one({ status: "unrelated", basis: "TRACKER" }))).toBe("추적기: 영향 없음");
    expect(evidenceReasonText(one({ status: "affected" }))).toBe("apt 보안 업데이트 대기");
    const rowAffected = environmentLines({ rows: [row(0, "90.5", [match({ rowIndex: 0, status: "affected" })])], generalMatches: [] }).exposed[0];
    expect(evidenceReasonText(rowAffected)).toBe("설치 판이 영향 구간 안");
    const rowPatched = environmentLines({ rows: [row(0, "90.1", [match({ rowIndex: 0, status: "patched" })])], generalMatches: [] }).patched[0];
    expect(evidenceReasonText(rowPatched)).toBe("설치 판이 해결 판 이상");
    const other = environmentLines({ rows: [row(0, "89.9", [match({ rowIndex: 0, status: "unrelated", otherFamily: true })])], generalMatches: [] }).unrelated[0];
    expect(evidenceReasonText(other)).toBe("다른 계열 행");
  });

  it("근거가 없으면 세 묶음 모두 비고 줄 수 글은 null, 옛 응답(basis·tracker 칸 없음)도 같게 묶는다", () => {
    const empty = environmentLines({ rows: [row(0, "1.0", [], [])], generalMatches: [] });
    expect(empty).toEqual({ exposed: [], patched: [], unrelated: [] });
    expect(settledCountText(empty)).toBeNull();
    const { basis: _basis, tracker: _tracker, ...old } = match({ status: "check", reason: "DISTRO_NO_PENDING" });
    const [line] = environmentLines({ rows: [], generalMatches: [old] }).exposed;
    expect([line.fixed, line.bases, evidenceReasonText(line)]).toEqual([[], [], "배포판 패키지 — 보류 목록에 없음"]);
  });

  it("글 목록은 앞 둘만 — 넘치면 '외 N개'", () => {
    expect(listText([])).toBeNull();
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b", "c", "d"])).toBe("a / b 외 2개");
    expect(listText(["a", "b", "c"], 3)).toBe("a / b / c");
  });
});

describe("※ 조건 문장 요약과 공지 표 범위", () => {
  it("문장 수와 첫 문장 — 길면 말줄임표, 없으면 null", () => {
    expect(conditionSummary(["※ 가짜 조건 하나", "※ 가짜 조건 둘"])).toEqual({ count: 2, first: "※ 가짜 조건 하나" });
    expect(conditionSummary([" ", ""])).toBeNull();
    expect(conditionSummary(null)).toBeNull();
    expect(conditionSummary(["가".repeat(130)])?.first).toBe(`${"가".repeat(120)}…`);
  });

  it("이 스택 행 = 이 스택 제품이 붙은 행, 범위 줄의 보조 글은 행 수", () => {
    const rows = [row(0, "1", []), row(1, "1", [], []), row(2, "1", [])];
    expect(stackRows(rows).map((item) => item.index)).toEqual([0, 2]);
    expect(rowScopeItems(rows)).toEqual([
      { key: "stack", label: "이 스택 행만", note: "2행" },
      { key: "all", label: "전체", note: "3행" },
    ]);
  });
});
