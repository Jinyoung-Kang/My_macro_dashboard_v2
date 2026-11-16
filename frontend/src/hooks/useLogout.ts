"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { auth } from "@/lib/api";

/**
 * 로그아웃 — 세션을 끝내고 로그인 화면으로 보냅니다. 실패하면 삼키지 않고 글로 돌려줍니다(QA-051 — 삼키면 단추가 아무 반응 없이 끝나고 세션은 그대로).
 * 더보기의 계정 영역(AccountBox)과 넓은 화면 상단바의 계정 메뉴(AccountMenu)가 같이 씁니다.
 */
export function useLogout(): { logout: () => Promise<void>; error: string | null } {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const logout = useCallback(async () => {
    setError(null);
    try {
      await auth.logout();
      router.push("/login");
    } catch (err) {
      // 짧은 결과 낱말 먼저(새로고침 실패 안내와 같은 꼴) — 넓은 화면 상단바 한 줄에서는 결과 낱말까지가 이 글의 하한입니다(FailureNotice, QA-547).
      setError(`로그아웃 실패 — ${err instanceof Error ? err.message : "다시 시도하세요"}`);
    }
  }, [router]);

  return { logout, error };
}
