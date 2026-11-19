/**
 * 상태색(정상·주의·위험)은 글 색만으로 뜻을 나르지 않고 아이콘과 함께 그린다(명세 §3-2, ADR 0042 결정 3 — W4).
 * 위험색 #e76a6e는 상승 빨강 #ff6b6b와 ΔE 4.4, 주의색은 ΔE 13.0이라 색만으로는 '상승'과 헷갈리고, 고대비(forced-colors)에서는 색이 지워집니다.
 *
 *  - 국면(/regime) 판정 근거: 속성 줄의 상태 글(정상·완화적·축소…)에 정상·주의 아이콘, 주의 줄은 읽어 주는 '주의:' 머리말
 *    (P5a — 지표 칸(Metric) 넷이 속성 목록(PropertyList) 줄 넷으로 바뀜. 아이콘 자리·'주의:'·값 톤은 같음)
 *  - 상태(/status) 수집 오류·경고 로그: '현재 오류'·'현재 경고' 수가 0보다 크면 위험·주의 아이콘 + 글(읽어 주는 머리말 없이), 0이면 아이콘 없음
 *  - 상태(/status) '최근 수집 상태'가 중단이면 주의 아이콘과 '주의:' + 까닭 글
 *    (P7 — 지표 칸(Metric)이 KPI 띠(KpiStrip) 타일로 바뀜. 값은 본문 잉크 숫자이고 아이콘·톤 색은 타일 아래 상태 줄로 — 아이콘 + 글·머리말 규칙은 같음)
 *
 * 홈 저장소 상태 줄은 HomeScreen.test.tsx가 봅니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { regimeExpansion } from "@/lib/__tests__/homeFixtures";
import { endpoints } from "@/lib/endpoints";
import type { StatusIssuesResponse } from "@/lib/types";
import RegimePage from "../regime/page";
import StatusPage from "../status/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});

afterEach(() => cleanup());

async function cardTitled(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name })).closest("section") as HTMLElement;
}

/** KPI 띠의 타일 하나 — 이름 있는 묶음(role=group, 이름 = 타일 이름). */
function tileOf(card: HTMLElement, label: string): HTMLElement {
  return within(card).getByRole("group", { name: label });
}

/** 속성 목록 한 줄 — 이름(dt) 옆 값 칸(dd)의 두 줄: 값 줄(값·배지)과 보조 글 줄(상태 글 + 해석). */
function propertyOf(card: HTMLElement, label: string): { cell: HTMLElement; valueRow: HTMLElement; captionRow: HTMLElement } {
  const cell = within(card).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
  const [valueRow, captionRow] = Array.from(cell.children) as HTMLElement[];
  return { cell, valueRow, captionRow };
}

describe("국면 판정 근거 — 지표 칸의 정상·주의는 아이콘과 함께(QA-505)", () => {
  // 수정 전에는 값만 정상(text-ok)·주의(text-warn) 색으로 칠하고 캡션은 회색 글이라, 건강·주의 판정이 색으로만 전해졌습니다
  // ('축소'는 주의라는 말이 아님). 캡션 글은 회색 그대로 두고 아이콘만 톤 색으로 붙입니다.
  // P5a: 판정 근거가 속성 목록이 되어 '캡션 줄'은 값 아래 보조 글 줄(상태 글 + 해석)입니다 — 아이콘 자리·'주의:'·값 톤은 같습니다.
  it("QA-505: 네 칸 모두 캡션에 아이콘, 주의 칸만 읽어 주는 '주의:' — 값의 톤 색은 그대로", async () => {
    const response = regimeExpansion();
    const signals = response.verdict?.signals ?? [];
    signals[3] = { ...signals[3], value: -0.05, state: "축소", reading: "최근 4주 동안 시장에서 유동성이 빠졌습니다.", healthy: false };
    reads[endpoints.insight.regime("5")] = response;

    render(<RegimePage />);
    const card = await cardTitled("판정 근거");
    await within(card).findByText(signals[0].label, { selector: "dt" });
    expect(signals).toHaveLength(4);
    for (const item of signals) {
      // 속성 한 줄의 값 칸: 값 줄(값·단위) · 보조 글 줄(상태 글 + 해석).
      const { cell, valueRow, captionRow } = propertyOf(card, item.label);
      const tone = item.healthy ? "text-ok" : "text-warn";
      const caption = within(cell).getByText(item.state);
      expect(captionRow.contains(caption), `${item.label} 캡션 줄`).toBe(true);
      // 캡션 글 자체는 보조 글 색(text-3) 그대로입니다.
      expect(caption.closest(".text-text-3"), `${item.label} 캡션 글 색`).not.toBeNull();
      const icons = Array.from(cell.querySelectorAll("svg"));
      expect(icons.map((icon) => icon.getAttribute("aria-hidden")), `${item.label} 아이콘`).toEqual(["true"]);
      // 아이콘은 값이 아니라 캡션 줄에, 톤 색으로 섭니다.
      expect(captionRow.contains(icons[0]), `${item.label} 아이콘이 캡션 줄`).toBe(true);
      expect(icons[0].closest(`.${tone}`), `${item.label} 아이콘 톤`).not.toBeNull();
      // 글 줄 안의 상태 글(inline-flex)은 위에 맞춰 캡션 줄이 기준선 때문에 높아지지 않습니다(QA 스택 실측 16px → 18px을 막음).
      expect(icons[0].closest(".inline-flex")?.className, `${item.label} 상태 글 세로 맞춤`).toContain("align-top");
      expect(within(cell).queryByText("주의:") !== null, `${item.label} '주의:' 머리말`).toBe(!item.healthy);
      // 값의 톤 색은 그대로입니다(값 글을 감싼 칸).
      expect(valueRow.querySelector(`.${tone}`), `${item.label} 값 색`).not.toBeNull();
    }
  });
});

