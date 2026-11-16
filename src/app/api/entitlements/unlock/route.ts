// POST { callId } -> spend one Solicitud premium credit on this call (Pro or an already unlocked call: nothing spent).
// 402 without a credit. Always the signed-in user's own entitlement; the call must exist.
import { z } from "zod";
import { unlockCall } from "@/features/purchases/server";
import { requireUser } from "@/server/auth";
import { body, json, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { getCall } from "@/server/store";

export const dynamic = "force-dynamic";

const UnlockRequest = z.object({ callId: z.string().min(1).max(200) });

export const POST = route(
  idempotent(async (req: Request) => {
    const user = requireUser(req);
    const { callId } = await body(req, UnlockRequest);
    getCall(callId); // unknown call: 404, nothing spent
    return json({ entitlement: await unlockCall(user.appUserId, callId) });
  }),
);
