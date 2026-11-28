"use client";

import { InspectorSubheading, Skeleton } from "@/components/patterns";
import { Callout, ErrorState, buttonClasses } from "@/components/ui";
import { ExternalLinkIcon, StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  NO_INVENTORY_NOTE,
  conditionSummary,
  environmentLines,
  evidenceReasonText,
  listText,
  reasonsText,
  safeExternalUrl,
  sectionLabel,
  settledCountText,
  type EvidenceLine,
} from "@/lib/security";
import type { SecurityNoticeResponse } from "@/lib/types";
import { AckPanel } from "./AckPanel";
import { NoticeDetailDialog } from "./NoticeDetailDialog";
import { VerdictText } from "./VerdictText";

const SUBHEADING = "mb-1 text-caption font-semibold text-text-2";

/**
 * 공지 요약 칸(목록의 검사 칸 — 넓은 틀은 옆 칸, 그 밖은 대화상자) — 공지 한 건(GET /api/security/notices/{번호})을 열 때 읽고 '이 환경에 걸린 것'만 짧게 보입니다
 * (2026-11-21 사용자 결정 — 패치됨 행까지 길게 늘어놓던 행 표 전체는 상세 페이지로 옮김):
 *
 * - 판정(아이콘 + 글)·사유 한 줄.
 * - 이 환경에 걸린 것 — 해당·확인 필요인 근거만, 같은 제품·구역·판정은 한 줄(제품·구역, 설치 판·해결 판, 사유·근거 한 줄). 없으면 그 사실 한 줄.
 * - '패치됨 N개 · 무관 N개' 한 줄(펼치기 없음 — 상세 페이지에서 봄).
 * - ※ 조건 문장 수와 첫 문장(있을 때만).
 * - 단추 둘: '자세히 보기'(팝업 — 상세 페이지와 같은 구역 ①~⑤, NoticeDetailDialog, 2026-11-22 사용자 요청)·'원문 열기(새 창)'.
 *   상세 페이지 주소(/security/<번호>)는 그대로 열립니다.
 * - '확인함' 표시(AckPanel — 확인 필요 공지에만, ADR 0046 덧붙임 2026-11-28). 적거나 지우면 이 칸과 목록(onAckChange)을 다시 읽습니다.
 */
export function NoticeSummary({ nttId, onAckChange }: { nttId: string; onAckChange?: () => void }) {
  const read = useApi<SecurityNoticeResponse>(endpoints.security.notice(nttId), 0);
  if (firstLoadPending(read)) return <Skeleton lines={5} label="공지를 불러오는 중" />;
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />;
  const data = read.data;
  // 읽기가 실패한 뒤 다시 읽는 동안('다시 시도') — useApi가 error를 비우고 failedAt을 남겨 위 두 갈래에 걸리지 않습니다. 빈 칸 대신 오류 상자와
  // 비슷한 높이의 읽는 중 표시(QA-1030 — 같은 응답을 읽는 상세 화면 NoticeScreen과 같은 처리, 큰 자리표시는 처음 읽을 때만 — QA-655).
  if (!data && read.loading) return <Skeleton lines={2} label="공지를 불러오는 중" />;
  if (!data) return null;
  const { notice } = data;
  const view = environmentLines(data);
  const settled = settledCountText(view);
  const condition = conditionSummary(notice.conditionNotes);
  const url = safeExternalUrl(notice.url);
  const reasons = reasonsText(notice.reasons);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <VerdictText code={notice.verdict} />
        {reasons ? <span className="break-keep text-text-2">{reasons}</span> : null}
      </p>

      {!data.inventory ? <Callout tone="warn">{NO_INVENTORY_NOTE}</Callout> : null}

      <section className="min-w-0">
        <InspectorSubheading fallback="h4" className={SUBHEADING}>
          이 환경에 걸린 것 {view.exposed.length}줄
        </InspectorSubheading>
        {view.exposed.length > 0 ? (
          <ul className="flex flex-col">
            {view.exposed.map((line) => (
              <ExposureItem key={line.key} line={line} />
            ))}
          </ul>
        ) : (
          <p className="break-keep text-sm text-text-2">해당·확인 필요인 근거가 없습니다.</p>
        )}
      </section>

      {settled ? <p className="break-keep text-sm text-text-2">{settled} — 목록은 &lsquo;자세히 보기&rsquo;에서 봅니다.</p> : null}

      {condition ? (
        <p className="text-sm text-text-2">
          <StatusText tone="warn" colorText={false} className="wrap-anywhere">
            ※ 조건 문장 {condition.count}개 — {condition.first}
          </StatusText>
        </p>
      ) : null}

      <AckPanel
        nttId={nttId}
        notice={notice}
        onChange={() => {
          read.reload();
          onAckChange?.();
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <NoticeDetailDialog
          data={data}
          trigger={
            <button type="button" className={buttonClasses("primary", "md")}>
              자세히 보기
            </button>
          }
        />
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClasses("default", "md")}>
            원문 열기(새 창)
            <ExternalLinkIcon size={14} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** 걸린 것 한 줄 — 판정·제품·구역, 설치 판 → 해결 판(값이 여럿이면 앞 둘과 '외 N개'), 사유·근거. */
function ExposureItem({ line }: { line: EvidenceLine }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-border-subtle py-2 last:border-0">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <VerdictText code={line.status} />
        <span className="break-keep font-medium text-text">{line.product}</span>
        <span className="text-text-2">{sectionLabel(line.source)}</span>
      </p>
      <p className="break-keep wrap-anywhere text-caption text-text-2">
        설치 판 {listText(line.installed) ?? EMPTY} · 해결 판 {listText(line.fixed) ?? EMPTY}
      </p>
      <p className="break-keep text-caption text-text-2">{evidenceReasonText(line)}</p>
    </li>
  );
}
