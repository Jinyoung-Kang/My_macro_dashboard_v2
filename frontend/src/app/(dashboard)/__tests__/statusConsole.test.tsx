/**
 * 저장소 상태(/status) 운영 콘솔 배치(작업대 P7 — 실행 명세 §7 7행 '저장소 상태: 운영 콘솔(KPI 띠·표·로그 패널·목차)').
 *
 * - 머리: 읽기 모드 태그, 수집기에 닿지 못하면 주의 안내 상자(제목 '수집기에 닿지 못함').
 * - KPI 띠 '저장소 요약' 타일 넷, 모르는 값은 '—'(0으로 채우지 않음 — 이력 거래일도 목록을 모르면 적지 않음).
 * - 긴 화면 목차 '저장소 상태 목차' 일곱 칸(차례·개수)과 절 닻.
 * - 태스크 표: 공용 조밀 표(개수 줄), 표 안 '다시 실행'은 작은 단추(넓은 화면 24px), 상세 칸은 낱말 사이 줄바꿈·최소 18rem, 정상이 아닌 줄의 상세는 아이콘 + 글.
 * - 오류·경고 로그는 공용 로그 상자(이름 있는 영역, 고정폭).
 * - 키·누락은 공용 태그(누락은 주의 아이콘 + 글, 키 설정됨은 정상 아이콘 + 글).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import StatusPage from "../status/page";

let reads: Record<string, unknown> = {};
beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const STATUS = {
  readMode: "store_only",
  collectorReachable: true,
  lastRunStatus: "partial",
  lastRun: { startedAt: "2026-11-18T00:00:00Z", groupName: "fast", okCount: 30, failCount: 2, detail: "macro_collected: 시간 초과" },
  timeseriesRows: 1234567,
  observationRows: 8910,
  radarHistoryDates: ["2026-11-17", "2026-11-18"],
  taskSummary: [
    { task: "macro_collected", speed: "fast", status: "ok", startedAt: "2026-11-18T00:00:00Z", durationMs: 1200, detail: "12건 저장" },
    { task: "kr_fundamentals", speed: "slow", status: "error", startedAt: "2026-11-18T00:00:00Z", durationMs: null, detail: "HTTP 500 응답" },
  ],
  snapshots: [{ name: "macro", status: "ok", error: null, ageSeconds: 60, stale: false, collectedAt: "2026-11-18T00:00:00Z" }],
  missingDatasets: [{ name: "kr_flows", label: "국내 수급" }],
  keys: { fred: true, dart: false },
};
const ISSUES = {
  generatedAt: "2026-11-18 09:00 KST", collectorReachable: true, lookbackHours: 24, lastRunStatus: "partial",
  counts: { errors: 1, warnings: 0, recentGroups: 1, missingDatasets: 1 }, current: [], recent: [], missing: ["kr_flows"],
  text: "요약: 합성 기록\nkr_fundamentals — HTTP 500 응답",
};

async function rendered() {
  reads = { [endpoints.status.overview]: STATUS, [endpoints.status.issues]: ISSUES };
  render(<StatusPage />);
  await screen.findByRole("heading", { name: "데이터 저장소 상태" });
}

describe("저장소 상태 — 운영 콘솔", () => {
  it("머리에 읽기 모드 태그, KPI 띠 '저장소 요약' 타일 넷(행 수는 쉼표·단위, 이력 거래일)", async () => {
    await rendered();
    expect(screen.getByText("읽기 모드 store_only")).toBeTruthy();
    const strip = screen.getByRole("region", { name: "저장소 요약" });
    const tiles = within(strip).getAllByRole("group").map((tile) => tile.getAttribute("aria-label"));
    expect(tiles).toEqual(["최근 수집 상태", "성공 / 실패", "누적 시계열", "누적 수급 레코드"]);
    expect(within(strip).getByRole("group", { name: "최근 수집 상태" }).textContent).toContain("일부 실패");
    expect(within(strip).getByRole("group", { name: "성공 / 실패" }).textContent).toContain("30 / 2");
    expect(within(strip).getByRole("group", { name: "누적 시계열" }).textContent).toBe("누적 시계열1,234,567행");
    expect(within(strip).getByRole("group", { name: "누적 수급 레코드" }).textContent).toBe("누적 수급 레코드8,910행이력 거래일 2일");
  });

  it("모르는 값은 '—' — 행 수·성공/실패를 0으로 채우지 않고, 이력 날짜 목록이 없으면 '이력 거래일 0일'을 적지 않는다", async () => {
    reads = { [endpoints.status.overview]: { readMode: "auto", collectorReachable: false, taskSummary: [] }, [endpoints.status.issues]: ISSUES };
    render(<StatusPage />);
    expect(await screen.findByText("수집기에 닿지 못함")).toBeTruthy();
    const strip = screen.getByRole("region", { name: "저장소 요약" });
    for (const name of ["성공 / 실패", "누적 시계열", "누적 수급 레코드"]) {
      expect(within(strip).getByRole("group", { name }).textContent, name).toBe(`${name}—값 없음`);
    }
  });

  it("목차 일곱 칸(차례·개수)과 같은 id의 절 닻", async () => {
    await rendered();
    const nav = screen.getByRole("navigation", { name: "저장소 상태 목차" });
    // 넓은 화면 세로 목록과 좁은 화면 가로 줄이 같은 칸을 두 번 그립니다(폭마다 하나만 보임) — 첫 목록만 봅니다.
    const list = nav.querySelectorAll("ul")[0];
    const links = Array.from(list.querySelectorAll("a")).map((link) => [link.getAttribute("href"), link.textContent]);
    expect(links).toEqual([
      ["#status-issues", "오류·경고 로그"],
      ["#status-tasks", "태스크 (2)2"],
      ["#status-snapshots", "스냅샷 (1)1"],
      ["#status-missing", "누락 (1)1"],
      ["#status-keys", "API 키"],
      ["#status-verification", "교차 검증"],
      ["#status-public-apis", "공공 API"],
    ]);
    for (const [href] of links) expect(document.getElementById((href as string).slice(1)), href as string).not.toBeNull();
  });

  it("태스크 표 — 조밀 표·개수 줄, 표 안 작은 단추, 상세 칸 줄바꿈 규칙, 정상이 아닌 상세는 아이콘 + 글", async () => {
    await rendered();
    const table = screen.getByRole("region", { name: "태스크별 최근 결과 (좌우 스크롤)" });
    const panel = table.closest("section") as HTMLElement;
    expect(within(panel).getByText("2건")).toBeTruthy();
    const buttons = within(table).getAllByRole("button", { name: "다시 실행" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.className).toContain("lg:min-h-6");
    const ok = within(table).getByText("12건 저장");
    expect(ok.closest("td")?.className).toContain("min-w-[18rem]");
    expect(ok.closest("td")?.className).toContain("break-keep");
    expect(ok.querySelector("svg")).toBeNull();
    const failed = within(table).getByText("HTTP 500 응답");
    expect(failed.closest(".text-danger")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // 고정폭 태스크 키와 속도 태그.
    expect(within(table).getByText("macro_collected").className).toContain("font-mono");
    expect(within(table).getByText("slow").className).toContain("rounded-control");
  });

  it("오류·경고 로그는 공용 로그 상자(이름 있는 영역, 고정폭, Tab 정지점)", async () => {
    await rendered();
    const log = await screen.findByRole("region", { name: "수집 오류·경고 로그 (스크롤)" });
    expect(log.tagName).toBe("PRE");
    expect(log.getAttribute("tabindex")).toBe("0");
    expect(log.className).toContain("font-mono");
    expect(log.textContent).toBe(ISSUES.text);
  });

  it("누락 데이터셋은 주의 태그(아이콘 + '주의:'), 키는 설정됨 정상 태그·없음 중립 태그", async () => {
    await rendered();
    const missing = screen.getByText("국내 수급").closest("span") as HTMLElement;
    expect(missing.querySelector("svg")).not.toBeNull();
    expect(within(missing).getByText("주의:")).toBeTruthy();
    const set = screen.getByText("FRED 설정됨").closest("span") as HTMLElement;
    expect(set.className).toContain("text-ok");
    expect(set.querySelector("svg")).not.toBeNull();
    const none = screen.getByText("DART 없음").closest("span") as HTMLElement;
    expect(none.querySelector("svg")).toBeNull();
  });
});
