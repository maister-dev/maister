---
title: "Diagnose and restart a configured stand"
description: "Assign maintenance to a specialist, approve one systemd restart and review independent health evidence."
---

## Prepare the stand and specialists

Use MAIster engine 3.12.0 or later, a Ready Claude ACP runner, and a Linux stand with the MAIster stand helper. The operator configures the target identity, mTLS peers, exact systemd service and scope, permitted actions, an independent health probe and the exact runbook revision. Keep credentials in host service configuration.

1. [Install and trust the reviewed `stand-operations` package revision](/guides/package-sources-and-versions). Verify the resolved commit against the approved package pin.
2. In **Settings → Company specialists and coordinators**, bind `stand-operations:coordinator` and `stand-operations:diagnostic` to the reviewed revision and a Ready runner. Bind `stand-maintenance` as a workspace-free, result-only company Flow. Map its `operator` role to an authorized user.
3. Grant the diagnostic specialist current read access to the assignment, target, logs and runbook. Grant the coordinator the actions required to delegate, accept child work and request the configured restart. The requester and operator need their own current grants. The **Assisted** execution policy can admit scoped tools while retaining the human gate and exact restart approval.

## Submit and verify an assignment

1. Open **Work → Specialist assignments**. Select the coordinator and target component. State the symptom and expected result. A company assignment does not require a project.
2. Follow the assignment's **Working context** and **Execution and delegated work** links. If the specialist requests clarification, answer in **Inbox** so the response stays with the assignment.
3. In **Stand operations**, verify the component, operation ID and intent digest. Enter a reason and select **Approve this restart**. Continue the Flow's authorization step in **Inbox**. The approval and the Flow response are separate actions.
4. Inspect the **Effect receipts** and **Verification receipts**. A successful restart has an applied receipt for the original operation and a separate healthy probe. Open the result and select **Accept verified outcome** when its evidence satisfies the requested checks.
5. If the result contains a draft, select **Submit retained knowledge drafts**. Review the proposal and its evidence in [Knowledge](/guides/company-brain). Assignment acceptance, publication and factual confirmation have separate controls.

## Schedule read-only health checks

In **Settings → Company specialists and coordinators**, select a reviewed `stand-operations:inspector` binding and an allowed component. Enter the cron expression, time zone and recurring request, then enable the schedule. The specialist uses the component's configured health probe. A healthy result with no changes stays in assignment history. Repeated failed probes update one incident.

Disable the old schedule and create a reviewed appointment when the target configuration changes.

## Recover an uncertain effect

If the coordinator stops before restart dispatch, a user with current recovery access can select **Recover** on the assignment. The same Run continues after MAIster verifies that the previous session has stopped. The assignment keeps its operation intent and previously accepted work.

If a restart response is lost, open the original operation and select **Check the original receipt**. Its effect can remain unknown and hold the resource. An authorized operator can inspect the current service state, leave the hold in place or approve a separate recovery assignment when eligible. A successor requires a new exact approval. When an applied receipt is available, use **Run health check** for independent evidence.
