import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";

/** 결과 낱말과 사유를 가르는 표 — '새로고침 실패 — 사유'·'로그아웃 실패 — 사유'(useRefreshSignal·useLogout). */
const SEPARATOR = " — ";

/**
 * 셸의 실패 안내 한 덩이 — 경고 톤 + 12px 경고 아이콘 + sr-only '주의: '(공용 StatusText). 데이터 새로고침 실패(RefreshButton)와 로그아웃 실패
 * (AccountMenu·더보기 AccountBox)가 같이 씁니다.
 *
 * - `oneLine`(넓은 화면 상단바 — 한 줄): 글을 결과 낱말(첫 ' — ' 앞, 예: '새로고침 실패')과 사유로 나눠, 결과 낱말은 줄바꿈·말줄임 없이 늘 보이고
 *   사유만 말줄임합니다(전체 글은 감싼 요소의 title). 둘을 담는 grid의 사유 칸이 minmax(0, 1fr)라 이 덩이의 최소 내용 폭은 아이콘 + 사이 + 결과
 *   낱말입니다 — 감싼 상자가 상단바에서 줄어도 그 폭 아래로는 줄지 않습니다(QA-547 후속: 결과 낱말까지 말줄임되어 '새로고…'·'로그아웃하…'만 남았음).
 *   사유 칸은 공백을 지키는(whitespace-pre) 한 줄이라 두 글 조각을 이으면 원래 글 그대로입니다(낭독기·textContent).
 * - 아니면(더보기 — 여러 줄): 글 전체를 줄바꿈해 그립니다.
 * 표가 없는 글은 나누지 않고 전체를 사유처럼 말줄임합니다.
 */
export function FailureNotice({ message, oneLine }: { message: string; oneLine: boolean }) {
  const cut = message.indexOf(SEPARATOR);
  return (
    <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />} className={oneLine ? "min-w-0" : ""}>
      {oneLine ? (
        <span className="grid grid-cols-[auto_minmax(0,1fr)]">
          <span className="whitespace-nowrap">{cut > 0 ? message.slice(0, cut) : ""}</span>
          <span className="overflow-hidden text-ellipsis whitespace-pre">{cut > 0 ? message.slice(cut) : message}</span>
        </span>
      ) : (
        message
      )}
    </StatusText>
  );
}
