"use client";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type {
  ProjectCapabilityCatalogEntry,
  ProjectCapabilityKind,
} from "@/lib/capabilities/project-catalog";
import type {
  TemplateVariableEntry,
  TemplateVariableUsageWarning,
} from "@/lib/flows/editor/template-variable-catalog";

import {
  Extension,
  Node,
  mergeAttributes,
  type Editor,
  type Range,
} from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import { useEffect, useRef, useState } from "react";

import {
  canonicalToSegments,
  chipToCanonical,
  promoteComposerSkillTokens,
  segmentsToParagraphs,
  type ComposerSegment,
} from "@/lib/capabilities/composer-serialize";
import { surfaceFormForSkill } from "@/lib/capabilities/token-normalizer";

export type CapabilityComposerLabels = {
  /** "claude-only" / "not on <runner>" advisory badge text. */
  unsupportedBadge: string;
  /** Empty-state placeholder. */
  placeholder: string;
  /** Compact variable picker tooltip/aria label. */
  variableButton?: string;
  /** Badge for variables that may be absent. */
  variableConditionalBadge?: string;
  /** Generic variable warning heading/aria label. */
  variableWarning?: string;
};

export type CapabilityComposerProps = {
  value: string;
  onChange: (value: string) => void;
  catalog: ProjectCapabilityCatalogEntry[];
  agent: AdapterId;
  labels: CapabilityComposerLabels;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
  onSubmitShortcut?: () => void;
  variableCatalog?: readonly TemplateVariableEntry[];
  variableWarnings?: readonly TemplateVariableUsageWarning[];
};

type ChipAttrs = {
  kind: "skill" | "subagent";
  slug: string;
  label: string;
  surfaceForm: string;
  supported: boolean;
};

// --- catalog lookup (per-runner wire form + validity) ------------------------

function lookupChip(
  kind: "skill" | "subagent",
  slug: string,
  agent: AdapterId,
  catalog: ProjectCapabilityCatalogEntry[],
): ChipAttrs {
  const entry = catalog.find((c) => c.kind === kind && c.slug === slug);
  const surfaceForm =
    entry?.surfaceForm ??
    (kind === "skill" ? surfaceFormForSkill(slug, agent) : `@${slug}`);

  return {
    kind,
    slug,
    label: entry?.displayName ?? slug,
    surfaceForm,
    // A skill is supported per its catalog flag; a subagent only on claude.
    supported: entry
      ? entry.supported
      : kind === "subagent"
        ? agent === "claude"
        : true,
  };
}

// --- the chip node -----------------------------------------------------------

const CapabilityChip = Node.create({
  name: "capabilityChip",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "skill" },
      slug: { default: "" },
      label: { default: "" },
      surfaceForm: { default: "" },
      supported: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-capability-chip]" }];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as ChipAttrs;
    const children: Array<unknown> = [
      [
        "span",
        { class: "capability-chip__sigil" },
        attrs.kind === "skill" ? "/" : "@",
      ],
      ` ${attrs.label}`,
    ];

    if (!attrs.supported) {
      children.push(["span", { class: "capability-chip__badge" }, "!"]);
    }

    return [
      "span",
      mergeAttributes({
        "data-capability-chip": "",
        "data-testid": "capability-chip",
        "data-kind": attrs.kind,
        "data-slug": attrs.slug,
        "data-supported": String(attrs.supported),
        title: attrs.surfaceForm,
        class: `capability-chip${attrs.supported ? "" : " capability-chip--unsupported"}`,
      }),
      ...(children as never[]),
    ];
  },
});

// --- suggestion (/, $, @) ----------------------------------------------------

type SuggestionState = {
  open: boolean;
  items: ProjectCapabilityCatalogEntry[];
  selected: number;
  top: number;
  left: number;
  range: Range | null;
};

type VariableSuggestionState = {
  open: boolean;
  items: TemplateVariableEntry[];
  selected: number;
  top: number;
  left: number;
  range: Range | null;
};

const EMPTY_SUGGESTION: SuggestionState = {
  open: false,
  items: [],
  selected: 0,
  top: 0,
  left: 0,
  range: null,
};

const EMPTY_VARIABLE_SUGGESTION: VariableSuggestionState = {
  open: false,
  items: [],
  selected: 0,
  top: 0,
  left: 0,
  range: null,
};

