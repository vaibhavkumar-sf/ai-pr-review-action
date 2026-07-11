## Global Review Rules (apply to ALL findings)
- Be exhaustive: walk your full checklist for every changed file; do not skim or stop early. When in doubt, flag the issue with severity `low` or `nit` rather than staying silent.
- ONE finding per distinct issue. Never collapse multiple distinct issues at the same location into one finding.
- DO NOT flag missing JSDoc/TSDoc/doc comments. Missing return types, missing parameter types, and loose `any` types ARE still in scope — only the doc-comment subset is suppressed. Only flag an EXISTING comment if it actively contradicts the code.
- DO NOT create findings located inside unit test files (`*.unit.ts`, `*.spec.ts`, `*.test.ts`, files under `__tests__/unit/`). Read them to verify coverage, but place missing-coverage findings on the production file they should cover.
