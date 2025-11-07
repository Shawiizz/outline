import { User, Team } from "@server/models";
import { UserRole } from "@shared/types";

// Fixed UUID for the default anonymous user (randomly generated UUID v4)
const DEFAULT_ANONYMOUS_USER_ID = "a0e7e0e0-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

/**
 * Get or create the default anonymous user.
 * This single user is used for all anonymous editing sessions.
 * Individual sessions are still tracked separately via their shareId in the collaboration system.
 */
export async function getOrCreateAnonymousUser(
    shareId: string,
    team: Team
): Promise<User> {
    // Try to find existing default anonymous user
    let user = await User.findByPk(DEFAULT_ANONYMOUS_USER_ID);

    if (user) {
        return user;
    }

    // Create default anonymous user
    user = await User.create({
        id: DEFAULT_ANONYMOUS_USER_ID,
        name: "Anonymous User",
        email: `anonymous@anonymous.local`,
        color: "#9E9E9E",
        teamId: team.id,
        isAnonymous: true,
        role: UserRole.Viewer,
    });

    return user;
}

/**
 * Check if a user is anonymous
 */
export function isAnonymousUser(user: User | null | undefined): boolean {
    return user?.isAnonymous === true;
}
