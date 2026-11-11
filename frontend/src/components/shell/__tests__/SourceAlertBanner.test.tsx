/**
 * 수집 출처 끊김 안내 띠(ADR 0035 결정 7) — 운영자에게만, 끊긴 출처가 있을 때만, 닫으면 그 사건은 이 브라우저에서 다시 보이지 않고 새 사건은 다시 뜬다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { SourceAlertBanner } from "../SourceAlertBanner";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const PATH = "/api/info/sources";

const incident = (task: string, label: string) => ({
  key: `${task}|blocked`, task, label, kind: "blocked", kindLabel: "차단됨 — 그 출처만 잠시 멈춤", reason: "HTTP 403", since: null,
});

function respond(incidents: unknown[]) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === PATH ? Promise.resolve({ checkedAt: "x", available: true, sources: [], incidents }) : new Promise(() => {}));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("수집 끊김 안내 띠", () => {
  it("회원에게는 띠가 없고 경로를 부르지 않는다", () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    render(<SourceAlertBanner user={MEMBER} />);

    expect(screen.queryByTestId("source-alert-banner")).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });

  it("운영자에게 끊긴 출처를 보이고 출처 상태로 잇는다", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    render(<SourceAlertBanner user={OWNER} />);

    expect(await screen.findByText(/수집 출처 1곳이 끊겼습니다: Wolf Street/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "출처 상태 보기" }).getAttribute("href")).toBe("/info/status");
  });

  it("끊긴 출처가 없으면 띠가 없다", async () => {
    respond([]);
    render(<SourceAlertBanner user={OWNER} />);
    await vi.waitFor(() => expect(api.apiGetShared).toHaveBeenCalled());

    expect(screen.queryByTestId("source-alert-banner")).toBeNull();
  });

  it("닫으면 그 사건은 다시 보이지 않고, 새 사건이 생기면 다시 뜬다", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    const first = render(<SourceAlertBanner user={OWNER} />);
    fireEvent.click(await screen.findByRole("button", { name: "수집 끊김 안내 닫기" }));
    expect(screen.queryByTestId("source-alert-banner")).toBeNull();
    first.unmount();

    render(<SourceAlertBanner user={OWNER} />);
    await vi.waitFor(() => expect(api.apiGetShared).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("source-alert-banner")).toBeNull();
    cleanup();

    respond([incident("info_blog_wolfstreet", "Wolf Street"), incident("info_naver_flows", "네이버 투자자별 매매동향·매매상위")]);
    render(<SourceAlertBanner user={OWNER} />);
    expect(await screen.findByText(/수집 출처 1곳이 끊겼습니다: 네이버/)).toBeTruthy();
  });
});
