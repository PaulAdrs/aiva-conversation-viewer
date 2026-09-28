# AIVA Conversation Viewer (template)

Static page (GitHub Pages) + Cloudflare Worker backend. A user enters an
access code, picks one of the company's agents from a list, picks one of
that agent's recent calls, and sees the transcript interleaved with the
paired tool-call (name/arguments/result) events — all pulled live from the
AIVA admin portal (**prod**).

**This talks to real production data (real caller PII: names, phone
numbers, and whatever the agent's tools capture).** That's why there's an
access-code gate and a company-scope check on every endpoint — read
"Notes / limits" below before sharing this with anyone.

This is a template: it has no live secrets, deployed endpoints, or company
identifiers baked in. Each person who uses it deploys their **own** Worker,
under their **own** Cloudflare account, seeded with their **own** cached
admin-portal token, and picks their **own** access code and company ID.
**The company ID lives only in a Cloudflare secret (`COMPANY_ID`) — it is
never written to this repo, the page, or a commit message.** Keep it that
way: don't put the company ID or company name in the repo name, the Worker
name, the page title, or any commit message when you customize this for a
specific customer.

## 1. Deploy the Worker

```bash
cd worker
npx wrangler login                     # opens a browser, log in to YOUR Cloudflare account
npx wrangler kv namespace create TOKENS
```

Copy the `id` it prints into `wrangler.toml` (replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`).

Seed the KV store with your currently-cached **prod** admin-portal token
(same shape as used by the `admin-portal-login` skill: `id_token`,
`access_token`, `refresh_token`, `expires_at`, `env`, `domain`, `client_id`):

```bash
npx wrangler kv key put --binding=TOKENS "prod" --path="$HOME/.aiva/admin-portal-prod.json" --remote
```

Set the company this deployment is scoped to (this is the only place the
company ID lives — never in a file):

```bash
npx wrangler secret put COMPANY_ID
```

Generate a strong, random access code (don't hand-pick something guessable)
and set it as a secret:

```bash
openssl rand -base64 18
npx wrangler secret put ACCESS_CODE
```

Deploy:

```bash
npx wrangler deploy
```

This prints your Worker URL, e.g. `https://aiva-conversation-viewer.<your-subdomain>.workers.dev`.

The Worker auto-refreshes the token using the cached refresh token, so you
don't need to re-seed it until the refresh token itself expires (~30 days
of inactivity). If you already have another deployment of this template
running (e.g. for a different customer), **do not reuse its Worker name or
KV namespace** — each deployment needs its own, or you'll overwrite a live
tool and corrupt both refresh-token chains.

## 2. Point the site at the Worker

Edit `docs/index.html`, replace `REPLACE_WITH_YOUR_WORKER_URL` with the URL
from step 1. Give whoever needs this both the page URL and the access
code (send the code via a separate channel, e.g. a different message than
the link itself).

## 3. Publish the site to GitHub Pages

```bash
git init
git add docs README.md .gitignore
git commit -m "Add conversation viewer"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then in the repo settings on GitHub: **Settings → Pages → Deploy from branch
→ main → /docs**. GitHub gives you the public URL
(`https://<your-username>.github.io/<repo-name>/`) after a minute.

Pick a repo name that says nothing about which customer this is for (e.g.
`aiva-conversation-viewer`, not `<customer>-viewer`) — the repo, its commit
history, and the Pages URL are all public.

Anyone with the link and access code can browse any agent and any
conversation belonging to the company you set in step 1 — nothing else.

## Flow

1. Enter the access code.
2. See the list of the company's agents (name, language, last updated).
3. Click an agent → see its recent calls (call ID, phone number, time,
   message count).
4. Click a call → see the transcript interleaved with tool-call logs.

## Notes / limits

- The access code is basic protection, not real auth — anyone who has it
  can browse every agent and every conversation belonging to the company
  you scoped this to. Treat it like a shared password: don't post it
  anywhere public alongside the link, and rotate it (`wrangler secret put
  ACCESS_CODE` again) if you suspect it leaked.
- Delete the Worker (`npx wrangler delete`) and take down the GitHub Pages
  repo once it's no longer needed — don't leave real customer call data
  reachable indefinitely.
- If the Worker ever returns "No cached token in KV", re-seed it (your
  local admin-portal token file must be fresh — re-run your admin-portal
  login flow if needed).
- The company scope check is membership-based: every request re-fetches
  the company's agent list and checks the requested agent/conversation
  against it, rather than trusting a single per-agent lookup to have
  filtered correctly.
- Before pointing this at a new company, double check with whoever owns
  that client relationship that sharing transcripts this way (a single
  shared access code, not per-recipient auth) is acceptable for their data
  — don't assume "just testing" means no real PII is involved.
