---
name: ux-review
description: Run a UI/UX review of the Linyup product — a cross-app consistency sweep, one feature area, or the whole app — using the ux-reviewer agent. Reviews for the studio-manager and contact personas, reports ranked findings with proposed fixes, and persists a dated report. Analysis only; no implementation. Use when the user wants to know where the UX is degrading, or before deciding what to simplify next.
---

# UX review

Orchestrates the `ux-reviewer` agent. The agent reviews ONE scope per invocation
and is read-only; this skill batches the runs, merges the reports, and writes the
result to `docs/ux-review-YYYY-MM.md`.

```
/ux-review                sweep, then every area, merged        (the whole app)
/ux-review M4             one area
/ux-review M7 C2          several areas
/ux-review C2 --brief     table only, detail for the top 3
/ux-review sweep          cross-app consistency only
```

## Why it is batched

A whole-app review is **never one agent invocation**. There are ~58 admin pages,
~25 public routes and ~96k lines in `apps/web` alone; one pass over all of it
yields a long list ranked by nothing, which gets skimmed once and ignored.

So: **1 SWEEP + N AREA runs**, each capped at 8 findings, merged here.

Run the SWEEP **first** and pass its result into the area runs. Consistency
problems are invisible from inside any single area — that is exactly the
degradation the user is worried about — and knowing "there are six hand-rolled
tab bars" changes how an area run reads the one in front of it.

## Procedure

1. **Read the previous report** — the newest `docs/ux-review-*.md`, if any. Pass
   its findings table to every agent run so findings are marked `new`,
   `repeat of <id>` or `regressed` rather than silently restated.

2. **Gather evidence inputs.** The agent's findings are only as good as these,
   and `observed` outranks everything it can infer alone:
   - a recent `/persona-ux-test` report (runtime friction, F1…Fn) — the
     strongest input. Offer to run one first if none exists and the user has the
     app running.
   - in-app feedback (`docs/in-app-feedback.md`; the ops console lists
     submissions with route + viewport + plan attached). The agent cannot read
     Firestore — paste it.
   Say explicitly in the final report which inputs were available. A review with
   no observed evidence is weaker, and should say so rather than pretend.

3. **Run SWEEP.** Launch `ux-reviewer` with the mode, the prior report, and the
   evidence inputs.

4. **Run the areas.** Default to all 16 for a whole-app review; otherwise only
   the ids given. Launch in parallel — they are independent and read-only —
   but pass `--brief` when running more than ~4 at once, or the merged output
   will not fit. Pull full detail afterwards only for what you intend to act on.

5. **Merge.** De-duplicate across areas (the same root cause surfaces in several
   — the merged entry lists every area it appeared in, which is itself a signal
   of severity). Re-rank globally by cost to the user. Renumber `UX-1…n`.

6. **Write `docs/ux-review-YYYY-MM.md`** in the shape of
   `docs/security-audit-2026-07.md`: a headline paragraph on what was reviewed
   and the top-line judgment, then

   ```
   | # | Sev | Finding | Area | Owner | Status |
   ```

   with `Status` starting as `▶ Open` and updated to `✅ Fixed` / `▶ Deferred` /
   `✅ Accepted` as work lands. Then the full work-order blocks, then
   **What's good**, then **Dropped**.

7. **Report to the user**: the table, the top 3 in full, and a one-line note of
   what was dropped. Do not paste every block into chat — the file is the
   artifact.

## Handing findings to dev agents

Each finding block is a self-contained work order (files, proposed change, what
must not change, owner, verification). Hand one to the named owner —
`web-agent`, `mobile-agent`, `functions-agent` — with the block and nothing else;
if it cannot act on that alone, the block was underspecified and the reviewer
should be asked to tighten it.

Do **not** hand the whole report to one agent. These are independent changes with
different owners, and several are L/XL refactors that deserve their own plan.

## Guardrails

- The agent is read-only (`disallowedTools: Edit, Write, Agent`). It proposes;
  it never implements. Keep it that way — an agent that can edit will.
- Never ask it to run the app. Runtime evidence comes from `/persona-ux-test`.
- Accessibility belongs to `design:accessibility-review`; a single screen or
  mockup belongs to `design:design-critique`. Route those rather than widening
  this one.
- Resist acting on findings in the same pass. The report is for deciding *what*
  to simplify; implementing while reviewing anchors both.

## After two or three runs

Promote whatever recurs into `docs/ux-principles.md` — the judgment calls that
cannot be derived from code (vocabulary lock, which patterns are canonical,
defaults-over-settings). The agent already reads that file if it exists and
treats it as outranking its own judgment. Writing it *before* any review has run
would be speculative; harvest it instead.
