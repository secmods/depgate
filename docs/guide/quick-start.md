# Quick start

In about ten minutes you will run DepGate on one machine, connect npm to it, and watch it block a vulnerable package. This setup is for evaluation. For a production installation, follow [Install with Docker](/install/docker).

## Before you begin

You need:

- A Linux or macOS machine with **Docker Engine** and **Docker Compose v2**.
- **Git** and **OpenSSL**.
- Outbound internet access, so DepGate can reach the public registries.
- Ports **80** and **443** free on the machine.
- **Node.js and npm**, to try an install at the end.

## Step 1: Get DepGate

Download `deploy-<version>.tar.gz` from the [latest release](https://github.com/secmods/depgate/releases) and change to the all-in-one folder:

```bash
tar -xzf deploy-0.1.0.tar.gz
cd deploy/all-in-one
```

## Step 2: Start everything

The quick-start script writes a configuration file with generated secrets, creates a local certificate authority and an HTTPS certificate for `localhost`, and starts PostgreSQL, Redis and DepGate from their published images:

```bash
./quickstart.sh
```

The first run pulls the images. When it finishes, the script checks that DepGate answers and prints the address and the admin account.

::: tip No access to the registry?
Download `depgate-<version>.tar` from the same release and load it first: `docker load -i depgate-<version>.tar`. The script then uses the loaded image.
:::

## Step 3: Sign in

1. Open **https://localhost** in your browser. The certificate comes from the local CA the script created; accept it, or import `deploy/all-in-one/certs/ca.crt` into your browser's trust store.
2. Sign in as `admin@example.com`. The password is `ADMIN_PASSWORD` in `deploy/all-in-one/.env`.

![The DepGate sign-in page](/screenshots/login.png)

You land on the **Dashboard**. It is empty until packages flow through the gateway.

The sidebar on the left lists every page. To get more room, choose the arrow on its edge: the sidebar shrinks to icons, and hovering an icon shows its name. Choose the arrow again to expand it. Your browser remembers the choice. On a phone or small window, the sidebar opens from the menu button instead.

## Step 4: Look at the policies

In the sidebar, choose **Policies**. A new installation starts with eight [starter policies](/admin/policies#starter-policies). Four enforce, among them **Critical vulnerabilities**, which blocks versions with a vulnerability scored CVSS 9.0 or higher; four only monitor.

To add a policy of your own:

1. Choose **New policy**.
2. **Name**: `High vulnerabilities in production`.
3. Under **Rule**, choose **Vulnerability**, and set **CVSS score at least** to `7.0`.
4. Under **Enforcement**, choose **Monitor only (log, don't block)** to see what it would block before it blocks anything.
5. Choose **Create policy**.

![Creating a vulnerability policy](/screenshots/policy-new-vulnerability.png)

[Create a policy](/admin/create-policy) explains every field.

## Step 5: Connect npm

1. In the sidebar, choose **Registry**. The **npm** tab shows a ready-made `.npmrc` with your personal registry token.
2. Choose **Copy snippet**.
3. Create an empty folder, and save the snippet in it as `.npmrc`.
4. npm must trust the local CA. In the same folder, run:

   ```bash
   npm config set cafile /path/to/deploy/all-in-one/certs/ca.crt --location=project
   ```

![The Registry page with the npm snippet](/screenshots/registry-npm.png)

## Step 6: Install a package

Install a current, healthy version. DepGate allows it:

```bash
npm install express
```

Now install a version with a known critical vulnerability:

```bash
npm install minimist@1.2.5
```

npm fails with `403 Forbidden`. The response names the policy and the vulnerability that matched, and links to Package check, which shows the newest version you can use instead.

## Step 7: See the decisions

- **Dashboard** counts the allowed and blocked requests.
- **Decision Ledger** lists the blocked install. Expand it to see the policy, the vulnerability and who made the request.
- **Package check** (`minimist`, npm) shows every recent version of the package, which ones are allowed, and why the others are blocked.

## Clean up

To stop DepGate and its database (the data is kept):

```bash
./3-run.sh --stop
```

`docker compose down -v` in the same folder also deletes the database data and the artifact cache.

## Next steps

- [Policies overview](/admin/policies): plan the policies your organization needs.
- [Monitor before enforcing](/admin/monitoring): roll out broad rules without breaking builds.
- [Connect your package manager](/developers/connect-package-managers): settings for every ecosystem.
- [Install with Docker](/install/docker): a production installation with your own certificate and database.
