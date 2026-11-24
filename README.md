# Expert Knowledge Network

[![Tests](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml/badge.svg)](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml) [![Latest release](https://img.shields.io/github/v/release/for-aiur/expert-knowledge-network?display_name=tag&sort=semver)](https://github.com/for-aiur/expert-knowledge-network/releases/latest) [![Live beta](https://img.shields.io/badge/Live-Beta-117668?logo=cloudflare&logoColor=white)](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev)

[Open the deployed beta](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev) · [Swagger API](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api-docs)

A platform for technicians to share repair knowledge and review technical diagnoses.

## User flow

Technicians submit repair reports, respond to reviewer questions, and review cases matching their expertise. External clients submit AI diagnoses for independent assessment.

## Features

- Submit and manage repair reports, including drafts and clarification responses.
- Review repair cases with a structured technical rubric.
- Request independent expert review of AI diagnoses through the API.
- Track contribution points, reputation and professional community achievements.
- Use the interface in English, German, Turkish, Polish, Russian or Arabic.
- Give administrators controlled access to approved, shareable data.

## API

[Open the interactive Swagger documentation](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api-docs). The OpenAPI file is available at [openapi.yaml](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/openapi.yaml).

External API access uses a bearer key issued by an administrator. Each client can create private diagnosis review tasks and read its own task results. Requests are limited to 60 per minute. Personal contact details and confidential text are rejected.

The result includes status, review counts, an aggregated assessment, safety and disagreement flags, and individual rubric answers with redacted reasoning.

1. Submit a diagnosis with `POST /api/v1/tasks` and a unique `Idempotency-Key`.
2. Save the returned task ID.
3. Check progress and results with `GET /api/v1/tasks/{taskId}`.

Example submission:

```sh
curl -X POST https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api/v1/tasks \\
  -H "Authorization: Bearer $EKN_CLIENT_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: diagnosis-2026-0042" \\
  -d '{
    "schema_version": 1,
    "content_language": "en",
    "required_reviews": 2,
    "equipment_category": "hvac",
    "symptoms": "The unit shuts down after several minutes under load.",
    "proposed_diagnosis": "Possible restricted airflow.",
    "supporting_evidence": "The intake filter was visibly obstructed.",
    "recommended_next_steps": "Inspect the filter and measure airflow."
  }'
```

Use the returned `id` to retrieve progress and review results:

```sh
curl https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api/v1/tasks/TASK_ID \\
  -H "Authorization: Bearer $EKN_CLIENT_KEY"
```

Achievements recognize peer-reviewed reports and completed reviews. They are community milestones, not professional credentials.

## Develop

Requires Node.js 20 or later.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Run `npm test` to build and run the test suite. Local fixture scripts are for local development only.

## CI/CD

GitHub Actions tests pushes and pull requests. Merging to `main` deploys the beta after tests pass. Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Protect `main` by requiring pull requests and the `Tests / test` check.
