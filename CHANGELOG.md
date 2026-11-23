# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries before 0.10.0 are reconstructed from the git history: the `VERSION` constant in `hub/server.mjs` and the commit messages. Dates are commit dates.

## [0.10.0] - 2026-11-24

### Added
- **Topology**: the heartbeat bar shows reads next to writes (per-hour counts on hover); a 24-hour time replay under the canvas (drag or play, "back to now"; the wall display loops it automatically); devices can be put into groups, shown on one plate and collapsible into a single summary node.
- **Triage**: *memory gaps* (queries that found nothing in the last 30 days, near-duplicate wordings merged, can be ignored and restored) and *cold memories* (active memories nobody has read since a stated date; it says "still collecting data" until enough days have accumulated).
- **MCP page**: 7-day latency (median, p95) and failure rate per tool. Usage records now carry `hits`, `ids`, `dur` and `err`; older rows stay readable.
- **Memory history**: every version with time, author and diff, and restore to any version (adds a new version; native-synced memories cannot be restored).
- **Save as memory**: select text in a conversation and store it as a memory with a provenance line.
- **Digest page** (Memory › Digest): preview the digest a given agent on a given device receives, budget use, pin or exclude entries (`state/digest-rules.json`), flags for low-information and duplicate titles.
- **Global search** (`Ctrl/Cmd+K`) over memories, conversations, projects, devices and pages. The **Ask** tab answers from your memories and conversations through any OpenAI-compatible endpoint (`ask_url`, `ask_model`, `ask_key`; the key is write-only and never returned), with clickable citations, rate limiting and an audit record.
- **Share links**: `/s/<token>` for a project's timeline or handoff pack, valid for 1, 7 or 30 days, revocable, work-log summaries only (no conversation text); only the token hash is stored. See [docs/share-links.md](docs/share-links.md).
- **Light theme** (follows the system by default, switch in the top bar) and **English interface** (`中 / EN`, runtime translation in the browser; the hub's API messages stay Chinese).
- **Docker**: `docker compose --profile demo up` for the demo data, `--profile hub` for a real hub.
- This changelog.

### Changed
- `hide_projects` now also applies to the console and `/browse/*` (topology, timeline, projects, conversations, memories, todos, handoff, digest preview, search, ask), with totals recomputed. A device that has a hide list can no longer edit hide lists in the console. MCP tools other than `memory_search` / `memory_get` and the device-side `/v1/*` endpoints are unchanged.
- The authentication gateway sets `TCP_NODELAY`, which saves about 40 ms per request.

### Performance
- Static files and API responses of 1 KB or more are compressed (br, then gzip).
- `console.html` is rewritten at runtime: adjacent stylesheets and scripts become one content-hashed bundle each (`immutable` caching); the html itself is `no-cache` with an ETag.
- First-screen data comes from one request (`GET /console/api/boot?page=…`): opening the topology page takes three requests after the html instead of twenty-three.

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
