# Company specialists settings

Route: `/settings/specialists` (query `binding`, `revision`, `kind`).
Status: Implemented.
Source: `web/app/(app)/settings/specialists/`,
`web/components/specialist-assignments/binding-review-form.tsx`,
`web/components/specialist-assignments/stand-inspection-schedule-form.tsx`.

## JTBD

When I make an installed agent a company specialist or coordinator, I want to
review its exact package revision and authority before binding it, so later
assignments run under a configuration I approved. When a read-only stand
inspector exists, I want to schedule recurring inspections without granting
restart authority.

## Roles & capabilities

| Authority | Visible surface and actions |
| --- | --- |
| `specialists:read` | Specialist and coordinator binding list, exact revision inspection |
| `specialists:manage` | Binding review forms, inspection schedules (create / disable) |

## Navigation

Reached from administrator [Settings](settings-brain.md). A binding opens its
exact revision through `?binding=…&revision=…`; assignments that use it are listed
on the [specialist assignments](specialist-assignments.md) screen.

## Layout & regions

A two-column list of specialist and coordinator bindings with their configuration
revisions; the selected revision's configuration; active inspection schedules
with a disable control; the inspection schedule form (only for an enabled,
read-only stand inspector); and two binding review forms (specialist,
coordinator).

## States

Empty list when no binding exists; management regions are hidden without manage
authority; an unknown or inaccessible binding selector shows no revision.

## Data & APIs

`listCompanySpecialists`, `getCompanySpecialistBindingRevision`,
`getCompanyFlowBindingRevision` and the page's server actions
(`createSpecialistBinding`, `createCoordinatorBinding`,
`createStandInspectionSchedule`, `disableStandInspectionSchedule`). Behaviour is
owned by [specialist runtime](../system-analytics/specialist-runtime.md) and
[stand maintenance](../system-analytics/stand-maintenance.md).

## i18n

`specialistAssignments`.

## Linked artifacts

[#adr-203](../decisions.md#adr-203-durable-specialist-assignments-and-company-coordinator-flows),
[specialist runtime](../system-analytics/specialist-runtime.md).
