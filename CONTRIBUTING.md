# Contributing to Marchward

Thanks for helping build Marchward, the runtime authority for AI agents. We welcome issues, fixes, and features for the open engine and SDK.

## Licensing of contributions

The Marchward engine and SDK are licensed under **Apache-2.0**. Under Apache-2.0 section 5, any contribution you intentionally submit for inclusion is licensed under the same terms, with no separate agreement required. We keep it clean with a **DCO**, not a CLA: we will not ask you to assign copyright or sign a contributor license agreement.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/). It is a lightweight, one-line attestation that you have the right to submit your contribution under the project's license. No account, no contract, no copyright assignment, just a sign-off on each commit.

Add a `Signed-off-by` line to every commit:

```
Signed-off-by: Your Name <you@example.com>
```

The easy way: commit with `git commit -s`. The DCO check on each PR verifies it is present.

By signing off you certify the DCO points: you wrote the change, or have the right to submit it under the project's open-source license, and you understand the contribution is public and recorded.

## What lives where (so PRs land in the right place)

Marchward is open-core. The **engine and SDK are open** (this repo). The **hosted control plane is commercial** and lives elsewhere. Contributions here should target the open engine and SDK; see `OPEN-VS-COMMERCIAL.md` for the boundary. If a feature belongs in the hosted plane, open an issue and we will route it.

## How to contribute

1. Open an issue describing the change (bug, feature, or question) before large work.
2. Fork, branch, and make your change with tests.
3. `git commit -s` (DCO sign-off), push, and open a PR against `main`.
4. CI runs tests and the DCO check. A maintainer reviews.

## Trademark

The code is open; the **name and logo are not**. Please read `TRADEMARK.md` before using "Marchward" for a fork, distribution, or service.
