/**
 * 인증 카드·대시보드 안내 카드 글의 낱말 줄바꿈 — QA-891(D6 전 QA 스택 확인에서 찾음, 개편 전부터 — D5 기준 빌드도 같은 곳·같은 수).
 *
 * 인증 화면(로그인·가입·재설정·인증·처리방침)과 대시보드 레이아웃의 안내 카드(백엔드에 연결하지 못함·운영자 계정 없음)의 한국어 안내 글이 word-break
 * normal이라 음절 사이에서 꺾였습니다 — /privacy 390 6곳('저장하지 않|음'·'보냅니|다' 등), /signup 1024·1440 '동|의합니다', 안내 카드 320 h1 '연결하지
 * 못|했습니다' 등(카드 폭 max-w-sm·max-w-lg라 넓은 화면에서도). 같은 화면군의 not-found 카드·안내 한 줄(`c9f12fb2`)은 낱말 사이에서만 꺾습니다.
 *
 * 기대: 카드(AUTH_CARD·AUTH_NOTICE_CARD)가 낱말 사이에서만 줄을 바꾸고(break-keep — 상속이라 카드 안 제목·안내·dd·동의 글 모두), 공백 없는 긴
 * 토큰(주소·이메일)만 칸 안에서 꺾습니다(wrap-break-word — 공용 글 부품 규약 QA-568과 같은 짝). 카드 크기·안쪽·모서리는 그대로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): "expected [ 'w-full', 'max-w-sm', …(5) ] to include 'break-keep'".
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthCard } from "@/components/auth/AuthCard";
import { AUTH_CARD, AUTH_NOTICE_CARD } from "@/components/auth/classes";

afterEach(() => cleanup());

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);

describe("인증·안내 카드의 낱말 줄바꿈(QA-891)", () => {
  it.fails("인증 카드·안내 카드는 break-keep + wrap-break-word, 카드 틀(AuthCard)의 제목·안내 글이 그 안에 있다", () => {
    for (const card of [AUTH_CARD, AUTH_NOTICE_CARD]) {
      expect(tokens(card)).toContain("break-keep");
      expect(tokens(card)).toContain("wrap-break-word");
    }
    render(
      <AuthCard title="개인정보 처리방침">
        <p>이 서비스는 이메일과 비밀번호 해시만 저장하고 나머지는 저장하지 않음</p>
      </AuthCard>,
    );
    const card = screen.getByRole("heading", { name: "개인정보 처리방침" }).parentElement as HTMLElement;
    expect(tokens(card.className)).toContain("break-keep");
    expect(card.contains(screen.getByText(/저장하지 않음/))).toBe(true);
  });
});
