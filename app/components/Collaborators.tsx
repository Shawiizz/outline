import filter from "lodash/filter";
import isEqual from "lodash/isEqual";
import orderBy from "lodash/orderBy";
import uniq from "lodash/uniq";
import { observer } from "mobx-react";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Document from "~/models/Document";
import { Avatar, AvatarSize, AvatarWithPresence, AvatarWrapper } from "~/components/Avatar";
import DocumentViews from "~/components/DocumentViews";
import Facepile from "~/components/Facepile";
import NudeButton from "~/components/NudeButton";
import Tooltip from "~/components/Tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "~/components/primitives/Popover";
import useCurrentUser from "~/hooks/useCurrentUser";
import useStores from "~/hooks/useStores";
import { isAnonymousUserId } from "@shared/utils/anonymousNames";

type Props = {
  /** The document to display live collaborators for */
  document: Document;
  /** Optional shareId for anonymous user identification */
  shareId?: string | null;
  /** The maximum number of collaborators to display, defaults to 6 */
  limit?: number;
};

/**
 * Displays a list of live collaborators for a document, including their avatars
 * and presence status.
 */
function Collaborators(props: Props) {
  const { limit = 6, shareId } = props;
  const { t } = useTranslation();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const currentUserId = user?.id;
  const [requestedUserIds, setRequestedUserIds] = useState<string[]>([]);
  const { users, presence, ui } = useStores();
  const { document } = props;
  const { observingUserId } = ui;
  const documentPresence = presence.get(document.id);

  // Get current anonymous user ID from the document's shareId if user is not logged in
  const currentAnonymousId = useMemo(() => {
    if (currentUserId) return null;
    return shareId ? `anonymous-${shareId}` : null;
  }, [currentUserId, shareId]);
  // Don't use useMemo here - let MobX track changes to the Map contents
  const documentPresenceArray = documentPresence
    ? Array.from(documentPresence.values())
    : [];

  // Use Set for O(1) lookups and stable references
  const presentIds = useMemo(
    () => new Set(documentPresenceArray.map((p) => p.userId)),
    [documentPresenceArray]
  );
  const editingIds = useMemo(
    () =>
      new Set(
        documentPresenceArray.filter((p) => p.isEditing).map((p) => p.userId)
      ),
    [documentPresenceArray]
  );

  // Get anonymous users present with their names and colors, sorted with current user first
  const anonymousUsers = useMemo(() => {
    const anons = documentPresenceArray
      .filter(p => isAnonymousUserId(p.userId))
      .map(p => ({
        id: p.userId,
        name: p.userName || t("Anonymous Editor"),
        avatarUrl: null,
        color: p.userColor || "#95a5a6",
        initial: (p.userName || "?").charAt(0),
        isEditing: p.isEditing,
      }));

    // Sort with current anonymous user first
    return anons.sort((a, b) => {
      if (a.id === currentAnonymousId) return -1;
      if (b.id === currentAnonymousId) return 1;
      return 0;
    });
  }, [documentPresenceArray, t, currentAnonymousId]);

  // ensure currently present via websocket are always ordered first
  // Memoize collaboratorIds as a Set for efficient lookup
  const collaboratorIdsSet = useMemo(
    () => new Set(document.collaboratorIds),
    [document.collaboratorIds]
  );
  const collaborators = useMemo(
    () =>
      orderBy(
        filter(
          users.all,
          (u) =>
            (presentIds.has(u.id) || collaboratorIdsSet.has(u.id)) &&
            !u.isSuspended
        ),
        [
          (u) => u.id !== currentUserId, // Current user first (false sorts before true)
          (u) => !presentIds.has(u.id),   // Then present users
          "id"                             // Then by ID
        ],
        ["asc", "asc", "asc"]
      ),
    [collaboratorIdsSet, users.all, presentIds, currentUserId]
  );

  // load any users we don't yet have in memory
  // Memoize ids to avoid unnecessary effect executions
  const missingUserIds = useMemo(
    () =>
      uniq([...document.collaboratorIds, ...Array.from(presentIds)])
        .filter((userId) => !users.get(userId))
        .sort(),
    [document.collaboratorIds, presentIds, users]
  );

  useEffect(() => {
    if (
      !isEqual(requestedUserIds, missingUserIds) &&
      missingUserIds.length > 0
    ) {
      setRequestedUserIds(missingUserIds);
      void users.fetchPage({ ids: missingUserIds, limit: 100 });
    }
  }, [missingUserIds, requestedUserIds, users]);

  // Memoize onClick handler to avoid inline function creation
  const handleAvatarClick = useCallback(
    (
      collaboratorId: string,
      isPresent: boolean,
      isObserving: boolean,
      isObservable: boolean
    ) =>
      (ev: React.MouseEvent) => {
        if (isObservable && isPresent) {
          ev.preventDefault();
          ev.stopPropagation();
          ui.setObservingUser(isObserving ? undefined : collaboratorId);
        }
      },
    [ui]
  );

  // Render anonymous avatar with presence styling
  const renderAnonymousAvatar = useCallback(
    (anon: typeof anonymousUsers[0], index: number, hasUsersBefore: boolean) => {
      const isCurrentAnonymous = anon.id === currentAnonymousId;
      const status = anon.isEditing ? t("currently editing") : t("currently viewing");

      return (
        <Tooltip
          key={anon.id}
          content={
            <div style={{ textAlign: "center" }}>
              <strong>{anon.name}</strong> {isCurrentAnonymous && `(${t("You")})`}
              <br />
              {status}
            </div>
          }
          placement="bottom"
        >
          <AvatarWrapper
            style={{ marginLeft: (index > 0 || hasUsersBefore) ? "4px" : "0" }}
            $isPresent={true}
            $isObserving={false}
            $userColor={anon.color}
            $size={AvatarSize.Large}
          >
            <Avatar
              size={AvatarSize.Large}
              model={anon}
              alt={anon.name}
            />
          </AvatarWrapper>
        </Tooltip>
      );
    },
    [currentAnonymousId, t]
  );

  const renderAvatar = useCallback(
    ({ model: collaborator, ...rest }) => {
      const isPresent = presentIds.has(collaborator.id);
      const isEditing = editingIds.has(collaborator.id);
      const isObserving = observingUserId === collaborator.id;
      const isObservable = collaborator.id !== currentUserId;

      return (
        <AvatarWithPresence
          {...rest}
          key={collaborator.id}
          user={collaborator}
          isPresent={isPresent}
          isEditing={isEditing}
          isObserving={isObserving}
          isCurrentUser={currentUserId === collaborator.id}
          alt={t("Avatar of {{ name }}", { name: collaborator.name })}
          onClick={
            isObservable
              ? handleAvatarClick(
                collaborator.id,
                isPresent,
                isObserving,
                isObservable
              )
              : undefined
          }
        />
      );
    },
    [presentIds, editingIds, observingUserId, currentUserId, handleAvatarClick]
  );

  // Don't show if insights are explicitly disabled and there are no anonymous users present
  if (document.insightsEnabled === false && anonymousUsers.length === 0) {
    return null;
  }

  // If insights are explicitly disabled but there are anonymous users, show only anonymous users
  const showOnlyAnonymous = document.insightsEnabled === false && anonymousUsers.length > 0;

  return (
    <Popover>
      <PopoverTrigger>
        <NudeButton
          width={((showOnlyAnonymous ? 0 : Math.min(collaborators.length, limit)) + anonymousUsers.length) * AvatarSize.Large}
          height={AvatarSize.Large}
          style={{ display: 'flex', alignItems: 'center' }}
        >
          {/* If user is logged in, show their Facepile first */}
          {!showOnlyAnonymous && currentUserId && (
            <Facepile
              size={AvatarSize.Large}
              limit={limit}
              overflow={Math.max(0, collaborators.length - limit)}
              users={collaborators}
              renderAvatar={renderAvatar}
            />
          )}
          {/* Then show anonymous users (or first if no logged in user) */}
          {anonymousUsers.map((anon, index) => renderAnonymousAvatar(anon, index, !!currentUserId))}
          {/* If no logged in user, show Facepile after anonymous users */}
          {!showOnlyAnonymous && !currentUserId && (
            <div style={anonymousUsers.length > 0 ? { marginLeft: "4px" } : undefined}>
              <Facepile
                size={AvatarSize.Large}
                limit={limit}
                overflow={Math.max(0, collaborators.length - limit)}
                users={collaborators}
                renderAvatar={renderAvatar}
              />
            </div>
          )}
        </NudeButton>
      </PopoverTrigger>
      <PopoverContent aria-label={t("Viewers")} side="bottom" align="end">
        <DocumentViews
          document={document}
          anonymousUsers={anonymousUsers}
          showOnlyAnonymous={showOnlyAnonymous}
          currentAnonymousId={currentAnonymousId}
        />
      </PopoverContent>
    </Popover>
  );
}

export default observer(Collaborators);

