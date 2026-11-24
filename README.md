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
