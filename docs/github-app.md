# GitHub App deployment

Instead of registering a webhook in each repository individually, you can create a GitHub App once and install it at the org (or user) level. Every repository in the org automatically sends events to claude-beacon — no per-repo webhook setup needed.

This is the recommended approach when you work across several repos or want new repos covered automatically.

---

## 1. Create the GitHub App

Go to **github.com/settings/apps → New GitHub App** (or **your-org → Settings → Developer settings → GitHub Apps → New GitHub App** for an org-owned app).

Fill in:

| Field | Value |
|---|---|
| **GitHub App name** | `claude-beacon` (or any name you prefer) |
| **Homepage URL** | `https://github.com/drmf-cz/claude-beacon` |
| **Webhook → Active** | ✓ checked |
| **Webhook URL** | Your tunnel URL — e.g. `https://random-name.trycloudflare.com` |
| **Webhook secret** | Output of `openssl rand -hex 32` (save this — it becomes `GITHUB_WEBHOOK_SECRET`) |

> The tunnel URL changes on restart. See [Managing the webhook URL](#managing-the-webhook-url) below.

---

## 2. Set repository permissions

Under **Repository permissions**, set **Actions**, **Pull requests**, **Issues**, and **Contents** to **Read-only**. Optionally add **Code scanning alerts** and **Dependabot alerts** (only needed if you enable those hooks in your config).

---

## 3. Subscribe to webhook events

Tick: **Workflow runs · Pull requests · Pull request reviews · Pull request review comments · Pull request review threads · Issue comments · Pushes**. Optionally add **Code scanning alerts** and **Dependabot alerts** if using those hooks.

---

## 4. Set install scope

Under **Where can this GitHub App be installed?**:

- **Only on this account** — for personal use
- **Any account** — if you want to share the app with others (e.g. publish to Marketplace)

Click **Create GitHub App**.

---

## 5. Install the app

After creation, click **Install App** in the left sidebar → choose your account or org → select **All repositories** (or specific repos) → **Install**.

To add more repos later: go to the App's installation page and edit the repository list.

---

## 5a. Organization installation

Org-level installation requires **org owner** privileges. If you are not an org owner, ask your admin to install: they go to `github.com/organizations/<org>/settings/installations` → find the App → **Install** → All repositories. Alternatively, install under your personal account at `github.com/settings/installations` — this covers only your own repos, not org-owned ones.

## 5b. Accepting updated permissions

When you add new permissions to the App later (e.g. Code scanning alerts), GitHub emails the org owner to accept the change before new events flow. If events stop after a permission update, ask your org owner to check their email for a pending "Review permissions" notification from GitHub.

---

## 6. Configure claude-beacon

The configuration is the same as the per-repo webhook setup. The webhook secret you generated in step 1 becomes `GITHUB_WEBHOOK_SECRET`:

```bash
echo 'GITHUB_WEBHOOK_SECRET=<secret-from-step-1>' >> .env
echo 'GITHUB_TOKEN=<your-PAT>'                    >> .env
```

Then start the mux normally:

```bash
claude-beacon-mux --author YourGitHubUsername
```

The mux receives events from all installed repos through the single App webhook URL — no other changes needed.

---

## Managing the webhook URL

The App has one webhook URL (set in App settings). When your tunnel restarts and produces a new URL, update it in one command:

```bash
# Replace APP_ID and TOKEN with your values
APP_ID=123456
TOKEN=ghp_...   # a PAT with 'admin:app' or 'write:org' scope, or use 'gh auth token'

NEW_URL=https://new-random-name.trycloudflare.com

gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  /apps/claude-beacon/hook/config \
  -f url="$NEW_URL"
```

Or update it manually: **github.com/settings/apps/claude-beacon → General → Webhook URL**.

**Stable URLs (recommended for daily use):**
- **cloudflared named tunnel** — same hostname survives restarts. See [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/).
- **ngrok static domain** — free tier includes one static domain. See [ngrok docs](https://ngrok.com/blog-post/free-static-domains-ngrok-users).

---

## App-based authentication (optional, future)

For now, `GITHUB_TOKEN` is a personal access token used to fetch workflow logs and check PR mergeability. This works fine alongside a GitHub App.

A future enhancement is to generate **installation tokens** from the App's private key (JWT → installation token), which are more scoped and auditable. This would replace the PAT entirely. The code path in `server.ts` would need to exchange a JWT for an installation token before API calls — tracked as a potential v2.x feature.

---

## Troubleshooting

**Events not arriving after installation**  
Check the App's **Advanced → Recent Deliveries** tab (in App settings, not repo settings). A failed delivery shows the response code from claude-beacon — 401 means secret mismatch, 200/204 means it was processed.

**installation / installation_repositories events**  
When you install or update the app, GitHub sends these events. claude-beacon logs them as `[skip] event=installation: not handled` and ignores them — this is expected.

**Permission updates not taking effect after changing App settings**  
After adding new permissions or event subscriptions to the App, GitHub requires each installation to accept the updated permissions before new events are delivered. The org owner (or personal account owner) receives an email from GitHub — they must click **Review and accept** at the installation page. See [§5b. Accepting updated permissions](#5b-accepting-updated-permissions) for the full procedure.
