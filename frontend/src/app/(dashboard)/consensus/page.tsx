"use client";

import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import {
  DataTable,
  FilterList,
  type FilterListPendingRow,
  type InspectorContext,
  InspectorFrame,
  InspectorTrigger,
  KpiStrip,
  type PropertyItem,
  PropertyList,
  Skeleton,
  SplitPane,
} from "@/components/patterns";
import {
  Callout,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Panel,
  Select,
  Tag,
} from "@/components/ui";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { CONSENSUS_BAR_LIMIT, consensusBars, securityNote } from "@/lib/consensus";
import type { KrwConversion } from "@/lib/holdings";
import { EMPTY, formatCurrency, formatNumber, formatWeightPercent } from "@/lib/format";
import {
  consensusKpis,
  consensusKpisPending,
  consensusRowItems,
  filerBadges,
  institutionChoices,
  type NewBuyRow,
  newBuyRowItems,
  participantsLine,
  securityTitles,
  selectionCountText,
  consensusCiks,
} from "@/lib/consensusScreen";
import { effectiveSelection, toggleSelection } from "@/lib/selection";
import type { ConsensusResponse, ConsensusRow, NewBuysResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 기관 13F Money 교집합.
 *
 * 여러 기관이 같은 분기에 공통 보유한 종목과, 동시 순매수/순매도가 몰린
 * 종목을 집계합니다. 기관마다 공시 분기가 다를 수 있으므로 기준 분기를
 * 고르면 그 분기를 공시한 기관만 참여합니다.
 *
 * 배치(작업대 화면 언어 — 명세 §7 4행): 머리 → 두 칸 틀(SplitPane — 오른쪽 칸 없음). 왼쪽(넓은 화면 13rem)은 '조건'(기준 분기·최소 공통
 * 보유 기관 수)과 그 아래 '분석 대상' 거르기 목록(옛 파란 기관 칩 12개 — 넓은 화면 세로 목록·좁은 화면 태그 줄바꿈), 가운데는 교집합 요약 KPI 띠(처음
 * 읽는 동안은 같은 꼴의 자리표시) → '공통 보유 상위 종목' 막대 → '교집합 상세' 표 → 참여 기관 줄 → '이번 분기 공통 신규 매수'. 좁은 화면(lg 미만)은
 * 한 칸으로 왼쪽 칸이 위입니다(접지 않음).
 */
export default function ConsensusPage() {
  const institutions = useApi<{ institutions: { name: string; cik: string }[]; favorites?: { name: string; cik: string }[] }>(
    endpoints.institution.institutions,
  );
  // 빈 목록 = 전체. 화면과 요청은 lib/selection의 유효 선택을 씁니다(QA-003).
  const [selected, setSelected] = useState<string[]>([]);
  const allCiks = (institutions.data?.institutions ?? []).map((entry) => entry.cik);
  // 13F 즐겨찾기(ADR 0048 단계 3) — 처음엔 모두 꺼짐. 하나라도 켜면 요청 ciks에 기본 12곳의 유효 선택과 함께 적습니다(켠 것이 없으면 요청은 지금 그대로).
  const favorites = institutions.data?.favorites ?? [];
  const [favoriteSelected, setFavoriteSelected] = useState<string[]>([]);
  const toggleFavorite = (cik: string) =>
    setFavoriteSelected((previous) => (previous.includes(cik) ? previous.filter((item) => item !== cik) : [...previous, cik]));
  const [reportDate, setReportDate] = useState("");
  const [minHolders, setMinHolders] = useState("2");

  const ciks = consensusCiks(allCiks, selected, favoriteSelected);
  const consensus = useApi<ConsensusResponse>(endpoints.institution.consensus({ minHolders, topN: 40, ciks, reportDate }));
  const { data, error, reload } = consensus;
  // 매크로 화면이 이미 수집하는 원/달러를 그대로 씁니다.
  const usdKrw = useUsdKrw();

  // 마지막 하나를 빼서 전체로 돌아갔는가 — 낭독기 알림 글이 그 되돌림을 말합니다(누른 단추가 '눌림'으로 남아 거꾸로 동작한 것처럼 들리지 않게).
  const [returnedToAll, setReturnedToAll] = useState(false);
  const toggle = (cik: string) => {
    const current = effectiveSelection(allCiks, selected);
    setReturnedToAll(current.length === 1 && current[0] === cik);
    setSelected((previous) => toggleSelection(allCiks, previous, cik));
  };
  // 보이는 고름(빈 목록 = 전체를 풀어 쓴 것) — 거르기 목록의 켬과 개수가 요청 ciks와 같은 규칙입니다(QA-003).
  const effective = effectiveSelection(allCiks, selected);
  const countText = selectionCountText(effective.length, allCiks.length);

  // 기준 분기 선택지는 응답에 딸려 옵니다. 고른 분기의 응답을 기다리는 동안 선택지가 '최신 분기' 하나로 줄면
  // 화면은 최신을 보이는데 요청은 고른 분기로 나갔습니다 — 마지막 목록을 씁니다(QA-047).
  const availableDates = useRemembered(data?.availableDates);
  // 이름이 겹치는 행(CUSIP으로 갈린 같은 이름)만 막대 이름표에 구분자를 붙입니다(QA-114).
  const chartData = consensusBars(data?.rows ?? []);

  // 교집합 요약 — 처음 읽는 동안(과 조건을 바꿔 다시 읽는 동안)은 같은 세 타일의 자리표시, 응답이 오면 값(저장본이 없으면 두지 않음).
  const kpis = data?.available
    ? consensusKpis(data, SOURCES.sec13f)
    : firstLoadPending(consensus)
      ? consensusKpisPending(SOURCES.sec13f)
      : [];

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader title="기관 13F Money 교집합" description="여러 기관이 공통 보유한 종목 · 동시 매수/매도 집중도" />

      {/* 왼쪽 칸 — 조건과 분석 대상 기관(거르기 목록). 좁은 화면은 한 칸으로 위에 둡니다(접지 않음 — 조작이 지금처럼 바로 보임). */}
      <SplitPane
        columns={2}
        left={
          <>
            {/* 조건을 거르기 목록 위에 둡니다 — 목록 아래면 넓은 화면에서 첫 화면 밖이었습니다(2026-11-18 결정(사용자 위임 — 권장안 가), lg-conditions-below-list). */}
            <Panel title="조건">
              <div className="flex flex-wrap items-end gap-3 lg:flex-col lg:items-stretch">
                <Select
                  label="기준 분기"
                  value={reportDate}
                  onChange={setReportDate}
                  options={[
                    { value: "", label: "각 기관의 최신 분기" },
                    ...(availableDates ?? []).map((date) => ({ value: date, label: date })),
                  ]}
                />
                <Select
                  label="최소 공통 보유 기관 수"
                  value={minHolders}
                  onChange={setMinHolders}
                  options={["2", "3", "4", "5"].map((value) => ({
                    value,
                    label: `${value}곳 이상`,
                  }))}
                />
              </div>
            </Panel>
            <Panel
              title="분석 대상" count={countText ?? undefined}
              subtitle="전체 기관이 선택된 상태에서 시작합니다. 빼고 싶은 기관을 누르세요(전부 빼면 다시 전체)."
            >
              <FilterList
                label="분석 대상 기관"
                items={institutionChoices(institutions.data?.institutions)}
                selected={effective}
                onToggle={toggle}
                selection="multiple"
                narrow="wrap"
                // 고름이 바뀌면 낭독기에 개수를 알립니다(패널 머리의 개수는 보통 글이라 읽히지 않음) — 마지막 하나를 빼 전체로 돌아가면 그 사실도.
                status={countText === null ? null : returnedToAll ? `마지막 기관을 빼서 전체로 돌아갔습니다 — 분석 대상 ${countText}` : `분석 대상 ${countText}`}
                // 목록을 아직 못 받았으면 목록 대신 — 실패면 오류(다시 시도), 처음 읽는 중이면 자리표시, 실패 뒤 다시 읽는 중이면 짧은 자리표시(같은 이름).
                // 마지막 경우에 null을 주면 거르기 목록이 빈 목록 글('고를 기관이 없습니다.')을 그려 모르는 상태를 '없다'로 적었습니다(QA-710).
                placeholder={
                  institutions.error ? (
                    <ErrorState message={institutions.error} onRetry={institutions.reload} />
                  ) : institutions.loading && institutions.data === null && !firstLoadPending(institutions) ? (
                    <Skeleton lines={2} label="기관 목록 불러오는 중" />
                  ) : null
                }
                // 처음 읽는 동안은 값이 온 뒤의 목록 꼴 자리(아래 PENDING_CONSENSUS) — 글 줄 자리표시였을 때는 목록이 오면 그때 목록 아래에 있던 '조건'과 가운데 칸이 밀렸습니다(QA-714).
                pending={firstLoadPending(institutions) ? { label: "기관 목록 불러오는 중", rows: PENDING_CONSENSUS } : null}
                emptyText="고를 기관이 없습니다."
              />
            </Panel>
            {favorites.length > 0 ? (
              <Panel
                title="즐겨찾기"
                count={favoriteSelected.length > 0 ? `${favoriteSelected.length}곳 선택` : undefined}
                subtitle="처음엔 모두 꺼져 있습니다. 누른 기관을 위 분석 대상에 더합니다."
              >
                <FilterList
                  label="교집합에 더할 즐겨찾기 기관"
                  items={institutionChoices(favorites)}
                  selected={favoriteSelected}
                  onToggle={toggleFavorite}
                  selection="multiple"
                  narrow="wrap"
                  status={favoriteSelected.length > 0 ? `즐겨찾기 ${favoriteSelected.length}곳을 더함` : "즐겨찾기를 더하지 않음"}
                />
              </Panel>
            ) : null}
          </>
        }
      >
        {error && <ErrorState message={error} onRetry={reload} />}
        {/* 실패 뒤 다시 읽는 동안(다시 시도·조건 바꿈 — useApi가 failedAt을 남김)은 공용 '불러오는 중' 한 줄(QA-655 규칙 — 13F 화면과 같음). 처음 읽는 동안은
            아래 KPI 띠 자리표시입니다. 없으면 가운데 칸이 응답까지 비었습니다(QA-710 — 개편 전 `loading && !data`의 같은 글). */}
        {consensus.loading && !data && !firstLoadPending(consensus) && <Loading label="교집합을 계산하는 중…" />}

        {data && !data.available && (
          <Callout tone="warn">
            조건을 만족하는 공통 보유 종목이 없습니다. 기준 분기나 최소 기관 수를 조정해 보세요.
          </Callout>
        )}

        {/* 읽는 중 타일은 값이 온 뒤의 꼴(값 줄 높이·첫 타일 출처 줄)로 — 값이 와도 띠 높이가 같게. */}
        {kpis.length > 0 ? <KpiStrip label="교집합 요약" items={kpis} pendingMatchesValue /> : null}

        {/*
          처음 읽는 동안은 막대·상세 표 패널도 같은 머리의 자리로 둡니다 — 없으면 값이 올 때 두 패널이 끼어들며 아래 '이번 분기 공통 신규 매수'를 화면 밖으로
          밀었습니다(QA-714). 막대 자리는 막대 15개(consensusBars의 상한 — 요청 topN 40이 보통 채움)의 차트 높이, 표 자리는 짧은 줄 자리입니다(표 패널은 넓은 화면
          첫 화면 아래 끝에 걸려, 그 아래는 화면 밖).
        */}
        {firstLoadPending(consensus) && (
          <>
            <Panel title="공통 보유 상위 종목" source={SOURCES.sec13f} subtitle={BARS_SUBTITLE}>
              {/* Skeleton은 위아래 4px를 더하므로 그만큼 뺍니다 — 자리 전체가 차트 높이와 같게. */}
              <Skeleton height={BARS_PENDING_HEIGHT - 8} label="공통 보유 상위 종목 불러오는 중" />
            </Panel>
            <Panel title="교집합 상세" source={SOURCES.sec13f}>
              <Skeleton lines={6} label="교집합 상세 불러오는 중" />
            </Panel>
          </>
        )}

        {data?.available && (
          <>
            <Panel title="공통 보유 상위 종목" source={SOURCES.sec13f} subtitle={BARS_SUBTITLE}>
              <HorizontalBars
                data={chartData}
                unit="곳"
                digits={0}
                neutral
                ariaLabel="공통 보유 상위 종목 — 보유 기관 수"
                height={Math.max(260, chartData.length * BAR_ROW)}
              />
            </Panel>

            <Panel
              title="교집합 상세" source={SOURCES.sec13f} count={`${data.rows.length.toLocaleString("ko-KR")}개`}
              subtitle={`종목 이름을 누르면 보유 기관 목록과 함께 자세한 값을 봅니다. ${usdKrw.note}`}
            >
              <ConsensusTable rows={data.rows} krw={usdKrw} />
            </Panel>

            <p className="text-xs text-text-3">{participantsLine(data.participants)}</p>
          </>
        )}

        <NewBuysCard reportDate={reportDate} />
      </SplitPane>
    </div>
  );
}

