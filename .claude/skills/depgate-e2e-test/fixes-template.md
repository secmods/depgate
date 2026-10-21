# Fixes needed

The list of work another agent has to do, produced by the `depgate-e2e-test` skill. It holds only what is still open, so it stays short. The full evidence is in `TEST_REPORT.md` (defect `D-<n>`), and the run state is in `TEST_STATUS.md`.

**For the agent fixing these:** work from the top (highest priority first). Change only product code, tests and docs, never the test files. When an item is fixed, set its Status to `Fixed (<date>, <commit>)` and keep it here. Do not delete it: the tester re-runs the listed cases, and only then moves it to *Verified fixed*.

**For the tester:** add an item as soon as you record a defect. When the fix is in and your re-run passes, move the item to *Verified fixed*. If the re-run fails, set the Status back to `Open` and add what you saw. Priority: **High** = blocks a customer workflow, wrong security decision, or data is missing or wrong; **Medium** = wrong or misleading result with a workaround; **Low** = cosmetic or rare.

Last updated: <date> · Run: <start> · Open: <n> · Fixed, waiting for re-run: <n> · Needs a decision: <n>

## Open

### D-<n> · <High | Medium | Low> · <short title>
- **Where:** case and step, page or endpoint
- **Happens:** what the user or API sees
- **Should happen:** the expected behavior, with the doc or charter line that says so
- **Reproduce:** 2 to 4 short steps
- **Suspected cause:** `path/file.ts:line`, one sentence
- **Suggested fix:** one or two sentences
- **Re-run after fix:** cases, for example `5, 19, 20`
- **Evidence:** paths under `test-results/charter/`
- **Status:** Open

## Needs a decision
(Blocked: needs decision items. Each with the question, the options and a recommendation.)

## Fixed, waiting for re-run
(Items another agent marked Fixed. The tester removes each one after its re-run passes.)

## Verified fixed
| ID | Title | Fixed | Verified by re-run of |
|---|---|---|---|
