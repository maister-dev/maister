"use client";

import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { buildRunFileHref } from "@/lib/runs/run-query-state";

export type FileTreeEntry = { name: string; type: "file" | "dir" };

export interface FileTreeLabels {
  empty: string;
  loadError: string;
  treeLabel?: string;
}

function DirIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-mute"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1.5 4a1 1 0 0 1 1-1h3.2l1.4 1.4h5.4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-mute"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14V2a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 1.5v3.5h3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export interface FileTreeEntryRowProps {
  entry: FileTreeEntry;
  depth?: number;
  expanded?: boolean;
  selected?: boolean;
  onActivate?: () => void;
}

export function FileTreeEntryRow({
  entry,
  depth = 0,
  expanded = false,
  selected = false,
  onActivate,
}: FileTreeEntryRowProps): ReactElement {
  const isDir = entry.type === "dir";

  return (
    <button
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left font-mono text-[11px] text-ink-2 hover:bg-ivory"
      data-entry-type={entry.type}
      data-testid="file-tree-entry"
      role="treeitem"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      type="button"
      onClick={onActivate}
    >
      {isDir ? <DirIcon /> : <FileIcon />}
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

export interface FileTreeListProps {
  entries: FileTreeEntry[];
  depth?: number;
  expandedDirs?: Record<string, boolean>;
  parentPath?: string;
  childrenByDir?: Record<string, FileTreeEntry[] | undefined>;
  selectedPath?: string | null;
  treeLabel?: string;
  onActivateEntry?: (entry: FileTreeEntry, fullPath: string) => void;
}

export function FileTreeList({
  entries,
  depth = 0,
  expandedDirs = {},
  parentPath = "",
  childrenByDir = {},
  selectedPath = null,
  treeLabel,
  onActivateEntry,
}: FileTreeListProps): ReactElement {
  return (
    <ul
      aria-label={depth === 0 ? treeLabel : undefined}
      className="m-0 flex list-none flex-col p-0"
      role={depth === 0 ? "tree" : "group"}
    >
      {entries.map((entry) => {
        const fullPath = parentPath
          ? `${parentPath}/${entry.name}`
          : entry.name;
        const isDir = entry.type === "dir";
        const expanded = isDir ? Boolean(expandedDirs[fullPath]) : false;
        const nested = isDir ? childrenByDir[fullPath] : undefined;

        return (
          <li key={fullPath} role="none">
            <FileTreeEntryRow
              depth={depth}
              entry={entry}
              expanded={expanded}
              selected={!isDir && fullPath === selectedPath}
              onActivate={() => onActivateEntry?.(entry, fullPath)}
            />
            {isDir && expanded && nested ? (
              <FileTreeList
                childrenByDir={childrenByDir}
                depth={depth + 1}
                entries={nested}
                expandedDirs={expandedDirs}
                parentPath={fullPath}
                selectedPath={selectedPath}
                onActivateEntry={onActivateEntry}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface FileTreeProps {
  filesApiBase: string;
  labels: FileTreeLabels;
}

async function fetchEntries(
  filesApiBase: string,
  dir: string,
): Promise<FileTreeEntry[] | null> {
  const res = await fetch(`${filesApiBase}?path=${encodeURIComponent(dir)}`);

  if (!res.ok) return null;

  const body = (await res.json()) as { entries: FileTreeEntry[] };

  return body.entries;
}

export default function FileTree({
  filesApiBase,
  labels,
}: FileTreeProps): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedPath = searchParams.get("file");

  const [rootEntries, setRootEntries] = useState<FileTreeEntry[] | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [childrenByDir, setChildrenByDir] = useState<
    Record<string, FileTreeEntry[] | undefined>
  >({});
  const [rootError, setRootError] = useState(false);
  const inFlightDirs = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function loadRoot(): Promise<void> {
      const entries = await fetchEntries(filesApiBase, "");

      if (cancelled) return;
      // A null result is a fetch/auth/precondition failure — surface it as an
      // error, never as an empty repo (which would mask a 403/404/network fault).
      if (entries === null) setRootError(true);
      else setRootEntries(entries);
    }

    void loadRoot();

    return () => {
      cancelled = true;
    };
  }, [filesApiBase]);

  const onActivateEntry = useCallback(
    (entry: FileTreeEntry, fullPath: string) => {
      // Selecting a file is a URL navigation (`?wb=files&file=<path>`): the
      // server child re-reads the blob and renders <CodeView>. Dir expansion
      // stays client-side lazy state (NOT in the URL) so it survives the
      // `?file=` soft-nav — the tree keeps stable React identity in the
      // persistent layout.
      if (entry.type === "file") {
        router.push(
          buildRunFileHref(pathname, searchParams.toString(), fullPath),
          { scroll: false },
        );

        return;
      }

      const willExpand = !expandedDirs[fullPath];

      setExpandedDirs((prev) => ({ ...prev, [fullPath]: willExpand }));

      if (
        willExpand &&
        childrenByDir[fullPath] === undefined &&
        !inFlightDirs.current.has(fullPath)
      ) {
        inFlightDirs.current.add(fullPath);
        void fetchEntries(filesApiBase, fullPath)
          .then((entries) => {
            setChildrenByDir((prev) => ({
              ...prev,
              [fullPath]: entries ?? [],
            }));
          })
          .finally(() => {
            inFlightDirs.current.delete(fullPath);
          });
      }
    },
    [filesApiBase, expandedDirs, childrenByDir, router, pathname, searchParams],
  );

  const isEmpty = rootEntries !== null && rootEntries.length === 0;

  return (
    <div
      className="overflow-auto rounded-[10px] border border-line bg-paper p-1.5"
      data-testid="file-tree"
    >
      {rootError ? (
        <p
          className="p-4 text-center font-mono text-[11px] text-rust"
          data-testid="file-tree-error"
          role="alert"
        >
          {labels.loadError}
        </p>
      ) : isEmpty ? (
        <p
          className="p-4 text-center font-mono text-[11px] text-mute"
          data-testid="file-tree-empty"
        >
          {labels.empty}
        </p>
      ) : (
        <FileTreeList
          childrenByDir={childrenByDir}
          entries={rootEntries ?? []}
          expandedDirs={expandedDirs}
          selectedPath={selectedPath}
          treeLabel={labels.treeLabel}
          onActivateEntry={onActivateEntry}
        />
      )}
    </div>
  );
}
