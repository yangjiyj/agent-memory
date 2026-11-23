# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries before 0.10.0 are reconstructed from the git history: the `VERSION` constant in `hub/server.mjs` and the commit messages. Dates are commit dates.

## [0.10.0] - 2026-11-24

### Added
- Topology: 24-hour time replay, to scrub back through what happened.
- Topology: device groups, collapsible.
- Usage insights: memory gaps, the queries that found nothing.
- Usage insights: cold memories, entries that are never read.
- Memory edit history, with restore to an earlier version.
- Save an excerpt of a conversation as a memory.
- Digest preview page, with pinned, excluded, low-information and duplicate markers.
- Global search with Ctrl/Cmd+K.
- Ask my memories: question answering over the library through any OpenAI-compatible API; the API key is write-only and is never returned.
- Read-only share links with an expiry date, revocable at any time.
- Docker one-command start: `docker compose --profile demo up` for the demo data, `--profile hub` for a real hub.
- This changelog.
- Light theme (with this release).
- English interface (with this release).

### Changed
- Topology heartbeat bar now includes reads, not only writes.
- Usage records now carry hit counts, latency and errors.
- MCP page shows latency and failure rate per tool.
- The console hides projects that the viewer's device is not allowed to see.

### Performance
- Static files and API responses are compressed.
- Assets are served under content-hashed URLs with long-lived caching.
- HTML pages carry an ETag.
- Scripts and stylesheets are each merged into a single file.
- First-screen data is fetched in a single request.

## [0.9.3] - 2026-11-23

### Added
- Topology: filter by project. Everything else dims, the agents that took part light up, and the event feed narrows to that project's conversations (`topology/events?project=`).
- Wall display: a topology scene, embedding the console page through `/console?embed=1#/<page>`, which drops the sidebar and top bar.

## [0.9.2] - 2026-11-23

### Added
- Topology: live read and write flows as separate particle streams, with width following the last 24 hours of traffic.
- Topology: an event feed under the canvas; each new event sends a pulse along its link.
- Topology: per-device 24-hour activity strip and up/down counts; pause sync and read-only toggles in the device drawer.
- Topology: fullscreen, compact and two-column layouts, phone width, reduced motion, and a loading placeholder.

### Changed
- Reporter and extractor tokens record their last request, so their "last active" is accurate; `/v1/report` and `/v1/weekly` are logged as usage.
- Three or more stale devices collapse into one problem chip.

### Performance
- `usage.jsonl` is read incrementally instead of being re-parsed on every request.

## [0.9.1] - 2026-11-23

### Added
- Live topology page and the `/console/api/topology` aggregate endpoint.
- Long-lived join codes (`join-code 0`, now the default in the add-device dialog); active codes can be listed and revoked from the same dialog.

## [0.9.0] - 2026-11-23

### Added
- One sidebar console at `/console` replaces five separate pages: overview, memory library, triage, knowledge graph, timeline, projects, todos, conversation archive, devices, agents, MCP, audit, jobs, settings.
- Admin API under `/console/api`: device policy, join codes, MCP tool switches, job status, settings, conversation search.
- Demo data generator (`scripts/demo-data.mjs`), README screenshots and an architecture diagram.
- Config keys `console_viewer` and `disabled_tools`; tests run with `node --test`.

### Changed
- The wall display is now a slimmed, auto-cruising page at `/wall`; the old `/browse`, `/browse/viz`, `/browse/manage`, `/b`, `/v` and `/r` URLs redirect to the console.

## [0.8.0] - 2026-11-23

First public version.

- One self-hosted hub plus a single-file device agent, with no third-party dependencies (Node.js 18 or later).
- Syncs the native memories of Claude Code, Codex, WorkBuddy, CodeBuddy, Hermes, OpenClaw, OpenCode, Gemini CLI and Qwen Code.
- Conversation archive with secrets redacted, and a daily work journal.
- MCP tools for search, timeline, handoff packs, todos and a knowledge graph.
- Secrets are rejected or redacted before storage; tokens are stored as sha256; device roles and per-device read-only or hidden projects.
- Dashboard, year in review and a memory management console; optional identity gateway and local embedding service.
