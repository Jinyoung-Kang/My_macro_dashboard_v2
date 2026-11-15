import type { Metadata } from "next";
import { LEGACY_THEME_CLEANUP_SCRIPT } from "@/lib/legacyTheme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Global Macro & 13F Dashboard",
  description:
    "글로벌 매크로 지표·연준 순유동성·섹터 로테이션·CFTC COT·KRX 파생·SEC 13F·국내 수급 레이더를 한 화면에서 보는 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 테마는 어두운 한 벌 하나입니다(ADR 0042 결정 2 — globals.css의 :root, color-scheme: dark). <head>의 인라인 스크립트는 없앤 테마 선택이
  // 브라우저에 남긴 값(localStorage "theme")을 읽지 않고 지우기만 합니다(lib/legacyTheme.ts). <html>에는 테마 속성을 붙이지 않습니다.
  return (
    <html lang="ko">
      <head>
        <script dangerouslySetInnerHTML={{ __html: LEGACY_THEME_CLEANUP_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">{children}</body>
    </html>
  );
}
