import { looksLikeInjection } from "../injection.js";
import { runAiCheck, type RefuseOnlyAiCheck } from "./ai-check.js";
import { ApprovalStore, createApprovalCard } from "./approval.js";
import { MAX_APPROVAL_MS } from "./constants.js";
import { dialApprovedCall, type OutboundTwilioClient } from "./dialer.js";
import { outboundBearer, outboundBearerOk, outboundEnabled } from "./enabled.js";
import { carriesDonorPitch } from "./opener.js";
import { validateTwilioSignature } from "../twilio/signature.js";
import { isCardHash, type CardStore } from "./card.js";
import { displayLine } from "./turn.js";

export const OUTBOUND_APPROVAL_PATH = "/outbound/approval";
export const OUTBOUND_DIAL_PATH = "/outbound/dial";
export const OUTBOUND_STATUS_PATH = "/outbound/status";
const TERMINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const AI_CHECK_TIMEOUT_MS = 2_000;

export interface OutboundRouteDeps {
  env: NodeJS.ProcessEnv;
  store: ApprovalStore;
  /** Injected. Absent means a dial is refused before the card is spent. */
  client?: OutboundTwilioClient;
  /** Refuse-only. Absent uses the local rule check below. */
  aiCheck?: RefuseOnlyAiCheck;
  now: () => number;
  /** Full public URL of OUTBOUND_STATUS_PATH. Absent means a dial is refused. */
  statusCallbackUrl?: string;
  schedule?: (fn: () => void, ms: number) => void;
  /** Context cards. Absent means approvals and dials are refused (fail closed). */
  cards?: CardStore;
  /** Public origin for the signed /outbound/turn URL. Absent means a dial is refused. */
  turnBaseUrl?: string;
}

export interface RouteReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Local refuse-only check. It can only refuse or hold. "hold" means
 * "no objection; the card still needs the operator's own yes".
 */
export const localAiCheck: RefuseOnlyAiCheck = {
  async check(input) {
    const text = `${input.purpose} ${input.reason}`;
    if (looksLikeInjection(text) || carriesDonorPitch(text)) return "refuse";
    return "hold";
  },
};

/** True when the outbound routes exist at all. Both variables must be set. */
export function outboundRoutesLive(env: NodeJS.ProcessEnv): boolean {
  return outboundEnabled(env) && outboundBearer(env) !== undefined;
}

