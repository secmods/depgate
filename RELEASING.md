# Releasing DepGate

A release is a version tag. Pushing it runs `.github/workflows/release.yml`, which publishes the image `ghcr.io/secmods/depgate:<version>`, and the same image on Docker Hub as `secmods/depgate:<version>`, for linux/amd64 and linux/arm64, and creates the GitHub release with three files: `depgate-<version>.tar` (the amd64 image, for hosts without registry access), its `.sha256`, and `deploy-<version>.tar.gz` (the `deploy/` folder). No `latest` tag is published: every deploy setup pins a version. The same tag runs `.github/workflows/docs.yml`, which builds the VitePress site in `docs/` and publishes it to the `gh-pages` branch.

## Steps

Actions → Release → Run workflow, choose patch, minor, or major. The workflow runs `npm version` on `main` and pushes the commit and the tag `v<version>` with the release deploy key (see One-time setup). That tag push publishes the release and the docs.

`npm version` bumps the root `package.json`, then runs `scripts/set-deploy-version.sh` (through the `version` script): it writes the same version into `deploy/all-in-one/.env.example`, `deploy/app-only/.env.example`, `deploy/kubernetes/kustomization.yaml` and the two workspace `package.json` files, refreshes `package-lock.json`, and stages them. The bump, the stamped files and the tag land in one commit.

By hand: `main` takes changes only through a pull request with passing checks, so put the bump on a branch, merge it, then tag the merged commit:

```bash
git checkout main && git pull && git checkout -b release/v1.0.1
npm version 1.0.1 --no-git-tag-version     # or: patch, minor, major
git add package.json && git commit -m "Release 1.0.1"
git push -u origin release/v1.0.1          # open the pull request and merge it, then:
git checkout main && git pull && git tag v1.0.1 && git push origin v1.0.1
```

The workflow refuses a tag on a commit that is not on `main`, a tag whose version differs from `package.json`, and a commit whose deploy files were edited by hand (`scripts/set-deploy-version.sh --check`, which CI also runs on every push).

## After the workflow

1. Edit the release notes. The template has two lines to fill in: **Database upgrade** (none, or the migrations this release applies and how long they take on a large database) and **Settings** (new or renamed variables).
2. Check that `docker pull ghcr.io/secmods/depgate:<version>` and `docker pull secmods/depgate:<version>` work without signing in. The GitHub package must be public (the package's settings, "Change visibility"), and so must the Docker Hub repository.

## One-time setup

The "Protect main" ruleset requires a pull request and passing checks for every change to `main`, and the workflow's own token cannot be exempted. So the Run workflow path pushes the version bump with a deploy key, which the ruleset lets bypass its rules. A tag pushed with the key also starts the release and docs workflows, which a tag pushed with the workflow's token would not.

1. Settings → Environments → New environment `release`. Under "Deployment branches and tags" choose "Selected branches and tags" and add `main`, so only a workflow run from `main` can read the key.
2. Create the key, add it as a deploy key with write access, store the private half in the environment, and delete the local copy:

   ```bash
   ssh-keygen -t ed25519 -N "" -C "depgate release workflow" -f depgate-release
   gh repo deploy-key add depgate-release.pub --repo secmods/depgate --allow-write --title "Release workflow"
   gh secret set RELEASE_DEPLOY_KEY --repo secmods/depgate --env release < depgate-release
   rm depgate-release depgate-release.pub
   ```

3. Settings → Rules → Rulesets → Protect main → Bypass list → Add bypass → Deploy keys, set to "Always allow", and save.

Other setup:

- Docker Hub: the public repository `secmods/depgate`, and an account that may push to it. Create an access token for that account with Read & Write scope (Docker Hub → Account settings → Personal access tokens). Store both in an environment `publish` that only version tags may use, so only the release job reads them. Not in `release`: a tag run must never be able to read its deploy key.

  ```bash
  echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/secmods/depgate/environments/publish --input -
  gh api -X POST repos/secmods/depgate/environments/publish/deployment-branch-policies -f name='v*' -f type=tag
  gh secret set DOCKERHUB_USERNAME --repo secmods/depgate --env publish --body '<docker hub user>'
  gh secret set DOCKERHUB_TOKEN --repo secmods/depgate --env publish     # paste the token when asked
  ```

  Without them the release stops at "Sign in to Docker Hub", before anything is pushed.
- The `secmods` organization owns the package `depgate`. When this repository is not in that organization, the workflow's own token cannot push there: create a token with `write:packages` on the organization and store it as the repository secret `GHCR_TOKEN`. The workflow uses it when present, otherwise `GITHUB_TOKEN`.
- Nothing in `deploy/` names the registry beyond the image name; mirrors are set by the customer (`DEPGATE_IMAGE`, or `newName` in `kustomization.yaml`).