/** 막대 패널 부제 — 값 패널과 읽는 중 자리가 같은 글(머리 높이가 같게). */
const BARS_SUBTITLE = "막대 길이 = 보유 기관 수";

/** 막대 한 줄 높이(px) — 이 화면이 막대 차트에 주는 높이(막대 수 × 26)와 차트 부품의 높이(막대 수 × 26 + 48)가 함께 씀. */
const BAR_ROW = 26;

/**
 * 처음 읽는 동안 막대 자리의 높이 — 막대 15개(CONSENSUS_BAR_LIMIT)를 그린 차트 높이. 차트 부품(HorizontalBars)은 받은 높이와 '막대 수 × 26 + 48' 가운데 큰 쪽을
 * 쓰므로 15개면 438px입니다(자기 빌드로 잰 막대 패널 559px — 머리·여백 121px).
 */
const BARS_PENDING_HEIGHT = Math.max(260, CONSENSUS_BAR_LIMIT * BAR_ROW, CONSENSUS_BAR_LIMIT * BAR_ROW + 48);

/**
 * 기관 목록을 처음 읽는 동안의 자리 줄(공용 거르기 목록의 `pending`) — 좁은 화면 태그 폭(px)·태그 줄 수(체크 상자를 포함한 태그 — 두 줄 태그 58px)와 넓은 화면
 * (왼쪽 13rem 칸 — 체크 상자 칸이 있어 13F 목록보다 줄이 많음) 이름 줄 수. QA 스택 자료 12곳(목록 차례)을 자기 빌드(dc898d5d)로 잰 값입니다(390 태그 폭 177~332px·
 * 합 672px, lg 줄 2~4줄 — 합 824px). 목록이 바뀌면 조금 어긋날 수 있습니다 — 자리일 뿐 보이는 수·이름이 아닙니다.
 */
