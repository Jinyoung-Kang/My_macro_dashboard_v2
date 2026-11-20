/**
 * 보안 공지 화면 모델(lib/security — ADR 0046). 값은 모두 가짜입니다(실제 서버 버전·실제 공지가 아님).
 * - 판정 넷의 글·톤, 모르는 판정은 안전한 쪽이 아니라 '확인 필요'
 * - 사유 코드 여덟의 한국어 글·설명, 모르는 코드는 코드 그대로
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
  reasonLabel,
  reasonsText,
  safeExternalUrl,
  securityInboxHref,
  securityKpis,
  verdictFilterItems,
  verdictView,
} from "../security";
import type { SecurityCollection, SecurityNoticesResponse } from "../types";

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
  it("여덟 코드 모두 한국어 글과 설명이 있고, 모르는 코드는 코드 그대로(설명 없음)", () => {
    expect(REASON_ORDER).toEqual([
      "PARSE_FAILED", "OUT_OF_TABLE", "DISTRO_NO_PENDING", "NO_INVENTORY", "CONDITION_NOTE", "NO_VERSION_TABLE", "NAME_MATCH", "VENDOR_DIFFERS",
    ]);
    for (const code of REASON_ORDER) {
      expect(reasonLabel(code)).not.toBe(code);
      expect(reasonLabel(code)).not.toMatch(/[A-Z_]{4,}/);
      expect(reasonDescription(code)).toBeTruthy();
    }
    expect(reasonLabel("NO_INVENTORY")).toBe("버전 목록 없음");
    expect(reasonLabel("CONDITION_NOTE")).toBe("조건 문장 있음");
    expect(reasonLabel("VENDOR_DIFFERS")).toBe("제조사 다름");
    expect(reasonLabel("NEW_CODE")).toBe("NEW_CODE");
    expect(reasonDescription("NEW_CODE")).toBeNull();
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
  it("판정 줄은 전체 + 넷(건수는 counts), 사유 줄은 전체 + 여덟(건수는 reasonCounts — 없으면 보조 글 없음)", () => {
    expect(verdictFilterItems(response().counts).map((item) => `${item.key}:${item.label}:${item.note}`)).toEqual([
      "all:전체:12건", "affected:해당:1건", "check:확인 필요:4건", "patched:패치됨:0건", "unrelated:무관:7건",
    ]);
    expect(verdictFilterItems(null).every((item) => item.note === null)).toBe(true);
    const reasons = reasonFilterItems(response().reasonCounts);
    expect(reasons).toHaveLength(9);
    expect(reasons.find((item) => item.key === "CONDITION_NOTE")).toEqual({ key: "CONDITION_NOTE", label: "조건 문장 있음", note: "2건" });
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
  it("ntt 인자는 숫자만(앞 0은 뗌), 그 밖은 null", () => {
    expect(parseNttParam("900001")).toBe("900001");
    expect(parseNttParam(" 0900001 ")).toBe("900001");
    for (const bad of ["", "0", "abc", "12a", "-1", "1234567890123", null, undefined]) expect(parseNttParam(bad)).toBeNull();
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
