import { observable, action, runInAction } from "mobx";
import { AwarenessChangeEvent } from "~/types";
import RootStore from "./RootStore";

type DocumentPresence = Map<
  string,
  {
    isEditing: boolean;
    userId: string;
    userName?: string;
    userColor?: string;
  }
>;

export default class PresenceStore {
  @observable
  data: Map<string, DocumentPresence> = new Map();

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
  }

  /**
   * Removes a user from the presence store
   *
   * @param documentId ID of the document to remove the user from
   * @param userId ID of the user to remove
   */
  @action
  public leave(documentId: string, userId: string) {
    const existing = this.data.get(documentId);

    if (existing) {
      existing.delete(userId);
    }
  }

  /**
   * Updates the presence store based on an awareness event from YJS
   *
   * @param documentId ID of the document the event is for
   * @param clientId ID of the client the event is for
   * @param event The awareness event
   * @param allClientIds Optional set of all client IDs currently in awareness (for detecting disconnections)
   */
  public updateFromAwarenessChangeEvent(
    documentId: string,
    clientId: number,
    event: AwarenessChangeEvent,
    allClientIds?: Set<number>
  ) {
    // Use runInAction to batch all presence updates into a single MobX transaction
    // This prevents the component from re-rendering between each state update
    runInAction(() => {
      const presence = this.data.get(documentId);
      let existingUserIds = (presence ? Array.from(presence.values()) : []).map(
        (p) => p.userId
      );

      event.states.forEach((state) => {
        const { user, cursor } = state;

        // Update presence for all users, including the current user
        if (user) {
          this.update(documentId, user.id, !!cursor, user.name, user.color);
          existingUserIds = existingUserIds.filter((id) => id !== user.id);
        }
      });

      // Remove users that are no longer present
      // If we have allClientIds, we can be more accurate about disconnections
      existingUserIds.forEach((userId) => {
        this.leave(documentId, userId);
      });
    });
  }

  /**
   * Updates the presence store to indicate that a user is present in a document
   * and then removes the user after a timeout of inactivity.
   *
   * @param documentId ID of the document to update
   * @param userId ID of the user to update
   * @param isEditing Whether the user is "editing" the document
   * @param userName Optional user name (for anonymous users)
   * @param userColor Optional user color (for anonymous users)
   */
  public touch(documentId: string, userId: string, isEditing: boolean, userName?: string, userColor?: string) {
    const id = `${documentId}-${userId}`;
    let timeout = this.timeouts.get(id);

    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }

    this.update(documentId, userId, isEditing, userName, userColor);

    timeout = setTimeout(() => {
      this.leave(documentId, userId);
    }, this.offlineTimeout);
    this.timeouts.set(id, timeout);
  }

  /**
   * Updates the presence store to indicate that a user is present in a document.
   *
   * @param documentId ID of the document to update
   * @param userId ID of the user to update
   * @param isEditing Whether the user is "editing" the document
   * @param userName Optional user name (for anonymous users)
   * @param userColor Optional user color (for anonymous users)
   */
  @action
  private update(documentId: string, userId: string, isEditing: boolean, userName?: string, userColor?: string) {
    const presence = this.data.get(documentId) || new Map();
    const existing = presence.get(userId);

    if (!existing || existing.isEditing !== isEditing || existing.userName !== userName || existing.userColor !== userColor) {
      presence.set(userId, {
        isEditing,
        userId,
        userName,
        userColor,
      });
      this.data.set(documentId, presence);
    }
  }

  public get(documentId: string): DocumentPresence | null | undefined {
    return this.data.get(documentId);
  }

  @action
  public clear() {
    this.data.clear();
  }

  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private offlineTimeout = 30000;

  private rootStore: RootStore;
}
