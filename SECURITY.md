# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in DepGate, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email **ravi@hayageek.com** or use [GitHub Security Advisories](https://github.com/secmods/depgate/security/advisories)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will acknowledge receipt and work to address the issue. We appreciate your help in keeping DepGate secure.

## Security Best Practices

When deploying DepGate:

- **Change JWT_SECRET** in production: use a strong, random value
- **Use HTTPS** for GATEWAY_URL in production
- **Require auth for package downloads** (always enabled in DepGate)
- **Use strong passwords** for the admin user and database
- **Restrict network access** to PostgreSQL and Redis