const PENDING_CONSENSUS: readonly FilterListPendingRow[] = [
  { tag: 287, lines: 2 },
  { tag: 317, lines: 3 },
  { tag: 250, lines: 3 },
  { tag: 332, tagLines: 2, lines: 4 },
  { tag: 332, tagLines: 2, lines: 3 },
  { tag: 177, lines: 2 },
  { tag: 215, lines: 2 },
  { tag: 299, lines: 3 },
  { tag: 332, tagLines: 2, lines: 3 },
  { tag: 324, lines: 3 },
  { tag: 302, lines: 3 },
  { tag: 332, tagLines: 2, lines: 3 },
];


/**
 * 교집합 상세 표 — 공용 표 + 검사 대화상자(늘 대화상자 — 일곱 칸 표라 옆 칸을 두면 표가 눌림, 섹터 표와 같은 판단). 종목 이름이 검사를 여는 줄 단추이고,
 * 보유 기관 목록(배지)은 검사 칸으로 옮겼습니다 — 표에 두면 행이 배지 줄 수만큼 높아졌습니다(사용자 결정 거리 4 — 권장안 가). 검사는 받은 값만
 * 보이고 새로 읽지 않습니다. 동시 매수·매도는 기관 수라 본문 잉크입니다(QA-703).
 */
