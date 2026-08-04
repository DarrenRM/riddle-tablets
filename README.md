# Riddle Tablets

A moderated gallery of animated community riddle tablets.

## Workflow

- `/` shows only approved inscriptions.
- `/submit` is a public submission form. It never lists other submissions.
- `/approve` is password-gated and provides inline Pending, Published, and Rejected moderation queues.
- `/create` redirects to `/submit` for backward compatibility.

Public submissions are validated, checked by a honeypot, and rate-limited by IP. Approval publishes the moderator's inline edits. Rejected inscriptions are retained until restored or permanently deleted. Published inscriptions can be edited or unpublished.

## Local preview

```powershell
Copy-Item .env.example .env
# Edit .env and set MODERATOR_PASSWORD
npm install
npm start
```

Open:

- Gallery: <http://127.0.0.1:3000/>
- Public submission: <http://127.0.0.1:3000/submit>
- Password-gated moderation: <http://127.0.0.1:3000/approve>

Without Upstash credentials, local published tablets and submissions persist to ignored JSON files under `data/`.

## Vercel deployment

1. Import or deploy this repository as a Vercel project.
2. Connect an Upstash Redis resource. Current Vercel integrations supply `KV_REST_API_URL` and `KV_REST_API_TOKEN`; direct `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` credentials are also supported.
3. Add `MODERATOR_PASSWORD` as a sensitive Production and Preview variable. Existing `CREATE_PASSWORD` deployments remain compatible.
4. Redeploy after changing environment variables.

```powershell
vercel env add MODERATOR_PASSWORD production
vercel integration add upstash/upstash-kv --plan free --environment production --metadata primaryRegion=iad1 --metadata autoUpgrade=false
vercel --prod
```

The integration command creates an external Upstash resource. Review the selected account and region before running it.

## Commands

```powershell
npm test
npm start
vercel
vercel --prod
```

The local Noita/FMOD audio-authoring tools are intentionally kept outside this
public repository. The deployed site includes only the exported web-ready audio
files under `public/audio/`; FMOD, its DLLs, and Noita's bank files are not part
of the deployment.
