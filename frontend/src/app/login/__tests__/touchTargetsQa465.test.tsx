/**
 * 인증 화면(로그인·재설정 — 재설정·가입·인증·처리방침은 같은 카드 틀 AuthCard)의 좁은 화면(lg 미만) 누르는 자리 44px(원칙 A8,
 * 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-7) — QA-465.
 *
 * 카드 아래의 따로 선 글 링크(AuthCard 기본 바닥줄 '← 로그인', 로그인 화면의 '가입하기'·'비밀번호를 잊었나요?')가 글 높이 그대로(390px에서
 * 19.5px)라 44px에 못 미쳤습니다. QA-458의 화면 DOM 감사(app/(dashboard)/__tests__/touchTargetsQa458.test.tsx)는 대시보드 화면만 그려 인증 화면을
 * 보지 않았습니다. 같은 검사기(lib/__tests__/touchTargetAudit — 클래스로 lg 미만 44px을 따짐, 문장 안 링크는 WCAG 2.5.8 글 안 예외)로 봅니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  auth: { session: vi.fn(), login: vi.fn(), requestReset: vi.fn(), confirmReset: vi.fn() },
}));
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import ResetPage from "../../reset/page";
import LoginPage from "../page";

beforeEach(() => {
  api.auth.session.mockReset();
  router.replace.mockReset();
});

afterEach(() => cleanup());

describe("인증 화면의 좁은 화면 누르는 자리(QA-465)", () => {
  it.fails("로그인 화면 — 카드 아래 '가입하기'·'비밀번호를 잊었나요?'까지 모든 누름 자리가 lg 미만 44px", async () => {
    api.auth.session.mockResolvedValue({ authenticated: false, mailAvailable: true });
    const { container } = render(<LoginPage />);
    expect(await screen.findByRole("link", { name: "가입하기" })).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
  });

  it.fails("카드 틀(AuthCard)의 기본 바닥줄 '← 로그인'도 lg 미만 44px — 재설정 화면", () => {
    const { container } = render(<ResetPage />);
    expect(screen.getByRole("link", { name: "← 로그인" })).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
  });
});
