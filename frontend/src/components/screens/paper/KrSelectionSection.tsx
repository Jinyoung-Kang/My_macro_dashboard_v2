"use client";

import type { ReactNode } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Banner, Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { PAPER_SOURCES } from "@/lib/paper";
import {
  type KrCell,
  type KrMemberNote,
  type KrMemberRow,
  KR_FINANCIAL_TABLE_CHECK,
  KR_SELECTION_LIMIT,
  krSelectionPicks,
  krSelectionReference,
  krSelectionView,
  type KrSelectionView,
} from "@/lib/paperKr";
import type { PaperDecisionDetailResponse, PaperDecisionsResponse } from "@/lib/types";

/** 첫 선정이 무엇인지 — 출발 전(결정 기록 없음)의 안내. */
const NO_SELECTION_YET =
  "아직 한국 규칙 계좌의 선정 기록이 없습니다 — 첫 선정은 출발 결정입니다(출발일 밤 결정 창, 네 계좌가 함께 다음 KR 거래일 시가에 출발). "
  + "그 뒤에는 재선정일(설정 kr.rules.reselection — 기본 그 달 첫 KR 거래일)마다 다시 고르고, 재선정일 결정이 게이트·기한으로 빠지면 다음 KR "
  + "결정일에 그날 자료로 따라잡습니다.";

/**
 * 한국 종목 선정 탭(2단계 명세 §4-6·§5·§6 — 한국 규칙 계좌의 재선정). 미국 '기관 선정'(13F 트랙레코드)과 달리 새 API가 없고, 한국 규칙 계좌
 * 결정 기록에서 선정한 가장 최근 결정(재선정·출발 — 결정 행의 selectionAsOf)을 골라 그 결정 한 건의 입력 동결본을 읽습니다(결정 때 읽은 그대로 —
 * 지금 다시 계산하지 않음).
 *
 * 위에서부터: 선정 요약(주식·153130 비중·후보 수/상한·목표 종목·고르지 않은 후보)과 '금융업 코드 표 확인 필요' 경고, 가장 최근 결정이 선정한 결정이
 * 아니면 그 결정의 후보를 '참고 — 매수하지 않음' 한 줄로, 제외 표(사유별 수)와 '자료 없음' 사유, 유니버스 구성원 표(정렬·가로 스크롤), 입력(U 기준일·
 * 수급 창·저장본 시각·DART 접수일 규칙·금융업 표 판). 숫자·판정은 서버 값이고 표기는 lib/paperKr가 고릅니다(ADR 0004).
 */
