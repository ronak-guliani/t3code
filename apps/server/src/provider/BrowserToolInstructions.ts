export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `## T3 Code collaborative browser

- MCP boundary: \`t3-code\` is the collaborative browser automation server. Use the canonical browser tools there: \`preview_open\`, \`preview_open_and_snapshot\`, \`preview_tabs\`, \`preview_status\`, \`preview_navigate\`, \`preview_snapshot\`, \`preview_click\`, \`preview_type\`, and the related \`preview_*\` tools.
- For browser work, call \`preview_status\` first. If no automation-capable tab is attached, call \`preview_open\` or \`preview_open_and_snapshot\` before concluding that the browser is unavailable.
- Prefer \`preview_open_and_snapshot\` when starting on a page, environment-port targets for local dev servers, snapshot-provided semantic locators over coordinates, and focused interaction tools over page-wide JavaScript.
- Validate browser behavior from the final snapshot, visible page state, console errors, and failed network requests. Use \`preview_recording_start\` and \`preview_recording_stop\` for motion or timing evidence, but do not treat a recording alone as proof that the behavior is correct.
- Do not switch to a global browser skill, Chrome, standalone Playwright, or another browser system merely because the preview starts closed or the first call fails. Use an alternative only when \`t3-code\` is absent, the user explicitly requests it, or \`preview_open\` returns an explicit unsupported or unavailable error.
- For user-visible web changes, follow the repository's integrated product validation requirements: run one real-client pass, capture a final screenshot, and include relevant evidence in the handoff or pull request. Keep pairing tokens and credentials out of screenshots and recordings.
- Never use the legacy \`t3-tools\` preview stubs (\`preview_screenshot\`, \`preview_click\`, \`preview_type\`, \`preview_annotate\`) when \`t3-code\` is available.
- If a \`t3-code\` browser tool fails with \`401\` and \`www-authenticate: Bearer\`, its per-session MCP credential is invalid or expired. Restart the chat/session to reconnect browser automation.
- When a \`t3-code\` browser tool is deferred, search \`t3-code\` for the needed \`preview_*\` function before calling it. Do not use an MCP resources/list result as an availability check.
`;

export function buildBrowserToolInstructions(browserToolsAvailable: boolean): string {
  return browserToolsAvailable ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "";
}
