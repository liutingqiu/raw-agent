# Security policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/liutingqiu/raw-agent/security/advisories/new>.

Include the affected version, operating system, reproduction steps, impact, and any suggested fix.
Do not include secrets or account data. Please avoid filing a public issue until a fix is available.

## Trust model

`raw` intentionally executes model-generated shell commands and browser scripts with the current
user's operating-system permissions. The `ask` and `readonly` permission modes control tool calls;
they are user controls rather than an operating-system sandbox. Dedicated file tools enforce the
workspace boundary unless `RAW_ALLOW_OUTSIDE=1` is set. Shell and browser tools are not confined to
that boundary.

Configuration, conversation history, recent image attachments, notes, downloads, and the dedicated
browser profile are stored locally in the raw data directory. Remote page and search content is
untrusted input to the model and can influence subsequent tool calls; use `ask` or `readonly` when
reviewing content that should not be allowed to trigger state changes automatically.
