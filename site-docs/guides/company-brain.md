---
title: "Review company and project knowledge"
description: "Find structured assertions, inspect original evidence, review proposals, and confirm facts under explicit authority."
---

Company Brain stores identifiable company and project knowledge. Use **Knowledge**
to search assertions and inspect their sources. Company ownership works without
a repository; access is configured separately from ownership. Private agent
memory and your personal librarian's memory remain separate.

## Prerequisites

You need an active account and current read access to the knowledge and its
sources. Proposing, reviewing and confirming require their own permissions.
Project knowledge also respects project access and Brain enablement.

For company knowledge, an installation administrator opens **Settings → Company
access**, selects **Grant access**, chooses an existing user or specialist and
checks the exact actions to permit. Administrator status alone grants no company
content access: an administrator who needs to read or review must explicitly
grant those actions to their own account. Company access needs no dummy project.

## Find and inspect an assertion

Open **Knowledge** and search by text. Filter by owner, knowledge kind,
confirmation, freshness or unresolved conflicts. Filters remain in the URL for
refresh and browser navigation. Follow **Next page** for additional accessible
results.

Open a record to inspect its stable identity and revision, ownership and
visibility, submitting user or agent, originating execution where available, and
available timestamps. Unknown historical authorship or source applicability
stays unknown.

The record presents separate facts:

| Field                | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| Assertion basis      | Observed, inferred or unknown                              |
| Factual confirmation | Unconfirmed, confirmed for this revision or revoked        |
| Freshness            | Current, stale or unknown from available source metadata   |
| Conflicting claims   | Accessible opposing records, with their original revisions |

A search match or confidence score cannot confirm an assertion. Follow
**Inspect evidence** to inspect the captured source version, content witness,
availability and original source group. Repeated references to one source are
not independent observations. A missing or inaccessible reference does not
permit an invented citation.

## Propose an addition or correction

Select **Propose knowledge**, choose the owner, and enter a title, kind,
assertion and basis. You can capture an exact source title and text. A capture
records submitted bytes and attribution; it does not independently establish
that the assertion is true. If evidence is absent, describe what is missing and
record relevant limitations.

For an existing record, select **Propose correction**. The proposal names the
exact base revision and retains its original witness references. Review retained
limitations and missing-evidence declarations before submitting. Another accepted
correction can make that base stale; inspect the current record and prepare a
fresh proposal rather than overwriting someone else's work.

## Review publication and confirmation separately

**Proposal review** lists the proposals you may currently review. Inspect the
assertion and evidence, enter a decision reason, then accept or reject.
Acceptance publishes a record; it does not confirm the fact.

**Published record** opens the exact accepted revision. **Open current record**
resolves the current head. With confirmation authority, select available
supporting witnesses and enter a confirmation reason before choosing **Confirm
assertion**. Stale, missing or unknown source support cannot establish a new
confirmation. A correction starts unconfirmed even when the previous revision
was confirmed.

Revoking confirmation is a separate explicit decision with a reason and
confirmation dialog. Prior confirmation history remains tied to its original
revision.

## Handle unavailable references and retries

If a reference becomes unavailable, inspect current access with its owner.
Company-owned knowledge can survive deletion of a source project; evidence that
depended on that project may become unavailable. Brain references do not prevent
project deletion.

When an action has an uncertain response, inspect the proposal or record before
starting different work. Retrying unchanged input in the same form reuses its
delivery identity. A changed revision or conflicting decision requires review
of the current state.

Administrators revoke company authority in **Company access** with an exact
revision and reason. Revocation takes effect for new actions and reads. Original
grant deliveries cannot restore revoked authority; intentional restoration
requires a new grant.
