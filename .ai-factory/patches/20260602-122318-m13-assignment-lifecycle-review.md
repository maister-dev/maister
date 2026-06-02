# M13 assignment lifecycle review patch

## Trigger

Opus review found that M13 assignment rows could outlive terminal run paths, and
that public assignment contracts advertised states/action kinds the current
service layer never creates.

## Patch

- Close active `open`/`claimed` assignments from terminal lifecycle paths through
  a system actor, including promote, discard/abandon, runner crashes/failures,
  reconcile, keepalive timeout, and terminal HITL timeout/resume failure.
- Complete linked HITL assignments from the current actor on successful response
  and idle auto-delivery.
- Keep assignment statuses limited to reachable durable states:
  `open`, `claimed`, `completed`, `cancelled`.
- Keep assignment action kinds limited to implemented current work types:
  `permission`, `form`, `human_review`, `manual_takeover`, `merge_conflict`.
- Revalidate pinned Flow manifests against active `project_flow_roles` at launch,
  because roles can be removed after package install.
- Share assignment DTO serialization across assignment action and project-list
  routes, including batched actor lookup.

## Guardrails

- Treat Flow roles as routing labels, never auth roles.
- Treat actors as broader than humans: user actors are current UI/API ingress,
  but system actors must own lifecycle cleanup events.
- Do not document future assignment statuses as current enum values unless the
  service can actually transition to them.
