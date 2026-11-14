"use client";

import { useCallback, useId, useState, type FormEvent } from "react";
import { NativeSelect, inputClasses } from "@/components/ui";
import { ChevronDownIcon, StatusText } from "@/components/ui/icons";
import { useInfoSearchExcludes } from "@/hooks/useInfoSearchWatch";
import { EMPTY, formatKst } from "@/lib/format";
import { excludeDraft, excludeKindLabel, excludeSeedGroups, type ExcludeKind } from "@/lib/infoSearch";
import { BUTTON, BUTTON_PRIMARY, PANEL, PaneHeading } from "./parts";

/** 입력칸 — 공용 모양(테두리 3:1·포커스 링 2px·lg 미만 44px), 칸 폭을 다 씀. */
const FIELD = `${inputClasses("sm")} w-full`;

/**
 * 매체 제외 목록(계약 §6-2·6-4, ADR 0041 결정 6) — 펼칠 때만 읽습니다(GET /api/search/excludes — 회원). 처음 값(코드 상수 — 중국 국가·당 매체,
 * 본토·홍콩·마카오 매체, 중국 자본 금융 매체)은 묶음별로 읽기만, 운영자가 더한 것은 운영자만 더하고 지웁니다(POST·DELETE — 운영자).
 * 중국어 제목과 주소가 .cn인 매체는 이 목록과 상관없이 늘 빠집니다(수집기가 거름).
 * 더하기·지우기가 성공하면 onChanged를 부릅니다(첫 화면이 최근 글을 다시 읽음 — 서버는 이미 바뀐 목록으로 거른 글을 줌).
 */
