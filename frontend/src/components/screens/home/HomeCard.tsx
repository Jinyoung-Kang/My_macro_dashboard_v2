import { useId, type ReactNode } from "react";
import { ErrorState, PANEL_CLASSES } from "@/components/ui";

/**
 * 홈 패널 틀 — 공용 Panel(작업대 실행 명세 §6)과 같은 모양입니다: 1층 면(surface·1px 경계·4px 모서리), 머리줄(제목 heading-sm · 개수 · 오른쪽 동작)을
 * 아래 1px 경계로 본문과 가르고, 본문 안쪽 12px(lg 16px). 공용 Panel과 다른 점은 이름 있는 영역(section aria-labelledby → 제목 h2)이라는 것
 * 하나입니다 — 홈은 구역마다 영역 이름으로 찾아가므로(낭독기 영역 목록) 이름이 있어야 하고, 공용 Panel을 고치면 180곳이 한꺼번에 영역이 됩니다.
 * 머리·본문 클래스가 공용 Panel과 같은지는 홈 시험이 대조합니다.
 *
 * 불러오는 중·오류에도 같은 틀과 제목으로 자리를 지킵니다 — 값이 와도 틀 여백이 바뀌지 않고, 한 구역이 실패해도 나머지 구역과 제목 구조가 그대로입니다.
 */
export function HomePanel({
  title,
  count,
  actions,
  children,
  className = "",
}: {
  title: string;
  /** 표·목록의 개수(명세 §3-7 '머리에는 늘 개수') — 제목 옆 보조 글, 제목(영역 이름)에는 넣지 않습니다. */
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`min-w-0 ${PANEL_CLASSES} ${className}`.trim()}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-3 py-2.5 lg:px-4 border-b border-border">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 id={headingId} className="text-heading-sm text-text">
              {title}
            </h2>
            {count !== undefined && count !== null ? <span className="text-[13px] tabular-nums text-text-3">{count}</span> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="p-3 lg:p-4">{children}</div>
    </section>
  );
}

/**
 * 홈 구역 하나의 카드 틀(알림 요약) — 제목(h2, 영역 이름) · 오른쪽 작은 동작(링크·배지) · 본문.
 * 불러오는 중·오류에도 같은 제목으로 자리를 지켜, 한 구역이 실패해도 나머지 구역과 제목 구조가 그대로입니다(일부 실패).
 * 1px 경계·4px 모서리(rounded-card)·그림자 없음, 안쪽 여백은 패널 12px(lg 16px — 작업대 실행 명세 §3-7).
 * 히어로 구역(국면·모의매매)은 불러오는 중·오류도 이 틀이 아니라 Hero의 placeholder로 그립니다 — 틀 여백이 Hero와 달라, 값이 오는 순간
 * 제목·본문이 튀었습니다(검토 지적).
 */
export function HomeCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-card border border-border bg-surface p-3 lg:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={headingId} className="text-[15px] font-medium text-text-2">
          {title}
        </h2>
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{actions}</div> : null}
      </div>
      <div className="mt-3 min-w-0">{children}</div>
    </section>
  );
}

/** 홈의 작은 글 링크("국면 판정 보기" 등) — 밑줄은 hover에서, 포커스 링은 토큰 색. 좁은 화면(lg 미만)에서는 누르는 높이 44px(셸과 같음). */
export const HOME_LINK =
  "inline-flex min-h-11 items-center rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline lg:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

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
