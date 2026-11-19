import type { JSX, ReactNode } from "react";

import { FOCUS_RING } from "@/components/ui/classes";

import { Empty } from "./Empty";

/** 상자 높이 한도 — 넘으면 상자 안에서 스크롤합니다. */
const MAX_HEIGHT = { sm: "max-h-[20rem]", md: "max-h-[30rem]", lg: "max-h-[40rem]" } as const;

/**
 * 줄바꿈 — anywhere: 칸보다 긴 낱말(경로·키·URL이 붙은 로그 한 줄)은 아무 데서나 꺾음(예전 break-all 대신 — 짧은 낱말은 그대로 둠, 한국어 낱말도
 * 낱말 사이에서만 — break-keep: 없으면 한글 음절 사이가 모두 줄바꿈 기회라 '태스|크'처럼 꺾였음, QA-872),
 * word: 낱말 사이에서만 꺾고(한국어도 — break-keep) 칸보다 긴 낱말만 그 안에서 꺾음(긴 글 원문).
 */
const WRAP = { anywhere: "break-keep wrap-anywhere", word: "break-keep wrap-break-word" } as const;

/** 글색 — plain 본문 보조(text-2), muted 한 단계 옅게(text-3 — AI 입력 원본처럼 참고로 펼친 글). */
const TONE = { plain: "text-text-2", muted: "text-text-3" } as const;

export type LogPanelHeight = keyof typeof MAX_HEIGHT;
export type LogPanelWrap = keyof typeof WRAP;
export type LogPanelTone = keyof typeof TONE;

/**
 * 로그·원문 글 상자(작업대 P7 — 저장소 상태의 수집 오류·경고 로그, AI 리포트 원문(Markdown)·AI 입력 원본, 연결 테스트의 토스 조회 JSON이 따로 적던 `<pre>`를 하나로).
 * 받은 글을 손대지 않고 그대로(공백·줄바꿈 유지 — whitespace-pre-wrap) 고정폭 12/20(text-micro — 12px 하한, leading-5)으로 보이고, 높이 한도(`maxHeight` — 20·30·40rem)를
 * 넘으면 상자 안에서 스크롤합니다. 바탕은 화면 바탕(bg-bg — 패널 surface 위에서 한 단계 내려앉은 글 상자) + 1px 경계 + 4px 모서리.
 *
 * - 값 있음: 글이 있으면 상자는 늘 Tab 정지점(tabIndex 0)이고 이름 있는 영역 '{label} (스크롤)'입니다 — 키보드로 상자 안을 스크롤할 수 있게(공용 표의 가로 스크롤
 *   상자 '{표 이름} (좌우 스크롤)'과 같은 규칙). 넘칠 때만 정지점을 두는 규칙은 기록된 결정 거리(datatable-scroll-region-tabstop-without-overflow)와 함께 정하므로
 *   여기서는 재지 않습니다. 포커스 링은 공용 FOCUS_RING.
 * - 빈 글('' 또는 공백만): 상자 없이 `emptyText`(기본 '내용이 없습니다.') 한 줄 — 빈 상자를 남기지 않습니다.
 * - 모름(null·undefined — 받지 못함): 상자 없이 공용 '—'(Empty — 읽기 '값 없음') + 사유(`emptyReason`, 기본 '받지 못함'). 0이나 빈 상자를 만들지 않습니다.
 * - 추정·대리·이전 값 배지는 이 패턴에 해당 없음: 글 원문을 그대로 보이는 상자라 값 꼬리표가 붙을 숫자가 없습니다(배지는 부르는 쪽 패널 머리가 붙임).
 *
 * 복사 단추는 넣지 않습니다 — 부르는 쪽 패널 머리의 CopyButton(지금 자리 그대로). 데이터 영역이라 강조 파랑을 쓰지 않습니다(데이터 칸 강조색 금지 목록).
 */
export function LogPanel({
  label,
  text,
  emptyText = "내용이 없습니다.",
  emptyReason = "받지 못함",
  maxHeight = "md",
  wrap = "anywhere",
  tone = "plain",
}: {
  /** 영역 이름의 앞부분 — 상자 이름은 '{label} (스크롤)'. */
  label: string;
  /** 보일 글(그대로). null·undefined면 모름('—' + 사유), 빈 글이면 `emptyText`. */
  text: string | null | undefined;
  /** 빈 글일 때 보일 것 — 기본 '내용이 없습니다.' */
  emptyText?: ReactNode;
  /** 모를 때 '—' 옆 사유 — 기본 '받지 못함'. */
  emptyReason?: string;
  /** 높이 한도 — sm 20rem·md 30rem(기본)·lg 40rem. */
  maxHeight?: LogPanelHeight;
  /** 줄바꿈 — anywhere(기본)·word. */
  wrap?: LogPanelWrap;
  /** 글색 — plain(기본, text-2)·muted(text-3). */
  tone?: LogPanelTone;
}): JSX.Element {
  if (text === null || text === undefined) {
    return (
      <p className="text-sm text-text-2">
        <Empty reason={emptyReason} />
      </p>
    );
  }
  if (text.trim() === "") {
    return <p className="text-sm text-text-3">{emptyText}</p>;
  }
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={`${label} (스크롤)`}
      className={`${MAX_HEIGHT[maxHeight]} overflow-auto whitespace-pre-wrap ${WRAP[wrap]} rounded-control border border-border bg-bg p-3 font-mono text-micro leading-5 ${TONE[tone]} ${FOCUS_RING}`}
    >
      {text}
    </pre>
  );
}
