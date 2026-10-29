/**
 * 🧪 모의 매매 — 프레임·메모 탭(단계 3b, 명세 F1~F7·D14·D15). 서버 값을 그대로 보이고, 렌더링·토큰 어림·예산 초과·유효 메모는 화면이
 * 다시 판정하지 않는다.
 *
 *  - 프레임: 지금 판(임시면 "임시 v0" 배지·안내, 토큰 어림 / 예산, 예산 초과 경고, 렌더링은 접어 둠), 판 목록과 두 판 나란히 비교
 *    (GET /api/paper/framework/versions/{v})
 *  - OS 원문으로 새 판 만들기: 원문 → POST /api/paper/notes {kind:INSIGHT} → 확인(비용 "Sonnet 5.5 호출 1회") → POST
 *    /api/paper/framework/proposals {noteId} → 그 자리에 제안 → 승인 확인(비용 없음) → POST …/{id}/approve → 판·제안 다시 읽기
 *  - 제안 목록: 기준 판이 지금 판과 다르면 승인을 막고, 거절은 확인 뒤 POST …/{id}/reject, 서버 400 문구는 경고로
 *  - 직접 고치기: 규칙마다 글자 수(400자), 넘으면 저장을 막음, 규칙 추가 → 저장 확인 → POST /api/paper/framework {body(status USER), changelog}
 *  - 메모: 목록(서버 상태 그대로)·만료 포함 토글, 쓰기(빈 날짜는 빼고 — 만료 기본 안내는 설정값), 보관은 확인 뒤 DELETE
 *  - 개요: 순자산 곡선에 프레임 경계선("프레임 v0")과 한 줄
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않습니다 — 경계선(markers)만 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ markers }: { markers?: { x: string; label: string }[] }) =>
    markers && markers.length > 0 ? (
      <ul aria-label="경계선">
        {markers.map((marker) => <li key={marker.x}>{`${marker.x} ${marker.label}`}</li>)}
      </ul>
    ) : null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
};

function engines(extra: { id: string; text: string; addedIn: number; sourceNoteId: number | null }[] = []) {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `E${index + 1}`,
    name: index === 0 ? "매크로 축 — 현금 비중" : `엔진 ${index + 1}`,
    rules: [
      { id: `E${index + 1}-R1`, text: index === 0 ? "세 축으로 주식 노출을 정한다." : `규칙 ${index + 1}`, addedIn: 0, sourceNoteId: null },
      ...(index === 1 ? [{ id: "E2-R3", text: "13F는 45일 시차를 안고 있다.", addedIn: 0, sourceNoteId: null }, ...extra] : []),
    ],
  }));
}

const BODY_V0 = {
  schemaVersion: 1, title: "임시 v0 — OS 원문 반영 전", status: "INTERIM",
  principles: [{ id: "P1", text: "패킷의 숫자에서 출발한다." }, { id: "P2", text: "과매매하지 않는다." }],
  engines: engines(), guidance: "이 판은 임시다.",
};

const RENDERED_V0 = "# 투자 OS — v0 (임시 v0 — OS 원문 반영 전)\n## 원칙\n1. 패킷의 숫자에서 출발한다.\n2. 과매매하지 않는다.";
const RENDERED_V1 = "# 투자 OS — v1 (투자 OS 2026-10)\n## 원칙\n1. 패킷의 숫자에서 출발한다.\n2. 노출은 매일 다시 정한다.";

const V0 = {
  version: 0, status: "INTERIM", title: "임시 v0 — OS 원문 반영 전", body: BODY_V0, rendered: RENDERED_V0, tokensEst: 4123,
  overBudget: false, changelog: "임시 v0 — 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판", createdAtKst: "2026-10-25 10:00",
};
const V1 = {
  ...V0, version: 1, status: "USER", title: "투자 OS 2026-10", body: { ...BODY_V0, status: "USER", title: "투자 OS 2026-10" },
  rendered: RENDERED_V1, tokensEst: 8420, overBudget: true, changelog: "OS 원문 옮김", createdAtKst: "2026-10-25 12:00",
};

const SUMMARY_V0 = { version: 0, title: V0.title, changelog: V0.changelog, createdAtKst: V0.createdAtKst, sourceProposalId: null };
const SUMMARY_V1 = { version: 1, title: V1.title, changelog: V1.changelog, createdAtKst: V1.createdAtKst, sourceProposalId: null };

const PROPOSAL = {
  id: 3, status: "PENDING", noteId: 12, model: "claude-sonnet-5-5", summary: "원문의 노출 규칙을 E1에 더합니다.",
  operations: [
    { op: "ADD_RULE", target: "E1", text: "VIX 30 이상이면 노출을 줄인다.", why: "원문 3절" },
    { op: "DELETE_PRINCIPLE", target: "P2", text: null, why: "원문과 모순" },
  ],
  assessment: [
    { point: "현금 비중은 매일 정한다", verdict: "일치", reason: "P3와 같음" },
    { point: "레버리지 ETF를 쓴다", verdict: "모순", reason: "유니버스 밖" },
  ],
  beforeAfter: "전: 노출 규칙 2개 → 후: 3개", error: null, createdAtKst: "2026-10-25 11:00", decidedAtKst: null,
  resultVersion: null, baseVersion: 0,
};

const SETTINGS = {
  available: true, version: 2, body: { frameworkTokenBudget: 8000, notesDefaultExpiryTradingDays: 5 }, defaults: {}, keys: [],
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};
let counts: Record<string, number> = {};

function serve(path: string, response: () => unknown) {
  reads[path] = () => {
    counts[path] = (counts[path] ?? 0) + 1;
    return Promise.resolve(response());
  };
}

beforeEach(() => {
  reads = {};
  counts = {};
  serve("/api/paper/overview", () => OVERVIEW);
  serve("/api/paper/settings", () => SETTINGS);
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const rowsOf = (region: HTMLElement) =>
  within(region).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));

async function openTab(name: "프레임" | "메모") {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name }));
}

describe("프레임 탭 — 지금 판·판 목록·비교", () => {
  it("임시 v0 — 배지·안내, 토큰 어림 / 예산(설정), 렌더링은 접어 둠, 판이 하나면 비교 대신 안내", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework", () => ({ available: true, current: V0, versions: [SUMMARY_V0] }));
    await openTab("프레임");

    expect(await screen.findByText("지금 프레임")).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/framework", 0);
    expect(screen.getAllByText("임시 v0").length).toBeGreaterThan(0);
    expect(screen.getByText(/지금 판은 임시 v0입니다 — 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판입니다/)).toBeTruthy();
    expect(await screen.findByText("추정 4,123토큰 / 예산 8,000토큰")).toBeTruthy();
    expect(screen.getByText("원칙 2 · 엔진 8 · 규칙 9")).toBeTruthy();
    const currentCard = screen.getByText("지금 프레임").closest("section") as HTMLElement;
    expect(within(currentCard).getByText(V0.changelog).textContent).toBe(`바꾼 내용 ${V0.changelog}`);
    expect(screen.queryByText(/렌더링이 예산을 넘습니다/)).toBeNull();
    const preview = screen.getByText("렌더링 미리보기(시스템 프롬프트)").closest("details") as HTMLDetailsElement;
    expect(preview.open).toBe(false);
    expect(preview.textContent).toContain("# 투자 OS — v0");

    expect(screen.getByText(/판이 하나뿐입니다/)).toBeTruthy();
    expect(screen.getByText(/아직 제안이 없습니다/)).toBeTruthy();
  });

  it("사용자 판 — 예산 초과 경고(서버 판정), 판 목록(출처·지금 표시), 두 판 렌더링을 나란히(다른 줄 강조)", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework/versions/0", () => ({ available: true, version: V0 }));
    serve("/api/paper/framework/versions/1", () => ({ available: true, version: V1 }));
    // 예산은 판 응답 맨 위의 tokenBudget(서버가 지금 설정에서 읽음)이 설정 응답보다 우선합니다.
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [SUMMARY_V1, SUMMARY_V0], tokenBudget: 8200 }));
    await openTab("프레임");

    expect(await screen.findByText(/렌더링이 예산을 넘습니다\(추정 8,420토큰 \/ 예산 8,200토큰\)/)).toBeTruthy();
    expect(screen.getAllByText("v1 · 사용자 판").length).toBeGreaterThan(0);
    expect(screen.queryByText(/지금 판은 임시/)).toBeNull();

    const versions = screen.getByText("판 목록·비교").closest("section") as HTMLElement;
    const table = within(versions).getAllByRole("table")[0];
    expect(within(table).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent))).toEqual([
      ["v1지금", "투자 OS 2026-10", "OS 원문 옮김", "수동 편집", "2026-10-25 12:00"],
      ["v0", "임시 v0 — OS 원문 반영 전", V0.changelog, "처음 시드(임시)", "2026-10-25 10:00"],
    ]);

    const compare = screen.getByRole("region", { name: "두 판 비교" });
    await waitFor(() => expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/framework/versions/0", 0));
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/framework/versions/1", 0);
    const left = await within(compare).findByRole("region", { name: "v0 렌더링" });
    const right = within(compare).getByRole("region", { name: "v1 렌더링" });
    await within(left).findByText("2. 과매매하지 않는다.");
    const changed = (region: HTMLElement) =>
      [...region.querySelectorAll("[data-changed='true']")].map((line) => line.textContent);
    expect(changed(left)).toEqual(["# 투자 OS — v0 (임시 v0 — OS 원문 반영 전)", "2. 과매매하지 않는다."]);
    await within(right).findByText("2. 노출은 매일 다시 정한다.");
    expect(changed(right)).toEqual(["# 투자 OS — v1 (투자 OS 2026-10)", "2. 노출은 매일 다시 정한다."]);
    expect(within(compare).getByText(/왼쪽 2줄 · 오른쪽 2줄/)).toBeTruthy();
  });

  it("판 표가 아직 없으면(available:false) 서버 문구 그대로", async () => {
    serve("/api/paper/framework", () => ({ available: false, message: "프레임 테이블이 아직 없습니다 — make migrate" }));
    await openTab("프레임");
    expect(await screen.findByText("프레임 테이블이 아직 없습니다 — make migrate")).toBeTruthy();
  });
});

describe("프레임 탭 — OS 원문으로 새 판 만들기", () => {
  it("원문 → 메모 저장 → 확인(비용) → 제안 요청 → 그 자리에 제안 → 승인 확인(비용 없음) → 승인, 판·제안을 다시 읽는다", async () => {
    let proposals: unknown[] = [];
    let current: unknown = V0;
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals }));
    serve("/api/paper/framework", () => ({ available: true, current, versions: [SUMMARY_V0] }));
    let finishPropose: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation((path: string) => {
      if (path === "/api/paper/notes") {
        return Promise.resolve({
          ok: true,
          note: { id: 12, kind: "INSIGHT", asOfDate: "2026-10-25", expiresOn: null, title: "투자 OS 원문", body: "원문", archived: false, active: true, createdAtKst: null },
        });
      }
      if (path === "/api/paper/framework/proposals") {
        return new Promise((resolve) => {
          finishPropose = resolve;
        });
      }
      if (path === "/api/paper/framework/proposals/3/approve") {
        proposals = [{ ...PROPOSAL, status: "APPROVED", resultVersion: 1, decidedAtKst: "2026-10-25 11:30" }];
        current = { ...V0, version: 1, title: "임시 v1" };
        return Promise.resolve({ ok: true, version: 1 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    await openTab("프레임");

    const card = (await screen.findByText("OS 원문으로 새 판 만들기")).closest("section") as HTMLElement;
    const request = within(card).getByRole("button", { name: "② 제안 요청" }) as HTMLButtonElement;
    expect(request.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText("OS 원문"), { target: { value: "  원문  " } });
    fireEvent.click(within(card).getByRole("button", { name: "① 메모로 저장" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/notes", { kind: "INSIGHT", title: "투자 OS 원문", body: "원문" });
    expect(await within(card).findByText(/방법론 메모\(#12\)를 저장했습니다/)).toBeTruthy();
    // 저장한 뒤에는 글을 잠그고(같은 원문 메모가 쌓이지 않게) 제안 요청을 엽니다.
    expect((within(card).getByLabelText("OS 원문") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(within(card).getByText(/비용: Sonnet 5\.5 호출 1회/)).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "② 제안 요청" }));
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(within(card).getByText(/메모\(#12\)로 제안을 요청할까요\? Sonnet 5\.5 호출 1회/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "제안 요청 확인" }));
    expect(api.apiPost).toHaveBeenLastCalledWith("/api/paper/framework/proposals", { noteId: 12 });
    expect(await within(card).findByRole("button", { name: /제안 받는 중… \d+초/ })).toBeTruthy();

    const proposalReads = counts["/api/paper/framework/proposals"];
    proposals = [PROPOSAL];
    finishPropose({ ok: true, proposal: PROPOSAL });

    expect(await within(card).findByText(/제안\(#3\)을 받았습니다 — 평가와 변경을 보고 승인하거나 거절하세요\. 자동 반영은 없습니다/))
      .toBeTruthy();
    await waitFor(() => expect(counts["/api/paper/framework/proposals"]).toBeGreaterThan(proposalReads));
    const inline = within(card).getByRole("article", { name: "제안 #3" });
    expect(rowsOf(within(inline).getByRole("region", { name: "평가 (OS 절차 B)" }))).toEqual([
      ["현금 비중은 매일 정한다", "일치", "P3와 같음"],
      ["레버리지 ETF를 쓴다", "모순", "유니버스 밖"],
    ]);
    expect(rowsOf(within(inline).getByRole("region", { name: "변경" }))).toEqual([
      ["규칙 추가", "E1", "E1. 매크로 축 — 현금 비중 — 새 규칙", "VIX 30 이상이면 노출을 줄인다.", "원문 3절"],
      ["원칙 삭제", "P2", "과매매하지 않는다.", "(삭제)", "원문과 모순"],
    ]);
    expect(within(inline).getByText("전: 노출 규칙 2개 → 후: 3개")).toBeTruthy();
    // 같은 제안이 아래 목록에도 있습니다.
    const list = screen.getByText("제안", { selector: "h2" }).closest("section") as HTMLElement;
    expect(within(list).getByRole("article", { name: "제안 #3" })).toBeTruthy();

    fireEvent.click(within(inline).getByRole("button", { name: "제안 #3 승인" }));
    const confirm = within(inline).getByText(/이 제안\(#3\)을 승인할까요\?/);
    expect(confirm.textContent).toContain("Claude를 부르지 않습니다(비용 없음)");
    expect(confirm.textContent).toContain("새 판은 기준 판의 상태(임시)를 이어받습니다");
    const frameworkReads = counts["/api/paper/framework"];
    fireEvent.click(within(inline).getByRole("button", { name: "승인 확인" }));

    expect(api.apiPost).toHaveBeenLastCalledWith("/api/paper/framework/proposals/3/approve");
    expect(await within(card).findByText("승인했습니다 — 새 판 v1. 다음 Claude 결정부터 이 판으로 판단합니다.")).toBeTruthy();
    await waitFor(() => expect(counts["/api/paper/framework"]).toBeGreaterThan(frameworkReads));
    // 다시 읽은 목록의 상태(승인)로 바뀌고 버튼은 사라집니다.
    await waitFor(() => expect(within(card).getAllByText("승인").length).toBeGreaterThan(0));
    expect(within(card).queryByRole("button", { name: "제안 #3 승인" })).toBeNull();
  });

  it("제안 요청이 실패하면(FAILED 행) 경고와 서버 사유 — 판은 그대로, 다시 요청할 수 있다", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework", () => ({ available: true, current: V0, versions: [SUMMARY_V0] }));
    api.apiPost.mockImplementation((path: string) => (path === "/api/paper/notes"
      ? Promise.resolve({ ok: true, note: { id: 12, kind: "INSIGHT", title: "t", body: "b", archived: false, active: true } })
      : Promise.resolve({ ok: false, proposal: { ...PROPOSAL, status: "FAILED", summary: null, operations: null, assessment: null, error: "API_ERROR — 529 과부하" } })));
    await openTab("프레임");

    const card = (await screen.findByText("OS 원문으로 새 판 만들기")).closest("section") as HTMLElement;
    fireEvent.change(within(card).getByLabelText("OS 원문"), { target: { value: "원문" } });
    fireEvent.click(within(card).getByRole("button", { name: "① 메모로 저장" }));
    fireEvent.click(await within(card).findByRole("button", { name: "② 제안 요청" }));
    fireEvent.click(within(card).getByRole("button", { name: "제안 요청 확인" }));

    const warning = await within(card).findByText(/제안 요청이 실패했습니다\(#3\) — API_ERROR — 529 과부하\. 판은 바뀌지 않았습니다/);
    expect(warning.closest("div")?.className).toContain("text-warn");
    expect((within(card).getByRole("button", { name: "② 제안 요청" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("프레임 탭 — 제안 목록", () => {
  it("기준 판이 지금 판과 다르면 승인을 막고, 거절은 확인 뒤 POST reject, 서버 400 문구는 경고로", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [PROPOSAL, { ...PROPOSAL, id: 4, baseVersion: 1 }] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [SUMMARY_V1, SUMMARY_V0] }));
    api.apiPost.mockRejectedValueOnce(new Error("대기 중인 제안이 아닙니다"));
    await openTab("프레임");

    const stale = await screen.findByRole("article", { name: "제안 #3" });
    expect(within(stale).getByText(/이 제안의 기준 판\(v0\)이 지금 판\(v1\)과 다릅니다/)).toBeTruthy();
    expect((within(stale).getByRole("button", { name: "제안 #3 승인" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(stale).getByText(/승인·거절은 Claude를 부르지 않습니다\(비용 없음\)/)).toBeTruthy();

    const fresh = screen.getByRole("article", { name: "제안 #4" });
    expect((within(fresh).getByRole("button", { name: "제안 #4 승인" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(fresh).getByRole("button", { name: "제안 #4 거절" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(within(fresh).getByText(/이 제안\(#4\)을 거절할까요\? 판은 바뀌지 않고/)).toBeTruthy();
    fireEvent.click(within(fresh).getByRole("button", { name: "거절 확인" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/framework/proposals/4/reject");
    const warning = await within(fresh).findByText("대기 중인 제안이 아닙니다");
    expect(warning.closest("div")?.className).toContain("text-warn");
    expect((within(fresh).getByRole("button", { name: "제안 #4 거절" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("프레임 탭 — 직접 고치기", () => {
  it("규칙 글자 수(400자) — 넘으면 저장을 막고, 규칙 추가 → 저장 확인 → POST /api/paper/framework {body(status USER), changelog}", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework", () => ({ available: true, current: V0, versions: [SUMMARY_V0] }));
    api.apiPost.mockResolvedValue({ ok: true, version: 1 });
    await openTab("프레임");

    fireEvent.click(await screen.findByRole("button", { name: "지금 판으로 편집 시작" }));
    const form = screen.getByRole("form", { name: "프레임 편집" });
    expect(within(form).getAllByRole("group")).toHaveLength(9);   // 원칙 + 엔진 8개
    const rule = within(form).getByLabelText("규칙 E1-R1") as HTMLTextAreaElement;
    expect(rule.value).toBe("세 축으로 주식 노출을 정한다.");
    expect(within(form).getAllByText("17/400자 · v0에서 추가").length).toBe(1);

    fireEvent.change(rule, { target: { value: "가".repeat(401) } });
    const count = within(form).getByText(/^401\/400자/);
    expect(count.className).toContain("text-warn");
    expect(within(form).getByText("규칙 E1-R1: 400자를 넘습니다(401자).")).toBeTruthy();
    const save = within(form).getByRole("button", { name: "새 판 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(rule, { target: { value: "세 축(할인율·비용 물가·외환)으로 노출을 정한다." } });
    fireEvent.click(within(form).getByRole("button", { name: "규칙 추가 (E2)" }));
    expect(within(form).getByText("0/400자 · 새 규칙 — 추가한 판 번호는 저장할 때 서버가 채움")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("규칙 E2-R4"), { target: { value: "새 규칙" } });
    fireEvent.click(within(form).getByRole("button", { name: "원칙 P2 지우기" }));
    fireEvent.change(within(form).getByLabelText(/바꾼 내용/), { target: { value: "OS 원문 옮김" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(within(form).getByText(/새 판으로 저장할까요\? 사용자 판이 되고/)).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "저장 확인" }));

    expect(api.apiPost).toHaveBeenCalledTimes(1);
    const [path, payload] = api.apiPost.mock.calls[0] as [string, { body: Record<string, unknown>; changelog: string }];
    expect(path).toBe("/api/paper/framework");
    expect(payload.changelog).toBe("OS 원문 옮김");
    expect((payload as { baseVersion?: unknown }).baseVersion).toBe(0);
    expect(payload.body).toMatchObject({ schemaVersion: 1, status: "USER", title: "임시 v0 — OS 원문 반영 전", guidance: "이 판은 임시다." });
    expect(payload.body.principles).toEqual([{ id: "P1", text: "패킷의 숫자에서 출발한다." }]);
    const sent = payload.body.engines as { id: string; rules: { id: string; text: string; addedIn: number | null }[] }[];
    expect(sent).toHaveLength(8);
    expect(sent[0].rules[0]).toMatchObject({ id: "E1-R1", text: "세 축(할인율·비용 물가·외환)으로 노출을 정한다.", addedIn: 0 });
    // 새 규칙의 addedIn은 비워 보냅니다 — 서버가 새 판 번호로 채웁니다.
    expect(sent[1].rules.map((entry) => [entry.id, entry.addedIn])).toEqual([["E2-R1", 0], ["E2-R3", 0], ["E2-R4", null]]);

    expect(await screen.findByText(/새 판 v1\(사용자 판\)을 저장했습니다/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "프레임 편집" })).toBeNull();
  });
});

describe("프레임 탭 — 3b 리뷰 결함", () => {
  it("FW-1 다른 창에서 판이 생겨 서버가 저장을 거절하면(400) 판을 다시 읽어 '판이 바뀌었습니다' 안내 — 편집본은 그대로", async () => {
    let current: unknown = V0;
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework", () => ({ available: true, current, versions: [SUMMARY_V0] }));
    api.apiPost.mockImplementation(() => {
      current = V1;   // 그사이 다른 창에서 제안을 승인해 v1이 생김
      return Promise.reject(new Error("다른 판이 먼저 생겼습니다 — 편집을 다시 시작하세요(편집 기준 v0, 지금 v1)."));
    });
    await openTab("프레임");

    fireEvent.click(await screen.findByRole("button", { name: "지금 판으로 편집 시작" }));
    const form = screen.getByRole("form", { name: "프레임 편집" });
    fireEvent.change(within(form).getByLabelText("원칙 P1"), { target: { value: "탭 A에서 고친 원칙" } });
    fireEvent.change(within(form).getByLabelText(/바꾼 내용/), { target: { value: "탭 A" } });
    fireEvent.click(within(form).getByRole("button", { name: "새 판 저장" }));
    fireEvent.click(within(form).getByRole("button", { name: "저장 확인" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/framework", expect.objectContaining({ baseVersion: 0 }));
    expect(await within(form).findByText(/다른 판이 먼저 생겼습니다/)).toBeTruthy();
    expect(await within(form).findByText(/편집을 시작한 뒤 판이 바뀌었습니다\(기준 임시 v0 → 지금 v1\)/)).toBeTruthy();
    expect((within(form).getByLabelText("원칙 P1") as HTMLTextAreaElement).value).toBe("탭 A에서 고친 원칙");
    expect((within(form).getByRole("button", { name: "새 판 저장" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("F1 사용자 판이면 '방법론 글로 갱신 제안 받기' — 이미 있는 방법론 메모를 골라 POST {noteId}(새 메모를 만들지 않음)", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [SUMMARY_V1, SUMMARY_V0] }));
    serve("/api/paper/notes?includeExpired=false", () => ({
      available: true,
      referenceDate: "2026-10-26",
      notes: [
        { id: 12, kind: "MARKET", asOfDate: "2026-10-23", expiresOn: "2026-10-28", title: "유가", body: "브렌트", archived: false, active: true, createdAtKst: null },
        { id: 10, kind: "INSIGHT", asOfDate: "2026-10-20", expiresOn: null, title: "투자 OS 원문", body: "원문", archived: false, active: true, createdAtKst: null },
      ],
    }));
    // 고르기 목록은 두 시장 메모를 합칩니다(사용자 결정 2026-10-29 y1) — 한국 메모는 기준일 최근 순으로 섞이고 이름 끝에 시장.
    serve("/api/paper/notes?includeExpired=false&market=KR", () => ({
      available: true,
      market: "KR",
      notes: [
        { id: 14, kind: "INSIGHT", asOfDate: "2026-10-22", expiresOn: null, title: "한국 방법론", body: "수급", archived: false, active: true, createdAtKst: null },
      ],
    }));
    api.apiPost.mockResolvedValue({ ok: true, proposal: { ...PROPOSAL, id: 5, noteId: 10, baseVersion: 1 } });
    await openTab("프레임");

    expect(screen.queryByText("OS 원문으로 새 판 만들기")).toBeNull();
    const card = (await screen.findByText("방법론 글로 갱신 제안 받기")).closest("section") as HTMLElement;
    expect(within(card).getByLabelText("방법론 글")).toBeTruthy();
    expect(within(card).getByText(/메모 제목\(비우면 "방법론 글"\)/)).toBeTruthy();
    const select = (await within(card).findByLabelText("이미 있는 방법론 메모로 요청")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "고르지 않음 — 아래에 글을 붙여 새 메모로", "#14 한국 방법론 (2자) · 한국", "#10 투자 OS 원문 (2자) · 미국",
    ]);
    fireEvent.change(select, { target: { value: "10" } });
    expect(within(card).getByText("메모 #10의 글로 요청합니다 — 새 메모를 만들지 않습니다.")).toBeTruthy();
    expect((within(card).getByRole("button", { name: "① 메모로 저장" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "② 제안 요청" }));
    expect(within(card).getByText(/메모\(#10\)로 제안을 요청할까요\? Sonnet 5\.5 호출 1회/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "제안 요청 확인" }));

    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/framework/proposals", { noteId: 10 });
    expect(await within(card).findByText(/제안\(#5\)을 받았습니다/)).toBeTruthy();
    // 다시 고르려면 '다른 글로 다시 쓰기'로 풉니다.
    fireEvent.click(within(card).getByRole("button", { name: "다른 글로 다시 쓰기" }));
    expect(select.value).toBe("");
  });

  it("FW-3·F2 변경 0건인 대기 제안은 승인 버튼을 막고 '거절로 닫으세요' — 거절은 그대로 할 수 있다", async () => {
    serve("/api/paper/framework/proposals", () => ({ available: true, proposals: [{ ...PROPOSAL, id: 6, operations: [], baseVersion: 1 }] }));
    serve("/api/paper/framework", () => ({ available: true, current: V1, versions: [SUMMARY_V1, SUMMARY_V0] }));
    await openTab("프레임");

    const item = await screen.findByRole("article", { name: "제안 #6" });
    expect(within(item).getByText("평가만 있는 제안입니다 — 바꿀 것이 없어 승인할 수 없습니다(서버가 새 판을 만들지 않음). 거절로 닫으세요."))
      .toBeTruthy();
    expect(within(item).queryByText(/같은 내용의 새 판이 생깁니다/)).toBeNull();
    expect((within(item).getByRole("button", { name: "제안 #6 승인" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(item).getByRole("button", { name: "제안 #6 거절" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("FW-4 승인된 제안의 변경 표는 기준 판(v0)을 읽어 대조 — '승인하면 서버가 거절합니다' 경고가 없다", async () => {
    serve("/api/paper/framework/proposals", () => ({
      available: true,
      proposals: [{ ...PROPOSAL, status: "APPROVED", resultVersion: 1, decidedAtKst: "2026-10-25 11:30" }],
    }));
    // 지금 판 v1에는 P2가 없음(승인으로 지움)
    const v1 = { ...V1, body: { ...V1.body, principles: [{ id: "P1", text: "패킷의 숫자에서 출발한다." }] } };
    serve("/api/paper/framework", () => ({ available: true, current: v1, versions: [SUMMARY_V1, SUMMARY_V0] }));
    serve("/api/paper/framework/versions/0", () => ({ available: true, version: V0 }));
    await openTab("프레임");

    const item = await screen.findByRole("article", { name: "제안 #3" });
    const changes = within(item).getByRole("region", { name: "변경" });
    expect(within(changes).getByText(/승인한 제안입니다 — 이 변경을 기준 판\(v0\)에 적용해 v1을 만들었습니다/)).toBeTruthy();
    await waitFor(() => expect(rowsOf(changes)).toEqual([
      ["규칙 추가", "E1", "E1. 매크로 축 — 현금 비중 — 새 규칙", "VIX 30 이상이면 노출을 줄인다.", "원문 3절"],
      ["원칙 삭제", "P2", "과매매하지 않는다.", "(삭제)", "원문과 모순"],
    ]));
    expect(within(changes).getByRole("columnheader", { name: "기준 판 글(v0)" })).toBeTruthy();
    expect(within(item).queryByText(/승인하면 서버가 거절합니다/)).toBeNull();
    expect(within(item).queryByRole("button", { name: "제안 #3 승인" })).toBeNull();
  });
});

describe("메모 탭", () => {
  const NOTES = [
    { id: 12, kind: "MARKET", asOfDate: "2026-10-23", expiresOn: "2026-10-28", title: "유가 급등", body: "브렌트 95 돌파", archived: false, active: true, createdAtKst: "2026-10-24 09:00" },
    { id: 10, kind: "INSIGHT", asOfDate: "2026-10-20", expiresOn: null, title: "투자 OS 원문", body: "원문", archived: false, active: true, createdAtKst: null },
  ];
  const EXPIRED = { id: 7, kind: "MARKET", asOfDate: "2026-10-10", expiresOn: "2026-10-15", title: "옛 메모", body: "x", archived: false, active: false, createdAtKst: null };

  beforeEach(() => {
    serve("/api/paper/notes?includeExpired=false", () => ({ available: true, notes: NOTES }));
    serve("/api/paper/notes?includeExpired=true", () => ({ available: true, notes: [...NOTES, EXPIRED] }));
  });

  it("목록은 서버 상태 그대로 — 만료 포함 토글은 includeExpired=true로 다시 읽고, 시작 패킷의 기준일 안내", async () => {
    await openTab("메모");

    const card = (await screen.findByText("메모", { selector: "h2" })).closest("section") as HTMLElement;
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/notes?includeExpired=false", 0);
    await within(card).findByText("유가 급등");
    // 제목·본문 칸의 최소 폭 — 390px에서 다른 칸(줄바꿈 없음)에 눌려 제목이 한 글자씩 세로로 쌓이지 않게(jsdom에는 배치가 없어 칸 정의로 확인).
    expect(within(card).getByRole("columnheader", { name: "제목·본문" }).className).toContain("min-w-[12rem]");
    expect(rowsOf(card).map((cells) => [cells[0], cells[1], cells[3], cells[4]])).toEqual([
      ["#12", "시황유효 — 패킷에 실음", "2026-10-23", "2026-10-28"],
      ["#10", "방법론프레임 제안용", "2026-10-20", "만료 없음"],
    ]);
    expect(within(card).getByText(/기준일이 출발일\(2026-10-23\) 이하인 메모만 실립니다/)).toBeTruthy();
    expect(within(card).getByText(/메모의 숫자보다 패킷의 숫자가 우선합니다/)).toBeTruthy();

    fireEvent.click(within(card).getByLabelText("만료한 메모도 보기"));
    expect(await within(card).findByText("옛 메모")).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/notes?includeExpired=true", 0);
    expect(within(card).getAllByText("패킷 밖 — 만료·기준일 전").length).toBe(1);
  });

  it("쓰기 — 만료 기본 안내는 설정값, 빈 날짜는 보내지 않고 POST /api/paper/notes → 결과(서버가 채운 날짜) · 목록 다시 읽기", async () => {
    api.apiPost.mockResolvedValue({
      ok: true,
      note: { id: 13, kind: "MARKET", asOfDate: "2026-10-27", expiresOn: "2026-11-03", title: "환율", body: "USD/JPY 155", archived: false, active: true, createdAtKst: null },
    });
    await openTab("메모");

    const form = await screen.findByRole("form", { name: "메모 쓰기" });
    expect(await within(form).findByText("비우면 기본 +5거래일(기준일부터 — 설정 notesDefaultExpiryTradingDays)")).toBeTruthy();
    const save = within(form).getByRole("button", { name: "메모 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("제목"), { target: { value: "환율" } });
    fireEvent.change(within(form).getByLabelText("본문"), { target: { value: "USD/JPY 155" } });
    expect(within(form).getByText(/^11\/4,000자/)).toBeTruthy();
    const listReads = counts["/api/paper/notes?includeExpired=false"];
    fireEvent.click(save);

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/notes", { kind: "MARKET", title: "환율", body: "USD/JPY 155" });
    expect(await within(form).findByText(
      "시황 메모(#13)를 저장했습니다 — 기준일 2026-10-27 · 만료 2026-11-03. 유효한 동안 Claude 결정 패킷에 자료로 실립니다.",
    )).toBeTruthy();
    await waitFor(() => expect(counts["/api/paper/notes?includeExpired=false"]).toBeGreaterThan(listReads));
    // 성공하면 입력을 비웁니다.
    expect((within(form).getByLabelText("제목") as HTMLInputElement).value).toBe("");

    // 방법론 메모는 만료일 칸이 없습니다.
    fireEvent.change(within(form).getByLabelText("종류"), { target: { value: "INSIGHT" } });
    expect(within(form).queryByLabelText(/만료일/)).toBeNull();
    expect(within(form).getByText("방법론 메모는 만료가 없습니다.")).toBeTruthy();
  });

  it("F4 기준일 칸에 비우면 채워지는 날(referenceDate)을 적고, 서버가 그 거래일 패킷에 싣지 않는다고 하면(active:false) 저장 결과가 경고", async () => {
    serve("/api/paper/notes?includeExpired=false", () => ({ available: true, referenceDate: "2026-10-26", notes: NOTES }));
    api.apiPost.mockResolvedValue({
      ok: true,
      note: { id: 14, kind: "MARKET", asOfDate: "2026-10-27", expiresOn: "2026-10-30", title: "아침 시황", body: "b", archived: false, active: false, createdAtKst: null },
    });
    await openTab("메모");

    const form = await screen.findByRole("form", { name: "메모 쓰기" });
    const asOf = within(form).getByLabelText("기준일(선택)");
    const hint = await within(form).findByText(/^비우면 2026-10-26\(마지막으로 끝난 미국 세션 — Claude 결정이 보는 거래일\)/);
    expect(asOf.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.change(asOf, { target: { value: "2026-10-27" } });
    fireEvent.change(within(form).getByLabelText("제목"), { target: { value: "아침 시황" } });
    fireEvent.change(within(form).getByLabelText("본문"), { target: { value: "b" } });
    fireEvent.click(within(form).getByRole("button", { name: "메모 저장" }));

    const banner = await within(form).findByText(/2026-10-26 거래일의 Claude 결정 패킷에는 실리지 않습니다/);
    expect(banner.closest("div")?.className).toContain("text-warn");
  });

  it("보관 — 확인 뒤 DELETE /api/paper/notes/{id}, 목록 다시 읽기", async () => {
    api.apiDelete.mockResolvedValue({ ok: true });
    await openTab("메모");

    fireEvent.click(await screen.findByRole("button", { name: "보관 #12" }));
    expect(api.apiDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/이 메모\(#12 유가 급등\)를 보관할까요\? 지우지 않고/)).toBeTruthy();
    const listReads = counts["/api/paper/notes?includeExpired=false"];
    fireEvent.click(screen.getByRole("button", { name: "보관 확인" }));

    expect(api.apiDelete).toHaveBeenCalledWith("/api/paper/notes/12");
    await waitFor(() => expect(counts["/api/paper/notes?includeExpired=false"]).toBeGreaterThan(listReads));
    await waitFor(() => expect(screen.queryByRole("button", { name: "보관 확인" })).toBeNull());
  });
});

describe("개요 — 프레임 판 경계(F5)", () => {
  it("순자산 곡선에 경계선('프레임 v0')과 한 줄 — 순자산 기록이 없는 날의 경계는 글로만", async () => {
    serve("/api/paper/overview", () => ({
      ...OVERVIEW,
      navSeries: { dates: ["2026-10-23", "2026-10-26"], books: {} },
      frameworkBoundaries: [
        { tradingDate: "2026-10-23", version: 0, status: "INTERIM" },
        { tradingDate: "2026-10-27", version: 1, status: "USER" },
      ],
    }));
    render(<PaperPage />);

    const lines = await screen.findByRole("list", { name: "경계선" });
    expect(within(lines).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["2026-10-23 프레임 v0"]);
    expect(screen.getByText(
      "프레임 경계(Claude 계좌 결정이 그 판을 처음 쓴 거래일) — 2026-10-23부터 임시 v0 · 2026-10-27부터 v1(그날 순자산 기록 없음 — 선 없음)",
    )).toBeTruthy();
  });

  it("경계가 없으면(이 필드를 보내지 않는 백엔드도) 선도 글도 없다", async () => {
    serve("/api/paper/overview", () => ({ ...OVERVIEW, navSeries: { dates: ["2026-10-23"], books: {} } }));
    render(<PaperPage />);
    expect(await screen.findByText("순자산 곡선")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "경계선" })).toBeNull();
    expect(screen.queryByText(/프레임 경계/)).toBeNull();
  });
});
