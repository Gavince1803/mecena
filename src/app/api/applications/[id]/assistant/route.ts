// "Copiar para tu asistente": GET ?task=draft|jury -> { text }, the prompt for the user's own chat assistant (no AI
// spent here). Only the owner's applications.
import { assistantPrompt } from "@/features/drafting/assistant";
import { ownedApplication, requireUser } from "@/server/auth";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const app = ownedApplication(requireUser(req).id, (await params).id);
  const task = new URL(req.url).searchParams.get("task") === "jury" ? "jury" : "draft";
  return json({ text: assistantPrompt(app.id, task) });
});
