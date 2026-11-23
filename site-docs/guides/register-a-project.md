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

After registration the browser opens the new project. If the repository has no
remote or needs an initial commit, the board shows the next Git step. Choose
**Declared dependencies** to inspect packages, standalone Flows and capability
imports. Their installations continue independently after registration. An
unreachable dependency stays in the list with its requested version and failure
stage. The project remains available and other dependencies can finish.

A platform administrator can retry the failed item or edit a package's source,
version and optional subdirectory. Saving the pin queues a fresh installation.
Use **Register another** to connect the next repository.
