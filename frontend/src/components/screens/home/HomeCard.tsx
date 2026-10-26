import { useId, type ReactNode } from "react";
import { ErrorState } from "@/components/ui";

/**
 * 홈 구역 하나의 카드 틀 — 제목(h2, 영역 이름) · 오른쪽 작은 동작(링크·배지) · 본문.
 * 히어로(components/patterns Hero)를 그리기 전(불러오는 중·오류)에도 같은 제목으로 자리를 지켜, 한 구역이 실패해도
 * 나머지 구역과 제목 구조가 그대로입니다(일부 실패). 1px 경계·rounded-xl·그림자 없음(브리프 §1.1).
 */
export function HomeCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-xl border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={headingId} className="text-sm font-medium text-text-2">
          {title}
        </h2>
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{actions}</div> : null}
      </div>
      <div className="mt-3 min-w-0">{children}</div>
    </section>
  );
}

/** 홈의 작은 글 링크("국면 판정 보기" 등) — 밑줄은 hover에서, 포커스 링은 토큰 색. */
export const HOME_LINK =
  "rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

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