function ConsensusTable({ rows, krw }: { rows: ConsensusRow[]; krw: KrwConversion }) {
  const titles = securityTitles(rows);
  return (
    <InspectorFrame
      label="교집합 종목"
      layout="dialog"
      titleOf={(key) => titles.get(key) ?? null}
      renderDetail={(key) => {
        const row = rows.find((entry) => entry.key === key);
        return row ? <SecurityDetail items={consensusRowItems(row, krw)} filersLabel="보유 기관" filers={row.holders} /> : null;
      }}
    >
      {(inspector) => (
        <DataTable
          caption="교집합 상세"
          rows={rows}
          rowKey={(row) => row.key}
          scrollHint="overflow"
          columns={[
            { key: "name", header: "종목", rowHeader: true, className: "break-keep", cell: (row) => <SecurityName row={row} inspector={inspector} /> },
            { key: "holderCount", header: "보유 기관", align: "right", cell: (row) => `${formatNumber(row.holderCount, 0)}곳` },
            // 기관 몇 곳이라는 개수입니다 — 오르내린 값이 아니라 등락색(빨강·파랑)을 쓰지 않습니다(QA-703).
            { key: "buy", header: "동시 매수", align: "right", cell: (row) => row.buyCount },
            { key: "sell", header: "동시 매도", align: "right", cell: (row) => row.sellCount },
            { key: "avgWeight", header: "평균 비중", align: "right", cell: (row) => formatWeightPercent(row.avgWeight) },
            { key: "maxWeight", header: "최대 비중", align: "right", cell: (row) => formatWeightPercent(row.maxWeight) },
            { key: "totalValue", header: "합산 평가액", align: "right", cell: (row) => moneyCell(row.totalValue, krw) },
          ]}
        />
      )}
    </InspectorFrame>
  );
}

