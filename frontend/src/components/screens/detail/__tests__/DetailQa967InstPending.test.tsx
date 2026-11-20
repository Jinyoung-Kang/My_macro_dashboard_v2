/**
 * QA-967(작업대 P8 후속 — `institution-header-placeholder-lines`): 기관 상세(/institutions/<CIK>)의 대상 머리가 13F 응답 뒤에 자라 첫 적재 이동(CLS)이
 * 났습니다 — 기준 빌드(40a8b4cf, QA API GET) 1024 0.1082·1440 0.0681(0001608046), 390 지연 300ms 0.1157.
 *  - 읽는 중 자리표시(막대 두 줄 44px)가 값이 온 뒤의 주 값 줄(36px) + 배지 줄(보고 기준일·공시일·출처 — 16px, 좁으면 꺾임)보다 낮음 — 1440 아래 칸 틀 +12px
 *  - 동작 칸의 수집 배지(Freshness)가 응답 뒤에야 생겨 넓은 화면에서 동작 칸이 넓어지고 왼쪽 이름 줄이 좁아짐
 *  - 개요 탭 분기별 평가액 자리(공용 Skeleton 220px + 여백 8px)가 히어로 차트(좁은 화면 200·lg 260px)와 달라 lg에서 아래 AI 요약이 32px 밀림
 * 자리표시는 값이 온 뒤와 같은 글꼴·꼴의 보이지 않는 글로 두 줄 높이를 잡고, 동작 칸에는 수집 배지 폭의 보이지 않는 자리(Freshness pending — QA-892)를,
 * 차트 자리는 히어로 차트와 같은 높이 클래스를 둡니다.
 * 기관 이름(응답에만 있음)의 길이로 이름 줄이 꺾이는 몫은 미리 알 수 없어 남습니다. 응답은 모두 합성 값입니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "1234567";

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

async function header(): Promise<HTMLElement> {
  render(
    <SessionUserProvider user={MEMBER}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
  return (await screen.findByRole("heading", { level: 1, name: `CIK ${CIK}` })).closest("header") as HTMLElement;
}

describe("QA-967 기관 상세 대상 머리의 읽는 중 자리표시는 값이 온 뒤의 꼴", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 막대 두 줄(공용 Skeleton)뿐이라 보이지 않는 글이 없었습니다.
  it.fails("주 값 줄(12px 캡션 + 28px 값)과 배지 줄(보고 기준일·공시일 + 출처) 꼴의 보이지 않는 글 — 읽기에서는 상태 이름만", async () => {
    const head = await header();
    const status = within(head).getByRole("status", { name: "13F 포트폴리오를 불러오는 중" });
    const rows = Array.from(status.children).filter((child) => child.getAttribute("aria-hidden") === "true");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".invisible .text-value-lg")?.textContent).toMatch(/달러$/);
    expect(rows[0].querySelector(".invisible")?.textContent).toContain("13F 보고 평가액");
    expect(rows[1].querySelector(".invisible")?.textContent).toMatch(/^보고 기준일 \d{4}-\d{2}-\d{2} · 공시일 \d{4}-\d{2}-\d{2}/);
    expect(rows[1].querySelector(".invisible")?.textContent).toContain("SEC EDGAR 13F");
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 응답 전 동작 칸에 수집 배지 자리가 없었습니다.
  it.fails("응답 전 동작 칸에 수집 배지 폭의 보이지 않는 자리(읽기에서 빠짐)", async () => {
    const head = await header();
    const reserve = Array.from(head.querySelectorAll<HTMLElement>('[aria-hidden="true"].invisible')).find((element) => element.textContent?.includes("수집"));
    expect(reserve).toBeTruthy();
    expect(reserve?.textContent).toMatch(/수집\s*0000-00-00 00:00/);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 공용 Skeleton(style 높이 220px — 폭과 상관없음)이었습니다.
  it.fails("분기별 평가액 자리는 히어로 차트와 같은 높이(좁은 화면 200·lg 260px — LineChart hero)", async () => {
    await header();
    const slot = screen.getByRole("status", { name: "분기별 평가액을 불러오는 중" });
    const block = slot.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(block.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-[200px]", "lg:h-[260px]"]));
    expect(block.style.height).toBe("");
  });
});
