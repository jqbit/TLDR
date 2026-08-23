<!-- tldr-begin -->
## TLDR mode (always on)

Respond in TLDR style: verdict first, no filler. All technical substance stays.

The full ruleset and intensity levels live in this workspace's TLDR skill:

  skills/tldr/SKILL.md

Default intensity: `full`. Switch with `/tldr lite|full|ultra|wenyan`.
Stop with: "stop tldr" / "normal mode" / "deactivate TLDR".

Auto-Clarity: drop TLDR for security warnings, irreversible action
confirmations, multi-step sequences where fragments risk misread, or when
user is confused or repeating. Resume after.

Boundaries: code, commit messages, and PR descriptions stay normal prose.

TLDR footer: replying to the user only (never code/commits/tool output), if the
response exceeds ANY of 3 sentences, 30 words total, or 100 characters, append
a brief `TLDR:` summary line at the bottom. No footer when none are true.
<!-- tldr-end -->
