import { onAuthenticatePayload, Extension } from "@hocuspocus/server";
import { trace } from "@server/logging/tracing";
import Document from "@server/models/Document";
import Share from "@server/models/Share";
import { can } from "@server/policies";
import { getUserForJWT } from "@server/utils/jwt";
import { generateAnonymousName } from "@shared/utils/anonymousNames";
import { AuthenticationError } from "../errors";

@trace()
export default class AuthenticationExtension implements Extension {
  async onAuthenticate({
    connection,
    token,
    documentName,
  }: onAuthenticatePayload) {
    // allows for different entity types to use this multiplayer provider later
    const [, documentId] = documentName.split(".");

    if (!token) {
      throw AuthenticationError("Authentication required");
    }

    // Check if token is a shareId (UUID format)
    const isShareId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);

    if (isShareId) {
      // Handle public editing via share link
      const share = await Share.findOne({
        where: {
          id: token,
          documentId,
          published: true,
          revokedAt: null,
        },
      });

      if (!share) {
        throw AuthenticationError("Invalid share");
      }

      const document = await Document.findByPk(documentId);

      if (!document || !document.isActive) {
        throw AuthenticationError("Document not found or not active");
      }

      // Allow connection but set read-only based on allowPublicEdit
      connection.readOnly = !share.allowPublicEdit;

      // Generate a unique name and color for this anonymous session
      const { name, color } = generateAnonymousName(token);

      // Return a pseudo-user for anonymous editing/viewing
      return {
        user: {
          id: `anonymous-${token}`,
          name,
          color,
          isAnonymous: true,
        },
      };
    }

    // Normal JWT authentication flow
    const user = await getUserForJWT(token, ["session", "collaboration"]);

    if (user.isSuspended) {
      throw AuthenticationError("Account suspended");
    }

    const document = await Document.findByPk(documentId, {
      userId: user.id,
    });

    if (!can(user, "read", document)) {
      throw AuthenticationError("Authorization required");
    }

    // set document to read only for the current user, thus changes will not be
    // accepted and synced to other clients
    if (!can(user, "update", document)) {
      connection.readOnly = true;
    }

    return {
      user,
    };
  }
}
