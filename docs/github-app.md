# GitHub App deployment

Instead of registering a webhook in each repository individually, you can create a GitHub App once and install it at the org (or user) level. Every repository in the org automatically sends events to claude-beacon — no per-repo webhook setup needed.

This is the recommended approach when you work across several repos or want new repos covered automatically.

---

## How it differs from per-repo webhooks

| Aspect | Per-repo webhook | GitHub App |
|---|---|---|
| Webhook URL | Set per repository | Set once in App settings |
| Webhook secret | Set per repository | Set once in App settings |
| Adding a new repo | Manually add webhook | Install app once → all repos covered |
| Code changes needed | — | None — same HMAC format |
| `GITHUB_TOKEN` | PAT | PAT still works |

The webhook payload format is identical, so `verifySignature`, event parsing, and all notification logic work without modification.

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

Under **Repository permissions**, set each to **Read-only**:

| Permission | Why |
|---|---|
| **Actions** | `workflow_run`, `workflow_job`, `check_suite` events + log fetching |
| **Pull requests** | `pull_request`, `pull_request_review`, review comment events |
| **Issues** | `issue_comment` on PRs |
| **Contents** | `push` events (for behind-PR detection) |
| **Code scanning alerts** | `code_scanning_alert` events (opt-in) |
| **Dependabot alerts** | `dependabot_alert` events (opt-in) |

> Only grant what you need. Code scanning and Dependabot can be skipped if you don't use those hooks.

---

## 3. Subscribe to webhook events

Under **Subscribe to events**, tick all that apply:

- [x] Workflow runs
- [x] Pull requests
- [x] Pull request reviews
- [x] Pull request review comments
- [x] Pull request review threads
- [x] Issue comments
- [x] Pushes
- [ ] Code scanning alerts *(opt-in — only if `on_code_scanning_alert.enabled: true`)*
- [ ] Dependabot alerts *(opt-in — only if `on_dependabot_alert.enabled: true`)*

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

**Permissions not showing up**  
After changing App permissions, each installation needs to accept the updated permissions. GitHub sends a notification to the org admin with an Accept link.
