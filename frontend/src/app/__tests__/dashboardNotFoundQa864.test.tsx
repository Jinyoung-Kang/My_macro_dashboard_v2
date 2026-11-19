/**
 * 셸 안 notFound()의 화면 — QA-864(작업대 P7 검토에서 찾음).
 *
 * QA-270 고침(afaef36e)은 루트 `app/not-found.tsx`만 두어, 대시보드 화면이 부르는 notFound()(형식이 틀린 CIK /institutions/abc·종목 주소 /s/xx/AAPL·
 * 없는 지표·정보 수집 분류·모의매매 탭)도 가장 가까운 not-found 경계인 루트로 올라가 대시보드 셸(왼쪽 메뉴·상단바·빵부스러기) 밖의 인증 카드로 그려졌습니다
 * (기준 0d016ca1은 셸 안의 Next 기본 영어 404 — 메뉴·빵부스러기, Tab 17개 → P7 끝 셸 없는 카드, Tab 1개). 넘겨받은 항목은 '루트·셸 안 not-found'
 * 한 묶음이었습니다(진행 기록 §P4 → P7).
 *
 * 기대: `app/(dashboard)/not-found.tsx`가 셸 안 경계로 같은 한국어 글(제목 '찾을 수 없는 화면'·안내 한 줄·홈 링크 하나)을 셸 본문에 그립니다 — 셸이
 * `<main>`을 가지므로 자기 `<main>`을 두지 않고, 제목은 화면 머리(h1)입니다. 앱이 만들지 않는 주소는 그대로 루트 not-found(셸 밖 카드)입니다.
 * 수정 전(재현 커밋에서는 it.fails): 'app/(dashboard)/not-found.tsx: expected false to be true'(파일 없음).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";

const FILE = resolve(__dirname, "../(dashboard)/not-found.tsx");

afterEach(() => cleanup());

async function loadPage(): Promise<ComponentType> {
  expect(existsSync(FILE), "app/(dashboard)/not-found.tsx").toBe(true);
  const mod = (await import(/* @vite-ignore */ FILE)) as { default: ComponentType };
  return mod.default;
}

describe("셸 안 notFound()의 화면(QA-864)", () => {
  it.fails("대시보드 묶음에 not-found 경계가 있다 — 서버 컴포넌트(\"use client\" 없음), 인증 카드 틀(AuthCard)을 쓰지 않음", () => {
    expect(existsSync(FILE), "app/(dashboard)/not-found.tsx").toBe(true);
    const source = readFileSync(FILE, "utf8");
    expect(source).not.toMatch(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?["']use client["']/);
    expect(source).not.toMatch(/AuthCard/);
  });

  it.fails("셸 본문에 화면 머리 h1 '찾을 수 없는 화면'·안내 한 줄·홈('/') 링크 하나 — 자기 <main> 없음, 홈 링크는 좁은 화면 44px", async () => {
    const NotFound = await loadPage();
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "찾을 수 없는 화면" })).toBeTruthy();
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByText("주소가 틀렸거나 없는 화면입니다. 주소를 확인하거나 홈에서 다시 찾아 주세요.")).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/"]);
    const home = screen.getByRole("link", { name: "← 홈" });
    const tokens = (home.getAttribute("class") ?? "").split(/\s+/);
    expect(belowLgTarget(home.getAttribute("class") ?? "")).toBeNull();
    expect(tokens).toEqual(expect.arrayContaining(["min-h-11", "min-w-11", "lg:min-h-0", "lg:min-w-0"]));
    expect(document.body.textContent).not.toMatch(/could not be found|404/);
  });
});
