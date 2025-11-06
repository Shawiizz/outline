import { Next } from "koa";
import { Share, Document, User, Team } from "@server/models";
import { AppContext } from "@server/types";
import { AuthenticationError } from "@server/errors";
import auth from "./authentication";

/**
 * Middleware that allows either authenticated access or public editing via a valid share link.
 * This middleware tries authentication first, and if it fails, checks for a valid shareId
 * with allowPublicEdit enabled.
 */
export default function authOrPublicEdit() {
    const authMiddleware = auth({ optional: true });

    return async function authOrPublicEditMiddleware(ctx: AppContext, next: Next) {
        // Try normal authentication first
        await authMiddleware(ctx, async () => {
            // If user is authenticated, proceed normally
            if (ctx.state.auth?.user) {
                return next();
            }

            // No authenticated user, check for public edit access via shareId
            const shareId = ctx.request.body?.shareId || ctx.request.query?.shareId;

            if (!shareId) {
                throw AuthenticationError("Authentication or valid shareId required");
            }

            // Find the share
            const share = await Share.findOne({
                where: {
                    id: shareId,
                    published: true,
                    revokedAt: null,
                },
            });

            if (!share || !share.allowPublicEdit) {
                throw AuthenticationError("Invalid share or public editing not allowed");
            }

            // Verify the document being edited matches the share
            const documentId = ctx.request.body?.id;
            if (documentId && share.documentId) {
                if (documentId !== share.documentId) {
                    throw AuthenticationError("Document ID does not match share");
                }
            }

            // Create a pseudo-anonymous user context for authorization
            // We'll use the share to identify the team and provide minimal user info
            const document = await Document.findByPk(share.documentId!);
            if (!document) {
                throw AuthenticationError("Shared document not found");
            }

            const team = await Team.findByPk(document.teamId);
            if (!team) {
                throw AuthenticationError("Team not found");
            }

            // Create a minimal anonymous user representation
            // This user won't be saved to DB, it's just for the request context
            const anonymousUser = {
                id: `anonymous-${shareId}`,
                name: "Anonymous Editor",
                email: `anonymous-${shareId}@public.edit`,
                teamId: team.id,
                team,
                isAnonymous: true,
                shareId,
            } as unknown as User;

            ctx.state.auth = {
                user: anonymousUser,
                type: "public-edit" as any,
                token: shareId,
            };

            return next();
        });
    };
}
