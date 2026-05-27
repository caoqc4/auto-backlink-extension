# Security Policy

Backlink Forge stores user-provided API keys, Google OAuth tokens, project records, and backlink workflow data locally in the browser extension environment.

## Reporting

Please report vulnerabilities privately to the maintainer before opening a public issue. Include:

- A concise description of the issue.
- Steps to reproduce.
- The affected extension version or commit.
- Any relevant browser and operating system details.

## Sensitive Data Guidelines

Do not commit:

- API keys or model provider tokens.
- Google OAuth client secrets or access tokens.
- Browser cookies, session tokens, or captured authenticated requests.
- Private backlink datasets, spreadsheets, account emails, or customer data.
- Built extension packages signed with private keys.

If sensitive data was committed, rotate the exposed credential immediately and rewrite repository history before publishing.
