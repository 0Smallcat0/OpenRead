# Security policy

OpenRead is a translation tool whose entire claim is that what you read stays
on your machine. A vulnerability here is not a crash — it is a page of text
reaching somewhere it was never supposed to go. That is the class of bug this
document is asking for.

## Reporting

Use GitHub's private reporting: **[Report a
vulnerability](https://github.com/0Smallcat0/OpenRead/security/advisories/new)**.
It opens a channel only you and the maintainer can read.

Please do not open a public issue for something exploitable. Everything else —
a wrong translation, a broken selection, a permission that looks larger than it
needs to be — belongs in the [public
tracker](https://github.com/0Smallcat0/OpenRead/issues) and is more useful
there.

Include what you did, what happened, and the version (`chrome://extensions`
shows it). A rough reproduction beats a polished report that cannot be run.

## What to expect

One maintainer, no bounty, no SLA. Realistically: acknowledged within a week,
and a fix or an explanation of why it is not one within a month. If a report is
valid you will be credited in the release notes unless you would rather not be.

If a fix ships, the advisory is published with it, and the CHANGELOG says what
was wrong rather than "security fix".

## What counts

The threat model is narrow, which makes the interesting bugs easy to name.

**In scope:**

- Any path by which page content, a selection, or a translation leaves the
  machine — other than to the Ollama server URL the user configured themselves.
- Any way a web page can reach the extension's privileged surfaces: the message
  port, the background broker, `chrome.storage`, or the bundled PDF.js viewer.
- Any way a web page's own requests can match the `declarativeNetRequest` rule
  in [`src/core/dnr-rule.ts`](src/core/dnr-rule.ts). That rule strips the
  `Origin` header, and it is scoped to `tabIds: [-1]` with a `urlFilter`
  anchored to the configured server so that a page can never be the initiator.
  A demonstration that the scoping fails is exactly the report to send.
- Injection through translated text — content that escapes the translation
  layer and executes in the page, or in the popup, or in the viewer.
- A capture that writes somewhere other than the `obsidian://` URI it claims.

**Out of scope:**

- Ollama itself, and anything reachable because you pointed OpenRead at a
  server exposed to a network. Take it to the Ollama project.
- Chrome's built-in translator, its language packs, and the quality or content
  of what it returns. That model is Google's; OpenRead calls it.
- Anything that requires the attacker to already have the ability to run code
  on the machine or to install a different extension.
- Translation quality. Wrong is not unsafe — file it as an issue.

## What the extension can already do

Stated plainly so a report can be measured against it rather than against a
guess:

- Host access is `<all_urls>`, because reading material is not a fixed list of
  sites. Page content is read only when you select text and invoke a
  translation, or ask for the whole page.
- On the default engine the extension makes **no network request at all**. On
  the Ollama engine it makes requests to the configured server URL and nowhere
  else.
- `chrome.storage` holds settings only: engine, server URL, model name, target
  language, Obsidian vault and folder, enrichment toggle.
- There is no analytics, no telemetry, no remote configuration, and no code
  that is not in the package.

[`PRIVACY.md`](PRIVACY.md) is the user-facing version of the same statement.

## Supported versions

The latest release. This is a single-maintainer project; there is no branch
receiving backported fixes.
