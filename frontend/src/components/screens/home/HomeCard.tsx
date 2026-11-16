import { ErrorState } from "@/components/ui";

/** 홈의 작은 글 링크("국면 판정 보기" 등) — 밑줄은 hover에서, 포커스 링은 토큰 색. 좁은 화면(lg 미만)에서는 누르는 높이 44px(셸과 같음). */
export const HOME_LINK =
  "inline-flex min-h-11 items-center rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline lg:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/*
 * 홈 패널 틀은 공용 Panel의 이름 있는 영역(`region` — section aria-labelledby → 제목 h2)입니다: 홈은 구역마다 영역 이름으로 찾아가므로(낭독기 영역 목록)
 * 이름이 있어야 합니다. 불러오는 중·오류에도 같은 틀과 제목으로 자리를 지킵니다 — 값이 와도 틀 여백이 바뀌지 않고, 한 구역이 실패해도 나머지 구역과
 * 제목 구조가 그대로입니다.
 */

/**
 * 구역 하나가 읽기에 실패했을 때의 오류 상자 — role="alert"로 감싸 보조 기술에 알립니다. 불러오는 중에는 Skeleton(role="status")이
 * 있다가 실패하면 DOM에서 빠지므로, 감싸지 않으면 낭독기 사용자는 실패를 모릅니다. 공용 ErrorState는 옛 화면 여럿이 쓰므로 바꾸지 않고
 * 홈에서만 감쌉니다(옛 화면은 4단계에서 옮길 때 함께 정합니다).
 */
export function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <ErrorState message={message} onRetry={onRetry} />
    </div>
  );
}
