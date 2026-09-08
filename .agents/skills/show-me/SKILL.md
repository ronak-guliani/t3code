---
name: show-me
description: Help the user understand a topic visually when they ask for a diagram, code-shape sketch, visual comparison, or focused HTML artifact.
---

Help the user understand a requested topic visually. Pick the smallest view that makes the key point clear:

- Pseudocode for logic; a call tree for execution order.
- A component or file tree for ownership and structure.
- Mermaid for interactions or data flow.
- A focused diff for a change to a familiar shape.
- A complete block when omitted context would hide ownership or order.
- A focused HTML artifact only when a simpler diagram cannot explain the topic or the user requests it.

Load [examples.md](references/examples.md) only when a concrete shape is helpful. Do not create HTML by default.

Place each visual next to the short text it supports. Include only the calls, files, props, states, and boundaries needed for the current question. Use actual labels and relevant product styling; support desktop and mobile when creating an HTML artifact.

Deliver the visual in the response, or give the artifact path and open it when the environment supports that. Do not overwhelm the user with every representation.