function issuesResponse(errors: number, warnings: number): StatusIssuesResponse {
  return {
    generatedAt: "2026-10-26 16:54 KST", collectorReachable: true, lookbackHours: 24, lastRunStatus: "ok",
    counts: { errors, warnings, recentGroups: 1, missingDatasets: 0 },
    current: [], recent: [], missing: [], text: "요약: 합성 기록",
  };
}

describe("상태 화면 수집 오류·경고 로그 — 현재 오류·경고 수는 아이콘과 함께(QA-505)", () => {
  // 수정 전에는 '현재 오류 3건'을 위험색, '현재 경고 19건'을 주의색 글로만 그렸습니다(홈 저장소 상태 줄과 쌍둥이).
  // 이름에 이미 '오류'·'경고'가 있어 읽어 주는 머리말은 더하지 않습니다. 0건은 상태가 아니라 아이콘이 없습니다.
  // P7: 타일 값은 본문 잉크 숫자, 아이콘은 타일 아래 상태 줄(톤 색 아이콘 + 글)에 섭니다.
  it("QA-505: 수가 0보다 크면 위험·주의 아이콘 + 글(톤 색, 머리말 없음), 0이면 아이콘 없음", async () => {
    reads["/api/status"] = { readMode: "auto", collectorReachable: true };
    reads[endpoints.status.issues] = issuesResponse(3, 19);
    const { unmount } = render(<StatusPage />);
    let card = await cardTitled("수집 오류·경고 로그");
    // 값이 온 KPI 띠('오류·경고')를 기다립니다 — 읽는 중 띠('오류·경고 불러오는 중', QA-876)에도 같은 타일 이름이 있어 이름만 기다리면 응답 전에
    // 넘어갈 수 있습니다(QA-883 — 부하 아래 전체 실행에서 '현재 오류현재 오류 불러오는 중'으로 흔들림).
    await within(card).findByRole("region", { name: "오류·경고" });
    for (const [label, value, tone, text] of [
      ["현재 오류", "3건", "text-danger", "지금 실패 중인 태스크"],
      ["현재 경고", "19건", "text-warn", "지금 경고인 태스크"],
    ] as const) {
      const tile = tileOf(card, label);
      // 이름 + 값 + 상태 글 — 읽어 주는 머리말('오류:'·'주의:')은 더하지 않습니다.
      expect(tile.textContent).toBe(`${label}${value}${text}`);
      const status = within(tile).getByText(text).closest(`.${tone}`);
      expect(status, `${label} 상태 줄의 톤 색`).not.toBeNull();
      const icons = Array.from(tile.querySelectorAll("svg"));
      expect(icons.map((icon) => icon.getAttribute("aria-hidden")), `${label} 아이콘`).toEqual(["true"]);
      expect(status?.contains(icons[0]), `${label} 아이콘이 상태 글 옆`).toBe(true);
    }
    unmount();

    reads[endpoints.status.issues] = issuesResponse(0, 0);
    render(<StatusPage />);
    card = await cardTitled("수집 오류·경고 로그");
    await within(card).findByRole("region", { name: "오류·경고" });
    for (const label of ["현재 오류", "현재 경고"]) {
      const tile = tileOf(card, label);
      expect(tile.textContent).toBe(`${label}0건`);
      expect(tile.querySelectorAll("svg"), `${label} 0건 아이콘`).toHaveLength(0);
    }
  });
});

describe("상태 화면 최근 수집 상태 — 중단은 주의 아이콘 + 글", () => {
  // P7: 값은 판정 라벨('비정상 종료'), 까닭은 타일 아래 상태 줄(주의 아이콘 + '주의:' + 글).
  it("중단이면 주의 아이콘 하나·읽어 주는 '주의:'와 까닭 글", async () => {
    reads["/api/status"] = { readMode: "auto", collectorReachable: true, lastRunStatus: "interrupted" };
    render(<StatusPage />);
    const tile = await screen.findByRole("group", { name: "최근 수집 상태" });
    expect(within(tile).getByText(/^비정상 종료/)).toBeTruthy();
    const icons = Array.from(tile.querySelectorAll("svg"));
    expect(icons.map((icon) => icon.getAttribute("aria-hidden"))).toEqual(["true"]);
    expect(icons[0].closest(".text-warn"), "아이콘 톤").not.toBeNull();
    expect(within(tile).getByText("주의:")).toBeTruthy();
    expect(within(tile).getByText("프로세스가 사라졌거나 신호가 끊겼습니다")).toBeTruthy();
  });
});
