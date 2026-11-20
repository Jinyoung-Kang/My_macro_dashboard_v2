"use client";

import type { ReactElement, ReactNode } from "react";

import { Dialog } from "./Dialog";

/**
 * 서랍(작업대 실행 명세 §6 Drawer — 처음 쓰는 곳 P6 모의매매 머리의 '이 장부의 한계'): 공용 대화상자(ui/Dialog)의 오른쪽 세로 패널 배치(`placement="end"`)를
 * 감싼 것입니다 — Radix Dialog 그대로라 새 의존성이 없습니다.
 *
 * - 모양: 화면 오른쪽 끝에 붙은 화면 높이의 패널(좁은 화면 sm 미만은 전체 폭, 그 위는 `width` — md 28rem·lg 42rem), 덮개 3층(surface-2 바탕·화면 안쪽
 *   가장자리 1px 밝은 경계·바깥 그림자 — 고대비에서는 그림자가 지워지고 경계가 시스템 색으로 남음), 덮개 범위 표지(data-overlay — 안의 공용 단추가 조작
 *   바탕을 한 단계 위로), 오른쪽 위 닫기 단추.
 * - 동작: 대화상자와 같습니다 — 이름은 `title`(aria-labelledby), 설명은 aria-describedby, Esc·바깥 누르기·닫기 단추로 닫히고(onOpenChange(false)),
 *   열면 포커스가 안으로 들어가 갇히며, 닫으면 연 단추로 돌아옵니다(`trigger`를 주면 Radix Trigger — aria-haspopup="dialog"·aria-expanded).
 * - 열림 상태는 부르는 쪽이 쥡니다. 닫혀 있으면 내용이 DOM에 없습니다(그래서 접힌 동안 글은 읽기에서도 빠짐 — 늘 보여야 하는 뜻은 서랍 밖에 둡니다).
 * - 검사 칸의 덮개(목록-검사·검사 칸 틀)는 서랍이 아니라 위쪽 대화상자입니다(2026-11-16 결정, P6에서 다시 봄 — 계획 §2-5). 서랍은 화면과 나란히 읽는
 *   긴 참고 글(한계 목록)에 씁니다.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  width = "md",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 서랍 이름 — 화면 읽기 프로그램이 "대화상자, {title}"로 읽습니다. */
  title: string;
  /** 제목 아래 설명(aria-describedby). */
  description?: ReactNode;
  /** 여는 단추(요소 하나) — Radix Trigger로 감쌉니다. 없으면 부르는 쪽이 open을 바꿉니다(닫으면 연 단추로 포커스가 돌아오는 것은 같음). */
  trigger?: ReactElement;
  /** 넓은 화면(sm 이상)의 폭 — md 28rem(기본)·lg 42rem. 좁은 화면은 전체 폭. */
  width?: "md" | "lg";
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} trigger={trigger} size={width} placement="end">
      {children}
    </Dialog>
  );
}
