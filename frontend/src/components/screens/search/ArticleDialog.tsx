"use client";

import { useState } from "react";
import { Banner, buttonClasses } from "@/components/ui";
import { FOCUS_RING } from "@/components/ui/classes";
import { Dialog } from "@/components/ui/Dialog";
import { ExternalLinkIcon, InfoIcon, SpinnerIcon } from "@/components/ui/icons";
import { useArticleBody } from "@/hooks/useArticleBody";
import { useTranslate } from "@/hooks/useTranslate";
import { endpoints } from "@/lib/endpoints";
import { translatedBy } from "@/lib/info";
import {
  articleFacts,
  articleFlags,
  articleNeedsTranslation,
  articleReasonText,
  httpUrl,
  itemTimeText,
} from "@/lib/infoSearch";
import type { SearchArticle, SearchFeedItem } from "@/lib/types";

/** 본문 팝업에 여는 줄 — 결과 줄의 꼬리표(bodyRef)·그 줄·받은 곳 이름. */
export type ArticleEntry = { ref: string; item: SearchFeedItem; label: string };

const LINK_BUTTON = buttonClasses("default", "sm");

/**
 * 정보 검색 본문 팝업(ADR 0043 — 운영자 전용). 미리 보기의 '본문 보기'를 누르면 운영 서버가 그 결과 줄의 글 한 건을 받아 본문만 추린 것을 보입니다.
 * 처음에는 받는 중(서버 작업자가 받는 동안 2초마다 다시 묻고 약 70초 뒤 멈춤), 받으면 사실 줄(매체·글쓴이·글에 적힌 날짜·받은 시각·출처 링크)·
 * 표지(잘림·짧음·유료 표시)·문단, 못 받으면 사유와 '원문 열기(새 창)'. 한국어가 아닌 글에는 번역 단추(저장하지 않는 번역 — 서버 메모리 24시간).
 * 덮개·포커스 가두기·Esc·연 단추로 포커스 돌려주기는 Dialog가 합니다. 본문은 저장하지 않고 개인 열람용으로만 보입니다.
 */
export function ArticleDialog({ entry, onClose }: { entry: ArticleEntry | null; onClose: () => void }) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={entry ? entry.item.title : "본문"}
      description={entry ? `${entry.label} · ${itemTimeText(entry.item)}` : undefined}
      size="lg"
      placement="top"
    >
      {entry && <ArticleBody key={entry.ref} entry={entry} />}
    </Dialog>
  );
}

function ArticleBody({ entry }: { entry: ArticleEntry }) {
  const { phase, response, failure, retryLocked, reload } = useArticleBody(entry.ref);
  const original = httpUrl(entry.item.url);
  const openOriginal = original ? (
    <a href={original} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
      원문 열기(새 창)
      <ExternalLinkIcon size={14} />
    </a>
  ) : null;

  if (phase === "loading") {
    return (
      <div className="mt-3 space-y-3" aria-busy="true">
        <p role="status" className="flex items-center gap-2 text-sm text-text-2">
          <SpinnerIcon size={16} className="motion-safe:animate-spin" />
          운영 서버가 글을 받는 중입니다(보통 몇 초, 길면 1분)
        </p>
        <div className="flex flex-wrap items-center gap-2">{openOriginal}</div>
      </div>
    );
  }

  if (phase === "stalled") {
    return (
      <div className="mt-3 space-y-3">
        <p role="status" className="text-sm text-text-2">
          아직 받는 중입니다 — 서버가 이 글을 끝까지 받지 못했습니다. 잠시 뒤 다시 확인하세요.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={reload} className={buttonClasses("default", "sm")}>
            다시 확인
          </button>
          {openOriginal}
        </div>
      </div>
    );
  }

  if (phase === "error" || !response?.article) {
    const reason = failure ?? articleReasonText(response ?? { available: false });
    const retryable = failure !== null || response?.retryable === true || response?.available === false;
    const wait = response?.retryAfterSeconds ?? null;
    return (
      <div className="mt-3 space-y-3">
        <Banner tone="warn">{reason}</Banner>
        <div className="flex flex-wrap items-center gap-2">
          {retryable ? (
            <button type="button" onClick={reload} disabled={retryLocked} className={buttonClasses("default", "sm")}>
              다시 시도
            </button>
          ) : null}
          {openOriginal}
        </div>
        {retryable && retryLocked && wait ? (
          <p className="text-xs text-text-3">{`곧바로 다시 물어도 같은 답이라 약 ${wait}초 동안 다시 시도를 잠가 둡니다.`}</p>
        ) : null}
      </div>
    );
  }

  return <ArticleView entry={entry} article={response.article} />;
}

