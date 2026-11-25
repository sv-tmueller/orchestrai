# Third-party notices

This repo is otherwise all-rights-reserved (see the License section in
`README.md`), but two skills incorporate content from MIT-licensed sources.
This file carries the notice that each license requires; each affected skill
also carries a short attribution pointing back here.

## mattpocock/skills

Source: [mattpocock/skills](https://github.com/mattpocock/skills)

- `.claude/skills/tm-grill-me/SKILL.md` is a near-verbatim adaptation of
  their `skills/productivity/grilling/SKILL.md`.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cloudflare/security-audit-skill

Source: [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill),
commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`

- `.claude/skills/tm-security-audit/` is a copy of their `skills/security-audit/`
  (20 files). Every file is byte-identical except `SKILL.md`, which differs in
  its `name:` line, one added frontmatter line (`disable-model-invocation: true`),
  and an orchestrai header.

```
MIT License

Copyright (c) 2025-2026 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other referenced sources (no attribution required)

- `vijaythecoder/awesome-claude-agents`: `docs/research/2026-07-04-awesome-claude-agents-adoption.md`
  is our own analysis of their published structure, philosophy, and routing
  approach. Checked against their file tree and nine representative agent
  files; no file in this repo copies any of their content verbatim or
  substantially, so no MIT attribution is required for that source.
- `owainlewis/youtube-tutorials`: `docs/team-architecture.md` credits a
  tutorial from this source as the origin of the flat-star diagram idea,
  adapted to this repo's own model. Idea only, not a file copy.
