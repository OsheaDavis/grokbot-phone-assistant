import { toSkeleton } from "./skeleton.js";

const PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions?|prompts?|rules?)/i,
  /disregard (your |the )?(instructions?|rules?|prompts?)/i,
  // Up to twelve filler words may sit between the verb and the target.
  // The skeleton has already turned commas, possessives, and marks into plain words.
  /\b(?:ignore|disregard|forget)\b(?:\s+\w+){0,12}\s+(?:instructions?|rules?|prompts?)\b/i,
  /system prompt/i,
  /you are now/i,
  /jailbreak/i,
  /developer mode/i,
  /reveal (your )?(instructions?|prompts?|secret)/i,
  /override (your )?(instructions?|rules?)/i,
  /forget (all |everything )?(you were told|your instructions?)/i,
  /pretend (you are|to be|you're|youre)/i,
  /what are your (instructions?|rules?|prompts?)/i,
  /repeat (your |the )?(instructions?|prompts?|rules?)/i,
  /\bread(?: me)? (?:your |the )?(?:contact list|contacts|known people)\b/i,
  /\b(?:is|are) .+ on (?:your|the) list\b/i,
  /\bwho do you know\b/i,
];

function matches(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Hyphens and intra-word dots are removed by the normalizer, so a phrase can
 * land as one token. The spaced patterns still run. This catches the joined form.
 */
function matchesCompact(skeleton: string): boolean {
  const compact = skeleton.replace(/ /g, "");
  if (!compact) return false;
  const patterns = [
    /(ignore|disregard|forget).{0,60}(instructions?|rules?|prompts?)/,
    /systemprompt/,
    /youarenow/,
    /jailbreak/,
    /developermode/,
    /reveal(?:your)?(instructions?|prompts?|secret)/,
    /override(?:your)?(instructions?|rules?)/,
    /forget(?:all|everything)?(?:youweretold|yourinstructions?)/,
    /pretend(?:youare|tobe|youre)/,
    /whatareyour(instructions?|rules?|prompts?)/,
    /repeat(?:your|the)?(instructions?|prompts?|rules?)/,
    /read(?:me)?(?:your|the)?(?:contactlist|contacts|knownpeople)/,
    /whodoyouknow/,
  ];
  return patterns.some((pattern) => pattern.test(compact));
}

/** Raw text and the shared normalizer, so punctuation and confusables cannot hide a phrase. */
export function looksLikeInjection(text: string): boolean {
  if (matches(text)) return true;
  const skeleton = toSkeleton(text);
  if (matches(skeleton)) return true;
  return matchesCompact(skeleton);
}
