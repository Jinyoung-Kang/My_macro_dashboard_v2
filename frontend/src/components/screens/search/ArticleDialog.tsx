"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Banner, buttonClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { ExternalLinkIcon, InfoIcon, SpinnerIcon } from "@/components/ui/icons";
import { useArticleBody } from "@/hooks/useArticleBody";
import { useTranslate } from "@/hooks/useTranslate";
import { endpoints } from "@/lib/endpoints";
import { translatedBy } from "@/lib/info";
import {
  articleAnnouncement,
  articleFacts,
  articleFlags,
  articleNeedsTranslation,
  articleReasonText,
  articleWaitText,
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
      titleLang={entry?.item.lang ?? undefined}
      description={entry ? `${entry.label} · ${itemTimeText(entry.item)}` : undefined}
      size="lg"
      placement="top"
    >
      {entry && <ArticleBody key={entry.ref} entry={entry} />}
    </Dialog>
  );
}

/** 한국어는 낱말 사이에서만 줄을 바꾸고 공백 없는 긴 토큰(주소 등)만 칸 안에서 꺾습니다(공용 글 부품 규약 QA-568·QA-664). */
const KEEP = "break-keep wrap-break-word";

function ArticleBody({ entry }: { entry: ArticleEntry }) {
  const { phase, response, failure, retryLocked, reload } = useArticleBody(entry.ref);
  // 번역 단계의 알림(번역 중·했음·못 함) — 있으면 단계 알림 대신 상태 줄에 둡니다. 다시 받으면 지웁니다.
  const [note, setNote] = useState<string | null>(null);
  // 단계가 바뀌어도 그대로 남는 자리 — '다시 시도'·'다시 확인'을 누르면 그 단추가 사라지므로 포커스를 여기로 옮깁니다(대화상자 틀로 떨어지지 않게).
  const place = useRef<HTMLDivElement>(null);
  const original = httpUrl(entry.item.url);
  const openOriginal = original ? (
    <a href={original} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
      원문 열기(새 창)
      <ExternalLinkIcon size={14} />
    </a>
  ) : null;
  const again = () => {
    place.current?.focus();
    setNote(null);
    reload();
  };

  const article = phase === "done" ? (response?.article ?? null) : null;
  const reason = failure ?? articleReasonText(response ?? { available: false });
  const announcement = note ?? articleAnnouncement(phase === "done" && !article ? "error" : phase, reason, article?.paragraphs.length ?? 0);

  let content: ReactNode;
  if (phase === "loading") {
    content = (
      <div className="space-y-3" aria-busy="true">
        <p className={`flex items-center gap-2 text-sm text-text-2 ${KEEP}`}>
          <SpinnerIcon size={16} className="shrink-0 motion-safe:animate-spin" />
          운영 서버가 글을 받는 중입니다(보통 몇 초, 길면 1분)
        </p>
        <div className="flex flex-wrap items-center gap-2">{openOriginal}</div>
      </div>
    );
  } else if (phase === "stalled") {
    content = (
      <div className="space-y-3">
        <p className={`text-sm text-text-2 ${KEEP}`}>아직 받는 중입니다 — 서버가 이 글을 끝까지 받지 못했습니다. 잠시 뒤 다시 확인하세요.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={again} className={buttonClasses("default", "sm")}>
            다시 확인
          </button>
          {openOriginal}
        </div>
      </div>
    );
  } else if (!article) {
    const retryable = failure !== null || response?.retryable === true || response?.available === false;
    const wait = response?.retryAfterSeconds ?? null;
    content = (
      <div className="space-y-3">
        <Banner tone="warn">
          <span className={KEEP}>{reason}</span>
        </Banner>
        <div className="flex flex-wrap items-center gap-2">
          {retryable ? (
            <button type="button" onClick={again} disabled={retryLocked} className={buttonClasses("default", "sm")}>
              다시 시도
            </button>
          ) : null}
          {openOriginal}
        </div>
        {retryable && retryLocked && wait ? (
          <p className={`text-xs text-text-3 ${KEEP}`}>{`곧바로 다시 물어도 같은 답이라 ${articleWaitText(wait)} 동안 다시 시도를 잠가 둡니다.`}</p>
        ) : null}
      </div>
    );
  } else {
    content = <ArticleView entry={entry} article={article} announce={setNote} />;
  }

  return (
    <div ref={place} tabIndex={-1} className="mt-3 space-y-3 outline-none">
      {/* 받는 중 → 받음·실패·멈춤과 번역의 진행·끝을 알리는 상태 줄 — 단계와 상관없이 늘 붙어 있어야 바뀐 글이 읽힙니다(aria-busy 밖). */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {content}
    </div>
  );
}

function ArticleView({ entry, article, announce }: { entry: ArticleEntry; article: SearchArticle; announce: (note: string | null) => void }) {
  const { translate: request, busy, translated, error } = useTranslate(endpoints.search.articleTranslate);
  const [showKorean, setShowKorean] = useState(false);
  // 번역이 끝나면 번역 단추가 사라지므로 포커스를 '원문 보기' 전환 단추로 옮깁니다(번역을 키보드로 눌렀을 때 자리를 잃지 않게).
  const toggle = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  // 다시 그리기 전에 두 번 눌러도 한 번만 보내게(aria-disabled는 다시 그린 뒤에 걸림 — AliasEditor와 같은 꼴).
  const inFlight = useRef(false);
  const facts = articleFacts(article, entry.item);
  const flags = articleFlags(article);
  const source = httpUrl(article.sourceUrl) ?? httpUrl(entry.item.url);
  const otherTitle = article.title && article.title.trim() !== entry.item.title.trim() ? article.title.trim() : null;
  const offerTranslate = articleNeedsTranslation(article) && !translated?.textKo;
  const koreanTitle = translated?.titleKo ?? null;
  const korean = showKorean && translated?.textKo ? translated.textKo.split(/\n\s*\n/).filter((part) => part.trim()) : null;
  const paragraphs = korean ?? article.paragraphs;
  const bodyLang = korean ? "ko" : (article.lang ?? undefined);
  // 한 줄 길이 — '0' 글자 폭(ch) 기준이라 비례 글꼴의 라틴 글은 72ch면 한 줄 약 90자가 됩니다. 한국어가 아닌 글은 60ch(약 75자 — WCAG 1.4.8의 80자 이하).
  const measure = bodyLang === "ko" ? "max-w-[72ch]" : "max-w-[60ch]";

  useEffect(() => {
    if (error) announce(`번역하지 못했습니다: ${error}`);
  }, [error, announce]);

  useEffect(() => {
    if (moveFocus.current && showKorean && toggle.current) {
      moveFocus.current = false;
      toggle.current.focus();
    }
  }, [showKorean]);

  const translate = async () => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    announce("번역 중입니다 — 긴 글은 1분쯤 걸립니다");
    try {
      const result = await request({ ref: entry.ref });
      if (result?.textKo) {
        moveFocus.current = true;
        setShowKorean(true);
        announce("번역했습니다 — 번역 보기로 바꿨습니다");
      }
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <div className="space-y-3">
      {koreanTitle ? (
        <p lang="ko" className={`text-sm font-semibold leading-snug text-text-2 ${KEEP}`}>
          {koreanTitle}
        </p>
      ) : null}
      {otherTitle ? (
        <p className="text-sm leading-snug text-text-2 wrap-anywhere">
          페이지 제목: <span lang={article.lang ?? undefined}>{otherTitle}</span>
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {facts.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-text-3">{name}</dt>
            <dd className={`min-w-0 text-text-2 ${KEEP}`}>{value}</dd>
          </div>
        ))}
        {source ? (
          <div className="contents">
            <dt className="text-text-3">출처</dt>
            <dd className={`min-w-0 text-text-2 ${KEEP}`}>{article.sourceHost ?? entry.item.publisherDomain ?? "원문"}</dd>
          </div>
        ) : null}
      </dl>
      {flags.length > 0 ? (
        <ul aria-label="본문 표지" className="space-y-1">
          {flags.map((flag) => (
            <li key={flag} className="flex items-start gap-1.5 text-xs leading-5 text-text-2">
              <InfoIcon size={14} className="mt-0.5 shrink-0" />
              <span className={KEEP}>{flag}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {offerTranslate ? (
          // 처리 중에도 disabled로 바꾸지 않습니다(포커스가 대화상자 밖 body로 떨어짐) — aria-disabled로 알리고 누름은 한 번만 보냅니다.
          <button
            type="button"
            onClick={() => void translate()}
            aria-disabled={busy || undefined}
            className={`${buttonClasses("primary", "sm")} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
          >
            {busy ? "번역 중…" : error ? "다시 번역" : "한국어로 번역"}
          </button>
        ) : null}
        {translated?.textKo ? (
          <button
            ref={toggle}
            type="button"
            onClick={() => setShowKorean((value) => !value)}
            className={buttonClasses("default", "sm")}
            aria-pressed={showKorean}
          >
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
      {busy ? <p className={`text-xs text-text-3 ${KEEP}`}>긴 글은 1분쯤 걸립니다. 번역은 저장하지 않고 하루 AI 글자 상한에 셉니다.</p> : null}
      {error ? (
        <Banner tone="danger">
          <span className={KEEP}>{error}</span>
        </Banner>
      ) : null}
      {/*
        스크롤은 대화상자 하나만 합니다 — 본문 상자를 따로 스크롤하면 위의 사실·단추가 높이를 먼저 차지해 상자 아래 끝과 맺음 글이 대화상자 밖으로
        잘렸습니다(가로로 눕힌 휴대폰에서는 처음에 본문이 보이지 않음). 대화상자 안에 단추·링크가 있어 키보드로도 스크롤됩니다.
      */}
      <div role="region" aria-label="본문" lang={bodyLang} className="rounded-control border border-border bg-surface p-3">
        <div className={`${measure} space-y-3 text-running text-text ${KEEP}`}>
          {paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>
      <p className={`text-xs leading-5 text-text-3 ${KEEP}`}>
        운영 서버가 방금 받은 페이지에서 본문만 추린 것이라 표·그림·일부 문단이 빠지거나 다를 수 있습니다. 저장하지 않고(서버 메모리 24시간) 개인
        열람용으로만 보입니다 — 저작권은 원 매체에 있습니다.
        {korean ? ` 번역은 ${translatedBy(translated ?? { model: null })}이(가) 옮긴 것이라 숫자·고유명사는 원문과 대조하세요.` : ""}
      </p>
    </div>
  );
}