function ArticleView({ entry, article }: { entry: ArticleEntry; article: SearchArticle }) {
  const { translate: request, busy, translated, error } = useTranslate(endpoints.search.articleTranslate);
  const [showKorean, setShowKorean] = useState(false);
  const facts = articleFacts(article, entry.item);
  const flags = articleFlags(article);
  const source = httpUrl(article.sourceUrl) ?? httpUrl(entry.item.url);
  const otherTitle = article.title && article.title.trim() !== entry.item.title.trim() ? article.title.trim() : null;
  const offerTranslate = articleNeedsTranslation(article) && !translated?.textKo;
  const koreanTitle = translated?.titleKo ?? null;
  const korean = showKorean && translated?.textKo ? translated.textKo.split(/\n\s*\n/).filter((part) => part.trim()) : null;
  const paragraphs = korean ?? article.paragraphs;

  const translate = async () => {
    const result = await request({ ref: entry.ref });
    if (result?.textKo) setShowKorean(true);
  };

  return (
    <div className="mt-3 space-y-3">
      {koreanTitle ? (
        <p lang="ko" className="text-sm font-semibold leading-snug text-text-2">
          {koreanTitle}
        </p>
      ) : null}
      {otherTitle ? <p className="text-sm leading-snug text-text-2 wrap-anywhere">{`페이지 제목: ${otherTitle}`}</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {facts.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-text-3">{name}</dt>
            <dd className="min-w-0 break-words text-text-2">{value}</dd>
          </div>
        ))}
        {source ? (
          <div className="contents">
            <dt className="text-text-3">출처</dt>
            <dd className="min-w-0 break-words text-text-2">{article.sourceHost ?? entry.item.publisherDomain ?? "원문"}</dd>
          </div>
        ) : null}
      </dl>
      {flags.length > 0 ? (
        <ul aria-label="본문 표지" className="space-y-1">
          {flags.map((flag) => (
            <li key={flag} className="flex items-start gap-1.5 text-xs leading-5 text-text-2">
              <InfoIcon size={14} className="mt-0.5 shrink-0" />
              <span>{flag}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {offerTranslate ? (
          <button type="button" onClick={translate} disabled={busy} className={buttonClasses("primary", "sm")}>
            {busy ? "번역 중…" : error ? "다시 번역" : "한국어로 번역"}
          </button>
        ) : null}
        {translated?.textKo ? (
          <button type="button" onClick={() => setShowKorean((value) => !value)} className={buttonClasses("default", "sm")} aria-pressed={showKorean}>
            {showKorean ? "원문 보기" : "번역 보기"}
          </button>
        ) : null}
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            원문 열기(새 창)
            <ExternalLinkIcon size={14} />
          </a>
        ) : null}
      </div>
      {busy ? <p className="text-xs text-text-3">긴 글은 1분쯤 걸립니다. 번역은 저장하지 않고 하루 AI 글자 상한에 셉니다.</p> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {/* 스크롤 상자는 이름이 있는 영역 — 키보드로 들어와 화살표·Page 키로 스크롤합니다(WCAG 2.1.1). */}
      <div
        role="region"
        tabIndex={0}
        aria-label="본문"
        lang={korean ? "ko" : (article.lang ?? undefined)}
        className={`max-h-[60dvh] overflow-y-auto rounded-control border border-border bg-surface p-3 ${FOCUS_RING}`}
      >
        <div className="max-w-[72ch] space-y-3 text-running text-text break-words">
          {paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>
      <p className="text-xs leading-5 text-text-3">
        운영 서버가 방금 받은 페이지에서 본문만 추린 것이라 표·그림·일부 문단이 빠지거나 다를 수 있습니다. 저장하지 않고(서버 메모리 24시간) 개인
        열람용으로만 보입니다 — 저작권은 원 매체에 있습니다.
        {korean ? ` 번역은 ${translatedBy(translated ?? { model: null })}이(가) 옮긴 것이라 숫자·고유명사는 원문과 대조하세요.` : ""}
      </p>
    </div>
  );
}
