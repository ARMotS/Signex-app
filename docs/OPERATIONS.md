# Signex — Operations Runbook

Sized for **5 branches, ~20 drivers each (~100 accounts)** on Vercel + Neon.

Each rule below exists because breaking it caused, or would cause, a specific
failure. The reasons are kept alongside the rules deliberately — a rule without
its reason gets "simplified" away by the next person.

---

## 1. Environment variables

### Database — getting these the wrong way round is the classic outage

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | **Pooled** (host contains `-pooler`) | The application at runtime |
| `DATABASE_URL_DIRECT` | **Direct** (no `-pooler`) | Prisma CLI — migrations only |

The `pg` pool `max` is a **per-instance** ceiling, not a global one. Vercel scales
out under load, so the real connection count is roughly `max × live instances`.
Pointing the runtime at the direct endpoint exhausts Neon's `max_connections` as
soon as a few branches are busy, and every branch stalls at once.

Migrations need the direct endpoint because they take advisory locks and run DDL,
neither of which survives a transaction-mode pooler.

`DATABASE_POOL_MAX` (default 5) tunes the per-instance pool. Raise it only if you
have measured queueing *inside* one instance — the pooler does the real fan-out.

> If the runtime is on a non-pooled Neon host, `lib/db.ts` logs a warning at
> startup. Check the Vercel function logs after a deploy.

### Rate limiting

| Variable | Notes |
|---|---|
| `UPSTASH_REDIS_REST_URL` | REST API URL, not the `redis://` one |
| `UPSTASH_REDIS_REST_TOKEN` | |

Without these the limiter falls back to per-instance in-memory counters. The app
still works, but the shared login limit is no longer actually shared.

### Also required

`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (rotating this makes stored OneDrive
tokens undecryptable — every admin must reconnect), `MICROSOFT_CLIENT_ID` /
`_SECRET` / `_REDIRECT_URI`, SMTP settings. See `.env.example`.

---

## 2. Rate limits

| Caller | Budget | Keyed on |
|---|---|---|
| Admin / super-admin | 600/min | **session** |
| Driver | 240/min | **session** |
| Anonymous | 300/min | IP |
| Login failures | 5 per 15 min | IP |

**Authenticated traffic is keyed per session, not per IP.** Five admins in one
branch office share one NAT address; keying on IP put them in a single bucket, so
ordinary use by a full office looked identical to abuse by one machine.

**`apiAnon` is not comparable to the per-session limits.** It is a *shared* pool —
everyone behind one address draws from it. It is sized for **shift change**: a
whole depot loading the sign-in page together, before anyone has a session to key
on. If you shrink it, do that arithmetic first (drivers × requests-before-login).

Everything **fails open**. A Redis error degrades to in-memory rather than
rejecting, because a driver at a customer's door must never be blocked from
capturing a signature by a cache having a bad minute.

---

## 3. Live updates

`GET /api/sync` returns an **opaque cursor**. Clients compare it for equality and
refetch only when it moves. Never parse it — the shape is free to change.

The cursor pairs `MAX(updatedAt)` with a **row count** per table. A timestamp
alone misses deletions: completing a trip sheet removes it and cascades its stops
away, which advances nothing — and moves the maximum *backwards* when the deleted
row was the most recently touched. A driver would sit looking at stops that no
longer exist.

A driver's cursor covers only their own work, so one driver signing does not wake
the other nineteen devices.

`hooks/useLiveSync.ts` pauses on hidden tabs and offline, never stacks requests,
backs off on errors, and honours `Retry-After` on 429.

> `/api/sync` is polled continuously by every signed-in device. A scoping bug
> there is not a one-off disclosure — it is a standing side channel. It is
> covered in `tests/isolation.test.ts`; keep it that way.

---

## 4. Microsoft Graph / OneDrive

**Address files by path, never by listing.** `getInvoiceItemByName` and
`downloadSignedInvoiceByName` resolve one file in one request. The listing
approach they replaced enumerated an entire folder to translate a filename into
an item id — and for signed invoices, twice.

**Filenames must go through `assertSafeItemName`.** They arrive from a URL path
parameter and are interpolated into a Graph path, where `/` is a separator and
`..` is a parent. Unsanitised, `../../Documents/payroll.pdf` reads anywhere in
that admin's drive.

**All Graph calls go through `graphFetch`** (`lib/graph-retry.ts`), which honours
`Retry-After` on 429/503/504. A 429 means Graph did *not* process the request.

**Token refresh is single-flight.** Microsoft *rotates* refresh tokens, so two
concurrent refreshes produce two replacements and the loser's is already dead —
taking that branch's OneDrive offline until an admin reconnects by hand.
Correctness rests on the **compare-and-swap** in `performRefresh`, not on the
Redis lock: the lock can expire mid-flight and Redis may be absent.

---

## 5. Verification

```bash
npm test                 # unit suite, no database needed
npx tsc --noEmit         # typecheck
npx eslint .             # lint
```

### Isolation suite — run before any deploy touching data access

```bash
# Use a THROWAWAY database. The suite deletes every row in every table.
TEST_DATABASE_URL="<neon branch DIRECT url>" npx prisma db push --url "<same>"
TEST_DATABASE_URL="<neon branch DIRECT url>" npm run test:isolation
```

Two traps, both hit in practice:

- **Use the DIRECT endpoint, not the pooler.** Session state leaks across
  PgBouncer connections, which can leave the pooled endpoint stuck in a state the
  suite cannot write through.
- **`prisma dev` cannot host this.** Its local server ignores the database name in
  the connection string and serves one underlying store, so `CREATE DATABASE`
  gives you an alias, not isolation — and the suite would truncate your dev data.
  Use a Neon branch.

### Load

```bash
node scripts/smoke-concurrency.mjs --url https://<host> \
  --path /api/sync --cookie "signex-session=<value>" \
  --concurrency 25 --requests 500