export function KrSelectionSection() {
  const list = useApi<PaperDecisionsResponse>(endpoints.paper.decisions("kr_rules", KR_SELECTION_LIMIT), 300_000);
  const picks = krSelectionPicks(list.data?.available ? list.data.decisions : null);
  const selectionId = picks.selection?.id ?? null;
  // 가장 최근 결정이 선정한 결정과 다를 때만 따로 읽습니다(같으면 한 번).
  const latestId = picks.latest && picks.latest.id !== selectionId ? picks.latest.id : null;
  const selected = useApi<PaperDecisionDetailResponse>(selectionId === null ? null : endpoints.paper.decision(selectionId));
  const latest = useApi<PaperDecisionDetailResponse>(latestId === null ? null : endpoints.paper.decision(latestId));

  if (list.loading && !list.data) return <Loading label="한국 규칙 계좌 결정 기록을 읽는 중…" />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  if (!list.data.available) return <Banner tone="warn">{list.data.message ?? "결정 기록을 읽을 수 없습니다."}</Banner>;

  const reference = latest.data?.available ? krSelectionReference(latest.data.decision) : null;
  const referenceLine = latestId === null ? null : latest.error ? (
    <p className="text-xs text-warn">가장 최근 결정(#{latestId})을 읽지 못했습니다 — {latest.error}</p>
  ) : reference ? (
    <p className="text-xs leading-relaxed text-body">{reference}</p>
  ) : null;

  if (selectionId === null) {
    return (
      <Card title="종목 선정(한국 규칙 계좌)" source={PAPER_SOURCES.krSelection} actions={<Freshness refreshError={list.refreshError} />}>
        <p className="text-sm leading-relaxed text-muted">{NO_SELECTION_YET}</p>
        {referenceLine && <div className="mt-3">{referenceLine}</div>}
      </Card>
    );
  }

  if (selected.loading && !selected.data) return <Loading label="선정 기록을 읽는 중…" />;
  if (selected.error) return <ErrorState message={`선정 기록(#${selectionId})을 읽지 못했습니다 — ${selected.error}`} onRetry={selected.reload} />;
  if (!selected.data) return null;
  if (!selected.data.available) return <Banner tone="warn">{selected.data.message ?? "선정 기록을 읽을 수 없습니다."}</Banner>;

  const view = krSelectionView(selected.data.decision);

  return (
    <>
      <Card
        title="종목 선정(한국 규칙 계좌)"
        subtitle="코스피 시총 상위 100 보통주(U) 가운데 외국인·기관의 20거래일 누적 순매수가 둘 다 0보다 큰 종목을 점수(두 순매수 합 ÷ 상장주식수) 순으로 — 재선정일·출발 때만 삽니다. 결정 때 읽은 입력 그대로입니다."
        source={PAPER_SOURCES.krSelection}
        actions={<Freshness refreshError={list.refreshError ?? selected.refreshError} />}
      >
        <div className="flex flex-col gap-4">
          <Cells cells={view.head} />
          {view.summary && <p className="text-xs text-body">{view.summary}</p>}
          {!view.recognized && (
            <Banner tone="warn">이 결정 기록에는 입력 구성원(input.members)이 없어 선정 표를 그릴 수 없습니다 — 결정 로그 탭에서 원래 기록을 보세요.</Banner>
          )}
          {view.financialChecks.length > 0 && (
            <Banner tone="warn">
              <strong>{KR_FINANCIAL_TABLE_CHECK}</strong> — 금융업 코드 표 밖이라 부채비율 상한으로 빠졌는데 DART에 &apos;유동자산&apos; 계정이 없는
              회사입니다(금융업식 재무상태표 — 표에 빠진 금융사일 수 있음). 코드 표를 고칠지 확인하세요.
              <NoteList label="금융업 코드 표 확인 필요" notes={view.financialChecks} />
            </Banner>
          )}
          {view.cells.length > 0 && (
            <Part title="선정 요약" note={view.cellsNote ?? undefined}>
              <Cells cells={view.cells} />
            </Part>
          )}
          {view.targets.length > 0 && (
            <Part title="매수 목표" note="배분 순서·점수·목표 비중 — 남는 비중은 153130(현금성)입니다.">
              {/* 열이 넷뿐이라 폭을 강제하지 않는 DataTable(390px에서도 한 화면) — ui Table은 최소 640px라 좁은 화면에서 비중이 가려짐. */}
              <DataTable<KrSelectionView["targets"][number]>
                caption="매수 목표"
                rows={view.targets}
                rowKey={(row) => row.key}
                columns={[
                  { key: "rank", header: "순서", align: "right", cell: (row) => row.rank },
                  { key: "code", header: "종목", rowHeader: true, cell: (row) => <CodeName code={row.code} name={row.name} /> },
                  { key: "score", header: "점수", align: "right", cell: (row) => row.score },
                  { key: "weight", header: "목표 비중", align: "right", cell: (row) => row.weight },
                ]}
              />
            </Part>
          )}
          {view.notChosen.length > 0 && (
            <p className="text-xs leading-relaxed text-body">
              <span className="text-muted">후보였지만 고르지 않음(종목 수 상한·배분 밖) — </span>
              {view.notChosen.join(", ")}
            </p>
          )}
          {referenceLine}
        </div>
      </Card>

      {view.recognized && (
        <Card title="제외" subtitle="후보에서 빠진 사유별 종목 수(남기는 순서 — 거래정지 → 재진입 금지 → 자료 부족 → 수급 미달 → 연속 순매수 미달 → 자료 없음 → 재무 미달)">
          <div className="flex flex-col gap-4">
            <DataTable<KrSelectionView["exclusions"][number]>
              caption="제외"
              rows={view.exclusions}
              rowKey={(row) => row.key}
              emptyText="빠진 종목이 없습니다."
              columns={[
                { key: "reason", header: "사유", rowHeader: true, cell: (row) => row.reason },
                { key: "count", header: "종목 수", align: "right", cell: (row) => row.count },
              ]}
            />
            <Part
              title="자료 없음 사유"
              note="DART 재무·접수일·ROE·부채비율·상장주식수를 셀 수 없어 후보에서 뺀 종목입니다(0으로 채우지 않음 — 2단계 명세 §5)."
            >
              {view.noData.length > 0 ? (
                <NoteList label="자료 없음 사유" notes={view.noData} />
              ) : (
                <p className="text-xs text-muted">자료 없음으로 빠진 종목이 없습니다.</p>
              )}
            </Part>
          </div>
        </Card>
      )}

      {view.recognized && (
        <Card
          title={`유니버스 구성원(U ${view.members.length}종목)`}
          subtitle="U 순위 순 — 머리를 누르면 정렬합니다. 수급은 주(토스증권, 결정 때 읽은 20거래일 창), 재무는 DART 접수일이 기준 세션 이하인 것만."
          source={PAPER_SOURCES.krSelection}
        >
          <DataTable<KrMemberRow>
            columns={MEMBER_COLUMNS}
            rows={view.members}
            rowKey={(row) => row.key}
            caption="유니버스 구성원"
            emptyText="구성원이 없습니다."
            maxHeight={560}
            scrollHint="overflow"
          />
        </Card>
      )}

      {view.input.length > 0 && (
        <Card title="입력" subtitle="결정이 읽은 자료 — 금융위원회(공공데이터포털) 유니버스·토스증권 수급·금융감독원 DART 재무.">
          <Cells cells={view.input} />
          {view.notes.length > 0 && (
            <ul aria-label="처리 메모" className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-body">
              {view.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

/**
 * 구성원 표의 열 — 숫자 열은 오른쪽 정렬·정렬 단추, 모르는 값은 "—"(DataTable이 그림). 순서는 순위·종목 다음에 후보·점수·사유(판정과 그 까닭)를
 * 먼저 두고 수급·재무 원자료를 뒤에 — 열 열넷이라 1280px 카드에서도 가로로 넘치므로, 넘겨 보지 않아도 판정과 사유가 보이게.
 */
const MEMBER_COLUMNS: Column<KrMemberRow>[] = [
  { key: "rank", header: "순위", align: "right", cell: (row) => row.text.rank, sortValue: (row) => row.rank },
  {
    key: "code",
    header: "종목",
    rowHeader: true,
    className: "whitespace-nowrap",
    cell: (row) => <CodeName code={row.code} name={row.name} />,
    sortValue: (row) => row.code,
  },
  {
    key: "candidate",
    header: "후보",
    className: "whitespace-nowrap",
    cell: (row) => (
      <span className={row.target ? "font-semibold text-text" : row.candidate === false ? "text-text-3" : "text-text-2"}>{row.text.candidate}</span>
    ),
    sortValue: (row) => (row.target ? 0 : row.candidate === true ? 1 : row.candidate === false ? 2 : null),
  },
  { key: "score", header: "점수", align: "right", cell: (row) => row.text.score, sortValue: (row) => row.score },
  {
    key: "reasons",
    header: "사유",
    className: "min-w-64",
    cell: (row) => (
      // relative — 안의 sr-only(절대 위치)가 가로 스크롤 상자 밖 문서 폭을 넓히지 않게(가려진 칸에서도 상자 안에 머묾).
      <span className={`relative text-xs ${row.financialCheck ? "text-warn" : "text-text-2"}`}>
        {row.financialCheck && <span className="sr-only">주의: </span>}
        {row.text.reasons}
      </span>
    ),
  },
  { key: "marketCap", header: "시총(조 원)", align: "right", cell: (row) => row.text.marketCap, sortValue: (row) => row.marketCap },
  { key: "foreign20", header: "외국인 20일(주)", align: "right", cell: (row) => signed(row.text.foreign20, row.foreign20), sortValue: (row) => row.foreign20 },
  {
    key: "institution20",
    header: "기관 20일(주)",
    align: "right",
    cell: (row) => signed(row.text.institution20, row.institution20),
    sortValue: (row) => row.institution20,
  },
  { key: "foreign5", header: "외국인 5일(주)", align: "right", cell: (row) => signed(row.text.foreign5, row.foreign5), sortValue: (row) => row.foreign5 },
  {
    key: "institution5",
    header: "기관 5일(주)",
    align: "right",
    cell: (row) => signed(row.text.institution5, row.institution5),
    sortValue: (row) => row.institution5,
  },
  { key: "streak", header: "연속일", align: "right", cell: (row) => row.text.streak, sortValue: (row) => row.streak },
  { key: "roe", header: "ROE", align: "right", cell: (row) => row.text.roe, sortValue: (row) => row.roePct },
  { key: "debtRatio", header: "부채비율", align: "right", cell: (row) => row.text.debtRatio, sortValue: (row) => row.debtRatioPct },
  { key: "financial", header: "금융업", cell: (row) => row.text.financial, className: "whitespace-nowrap" },
];

/**
 * 순매수(주) 칸 — 부호가 글자에 있습니다(+·-). 상승·하락 색(up·down)은 가격 변화 전용이라 순매수·순매도에 쓰지 않습니다(UI 설계 §3).
 */
function signed(text: string, value: number | null) {
  return <span className={value === null ? "text-text-3" : "text-text"}>{text}</span>;
}

/** 코드(줄바꿈 없음) + 이름 — 좁은 화면에서는 이름이 다음 줄로 내려갑니다(구성원 표는 열이 whitespace-nowrap이라 한 줄). */
function CodeName({ code, name }: { code: string; name: string }) {
  return (
    <span>
      <span className="whitespace-nowrap font-semibold text-bright">{code}</span>
      {name && name !== "—" && <span className="ml-1 text-xs text-text-2">{name}</span>}
    </span>
  );
}

function NoteList({ label, notes }: { label: string; notes: KrMemberNote[] }) {
  return (
    <ul aria-label={label} className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
      {notes.map((note) => (
        <li key={note.key}>
          <span className="font-semibold">{note.label}</span> — {note.detail}
        </li>
      ))}
    </ul>
  );
}

function Cells({ cells }: { cells: KrCell[] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
      {cells.map((cell) => (
        <div key={cell.key} className="min-w-0">
          <dt className="text-muted">{cell.label}</dt>
          <dd className="break-words tabular-nums font-semibold text-bright">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 카드 안의 한 부분 — 결정 로그 탭과 같은 모양(제목 h3이 영역 이름). */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-bright">{title}</h3>
      {note && <p className="text-[11px] leading-relaxed text-muted">{note}</p>}
      {children}
    </section>
  );
}
