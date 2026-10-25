// Fixed Spanish texts. Written for readers who do not know Paperclip: what
// happened, why, and who has to act, in short plain sentences.
import { excerpt, type Diagnosis, type WaitingOn } from "./rules.js";

export interface TaskRef {
  identifier: string | null;
  title: string;
  url: string | null;
}

export const marker = (kind: string, id: string) => `<!-- linear-sync:${kind}:${id} -->`;

export function taskUrl(paperclipUrl: string, identifier: string | null): string | null {
  if (!paperclipUrl || !identifier) return null;
  const prefix = identifier.split("-")[0];
  return `${paperclipUrl}/${prefix}/issues/${identifier}`;
}

const ref = (task: TaskRef) => {
  const id = task.identifier ?? "tarea sin identificador";
  return `${task.url ? `[${id}](${task.url})` : id} «${excerpt(task.title, 120)}»`;
};

export function formatUtc(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function waitingText(waitingOn: WaitingOn): string {
  switch (waitingOn.kind) {
    case "blockers":
      return `que terminen ${waitingOn.blockers.map((blocker) => blocker.identifier ?? "otra tarea").join(", ")}`;
    case "agent":
      return waitingOn.viaMention
        ? `una respuesta de la agente ${waitingOn.agentName}`
        : `una respuesta de la agente ${waitingOn.agentName} (la nombraron sin mencionarla, así que no se enteró)`;
    case "human":
      return "una respuesta de una persona";
    default:
      return "nada identificado: nadie sabe qué la desbloquea";
  }
}

const mentionLine = (mentionUrls: string[]) => (mentionUrls.length > 0 ? `\n\nHace falta que una persona lo mire: ${mentionUrls.join(" ")}` : "");

export function blockNotice(input: { task: TaskRef; diagnosis: Diagnosis; mentionUrls: string[]; episode: string }): string {
  const reason = input.diagnosis.reason ? `\n**Qué dijo la agente:** ${input.diagnosis.reason}` : "";
  return [
    `**Bloqueada en Paperclip:** ${ref(input.task)}`,
    `**Espera:** ${waitingText(input.diagnosis.waitingOn)}.${reason}`,
    `**Desde:** ${formatUtc(input.diagnosis.lastActivityAt)}`,
  ].join("\n") + mentionLine(input.mentionUrls) + `\n${marker("block", input.episode)}`;
}

export function unblockNotice(input: { task: TaskRef; episode: string }): string {
  return `**Desbloqueada:** ${ref(input.task)} sigue adelante en Paperclip.\n${marker("unblock", input.episode)}`;
}

export function stuckNotice(input: { task: TaskRef; diagnosis: Diagnosis; minutes: number; mentionUrls: string[]; episode: string }): string {
  return [
    `**Atascada en Paperclip:** ${ref(input.task)}`,
    `Lleva al menos ${input.minutes} min bloqueada y ninguna tarea la bloquea formalmente.`,
    `**Espera:** ${waitingText(input.diagnosis.waitingOn)}.`,
  ].join("\n") + mentionLine(input.mentionUrls) + `\n${marker("stuck", input.episode)}`;
}

export function resumedNotice(input: { task: TaskRef; cause: string; key: string }): string {
  return `**Reanudada automáticamente:** ${ref(input.task)}\n**Por qué:** ${input.cause}\n${marker("resumed", input.key)}`;
}

export function legacyLabelNotice(input: { blockedLabel: string; key: string }): string {
  return `Quito la etiqueta «${input.blockedLabel}»: en Paperclip no hay nada bloqueado en esta issue. Era un resto del sistema anterior. Si alguien la vuelve a poner a mano, no la tocaré.\n${marker("legacy-label", input.key)}`;
}

export function doneNotice(input: { roots: TaskRef[]; episode: string }): string {
  return `**Terminado en Paperclip:** ${input.roots.map(ref).join(", ")} ya está cerrado. Falta que una persona lo revise y cierre esta issue.\n${marker("done", input.episode)}`;
}

export function noTaskReply(input: { commentId: string }): string {
  return `Esta issue todavía no tiene una tarea en Paperclip, así que ninguna agente va a leer este comentario. Para que entre, ponla en Todo con la etiqueta «Ready for AI».\n${marker("no-task", input.commentId)}`;
}

export function replyToLinear(input: { agentName: string; task: TaskRef; body: string; key: string }): string {
  return `**Respuesta de ${input.agentName}** (${ref(input.task)}):\n\n${excerpt(input.body, 4000)}\n${marker("reply", input.key)}`;
}

// --- Comments written in Paperclip ---

export function relayToPaperclip(input: { authorName: string; linearIdentifier: string; linearUrl: string; body: string; fallback: boolean; commentId: string }): string {
  const who = input.fallback ? `${input.authorName} (escrito en Linear; aquí aparece con otra cuenta)` : input.authorName;
  return `**Comentario de ${who} en [${input.linearIdentifier}](${input.linearUrl}):**\n\n${input.body.trim()}\n\nResponde en este hilo: tu respuesta se copia a Linear.\n${marker("relay", input.commentId)}`;
}

export function resumeComment(input: { fix: TaskRef; key: string }): string {
  return `${ref(input.fix)} ya terminó, así que lo que bloqueaba esta tarea está resuelto. Comprueba el resultado y continúa.\n${marker("resume", input.key)}`;
}

export function handoffComment(input: { agentId: string; agentName: string; from: TaskRef; quote: string; key: string }): string {
  return `[${input.agentName}](agent://${input.agentId}): desde ${ref(input.from)} te devolvieron el trabajo, pero sin mencionarte, así que no te enteraste. Lo que escribieron: «${excerpt(input.quote, 400)}». Continúa con esta tarea.\n${marker("handoff", input.key)}`;
}
