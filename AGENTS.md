# cryptoweeklies.github.io — agent instructions

**`CLAUDE.md` in this directory is the authority. Read it before changing anything.**
Most of it records defects that reached production. This file is the short version so that
a tool which only injects `AGENTS.md` still gets the rules that matter; it is deliberately
not a copy, because a second full copy would drift from the first.

Static site behind cryptoweeklies.com (GitHub Pages) plus the Python/notebook pipelines
that generate it and the Firebase feeds the Android app reads. **Everything is generated
except `index.html`, `app.js`, `style.css` and the scripts themselves** — editing a
generated file is work the next pipeline run will discard.

```bash
python -m pytest tests                                      # 563 tests
python website_automation/run_notebook.py --group frequent --validate-only
python scripts/build_seo_assets.py --site-root . --check    # dry-run the SEO pass
```

## The trap that has cost the most

**`index.html` and `app.js` share one global lexical scope.** `app.js` is a classic script,
not a module. A top-level `const`/`let`/`class` declared in *both* files is an early
`SyntaxError` that aborts all of `app.js` before a single declaration installs — killing
the delegated click listener and with it every `data-action` control on the page.
`tests/test_frontend_bundle.py` fails if a duplicate is reintroduced.

**`app.js` is deferred, so it always wins a duplicate function** — silently. This has
produced six separate production regressions. Which copy should survive is decided
per-function by which one owns the dependencies: `switchView` and `openChartViewer` live
only in `app.js`; `hydrateClassicView` and `filterClassicView` live only in `index.html`.
Tests pin both directions.

**A duplicate does not have to throw to be a bug.** It usually resolves to `null` instead,
addressing element ids the markup no longer has.

## Deploying

**Pushed is not live.** Cloudflare Pages deploys only inside a scheduled refresh run on the
user's Mac, never on `git push`. A fix can sit correct-but-unshipped for days; confirm by
*content* on the live site, not by commit timestamp.

The refresh pipeline runs on that Mac rather than GitHub Actions, on purpose. Stale cards
in the app usually mean the notebook died partway, not that the app is wrong.

## Android / Firebase contracts

This repo's publishers are the source of truth for what every number in the Android app
*means*. Changing a model here changes the app with no app release — and can break it.
`schema_version` is a breaking-change gate the client enforces; `contract_revision` is
advisory and must not be pinned to a closed range.

Note the synced-copy trap: `mobile_app.ipynb` carries a pasted copy of
`scripts/android_full_analytics_export.py`. Edit the script, skip the sync, and every test
passes while the publisher goes on running the old code.

## Conventions

Comments explain *why*, especially where behaviour is non-obvious or a bug is being
prevented — most comments in this repo encode a past failure. Tests assert the invariant
that made a change safe rather than trusting it to stay true. Verify frontend changes in
the browser using computed styles and console reads, not assumptions.

Do not edit the Android tree during website work.