/** 공통 신규 매수 표 — 교집합 상세와 같은 틀(검사 대화상자), 기관 목록은 검사 칸에. 새로 담은 기관 수는 개수라 본문 잉크입니다(QA-703). */
function NewBuysTable({ rows, krw }: { rows: NewBuyRow[]; krw: KrwConversion }) {
  const titles = securityTitles(rows);
  return (
    <InspectorFrame
      label="공통 신규 매수 종목"
      layout="dialog"
      titleOf={(key) => titles.get(key) ?? null}
      renderDetail={(key) => {
        const row = rows.find((entry) => entry.key === key);
        return row ? <SecurityDetail items={newBuyRowItems(row, krw)} filersLabel="새로 담은 기관" filers={row.buyers} /> : null;
      }}
    >
      {(inspector) => (
        // 네 칸이지만 390에서 표 자연 폭(416px)이 패널 안쪽(332px)보다 넓어 오른쪽 칸이 안내 없이 가려졌습니다(브라우저 확인) — 넘침 안내를 둡니다
        // (공용 표의 안내는 640px 최소 폭과 함께라 1024의 가운데 칸 482px에서도 좌우로 넘김).
        <DataTable
          caption="이번 분기 공통 신규 매수"
          rows={rows}
          rowKey={(row) => row.key}
          scrollHint="overflow"
          columns={[
            { key: "name", header: "종목", rowHeader: true, className: "break-keep", cell: (row) => <SecurityName row={row} inspector={inspector} /> },
            { key: "buyerCount", header: "새로 담은 기관", align: "right", cell: (row) => <span className="font-semibold">{formatNumber(row.buyerCount, 0)}곳</span> },
            { key: "avgWeight", header: "평균 비중", align: "right", cell: (row) => formatWeightPercent(row.avgWeight) },
            { key: "totalValue", header: "합산 평가액", align: "right", cell: (row) => moneyCell(row.totalValue, krw) },
          ]}
        />
      )}
    </InspectorFrame>
  );
}

/** 합산 평가액 칸 — 달러(조·억 단위)와 그 아래 원화(환율을 알 때만). 값을 모르면 null(표가 '—'). */
function moneyCell(value: number | null, krw: KrwConversion) {
  const usd = formatCurrency(value);
  if (usd === EMPTY) return null;
  const won = krw.toKrw(value);
  return won ? (
    <span className="flex flex-col items-end">
      <span>{usd}</span>
      <span className="text-xs text-text-3">{won}</span>
    </span>
  ) : (
    usd
  );
}

/**
 * 종목 이름(검사를 여는 줄 단추)과 그 아래 작은 글씨의 증권 구분자(CUSIP, 합친 행은 발행사). 행은 증권으로 갈리고 표시 이름은 겹칠 수
 * 있어(같은 이름의 다른 ETF, 클래스 표기가 갈려 두 행으로 남은 A·C주), 이름만 적으면 어느 행이 어느 증권인지 알 수 없습니다(QA-114).
 * 기관 포트폴리오 화면의 '종목' 칸과 같은 모양입니다.
 */
