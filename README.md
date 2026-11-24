# Expert Knowledge Network

[![Tests](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml/badge.svg)](https://github.com/for-aiur/expert-knowledge-network/actions/workflows/test.yml)

[Open the beta](https://expert-knowledge-network-beta.yildirimmehmet82.workers.dev)

A practical knowledge-sharing platform for technicians. Share repair experience, learn from independently reviewed cases, and build a reputation through useful contributions.

## Features

- Submit and manage repair reports, including drafts and clarification responses.
- Review repair cases with a structured technical rubric.
- Request independent expert review of AI diagnoses through the API.
- Track contribution points, reputation and professional community achievements.
- Use the interface in English, German, Turkish, Polish, Russian or Arabic.
- Give administrators controlled access to approved, shareable data.

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
