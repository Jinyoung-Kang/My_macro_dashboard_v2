"use client";

import Link from "next/link";
import { InspectorSubheading, Skeleton } from "@/components/patterns";
import { Callout, ErrorState, buttonClasses } from "@/components/ui";
import { ExternalLinkIcon, StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { securityNoticeHref } from "@/lib/detail";
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
 * - 단추 둘: '자세히 보기'(상세 페이지 /security/<번호>)·'원문 열기(새 창)'.
 */
export function NoticeSummary({ nttId }: { nttId: string }) {
  const read = useApi<SecurityNoticeResponse>(endpoints.security.notice(nttId), 0);
  if (firstLoadPending(read)) return <Skeleton lines={5} label="공지를 불러오는 중" />;
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />;
  const data = read.data;
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

      <div className="flex flex-wrap items-center gap-2">
        <Link href={securityNoticeHref(nttId)} className={buttonClasses("primary", "md")}>
          자세히 보기
        </Link>
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
