# Claim node duration stops before session teardown

**Date:** 2026-11-11
**Files:** `web/lib/runs/keepalive-sweeper.ts`, `web/lib/runs/budget-termination.ts`

## Problem and cause

The duration watchdog sent a session DELETE before claiming the current node
attempt. Cancellation could wake the accepted ACP prompt while the process was
still retiring. The prompt driver then tried to close the same session, and the
host refused the overlapping command because process retirement was unconfirmed.

## Solution and prevention

Claim the exact Run, attempt and incarnation with the existing durable budget
termination intent before sending DELETE. Prompt settlement yields to that
owner, and the watchdog keeps its intent until it observes confirmed retirement.
When the completed prompt already has pending application, the attempt owner
applies the result first.

The real-supervisor regression holds the deletion acknowledgment while the
prompt driver wakes. It checks that the driver yields, the retained owner
recovers an unconfirmed teardown, and exactly one duration failure is recorded.
