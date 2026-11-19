/**
 * 없는 주소 화면의 '← 홈' 링크 누름 자리 — QA-862(작업대 P7 통합 확인에서 찾음).
 *
 * QA-270 고침(afaef36e)이 만든 루트 not-found의 돌아갈 링크 '← 홈'은 인증 카드 아래 따로 선 글 링크 클래스(AUTH_LINK — TEXT_TARGET: lg 미만 높이 44px,
 * 폭은 글 폭)를 써서, 통합 자기 빌드(`ui-audit` 390 /no-such-page)에서 29.6×44px — 폭이 좁은 화면 44px에 못 미쳤습니다. 글이 두세 글자인 홀로 선 링크는
 * 짧은 글 단추 규칙(ui/classes TEXT_TARGET_SHORT — 좁은 화면 높이·폭 44px, 글 가운데, 넓은 화면 글 크기)을 따릅니다.
 * jsdom은 배치를 재지 않으므로 클래스로 봅니다(QA-835 쪽 번호 단추와 같은 방식). 높이 규칙은 touchTargetAudit의 belowLgTarget.
 * 수정 전(재현 커밋에서는 it.fails): 링크 클래스 ['inline-flex', 'min-h-11', 'items-center', 'lg:min-h-0', 'rounded-sm', 'hover:text-accent', …포커스 링]에
 * min-w-11·lg:min-w-0이 없음('expected [ \'inline-flex\', \'min-h-11\', …(7) ] to deeply equal ArrayContaining{…}').
 */
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";

const FILE = resolve(__dirname, "../not-found.tsx");

afterEach(() => cleanup());

describe("없는 주소 화면의 '← 홈' 링크(QA-862)", () => {
  it("좁은 화면에서 높이·폭 44px(min-h-11·min-w-11), 넓은 화면은 글 크기(lg:min-h-0·lg:min-w-0)", async () => {
    const NotFound = ((await import(/* @vite-ignore */ FILE)) as { default: ComponentType }).default;
    render(<NotFound />);
    const link = screen.getByRole("link", { name: "← 홈" });
    const tokens = (link.getAttribute("class") ?? "").split(/\s+/);
    expect(belowLgTarget(link.getAttribute("class") ?? "")).toBeNull();
    expect(tokens).toEqual(expect.arrayContaining(["min-h-11", "min-w-11", "lg:min-h-0", "lg:min-w-0"]));
  });
});
