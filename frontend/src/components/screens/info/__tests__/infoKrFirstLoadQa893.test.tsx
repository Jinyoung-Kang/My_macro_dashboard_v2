/**
 * 정보 수집 국내 탭의 첫 적재 이동 — QA-893(D6 전 QA 스택 확인에서 찾음, 개편 전부터 — 기준 빌드도 같은 꼴).
 *
 * 국내 탭은 KRX 패널이 읽는 중 한 줄이다가 응답 뒤 자라는데, 그 높이가 받은 자료에 따라 크게 갈립니다(받은 날 표 다섯 약 2,000px · 저장본 없음
 * 약 230px). 처음부터 보이던 아래 네이버·출처 패널이 응답 뒤 첫 화면 밖으로 밀려, 합성 자료(받은 날) 첫 적재 CLS 1024 0.48·1280 0.55·1440 0.32
 * (기준 0.51·0.57·0.37)였습니다. 읽는 중 자리를 받은 날 꼴(화면 높이 이상)로 두면 받은 날은 0.002가 되지만 저장본이 없는 날(QA 자료)은 아래
 * 패널이 화면 밖에서 올라와 0.02 → 0.40이 되어(머리 없는 크롬으로 잼) 쓰지 않았습니다.
 *
 * 기대: KRX 패널이 처음 답할 때까지(값이든 오류든) 아래 네이버·출처 패널은 그리되 보이지 않게(hidden — 요청은 처음부터 함께, 경로·횟수 그대로),
 * 답한 뒤 처음 나타납니다(밀리지 않음).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected null to be truthy'(아래 패널이 처음부터 보임).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "../InfoHub";

const DEFERRED = {
  task: "info_saveticker", key: "saveticker", label: "합성 보류 출처", tab: "news", kind: "news", siteUrl: null, origin: "합성", access: "deferred", screen: null,
  speed: null, lastStatus: null, lastRunAt: null, lastDetail: null, politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "neutral",
};
const CATALOG = { checkedAt: "2026-11-19 10:00 KST", collectorReachable: true, tabs: [], sources: [DEFERRED], incidents: [] };
const FLOWS = { available: false, collectedAtKst: null, failed: [] };

/** 경로 앞부분마다 직접 풀 수 있는 응답 — 풀기 전에는 기다리는 중. */
function deferredRoutes(prefixes: string[]) {
  const resolvers = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const promises = new Map<string, Promise<unknown>>();
  for (const prefix of prefixes) {
    promises.set(prefix, new Promise((resolve, reject) => resolvers.set(prefix, { resolve, reject })));
  }
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = prefixes.find((prefix) => path.startsWith(prefix));
    return hit ? (promises.get(hit) as Promise<unknown>) : new Promise(() => {});
  });
  return resolvers;
}
const called = (prefix: string) => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));
/** 제목(h2)이 든 패널이 hidden 안에 있는가. */
const hiddenPanel = (title: string) => screen.getByText(title, { selector: "h2" }).closest("[hidden]");

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

describe("정보 수집 국내 탭 첫 적재(QA-893)", () => {
  it.fails("KRX가 답하기 전에는 네이버·출처 패널을 보이지 않게(요청은 처음부터), KRX가 답하면(오류여도) 나타난다", async () => {
    const routes = deferredRoutes(["/api/info/krx", "/api/info/flows", "/api/info/catalog"]);
    render(<InfoHub tab="kr" />);
    await act(async () => {
      routes.get("/api/info/flows")?.resolve(FLOWS);
      routes.get("/api/info/catalog")?.resolve(CATALOG);
    });
    expect(called("/api/info/krx")).toHaveLength(1);
    expect(called("/api/info/flows")).toHaveLength(1);
    expect(called("/api/info/catalog")).toHaveLength(1);
    expect(hiddenPanel("네이버 투자자별 매매동향·매매상위")).toBeTruthy();
    expect(hiddenPanel("출처")).toBeTruthy();
    await act(async () => routes.get("/api/info/krx")?.reject(new Error("합성 실패")));
    expect(hiddenPanel("네이버 투자자별 매매동향·매매상위")).toBeNull();
    expect(hiddenPanel("출처")).toBeNull();
    expect(called("/api/info/flows")).toHaveLength(1);
  });
});
