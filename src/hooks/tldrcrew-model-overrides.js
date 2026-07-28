#!/usr/bin/env node
// tldrcrew model overrides — patch installed agent frontmatter from env vars.
//
// Called by tldr-activate.js early in SessionStart so users can pin
// per-agent models without shadow-copying entire agent files.
//
// Env vars:
//   TLDRCREW_REVIEWER_MODEL     → agents/tldrcrew-reviewer.md
//   TLDRCREW_BUILDER_MODEL      → agents/tldrcrew-builder.md
//   TLDRCREW_INVESTIGATOR_MODEL → agents/tldrcrew-investigator.md
//
// Rules:
//   - Unset / blank → no-op.
//   - Values containing newlines or control characters → ignored.
//   - Existing `model:` line in frontmatter → replaced in-place.
//   - No `model:` line → inserted after `tools:` (or before closing `---`).
//   - File missing / outside expected layout → silent no-op.
//   - All filesystem errors → silent fail.

const fs = require('fs');
const path = require('path');

const AGENT_ENV_MAP = [
  { envVar: 'TLDRCREW_REVIEWER_MODEL',     file: path.join('agents', 'tldrcrew-reviewer.md') },
  { envVar: 'TLDRCREW_BUILDER_MODEL',      file: path.join('agents', 'tldrcrew-builder.md') },
  { envVar: 'TLDRCREW_INVESTIGATOR_MODEL', file: path.join('agents', 'tldrcrew-investigator.md') },
];

// Fallback root when CLAUDE_PLUGIN_ROOT is unset: parent of the hooks dir.
// Standalone installs put hooks at $CLAUDE_CONFIG_DIR/hooks/, so agent copies
// (when present) live at $CLAUDE_CONFIG_DIR/agents/. Callers should prefer
// process.env.CLAUDE_PLUGIN_ROOT — plugin installs run this hook from
// <plugin_root>/src/hooks/, where the parent dir holds no agents/.
// Patch the YAML frontmatter of `content` to set `model: <modelValue>`.
// Returns the patched string, or the original if no frontmatter or already identical.
// Rejects `modelValue` strings that contain newlines or control characters.
function patchFrontmatterModel(content, modelValue) {
  // Reject blank or unsafe model strings
  if (!modelValue || /[\x00-\x1f\x7f]/.test(modelValue)) return content;

  // Must begin with YAML frontmatter delimiter
  if (!content.startsWith('---')) return content;

  // Find the closing ---
  const closeIdx = content.indexOf('\n---', 3);
  if (closeIdx === -1) return content;

  const fmRaw = content.slice(0, closeIdx);           // opening --- through last fm line
  const after  = content.slice(closeIdx);             // \n--- onward (body)

  // Preserve original line ending so we don't create mixed CRLF/LF on Windows
  const nl = fmRaw.includes('\r\n') ? '\r\n' : '\n';

  const modelLine = 'model: ' + modelValue;
  const modelRe   = /^model:[ \t]*.*$/m;

  if (modelRe.test(fmRaw)) {
    // Replace existing model: line
    const patched = fmRaw.replace(modelRe, modelLine);
    if (patched === fmRaw) return content;            // already identical
    return patched + after;
  }

  // Insert after tools: line when present; else before closing ---
  const toolsMatch = fmRaw.match(/^tools:[ \t]*.*$/m);
  if (toolsMatch) {
    const toolsEnd = fmRaw.indexOf(toolsMatch[0]) + toolsMatch[0].length;
    return fmRaw.slice(0, toolsEnd) + nl + modelLine + fmRaw.slice(toolsEnd) + after;
  }

  // Append before closing delimiter
  return fmRaw + nl + modelLine + after;
}

// Apply all env-var overrides to agent files under `pluginRoot`.
// `env` defaults to process.env; pass an object in tests.
function applyOverrides(pluginRoot, env) {
  const envArg = env || process.env;
  for (const { envVar, file } of AGENT_ENV_MAP) {
    const raw = envArg[envVar];
    if (!raw || !raw.trim()) continue;

    const modelValue = raw.trim();
    if (/[\x00-\x1f\x7f]/.test(modelValue)) continue;

    const agentPath = path.join(pluginRoot, file);
    let content;
    try {
      content = fs.readFileSync(agentPath, 'utf8');
    } catch (e) {
      continue; // missing file or wrong layout → silent no-op
    }

    const patched = patchFrontmatterModel(content, modelValue);
    if (patched === content) continue;

    try {
      fs.writeFileSync(agentPath, patched, 'utf8');
    } catch (e) {
      // Silent fail — never block session start
    }
  }
}

module.exports = { patchFrontmatterModel, applyOverrides, AGENT_ENV_MAP };
