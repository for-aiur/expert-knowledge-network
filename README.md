# Expert Knowledge Network

A six-language repair knowledge prototype. Technicians can save and submit repair reports, receive independent peer feedback, and browse reports shared with the community after approval.

## Run locally

Use Node.js 20 or later.

```sh
npm ci
npm run db:migrate
npm run dev -- --port 8788
```

Open [localhost:8788](http://localhost:8788). For a synthetic draft and demo accounts, run `EKN_URL=http://localhost:8788 npm run seed:repairs` in another terminal.

Run `npm test` for the build and integration suite. The repair forms and review rubric live in `config/`.

Use synthetic data. Public signup requires email verification and password recovery.

## Diagnosis tasks (M3)

For a local demo, run `EKN_URL=http://localhost:8788 npm run seed:repairs` against the running app to create synthetic HVAC reviewer accounts. Set a client key with `export EKN_CLIENT_KEY="$(node scripts/provision-local-client.mjs)"`. This local helper prints a generated key once and stores only its hash in D1.

```sh
curl -X POST http://localhost:8788/api/v1/tasks \
  -H "Authorization: Bearer $EKN_CLIENT_KEY" \
  -H 'Idempotency-Key: synthetic-hvac-1' \
  -H 'Content-Type: application/json' \
  -d '{"schema_version":1,"content_language":"en","equipment_category":"hvac","symptoms":"Synthetic simulator shows no airflow.","proposed_diagnosis":"The simulator may have lost its airflow sensor signal.","recommended_next_steps":"Inspect the saved simulator log."}'
```

Sign in separately as the matching demo reviewers, complete the diagnosis assessments under **Reviews**, then call `GET /api/v1/tasks/<id>` with the same bearer key. Creation returns a stable ID and the initial pending status. GET reports the current state. Run `node scripts/demo-diagnosis.mjs` to create a fresh task and poll for a result while reviewers work. Both endpoints are limited to 60 requests per minute per client. An idempotency key can be retried with the same payload. A changed payload returns HTTP 409.

Send only task-relevant technical text stripped of personal and client information. The API rejects obvious contacts, links, and API keys in input and redacts common contact tokens and the reviewer's recorded nickname from returned reasoning. Free-text detection cannot identify every private detail. Reviewer identity fields are never returned.

Two reviewers are required by default. Set `required_reviews` to 3 for a larger initial round. Each diagnosis has at most five assignments, including replacements and one tie-breaker. Abstentions do not count as votes. A mixed verdict needs a decisive tie-break and a strict majority with enough non-abstaining assessments. A recorded unsafe next step prevents approval regardless of other votes. An inconclusive result may change if a new eligible reviewer becomes available before the cap and opens Reviews. Peer review is an assessment of the proposed diagnosis and does not verify a physical repair.