// Submit on Enter (chat convention). Shift+Enter inserts a newline; Cmd/Ctrl+
// Enter also submits for muscle-memory. IME composition Enter (keyCode 229) must
// NOT submit — it commits the candidate. The suggestion popup consumes Enter
// first (pick item), so this only fires when the popup is closed.
export function isSubmitShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "isComposing" | "keyCode"
  >,
): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing || event.keyCode === 229) return false;

  return !event.shiftKey;
}

function buildSuggestionExtension(args: {
  getCatalog: () => ProjectCapabilityCatalogEntry[];
  setState: (next: SuggestionState) => void;
  getState: () => SuggestionState;
}): Extension {
  // `command` from the active suggestion plugin (one popup at a time).
  let commandRef: ((item: ProjectCapabilityCatalogEntry) => void) | null = null;

  return Extension.create({
    name: "capabilitySuggestions",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const make = (char: string, kinds: ProjectCapabilityKind[]) =>
        Suggestion<ProjectCapabilityCatalogEntry>({
          editor,
          // Each trigger needs a distinct ProseMirror plugin key — the default
          // `suggestion$` collides across the three instances.
          pluginKey: new PluginKey(`capabilityComposerSuggestion_${char}`),
          char,
          allowedPrefixes: null,
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => {
            const q = query.toLowerCase();

            return args
              .getCatalog()
              .filter((c) => kinds.includes(c.kind))
              .filter(
                (c) =>
                  c.slug.toLowerCase().includes(q) ||
                  c.displayName.toLowerCase().includes(q),
              )
              .slice(0, 8);
          },
          command: ({ editor: ed, range, props }) => {
            insertChip(ed, range, props);
          },
          render: () => ({
            onStart: (p) => {
              const rect = p.clientRect?.();

              args.setState({
                open: p.items.length > 0,
                items: p.items,
                selected: 0,
                top: rect ? rect.bottom : 0,
                left: rect ? rect.left : 0,
                range: p.range,
              });
              commandRef = p.command;
            },
            onUpdate: (p) => {
              const rect = p.clientRect?.();

              args.setState({
                ...args.getState(),
                open: p.items.length > 0,
                items: p.items,
                selected: 0,
                top: rect ? rect.bottom : args.getState().top,
                left: rect ? rect.left : args.getState().left,
                range: p.range,
              });
              commandRef = p.command;
            },
            onKeyDown: (p) => {
              const s = args.getState();

              if (!s.open) return false;
              // Cmd/Ctrl+Enter still submits even with the popup open; plain
              // Enter below picks the highlighted item instead.
              if (
                p.event.key === "Enter" &&
                (p.event.metaKey || p.event.ctrlKey)
              ) {
                return false;
              }
              if (p.event.key === "ArrowDown") {
                args.setState({
                  ...s,
                  selected: (s.selected + 1) % s.items.length,
                });

                return true;
              }
              if (p.event.key === "ArrowUp") {
                args.setState({
                  ...s,
                  selected: (s.selected - 1 + s.items.length) % s.items.length,
                });

                return true;
              }
              if (p.event.key === "Enter") {
                const item = s.items[s.selected];

                if (item && commandRef) commandRef(item);

                return true;
              }
              if (p.event.key === "Escape") {
                args.setState(EMPTY_SUGGESTION);

                return true;
              }

              return false;
            },
            onExit: () => {
              args.setState(EMPTY_SUGGESTION);
            },
          }),
        });

      return [
        make("/", ["skill", "command"]),
        make("$", ["skill", "command"]),
        make("@", ["subagent"]),
      ];
    },
  });
}

