import type { JSX } from "react";

import { Tag } from "@/components/ui";
import type { Badge } from "@/lib/paper";
import { badgeTagTone } from "@/lib/paperBadgeTone";

/**
 * 모의매매 화면 안 상태 배지 → 공용 태그(작업대 P6 — 진행 기록 '화면 안 상태 배지 → 공용 Tag 20px'). lib의 배지(`Badge` — 글·색 클래스·마우스 설명)를 그대로
 * 받아 색 표를 태그 톤으로 옮깁니다(lib/paperBadgeTone — 정상·주의·중립, 주의는 아이콘 + 낭독기 '주의: '). 글은 태그 안의 안쪽 span이라 글로 찾는 시험이
 * 그대로 찾습니다. 마우스 설명(title)은 바깥 span에 둡니다(없으면 붙이지 않음). 이 파일은 패턴 단계가 만들고 세 갈래가 함께 써 얼립니다.
 */
export function PaperBadge({ badge }: { badge: Pick<Badge, "label" | "className" | "title"> }): JSX.Element {
  return (
    <span title={badge.title}>
      <Tag tone={badgeTagTone(badge)}>
        <span>{badge.label}</span>
      </Tag>
    </span>
  );
}
