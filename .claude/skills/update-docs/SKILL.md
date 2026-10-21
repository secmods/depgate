---
name: update-docs
description: Update the DepGate customer documentation (the VitePress site in docs/) to match the current code. Finds what changed since the docs were last updated, edits the affected pages, recaptures the screenshots from a freshly built and seeded DepGate, reviews every changed image, and verifies the site builds with no broken links. Use when asked to update, refresh, regenerate or check the documentation or its screenshots.
disable-model-invocation: true
argument-hint: "[since <git-ref> | all | screenshots | page <path>]"
---

# Update the DepGate documentation

The documentation is a VitePress site in `docs/`, written for customers: security teams, platform engineers and developers who use DepGate. Your job is to keep it true to the current code, with screenshots that show the current UI.

Read these before writing anything:
- [page-map.md](page-map.md): which source files feed which pages and screenshots.
- [style-guide.md](style-guide.md): how the pages are written. Follow it exactly.

## Arguments

| Argument | Meaning |
|---|---|
| *(none)* | Everything that changed since the commit in `docs/scripts/.docs-baseline`, including uncommitted changes. |
| `since <ref>` | Everything that changed since that git ref. |
| `all` | Review every page against the code, and recapture every screenshot. |
| `screenshots` | Recapture and review screenshots only; change text only where a screenshot shows the text is wrong. |
| `page <path>` | Only that page, for example `page admin/monitoring`, and its screenshots. |

## Ground rules

- **The code is the source of truth.** Check every claim you write (labels, defaults, limits, behavior) against the source: UI templates in `packages/ui/src/app/`, routes and services in `packages/backend/src/`, `deploy/`, `.env.example`. Never document something you have not seen in the code or the running app. The old internal notes (`requirements*.md`, `DEVELOPMENT_STATUS.md`, `TEST_REPORT.md`) can be out of date; use them for hints only.
- **Use the UI's exact words.** Button, tab, field and menu names in the docs must match the UI text character for character. Copy them from the templates.
- **Customer view only.** Describe what people see and do and what DepGate guarantees. Leave out internals: class names, Redis keys, cache epochs, metric internals, test IDs, requirement IDs, ticket numbers.
- **Only edit `docs/`** (pages, `docs/public/`, `docs/scripts/`, `docs/.vitepress/config.mts`). Never change application code. If the UI or the API is broken or contradicts itself, write it down for the final report instead of documenting around it.
- **Never screenshot the dev database** on :3050. It holds test data. Screenshots come only from the throwaway instance on :3060 described below.
- Other sessions may be editing the application at the same time. Do not revert, stage or commit files outside `docs/` and this skill folder.

## Step 1: Find what changed

```bash
BASE=$(cat docs/scripts/.docs-baseline)          # or the ref given in the arguments
git log --oneline $BASE..HEAD
git diff --stat $BASE -- packages deploy .env.example Dockerfile
git status --short -- packages deploy            # uncommitted work counts too
```

Map every changed file to pages and screenshots with [page-map.md](page-map.md). Then read the diffs that matter. A change matters for the docs when it is visible to customers: a new or renamed page, tab, button, field, option or message; a new or changed rule, setting, default, limit or environment variable; a new API endpoint or field; a changed install or upgrade step. Refactors, tests and internal renames do not.

Write a short plan before editing: for each affected page, what is wrong or missing, and which screenshots must be recaptured. With `all`, go through every page in page-map.md.

## Step 2: Update the pages

Edit the pages following [style-guide.md](style-guide.md).

- New feature: add it to the page that owns the area. Add a new page only for a new area of the product, register it in the `sidebar` (and `nav` if it is a new section) in `docs/.vitepress/config.mts`, and add it to page-map.md.
- Removed feature: delete its text, its screenshots and the links to it.
- Renamed UI element: search all pages for the old name (`rg -n "Old name" docs --glob '!node_modules'`).
- New environment variable: add it to `reference/configuration.md` (customer-relevant ones only), and to the install pages if a customer must set it.
- Keep `README.md` (repository root) in step when a top-level section is added or removed.

## Step 3: Prepare the screenshot instance

Screenshots come from a clean DepGate on http://localhost:3060 with demo data for a fictional company, Acme. See `docs/scripts/README.md`.

