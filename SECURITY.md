# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories:
[Report a vulnerability](https://github.com/antohins/seo-tools-mcp/security/advisories/new).

Do not open a public issue for security problems. You can expect an initial response
within a few days.

## Handling of credentials

These servers talk to third-party APIs on your behalf, so they hold API keys and OAuth
tokens. How they are handled:

- Credentials live in a single env file, `~/.config/seo-tools-mcp/.env`, written with
  mode `600`. They are **never** committed — `.env` is git-ignored.
- Secrets are masked before anything is logged: request URLs pass through `maskUrl`
  (query secrets and userinfo redacted), and status responses use `maskSecret`.
- Keys provided through chat pass through the model's context — for maximum hygiene,
  write them into the config file by hand instead (the servers pick it up on their own).
- When exposing servers remotely (the supergateway scenario in the README), the endpoint
  fronts all your service keys: use HTTPS, a long secret path, and a separate access log.

## Scope

The read-only design means the servers cannot modify provider data. The main risk surface
is credential exposure — see above.