function buildVariableSuggestionExtension(args: {
  getCatalog: () => readonly TemplateVariableEntry[];
  setState: (next: VariableSuggestionState) => void;
  getState: () => VariableSuggestionState;
}): Extension {
  let commandRef: ((item: TemplateVariableEntry) => void) | null = null;

  return Extension.create({
    name: "templateVariableSuggestions",
    addProseMirrorPlugins() {
      const editor = this.editor;

      return [
        Suggestion<TemplateVariableEntry>({
          editor,
          pluginKey: new PluginKey("capabilityComposerSuggestion_variables"),
          char: "{{",
          allowedPrefixes: null,
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => {
            const q = query.toLowerCase();

            return args
              .getCatalog()
              .filter(
                (entry) =>
                  entry.path.toLowerCase().includes(q) ||
                  entry.label.toLowerCase().includes(q) ||
                  (entry.nodeId?.toLowerCase().includes(q) ?? false) ||
                  fieldName(entry).toLowerCase().includes(q),
              )
              .slice(0, 8);
          },
          command: ({ editor: ed, range, props }) => {
            insertVariable(ed, range, props);
          },
          render: () => ({
            onStart: (p) => {
              const rect = p.clientRect?.();

              args.setState({
                open: p.items.length > 0,
                items: p.items,
                selected: 0,
                top: rect ? rect.bottom : 0,
                left: rect ? rect.left : 0,
                range: p.range,
              });
              commandRef = p.command;
            },
            onUpdate: (p) => {
              const rect = p.clientRect?.();

              args.setState({
                ...args.getState(),
                open: p.items.length > 0,
                items: p.items,
                selected: 0,
                top: rect ? rect.bottom : args.getState().top,
                left: rect ? rect.left : args.getState().left,
                range: p.range,
              });
              commandRef = p.command;
            },
            onKeyDown: (p) => {
              const s = args.getState();

              if (!s.open) return false;
              if (isSubmitShortcut(p.event)) return false;
              if (p.event.key === "ArrowDown") {
                args.setState({
                  ...s,
                  selected: (s.selected + 1) % s.items.length,
                });

                return true;
              }
              if (p.event.key === "ArrowUp") {
                args.setState({
                  ...s,
                  selected: (s.selected - 1 + s.items.length) % s.items.length,
                });

                return true;
              }
              if (p.event.key === "Enter") {
                const item = s.items[s.selected];

                if (item && commandRef) commandRef(item);

                return true;
              }
              if (p.event.key === "Escape") {
                args.setState(EMPTY_VARIABLE_SUGGESTION);

                return true;
              }

              return false;
            },
            onExit: () => {
              args.setState(EMPTY_VARIABLE_SUGGESTION);
            },
          }),
        }),
      ];
    },
  });
}

function insertChip(
  editor: Editor,
  range: Range,
  entry: ProjectCapabilityCatalogEntry,
): void {
  if (entry.kind === "command") {
    editor
      .chain()
      .focus()
      .insertContentAt(range, `${entry.canonicalToken} `)
      .run();

    return;
  }

  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      {
        type: "capabilityChip",
        attrs: {
          kind: entry.kind,
          slug: entry.slug,
          label: entry.displayName,
          surfaceForm: entry.surfaceForm,
          supported: entry.supported,
        },
      },
      { type: "text", text: " " },
    ])
    .run();
}

function templateVariableText(entry: TemplateVariableEntry): string {
  return `{{ ${entry.insertText} }}`;
}

function variableNeedsDefault(entry: TemplateVariableEntry): boolean {
  return entry.availability === "conditional" || entry.presence === "optional";
}

function fieldName(entry: TemplateVariableEntry): string {
  return entry.path.split(".").at(-1) ?? entry.path;
}

function insertVariable(
  editor: Editor,
  range: Range,
  entry: TemplateVariableEntry,
): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, templateVariableText(entry))
    .run();
}

// --- doc <-> canonical -------------------------------------------------------

function segmentsToDoc(
  segments: ComposerSegment[],
  agent: AdapterId,
  catalog: ProjectCapabilityCatalogEntry[],
): Record<string, unknown> {
  // One paragraph node per line (the doc has no HardBreak extension), so a
  // multiline prompt keeps its line breaks instead of collapsing to one line.
  const content = segmentsToParagraphs(segments).map((group) => ({
    type: "paragraph",
    content: group
      .map((seg) => {
        if (seg.type === "text") {
          return seg.text ? { type: "text", text: seg.text } : null;
        }
        const chip = lookupChip(seg.kind, seg.slug, agent, catalog);

        return { type: "capabilityChip", attrs: chip };
      })
      .filter(Boolean),
  }));

  return { type: "doc", content };
}

