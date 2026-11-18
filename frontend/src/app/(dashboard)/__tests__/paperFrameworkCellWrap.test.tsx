/**
 * 모의 프레임·설정 표 칸의 글 꺾기(작업대 P6 자기 빌드 1440에서 잼): 공용 DataTable 칸 글에 wrap-anywhere(overflow-wrap: anywhere)를 두면 칸의 최소 폭이
 * 한 글자로 줄어 넓은 화면에서도 짧은 칸('이유' — '합성')이 글자 사이에서 꺾였습니다. 칸 글은 낱말 사이(break-keep) + 넘칠 때만 낱말 안(wrap-break-word).
 * jsdom은 배치를 재지 않으므로 클래스로 봅니다. 값은 합성 값입니다.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import { FrameworkSection } from "@/components/screens/paper/FrameworkSection";
import { SettingsSection } from "@/components/screens/paper/SettingsSection";

const V1 = {
  version: 1, status: "USER", title: "합성 판", rendered: "# 투자 OS — v1", tokensEst: 100, overBudget: false, changelog: "처음", createdAtKst: null,
  body: { schemaVersion: 1, title: "합성 판", status: "USER", principles: [{ id: "P1", text: "패킷" }], engines: [{ id: "E1", name: "시장관", rules: [{ id: "E1-R1", text: "세 축", addedIn: 1, sourceNoteId: null }] }], guidance: "" },
};
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {
    "/api/paper/framework": { available: true, current: V1, versions: [] },
    "/api/paper/framework/proposals": {
      available: true,
      proposals: [{
        id: 7, status: "PENDING", noteId: 1, model: "m", summary: "합성", beforeAfter: null, error: null, createdAtKst: null, decidedAtKst: null,
        resultVersion: null, baseVersion: 1, operations: [{ op: "UPDATE_RULE", target: "E1-R1", text: "합성 고친 글", why: "합성" }],
        assessment: [{ point: "합성 주장", verdict: "일치", reason: "합성" }],
      }],
    },
    "/api/paper/settings": { available: true, version: 2, body: { a: 1 }, defaults: { a: 1 }, keys: [{ key: "a", type: "integer", min: null, max: null, affectsRules: false, description: null }] },
    "/api/paper/settings/history": { available: true, history: [{ version: 2, changedKeys: ["a"], createdAtKst: null, body: { a: 1 } }] },
  };
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 표 몸통 칸 안의 요소 가운데 wrap-anywhere를 단 것. */
const anywhere = (table: HTMLElement) => [...table.querySelectorAll("tbody *")].filter((element) => element.classList.contains("wrap-anywhere"));

describe("표 칸 글 꺾기 — 칸 최소 폭을 한 글자로 줄이지 않음", () => {
  it("프레임 제안의 평가·변경 표", async () => {
    render(<FrameworkSection />);
    (await screen.findByRole("button", { name: /^#7 / })).click();
    const changes = await screen.findByRole("region", { name: "변경" });
    const assessment = screen.getByRole("region", { name: "평가 (OS 절차 B)" });
    for (const region of [changes, assessment]) {
      const table = within(region).getByRole("table");
      expect(anywhere(table)).toEqual([]);
      expect(table.querySelector("tbody .wrap-break-word")).not.toBeNull();
    }
  });

  it("설정 바꾼 기록 표", async () => {
    render(<SettingsSection />);
    await waitFor(() => expect(screen.getByRole("table", { name: "바꾼 기록" })).toBeTruthy());
    const table = screen.getByRole("table", { name: "바꾼 기록" });
    expect(anywhere(table)).toEqual([]);
    expect(table.querySelector("tbody .wrap-break-word")).not.toBeNull();
  });
});