```

`p95` is the number that matters — the slowest 1 in 20 is what a driver notices.
Any 5xx is a real failure. Any 429 at realistic volume means the limits are too
tight for the way the app polls.

### Health

`GET /api/health`

| Code | Meaning |
|---|---|
| 200 `ok` | Healthy |
| 200 `degraded` | Redis unavailable or unconfigured. Rate limits and the refresh lock fall back; **deliveries continue** — not an outage |
| 503 `down` | Postgres unreachable. Take the instance out of rotation |

---

## 6. Post-deploy checklist

1. `GET /api/health` returns **`ok`**, not `degraded`. `degraded` means Upstash
   is not wired up.
2. Function logs contain **no** non-pooled Neon warning from `lib/db.ts`.
3. Sign in as a driver on a phone; deploy a trip sheet from another browser and
   confirm it appears within ~15s **without reloading**.
4. Sign one stop and confirm the admin dashboard updates on its own.
5. Run the smoke test against production and confirm no 429s and no 5xx.

---

## 7. Known constraints

- **`xlsx` is pinned to a tarball from `cdn.sheetjs.com`.** SheetJS no longer
  publishes fixed builds to npm, and the last npm release carries unpatched
  prototype-pollution and ReDoS advisories. **Builds therefore depend on that CDN
  being reachable.** `tests/xlsx-compat.test.ts` pins the exact API the trip-sheet
  parser relies on, so a bad version upgrade fails loudly.
- **`package.json` has an `overrides` block** (`postcss`, `sharp`,
  `brace-expansion`, `minimatch`) forcing patched versions inside the dependency
  tree. **Re-check it whenever Next.js is upgraded** — a stale override can pin
  you to an old package.
- **One active session per account.** Signing in on a second device logs the first
  out within 30 seconds. Each driver needs their own account.
- **Sessions last 24 hours from login and do not roll.** Fine for a 10-hour shift.
