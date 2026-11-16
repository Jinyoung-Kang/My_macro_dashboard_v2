"use client";

import { useEffect } from "react";
import { rememberRecentEntity } from "@/hooks/useRecentEntities";
import { detailVisitEntity, type DetailVisitKind } from "@/lib/palette";

/**
 * 상세 화면 방문을 명령 팔레트의 '최근 연 대상'에 넣습니다(P4 — 이 브라우저의 localStorage, 형식은 lib/palette). 대상 이름을 읽은 뒤에만 넣고
 * (주소나 이름이 null이면 넣지 않음 — 찾지 못함·읽기 실패·'CIK …' 같은 자리표시 이름은 부르는 쪽이 null로), 주소·이름·보조 글이 바뀔 때만
 * 다시 넣습니다(실시간 시세로 다시 그려도 저장하지 않음). 형식 밖이면 아무 일도 없습니다.
 */
export function useDetailVisit(kind: DetailVisitKind, href: string | null, label: string | null, sub: string | null): void {
  useEffect(() => {
    if (!href || !label) return;
    const entity = detailVisitEntity({ kind, label, sub, href });
    if (entity) rememberRecentEntity(entity);
  }, [kind, href, label, sub]);
}
