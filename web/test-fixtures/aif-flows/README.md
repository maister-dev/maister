# AIF flow test fixtures

Snapshot of the five AIF flow graphs (v1 manifests) taken when `plugins/aif`
was extracted to the external `maister-plugins` repo (ADR-088), with the
maintained Plan-review contract overlay used by this branch's engine tests.
These are **test fixtures** for engine behavior (manifest loading, graph
validation, settings, rework comments, authoring round-trips) — NOT the
shipped package. The canonical package is `maister-plugins/packages/aif` at
`aif/v2.5.0` (`e25937f`) and is validated through the package install pipeline.