export function ExcludesPanel({ owner, onChanged }: { owner: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const excludes = useInfoSearchExcludes(open);
  const data = excludes.data;
  const { add: addExclude, remove: removeExclude } = excludes;
  const add = useCallback(
    async (body: Parameters<typeof addExclude>[0]) => {
      const ok = await addExclude(body);
      if (ok) onChanged?.();
      return ok;
    },
    [addExclude, onChanged],
  );
  const remove = useCallback(
    async (id: number) => {
      if (await removeExclude(id)) onChanged?.();
    },
    [removeExclude, onChanged],
  );
  const seed = data?.available ? (data.seed ?? []) : [];
  const added = data?.available ? (data.added ?? []) : [];

  let body = null;
  if (open) {
    if (!data) {
      body = excludes.error ? (
        <p className="text-sm text-text-2">제외 목록을 읽지 못했습니다 — {excludes.error}</p>
      ) : (
        <p className="text-xs text-text-3">제외 목록을 읽는 중…</p>
      );
    } else if (!data.available) {
      body = <p className="text-sm text-text-2">{data.message ?? "제외 목록을 받지 못했습니다."}</p>;
    } else {
      body = (
        <>
          <p className="text-xs leading-5 text-text-3">
            중국어 제목과 주소가 .cn인 매체는 늘 뺍니다. 그 밖에 아래 매체를 뺍니다 — 도메인은 그 아래 주소까지(news.example.com은 example.com에 걸림),
            이름은 대소문자를 무시하고 똑같을 때만. 즉석 검색·관심 대상 수집 모두 같은 목록을 씁니다.
          </p>
          <div className="flex flex-col gap-1.5">
            <PaneHeading>더한 매체 {added.length}곳</PaneHeading>
            {added.length === 0 ? (
              <p className="text-xs text-text-3">더한 매체가 없습니다.</p>
            ) : (
              <ul aria-label="더한 제외 매체" className="flex flex-col divide-y divide-border rounded-control border border-border">
                {added.map((row) => (
                  // 좁은 화면(sm 미만)은 메모를 줄 끝으로 내려 한 줄을 다 쓰게 합니다 — 값 옆에 끼우면 메모 칸이 좁아져 글자마다 끊깁니다.
                  <li key={row.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-sm lg:min-h-8">
                    <span className="min-w-0 break-all font-medium text-text">{row.value}</span>
                    <span className="text-xs text-text-3">{excludeKindLabel(row.kind)}</span>
                    {row.note ? (
                      <span className="order-last basis-full break-words text-xs text-text-2 sm:order-none sm:min-w-0 sm:flex-1 sm:basis-0">{row.note}</span>
                    ) : null}
                    <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-text-3">{row.createdAt ? formatKst(row.createdAt) : EMPTY}</span>
                    {owner ? (
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={excludes.busy}
                        onClick={() => void remove(row.id)}
                        aria-label={`${row.value} 지우기`}
                      >
                        지우기
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {owner ? (
            <AddExcludeForm
              busy={excludes.busy}
              error={excludes.actionError}
              existing={[...seed, ...added]}
              onError={excludes.setActionError}
              onAdd={add}
            />
          ) : (
            <p className="text-xs text-text-3">제외 매체를 더하고 지우는 것은 운영자만 합니다.</p>
          )}
          <div className="flex flex-col gap-2">
            <PaneHeading>처음 값 {seed.length}개 — 코드에 둔 목록</PaneHeading>
            {excludeSeedGroups(seed).map((group) => (
              <div key={group.group} className="text-xs leading-5">
                <p className="font-semibold text-text-2">{group.group}</p>
                <ul className="flex flex-wrap gap-x-2 gap-y-0.5 text-text-3">
                  {group.items.map((item) => (
                    <li key={`${item.kind}:${item.value}`}>
                      {item.value}
                      {item.kind === "name" ? <span className="sr-only">(이름)</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      );
    }
  }

  return (
    <section aria-label="매체 제외" className={`${PANEL} flex flex-col gap-3 p-3`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className={`${BUTTON} justify-between self-start`}
      >
        매체 제외 목록
        <ChevronDownIcon size={14} className={open ? "rotate-180" : ""} />
      </button>
      <div id={bodyId} className={open ? "flex flex-col gap-3" : "hidden"}>
        {body}
      </div>
    </section>
  );
}

/** 운영자의 더하기 칸 — 종류(도메인·이름)·값·메모. 값은 lib/infoSearch의 excludeDraft로 다듬고, 틀리거나 이미 있으면 보내지 않고 사유를 글로. */
function AddExcludeForm({
  busy,
  error,
  existing,
  onError,
  onAdd,
}: {
  busy: boolean;
  error: string | null;
  existing: readonly { kind: string; value: string }[];
  onError: (message: string | null) => void;
  onAdd: (body: { kind: ExcludeKind; value: string; note: string | null }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<ExcludeKind>("domain");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const ids = { kind: useId(), value: useId(), note: useId() };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft = excludeDraft(kind, value, note, existing);
    if (!draft.ok) {
      onError(draft.message);
      return;
    }
    if (await onAdd(draft.body)) {
      setValue("");
      setNote("");
    }
  };

  return (
    <form aria-label="제외 매체 더하기" onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label htmlFor={ids.kind} className="flex flex-col gap-1 text-xs text-text-2">
          종류
          <NativeSelect
            id={ids.kind}
            inputSize="sm"
            wrapperClassName="block w-full"
            value={kind}
            onChange={(event) => setKind(event.target.value as ExcludeKind)}
          >
            <option value="domain">도메인</option>
            <option value="name">이름</option>
          </NativeSelect>
        </label>
        <label htmlFor={ids.value} className="flex flex-col gap-1 text-xs text-text-2">
          값
          <input
            id={ids.value}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={kind === "domain" ? "example.com" : "매체 이름"}
            maxLength={300}
            autoComplete="off"
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.note} className="flex flex-col gap-1 text-xs text-text-2">
          메모(선택)
          <input id={ids.note} value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} autoComplete="off" className={FIELD} />
        </label>
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !value.trim()}>
          더하기
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-text-2">
          <StatusText tone="warn" colorText={false} iconSize={12}>
            {error}
          </StatusText>
        </p>
      ) : null}
    </form>
  );
}
