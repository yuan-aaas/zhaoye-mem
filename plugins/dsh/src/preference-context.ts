import { explicitPreference } from '@zhaoye/app';
import type { BackupObservation, PreferenceEvidence } from '@zhaoye/contracts';
import type { DshSession, SessionEvent } from './api.js';
import { assistantPreset } from './api.js';

function evidenceOf(sessionId: string, event: SessionEvent): PreferenceEvidence | null {
  const content = event.data.content;
  const message = content?.[0];
  if (
    event.type !== 'user/message' ||
    event.data.source?.kind !== 'user' ||
    event.data.role !== 'user' ||
    content?.length !== 1 ||
    message?.type !== 'text' ||
    !message.text?.trim() ||
    message.text.length > 4000
  )
    return null;
  const at = new Date(event.time ?? Date.now());
  if (!Number.isFinite(at.getTime())) return null;
  return {
    id: `dsh:${sessionId}:${event.data.id ?? event.seq}`,
    text: message.text,
    at: at.toISOString(),
  };
}

export function userEvidence(session: DshSession, ended = false): PreferenceEvidence | null {
  const events = session.snapshotEvents();
  if (ended) {
    const selected = events.findLast((event) => event.type === 'agent-preset/selected');
    if ((selected?.data.agentPreset ?? session.header.agentPreset) !== assistantPreset) return null;
  }
  const end = ended && events.at(-1)?.type === 'turn/end' ? events.length - 1 : events.length;
  for (let i = end - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === 'turn/start' || event.type === 'turn/end') return null;
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
    return evidenceOf(session.id, event);
  }
  return null;
}

export async function verifyDistilledPreference(
  row: BackupObservation,
  readEvents: (id: string) => Promise<readonly SessionEvent[]>,
) {
  const text = row.content?.body.trim();
  const source =
    typeof row.metadata.source === 'string'
      ? /^session:([a-zA-Z0-9_-]{1,200})$/.exec(row.metadata.source)?.[1]
      : undefined;
  if (!source || !text || !explicitPreference(text) || !row.sourceUpdatedAt) return null;
  const latestTime = Date.parse(row.sourceUpdatedAt);
  const events = await readEvents(source);
  for (let i = events.length - 1; i >= 0 && i >= events.length - 3000; i--) {
    const event = events[i];
    if (!event || event.time === undefined) continue;
    const evidence = evidenceOf(source, event);
    if (evidence && evidence.text.trim() === text && Date.parse(evidence.at) <= latestTime)
      return evidence;
  }
  return null;
}
