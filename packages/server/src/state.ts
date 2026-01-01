import type { Session, HookPayload, ServerMessage } from "./types.js";
import { SESSION_TIMEOUT_MS, USER_INPUT_TOOLS } from "./types.js";

type StateChangeCallback = (message: ServerMessage) => void;

class SessionState {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<StateChangeCallback> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval for stale sessions
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, 30_000); // Check every 30 seconds
  }

  subscribe(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    // Immediately send current state to new subscriber
    callback(this.getStateMessage());
    return () => this.listeners.delete(callback);
  }

  private broadcast(): void {
    const message = this.getStateMessage();
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private getStateMessage(): ServerMessage {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    const waitingForInput = sessions.filter(
      (s) => s.status === "waiting_for_input"
    ).length;
    return {
      type: "state",
      blocked: working === 0,
      sessions: sessions.length,
      working,
      waitingForInput,
    };
  }

  handleHook(payload: HookPayload): void {
    const { session_id, hook_event_name } = payload;

    switch (hook_event_name) {
      case "SessionStart":
        this.sessions.set(session_id, {
          id: session_id,
          status: "idle",
          lastActivity: new Date(),
          cwd: payload.cwd,
        });
        console.log(`[State] Session started: ${session_id}`);
        break;

      case "SessionEnd":
        this.sessions.delete(session_id);
        console.log(`[State] Session ended: ${session_id}`);
        break;

      case "UserPromptSubmit":
        this.ensureSession(session_id, payload.cwd);
        const promptSession = this.sessions.get(session_id)!;
        promptSession.status = "working";
        promptSession.lastActivity = new Date();
        console.log(`[State] Session working: ${session_id} (UserPromptSubmit)`);
        break;

      case "PreToolUse":
        this.ensureSession(session_id, payload.cwd);
        const toolSession = this.sessions.get(session_id)!;
        // Check if this is a user input tool
        if (payload.tool_name && USER_INPUT_TOOLS.includes(payload.tool_name)) {
          toolSession.status = "waiting_for_input";
          console.log(
            `[State] Session waiting for input: ${session_id} (${payload.tool_name})`
          );
        } else {
          toolSession.status = "working";
          console.log(
            `[State] Session working: ${session_id} (PreToolUse: ${payload.tool_name})`
          );
        }
        toolSession.lastActivity = new Date();
        break;

      case "Stop":
        this.ensureSession(session_id, payload.cwd);
        const idleSession = this.sessions.get(session_id)!;
        // Don't reset to idle if waiting for user input - preserve that state
        if (idleSession.status !== "waiting_for_input") {
          idleSession.status = "idle";
          console.log(`[State] Session idle: ${session_id}`);
        } else {
          console.log(`[State] Session still waiting for input: ${session_id}`);
        }
        idleSession.lastActivity = new Date();
        break;
    }

    this.broadcast();
  }

  private ensureSession(sessionId: string, cwd?: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        status: "idle",
        lastActivity: new Date(),
        cwd,
      });
      console.log(`[State] Session auto-registered: ${sessionId}`);
    }
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
        this.sessions.delete(id);
        removed++;
        console.log(`[State] Session timed out: ${id}`);
      }
    }

    if (removed > 0) {
      this.broadcast();
    }
  }

  getStatus(): { blocked: boolean; sessions: Session[] } {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    return {
      blocked: working === 0,
      sessions,
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.listeners.clear();
  }
}

export const state = new SessionState();
