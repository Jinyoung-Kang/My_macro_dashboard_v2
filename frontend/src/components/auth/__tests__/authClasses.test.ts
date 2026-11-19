/**
 * 인증 화면 클래스(components/auth/classes.ts) — 작업대 화면 언어 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §7 8행('auth/classes.ts 겉모양만,
 * /privacy 서버 컴포넌트 제약 유지').
 *
 * - 순수 모듈: React·"use client" 없이 문자열만 내보냅니다 — 서버 컴포넌트(/privacy, 루트 not-found)와 클라이언트 화면이 함께 가져옵니다.
 * - 서버 컴포넌트: /privacy 화면과 카드 틀(AuthCard.tsx)은 "use client"가 없습니다(카드 틀은 서버 컴포넌트가 가져옴).
 * - 카드 꼴: 인증 카드와 대시보드 레이아웃의 안내 카드(AUTH_NOTICE_CARD)는 같은 4px 모서리·안쪽 24px(모든 폭 — sm:p-8 없음).
 * - 결과 상자(AUTH_MESSAGE)는 4px·13px, 동의 체크(AUTH_CHECK)는 lg 미만 44px(touchTargetAudit).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as authClasses from "@/components/auth/classes";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";

const SRC = resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(resolve(SRC, file), "utf8");
/** 파일 첫 문(주석·빈 줄 뒤)이 "use client" 지시문인가. */
const isClient = (source: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(source);

describe("인증 화면 클래스", () => {
  it("순수 모듈 — 문자열·문자열 표만 내보내고 React·\"use client\"가 없다", () => {
    const source = read("components/auth/classes.ts");
    expect(isClient(source)).toBe(false);
    expect(source).not.toMatch(/from ["']react["']/);
    for (const [name, value] of Object.entries(authClasses)) {
      const strings = typeof value === "string" ? [value] : Object.values(value as Record<string, unknown>);
      for (const item of strings) expect(typeof item, name).toBe("string");
    }
  });

  it("/privacy 화면과 카드 틀(AuthCard)은 서버 컴포넌트로 그릴 수 있다 — \"use client\" 없음", () => {
    expect(isClient(read("app/privacy/page.tsx"))).toBe(false);
    expect(isClient(read("components/auth/AuthCard.tsx"))).toBe(false);
    // 로그인·가입·재설정·인증은 지금처럼 클라이언트 화면(입력·요청).
    for (const page of ["login", "signup", "reset", "verify"]) expect(isClient(read(`app/${page}/page.tsx`)), page).toBe(true);
  });

  it("안내 카드(AUTH_NOTICE_CARD)는 인증 카드와 같은 4px 모서리·안쪽 24px — 넓은 화면 32px(sm:p-8) 없음", () => {
    const card = authClasses.AUTH_CARD.split(" ");
    const notice = authClasses.AUTH_NOTICE_CARD.split(" ");
    for (const token of ["rounded-card", "border", "bg-surface", "p-6"]) {
      expect(card, `AUTH_CARD ${token}`).toContain(token);
      expect(notice, `AUTH_NOTICE_CARD ${token}`).toContain(token);
    }
    expect(notice.filter((token) => /^(?:sm|md|lg|xl|2xl):p-/.test(token))).toEqual([]);
    expect(card.filter((token) => /^(?:sm|md|lg|xl|2xl):p-/.test(token))).toEqual([]);
    // 대시보드 레이아웃의 두 안내 카드가 이 클래스를 씁니다.
    expect(read("app/(dashboard)/layout.tsx").match(/className=\{AUTH_NOTICE_CARD\}/g)).toHaveLength(2);
  });

  it("결과 상자(AUTH_MESSAGE)는 4px 모서리·13px, 톤 두 가지(오류·성공)", () => {
    expect(authClasses.AUTH_MESSAGE.split(" ")).toEqual(expect.arrayContaining(["rounded-control", "border", "text-[13px]"]));
    expect(Object.keys(authClasses.AUTH_MESSAGE_TONE).sort()).toEqual(["error", "ok"]);
  });

  it("동의 체크(AUTH_CHECK)·글 링크(AUTH_LINK)·주 단추(AUTH_SUBMIT)는 lg 미만 44px", () => {
    for (const name of ["AUTH_CHECK", "AUTH_LINK", "AUTH_SUBMIT"] as const) {
      expect(belowLgTarget(authClasses[name]), name).toBeNull();
    }
  });
});
