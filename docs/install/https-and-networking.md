# HTTPS and networking

DepGate is usually installed inside a company network: with a certificate from the company CA, behind a load balancer, and with outbound traffic through a proxy. This page covers each of those setups.

## HTTPS in DepGate

By default DepGate terminates TLS itself:

- HTTPS on host port **443**, using `certs/tls.crt` and `certs/tls.key`.
- Host port **80** redirects every request to the same path on `GATEWAY_URL`.

**Renewing the certificate.** Overwrite `tls.crt` and `tls.key`. DepGate picks up the new files within a minute, without a restart. To apply them at once:

```bash
docker compose kill -s HUP app
```

**Certificates inside a company network.** A server without internet access cannot obtain a public certificate. Use one issued by your company CA for the exact host name in `GATEWAY_URL`, with the intermediate certificates appended to `tls.crt`.

| Setting | Default | Description |
|---|---|---|
| `HTTPS_PORT` | `443` | Host port for HTTPS. |
| `HTTP_PORT` | `80` | Host port for the redirect. |
| `HTTP_REDIRECT` | `true` | `false` closes the HTTP port instead of redirecting. |

## Behind your own TLS proxy

If a load balancer or reverse proxy terminates TLS, set `DISABLE_SSL=true` in `.env`. DepGate then serves plain HTTP on port 80 and needs no certificate.

- Keep `GATEWAY_URL` set to the proxy's `https://` address.
- If the proxy runs on the same host, set `HTTP_BIND=127.0.0.1` so nothing can reach DepGate around the proxy. If the proxy needs port 443 on that host, also set `HTTPS_PORT=127.0.0.1:8443`.
- DepGate trusts one proxy hop for client addresses (`TRUST_PROXY=1`). Set the number of hops if there are more.

Configure the proxy to pass the `Host` header and `X-Forwarded-For`, allow large request bodies, and stream downloads without buffering. For nginx:

```nginx
location / {
    proxy_pass http://depgate-host:80;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 1g;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

## Corporate outbound proxy

DepGate fetches packages, vulnerability data and feeds from the internet. To send that traffic through an HTTP proxy, add to `.env`:

```ini
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://proxy.example.com:3128
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,.internal.example.com
```

- Put credentials in the URL (`http://user:password@proxy.example.com:3128`) and URL-encode special characters.
- List internal hosts in `NO_PROXY`: internal registries, webhook endpoints and the database.
- Email (SMTP) does not use the proxy.
- If the proxy inspects TLS, add its CA certificate to `certs/ca.crt`. DepGate trusts that file for every outgoing connection.

## Trusting your CA in package clients

Clients must trust the certificate DepGate presents. Most use the operating system's trust store, which usually already holds the company CA. Some need it configured:

| Client | How to trust the company CA |
|---|---|
| npm, Yarn, pnpm | `npm config set cafile /path/to/company-ca.pem`, or the `NODE_EXTRA_CA_CERTS` environment variable |
| pip | `pip config set global.cert /path/to/company-ca.pem`, or `REQUESTS_CA_BUNDLE` |
| Maven, Gradle | Import into the Java truststore: `keytool -importcert -cacerts -alias company-ca -file company-ca.pem` |
| Go, Cargo, Composer, NuGet, RubyGems | Operating system trust store |

## Air-gapped installations

DepGate can run with no inbound internet access. It still needs outbound access to the registries it proxies and to its data sources. Where that is not allowed:

- Point the repositories at internal mirrors (Artifactory, Nexus) instead of the public registries.
- Point `EPSS_FEED_URL` at an internal copy of the daily EPSS file, and `MALICIOUS_FEED_URL` / `MALICIOUS_FEED_ARCHIVE_URL` at a mirror of the malware feed.
- Without vulnerability data, Vulnerability policies cannot match. Plan for an internal OSV mirror (`OSV_API_URL`).

## What is exposed

| Port | Exposed | Serves |
|---|---|---|
| 443 | Yes | Web interface, API and registries over HTTPS. |
| 80 | Yes | Redirect to HTTPS, or the whole application with `DISABLE_SSL=true`. |
| 9464 | No (private Compose network) | `/metrics`, `/healthz`, `/readyz`. |

The application runs as an unprivileged user. The optional database stack publishes PostgreSQL and Redis only on the loopback interface.
