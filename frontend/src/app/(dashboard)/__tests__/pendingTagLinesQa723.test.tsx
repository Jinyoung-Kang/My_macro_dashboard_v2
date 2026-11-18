/**
 * 13F 포트폴리오(/institutions)·교집합(/consensus) 왼쪽 칸의 기관 목록을 처음 읽는 동안의 자리(공용 거르기 목록 `pending`) — 좁은 화면 태그 자료 점검(QA-723).
 *
 * 규약(교집합 배열 — 252e9227, 태그 줄 수 칸은 a959cb52): 좁은 화면 태그 폭은 390의 목록 칸(패널 356px − 안쪽 여백 12px씩 = 332px) 안에서 그려지는 폭이고, 칸 폭에 잘린 태그(332)는
 * 이름이 두 줄로 꺾여 58px이므로 태그 줄 수(tagLines)를 2 이상으로 적습니다. 13F 배열은 APG 태그를 잘리기 전 한 줄 폭(336)으로만 적어, 자리는 332×44px로
 * 그려지고 실제 태그는 332×58px라 390에서 목록이 616 → 630px로 자라며 아래를 14px 밀었습니다(P5b QA 스택 확인).
 * jsdom은 배치를 계산하지 않으므로 그린 자리 줄의 폭(style width)과 줄 수(막대 수)를 이 규약과 견줍니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  LineChart: () => null,
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
  HorizontalBars: () => null,
}));

import ConsensusPage from "../consensus/page";
import InstitutionsPage from "../institutions/page";

/** 390의 목록 칸 폭(px) — 이보다 넓은 태그는 칸에서 잘리고 이름이 두 줄로 꺾입니다. */
const NARROW_COLUMN = 332;

beforeEach(() => {
  api.apiGetShared.mockReset();
  // 모든 읽기를 끝나지 않게 둡니다 — 처음 읽는 동안의 자리만 봅니다.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

/** 처음 읽는 동안의 자리에서 좁은 화면 태그 줄(첫 목록)마다 그린 폭과 줄 수. */
async function pendingTags(label: string) {
  const status = await screen.findByRole("status", { name: label });
  const tags = status.querySelector("ul");
  return [...(tags?.children ?? [])].map((li) => ({
    width: Number.parseFloat((li as HTMLElement).style.width),
    lines: li.firstElementChild?.children.length ?? 0,
  }));
}

/** 규약을 어긴 줄 — 칸보다 넓은 폭, 또는 잘린 폭(332)인데 한 줄. */
function violations(rows: readonly { width: number; lines: number }[]) {
  return rows.flatMap(({ width, lines }, index) => {
    if (width > NARROW_COLUMN) return [`${index + 1}번째 줄 폭 ${width}px > 칸 ${NARROW_COLUMN}px`];
    if (width === NARROW_COLUMN && lines < 2) return [`${index + 1}번째 줄 잘린 폭 ${NARROW_COLUMN}px인데 ${lines}줄`];
    return [];
  });
}

describe("기관 목록 자리의 좁은 화면 태그는 390 칸 폭 안의 폭과 실제 줄 수로 적는다(QA-723)", () => {
  // 수정 전 실패(plain it): ['4번째 줄 폭 336px > 칸 332px'] — APG 태그를 잘리기 전 한 줄 폭으로 적고 줄 수(tagLines)를 적지 않음.
  it("13F 포트폴리오 — 자리 줄 12개, 칸보다 넓은 폭이 없고 잘린 폭인 줄은 두 줄 이상", async () => {
    render(<InstitutionsPage />);
    const rows = await pendingTags("기관 목록을 불러오는 중");
    expect(rows).toHaveLength(12);
    expect(violations(rows)).toEqual([]);
  });

  it("교집합 — 자리 줄 12개, 칸보다 넓은 폭이 없고 잘린 폭인 줄은 두 줄 이상", async () => {
    render(<ConsensusPage />);
    const rows = await pendingTags("기관 목록 불러오는 중");
    expect(rows).toHaveLength(12);
    expect(violations(rows)).toEqual([]);
  });
});
