# Riddle Tablets

A standalone gallery of animated riddle tablets with a hidden, password-gated editor.

## Local preview

```powershell
Copy-Item .env.example .env
# Edit .env and set CREATE_PASSWORD
npm install
npm start
```

Open:

- Gallery: <http://127.0.0.1:3000/>
- Password-gated editor: <http://127.0.0.1:3000/create>

Without Upstash credentials, local edits persist to the ignored `data/tablets.local.json` file. Existing tablets from the earlier browser-local experiment are imported after the first successful editor login.

## Vercel deployment

1. Import or deploy this repository as a Vercel project. The root `index.js` exports the Express application Vercel detects.
2. In Vercel Marketplace, install Upstash Redis and connect it to this project. It supplies `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Add `CREATE_PASSWORD` as a sensitive environment variable for Production and Preview.
4. Redeploy after changing environment variables.

The same setup can be done from this linked project with:

```powershell
vercel env add CREATE_PASSWORD production
vercel integration add upstash/upstash-kv --plan free --environment production --metadata primaryRegion=sfo1 --metadata autoUpgrade=false
vercel --prod
```

The integration command creates an external Upstash resource. Review the selected account and region before running it.

The public page exposes no editor or navigation link. `/create` is protected by a rate-limited password exchange and an HTTP-only, SameSite=Strict cookie. Opened tablet IDs stay in each visitor's local storage; tablet content is shared through Upstash.

## Commands

```powershell
npm test
npm start
vercel
vercel --prod
```
