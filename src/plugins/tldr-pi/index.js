// TLDR — Pi Coding Agent extension.
//
// Pi has no JSON hook config; extensions are JS modules declared by a package's
// `pi.extensions` manifest entry. The injection point is `before_agent_start`,
// which may return `{ systemPrompt }` — that is how the ruleset reaches the
// model on every turn (Pi has no per-session system-prompt slot).
//
// Everything else is shared with the hook stack: tldr-config.js owns the mode
// flag and tldr-instructions.js owns the SKILL.md filtering, so this file adds
// no ruleset text of its own.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Installed layout: <dir>/extensions/tldr/{index.js,lib/}. Pi treats a global
// `hooks/` dir as a legacy extensions dir and warns on every start, so the
// shared modules ship inside the extension instead.
// Repo layout: src/plugins/tldr-pi/index.js alongside src/hooks/.
function loadShared(name) {
  for (const rel of [join('lib', name), join('..', '..', 'hooks', name)]) {
    try { return require(join(here, rel)); } catch (e) { /* try next */ }
  }
  return null;
}

const config = loadShared('tldr-config.js');
const instructions = loadShared('tldr-instructions.js');

const VALID = new Set(config ? config.VALID_MODES : ['lite', 'full', 'ultra', 'wenyan']);
const DEACTIVATE = /^\s*(stop tldr|normal mode|deactivate tldr)\s*$/i;

export default function tldrExtension(pi) {
  // Pi keeps one process per session, so module state is session state.
  let mode = config ? config.getDefaultMode() : 'full';

  const flagPath = () => {
    const dir = process.env.TLDR_CONFIG_DIR || join(here, '..', '..');
    return join(dir, '.tldr-active');
  };

  function persist(next) {
    mode = next;
    // Best-effort: the statusline and other agents read this flag. A failure to
    // write must never break the session.
    try {
      if (next === 'off') return;
      if (config && config.safeWriteFlag) config.safeWriteFlag(flagPath(), next);
    } catch (e) { /* non-fatal */ }
  }

  pi.registerCommand('tldr', {
    description: 'Set TLDR mode: lite|full|ultra|wenyan|off (no arg = full)',
    handler: async (args, ctx) => {
      const arg = String(args || '').trim().toLowerCase();
      if (arg === 'status') {
        ctx?.ui?.notify?.(`TLDR: ${mode}`, 'info');
        return;
      }
      const next = arg === '' ? 'full' : arg;
      if (next !== 'off' && !VALID.has(next)) {
        ctx?.ui?.notify?.(`TLDR: unknown mode "${next}"`, 'error');
        return;
      }
      persist(next);
      ctx?.ui?.notify?.(next === 'off' ? 'TLDR off' : `TLDR: ${next}`, 'info');
    },
  });

  // Natural-language deactivation, matching the other agents' mode tracker.
  pi.on('input', async (event) => {
    if (event?.source === 'extension') return;
    if (mode !== 'off' && DEACTIVATE.test(String(event?.text || ''))) persist('off');
  });

  pi.on('session_start', async (_event, ctx) => {
    mode = config ? config.getDefaultMode() : 'full';
    if (mode !== 'off') ctx?.ui?.notify?.(`TLDR loaded: ${mode}`, 'info');
  });

  // The actual injection. Append so we never clobber Pi's own system prompt.
  pi.on('before_agent_start', async (event) => {
    if (!mode || mode === 'off' || !instructions) return;
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : '';
    return { systemPrompt: `${base}${instructions.getInstructions(mode)}` };
  });
}
