"use client";
// "Mejóralo con tu asistente" (draft) / "Pásalo con tu asistente" (jury): a prompt to copy into whatever chat the user
// uses, and, for the draft, a box to paste the answer back. Mecena spends no AI here: the user's assistant does the work.
import Link from "next/link";
import { useEffect, useState } from "react";
import { API, ROUTES, type ApplicationSection } from "@/contracts";
import { Button, Card } from "@/components/ui";
import { apiGet } from "@/lib/api-client";
import { parseAssistantReply } from "../reply";
import s from "./draft.module.css";

interface Props {
  applicationId: string;
  task: "draft" | "jury";
  /** Changes when the draft changes, so the copied text is the current one. */
  version: number;
  /** Draft only: the current sections and how to save the ones pasted back. */
  sections?: ApplicationSection[];
  onApply?: (sections: ApplicationSection[]) => Promise<void> | void;
  /** Why the card is here (e.g. "the server has no AI"); a default line otherwise. */
  intro?: string;
}

export function AssistantCard({ applicationId, task, version, sections, onApply, intro }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [preview, setPreview] = useState<{ sections: ApplicationSection[]; matched: string[]; unmatched: string[] } | null>(null);

  // Fetched ahead of the tap: some browsers only let a page write to the clipboard right inside the tap itself.
  useEffect(() => {
    let live = true;
    apiGet<{ text: string }>(API.applicationAssistant(applicationId, task))
      .then((r) => live && setText(r.text))
      .catch(() => live && setError("No hemos podido preparar el texto. Recarga la página."));
    return () => {
      live = false;
    };
  }, [applicationId, task, version]);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setManual(true); // no clipboard access: show the text to select and copy by hand
    }
  };

  const review = () => {
    if (!sections) return;
    const r = parseAssistantReply(reply, sections);
    if ("error" in r) {
      setPreview(null);
      setError(r.error);
      return;
    }
    setError(null);
    setPreview(r);
  };

  const apply = async () => {
    if (!preview || !onApply) return;
    await onApply(preview.sections);
    setPreview(null);
    setReply("");
  };

  const draft = task === "draft";
  return (
    <Card>
      <h2>{draft ? "Mejóralo con tu asistente" : "Pásalo con tu asistente"}</h2>
      <p className={s.note}>
        {intro ??
          (draft
            ? "Copia este texto y pégalo en el asistente que uses (ChatGPT, Gemini, Claude, Le Chat…, también en su plan gratis). Lleva las reglas de Mecena, las bases, tus palabras y tu borrador. Luego pega aquí su respuesta."
            : "Copia este texto y pégalo en el asistente que uses (ChatGPT, Gemini, Claude, Le Chat…, también en su plan gratis). Lleva los criterios de las bases, los tres jueces y tu solicitud; te dirá la puntuación y qué mejorar.")}
      </p>
      <div className={s.assistantRow}>
        <Button onClick={copy} disabled={!text}>
          {copied ? "Copiado" : "Copiar para tu asistente"}
        </Button>
        <Link href={ROUTES.account} className="btn btn-quiet">
          Conectar Claude u otro asistente (MCP)
        </Link>
      </div>
      <p className={s.note}>El texto incluye tu perfil y tus palabras: pégalo solo en un asistente de tu confianza.</p>
      {manual && text && <textarea className={s.edit} readOnly value={text} aria-label="Texto para tu asistente" onFocus={(e) => e.currentTarget.select()} />}

      {draft && sections && onApply && (
        <details className={s.sources}>
          <summary>Pegar la respuesta de tu asistente</summary>
          <textarea
            className={`${s.edit} ${s.paste}`}
            value={reply}
            aria-label="Respuesta de tu asistente"
            placeholder="## Memoria del proyecto&#10;…"
            onChange={(e) => {
              setReply(e.target.value);
              setPreview(null);
            }}
          />
          <div className={s.assistantRow}>
            <Button variant="ghost" onClick={review} disabled={!reply.trim()}>
              Revisar
            </Button>
            {preview && <Button onClick={apply}>Guardar en la solicitud</Button>}
          </div>
          {preview && (
            <p className={s.note} role="status">
              Se cambiarán: {preview.matched.join(", ")}.{preview.unmatched.length ? ` No reconozco y dejo fuera: ${preview.unmatched.join(", ")}.` : ""} Revisa el resultado: tienes la última palabra.
            </p>
          )}
        </details>
      )}
      {error && <p className={s.error}>{error}</p>}
    </Card>
  );
}
