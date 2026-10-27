/**
 * Refuse-only check. The type has no approve arm. Tick boxes on the card
 * are the only release path, and stage 1 does not release anything.
 * The dialer does not consult this hook.
 */
export type AiCheckVerdict = "refuse" | "hold";

export interface AiCheckInput {
  purpose: string;
  slot: string;
  reason: string;
}

export interface RefuseOnlyAiCheck {
  check(input: AiCheckInput): Promise<AiCheckVerdict>;
}

function onlyRefuseOrHold(value: unknown): AiCheckVerdict {
  return value === "hold" ? "hold" : "refuse";
}

/**
 * Runs the hook. An error, a timeout, or any value other than hold
 * (including an approve attempt) is refuse.
 */
export async function runAiCheck(
  hook: RefuseOnlyAiCheck,
  input: AiCheckInput,
  timeoutMs: number,
): Promise<AiCheckVerdict> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return "refuse";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => hook.check(input))
        .then((value) => ({ kind: "value" as const, value }))
        .catch(() => ({ kind: "error" as const })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (outcome.kind !== "value") return "refuse";
    return onlyRefuseOrHold(outcome.value);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
