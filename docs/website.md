# Website — agnthive.run

This repository publishes a static landing page at **<https://agnthive.run>** via
GitHub Pages, served from the repository root (`/`).

## Repository files

| File | Purpose |
|------|---------|
| `CNAME` | Tells GitHub Pages the custom domain is `agnthive.run`. Must live at the root of the Pages publishing source. |
| `index.html` | The landing page served at `/`. |
| `.nojekyll` | Disables Jekyll processing so all static files are served verbatim. |

The Pages publishing source is **Deploy from a branch → `main` → `/` (root)**.
Do not put build output or generated files in the root for Pages — the landing
page is hand-authored static HTML with no build step.

## DNS records

Set these at the `agnthive.run` registrar / DNS provider. The apex uses **A
records** (not a CNAME — a CNAME at the apex would conflict with MX/TXT and
other apex records). `www` uses a CNAME to the GitHub Pages default host.

### Apex — `agnthive.run` (A records, required)

| Type | Host | Value |
|------|------|-------|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

### Apex — IPv6 (AAAA records, optional but recommended)

| Type | Host | Value |
|------|------|-------|
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

### www — `www.agnthive.run` (CNAME, so GitHub can redirect www → apex)

| Type | Host | Value |
|------|------|-------|
| CNAME | `www` | `C0FFEEC0DE.github.io` |

> The CNAME target is `<owner>.github.io` — the GitHub Pages default host —
> not the project repo. GitHub maps the incoming `www.agnthive.run` request to
> this repo via the `CNAME` file committed here.

## GitHub setup

1. Push `CNAME`, `index.html`, and `.nojekyll` to `main`.
2. Repo **Settings → Pages**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` / **folder:** `/` (root) → **Save**
   - **Custom domain:** enter `agnthive.run` → **Save**
   - Tick **Enforce HTTPS** once the certificate is issued (may take a few
     minutes after DNS propagates).
3. Set the apex (`agnthive.run`) as the primary domain in Pages settings;
   GitHub will automatically redirect `www.agnthive.run` → `agnthive.run`.

## Verify

After DNS propagates, confirm the apex resolves to GitHub Pages IPs:

```bash
dig agnthive.run +short
dig www.agnthive.run +short
```

The apex should return the four `185.199.108–111.153` addresses; `www` should
CNAME to `C0FFEEC0DE.github.io`. The Pages **Custom domain** UI will show
"DNS check successful" and issue a TLS certificate for `agnthive.run`.

## Notes

- The `CNAME` file is authoritative — if it is missing or mismatched, GitHub
  Pages will not serve the custom domain even with correct DNS.
- These DNS values are GitHub Pages' published anycast addresses and can change;
  re-check <https://docs.github.com/pages> if verification fails after
  propagation.
- This doc describes hosting only; release/deploy automation stays disabled per
  the profile. Pages deployment is GitHub's branch-based action, not repo CI.
- `index.html` is built on **Bootstrap 5.3**, with the dark CRT/neon brand
  applied as a custom CSS layer on top of Bootstrap dark mode. The Bootstrap
  stylesheet is **vendored locally** at `assets/vendor/bootstrap.min.css`
  (v5.3.3, MIT, The Bootstrap Authors — the in-file header is the attribution)
  and loaded with `<link href="assets/vendor/bootstrap.min.css">`. The page is
  fully **self-hosted: no build step, no npm, and no external runtime
  requests** (the favicon is an inline SVG data URI; fonts are system +
  monospace; there is no external JS). To upgrade Bootstrap, replace that file
  with the new `bootstrap.min.css` from the release and bump the comment.