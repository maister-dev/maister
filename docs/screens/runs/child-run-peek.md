# Child Run peek (Implemented)

Route: `/runs/:main?peek=:selected&peekView=conversation|execution|result&peekNode=:node`.
Source: `web/components/runs/run-peek-panel.tsx` (Implemented).

## JTBD

When a Run delegates work, inspect a descendant's execution and public result while keeping the main Run's view and draft.

## Roles and capabilities

Project viewers can inspect authorized metadata and public results; transcript/evidence content requires `readRepoFiles`. No interactive child action lives in peek. Each Run/path is independently authorized.

## Navigation

Both child lists open one anchored peek. Breadcrumbs, sibling selection, descendants and Previous change its content. Close returns focus. Open full Run goes to the selected Run's normal page without parent query keys.

## Layout and regions

The header names the selected Run, hierarchy, execution status and independent result status. Conversation or controlled Flow details and public result use existing renderers. Desktop uses the inspector slot; narrower or fullscreen-Flow layouts use a single modal sheet. Competing inspector/librarian presentation is suspended and restored as specified by the behavior owner.

## States and accessibility

Loading, empty, denied, unavailable, incompatible, error, disconnected and terminal states are explicit. EN/RU parity, keyboard focus, inner-first Escape and responsive restoration are contractual.

## Linked artifacts

- [Navigation contract](../../system-analytics/run-peek-navigation.md).
- [Data and live-delivery contract](../../system-analytics/run-peek-data.md).
- [Run inspector](run-inspector.md).
