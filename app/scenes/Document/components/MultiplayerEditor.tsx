import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import throttle from "lodash/throttle";
import {
  useState,
  useLayoutEffect,
  useMemo,
  useEffect,
  forwardRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useHistory } from "react-router-dom";
import { toast } from "sonner";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  AuthenticationFailed,
  DocumentTooLarge,
  EditorUpdateError,
} from "@shared/collaboration/CloseEvents";
import EDITOR_VERSION from "@shared/editor/version";
import { generateAnonymousName } from "@shared/utils/anonymousNames";
import { supportsPassiveListener } from "@shared/utils/browser";
import Editor, { Props as EditorProps } from "~/components/Editor";
import MultiplayerExtension from "~/editor/extensions/Multiplayer";
import env from "~/env";
import useCurrentUser from "~/hooks/useCurrentUser";
import useIdle from "~/hooks/useIdle";
import useIsMounted from "~/hooks/useIsMounted";
import usePageVisibility from "~/hooks/usePageVisibility";
import useStores from "~/hooks/useStores";
import { AwarenessChangeEvent } from "~/types";
import Logger from "~/utils/Logger";
import { homePath } from "~/utils/routeHelpers";

type Props = EditorProps & {
  id: string;
  onSynced?: () => Promise<void>;
};

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | void;

type ConnectionStatusEvent = { status: ConnectionStatus };

type MessageEvent = {
  message: string;
  event: Event & {
    code?: number;
  };
};

