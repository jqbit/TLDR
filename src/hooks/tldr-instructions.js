'use strict';

// Shared ruleset builder: reads skills/tldr/SKILL.md (the single source of
// truth) and filters it to one intensity level. Used by the SessionStart hook
// (tldr-activate.js) and the Pi extension, so the filter logic exists once.
//
// SKILL.md is resolved relative to this file: <root>/src/hooks/ -> <root>/skills/
// for a repo/plugin layout, and <dir>/hooks/tldr/ -> <dir>/skills/ for the
// per-agent installs bin/install.js writes. Standalone installs with no skills
// dir fall back to the embedded minimal ruleset below.

const fs = require('fs');
const path = require('path');

// Layouts this must satisfy:
//   <root>/src/hooks/            -> <root>/skills/          (repo + plugin)
//   <dir>/hooks/tldr/            -> <dir>/skills/           (native agent hooks)
//   <dir>/extensions/tldr/lib/   -> <dir>/skills/           (Pi extension)
// Anything else falls back to the embedded ruleset below.
const SKILL_CANDIDATES = [
  ['..', '..', 'skills', 'tldr', 'SKILL.md'],
  ['..', '..', '..', 'skills', 'tldr', 'SKILL.md'],
  ['..', 'skills', 'tldr', 'SKILL.md'],
];

function readSkill() {
  for (const rel of SKILL_CANDIDATES) {
    try { return fs.readFileSync(path.join(__dirname, ...rel), 'utf8'); }
    catch (e) { /* try next */ }
  }
  return '';
}

function getInstructions(mode) {
  // wenyan is an alias for wenyan-full
  const modeLabel = mode === 'wenyan' ? 'wenyan-full' : mode;

  let skillContent = readSkill();

  let output;

if (skillContent) {
  // Strip YAML frontmatter
  const body = skillContent.replace(/^---[\s\S]*?---\s*/, '');

  // Filter intensity table: keep header rows + only the active level's row
  const filtered = body.split('\n').reduce((acc, line) => {
    // Intensity table rows start with | **level** |
    const tableRowMatch = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (tableRowMatch) {
      // Keep only the active level's row (and always keep header/separator)
      if (tableRowMatch[1] === modeLabel) {
        acc.push(line);
      }
      return acc;
    }

    // Example lines start with "- level:" — keep only lines matching active level.
    // Restrict to actual intensity tokens so unrelated rule bullets like
    // "- Default: 1 sentence." are NOT mistaken for a level and dropped.
    const exampleMatch = line.match(/^- (lite|full|ultra|wenyan(?:-lite|-full|-ultra)?):\s/);
    if (exampleMatch) {
      if (exampleMatch[1] === modeLabel) {
        acc.push(line);
      }
      return acc;
    }

    acc.push(line);
    return acc;
  }, []);

  output = 'TLDR MODE ACTIVE — level: ' + modeLabel + '\n\n' + filtered.join('\n');
} else {
  // Fallback when SKILL.md is not found (standalone hook install without skills dir).
  // This is the minimum viable ruleset — better than nothing.
  output =
    'TLDR MODE ACTIVE — level: ' + modeLabel + '\n\n' +
    'Respond in TLDR style: verdict first, no filler. All technical substance stays.\n\n' +
    '## Persistence\n\n' +
    'ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. Off only: "stop tldr" / "normal mode".\n\n' +
    'Current level: **' + modeLabel + '**. Switch: `/tldr lite|full|ultra|wenyan`.\n\n' +
    '## Rules\n\n' +
    'Default: 1 sentence.\n' +
    'Default target: 3 words.\n' +
    'Default maximum: 6 words.\n\n' +
    'Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. ' +
    'Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.\n\n' +
    'Pattern: `[thing] [action] [reason]. [next step].`\n\n' +
    'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing is likely caused by..."\n' +
    'Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"\n\n' +
    '## Auto-Clarity\n\n' +
    'Drop TLDR for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user asks to clarify or repeats question. Resume TLDR after clear part done.\n\n' +
    '## Boundaries\n\n' +
    'Code/commits/PRs: write normal. "stop tldr" or "normal mode": revert. Level persist until changed or session end.';
}


  return output;
}

module.exports = { getInstructions };
