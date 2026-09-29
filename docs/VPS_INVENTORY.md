# VPS Inventory (public summary)

The full read-only inventory (2026-09-29) lives in `docs/private/VPS_INVENTORY.local.md`. It is
git-ignored because it contains server addresses, open ports and other projects' details. This
repository is public, so none of that belongs here.

## Findings that shape Blink's design

- The VPS is shared with many unrelated projects. Blink must stay fully isolated (MASTER_PROMPT,
  "VPS isolation").
- Node 22 is installed globally, and Blink targets Node 22 (`.nvmrc`). No global runtime changes.
- The existing PostgreSQL belongs to another project and is **not** reused. Blink runs its own.
- Memory is limited (no swap), so **the Android APK is not built on the VPS**. EAS Build is used
  instead (see DECISIONS D-9).
- The existing reverse proxy serves other sites. Blink adds one site block only, after a backup and
  config validation, then reloads (never restarts).

## Blink footprint (all names and ports verified free on 2026-09-29)

| Resource | Name |
|---|---|
| Directory | `/opt/blink-to-stock` (its own git clone) |
| Env file | `/opt/blink-to-stock/.env`, mode 600 |
| PM2 process | `blink-api`, bound to 127.0.0.1:4310 |
| Docker compose | project `blink-to-stock`: `blink-postgres`, network `blink-network`, volume `blink-postgres-data`, bound to 127.0.0.1:5433 |
| Database / user | `blink_to_stock` / `blink_app` |
| Public access | only through a Blink-specific reverse-proxy site (domain: NEEDS_OWNER_DECISION) |
