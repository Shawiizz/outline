import { Document, Share } from "@server/models";
import { Op } from "sequelize";

/**
 * Check if a document can be edited anonymously via a public share
 *
 * @param documentId - The document ID to check
 * @returns Boolean whether the document allows public editing
 */
export async function canEditDocumentPublicly(
    documentId: string
): Promise<boolean> {
    const share = await Share.findOne({
        where: {
            documentId,
            published: true,
            allowPublicEdit: true,
            revokedAt: {
                [Op.is]: null,
            },
        },
    });

    return !!share;
}

/**
 * Check if a document is within a collection that allows public editing
 *
 * @param document - The document to check
 * @returns Boolean whether the document's collection allows public editing
 */
export async function canEditDocumentCollectionPublicly(
    document: Document
): Promise<boolean> {
    if (!document.collectionId) {
        return false;
    }

    const share = await Share.findOne({
        where: {
            collectionId: document.collectionId,
            published: true,
            allowPublicEdit: true,
            revokedAt: {
                [Op.is]: null,
            },
        },
    });

    return !!share;
}
