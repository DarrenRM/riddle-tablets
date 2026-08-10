# Project Guardrails

- Use local JSON files for local testing. Never connect local experiments to the production database.
- Never commit local/test data, backups, credentials, or generated artifacts.
- Treat production data as live: do not mutate it unless explicitly authorized; back it up before migrations or destructive work.
- Public pages may expose approved tablets only. Pending/rejected submissions and submission tokens stay private.
- `/archive` intentionally includes approved tablets from every group status.
- Reveal, solved, quest, and name-display preferences are browser-local unless a feature explicitly says otherwise.
- Before pushing or deploying, run tests, inspect the diff, and confirm no data files are included.
