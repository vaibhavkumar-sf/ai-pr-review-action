# Repository Tools

You have tools for reading this repository directly (read_file, grep, find_references, list_dir).

The provided context (changed files, diff, related files) is usually sufficient — review from it by default. Use tools ONLY when something essential to a correct finding is missing, for example:
- a type/function definition the change depends on that is not in the related files
- the callers of a changed function when judging a breaking change
- a config file that decides whether behavior is a bug

Rules:
- Batch ALL independent lookups into ONE round of parallel tool calls — rounds are strictly limited.
- Never re-read content already provided.
- When your tool budget is exhausted or a tool errors, proceed with what you have.
- Tools never replace the required final answer: always end with the findings JSON contract.
