import type { ReactNode } from "react";
import { AUTH_SUBMIT_PLACE } from "@/components/auth/classes";
import { Button } from "@/components/ui";

/**
 * 인증 카드의 주 단추(보내기) — 로그인·가입·재설정 폼이 씁니다. 카드 틀(AuthCard.tsx)은 서버 컴포넌트(/privacy·루트 not-found)도 가져오므로, 폼에서만 쓰는
 * 이 단추는 따로 둡니다(클라이언트 화면만 가져옴).
 *
 * 공용 Button(primary lg — 클래스 묶음은 AUTH_SUBMIT와 같음)이라 요청 중(`busy`)은 진짜 disabled가 아니라 aria-disabled와 누름 무시입니다 — 누른 단추가
 * 꺼지면 크롬이 포커스를 body로 보냈습니다(QA-909, 대시보드 화면은 QA-899). 입력칸 Enter로 폼을 다시 보내는 길은 단추가 막지 못하므로 폼의 onSubmit도 busy면
 * 돌아갑니다(부르는 쪽). `disabled`는 켜짐 조건(빈 입력·불일치·동의 안 함)이라 그대로 진짜 disabled입니다.
 *
 * @param busyLabel 요청 중 단추 글 — 로그인은 '확인 중…', 그 밖은 '처리 중…'(예전 글 그대로).
 */
export function AuthSubmit({
  busy, disabled, busyLabel = "처리 중…", children,
}: {
  busy: boolean;
  disabled?: boolean;
  busyLabel?: string;
  children: ReactNode;
}) {
  return (
    <Button variant="primary" size="lg" type="submit" busy={busy} disabled={disabled} className={AUTH_SUBMIT_PLACE}>
      {busy ? busyLabel : children}
    </Button>
  );
}
