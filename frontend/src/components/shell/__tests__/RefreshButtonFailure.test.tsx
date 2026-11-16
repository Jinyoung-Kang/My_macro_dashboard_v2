/**
 * 운영자 데이터 새로고침의 실패 안내(shell/RefreshButton + hooks/useRefreshSignal — 진짜 RefreshProvider로 그림, @/lib/api의 요청 둘만 바꿈).
 * Shell.test는 useRefreshSignal을 목으로 바꿔 쓰므로 훅이 만드는 글·실패 여부는 여기서 봅니다.
 *
 * QA-552: 넓은 화면 상단바의 안내는 단추 왼쪽 한 줄(160px, xl 288px 말줄임 — 전체 글은 title)인데, 실패 글이 사유부터 시작하고('백엔드 API(<주소>)에
 * 연결하지 못했습니다' — 훅이 오류 글을 그대로 넣음) 성공 글과 같은 회색(text-3)이었습니다. QA 스택 1024에서 막힌 POST 뒤 보이는 글은
 * '백엔드 API(http://127.0.0.1:...'뿐이라 실패를 뜻하는 낱말이 잘려 나갔고, 톤·아이콘으로도 실패가 구분되지 않았습니다(전체 글은 마우스 전용 title).
 * 같은 상단바의 로그아웃 실패(결과 낱말 먼저, 경고 톤 + 아이콘)와 같은 꼴로 둡니다: 훅이 실패 여부(failed)를 내보내고, 요청 실패와 200이라도 수집을
 * 시작하지 못한 응답(store_only가 아니고 triggered=false — 백엔드 '수집기에 연결하지 못했습니다…') 모두 '새로고침 실패 — 사유'(검토 뒤 짧은 결과 낱말로)
 * 입니다. 성공 글은 지금 그대로(회색 말줄임)입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), apiGet: api.apiGet, apiPost: api.apiPost }));

import { NetworkError } from "@/lib/api";
import { RefreshProvider } from "@/hooks/useRefreshSignal";
import { RefreshButton } from "../RefreshButton";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true };
const NETWORK_REASON = "백엔드 API(http://127.0.0.1:18082)에 연결하지 못했습니다";
const COLLECTOR_DOWN = "수집기에 연결하지 못했습니다. 저장본을 그대로 표시합니다.";

function renderRefresh(variant: "icon" | "block" = "icon") {
  render(
    <RefreshProvider>
      <RefreshButton user={OWNER} variant={variant} />
    </RefreshProvider>,
  );
  return { button: screen.getByRole("button", { name: "데이터 수동 새로고침" }), status: screen.getByRole("status") };
}

/** 경고 꼴(공용 StatusText tone=warn) — 경고 글색·아이콘·sr-only 머리말 '주의: '. */
function expectWarn(status: HTMLElement) {
  expect(status.querySelector(".text-warn")).not.toBeNull();
  expect(status.querySelector("svg")).not.toBeNull();
  expect([...status.querySelectorAll(".sr-only")].map((node) => node.textContent)).toContain("주의: ");
}

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiPost.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("새로고침 실패 안내 — 결과 낱말 먼저, 경고 톤 + 아이콘 (QA-552)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 글이 '백엔드 API(http://127.0.0.1:18082)에 연결하지 못했습니다'로 시작했고(160px에서 실패 낱말이 잘림),
  // 안내 p가 'max-w-40 truncate text-xs leading-5 text-text-3 xl:max-w-72' — 경고 글색·아이콘·'주의: '가 없었습니다.
  it("백엔드에 닿지 못하면(NetworkError) '새로고침 실패 — 사유'를 경고 톤과 아이콘으로, 전체 글은 title", async () => {
    api.apiPost.mockRejectedValue(new NetworkError(NETWORK_REASON));
    const { button, status } = renderRefresh();
    fireEvent.click(button);
    const full = `새로고침 실패 — ${NETWORK_REASON}`;
    await waitFor(() => expect(status.getAttribute("title")).toBe(full));
    expect(status.querySelector(".truncate")?.textContent).toBe(full);
    expectWarn(status);
    // 폭(160px, xl 288px)은 그대로 — 말줄임은 안쪽 글에
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-40", "xl:max-w-72", "min-w-0"]));
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 수집기에 닿지 못한 200 응답도 성공 글과 같은 회색(text-text-3)이었습니다.
  it("200이라도 수집을 시작하지 못한 응답(auto 모드 triggered=false — 수집기에 닿지 못함)은 실패 — 서버 글에 결과 낱말 머리말을 붙여 경고 톤", async () => {
    api.apiPost.mockResolvedValue({ readMode: "auto", triggered: false, message: COLLECTOR_DOWN });
    const { button, status } = renderRefresh();
    fireEvent.click(button);
    await waitFor(() => expect(status.getAttribute("title")).toBe(`새로고침 실패 — ${COLLECTOR_DOWN}`));
    expectWarn(status);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 더보기(좁은 화면)의 안내도 실패·성공이 같은 회색 글이었습니다.
  it("더보기의 폭 전체 단추(block) 아래 안내도 실패면 경고 톤 + 아이콘 — 줄바꿈이라 말줄임은 없다", async () => {
    api.apiPost.mockRejectedValue(new NetworkError(NETWORK_REASON));
    const { button, status } = renderRefresh("block");
    fireEvent.click(button);
    await waitFor(() => expect(status.textContent).toContain(`새로고침 실패 — ${NETWORK_REASON}`));
    expectWarn(status);
    expect(status.querySelector(".truncate")).toBeNull();
  });

  it("성공 응답(store_only 다시 읽기·수집 끝남)은 지금 그대로 — 경고 톤·아이콘 없이 회색 한 줄", async () => {
    api.apiPost.mockResolvedValue({ readMode: "store_only", triggered: false, message: "store_only 모드입니다. 저장본만 다시 읽었습니다 (수집은 수집기가 담당합니다)." });
    const first = renderRefresh();
    fireEvent.click(first.button);
    await waitFor(() => expect(first.status.textContent).toMatch(/^store_only 모드입니다/));
    expect(first.status.querySelector("svg")).toBeNull();
    expect(first.status.querySelector(".text-warn")).toBeNull();
    expect(first.status.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "text-text-3", "max-w-40"]));
    cleanup();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.apiPost.mockResolvedValue({ readMode: "auto", triggered: true, baselineRunId: 1, message: "수집기에 fast 작업을 요청했습니다. 끝나면 화면이 자동으로 갱신됩니다." });
    api.apiGet.mockResolvedValue({ lastRun: { id: 2, finishedAt: "2026-11-16T04:00:00Z" } });
    const second = renderRefresh();
    fireEvent.click(second.button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await waitFor(() => expect(second.status.textContent).toBe("수집이 끝나 화면을 갱신했습니다."));
    expect(second.status.querySelector("svg")).toBeNull();
    expect(second.status.querySelector(".text-warn")).toBeNull();
  });

  // QA-552 후속(검토): 결과 낱말 '새로고침하지 못했습니다'가 길어(12px 글 11자 — 약 130px), 같은 배치의 QA-547로 안내가 먼저 줄면 보이는 글이
  // '새로고침하…'(1024 99.7px)·'새로고…'(1280 74.4px)뿐이었고(tip 8b7524ab 정적 하네스), 수집기에 닿지 못한 200 응답(triggered=false)은 머리말 없이
  // 서버 글로 시작해('수집기에 연…'·'수집기…') 결과 낱말이 문장 끝에 있었습니다. 두 갈래 모두 짧은 결과 낱말 '새로고침 실패'를 앞에 둡니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 title이 '새로고침하지 못했습니다 — 백엔드 API(…)에 연결하지 못했습니다'와
  // '수집기에 연결하지 못했습니다. 저장본을 그대로 표시합니다.'(머리말 없음)였습니다.
  it("두 실패 갈래 모두 짧은 결과 낱말이 먼저 — 요청 실패도, 수집기에 닿지 못한 200 응답도 '새로고침 실패 — 사유' (QA-552)", async () => {
    api.apiPost.mockRejectedValue(new NetworkError(NETWORK_REASON));
    const first = renderRefresh();
    fireEvent.click(first.button);
    await waitFor(() => expect(first.status.getAttribute("title")).toBe(`새로고침 실패 — ${NETWORK_REASON}`));
    cleanup();

    api.apiPost.mockResolvedValue({ readMode: "auto", triggered: false, message: COLLECTOR_DOWN });
    const second = renderRefresh();
    fireEvent.click(second.button);
    await waitFor(() => expect(second.status.getAttribute("title")).toBe(`새로고침 실패 — ${COLLECTOR_DOWN}`));
  });
});
