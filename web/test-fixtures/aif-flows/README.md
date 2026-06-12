# AIF flow test fixtures

Verbatim snapshot of the five AIF flow graphs (v1 manifests, pre-`aif/v2.0.0`
bump) taken when `plugins/aif` was extracted to the external `maister-plugins`
repo (ADR-088). These are **test fixtures** for engine-behavior tests
(manifest loading, graph validation, settings, rework comments, authoring
round-trips) — NOT the shipped package. The canonical package lives in
`maister-plugins/packages/aif` and is validated through the package install
pipeline.
