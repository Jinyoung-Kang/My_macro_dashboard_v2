/**
 * 패턴 배럴(components/patterns/index.ts) — 화면은 `@/components/patterns` 한 곳에서 가져옵니다.
 *  - 패턴 파일(.tsx)마다 내보내는 이름이 배럴에 같은 것으로(같은 참조) 다시 나온다 — 새 파일·새 이름이 빠지지 않게
 *  - 배럴에는 패턴만 — 차트(LineChart 등)는 `@/components/charts`에서만(테스트 mock이 그 지정자에 걸림)
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as AssetRow from "../AssetRow";
import * as Avatar from "../Avatar";
import * as badges from "../badges";
import * as ChangeChip from "../ChangeChip";
import * as DataTable from "../DataTable";
import * as Empty from "../Empty";
import * as EntityHeader from "../EntityHeader";
import * as FilterList from "../FilterList";
import * as HeatmapTable from "../HeatmapTable";
import * as Hero from "../Hero";
import * as patterns from "../index";
import * as InspectorFrame from "../InspectorFrame";
import * as KpiStrip from "../KpiStrip";
import * as MasterDetail from "../MasterDetail";
import * as PropertyList from "../PropertyList";
import * as RangeTabs from "../RangeTabs";
import * as SectionIndex from "../SectionIndex";
import * as Skeleton from "../Skeleton";
import * as Sparkline from "../Sparkline";
import * as SplitPane from "../SplitPane";
import * as StatTile from "../StatTile";
import * as Timeline from "../Timeline";

const MODULES: Record<string, Record<string, unknown>> = {
  AssetRow,
  Avatar,
  badges,
  ChangeChip,
  DataTable,
  Empty,
  EntityHeader,
  FilterList,
  HeatmapTable,
  Hero,
  InspectorFrame,
  KpiStrip,
  MasterDetail,
  PropertyList,
  RangeTabs,
  SectionIndex,
  Skeleton,
  Sparkline,
  SplitPane,
  StatTile,
  Timeline,
};

describe("components/patterns 배럴", () => {
  it("패턴 파일 목록이 이 테스트의 목록과 같다 — 새 파일을 만들면 배럴과 여기에 함께 넣는다", () => {
    // jsdom 환경의 import.meta.url은 file: 주소가 아닙니다 — endpoints.test.ts처럼 __dirname을 씁니다.
    const files = readdirSync(resolve(__dirname, ".."))
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => name.replace(/\.tsx$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(MODULES).sort());
  });

  it("파일마다 내보낸 이름이 배럴에서 같은 참조로 나온다", () => {
    for (const [file, module] of Object.entries(MODULES)) {
      for (const [name, value] of Object.entries(module)) {
        expect(patterns, `${file}.${name}`).toHaveProperty(name);
        expect((patterns as Record<string, unknown>)[name], `${file}.${name}`).toBe(value);
      }
    }
  });

  it("배럴에는 패턴만 — 차트 이름이 없다", () => {
    const names = Object.keys(patterns).sort();
    expect(names).toEqual(
      [
        "AssetList",
        "AssetRow",
        "Avatar",
        "ChangeCell",
        "ChangeChip",
        "DataTable",
        "Empty",
        "EntityHeader",
        "EstimateBadge",
        "FilterList",
        "HeatmapTable",
        "Hero",
        "InspectorFrame",
        "InspectorTrigger",
        "KpiStrip",
        "MasterDetail",
        "PropertyList",
        "ProvenanceBadge",
        "RangeTabs",
        "SectionAnchor",
        "SectionIndex",
        "Skeleton",
        "Sparkline",
        "SplitPane",
        "StaleBadge",
        "StatGrid",
        "StatTile",
        "Timeline",
        "TimelineSkeleton",
      ].sort(),
    );
    expect(names).not.toContain("LineChart");
  });
});
