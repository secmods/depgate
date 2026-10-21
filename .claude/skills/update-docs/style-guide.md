# Documentation style guide

The readers are customers: security engineers, platform engineers, developers and compliance staff. They want to get a task done, or to understand what DepGate will do. Write like a professional technical writer.

## Voice

- Second person, present tense, active voice: "Choose **Create policy**. DepGate blocks the version."
- Short sentences. One idea per sentence. Plain words: "use", not "utilize"; "about", not "approximately".
- Say what something does for the reader before how it works.
- No marketing superlatives, no exclamation marks, no emoji in body text (the home page feature icons are the exception).
- Name the product **DepGate**. Name roles **User**, **Security** and **service account**. Call the web interface "the web interface", not "the UI" or "the frontend".

## UI text

- Bold the exact UI label: choose **New policy**, open **Settings → Repositories**, set **Enforcement** to **Monitor only (log, don't block)**.
- Use "choose" for buttons, menu items, tabs and options (it works for mouse, keyboard and touch). Use "enter" or "type" for text fields, "select" for check boxes, "turn on/off" for switches.
- Navigation paths use `→`: **Settings → Users & access**.
- Code, values, file names, environment variables, URLs and commands go in backticks: `GATEWAY_URL`, `deploy/.env`, `npm install`.

## Page structure

- One `#` title per page, as a noun phrase or task ("Create a policy", "Repositories"). It must match the sidebar text in `docs/.vitepress/config.mts`.
- Open with one or two sentences: what this is and why the reader cares.
- `##` sections for tasks and concepts, `###` for sub-steps. Headings are sentence case.
- Procedures are numbered lists, one action per step, with the result after the action when it helps. Put field descriptions in a table inside the step.
- Tables for reference material (fields, settings, statuses, events). Every table has a header row.
- End task pages with what to do next, or links to related pages, when useful.

## Screenshots

- Place a screenshot right after the step or paragraph it illustrates, never before it.
- Alt text describes what the image shows: `![Adding a webhook](/screenshots/webhook-add.png)`.
- One screenshot per idea. Don't add a screenshot that shows nothing the text doesn't already make clear.
- Diagrams that should not zoom get `{.no-zoom}`.

## Callouts

Use VitePress containers sparingly, at most two or three per page:
- `::: tip` for a shortcut or a recommendation.
- `::: warning` for something that can break builds or lose access.
- `::: danger` for something that loses data or weakens security.
- `::: details Title` for optional background the reader can skip.

Use `::: code-group` when the same step differs per ecosystem or operating system.

## Examples

- Fictional company: **Acme**. Hosts: `depgate.example.com`, `*.example.com`, `*.acme.internal`. People: `alice.chen@example.com`, `security-team@example.com`.
- Placeholders in angle brackets inside code: `<TOKEN>`, `<id>`. Never real tokens, keys or passwords.
- Version numbers in examples must be real (they are checked against public registries in screenshots).

## What not to write

- Internal implementation: class or file names, database tables, Redis keys, cache epochs, queue internals, test IDs, requirement or charter numbers.
- History ("previously", "in the old version", "no longer"), unless a customer must act on an upgrade.
- Promises about features that are not in the code. Planned features only as one short sentence, marked as planned.
- Markdown definition lists (`Term` / `: definition`): VitePress does not render them. Use a bullet list with a bold term, or a table.
