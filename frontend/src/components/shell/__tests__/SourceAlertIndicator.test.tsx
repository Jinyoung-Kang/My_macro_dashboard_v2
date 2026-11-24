/**
 * 수집 출처 끊김 안내(ADR 0035 결정 7) — 운영자에게만, 끊긴 출처가 있을 때만, 닫으면 그 사건은 이 브라우저에서 다시 보이지 않고 새 사건은 다시 뜬다.
 * 2026-11-24부터(QA-994, 사용자 결정 D-4) 본문 맨 위의 띠가 아니라 상단바 안의 경고 표시(아이콘·건수)이고, 누르면 같은 문구·'출처 상태 보기'·닫기가 펼쳐진다.
 * 홈('/')에서는 그리지 않고 경로도 부르지 않는다(QA-613).
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

import { SourceAlertIndicator } from "../SourceAlertIndicator";

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

/** 홈 밖 화면(/macro)의 상단바 자리. */
const OnMacro = ({ user }: { user?: SessionUser }) => <SourceAlertIndicator pathname="/macro" user={user} />;
const indicator = () => screen.queryByTestId("source-alert");
/** 경고 표시를 눌러 안내를 펼칩니다. */
async function openPanel(count = 1) {
  fireEvent.click(await screen.findByRole("button", { name: `수집 끊김 ${count}건 — 안내 펼치기` }));
  return screen.getByRole("region", { name: "수집 끊김 안내" });
}

describe("수집 끊김 안내(상단바 경고 표시)", () => {
  it("회원에게는 경고 표시가 없고 경로를 부르지 않는다", () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    render(<OnMacro user={MEMBER} />);

    expect(indicator()).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });

  it("운영자에게 건수를 보이고, 누르면 끊긴 출처를 적고 출처 상태로 잇는다 — 접혀 있을 때는 문구가 없다", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street"), incident("info_naver_flows", "네이버 투자자별 매매동향·매매상위")]);
    render(<OnMacro user={OWNER} />);

    const toggle = await screen.findByRole("button", { name: "수집 끊김 2건 — 안내 펼치기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("2");
    expect(screen.queryByText(/수집 출처 2곳이 끊겼습니다/)).toBeNull();

    const panel = await openPanel(2);
    expect(screen.getByRole("button", { name: "수집 끊김 2건 — 안내 접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toMatch(/수집 출처 2곳이 끊겼습니다: Wolf Street/);
    expect(panel.textContent).toContain("그 출처만 멈추고 직전 저장본을 유지합니다.");
    expect(screen.getByRole("link", { name: "출처 상태 보기" }).getAttribute("href")).toBe("/info/status");
  });

  it("끊긴 출처가 없으면 경고 표시가 없다", async () => {
    respond([]);
    render(<OnMacro user={OWNER} />);
    await vi.waitFor(() => expect(api.apiGetShared).toHaveBeenCalled());

    expect(indicator()).toBeNull();
  });

  it("홈('/')에서는 운영자에게 끊긴 출처가 있어도 그리지 않고 경로도 부르지 않는다(QA-613)", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    render(<SourceAlertIndicator pathname="/" user={OWNER} />);
    await Promise.resolve();

    expect(indicator()).toBeNull();
    expect(api.apiGetShared).not.toHaveBeenCalled();
  });

  it("Escape는 펼친 안내를 접고 포커스를 단추로 돌려준다 — 바깥을 누르면 접힌다", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    render(<OnMacro user={OWNER} />);
    await openPanel();

    fireEvent.keyDown(document, { key: "Escape" });
    const toggle = screen.getByRole("button", { name: "수집 끊김 1건 — 안내 펼치기" });
    expect(screen.queryByRole("region", { name: "수집 끊김 안내" })).toBeNull();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(screen.getByRole("region", { name: "수집 끊김 안내" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "수집 끊김 안내" })).toBeNull();
  });

  it("닫으면 그 사건은 다시 보이지 않고, 새 사건이 생기면 다시 뜬다", async () => {
    respond([incident("info_blog_wolfstreet", "Wolf Street")]);
    const first = render(<OnMacro user={OWNER} />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "수집 끊김 안내 닫기" }));
    expect(indicator()).toBeNull();
    first.unmount();

    render(<OnMacro user={OWNER} />);
    await vi.waitFor(() => expect(api.apiGetShared).toHaveBeenCalledTimes(2));
    expect(indicator()).toBeNull();
    cleanup();

    respond([incident("info_blog_wolfstreet", "Wolf Street"), incident("info_naver_flows", "네이버 투자자별 매매동향·매매상위")]);
    render(<OnMacro user={OWNER} />);
    expect((await openPanel(1)).textContent).toMatch(/수집 출처 1곳이 끊겼습니다: 네이버/);
  });

  // 닫은 기록의 키가 '태스크|종류'뿐이라, 회복했다가 같은 종류로 다시 끊기면 키가 같아 띠가 뜨지 않았습니다(QA-408).
  // 서버가 사건마다 회차(episode — 그 출처의 마지막 성공 시각)를 주고 화면은 그것까지 붙여 닫습니다.
  it("QA-408: 닫은 출처가 회복했다가 같은 종류로 다시 끊기면(회차가 바뀜) 경고가 다시 뜬다", async () => {
    respond([{ ...incident("info_blog_wolfstreet", "Wolf Street"), episode: "2026-11-10T01:00:00Z" }]);
    const first = render(<OnMacro user={OWNER} />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "수집 끊김 안내 닫기" }));
    expect(indicator()).toBeNull();
    first.unmount();

    // 같은 사건이 이어지는 동안(회차 그대로)은 닫힌 채입니다.
    const second = render(<OnMacro user={OWNER} />);
    await vi.waitFor(() => expect(api.apiGetShared).toHaveBeenCalledTimes(2));
    expect(indicator()).toBeNull();
    second.unmount();

    // 회복(마지막 성공 시각이 바뀜) 뒤 같은 출처·같은 종류로 다시 끊김.
    respond([{ ...incident("info_blog_wolfstreet", "Wolf Street"), episode: "2026-11-11T09:00:00Z" }]);
    render(<OnMacro user={OWNER} />);
    expect((await openPanel()).textContent).toMatch(/수집 출처 1곳이 끊겼습니다: Wolf Street/);
  });
});
