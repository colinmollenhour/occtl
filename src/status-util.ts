import type { OpencodeClient, Session } from "@opencode-ai/sdk";
import { listAllSessions } from "./client.js";

type SessionStatus = {
  type: string;
};

type SessionStatusMap = Record<string, SessionStatus | undefined>;

export type DerivedSessionStatus = {
  type: string;
  main: string;
  mainKnown: boolean;
  mainIdle: boolean;
  allIdle: boolean;
  children: string[];
  activeChildren: string[];
};

export function getRawSessionStatus(
  statuses: SessionStatusMap,
  sessionId: string
): string {
  return statuses[sessionId]?.type ?? "idle";
}

export function isRawIdle(statuses: SessionStatusMap, sessionId: string): boolean {
  return getRawSessionStatus(statuses, sessionId) === "idle";
}

export function deriveSessionStatus(
  sessionId: string,
  statuses: SessionStatusMap,
  sessions: Session[]
): DerivedSessionStatus {
  const main = getRawSessionStatus(statuses, sessionId);
  const mainKnown = !!statuses[sessionId];
  const children = getDescendantIds(sessionId, sessions);
  const activeChildren = children.filter((id) => !isRawIdle(statuses, id));
  const mainIdle = main === "idle";
  const allIdle = mainIdle && activeChildren.length === 0;

  return {
    type: mainIdle && activeChildren.length > 0 ? "waiting" : main,
    main,
    mainKnown,
    mainIdle,
    allIdle,
    children,
    activeChildren,
  };
}

export async function getDerivedSessionStatus(
  client: OpencodeClient,
  sessionId: string
): Promise<DerivedSessionStatus> {
  const [statusResult, sessions] = await Promise.all([
    client.session.status(),
    listAllSessions(client),
  ]);

  return deriveSessionStatus(sessionId, statusResult.data ?? {}, sessions);
}

function getDescendantIds(sessionId: string, sessions: Session[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID) ?? [];
    children.push(session.id);
    childrenByParent.set(session.parentID, children);
  }

  const descendants: string[] = [];
  const pending = [...(childrenByParent.get(sessionId) ?? [])];
  while (pending.length > 0) {
    const id = pending.shift()!;
    descendants.push(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}