function MultiplayerEditor({ onSynced, ...props }: Props, ref: any) {
  const documentId = props.id;
  const history = useHistory();
  const { t } = useTranslation();
  const currentUser = useCurrentUser({ rejectOnEmpty: false });
  const { presence, auth, ui } = useStores();
  const [editorVersionBehind, setEditorVersionBehind] = useState(false);
  const [showCursorNames, setShowCursorNames] = useState(false);
  const [remoteProvider, setRemoteProvider] =
    useState<HocuspocusProvider | null>(null);
  const [isLocalSynced, setLocalSynced] = useState(false);
  const [isRemoteSynced, setRemoteSynced] = useState(false);
  const [ydoc] = useState(() => new Y.Doc());
  // Use shareId as token for anonymous public editing, otherwise use collaboration token
  const token = (props as any).shareId || auth.collaborationToken;
  const isIdle = useIdle();
  const isVisible = usePageVisibility();
  const isMounted = useIsMounted();

  // Define user before useLayoutEffect so it can be used in provider setup
  const user = useMemo(() => {
    if (currentUser) {
      return {
        id: currentUser.id,
        name: currentUser.name,
        color: currentUser.color,
      };
    }

    // For anonymous users, generate a name and color based on shareId
    // This will be consistent for the same share link
    const shareId = (props as any).shareId;
    if (shareId) {
      const { name, color } = generateAnonymousName(shareId);
      return {
        id: `anonymous-${shareId}`,
        name,
        color,
      };
    }

    // Fallback
    return {
      id: "anonymous",
      name: "Anonymous Editor",
      color: "#9E9E9E",
    };
  }, [currentUser, (props as any).shareId]);

  // Provider initialization must be within useLayoutEffect rather than useState
  // or useMemo as both of these are ran twice in React StrictMode resulting in
  // an orphaned websocket connection.
  // see: https://github.com/facebook/react/issues/20090#issuecomment-715926549
  useLayoutEffect(() => {
    const debug = env.ENVIRONMENT === "development";
    const name = `document.${documentId}`;
    const localProvider = new IndexeddbPersistence(name, ydoc);
    const provider = new HocuspocusProvider({
      parameters: {
        editorVersion: EDITOR_VERSION,
      },
      url: `${env.COLLABORATION_URL}/collaboration`,
      name,
      document: ydoc,
      token,
    });

    // Set awareness user immediately after provider creation, before connection
    // But only if we're not in read-only mode (to avoid showing presence for viewers)
    if (!props.readOnly) {
      provider.setAwarenessField("user", user);
    }

    const syncScrollPosition = throttle(() => {
      // Don't sync scroll position if we're in read-only mode
      if (!props.readOnly) {
        provider.setAwarenessField(
          "scrollY",
          window.scrollY / window.innerHeight
        );
      }
    }, 250);

    const finishObserving = () => {
      if (ui.observingUserId) {
        ui.setObservingUser(undefined);
      }
    };

    window.addEventListener("click", finishObserving);
    window.addEventListener("wheel", finishObserving);
    window.addEventListener(
      "scroll",
      syncScrollPosition,
      supportsPassiveListener ? { passive: true } : false
    );

    provider.on("authenticationFailed", () => {
      void auth.fetchAuth().catch(() => {
        history.replace(homePath());
      });
    });

    provider.on("awarenessChange", (event: AwarenessChangeEvent) => {
      // Get all states from awareness including empty ones to detect disconnections
      const awarenessStates = provider.awareness.getStates();
      const allStates = Array.from(awarenessStates.entries())
        .map(([clientId, state]: [number, any]) => ({
          clientId,
          user: state.user,
          cursor: state.cursor,
          scrollY: state.scrollY,
        }));

      // Separate states with user info (connected) from empty states (disconnected)
      const connectedStates = allStates.filter((state) => state.user);
      const allClientIds = new Set(allStates.map(s => s.clientId));

      presence.updateFromAwarenessChangeEvent(
        documentId,
        provider.awareness.clientID,
        {
          ...event,
          states: connectedStates, // Pass only states with user info
        },
        allClientIds // Pass all client IDs to detect disconnections
      );

      event.states.forEach(({ user, scrollY }) => {
        if (user) {
          if (scrollY !== undefined && user.id === ui.observingUserId) {
            window.scrollTo({
              top: scrollY * window.innerHeight,
              behavior: "smooth",
            });
          }
        }
      });
    });

    const showCursorNames = () => {
      setShowCursorNames(true);
      setTimeout(() => {
        if (isMounted()) {
          setShowCursorNames(false);
        }
      }, 2000);
      provider.off("awarenessChange", showCursorNames);
    };

    provider.on("awarenessChange", showCursorNames);
    localProvider.on("synced", () =>
      // only set local storage to "synced" if it's loaded a non-empty doc
      setLocalSynced(!!ydoc.get("default")._start)
    );
    provider.on("synced", () => {
      if (currentUser) {
        presence.touch(documentId, currentUser.id, false);
      }
      setRemoteSynced(true);
    });

    provider.on("close", (ev: MessageEvent) => {
      if ("code" in ev.event) {
        provider.shouldConnect =
          ev.event.code !== DocumentTooLarge.code &&
          ev.event.code !== AuthenticationFailed.code &&
          ev.event.code !== EditorUpdateError.code;
        ui.setMultiplayerStatus("disconnected", ev.event.code);

        if (ev.event.code === EditorUpdateError.code) {
          setEditorVersionBehind(true);
        }
      }
    });

    if (debug) {
      provider.on("close", (ev: MessageEvent) =>
        Logger.debug("collaboration", "close", ev)
      );
      provider.on("message", (ev: MessageEvent) =>
        Logger.debug("collaboration", "incoming", {
          message: ev.message,
        })
      );
      provider.on("outgoingMessage", (ev: MessageEvent) =>
        Logger.debug("collaboration", "outgoing", {
          message: ev.message,
        })
      );
      localProvider.on("synced", () =>
        Logger.debug("collaboration", "local synced")
      );
    }

    provider.on("status", (ev: ConnectionStatusEvent) => {
      if (ui.multiplayerStatus !== ev.status) {
        ui.setMultiplayerStatus(ev.status, undefined);
      }
    });

    // Listen for permission changes via WebSocket messages
    const handleWebSocketMessage = (event: any) => {
      try {
        if (typeof event.data !== 'string') {
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message && message.type === 'outline-permission-change') {
          const { allowPublicEdit } = message;

          if (!allowPublicEdit && !currentUser) {
            toast.info(
              t("Public editing has been disabled. The page will reload in read-only mode.")
            );

            // Clear local IndexedDB storage to prevent stale edits
            const dbName = `document.${documentId}`;
            if (indexedDB) {
              indexedDB.deleteDatabase(dbName);
            }

            setTimeout(() => {
              window.location.reload();
            }, 2000);
          } else if (allowPublicEdit && !currentUser) {
            toast.success(
              t("Public editing has been enabled. The page will reload to enable editing.")
            );

            setTimeout(() => {
              window.location.reload();
            }, 2000);
          }
        }
      } catch (error) {
        Logger.error("Failed to process WebSocket message", error);
      }
    };

    // Access the underlying WebSocket and add our listener
    const ws = (provider as any).webSocket || (provider as any).ws;
    if (ws) {
      ws.addEventListener('message', handleWebSocketMessage);
    }

    setRemoteProvider(provider);

    return () => {
      window.removeEventListener("click", finishObserving);
      window.removeEventListener("wheel", finishObserving);
      window.removeEventListener("scroll", syncScrollPosition);
      provider?.destroy();
      void localProvider?.destroy();
      setRemoteProvider(null);
      ui.setMultiplayerStatus(undefined, undefined);
    };
  }, [
    history,
    t,
    documentId,
    ui,
    presence,
    ydoc,
    token,
    currentUser?.id,
    isMounted,
    auth,
    user,
  ]);

  const extensions = useMemo(() => {
    if (!remoteProvider) {
      return props.extensions;
    }

    return [
      ...(props.extensions || []),
      new MultiplayerExtension({
        user,
        provider: remoteProvider,
        document: ydoc,
      }),
    ];
  }, [remoteProvider, user, ydoc, props.extensions]);

  useEffect(() => {
    if (isLocalSynced && isRemoteSynced) {
      void onSynced?.();
    }
  }, [onSynced, isLocalSynced, isRemoteSynced]);

  // Disconnect the realtime connection while idle. `isIdle` also checks for
  // page visibility and will immediately disconnect when a tab is hidden.
  useEffect(() => {
    if (!remoteProvider) {
      return;
    }

    if (
      isIdle &&
      !isVisible &&
      remoteProvider.status === WebSocketStatus.Connected
    ) {
      void remoteProvider.disconnect();
    }

    if (
      (!isIdle || isVisible) &&
      remoteProvider.status === WebSocketStatus.Disconnected
    ) {
      void remoteProvider.connect();
    }
  }, [remoteProvider, isIdle, isVisible]);

  // Certain emoji combinations trigger this error in YJS, while waiting for a fix
  // we must prevent the user from continuing to edit as their changes will not
  // be persisted. See: https://github.com/yjs/yjs/issues/303
  useEffect(() => {
    function onUnhandledError(event: ErrorEvent) {
      if (event.message.includes("URIError: URI malformed")) {
        toast.error(
          t(
            "Sorry, the last change could not be persisted – please reload the page"
          )
        );
      }
    }

    window.addEventListener("error", onUnhandledError);
    return () => window.removeEventListener("error", onUnhandledError);
  }, [t]);

  if (!remoteProvider) {
    return null;
  }

  // while the collaborative document is loading, we render a version of the
  // document from the last text cache in read-only mode if we have it.
  const showCache = !isLocalSynced && !isRemoteSynced;

  return (
    <>
      {showCache && (
        <Editor
          editorStyle={props.editorStyle}
          embedsDisabled={props.embedsDisabled}
          defaultValue={props.defaultValue}
          extensions={props.extensions}
          scrollTo={props.scrollTo}
          readOnly
          ref={ref}
        />
      )}
      <Editor
        {...props}
        readOnly={props.readOnly || editorVersionBehind}
        value={undefined}
        defaultValue={undefined}
        extensions={extensions}
        ref={showCache ? undefined : ref}
        style={
          showCache
            ? {
              height: 0,
              opacity: 0,
            }
            : undefined
        }
        className={showCursorNames ? "show-cursor-names" : undefined}
      />
    </>
  );
}

export default forwardRef<typeof MultiplayerEditor, Props>(MultiplayerEditor);
