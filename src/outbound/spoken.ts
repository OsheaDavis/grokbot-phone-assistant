/** Display name -> spoken name. Generic copy: the spoken form is plain "Owner"; change it here if your name needs a phonetic spelling. */
export function spokenName(text: string): string {
  return text.replace(/\b(?:Owner)(['\u2019]s)?\b/gi, (_m, poss: string | undefined) =>
    poss ? "Owner's" : "Owner",
  );
}
