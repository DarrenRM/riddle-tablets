# Riddle Tablets

A moderated, episodic gallery of animated community riddle tablets.

## Workflow

- `/approve` is password-gated and organizes moderation around topic groups.
- A moderator creates a topic and copies its automatically generated submission link.
- The topic-specific form fixes the topic and accepts only an author name and clue.
- Pending clues remain private until a moderator approves them.
- Approved clues can be edited and ordered within their group.
- Exactly one topic group can be active on `/` at a time.
- Activating a topic makes the previously active topic a previous presentation.

Tablet reveal state and topic completion are stored in each visitor's browser. Marking a topic solved moves all its clues below the active presentation, where that visitor's solved topics accumulate without changing anyone else's experience. The public page does not expose presentation controls or a link to the historical topic index.

Public submissions are validated, checked by a honeypot, and rate-limited by IP. Rejected clues are retained until restored or permanently deleted. Approved clues can be edited or returned to the rejected queue.

## Local preview

```powershell
Copy-Item .env.example .env
# Edit .env and set MODERATOR_PASSWORD
npm install
npm start
```

Open:

- Gallery: <http://127.0.0.1:3000/>
- Password-gated moderation: <http://127.0.0.1:3000/approve>
- Direct historical topic index (not linked publicly): <http://127.0.0.1:3000/archive>

Create a topic from the moderation page to obtain its submission URL. The generic `/submit` page intentionally does not accept clues without a topic-specific token.

Without Upstash credentials, local groups, approved tablets, and submissions persist to ignored JSON files under `data/`.

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