function SecurityName({ row, inspector }: { row: { key: string; name: string; cusip?: string | null }; inspector: InspectorContext }) {
  const note = securityNote(row);
  return (
    <span className="flex min-w-0 flex-col items-start">
      <InspectorTrigger inspector={inspector} itemKey={row.key}>
        {row.name}
      </InspectorTrigger>
      {note && <span className="text-xs text-text-3">{note}</span>}
    </span>
  );
}

/** 검사 칸 내용 — 속성 목록(lib/consensusScreen)과 기관 배지 목록. 받은 값만 보입니다(새로 읽지 않음). */
function SecurityDetail({ items, filersLabel, filers }: { items: PropertyItem[]; filersLabel: string; filers: readonly string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PropertyList items={items} source={SOURCES.sec13f} />
      <section aria-label={filersLabel} className="min-w-0">
        <h3 className="mb-1 text-caption font-semibold text-text-2">
          {filersLabel} <span className="font-normal tabular-nums text-text-3">{filers.length.toLocaleString("ko-KR")}곳</span>
        </h3>
        <FilerBadges names={filers} />
      </section>
    </div>
  );
}

/**
 * 이번 분기에 여러 기관이 <b>함께 새로 담은</b> 종목.
 *
 * <p>교집합은 "지금 누가 무엇을 들고 있는가"를 보여 줍니다. 그런데 더 신호에
 * 가까운 것은 <b>이번 분기에 새로 들어온</b> 종목입니다 — 한 곳이 새로 사면
 * 취향이지만, 여러 곳이 같은 분기에 새로 사면 테마입니다.
 *
 * <p>직전 분기와 비교할 수 없는 항목(주식 수 누락 등)은 세지 않습니다. 모르는
 * 것을 신규 매수로 올리면 없던 테마가 생깁니다.
 */
function NewBuysCard({ reportDate }: { reportDate: string }) {
  const [minHolders, setMinHolders] = useState("3");

  const { data, loading, error, reload } = useApi<NewBuysResponse>(
    endpoints.institution.newBuys(minHolders, reportDate),
  );
  const usdKrw = useUsdKrw();

  return (
    <Panel
      title="이번 분기 공통 신규 매수" source={SOURCES.sec13f}
      count={data?.available ? `${data.rows.length.toLocaleString("ko-KR")}개` : undefined}
      subtitle={`여러 기관이 같은 분기에 처음 담은 종목 — 교집합보다 한 발 앞선 신호입니다. 종목 이름을 누르면 기관 목록과 함께 자세한 값을 봅니다. ${usdKrw.note}`}
      actions={
        <Select
          label="최소 기관 수"
          value={minHolders}
          onChange={setMinHolders}
          options={["2", "3", "4", "5"].map((value) => ({ value, label: `${value}곳 이상` }))}
        />
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data && !data.available && (
        <EmptyState
          message={`${minHolders}곳 이상이 함께 새로 담은 종목이 없습니다. 기준을 낮춰 보세요.`}
        />
      )}

      {data?.available && (
        <>
          <NewBuysTable rows={data.rows} krw={usdKrw} />
          <p className="mt-2 text-xs text-text-3">
            기준 분기 {data.rows[0]?.reportDate ?? EMPTY} · {data.note}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * 기관 배지 목록 — 국기를 뗀 전체 이름(lib/consensusScreen filerBadges). 예전 표 열에서는 행 높이를 아끼려 첫 낱말만 적고 전체 이름은 마우스 설명(title)에
 * 두었는데, 넓은 검사 대화상자로 옮긴 뒤에도 그대로라 터치·키보드·낭독기로는 전체 이름에 닿지 않았고 첫 낱말이 같은 두 기관을 가를 수 없었습니다(P5b 검토 지적).
 * 배지는 테두리 있는 중립 태그(공용 Tag)입니다 — 테두리 없는 출처 배지(SourceBadge — 바탕 surface-2만)는 같은 surface-2인 대화상자 면 위에서 상자가 사라지고
 * (1.00:1) 고대비에서도 바탕이 지워져 상자가 없었습니다(QA-725 — 13F 보유 표 QA-697과 같은 고침).
 */
function FilerBadges({ names }: { names: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {filerBadges(names).map((badge) => (
        <li key={badge.key}>
          <Tag>{badge.name}</Tag>
        </li>
      ))}
    </ul>
  );
}
