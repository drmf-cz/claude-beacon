# Mux mode (no Bearer auth, local only)

Mux is the predecessor to hub. It runs a persistent process on localhost without any Bearer token authentication — anyone who can reach port 9444 can connect. This makes setup slightly simpler (no token management), but hub is recommended for most setups.

**Use mux when:**
- You are air-gapped or behind a firewall and port 9444 is never exposed externally
- You explicitly do not want token management
- You are migrating from an older claude-beacon install

**Use hub instead when:**
- You want Bearer token auth (prevents accidental connections from other local processes)
- You want per-user/per-session behavior config (`set_behavior`)
- You plan to share the server across teammates later

---

## Setup

Follow Quickstart steps 1–4 (install, secrets, tunnel, GitHub App), then:

### Start the mux

```bash
claude-beacon-mux --author YourGitHubUsername
```

`--author` is required. It sets `allowed_authors` — only PRs authored by this GitHub login trigger notifications. This is both a routing filter and a loop-prevention guard (Claude's own reply comments are skipped).

### Connect Claude Code

```bash
claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp
```

No `--header` needed — mux has no Bearer auth.

### Start Claude Code and register the session filter

Same as hub mode — see Quickstart steps 7–9 in [README.md](../README.md).

---

## `allowed_authors` config

The `--author` flag is a shorthand for setting `webhooks.allowed_authors` in a YAML config. For multiple co-authored PRs (e.g. an AI agent creates the PR on your behalf), add your email as well:

```yaml
webhooks:
  allowed_authors:
    - YourGitHubUsername
    - you@company.com   # matches Co-Authored-By trailers
```

Pass the config with `--config my-config.yaml` alongside `--author`.

---

## Running as a persistent process

See [docs/multi-session.md](multi-session.md) for how to run the mux under systemd, manage multi-session coordination, and use work-context claims.
