"use client";
// "Completa los huecos": each "[Completa: …]" of the draft as a question; the answer replaces the gap word for word.
// No AI: the most useful thing a jury rewards (concrete dates, figures, places) comes from the user.
import { useState } from "react";
import type { ApplicationSection } from "@/contracts";
import { Button, Card } from "@/components/ui";
import { fillGap, listGaps } from "../reply";
import s from "./draft.module.css";

export function GapsCard({ sections, onSave }: { sections: ApplicationSection[]; onSave: (sections: ApplicationSection[]) => Promise<void> | void }) {
  const gaps = listGaps(sections);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!gaps.length) return null;
  const keyOf = (g: (typeof gaps)[number], i: number) => `${g.section}:${i}:${g.text}`;
  return (
    <Card>
      <h2>Completa los huecos ({gaps.length})</h2>
      <p className={s.note}>Lo que escribas sustituye al hueco tal cual. Lo que más puntúa es lo concreto: fechas, cifras, lugares, nombres.</p>
      {gaps.map((g, i) => {
        const k = keyOf(g, i);
        const value = answers[k] ?? "";
        const id = `gap-${i}`;
        return (
          <div key={k} className={s.gapRow}>
            <label htmlFor={id}>
              {sections[g.section].title}: <b>{g.label || "falta un dato"}</b>
            </label>
            <div className={s.gapInput}>
              <input id={id} value={value} maxLength={600} onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })} />
              <Button
                variant="ghost"
                disabled={!value.trim()}
                onClick={async () => {
                  await onSave(fillGap(sections, g, value));
                  setAnswers(({ [k]: _done, ...rest }) => rest);
                }}
              >
                Rellenar
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