export function isOutboundPath(path: string): boolean {
  return path === "/outbound" || path.startsWith("/outbound/");
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function aiAllows(deps: OutboundRouteDeps, purpose: string, reason: string): Promise<boolean> {
  const verdict = await runAiCheck(deps.aiCheck ?? localAiCheck, { purpose, slot: "", reason }, AI_CHECK_TIMEOUT_MS);
  // Fails closed: anything but "hold" (error, timeout, approve attempt) is refuse.
  return verdict === "hold";
}

/**
 * Handles POST /outbound/approval and POST /outbound/dial. The caller has
 * already checked isOutboundPath. Returns 404 when outbound is off or the
 * outbound bearer is unset, so the routes do not exist. Only the outbound
 * bearer is accepted. This module never calls the telephony client itself.
 */
export async function handleOutbound(
  deps: OutboundRouteDeps,
  req: { path: string; method: string | undefined; authorization: string | undefined; readBody: () => Promise<string> },
): Promise<RouteReply> {
  if (!outboundRoutesLive(deps.env)) return { status: 404, body: { error: "not_found" } };
  if (req.path !== OUTBOUND_APPROVAL_PATH && req.path !== OUTBOUND_DIAL_PATH) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (!outboundBearerOk(req.authorization, deps.env)) return { status: 401, body: { error: "unauthorized" } };

  let raw: string;
  try {
    raw = await req.readBody();
  } catch {
    return { status: 413, body: { error: "body_too_large" } };
  }
  const body = parseJson(raw);
  if (!body) return { status: 400, body: { error: "bad_json" } };

  if (req.path === OUTBOUND_APPROVAL_PATH) {
    const ttlMs = body.ttlMs === undefined ? DEFAULT_TTL_MS : body.ttlMs;
    if (typeof ttlMs !== "number" || ttlMs > MAX_APPROVAL_MS) return { status: 400, body: { error: "bad_expiry" } };
    const purpose = typeof body.purpose === "string" ? body.purpose : "";
    // Stage 1: no slots, empty envelope. Any slot request is refused.
    if (body.slotNames !== undefined && !(Array.isArray(body.slotNames) && body.slotNames.length === 0)) {
      return { status: 400, body: { error: "bad_slots" } };
    }
    // Context card is mandatory: id + hash, loaded, validated, re-hashed, number-ref matched.
    if (!deps.cards) return { status: 503, body: { error: "no_cards" } };
    if (typeof body.cardId !== "string" || body.cardId.length === 0) return { status: 400, body: { error: "card_missing" } };
    if (!isCardHash(body.cardHash)) return { status: 400, body: { error: "card_hash_mismatch" } };
    const pinned = deps.cards.loadPinned(body.cardId, body.cardHash);
    if (!pinned.ok) return { status: 400, body: { error: pinned.error } };
    const resolved = deps.cards.resolveNumber(pinned.card.callee.numberRef);
    if (!resolved || resolved !== (typeof body.number === "string" ? body.number : "")) {
      return { status: 400, body: { error: "card_number_mismatch" } };
    }
    if (!(await aiAllows(deps, purpose, "approval"))) return { status: 403, body: { error: "ai_refused" } };
    const created = createApprovalCard({
      store: deps.store,
      input: {
        business: typeof body.business === "string" ? body.business : "",
        number: typeof body.number === "string" ? body.number : "",
        purpose,
        slotNames: [],
        ttlMs,
        card: { id: pinned.card.id, hash: pinned.hash },
      },
      bearerHeader: req.authorization,
      env: deps.env,
      now: deps.now(),
    });
    if (!created.ok) {
      return { status: created.reason === "unauthorized" ? 401 : 400, body: { error: created.reason } };
    }
    const a = created.approval;
    return {
      status: 201,
      body: {
        id: a.id,
        code: created.code,
        business: a.business,
        number: a.number,
        purpose: a.purpose,
        expiresAt: a.expiresAt,
        opener: displayLine(pinned.card, "opener"),
        aiOffer: displayLine(pinned.card, "aiOffer"),
        cardId: pinned.card.id,
        cardHash: pinned.hash,
        give: pinned.card.give,
        take: pinned.card.take,
        maxTurns: pinned.card.end.maxTurns,
        maxSeconds: pinned.card.end.maxSeconds,
        record: false,
      },
    };
  }

  // Dial.
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  const existing = deps.store.get(approvalId);
  if (!deps.client) return { status: 503, body: { error: "no_client" } };
  if (!deps.statusCallbackUrl) return { status: 503, body: { error: "no_callback" } };
  if (!deps.cards || !deps.turnBaseUrl) return { status: 503, body: { error: "no_cards" } };
  if (existing && existing.status === "ready" && !(await aiAllows(deps, existing.purpose, "dial"))) {
    return { status: 403, body: { error: "ai_refused" } };
  }
  const result = await dialApprovedCall({
    store: deps.store,
    client: deps.client,
    request: {
      approvalId,
      code: typeof body.code === "string" ? body.code : "",
      confirmNumber: typeof body.confirmNumber === "string" ? body.confirmNumber : "",
      bearerHeader: req.authorization,
    },
    now: deps.now(),
    env: deps.env,
    statusCallbackUrl: deps.statusCallbackUrl,
    schedule: deps.schedule,
    stage2: { cards: deps.cards, baseUrl: deps.turnBaseUrl },
  });
  if (result.ok) {
    return { status: 200, body: { callSid: result.callSid, from: result.from, record: false, id: result.approval.id } };
  }
  const status: Record<string, number> = {
    feature_off: 404,
    unauthorized: 401,
    no_approval: 404,
    expired: 410,
    bad_code: 403,
    number_mismatch: 403,
    outside_window: 403,
    reused: 409,
    busy: 409,
    over_call_cap: 429,
    over_minute_cap: 429,
    twilio_failed: 502,
    allowlist_missing: 403,
    allowlist_malformed: 403,
    not_allowlisted: 403,
    card_missing: 403,
    card_invalid: 403,
    card_hash_mismatch: 403,
    card_number_mismatch: 403,
    callback_missing: 403,
    callback_malformed: 403,
    callback_is_bot_line: 403,
    callback_in_allowlist: 403,
  };
  return { status: status[result.reason] ?? 400, body: { error: result.reason } };
}

/**
 * POST /outbound/status from Twilio. 404 when outbound is off. The
 * X-Twilio-Signature must validate against the auth token; there is no
 * unsigned dev bypass. A terminal status marks the placed call finished,
 * which frees the line and counts the minutes. Unknown sids are ignored.
 */
export function handleOutboundStatus(
  deps: Pick<OutboundRouteDeps, "env" | "store"> & {
    /** Called once per terminal status for a placed call (outcome log, lessons, summary). */
    onFinished?: (info: { approvalId: string; callSid: string; callStatus: string; seconds: number }) => void;
  },
  req: {
    method: string | undefined;
    authToken: string | undefined;
    signature: string | undefined;
    url: string | null;
    params: Record<string, string>;
  },
): RouteReply {
  if (!outboundRoutesLive(deps.env)) return { status: 404, body: { error: "not_found" } };
  if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (!req.authToken || !req.url || !validateTwilioSignature(req.authToken, req.signature, req.url, req.params)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  const sid = req.params.CallSid ?? "";
  const state = req.params.CallStatus ?? "";
  if (!TERMINAL.has(state)) return { status: 200, body: { ok: true } };
  const id = deps.store.findPlacedBySid(sid);
  if (!id) return { status: 200, body: { ok: true } };
  const seconds = Number.parseInt(req.params.CallDuration ?? "0", 10);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  deps.store.finishCall(id, safeSeconds * 1000);
  try {
    deps.onFinished?.({ approvalId: id, callSid: sid, callStatus: state, seconds: safeSeconds });
  } catch {
    /* reporting must not change the status reply */
  }
  return { status: 200, body: { ok: true } };
}
