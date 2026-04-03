# PracticeFlow

PracticeFlow is a lightweight Node.js app for psychotherapists and supervisors to:

- log therapy and supervision sessions
- generate client-wise monthly invoices from session logs
- track payments
- review monthly income, pending balances, and client-wise reports

## Run locally

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

## Default login

- Email: `owner@example.com`
- Password: `supersecure123`

## Railway deployment notes

- Start command: `npm start`
- Exposed port: Railway will provide `PORT`, which the app already supports
- Important: the app stores SQLite data in the `data/` folder

For production use, you should either:

1. attach persistent storage for the `data/` directory, or
2. migrate to Postgres before using it for real client data

## Sensitive data note

This app stores therapy/supervision client, session, invoice, and payment data. Before production use, review your privacy, security, and compliance obligations in your jurisdiction.
