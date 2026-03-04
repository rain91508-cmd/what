// ============================================
// Session Manager - Save/Restore Session Feature
// ============================================

import type { Session, SessionInfo } from '../../types/session';
import { SESSION_VERSION } from '../../types/session';

const SESSIONS_KEY = 'hwda_sessions';
const SESSION_PREFIX = 'hwda_session_';

class SessionManager {
  /**
   * Get all session names and info
   */
  getAllSessions(): SessionInfo[] {
    try {
      const sessionsJson = localStorage.getItem(SESSIONS_KEY);
      if (!sessionsJson) return [];
      const sessions: SessionInfo[] = JSON.parse(sessionsJson);
      // Sort by updatedAt desc
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      console.error('[SessionManager] Failed to get sessions:', e);
      return [];
    }
  }

  /**
   * Get a session by name
   */
  getSession(name: string): Session | null {
    try {
      const sessionJson = localStorage.getItem(`${SESSION_PREFIX}${name}`);
      if (!sessionJson) return null;
      return JSON.parse(sessionJson);
    } catch (e) {
      console.error('[SessionManager] Failed to get session:', e);
      return null;
    }
  }

  /**
   * Save a session
   */
  saveSession(session: Session): void {
    try {
      // Save session data
      localStorage.setItem(`${SESSION_PREFIX}${session.name}`, JSON.stringify(session));

      // Update session list
      const sessions = this.getAllSessions();
      const existingIndex = sessions.findIndex(s => s.name === session.name);
      const sessionInfo: SessionInfo = {
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };

      if (existingIndex >= 0) {
        sessions[existingIndex] = sessionInfo;
      } else {
        sessions.push(sessionInfo);
      }

      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
      console.log('[SessionManager] Session saved:', session.name);
    } catch (e) {
      console.error('[SessionManager] Failed to save session:', e);
      throw e;
    }
  }

  /**
   * Delete a session
   */
  deleteSession(name: string): void {
    try {
      // Remove session data
      localStorage.removeItem(`${SESSION_PREFIX}${name}`);

      // Update session list
      const sessions = this.getAllSessions().filter(s => s.name !== name);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
      console.log('[SessionManager] Session deleted:', name);
    } catch (e) {
      console.error('[SessionManager] Failed to delete session:', e);
      throw e;
    }
  }

  /**
   * Check if session name exists
   */
  sessionExists(name: string): boolean {
    return localStorage.getItem(`${SESSION_PREFIX}${name}`) !== null;
  }

  /**
   * Migrate session if needed (for version compatibility)
   */
  migrateSession(session: Session): Session {
    if (session.version === SESSION_VERSION) {
      return session;
    }

    // Version migration logic here
    // For now, just update version
    return {
      ...session,
      version: SESSION_VERSION,
    };
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
