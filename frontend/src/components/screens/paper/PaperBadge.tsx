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
    // 줄바꿈 없음 — 공용 Tag는 글 흐름의 inline-flex라 좁은 표 칸에서 '사후/체결'처럼 글자 사이로 접혔습니다(예전 화면 배지는 whitespace-nowrap).
    <span title={badge.title} className="whitespace-nowrap">
      <Tag tone={badgeTagTone(badge)}>
        <span>{badge.label}</span>
      </Tag>
    </span>
  );
}

/**
 * lib 배지 목록 → 공용 태그 여럿(PaperBadge) — 배지 글은 줄을 바꾸지 않고 배지 사이에서만 꺾습니다(감싸개 flex-wrap·간격 4px). `bare`면 감싸개 없이 태그만
 * (부르는 쪽 줄이 이미 flex 줄 — 보유·주문·체결 표의 종목 칸). 결정 상세·선정·보유 표가 함께 씁니다(작업대 P6 검토 — 화면마다 따로 있던 같은 도우미 다섯).
 */
export function PaperBadges({ badges, bare = false }: { badges: readonly Badge[]; bare?: boolean }): JSX.Element {
  const tags = badges.map((badge) => <PaperBadge key={badge.key} badge={badge} />);
  return bare ? <>{tags}</> : <span className="flex flex-wrap items-center gap-1 whitespace-nowrap">{tags}</span>;
}

