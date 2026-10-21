# Ecosystem install tests

Real client installs for npm, PyPI, Go, Maven, NuGet, Cargo, Composer, and RubyGems. Each app lists six direct dependencies. `install_packages.sh` runs the official client inside Docker, points it at DepGate, and installs those dependencies one at a time so a blocked package does not hide the rest.

You do not install npm, Maven, Cargo, the .NET SDK, or the other CLIs on the host. Docker is enough. The first run of an ecosystem builds `depgate-test-<ecosystem>` from the official image and adds `socat` and `curl` (with `apk` on the Alpine-based Composer image, `apt-get` on the others). Later runs reuse that image. Set `DEPGATE_REBUILD=1` to build it again.

## Run one ecosystem

Start DepGate, then pass the same email address and password you use to sign in (`user@example.com:password`). The script logs in and uses the registry token from that response.

```bash
cd test_apps/npm
./install_packages.sh http://localhost:3050 'user@example.com:password'
```

The same two arguments work in every directory: `pypi`, `go`, `maven`, `nuget`, `cargo`, `composer`, `rubygems`.

Pass a repository URL when the repo key is not `default`:

```bash
./install_packages.sh http://localhost:3050/npm/all/ 'user@example.com:password'
```

Run every ecosystem:

```bash
cd test_apps
./run-all.sh http://localhost:3050 'user@example.com:password'
```

`localhost` in that URL is the host running DepGate. Inside the container the script forwards `127.0.0.1` to the host and points the clients at `http://localhost`. Cargo, Composer, and Maven only accept a plain HTTP registry on localhost, and DepGate rewrites artifact URLs to that same host.

## What the log means

Each dependency is installed with that ecosystem's real command (`npm install`, `pip install`, `go mod download`, `mvn dependency:get`, `dotnet restore`, `cargo fetch`, `composer require`, `gem install`). The client log is printed as it runs. After each one:

```text
RESULT ALLOWED  lodash@4.17.21
RESULT BLOCKED  lodash@4.17.21
         npm error code E403
         npm error 403 Forbidden - GET http://localhost:3050/npm/lodash/-/lodash-4.17.21.tgz - Package blocked by policy "lodash": ...
```

The script exits 0 when every dependency is allowed, and 2 when any dependency is blocked or fails for another reason. A blocked npm version stays in the package list so `npm install name@version` downloads that tarball. The download is HTTP 403, the install fails, and that request is the decision-ledger row. pip keeps the file in the simple index with `data-yanked` set to the policy sentence, so a pinned install prints that reason and then the download's HTTP 403. Go and Maven leave the blocked version out of the version list and return HTTP 403, with the policy sentence in the status line, when that exact version is requested. NuGet, Composer, Cargo, and RubyGems keep the version listed and refuse the download with HTTP 403 and the same sentence, which is the text those clients print. HTTP 401 is an authentication error, usually a missing or expired token.

`debug` and `chalk` in the npm app are on the public malicious package list. With that feed enabled they show as blocked, and the other four npm packages install.

DepGate rewrites simple-index links to `/pypi/<repo>/files/<package>/<file name>` and finds the upstream file again in the same index when pip downloads it, so the link carries no upstream address and does not expire. Nothing follows the file name, so pip's PEP 658 `<file URL>.metadata` requests work too. If pip reports `from versions: none`, the simple index is broken and the script marks the package as an error.

npm and Cargo send the token as `Authorization: Bearer`. The other clients send HTTP Basic with username `_` and the token as the password, which is what the Registry page shows. The token is kept in the container home directory (`~/.npmrc`, `~/.netrc`, Maven `settings.xml`, `NuGet.Config`, Cargo config, Composer `auth.json`), or in the source URL for pip and RubyGems (`gem` does not read `~/.netrc`), and is redacted if a tool prints it.

Go is configured with `GOPROXY` only. There is no `,direct` fallback, so a blocked module is not fetched from GitHub. The `go` command never sends credentials over plain HTTP, so for an `http://` gateway the script terminates TLS inside the container with a throwaway certificate and sets `GOPROXY=https://localhost:3443/go/<key>`; the token is in `~/.netrc` under `machine localhost:3443`. Checksums are still verified against `sum.golang.org`. Composer has public Packagist turned off. NuGet clears nuget.org. Maven mirrors every repository to DepGate.

## Images

| Directory | Base image | Client command |
|-----------|------------|----------------|
| `npm` | `node:22-bookworm-slim` | `npm install` |
| `pypi` | `python:3.12-slim-bookworm` | `pip install` |
| `go` | `golang:1.23-bookworm` | `go mod download` |
| `maven` | `maven:3.9-eclipse-temurin-21` | `mvn dependency:get` |
| `nuget` | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet restore` |
| `cargo` | `rust:1-slim` | `cargo fetch` |
| `composer` | `composer:2` | `composer require` |
| `rubygems` | `ruby:3.3-slim-bookworm` | `gem install` |

The .NET SDK and Rust images are large. The first `docker build` for those two downloads about a gigabyte each.
