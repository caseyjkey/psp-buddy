/**
 * Creature sprite atlas names.
 *
 * WHY THIS FILE EXISTS: the PocketJS cooker discovers sprite atlases by
 * scanning app modules for LITERAL strings that look like asset paths
 * (`tools/build.ts`: `classStrings.filter(s => /^[\w./-]+\.(?:png|svg)$/i)`).
 * A computed name like `sprite={`${base}.png`}` is a template literal, so
 * the scanner never sees it and the atlas is NOT baked into the pak -- the
 * sprite silently renders as nothing.
 *
 * The gallery solves the same problem with `apps/gallery/tiles.ts`: a plain
 * (not `*.generated.ts`) module holding full string literals.
 *
 * So every atlas name must appear as a literal HERE, and the runtime looks
 * the name up rather than building it.
 */

export const CREATURE_SPRITES = {
  fish: "fish.png",
  fishSleep: "fish-sleep.png",
  jellyfish: "jellyfish.png",
  jellyfishSleep: "jellyfish-sleep.png",
  butterfly: "butterfly.png",
  butterflySleep: "butterfly-sleep.png",
  crab: "crab.png",
  crabSleep: "crab-sleep.png",
  snail: "snail.png",
  snailSleep: "snail-sleep.png",
} as const;

/** Provider-colored contour atlases. They sit behind the original art, so
 * the creature keeps its existing RGB stipple while its silhouette carries
 * the same identity color as the status-bar dot. */
export const CREATURE_OUTLINES = {
  codex: {
    normal: "outline-codex-fish.png",
    sleeping: "outline-codex-fish-sleep.png",
  },
  minimax: {
    normal: "outline-minimax-jellyfish.png",
    sleeping: "outline-minimax-jellyfish-sleep.png",
  },
  muse: {
    normal: "outline-muse-crab.png",
    sleeping: "outline-muse-crab-sleep.png",
  },
  meta: {
    normal: "outline-meta-snail.png",
    sleeping: "outline-meta-snail-sleep.png",
  },
  "opencode-go": {
    normal: "outline-opencode-go-crab.png",
    sleeping: "outline-opencode-go-crab-sleep.png",
  },
} as const;

export type CreatureSpriteKey = keyof typeof CREATURE_SPRITES;

export type CreatureOutlineKey = keyof typeof CREATURE_OUTLINES;

/** All atlas names, for the cooker's literal scan. */
export const CREATURE_SPRITE_NAMES: string[] = Object.values(CREATURE_SPRITES);