function docToCanonical(editor: Editor): string {
  // Serialize each top-level block (paragraph) on its own, then join with `\n` —
  // a paragraph boundary IS a newline in the prompt. Joining the inline nodes
  // flat would drop every line break the user typed or pasted.
  const blocks: string[] = [];

  editor.state.doc.forEach((block) => {
    const parts: string[] = [];

    block.descendants((node) => {
      if (node.type.name === "text") {
        parts.push(node.text ?? "");
      } else if (node.type.name === "capabilityChip") {
        const attrs = node.attrs as ChipAttrs;

        parts.push(chipToCanonical(attrs.kind, attrs.slug));
      }
    });
    blocks.push(parts.join(""));
  });

  return blocks.join("\n");
}

// --- component ---------------------------------------------------------------

export function CapabilityComposer({
  value,
  onChange,
  catalog,
  agent,
  labels,
  ariaLabel,
  disabled,
  className,
  testId,
  onSubmitShortcut,
  variableCatalog = [],
  variableWarnings = [],
}: CapabilityComposerProps) {
  const [suggestion, setSuggestion] =
    useState<SuggestionState>(EMPTY_SUGGESTION);
  const [variableSuggestion, setVariableSuggestion] =
    useState<VariableSuggestionState>(EMPTY_VARIABLE_SUGGESTION);
  const [variableMenuOpen, setVariableMenuOpen] = useState(false);
  const suggestionRef = useRef(suggestion);
  const variableSuggestionRef = useRef(variableSuggestion);
  const submitShortcutRef = useRef(onSubmitShortcut);
  const editorRef = useRef<Editor | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const agentRef = useRef(agent);

  suggestionRef.current = suggestion;
  variableSuggestionRef.current = variableSuggestion;
  submitShortcutRef.current = onSubmitShortcut;
  valueRef.current = value;
  onChangeRef.current = onChange;
  agentRef.current = agent;
  const catalogRef = useRef(catalog);
  const variableCatalogRef = useRef(variableCatalog);

  catalogRef.current = catalog;
  variableCatalogRef.current = variableCatalog;

  const commitPromotedValue = () => {
    const currentEditor = editorRef.current;

    if (!currentEditor) return;

    const raw = docToCanonical(currentEditor);
    const promoted = promoteComposerSkillTokens(raw, catalogRef.current);

    if (promoted !== raw) {
      currentEditor.commands.setContent(
        segmentsToDoc(
          canonicalToSegments(promoted),
          agentRef.current,
          catalogRef.current,
        ),
        { emitUpdate: false },
      );
    }

    if (promoted !== valueRef.current) {
      onChangeRef.current(promoted);
    }
  };

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "capability-composer__editor",
        "data-testid": "capability-composer-input",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleKeyDown: (_view, event) => {
        if (!isSubmitShortcut(event) || !submitShortcutRef.current) {
          return false;
        }

        event.preventDefault();
        commitPromotedValue();
        submitShortcutRef.current();

        return true;
      },
    },
    extensions: [
      Document,
      Paragraph,
      Text,
      CapabilityChip,
      Placeholder.configure({ placeholder: labels.placeholder }),
      buildSuggestionExtension({
        getCatalog: () => catalogRef.current,
        setState: setSuggestion,
        getState: () => suggestionRef.current,
      }),
      buildVariableSuggestionExtension({
        getCatalog: () => variableCatalogRef.current,
        setState: setVariableSuggestion,
        getState: () => variableSuggestionRef.current,
      }),
    ],
    content: segmentsToDoc(canonicalToSegments(value), agent, catalog),
    onUpdate: ({ editor: ed }) => {
      const next = docToCanonical(ed);

      if (next !== value) onChange(next);
    },
  });

  editorRef.current = editor;

  // External value / runner-switch sync: rebuild the doc so chips re-render
  // their per-runner wire form + validity (FR-D4/D10). Skip when the editor
  // already reflects the value (avoids clobbering the cursor on self-edits).
  useEffect(() => {
    if (!editor) return;
    if (docToCanonical(editor) === value) {
      // value unchanged, but the runner may have switched → rebuild for display.
      editor.commands.setContent(
        segmentsToDoc(canonicalToSegments(value), agent, catalog),
        { emitUpdate: false },
      );

      return;
    }
    editor.commands.setContent(
      segmentsToDoc(canonicalToSegments(value), agent, catalog),
      { emitUpdate: false },
    );
  }, [editor, value, agent]);

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  const showVariableControls = !disabled && variableCatalog.length > 0;

  return (
    <div
      className={`capability-composer ${className ?? ""}`}
      data-testid={testId}
      onBlur={() => {
        commitPromotedValue();
      }}
    >
      <EditorContent editor={editor} />
      {showVariableControls ? (
        <div className="capability-composer__variables">
          <button
            aria-label={labels.variableButton ?? "Variables"}
            className="capability-composer__variable-button"
            data-testid="capability-variable-button"
            title={labels.variableButton ?? "Variables"}
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              setVariableMenuOpen((open) => !open);
            }}
          >
            {"{}"}
          </button>
          <ul
            className="capability-composer__variable-menu"
            data-testid="capability-variable-menu"
            hidden={!variableMenuOpen}
          >
            {variableCatalog.map((entry) => (
              <li key={entry.path}>
                <button
                  className="capability-composer__variable-item"
                  data-insert-text={entry.insertText}
                  data-suggestion-type="variable"
                  data-testid="capability-variable-item"
                  data-variable-path={entry.path}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (!editor) return;
                    insertVariable(
                      editor,
                      {
                        from: editor.state.selection.from,
                        to: editor.state.selection.to,
                      },
                      entry,
                    );
                    setVariableMenuOpen(false);
                  }}
                >
                  <span className="capability-composer__item-name">
                    {entry.label}
                  </span>
                  <span className="capability-composer__item-desc">
                    {entry.insertText}
                  </span>
                  {variableNeedsDefault(entry) ? (
                    <span className="capability-composer__item-badge">
                      {labels.variableConditionalBadge ?? "optional"}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {variableWarnings.length > 0 ? (
        <ul
          aria-label={labels.variableWarning ?? "Variable warnings"}
          className="capability-composer__variable-warnings"
          data-testid="capability-variable-warnings"
        >
          {variableWarnings.map((warning) => (
            <li
              key={`${warning.code}:${warning.path}`}
              data-severity={warning.severity}
              data-variable-path={warning.path}
            >
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
      {suggestion.open ? (
        <ul
          className="capability-composer__popup"
          data-testid="capability-suggestions"
          style={{
            position: "fixed",
            top: suggestion.top,
            left: suggestion.left,
            zIndex: 50,
          }}
        >
          {suggestion.items.map((item, index) => (
            <li key={`${item.kind}:${item.slug}`}>
              <button
                className={
                  index === suggestion.selected
                    ? "capability-composer__item is-selected"
                    : "capability-composer__item"
                }
                data-selected={index === suggestion.selected}
                data-slug={item.slug}
                data-testid="capability-suggestion-item"
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!editor || !suggestion.range) return;
                  insertChip(editor, suggestion.range, item);
                  setSuggestion(EMPTY_SUGGESTION);
                }}
              >
                <span className="capability-composer__item-name">
                  {item.displayName}
                </span>
                {item.description ? (
                  <span className="capability-composer__item-desc">
                    {item.description}
                  </span>
                ) : null}
                {!item.supported ? (
                  <span className="capability-composer__item-badge">
                    {labels.unsupportedBadge}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {variableSuggestion.open ? (
        <ul
          className="capability-composer__popup"
          data-testid="variable-suggestions"
          style={{
            position: "fixed",
            top: variableSuggestion.top,
            left: variableSuggestion.left,
            zIndex: 50,
          }}
        >
          {variableSuggestion.items.map((item, index) => (
            <li key={item.path}>
              <button
                className={
                  index === variableSuggestion.selected
                    ? "capability-composer__item is-selected"
                    : "capability-composer__item"
                }
                data-insert-text={item.insertText}
                data-selected={index === variableSuggestion.selected}
                data-suggestion-type="variable"
                data-testid="variable-suggestion-item"
                data-variable-path={item.path}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!editor || !variableSuggestion.range) return;
                  insertVariable(editor, variableSuggestion.range, item);
                  setVariableSuggestion(EMPTY_VARIABLE_SUGGESTION);
                }}
              >
                <span className="capability-composer__item-name">
                  {item.label}
                </span>
                <span className="capability-composer__item-desc">
                  {item.insertText}
                </span>
                {variableNeedsDefault(item) ? (
                  <span className="capability-composer__item-badge">
                    {labels.variableConditionalBadge ?? "optional"}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
