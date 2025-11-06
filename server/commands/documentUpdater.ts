import { Event, Document, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { TextHelper } from "@server/models/helpers/TextHelper";
import { APIContext } from "@server/types";

type Props = {
  /** The user updating the document (null for anonymous public editing) */
  user: User | null;
  /** The existing document */
  document: Document;
  /** The new title */
  title?: string;
  /** The document icon */
  icon?: string | null;
  /** The document icon's color */
  color?: string | null;
  /** The new text content */
  text?: string;
  /** Whether the editing session is complete */
  done?: boolean;
  /** The version of the client editor that was used */
  editorVersion?: string;
  /** The ID of the template that was used */
  templateId?: string | null;
  /** If the document should be displayed full-width on the screen */
  fullWidth?: boolean;
  /** Whether insights should be visible on the document */
  insightsEnabled?: boolean;
  /** Whether the text be appended to the end instead of replace */
  append?: boolean;
  /** Whether the document should be published to the collection */
  publish?: boolean;
  /** The ID of the collection to publish the document to */
  collectionId?: string | null;
};

/**
 * This command updates document properties. To update collaborative text state
 * use documentCollaborativeUpdater.
 *
 * @param Props The properties of the document to update
 * @returns Document The updated document
 */
export default async function documentUpdater(
  ctx: APIContext,
  {
    user,
    document,
    title,
    icon,
    color,
    text,
    editorVersion,
    templateId,
    fullWidth,
    insightsEnabled,
    append,
    publish,
    collectionId,
    done,
  }: Props
): Promise<Document> {
  const { transaction } = ctx.state;
  const previousTitle = document.title;
  const cId = collectionId || document.collectionId;

  if (title !== undefined) {
    document.title = title.trim();
  }
  if (icon !== undefined) {
    document.icon = icon;
  }
  if (color !== undefined) {
    document.color = color;
  }
  if (editorVersion) {
    document.editorVersion = editorVersion;
  }
  if (templateId) {
    document.templateId = templateId;
  }
  if (fullWidth !== undefined) {
    document.fullWidth = fullWidth;
  }
  if (insightsEnabled !== undefined) {
    document.insightsEnabled = insightsEnabled;
  }
  if (text !== undefined) {
    const processedText = user
      ? await TextHelper.replaceImagesWithAttachments(ctx, text, user, {
        base64Only: true,
      })
      : text; // For anonymous users, don't process image attachments

    document = DocumentHelper.applyMarkdownToDocument(
      document,
      processedText,
      append
    );
  }

  const changed = document.changed();

  const event = {
    name: "documents.update",
    documentId: document.id,
    collectionId: cId,
    data: {
      done,
      title: document.title,
    },
  };

  // Anonymous users cannot publish documents
  if (publish && user && (document.template || cId)) {
    if (!document.collectionId) {
      document.collectionId = cId;
    }
    await document.publish(user, cId, { transaction });

    await Event.createFromContext(ctx, {
      ...event,
      name: "documents.publish",
    });
  } else if (changed) {
    // For anonymous users, keep the original lastModifiedById
    if (user) {
      document.lastModifiedById = user.id;
      document.updatedBy = user;
    }
    await document.save({ transaction });

    // Only create events for authenticated users
    if (user) {
      await Event.createFromContext(ctx, event);
    }
  } else if (done && user) {
    await Event.schedule({
      ...event,
      actorId: user.id,
      teamId: document.teamId,
    });
  }

  if (document.title !== previousTitle && user) {
    await Event.schedule({
      name: "documents.title_change",
      documentId: document.id,
      collectionId: cId,
      teamId: document.teamId,
      actorId: user.id,
      data: {
        previousTitle,
        title: document.title,
      },
      ip: ctx.request.ip,
    });
  }

  // For anonymous users, return the document without user-specific scopes
  if (!user) {
    return await Document.findByPk(document.id, {
      rejectOnEmpty: true,
      transaction,
    });
  }

  return await Document.findByPk(document.id, {
    userId: user.id,
    rejectOnEmpty: true,
    transaction,
  });
}
