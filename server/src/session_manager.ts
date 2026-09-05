// Trinetra — Session Manager (Phase 9)
// In-memory store keyed by sessionId (Redis later). Persists conversation history + page state per extension client.

export interface SessionTurn {
  timestamp: string;
  sanitizedAT?: any[];
  sanitizedScreenshot?: string; // truncated log preview
  action?: any;
  reasoning?: string;
}

export interface Session {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
}

class SessionManager {
  private store: Map<string, Session> = new Map();

  createSession(sessionId: string): Session {
    const now = new Date().toISOString();
    const session: Session = { sessionId, createdAt: now, updatedAt: now, turns: [] };
    this.store.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.store.get(sessionId);
  }

  getOrCreate(sessionId: string): Session {
    let s = this.store.get(sessionId);
    if (!s) s = this.createSession(sessionId);
    return s;
  }

  addTurn(sessionId: string, turn: SessionTurn): Session {
    const session = this.getOrCreate(sessionId);
    session.turns.push(turn);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  getHistory(sessionId: string): SessionTurn[] {
    const s = this.store.get(sessionId);
    return s ? [...s.turns] : [];
  }

  clear(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  size(): number {
    return this.store.size;
  }

  // For testing/debugging
  allSessionIds(): string[] {
    return Array.from(this.store.keys());
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
