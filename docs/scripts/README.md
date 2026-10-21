# Documentation screenshots

The screenshots in `docs/public/screenshots/` come from a throwaway DepGate with demo data for a fictional company, Acme. Regenerate them after UI changes:

```bash
# 1. A clean DepGate on http://localhost:3060 (uses the depgate-backend:latest image; set DEPGATE_IMAGE to change it),
#    with the artifact cache on and a Keycloak on :8180 that plays the company identity provider (realm from e2e/keycloak)
docker compose -f docs/scripts/docker-compose.yml up -d

# 2. Demo data: repositories, policies, people, single sign-on, log streaming, a webhook, exceptions, waivers
#    and real package downloads. Needs internet access, Verdaccio on :4873 with @acme/billing (internal
#    registry), and Mailpit on :8025.
node docs/scripts/seed.mjs

# 3. Capture every screenshot, or only those whose name contains a word
node docs/scripts/screenshots.mjs
node docs/scripts/screenshots.mjs policy monitoring

# 4. Remove the instance and its data
docker compose -f docs/scripts/docker-compose.yml down -v
```

The demo accounts and passwords are defined in `seed.mjs` and `docker-compose.yml`. They exist only in this local instance.

Verdaccio and Mailpit are not part of the compose file. To start them:

```bash
docker run -d --name mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit
docker run -d --name verdaccio -p 127.0.0.1:4873:4873 verdaccio/verdaccio:6
# then create a user with `npm adduser --registry http://localhost:4873/` and publish a small @acme/billing package
```

## Demo video

The README's two-minute walkthrough (`.github/assets/demo.mp4` and `demo.gif`) is recorded by `demo-video.mjs` against the same instance. Start it with its gateway URL pointing at itself, so that the real `npm install` in the recording can fetch from it, and seed it:

```bash
GATEWAY_URL=http://localhost:3060 docker compose -f docs/scripts/docker-compose.yml up -d
node docs/scripts/seed.mjs
FFMPEG=/path/to/ffmpeg node docs/scripts/demo-video.mjs
```

The script records five segments as Playwright videos (1440×900), runs `npm install minimist@1.2.5` and `npm install minimist` through the gateway for the terminal segment (never typed-in text), and stitches them with ffmpeg into an H.264 MP4 under 10 MB and a GIF under 8 MB. It needs an ffmpeg with `libx264` and the `gif` encoder, for example `brew install ffmpeg` or the binary from the `ffmpeg-static` npm package; the ffmpeg Playwright ships only encodes VP9. `FFMPEG` defaults to `ffmpeg` on `PATH`.

The storyboard: create the policy *Critical vulnerabilities* (Vulnerability rule, CVSS ≥ 9.0, enforce) · the refused and the allowed install · the block in the Decision Ledger · Package check for minimist 1.2.5 · a waiver requested by the developer and approved by Security. The script first deletes the starter *Critical vulnerabilities* policy and the developer's seeded minimist waiver request, so the recording can create them. Because an approved waiver cannot be deleted, re-seed (`down -v`, `up -d`, `seed.mjs`) before recording again. `--only policy,terminal` re-records only those segments and reuses the others from the work directory (`$TMPDIR/depgate-demo`, or `DEMO_WORK_DIR`). It prints each segment's length at the end.

After a recording, upload `demo.mp4` through the GitHub web editor as the comment in README.md describes, so GitHub shows a video player above the GIF.

## Other helpers

| File | Purpose |
|---|---|
| `contact-sheet.mjs` | `node docs/scripts/contact-sheet.mjs <out-dir> [name …]` puts four screenshots on each sheet image, for review. |
| `check-links.mjs` | After `npm --prefix docs run build`: reports broken `#anchors`, missing images and unused screenshots. |
| `.docs-baseline` | The commit the documentation was last checked against. The `/update-docs` skill starts from it. |

To update the documentation after code changes, run the `/update-docs` skill in Claude Code (`.claude/skills/update-docs/`).
| `terminal-shot.mjs` | `node docs/scripts/terminal-shot.mjs <npm-output.txt> <out.png>` renders captured `npm install` output as a terminal screenshot. Made `.github/assets/npm-install-blocked.png` for the README from `npm install minimist@1.2.5 --loglevel=error 2>&1` against a gateway with the starter policies. |
| `svg-to-png.mjs` | `node docs/scripts/svg-to-png.mjs docs/public/diagrams/<name>.svg` renders a diagram to a 2× PNG with the site's Inter font. The SVG stays as the editable source. |
