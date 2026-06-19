/**
 * The shared visual vocabulary for gori's output: a small, restrained set of
 * semantic glyphs that read well in a terminal and parse cleanly as MCP
 * tool-response text. Kept in one module so every surface that prints status
 * (the formatters, the setup installer) draws from the same source and the
 * vocabulary cannot drift apart.
 */
export const DONE = "✓";
export const FAIL = "✗";
export const NEXT = "→";
export const ACTIVE = "●";
export const ALERT = "🆕";
export const WARN = "⚠";
