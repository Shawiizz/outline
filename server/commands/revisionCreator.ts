import { createContext } from "@server/context";
import { Document, User, Revision } from "@server/models";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import { DocumentEvent, RevisionEvent } from "@server/types";
import { isAnonymousUserId } from "@shared/utils/anonymousNames";

export default async function revisionCreator({
  event,
  document,
  user,
}: {
  event: DocumentEvent | RevisionEvent;
  document: Document;
  user: User;
}) {
  return sequelize.transaction(async (transaction) => {
    // Get collaborator IDs since last revision was written.
    const key = Document.getCollaboratorKey(document.id);
    const collaboratorIds = await Redis.defaultClient.smembers(key);
    await Redis.defaultClient.del(key);

    // Filter out anonymous users as they cannot be stored in the revisions table
    const validCollaboratorIds = collaboratorIds.filter(
      (id) => !isAnonymousUserId(id)
    );

    return await Revision.createFromDocument(
      createContext({
        user,
        authType: event.authType,
        ip: event.ip,
        transaction,
      }),
      document,
      validCollaboratorIds
    );
  });
}
