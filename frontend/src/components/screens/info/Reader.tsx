"use client";

import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useScrollRegion } from "@/components/patterns/useScrollRegion";
import { Banner, ErrorState, Loading, buttonClasses } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useTranslate } from "@/hooks/useTranslate";
import { endpoints } from "@/lib/endpoints";
import { type InfoItemResponse, type ReaderEntry, offersTranslate, translatedBy } from "@/lib/info";

/**
 * 원문 읽기(ADR 0037) — 받아 둔 원문(본문, 없으면 요약)과 번역 단추·원문/번역 바꾸기·원문 링크·안내 글. 정보 수집 뉴스·글의 원문 검사 칸
 * (NewsSection — 옆 칸·좁은 배치 대화상자)과 정보 검색 피드의 원문 팝업(ReaderDialog)이 함께 쓰는 내용입니다. 열어도 수집은 일어나지 않습니다 — 수집 글의
 * 본문은 id로 저장본을 읽습니다.
 */
export function Reader({ entry }: { entry: ReaderEntry }) {
  // 수집 글의 본문은 열 때 id로 읽습니다(목록 응답에는 본문이 없음). 사건 뉴스는 목록이 준 요약이 전부입니다.
  const stored = useApi<InfoItemResponse>(entry.itemId && entry.hasBody ? endpoints.info.item(entry.itemId) : null);
  const original = entry.itemId ? (stored.data?.item?.body ?? stored.data?.item?.summary ?? null) : entry.text;
  const { translate: request, busy, translated, error } = useTranslate();
  const [showKorean, setShowKorean] = useState(false);
  // 번역 단추는 요청 동안 disabled가 아니라 aria-disabled입니다 — 누른 단추가 disabled가 되면 크롬이 포커스를 body로 보내고, 넓은 틀의 옆 칸에는
  // 대화상자처럼 되살리는 포커스 가두기가 없습니다(QA-887). 다시 그리기 전에 두 번 눌러도 한 번만 보내게 누름을 여기서 막습니다(정보 검색 원문 팝업과 같은 꼴).
  const inFlight = useRef(false);
  // 성공으로 번역 단추가 사라지면(옮길 것이 없음) 포커스를 '원문 보기' 전환 단추로 — 누를 때 그 단추에 포커스가 있었고 그 사이 다른 곳으로 옮기지 않았을 때만.
  // 옮기는 것은 응답을 그린 뒤입니다(상태로 두어 한 번 더 그린 효과에서 — 이미 '번역 보기'였던 두 번째 성공에도).
  const [refocus, setRefocus] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (toggle.current ?? actions.current?.querySelector<HTMLElement>("button, a[href]"))?.focus();
  }, [refocus]);

  const translate = async (event: MouseEvent<HTMLButtonElement>) => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    const button = event.currentTarget;
    const hadFocus = document.activeElement === button;
    try {
      const result = await request(
        entry.itemId ? { itemId: entry.itemId } : { title: entry.titleKo ? undefined : entry.title, text: entry.text ?? undefined },
      );
      if (result && (result.textKo || result.titleKo || result.alreadyKorean)) {
        const active = document.activeElement;
        if (hadFocus && (active === button || active === document.body || active === null)) setRefocus(true);
        setShowKorean(true);
      }
    } finally {
      inFlight.current = false;
    }
  };

  const loading = !!entry.itemId && entry.hasBody && stored.loading && !stored.data;
  const koreanTitle = translated?.titleKo ?? entry.titleKo;
  const shown = showKorean && translated?.textKo ? translated.textKo : original;
  // 본문 상자 — 넘칠 때만 Tab 정지점·이름 있는 영역(공용 계약 useScrollRegion, QA-939 — 재기 전·잴 수 없으면 정지점). 글이 바뀌면 다시 잽니다(QA-904).
  const bodyBox = useRef<HTMLDivElement>(null);
  const { regionProps: bodyRegion } = useScrollRegion(bodyBox, "본문 (스크롤)", { axis: "y", enabled: Boolean(shown), watch: shown });
  // 일부만 번역된 응답(제목만 옮기고 본문은 실패) 뒤에도 단추를 남깁니다 — 다시 누르면 서버가 남은 부분만 옮깁니다(QA-409).
  const offerTranslate = !loading && offersTranslate(entry, original, translated);
  const retry = translated !== null || error !== null;

  return (
    <div className="mt-3 space-y-3">
      {koreanTitle && (
        <p lang="ko" className="text-[14px] font-semibold leading-snug text-text-2">
          {koreanTitle}
        </p>
      )}
      <div ref={actions} className="flex flex-wrap items-center gap-2">
        {offerTranslate && (
          <button
            type="button"
            onClick={(event) => void translate(event)}
            aria-disabled={busy || undefined}
            className={`${buttonClasses("primary", "sm")} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
          >
            {busy ? "번역 중…" : retry ? "다시 번역" : "한국어로 번역"}
          </button>
        )}
        {translated?.textKo && (
          <button
            ref={toggle}
            type="button"
            onClick={() => setShowKorean((value) => !value)}
            className={buttonClasses("secondary", "sm")}
            aria-pressed={showKorean}
          >
            {showKorean ? "원문 보기" : "번역 보기"}
          </button>
        )}
        {entry.url && (
          <a href={entry.url} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
            원문 열기(새 창)
          </a>
        )}
      </div>
      {busy && <p className="text-xs text-text-3">긴 글은 1분쯤 걸립니다. 한 번 번역한 글은 저장되어 다음에는 바로 뜹니다.</p>}
      {error && <Banner tone="danger">{error}</Banner>}
      {translated?.alreadyKorean && !translated.textKo && <p className="text-xs text-text-3">이미 한국어 글이라 번역하지 않았습니다.</p>}
      {translated?.truncated && <p className="text-xs text-text-3">글이 길어 앞부분(40,000자)만 번역했습니다.</p>}
      {loading && <Loading />}
      {stored.error && <ErrorState message={stored.error} onRetry={stored.reload} />}
      {shown ? (
        // 본문 상자는 놓인 면과 다른 면(bg-bg — 페이지 바탕)과 1px 경계로 가릅니다 — 대화상자 덮개 면(surface-2) 위에서 예전 surface-2/60이 묻혔음(QA-838).
        <div
          ref={bodyBox}
          {...bodyRegion}
          lang={showKorean && translated?.textKo ? "ko" : undefined}
          className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap rounded-control border border-border bg-bg p-3 text-[13px] leading-6 text-text"
        >
          {shown}
        </div>
      ) : (
        !loading && !stored.error && <p className="text-sm text-text-2">받아 둔 본문이 없습니다.</p>
      )}
      <p className="text-xs leading-5 text-text-3">
        {entry.note}
        {showKorean && translated?.textKo ? ` 번역은 ${translatedBy(translated)}이(가) 옮긴 것이라 숫자·고유명사는 원문과 대조하세요.` : ""}
      </p>
    </div>
  );
}
