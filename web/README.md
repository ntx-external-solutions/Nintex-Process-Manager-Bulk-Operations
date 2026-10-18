# Bulk Operations web app

The web replacement for the PowerShell script in the repository root. The design is
in [`handoff/SPEC-WEB.md`](../handoff/SPEC-WEB.md).

Status: the foundation (W0). Sign-in, the proxy and a landing page work. The proxy's
allowlist is read-only, and the four operation tiles are disabled until the tasks that
build them land.

## Where the foundation came from

Lifted from
[process-group-manager](https://github.com/ntx-external-solutions/process-group-manager)
at commit `429b6403e28b37bb1572241291954fc3311b2a81`, then cut down and adapted:

| Kept from PGM | Changed here |
|---|---|
| `lib/auth/*`, `app/api/auth/route.ts` | Cookie renamed to `npmbo_session` so the two apps can share `localhost`. |
| `app/api/pm/route.ts`, `lib/pm/operations.ts` | Allowlist cut to `groups.tree`, `process.summary` and `processes.list`. `WRITE_OPERATIONS` is empty and a test holds it there. |
| `lib/pm/client.ts`, `types.ts`, `scim.ts` | Unchanged apart from test fixtures. |
| `lib/pm/groups.ts` | Group create and rename removed. Tree read, `ValidateGroupAction`, `ReorderTreeNodes` and viewer counts kept for later tasks. |
| `lib/pm/processes.ts` | Shortcut editing, the process PUT and the CSV report removed. |
| `lib/exec/journal.ts` | Action kinds and step names are this app's (archive, publish, restore, update, delete, move). |
| `lib/exec/runner.ts` | Reduced to the shared machinery: stop and cancel controls, the fatal-error rule, batched execution. PGM's group, champion and shortcut steps are gone. |
| `lib/exec/report.ts` | Rewritten to the PowerShell script's results columns, so the two tools' files read the same. |
| `lib/plan/tree.ts`, `lib/ui/treeCache.ts` | CSV path resolution removed. The whole-tree loader moved from PGM's `orchestrate.ts` to `lib/plan/load.ts`. |
| `lib/plan/revalidate.ts` | Generalised from PGM's group-plan checks to one question: is each planned item still in the level the preview saw it in? |
| `lib/csv/parse.ts`, `lib/ui/gateway.ts`, `download.ts`, `next.config.mjs` | Gateway reduced to the read-only operations. Security headers unchanged. |

Tenant ids and GUIDs captured from a live tenant in PGM's tests were replaced with
synthetic ones.

## Running it locally

Needs Node 24.

```sh
cd web
npm install
cp .env.example .env.local
# put a secret of at least 32 characters in AUTH_SECRET:
#   openssl rand -base64 48
npm run dev
```

Open http://localhost:3000 and sign in with a Process Manager address (including the
tenant segment, for example `https://demo.promapp.com/your-tenant`), username and
password. The password is exchanged for a token and dropped. The token is sealed into
an httpOnly cookie.

Sign-in uses the password grant, so tenants that sign in only through SSO cannot use
this app.

## Checks

```sh
npm test          # node --test over src/**/*.test.ts
npm run typecheck
npm run build
```

## Deploying

Create a Vercel project from this repository with **Root Directory** set to `web`. The
root directory is a project setting in Vercel, not something `vercel.json` can set, so
`web/vercel.json` only names the framework. Set `AUTH_SECRET` in the project's
environment variables. Deploy to a Nintex team on Pro: Hobby is for non-commercial use.
