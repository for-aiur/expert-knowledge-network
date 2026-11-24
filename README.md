# Expert Knowledge Network

Mobile-first closed-beta app for synthetic and technician-reported repair cases, independent peer review, and external diagnosis review. Peer assessment does not verify a physical repair.

## Local development

Use Node.js 20 or later.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace BETA_INVITE_CODE with a private random value in .dev.vars.
npm run db:migrate
npm run dev -- --port 8788
```

Run `npm test` for the Worker, D1 integration suite, and production build. `EKN_BETA_INVITE_CODE="..." npm run test:browser` runs the six-language responsive browser checks; `EKN_BETA_INVITE_CODE="..." npm run test:repairs-browser` checks drafts and repair reviews. The variable must match the local `.dev.vars` value. `npm run load:smoke` measures public-list read throughput and latency at 100 and 500 concurrent local virtual users. Synthetic local accounts use fictional `.invalid` addresses.

## Demo and diagnosis API

Start a local Worker, then run `EKN_URL=http://localhost:8788 EKN_BETA_INVITE_CODE="..." npm run seed:repairs` to create synthetic accounts and a draft. `node scripts/provision-local-client.mjs` creates a local diagnosis API client; save its one-time printed key as `EKN_CLIENT_KEY`. Run `EKN_URL=http://localhost:8788 EKN_BETA_INVITE_CODE="..." EKN_CLIENT_KEY="..." npm run seed:demo` to generate synthetic peer-reviewed, disagreement, clarification, pending and diagnosis examples. For the controlled `workers.dev` demo only, add `EKN_SEED_SYNTHETIC=YES`; the seeder refuses other remote hosts.

The API uses `POST /api/v1/tasks` and `GET /api/v1/tasks/{id}` with a bearer client key. Each client is rate limited. Do not send personal, employer, or confidential text.

## Closed-beta access

Registration requires the `BETA_INVITE_CODE` secret and explicit privacy consent. Email is not verified and password recovery is unavailable; share invitations only with intended beta users. The Profile page provides account/data deletion. The privacy notice describes the demo's data handling. Do not enable open registration until email verification, recovery, abuse controls, deletion operations and privacy/consent review are ready.

## Admin access

Register the intended administrator normally, then confirm their identity out of band. Promote only that existing account with:

```sh
npm run admin:grant -- --email="ADMIN_EMAIL"
```

The command requires typing the exact email and updates the account's D1 role through Wrangler. It does not create accounts or promote the first user. Admin endpoints check the role on the server. Default exports contain only peer-reviewed, explicitly community-shareable repair reports. Restricted internal export is limited to repair records. Review free text and data rights before reuse.

## Cloudflare deployment

Deployment uses a separate production D1 database. After Cloudflare Wrangler is authenticated:

```sh
npx wrangler d1 create expert-knowledge-network-beta
# Copy the returned database ID to env.production in wrangler.toml.
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler secret put BETA_INVITE_CODE --env production
npm run build
npx wrangler deploy --env production
```

Provision external API clients with `npm run client:provision -- --label="synthetic-demo-client"`; the generated bearer key is shown once. Keep it in the caller's secret store. Seed only synthetic examples. For the smoke check, visit the returned `workers.dev` URL, register with an invitation, submit a repair, and use a synthetic API client to create/read a diagnosis task. Confirm `/api/v1/admin/overview` returns 401 to signed-out visitors and 403 to regular accounts.

## Recovery

Apply additive D1 migrations before deploying code that needs them. If a Worker release fails, redeploy the previous known-good commit with Wrangler; do not roll back a migration by dropping tables. Restore D1 from an available Cloudflare backup/export before attempting recovery from data loss. Verify health and sign-in after rollback.
