import type { Metadata } from "next";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Global Macro & 13F Dashboard",
  description:
    "글로벌 매크로 지표·연준 순유동성·섹터 로테이션·CFTC COT·KRX 파생·SEC 13F·국내 수급 레이더를 한 화면에서 보는 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 테마: <head>의 인라인 스크립트가 저장된 선택(light|dark)을 첫 페인트 전에 <html data-theme>로 붙입니다(없으면 시스템 따름).
  // 스크립트가 바꾼 속성을 하이드레이션이 오류로 보지 않게 suppressHydrationWarning을 주고, JSX에는 data-theme를 쓰지 않습니다
  // (적으면 Strict Mode 재마운트가 그 값으로 되돌림 — useTheme이 다시 붙임).
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">{children}</body>
    </html>
  );
}
