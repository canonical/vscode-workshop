# Change Log

All notable changes to the "workshop" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.5.4] - 23-09-2026

### Changed

- README: add intro video

## [0.5.3] - 17-09-2026

### Changed

- README: feature overview, screenshots, and a link to the step-by-step guide
  in the Workshop documentation.

### Added

- Pre-install a matching VS Code server into a workshop over SSH before
  connecting, so Remote-SSH never downloads it on the air-gapped host. Supports
  both the legacy `bin/<commit>` and CLI `cli/servers/Stable-<commit>` layouts,
  caches downloads locally, and can be disabled with `workshop.preinstallServer`.

### Added

- Workshop mount interface panel

## [0.5.0] - 27-08-2026

### Added

- Support `workshop launch` and `workshop refresh` workflows
- Support `--wait-on-error` mode for debugging refresh errors
- Show workshop info in the tree view
