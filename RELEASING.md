# Releasing DepGate

A release is a version tag. Pushing it runs `.github/workflows/release.yml`, which publishes the image `ghcr.io/secmods/depgate:<version>` for linux/amd64 and linux/arm64 and creates the GitHub release with three files: `depgate-<version>.tar` (the amd64 image, for hosts without registry access), its `.sha256`, and `deploy-<version>.tar.gz` (the `deploy/` folder). No `latest` tag is published: every deploy setup pins a version. The same tag runs `.github/workflows/docs.yml`, which builds the VitePress site in `docs/` and publishes it to the `gh-pages` branch.

## Steps

```bash
git checkout main && git pull
npm version 1.0.1            # or: minor, major
git push --follow-tags
```

`npm version` bumps the root `package.json`, then runs `scripts/set-deploy-version.sh` (through the `version` script): it writes the same version into `deploy/all-in-one/.env.example`, `deploy/app-only/.env.example`, `deploy/kubernetes/kustomization.yaml` and the two workspace `package.json` files, refreshes `package-lock.json`, and stages them. The bump, the stamped files and the tag `v1.0.1` land in one commit.

The workflow refuses a tag whose version differs from `package.json`, and a commit whose deploy files were edited by hand (`scripts/set-deploy-version.sh --check`, which CI also runs on every push).

## After the workflow

1. Edit the release notes. The template has two lines to fill in: **Database upgrade** (none, or the migrations this release applies and how long they take on a large database) and **Settings** (new or renamed variables).
2. Check that `docker pull ghcr.io/secmods/depgate:<version>` works without signing in. The package must be public (GitHub: the package's settings, "Change visibility").

## One-time setup

- The `secmods` organization owns the package `depgate`. When this repository is not in that organization, the workflow's own token cannot push there: create a token with `write:packages` on the organization and store it as the repository secret `GHCR_TOKEN`. The workflow uses it when present, otherwise `GITHUB_TOKEN`.
- Nothing in `deploy/` names the registry beyond the image name; mirrors are set by the customer (`DEPGATE_IMAGE`, or `newName` in `kustomization.yaml`).
