# Expert Knowledge Network

[![Tests](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml/badge.svg)](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml)

[Open the beta](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev)

A practical knowledge-sharing platform for technicians. Share repair experience, learn from independently reviewed cases, and build a reputation through useful contributions.

## User flow

Technicians create an account, choose areas of expertise, and submit a repair report. The community can review eligible reports independently. Authors can track progress, respond to clarification requests, and see points and achievements for useful contributions. External clients can submit AI diagnoses through the API and retrieve independent expert assessments.

## Features

- Submit and manage repair reports, including drafts and clarification responses.
- Review repair cases with a structured technical rubric.
- Request independent expert review of AI diagnoses through the API.
- Track contribution points, reputation and professional community achievements.
- Use the interface in English, German, Turkish, Polish, Russian or Arabic.
- Give administrators controlled access to approved, shareable data.

## API

[Open the interactive Swagger documentation](/api-docs.html). The OpenAPI file is available at [`/openapi.yaml`](/openapi.yaml).

External clients can submit an AI diagnosis for independent review with `POST /api/v1/tasks`, then retrieve its status and assessment with `GET /api/v1/tasks/{taskId}`. Access requires a provisioned bearer API key. Task creation requires an idempotency key and includes equipment category, symptoms, proposed diagnosis, optional supporting evidence and next steps, content language, and the requested number of reviews. Personal contact details and confidential context are rejected.

The result provides task status, required/assigned/completed review counts, an aggregate assessment with disagreement and safety indicators, and individual rubric answers with redacted reasoning. Tasks are private to the API client that created them. Possible statuses include pending, in review, needs clarification, disputed, peer reviewed, rejected and inconclusive. API clients are limited to 60 requests per minute.

Typical flow: obtain a client API key from the platform administrator, submit a diagnosis task with a stable `Idempotency-Key`, save the returned task ID, poll the task endpoint for progress, then read the aggregate and individual assessments when review completes. API keys and personal or confidential data should not be placed in source control or submitted in case text.

Example submission:

```sh
curl -X POST https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api/v1/tasks \
  -H "Authorization: Bearer $EKN_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: diagnosis-2026-0042" \
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
curl https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev/api/v1/tasks/TASK_ID \
  -H "Authorization: Bearer $EKN_CLIENT_KEY"
```

Achievements recognize peer-reviewed contributions and completed reviews. They represent community participation, not professional credentials.

## Develop

Requires Node.js 20 or later.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Run `npm test` to build and run the test suite. Local fixture scripts are for local development only.
