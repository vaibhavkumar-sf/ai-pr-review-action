Some Mermaid diagrams have syntax errors. Fix them and return the SAME JSON format as before, with ALL four keys (flowchart_styled, flowchart_simple, sequence_styled, sequence_simple).

{{error_sections}}Common fixes: Quote ALL labels. Use -->|"label"| not commas. No par in flowcharts. No colons in flowchart labels. Never the ":::" shorthand — use a separate "class A name" line. Keep the styled version styled; keep the simple version plain (no init directive, classDef or emojis there).

