---
"@pnpm/installing.deps-installer": patch
"@pnpm/lockfile.verification": patch
"pnpm": patch
---

`pnpm install --frozen-lockfile` now fails when workspace package versions or workspace members have drifted from the lockfile [pnpm/pnpm#7823](https://github.com/pnpm/pnpm/issues/7823).