1. **Build the image from the current code.** The instance runs `depgate-backend:latest`, the image of the development stack:

   ```bash
   docker compose build backend
   ```

   This builds from the working tree, so uncommitted UI changes are included. It takes a few minutes; run it in the background while you edit pages.

2. **Start or refresh the instance.**
   - Not running (`curl -sf localhost:3060/readyz` fails): `docker compose -f docs/scripts/docker-compose.yml up -d`, wait for `/readyz`, then seed (below).
   - Running: `docker compose -f docs/scripts/docker-compose.yml up -d --force-recreate app` to pick up the new image. The data is kept.
   - Data model changed, or the seed changed: start clean with `docker compose -f docs/scripts/docker-compose.yml down -v`, then `up -d` and seed.

3. **Seed.** `node docs/scripts/seed.mjs` creates repositories, policies, people, identity providers, log streaming destinations, a webhook, exceptions, waiver requests and real downloads across all ecosystems. It needs internet access, Verdaccio on :4873 (internal npm registry with `@acme/billing`) and Mailpit on :8025 (to accept the invitation); `docs/scripts/README.md` says how to start them. The Keycloak that plays the identity provider is part of the compose file. Check that Verdaccio and Mailpit run (`docker ps`) before seeding. Read the output: every step should succeed, and the traffic lines should show a mix of `200` and `403`.

4. **Extend the seed** when a new feature needs data to be visible (a new rule, a new setting, a new kind of record). Use only the fictional Acme names, `example.com` addresses and demo credentials already in the file. Keep the seed safe to run twice.

## Step 4: Capture screenshots

`docs/scripts/screenshots.mjs` holds one entry per screenshot. Each entry signs in as the Security user or the developer (alice), opens a page, fills forms with realistic Acme values, and captures the window.

- Recapture what changed: `node docs/scripts/screenshots.mjs <word> [<word> …]` runs only the entries whose name contains a word. With `all` or `screenshots`, run it without arguments.
- **New screenshot:** add an entry to `screenshots.mjs`, reference it from the page as `![Alt text that describes it](/screenshots/<name>.png)`, and add it to page-map.md. Prefer stable selectors: `#id`, `getByTestId`, `getByRole` with the visible name. Read the UI template to find them.
- **Failing entry:** a `FAIL` line usually means a label or selector changed. Read the current template and fix the selector; do not delete the shot.
- Conventions: window 1440×900 at 1.5× scale; grow the height (`capture(page, name, { height })`) for long pages so the sidebar is not cut off; close dialogs with Escape; never submit a form that changes data unless the shot needs the result.

## Step 5: Review every changed screenshot

Never publish a screenshot you have not looked at.

```bash
node docs/scripts/contact-sheet.mjs <scratchpad>/sheets <name> [<name> …]
```

Read each sheet. Check that every screenshot:
- shows the right page, with the dialog or form state the text describes;
- contains only demo data (Acme, `example.com`), no real-looking secrets beyond the demo tokens, no error toasts, no loading spinners, no open dropdowns covering content;
- matches the labels and steps written on its page.

Fix and recapture until all pass. Read a single screenshot at full size when a detail matters.

## Step 6: Verify the site

```bash
npm --prefix docs install          # first time only
npm --prefix docs run build        # fails on dead page links
node docs/scripts/check-links.mjs  # broken #anchors, missing or unused images
```

Both must pass. Then preview: start the `docs` launch configuration (port 5173), open the pages you changed, and check that they render, the screenshots load, and code groups and tables look right, in light and dark mode. Use Playwright or the browser pane at 1440×900; the pane alone is too narrow to judge layout.

Remove the build output when done: `rm -rf docs/.vitepress/dist`.

## Step 7: Finish

1. Write the commit the docs now match into the baseline: `git rev-parse HEAD > docs/scripts/.docs-baseline`. If the docs also cover uncommitted application changes, say so in the report.
2. Report to the user:
   - the pages changed, added or removed, one line each;
   - the screenshots recaptured or added;
   - anything you could not document or verify, and any UI or API problem you found (for someone else to fix);
   - that nothing was committed, unless the user asked for a commit.
3. Leave the :3060 instance running for the next update, and say how to remove it: `docker compose -f docs/scripts/docker-compose.yml down -v`.
