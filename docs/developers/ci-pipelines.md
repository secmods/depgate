# CI/CD pipelines

Build pipelines download packages through DepGate exactly like developers do, with one difference: they should use a **CI token**, not a person's registry token. A CI token:

- can only download packages;
- expires after a short time you choose (at most 1 day);
- carries build metadata, such as the repository and build number, which the Decision Ledger records on every download it blocks.

## How it works

1. A Security user creates a **service account**, for example `github-actions`, under **Access → Service accounts**. DepGate shows its key once. See [Service accounts](/admin/users#service-accounts).
2. You store the service-account key as a secret in your CI system.
3. At the start of each job, the pipeline exchanges the key for a CI token.
4. The pipeline uses the CI token in the package manager settings, in place of `<TOKEN>`.

The service-account key itself can only mint CI tokens; it cannot sign in or change any setting.

## Mint a CI token

```bash
curl -sS -X POST https://depgate.example.com/api/admin/ci-tokens \
  -H "Authorization: Bearer $DEPGATE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "github-actions",
        "expiresIn": "2h",
        "metadata": { "repository": "acme/storefront", "pr_number": "4821", "build_number": "9102" }
      }'
```

The response contains `token`. It is shown only once.

| Field | Description |
|---|---|
| `name` | A label shown in the Decision Ledger and the Audit Log. |
| `expiresIn` | Lifetime, such as `30m`, `2h` or `1d`. Maximum 1 day. Anything longer is rejected. Keep it as short as the job. |
| `metadata` | Key-value pairs recorded with every download, for example the pull request and build number. |

## Example: GitHub Actions with npm

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Get a DepGate token
        run: |
          TOKEN=$(curl -sS -X POST https://depgate.example.com/api/admin/ci-tokens \
            -H "Authorization: Bearer ${{ secrets.DEPGATE_SERVICE_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"github-actions\",\"expiresIn\":\"1h\",\"metadata\":{\"repository\":\"${{ github.repository }}\",\"run_id\":\"${{ github.run_id }}\"}}" \
            | jq -r .token)
          echo "::add-mask::$TOKEN"
          cat > ~/.npmrc <<EOF
          registry=https://depgate.example.com/npm/default/
          //depgate.example.com/npm/default/:_authToken=$TOKEN
          EOF

      - run: npm ci
```

For other ecosystems, write the settings from [Connect your package manager](./connect-package-managers) with the CI token in place of `<TOKEN>`.

## Fail early on blocked versions

To fail a build before installing, call Package check for your pinned versions. CI tokens and service-account keys can call it:

```bash
curl -sS -X POST https://depgate.example.com/api/package-check \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ecosystem":"npm","package":"lodash","versions":["4.17.21"],"repository":"default"}'
```

See the [REST API](/reference/api) for the full request and response.

## Revoking a token

A Security user can list active CI tokens and revoke one with `DELETE /api/admin/ci-tokens/<id>`. Deleting the service account revokes its key. Security users cannot mint CI tokens themselves.
