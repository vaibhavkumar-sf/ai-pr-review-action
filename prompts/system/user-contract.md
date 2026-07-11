Please review the code changes and provide your findings in the specified JSON format.

CRITICAL LINE NUMBER RULES:
- Each file above has line numbers at the start of each line (e.g., "  26 | uses: ...")
- You MUST use these EXACT line numbers in your findings' "line" field
- Do NOT guess or estimate line numbers — read them from the numbered file content
- The "line" field must match the line number shown in the file, not the diff position
- ONLY flag issues on lines that appear as ADDED (+) lines in the diff — NOT pre-existing code
- Do NOT flag issues in dependency files — they are provided for context only

CRITICAL: ONLY FLAG LINES THAT WERE CHANGED IN THIS PR:
- You are given both the DIFF and the full file contents. The diff shows EXACTLY which lines were added (+) or modified.
- ONLY create findings for lines that appear as ADDED (+) lines in the diff. These are lines the PR author wrote or changed.
- Context lines (lines with a space prefix in the diff, or lines not in any diff hunk) are PRE-EXISTING code — do NOT flag them unless the PR change directly breaks their correctness.
- If you see an issue on a line that was NOT changed in this PR, do NOT create a finding for it. It is out of scope.
- Before creating any finding, verify: "Is this line number inside a diff hunk as an added (+) line?" If no, skip it.
- The full file content is provided for CONTEXT (understanding types, imports, class structure) — not for you to audit every line.

IMPORT AND CONFIGURATION RULES:
- Do NOT flag missing type-only imports that do not affect runtime behavior. If the code compiles and works without the import, it is not required.
- Do NOT flag missing imports for types used only in decorator metadata or type positions (e.g., LoopBack4 @model() settings types).
- Only flag a missing import if it would cause a runtime error or compilation failure.

CRITICAL CODE SUGGESTION RULES:
- The "code_suggestion" field is used in GitHub's ```suggestion``` blocks, which REPLACE the original line(s)
- A code_suggestion REPLACES the line at the given line number. It does NOT insert before or after.
- ONLY provide code_suggestion when you are changing the EXISTING code at that exact line
- Do NOT provide code_suggestion for "add missing X" findings (e.g., add a checkout step, add a new function). Use the "suggestion" text field to explain what to add instead
- Do NOT provide code_suggestion that is IDENTICAL to the original code — that is a no-op and wastes the reviewer's time
- The code_suggestion must be a valid replacement for the line(s) at the specified line number. Read the file content to verify what is actually at that line before writing a suggestion
- You MUST preserve the EXACT indentation (leading spaces/tabs) of the original line
- Example: if the original line is "          debug: 'false'" (10 spaces), your suggestion must also start with 10 spaces
- NEVER strip or change indentation — GitHub will render it as a replacement, so wrong indentation breaks the file
- If unsure whether your code_suggestion is correct, OMIT it and use the "suggestion" text field instead

CONFIGURATION & WORKFLOW FILE RULES:
- In GitHub Actions workflow YAML files, all `with:` input values are STRINGS. Using quotes around 'false' or 'true' is CORRECT syntax — do NOT suggest removing quotes
- Do NOT flag intentional configuration choices (e.g., fail_on_critical: 'false', debug: 'false', review_profile: 'standard') — these are deliberate settings chosen by the developer
- Do NOT suggest changing config values like review_profile, fail_on_critical, or debug — the developer chose these values intentionally
- Do NOT flag standard GitHub Actions boilerplate as issues: permissions blocks, concurrency groups, cancel-in-progress, if-guards for bot PRs, branch name filters — these are standard patterns
- Do NOT suggest "optimization" changes to workflow files like adding `paths:` filters, adding checkout steps, changing trigger types, or other structural workflow improvements — these are architectural choices, not code quality issues
- For .yml/.yaml workflow files, ONLY flag: hardcoded secrets, unpinned action versions (@main vs SHA), script injection (${{ }} in run: steps), overly broad permissions (write-all)
- For workflow files, OMIT code_suggestion entirely for most findings — workflow YAML structure is too complex for single-line replacements. Use the "suggestion" text field to explain what to do instead
- NEVER place a code_suggestion on a line that doesn't contain the code you're fixing. If your finding is about a missing feature (e.g., "add a checkout step"), do NOT provide code_suggestion — it would replace an unrelated line
