# Releasing

## The short version

```bash
npm run bump minor     # patch | minor | major | x.y.z; updates package.json and the README title
# add the "## vX.Y.Z" section to CHANGELOG.md
npm test               # the whole suite, 31 files (30 offline, one live check opt-in)
git add -A && git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

The tag push is what publishes. `.github/workflows/publish.yml` runs on a `v*` tag: it refuses a tag that disagrees with `package.json`, runs the suite against installed dependencies, prints the tarball with `npm pack --dry-run`, publishes to npm with provenance through Trusted Publishing, and creates the GitHub Release whose body is the `CHANGELOG.md` section for that tag.

Pushing to `main` never publishes. `.github/workflows/ci.yml` builds and tests on every push and pull request and does nothing else, so work in progress can sit on `main` for as long as you like.

## Where the version lives

`package.json` holds the one source of truth. npm keys releases off it, `dokuha --version` prints it, and the publish workflow refuses a tag that disagrees with it. `npm run bump` updates `package.json` and the `· vX.Y.Z` in the README title together, and deliberately does not touch `CHANGELOG.md`, whose `## vX.Y.Z` headings are history and whose newest section becomes the release body.

`node tools/release-notes.mjs vX.Y.Z` prints that body. It exits non-zero when the section is missing, so a release cannot ship empty notes.

## One-time npm setup

Trusted Publishing needs no token stored in the repository or in CI secrets. On npmjs.com, open the package settings, Trusted Publisher, GitHub Actions, and set:

- Organization or user: `GolyBidoof`
- Repository: `dokuha-cli`
- Workflow filename: `publish.yml`
- Environment: none

Until that publisher exists the upload fails with an OIDC error while every check above it still runs. To rehearse without publishing, dispatch `publish.yml` by hand and leave `dry_run` on: it packs and checks but does not upload.

## Installing, and how updates arrive

`npm install -g dokuha-cli` installs the `latest` dist-tag, and a tag push is what moves it. An installed copy checks the registry at most once a day and prints one line when a newer release exists. `dokuha --check-update` asks immediately and exits 0 when current, 1 when a newer release exists and 2 when the check failed; `dokuha --update` runs the global install. The check never delays a download and stays silent for `--json`, `--quiet` and non-terminal stderr.

## What a release must pass

- `npm test` green, with only the opt-in live file skipped.
- The tag matches `package.json`; the workflow enforces this before it touches the registry.
- `npm pack --dry-run` lists the binary, `src/`, `vendor/`, `docs/` (including the README images), `CHANGELOG.md`, `LICENSE` and the logo, and nothing from tests, benches or local state.
- The CHANGELOG section for the version exists and reads as release notes, not as a to-do list.

The architecture, the store protocols and the optional bridge hand-off are documented in [docs/architecture.md](docs/architecture.md), [docs/stores.md](docs/stores.md) and [docs/troubleshooting.md](docs/troubleshooting.md).
