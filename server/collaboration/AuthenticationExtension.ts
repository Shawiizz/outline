import { onAuthenticatePayload, Extension } from "@hocuspocus/server";
import { trace } from "@server/logging/tracing";
import Document from "@server/models/Document";
import Share from "@server/models/Share";
import Team from "@server/models/Team";
import { can } from "@server/policies";
import { getUserForJWT } from "@server/utils/jwt";
import { getOrCreateAnonymousUser } from "@server/utils/anonymous";
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

      // Get team for anonymous user creation
      const team = await Team.findByPk(document.teamId);
      if (!team) {
        throw AuthenticationError("Team not found");
      }

      // Get or create the default anonymous user in the database
      const anonymousUser = await getOrCreateAnonymousUser(token, team);

      // Generate a unique display name and color for this session
      const { name, color } = generateAnonymousName(token);

      // Return the real database user but with session-specific display info
      return {
        user: {
          ...anonymousUser.toJSON(),
          name, // Override display name for this session
          color, // Override color for this session
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
