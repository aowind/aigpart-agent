import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from '../llm/types.js';

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  meta: SessionMeta;
  messages: ChatMessage[];
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSession(cwd: string, model: string, title: string): Session {
  const now = new Date().toISOString();
  return {
    meta: { id: newSessionId(), cwd, model, title, createdAt: now, updatedAt: now },
    messages: [],
  };
}

export function loadSession(dir: string, id: string): Session | null {
  try {
    const p = path.join(dir, `${id}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && raw.meta && Array.isArray(raw.messages)) return raw as Session;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(dir: string, session: Session): void {
  session.meta.updatedAt = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${session.meta.id}.json`),
    JSON.stringify(session, null, 2),
    'utf8',
  );
}

export function listSessions(dir: string): SessionMeta[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return s?.meta as SessionMeta;
        } catch {
          return null;
        }
      })
      .filter((m): m is SessionMeta => Boolean(m?.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}
