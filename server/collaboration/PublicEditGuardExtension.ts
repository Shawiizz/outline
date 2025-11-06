import {
  Extension,
  onChangePayload,
  onAuthenticatePayload
} from "@hocuspocus/server";
import { trace } from "@server/logging/tracing";
import Logger from "@server/logging/Logger";
import Share from "@server/models/Share";

/**
 * Extension that monitors and enforces public editing permissions.
 * When allowPublicEdit is disabled on a share, this extension will:
 * - Broadcast permission changes via awareness to all anonymous users
 * - Set anonymous connections to read-only mode
 * - Keep connections alive to allow real-time permission updates
 */
@trace()
export default class PublicEditGuardExtension implements Extension {
  /**
   * Store for tracking share permissions by document
   */
  private sharePermissions = new Map<string, boolean>();

  /**
   * Check if a connection is anonymous (using shareId as token)
   */
  private isAnonymousConnection(connection: any): boolean {
    return connection.context?.user?.isAnonymous === true;
  }

  /**
   * Required by Extension interface but not used in this extension.
   * Permission checks are done via forcePermissionCheck() which is called externally.
   */
  async onAuthenticate(_data: onAuthenticatePayload) {
    // No-op: permissions are checked on-demand via forcePermissionCheck
  }

  /**
   * Broadcast permission change to all connections on a document
   * Sends a custom message to each WebSocket connection
   */
  private broadcastPermissionChange(
    hocuspocusDocument: any,
    allowPublicEdit: boolean
  ): void {
    try {
      const connections = Array.from(hocuspocusDocument.getConnections());

      const message = JSON.stringify({
        type: 'outline-permission-change',
        allowPublicEdit,
        timestamp: Date.now(),
      });

      connections.forEach((connection: any) => {
        try {
          if (connection.webSocket && connection.webSocket.readyState === 1) {
            connection.webSocket.send(message);
          }
        } catch (error) {
          Logger.error("Failed to send permission change to connection", error);
        }
      });

      Logger.info(
        "multiplayer",
        `Broadcasted permission change (allowPublicEdit: ${allowPublicEdit}) to ${connections.length} connection(s)`,
        { allowPublicEdit, connectionCount: connections.length }
      );
    } catch (error) {
      Logger.error("Failed to broadcast permission change", error);
    }
  }

  /**
   * Set anonymous connections to read-only or read-write mode
   * @param readOnly - true for read-only, false for read-write
   */
  private setAnonymousConnectionsMode(
    documentId: string,
    hocuspocusDocument: any,
    readOnly: boolean
  ): void {
    const connections = Array.from(hocuspocusDocument.getConnections());
    let updatedCount = 0;

    connections.forEach((connection: any) => {
      if (this.isAnonymousConnection(connection)) {
        connection.readOnly = readOnly;

        // Clear awareness state for read-only users so they don't appear in collaborators
        if (readOnly && connection.awareness) {
          connection.awareness.setLocalState(null);
        }

        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      const mode = readOnly ? "read-only" : "read-write";
      Logger.info(
        "multiplayer",
        `Set ${updatedCount} anonymous connection(s) to ${mode} for document ${documentId}`,
        { documentId, count: updatedCount, mode }
      );
    }
  }

  /**
   * Force a permission check for a specific document.
   * This should be called when a share's allowPublicEdit status changes.
   */
  async forcePermissionCheck(
    documentId: string,
    hocuspocusServer: any,
    allowPublicEdit?: boolean
  ): Promise<void> {
    const hocuspocusDocument = hocuspocusServer.documents.get(`document.${documentId}`);

    if (!hocuspocusDocument) {
      Logger.warn(`Hocuspocus document not found for ${documentId}`);
      return;
    }

    // If allowPublicEdit is provided, use it directly
    // Otherwise, query the database
    let allowsPublicEdit: boolean;
    if (allowPublicEdit !== undefined) {
      allowsPublicEdit = allowPublicEdit;
    } else {
      const shares = await Share.findAll({
        where: {
          documentId,
          published: true,
          revokedAt: null,
        },
      });
      allowsPublicEdit = shares.some(share => share.allowPublicEdit);
    }

    this.sharePermissions.set(documentId, allowsPublicEdit);

    this.broadcastPermissionChange(hocuspocusDocument, allowsPublicEdit);

    // Set anonymous connections to read-write if allowed, read-only otherwise
    this.setAnonymousConnectionsMode(documentId, hocuspocusDocument, !allowsPublicEdit);
  }
}
