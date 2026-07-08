import type { PermissionV2Reply, PermissionV2Request } from "@opencode-ai/sdk/v2";
import { getClientV2 } from "./client.js";

export type PermissionResponse = PermissionV2Reply;

export type PendingPermission = {
  id: string;
  title: string;
  type: string;
};

export async function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: PermissionResponse
): Promise<void> {
  await getClientV2().v2.session.permission.reply({
    sessionID: sessionId,
    requestID: permissionId,
    reply: response,
  });
}

export async function listPendingPermissions(
  sessionId: string
): Promise<PendingPermission[]> {
  const result = await getClientV2().v2.session.permission.list({
    sessionID: sessionId,
  });
  return (result.data?.data ?? []).map((request: PermissionV2Request) => ({
    id: request.id,
    title: request.action,
    type: request.resources?.join(", ") || "permission",
  }));
}

export function getPermissionFromEvent(
  event: { type: string; properties: unknown },
  sessionId: string
): PendingPermission | undefined {
  if (event.type === "permission.v2.asked") {
    const props = event.properties as {
      id: string;
      action: string;
      resources?: string[];
      sessionID?: string;
    };
    if (props.sessionID && props.sessionID !== sessionId) return undefined;
    return {
      id: props.id,
      title: props.action,
      type: props.resources?.join(", ") || "permission",
    };
  }

  if (event.type === "permission.asked") {
    const props = event.properties as {
      id: string;
      permission: string;
      patterns?: string[];
      sessionID?: string;
    };
    if (props.sessionID && props.sessionID !== sessionId) return undefined;
    return {
      id: props.id,
      title: props.permission,
      type: props.patterns?.join(", ") || "permission",
    };
  }

  if (event.type === "permission.updated") {
    const props = event.properties as {
      id: string;
      title: string;
      type: string;
      status?: string;
      sessionID?: string;
    };
    if (props.sessionID && props.sessionID !== sessionId) return undefined;
    if (props.status && props.status !== "pending") return undefined;
    return {
      id: props.id,
      title: props.title,
      type: props.type,
    };
  }

  return undefined;
}
