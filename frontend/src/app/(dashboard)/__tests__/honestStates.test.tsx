/**
 * '모름'을 '정상'·'없음'으로 보여 주지 않는다 — 조회가 실패하거나 값을 확인하지 못했을 때의 화면 문구.
 * (PRINCIPLES: 실패는 실패로, 모르는 값은 "—")
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 함수를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AiReportPage from "../ai/report/page";
import AlertsPage from "../alerts/page";
import { AiEngineSection } from "../connections/AiEngineSection";
import { TossSection } from "../connections/TossSection";
import CotPage from "../cot/page";
import MacroPage from "../macro/page";
import { ScrapedSection } from "../macro/ScrapedSection";
import { SingleChartSection } from "../macro/SingleChartSection";
import RadarPage from "../radar/page";
import StatusPage from "../status/page";

/** 경로 앞부분 → 응답(함수면 거절할 수도 있음). 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("QA-045 상태 화면 — 수집기에 닿지 못하면 누락 여부를 모른다", () => {
  // 수정 전에는 missingDatasets가 없으면(수집기 불통) '누락된 데이터셋이 없습니다'를 초록으로 보였다.
  it("누락 목록을 받지 못했으면 '없습니다'가 아니라 '확인하지 못했습니다'", async () => {
    reads["/api/status/issues"] = () => new Promise(() => {});
    reads["/api/status"] = () => Promise.resolve({ readMode: "auto", collectorReachable: false, taskSummary: [] });

    render(<StatusPage />);

    expect(await screen.findByText(/누락 여부를 확인하지 못했습니다/)).toBeTruthy();
    expect(screen.queryByText("누락된 데이터셋이 없습니다.")).toBeNull();
  });
});

describe("QA-102 상태 화면 오류·경고 로그 — 수집기에 닿지 못하면 누락 데이터셋 수를 모른다", () => {
  // 수정 전에는 누락 수를 모르는데도(null) '0개'로 적고, 실행 기록에 실패가 없으면 초록 '오류·경고가 없습니다'를 보였다.
  it("누락 데이터셋은 '—'이고 초록 '오류·경고가 없습니다'를 보이지 않는다", async () => {
    reads["/api/status/issues"] = () => Promise.resolve({
      generatedAt: "2026-10-18 09:00 KST", collectorReachable: false, lookbackHours: 24, lastRunStatus: null,
      counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: null },
      current: [], recent: [], missing: null, text: "요약: … 누락 데이터셋 확인 못 함(수집기 연결 안 됨)",
    });
    reads["/api/status"] = () => Promise.resolve({ readMode: "auto", collectorReachable: false, taskSummary: [] });

    render(<StatusPage />);
    const section = (await screen.findByRole("heading", { name: "수집 오류·경고 로그" })).closest("section") as HTMLElement;
    const metric = (await within(section).findByText("누락 데이터셋")).parentElement as HTMLElement;

    expect(metric.textContent).toBe("누락 데이터셋—");
    expect(within(section).queryByText(/오류·경고가 없습니다/)).toBeNull();
  });
});

describe("QA-046 수급 레이더 — 이력 조회가 실패하면 '이력 없음'이 아니다", () => {
  // 수정 전에는 오류를 받지 않아 500·연결 실패에도 '아직 누적된 이력이 없습니다'를 보였다.
  it("이력 조회 실패는 오류로 보이고 '아직 누적된 이력이 없습니다'를 적지 않는다", async () => {
    reads["/api/radar/history"] = () => Promise.reject(new Error("요청 실패 (HTTP 500)"));

    render(<RadarPage />);

    expect(await screen.findByText(/요청 실패 \(HTTP 500\)/)).toBeTruthy();
    expect(screen.queryByText(/아직 누적된 이력이 없습니다/)).toBeNull();
  });
});

describe("QA-050 실패·로딩을 '없음'으로 보이지 않는다", () => {
  // 수정 전에는 COT 개요 조회의 오류를 받지 않아 카드가 빈 채로 남았다.
  it("COT 개요 조회가 실패하면 오류를 보인다", async () => {
    reads["/api/cot/overview"] = () => Promise.reject(new Error("요청 실패 (HTTP 503)"));

    render(<CotPage />);

    expect(await screen.findByText(/요청 실패 \(HTTP 503\)/)).toBeTruthy();
  });

  // 수정 전에는 알림함을 읽는 동안(그리고 오류에도) '아직 알림이 없습니다'와 '읽지 않은 알림 0건'이 보였다.
  it("알림함을 읽는 동안에는 '아직 알림이 없습니다'·'0건'이 아니다", async () => {
    reads["/api/alerts/rules"] = () => Promise.resolve({ available: true, rules: [] });   // 알림함만 읽는 중
    render(<AlertsPage />);
    await screen.findByText("알림함");

    expect(screen.queryByText(/아직 알림이 없습니다/)).toBeNull();
    expect(screen.queryByText(/읽지 않은 알림 0건/)).toBeNull();
  });
});

describe("QA-050 자동 갱신이 실패하면 수집 시각 배지 옆에 알린다", () => {
  it("refreshError가 있으면 '새로 읽지 못함'(이유는 title), 없으면 보이지 않는다", async () => {
    const { Freshness } = await import("@/components/ui");
    const { rerender } = render(<Freshness collectedAt="2026-10-11 09:00 KST" refreshError="백엔드 API에 연결하지 못했습니다" />);
    expect(screen.getByText("새로 읽지 못함").getAttribute("title")).toContain("백엔드 API에 연결하지 못했습니다");

    rerender(<Freshness collectedAt="2026-10-11 09:00 KST" />);
    expect(screen.queryByText("새로 읽지 못함")).toBeNull();
  });
});

describe("QA-099 지표별 단독 차트 — 백엔드가 받지 못한 이유를 보인다", () => {
  // 수정 전에는 available·message를 보지 않아, 공개 데모(store_only)에서 10개 중 8개 지표가 이유 없이
  // '표시할 시계열이 없습니다'만 보였다(수집기 실패 사유도 같은 식으로 버려졌다).
  it.each([
    "store_only 모드에서는 저장하지 않는 지표의 차트를 조회하지 않습니다.",
    "수집기에서 시계열을 받지 못했습니다.",
  ])("응답이 '%s'이면 그 문구를 보이고 빈 차트를 그리지 않는다", async (message) => {
    reads["/api/macro/ticker"] = () => Promise.resolve({ available: false, symbol: "^VIX", points: [], message });

    render(<SingleChartSection />);

    expect(await screen.findByText(message, {}, { timeout: 500 })).toBeTruthy();
    expect(screen.queryByText("표시할 시계열이 없습니다.")).toBeNull();
  });
});

describe("QA-103 첫 조회·버튼 동작이 실패하면 이유를 보인다", () => {
  const FAILED = "요청 실패 (HTTP 503)";
  // 수정 전에는 error를 받지 않거나(스크래핑·AI 엔진 목록) 섹션에 넘기지 않아(심화 지표) 빈 카드·이유 없이 꺼진 버튼만 남았다.
  it.each<[string, string, () => ReactElement]>([
    ["스크래핑 시세", "/api/macro/scraped", () => <ScrapedSection />],
    ["매크로 심화 지표", "/api/macro/advanced", () => <MacroPage />],
    ["AI 엔진 목록(연결 테스트)", "/api/ai/engines", () => <AiEngineSection />],
  ])("%s: 첫 조회가 실패하면 오류와 다시 시도", async (_name, path, make) => {
    reads[path] = () => Promise.reject(new Error(FAILED));

    render(make());

    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  // 수정 전에는 진단 요청이 실패하면(백엔드 5xx, 회원이 주소로 들어와 403) 안내 문구까지 사라져 카드가 비었다.
  it("토스 연결 진단이 실패하면 오류를 보인다", async () => {
    reads["/api/ai/toss/diagnostics"] = () => Promise.reject(new Error("요청 실패 (HTTP 403)"));
    render(<TossSection />);

    fireEvent.click(screen.getByRole("button", { name: "진단 실행" }));

    expect(await screen.findByText("요청 실패 (HTTP 403)")).toBeTruthy();
  });

  // 수정 전에는 읽음 처리의 오류를 어디에도 그리지 않아, 실패해도 목록만 다시 읽혀 항목이 그대로 남았다.
  it("알림 읽음 처리가 실패하면 알림함에 알린다", async () => {
    reads["/api/alerts/rules"] = () => Promise.resolve({ available: true, rules: [] });
    reads["/api/alerts/inbox"] = () => Promise.resolve({ available: true, unread: 1, items: [
      { id: 1, read: false, late: false, title: "국면 전환", body: "본문", occurredOn: "2026-10-18" }] });
    api.apiPost.mockRejectedValue(new Error("요청 실패 (HTTP 500)"));
    render(<AlertsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "읽음" }));

    const inbox = (await screen.findByRole("heading", { name: "알림함" })).closest("section") as HTMLElement;
    expect(await within(inbox).findByText("요청 실패 (HTTP 500)")).toBeTruthy();
  });
});

describe("QA-132 AI 리포트 — 원본 텍스트를 받지 못하면 이유를 보인다", () => {
  // 수정 전에는 snapshot.error를 그리지 않아, 원본 데이터 카드를 펼치면 이유 없이 빈 상자만 보였다.
  it("원본 데이터 카드에 오류와 다시 시도", async () => {
    reads["/api/snapshot/text"] = () => Promise.reject(new Error("요청 실패 (HTTP 503)"));
    render(<AiReportPage />);

    fireEvent.click(screen.getByRole("button", { name: "AI에 전달되는 원본 데이터 보기" }));

    const card = (await screen.findByRole("heading", { name: "수집 데이터 원본 (AI 입력)" })).closest("section") as HTMLElement;
    expect(await within(card).findByText("요청 실패 (HTTP 503)")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
