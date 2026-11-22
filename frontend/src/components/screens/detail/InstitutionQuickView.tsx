"use client";

import Link from "@/components/ui/IntentLink";
import { type ReactElement, useState } from "react";
import { DataTable, PropertyList, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { ErrorState, Freshness, LINK_CLASSES } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { institutionHref, institutionNames } from "@/lib/detail";
import { institutionProperties } from "@/lib/detailEntity";
import { endpoints } from "@/lib/endpoints";
import { formatUsd, formatWeightPercent, withoutLeadingIcon } from "@/lib/format";
import type { Holding, PortfolioResponse } from "@/lib/types";
import { propertyItems } from "./DetailParts";

/** 기관 상세·13F 포트폴리오 화면과 같은 요청 값(같은 응답 캐시). */
const QUARTERS = 8;
const TOP_N = 30;
/** 팝업에 보일 보유 종목 수 — 나머지는 기관 상세 화면의 '보유 종목'. */
const HOLDINGS_SHOWN = 10;

/**
 * 기관 팝업 창(사용자 요청 2026-11-22 — 모의매매 '신호 기관'의 기관 이름을 누르면 화면을 떠나지 않고). 그 기관의 13F 저장본(SEC EDGAR, 분기마다 45일 안에
 * 공시 — 지금 보유와 다를 수 있음)으로 기관 속성(CIK·보고 기준일·공시일·평가액·보유 종목 수·분기 수)과 비중 상위 보유 종목(지난 분기 대비 동작)을 보이고,
 * '기관 상세 화면 열기'가 있습니다. 13F 메뉴 밖의 신호 후보 기관은 트랙레코드 저장본을 읽습니다(백엔드 — 이름은 이 팝업이 받은 이름).
 * 열려 있을 때만 읽습니다. 종목 팝업(StockQuickView)과 같은 틀입니다.
 */
export function InstitutionQuickView({ cik, name, trigger }: { cik: string; name: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const title = withoutLeadingIcon(name).trim() || `CIK ${cik}`;
  return (
    <Dialog open={open} onOpenChange={setOpen} title={title} trigger={trigger} size="lg">
      {open && <InstitutionQuickBody cik={cik} title={title} />}
    </Dialog>
  );
}

function InstitutionQuickBody({ cik, title }: { cik: string; title: string }) {
  const portfolio = useApi<PortfolioResponse>(endpoints.institution.portfolio(cik, QUARTERS, TOP_N));
  const data = portfolio.data;
  // 13F 메뉴 기관이면 응답의 이름(아이콘 뗌), 그 밖(이름 = CIK)은 받은 이름 그대로.
  const responseName = data?.institution?.name;
  const display = responseName && responseName !== cik ? institutionNames(responseName).display : title;
  const holdings = (data?.holdings ?? []).slice(0, HOLDINGS_SHOWN);

  let body;
  if (!data) {
    body =
      portfolio.errorStatus === 400 ? (
        <p className="break-keep text-sm text-text-2">이 기관의 13F 저장본이 없습니다(CIK {cik}).</p>
      ) : portfolio.error ? (
        <ErrorState message={portfolio.error} onRetry={() => void portfolio.reload()} />
      ) : (
        <Skeleton lines={6} label="13F 포트폴리오를 불러오는 중" />
      );
  } else if (!data.available) {
    body = <p className="text-sm text-text-2">{data.message ?? "13F 저장본이 없습니다."}</p>;
  } else {
    body = (
      <>
        <PropertyList items={propertyItems(institutionProperties(data, cik))} />
        <DataTable<Holding>
          caption={`${display} 비중 상위 보유 종목`}
          dense
          rows={holdings}
          rowKey={(holding) => `${holding.cusip}:${holding.class}`}
          emptyText="보유 종목이 없습니다."
          columns={[
            {
              key: "name",
              header: "종목",
              className: "break-keep",
              cell: (holding) => (
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-text wrap-anywhere">{holding.name}</span>
                  {withoutLeadingIcon(holding.action) ? (
                    <span className="text-xs text-text-3">{withoutLeadingIcon(holding.action)}</span>
                  ) : null}
                </span>
              ),
            },
            { key: "weight", header: "비중", align: "right", cell: (holding) => formatWeightPercent(holding.weight) },
            { key: "value", header: "평가액", align: "right", cell: (holding) => formatUsd(holding.value) },
          ]}
        />
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        <span className="tabular-nums">{display === title ? `CIK ${cik}` : `${display} · CIK ${cik}`}</span>
        {data?.latest ? (
          <span className="tabular-nums">
            보고 기준일 {data.latest.reportDate} · 공시일 {data.latest.filingDate}
          </span>
        ) : null}
        <ProvenanceBadge source="SEC EDGAR 13F" />
        {data ? <Freshness collectedAt={data.collectedAtKst} ageSeconds={data.ageSeconds} refreshError={portfolio.refreshError} /> : null}
      </div>
      {body}
      <p className="break-keep text-xs text-text-3">13F는 분기마다 45일 안에 공시됩니다 — 지금 보유와 다를 수 있습니다.</p>
      <Link href={institutionHref(cik)} className={`${LINK_CLASSES} self-start text-sm`}>
        기관 상세 화면 열기
      </Link>
    </div>
  );
}
