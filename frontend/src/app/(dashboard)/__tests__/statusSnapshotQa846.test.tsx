/**
 * QA-846 — 저장소 상태 스냅샷 신선도 표가 상태와 '오래됨'을 색만으로 나름(D1 QA `status-snapshot-freshness-colour-only`, S3, 개편 전부터).
 *
 * 상태 칸은 원시 코드('ok')나 '추정치'를 정상·주의·위험 글자색으로만, 수집 칸은 오래된 저장본의 나이를 주의 글자색으로만 칠했습니다 — 색을 구별하지
 * 못하면 뜻이 전해지지 않고, 고대비(forced-colors)에서는 색이 지워져 '오래됨'이 완전히 사라졌습니다. 패널 부제는 "오래된 저장본은 화면에서도 '오래됨'으로
 * 표시됩니다"라고 약속합니다.
 *
 * 기대: 상태 칸은 모든 줄(정상 줄 포함 — D1 결정 거리 4, 계획 U6 '모든 행')이 상태 아이콘 + 한국어 글(정상·추정치·수집 실패, 모르는 코드는 '알 수 없음'),
 * 오래된 줄의 수집 칸에는 주의 태그 '오래됨'(아이콘 + '주의:' + 글).
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

const SNAPSHOTS = [
  { name: "macro", status: "ok", error: null, ageSeconds: 60, stale: false, collectedAt: "2026-11-18T00:00:00Z" },
  { name: "krx_futures", status: "estimated", error: null, ageSeconds: 90_000, stale: true, collectedAt: "2026-11-17T00:00:00Z" },
  { name: "kr_flows", status: "error", error: "HTTP 500", ageSeconds: 600, stale: false, collectedAt: "2026-11-18T00:00:00Z" },
];

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.status.overview]: { readMode: "auto", collectorReachable: true, taskSummary: [], snapshots: SNAPSHOTS },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

/** 스냅샷 표의 한 줄 — 데이터셋 이름 칸의 행. */
async function snapshotRow(name: string): Promise<HTMLTableRowElement> {
  const table = await screen.findByRole("region", { name: "스냅샷 신선도 (좌우 스크롤)" });
  return within(table).getByText(name).closest("tr") as HTMLTableRowElement;
}

describe("QA-846 스냅샷 신선도 — 상태와 '오래됨'을 아이콘 + 글로", () => {
  it.fails("상태 칸은 모든 줄이 상태 아이콘 + 한국어 글, 오래된 줄의 수집 칸에는 주의 태그 '오래됨'", async () => {
    render(<StatusPage />);
    const expected: Record<string, string> = { macro: "정상", krx_futures: "추정치", kr_flows: "수집 실패" };
    for (const [name, label] of Object.entries(expected)) {
      const row = await snapshotRow(name);
      const status = row.cells[1];
      expect(status.textContent, `${name} 상태 글`).toContain(label);
      expect(status.querySelector("svg")?.getAttribute("aria-hidden"), `${name} 상태 아이콘`).toBe("true");
    }
    const staleAge = (await snapshotRow("krx_futures")).cells[2];
    expect(within(staleAge).getByText("오래됨")).toBeTruthy();
    expect(staleAge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(staleAge).getByText("주의:")).toBeTruthy();
    // 오래되지 않은 줄에는 태그가 없습니다.
    expect(within((await snapshotRow("macro")).cells[2]).queryByText("오래됨")).toBeNull();
  });
});
