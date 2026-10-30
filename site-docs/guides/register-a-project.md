---
title: "Register a project"
description: "Connect an existing local or remote git repository to MAIster without exposing its credentials."
---

## Prerequisites

- Administrator access to MAIster
- A git repository reachable from the MAIster host
- A clean default branch
- Host credentials for cloning or fetching the repository

## Register an existing directory

1. Open **Projects → Add project**.
2. Choose the existing-directory onboarding mode.
3. Enter the absolute repository path.
4. Optionally set the display name.
5. Submit and review validation results.

When `maister.yaml` is absent, MAIster validates defaults in memory and registers
the runtime configuration without creating a file. The checkout stays clean.
Use [Save project configuration to Git](/guides/save-project-configuration) when
you want a reviewed configuration commit. A present invalid file causes a
configuration error and remains unchanged.

## Clone a remote repository

Choose a supported remote onboarding mode and supply the repository URL. Use
host SSH configuration, a credential helper, an authenticated provider CLI, or
the one-time credential field shown by the UI. Credentials are used for the
operation and are not written to `maister.yaml`.

## Validation

Registration verifies repository identity, path uniqueness, project slug,
manifest structure, Flow bindings, and runner references. Correct every error
before retrying; MAIster does not silently substitute another repository,
Flow, or runner.

## Result

The new project appears in the portfolio and project list. Open its board to
create the first task or launch a scratch session.
