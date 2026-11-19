/**
 * 없는 주소의 화면 — QA-270(2026-11-04 기록, P4 QA가 '형식이 틀린 CIK 주소(/institutions/abc)의 흰 판·빈 스크롤'을 덧붙여 P7 몫으로 넘김).
 *
 * `app/not-found.tsx`가 없어 앱이 만들지 않는 주소(/nonexistent-page·/paper/us/overview)와 셸 안 notFound()(/institutions/abc·/s/xx/AAPL·
 * dynamicParams false인 /info/<없는 분류>)가 Next 기본 영어 화면('404 / This page could not be found.' — 어두운 고정 테마와 맞지 않는 흰 판, 돌아갈 링크
 * 없음)이었습니다. 루트 not-found는 (dashboard) 레이아웃을 거치지 않으므로 루트에 둡니다.
 *
 * 기대: 인증 화면과 같은 카드 틀(AuthCard — 서버 컴포넌트, 어두운 토큰) 안에 한국어 제목 '찾을 수 없는 화면'과 홈('/')으로 가는 링크 하나.
 * 모의매매 링크(QA-270 기록의 기대값)는 운영자 전용 화면이라 넣지 않습니다(회원·로그인 전 방문자에게 막힌 링크가 됨). 탭 제목(metadata.title)은
 * 사용자 결정대로 그대로입니다(QA-565 기록 'QA-270 결정').
 * 수정 전(재현 커밋에서는 it.fails): 두 사례 모두 'app/not-found.tsx: expected false to be true'(파일 없음).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";

const FILE = resolve(__dirname, "../not-found.tsx");

afterEach(() => cleanup());

async function loadPage(): Promise<ComponentType> {
  expect(existsSync(FILE), "app/not-found.tsx").toBe(true);
  const mod = (await import(/* @vite-ignore */ FILE)) as { default: ComponentType };
  return mod.default;
}

describe("없는 주소의 화면(QA-270)", () => {
  it("루트 not-found는 서버 컴포넌트다 — \"use client\" 없음, 인증 카드 틀(AuthCard)을 씀", () => {
    expect(existsSync(FILE), "app/not-found.tsx").toBe(true);
    const source = readFileSync(FILE, "utf8");
    expect(source).not.toMatch(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?["']use client["']/);
    expect(source).toMatch(/from ["']@\/components\/auth\/AuthCard["']/);
  });

  it("한국어 제목 '찾을 수 없는 화면'과 홈('/')으로 가는 링크 하나 — 운영자 전용 화면 링크는 두지 않는다", async () => {
    const NotFound = await loadPage();
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "찾을 수 없는 화면" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/"]);
    expect(document.body.textContent).not.toMatch(/could not be found|404/);
  });
});
