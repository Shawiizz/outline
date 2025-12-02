import ExtensionManager from "@shared/editor/lib/ExtensionManager";
import { richExtensions, withComments } from "@shared/editor/nodes";
import { ProsemirrorHelper as SharedProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { shouldHaveBlockId, generateBlockId } from "@shared/editor/extensions/BlockId";
import type Document from "../Document";
import { Schema } from "prosemirror-model";
import { Node } from "prosemirror-model";

/**
 * Block types that contain media/attachments and should not have their content modified by AI.
 * AI can delete these blocks or insert content around them, but cannot change the content itself.
 */
const NON_EDITABLE_BLOCK_TYPES = [
  "image",
  "video",
  "attachment",
  "embed",
  "table",
  "table_of_contents",
  "math_block",
];

/**
 * Block types that are lists and should have their items exposed individually
 */
const LIST_BLOCK_TYPES = [
  "bullet_list",
  "ordered_list",
  "checkbox_list",
];

/**
 * Represents a block with its unique ID and content
 */
export interface BlockInfo {
  /** Unique persistent ID for the block */
  blockId: string;
  /** Current index/position of the block (can change) */
  index: number;
  /** Markdown content of the block */
  content: string;
  /** Node type (paragraph, heading, etc.) */
  type: string;
  /** Whether the content can be edited (false for images, attachments, etc.) */
  editable: boolean;
  /** Human-readable description for non-editable blocks */
  description?: string;
  /** For list items: the parent list's blockId */
  parentBlockId?: string;
  /** For list items: the index within the list (0-based) */
  itemIndex?: number;
  /** For lists: the type of list marker (bullet, number, checkbox) */
  listType?: "bullet" | "ordered" | "checkbox";
}

export class ProsemirrorHelper {

  /**
   * Returns the markdown representation of the document derived from the ProseMirror data.
   *
   * @returns The markdown representation of the document as a string.
   */
  static toMarkdown = (document: Document) => {
    const extensionManager = new ExtensionManager(withComments(richExtensions));
    const serializer = extensionManager.serializer();
    const schema = new Schema({
      nodes: extensionManager.nodes,
      marks: extensionManager.marks,
    });

    const doc = Node.fromJSON(
      schema,
      SharedProsemirrorHelper.attachmentsToAbsoluteUrls(document.data)
    );

    const markdown = serializer.serialize(doc, {
      softBreak: true,
    });
    return markdown;
  };

  /**
   * Returns the document content with unique block IDs for AI context.
   * Each block is prefixed with [ID:xxx] where xxx is a persistent unique identifier.
   * This helps the AI reference specific blocks precisely - IDs remain stable
   * even when blocks are added, removed, or reordered.
   * 
   * Non-editable blocks (images, videos, etc.) are marked with [TYPE:xxx] and
   * their content is shown as a description to prevent AI from modifying them incorrectly.
   *
   * @returns Object with block content, blocks array with IDs, and block count
   */
  static toBlocksWithIds = (document: Document): {
    content: string;
    blocks: BlockInfo[];
    blockCount: number;
  } => {
    const extensionManager = new ExtensionManager(withComments(richExtensions));
    const serializer = extensionManager.serializer();
    const schema = new Schema({
      nodes: extensionManager.nodes,
      marks: extensionManager.marks,
    });

    const doc = Node.fromJSON(
      schema,
      SharedProsemirrorHelper.attachmentsToAbsoluteUrls(document.data)
    );

    const blocks: BlockInfo[] = [];
    const lines: string[] = [];
    let blockIndex = 0;

    // Track list item IDs generated during this serialization
    const generatedListItemIds = new Map<string, string[]>();

    // Traverse top-level blocks
    doc.forEach((node) => {
      if (shouldHaveBlockId(node.type.name)) {
        const blockId = node.attrs.blockId || `temp_${blockIndex}`;
        const isEditable = !NON_EDITABLE_BLOCK_TYPES.includes(node.type.name);
        const isList = LIST_BLOCK_TYPES.includes(node.type.name);

        if (isList) {
          // For lists, expose each item individually
          const listType = node.type.name === "bullet_list" ? "bullet"
            : node.type.name === "ordered_list" ? "ordered"
              : "checkbox";

          // Add list header with metadata
          lines.push(`[LIST:${blockId}] (${listType} list with ${node.childCount} items)`);

          // Track item IDs for this list
          const itemIds: string[] = [];

          // Process each list item
          let itemIndex = 0;
          node.forEach((listItem) => {
            // Generate a stable ID for this list item based on parent + index
            // Use a deterministic format so the same item gets the same ID on re-render
            const itemId = `${blockId}_item${itemIndex}`;
            itemIds.push(itemId);

            // Serialize the list item's children directly (not the list_item wrapper)
            // This avoids issues with list context and gives us clean content
            const contentParts: string[] = [];
            listItem.forEach((child: Node) => {
              const childMarkdown = serializer.serialize(child, { softBreak: true }).trim();
              if (childMarkdown) {
                contentParts.push(childMarkdown);
              }
            });
            const cleanContent = contentParts.join("\n\n");

            // Determine the prefix based on list type
            let prefix = "";
            if (listType === "bullet") {
              prefix = "- ";
            } else if (listType === "ordered") {
              prefix = `${itemIndex + 1}. `;
            } else if (listType === "checkbox") {
              const checked = listItem.attrs?.checked ? "[x]" : "[ ]";
              prefix = `- ${checked} `;
            }

            blocks.push({
              blockId: itemId,
              index: blockIndex,
              content: cleanContent,
              type: "list_item",
              editable: true,
              parentBlockId: blockId,
              itemIndex,
              listType,
            });

            lines.push(`  [ITEM:${itemId}] ${prefix}${cleanContent}`);
            itemIndex++;
          });

          generatedListItemIds.set(blockId, itemIds);

          // Also add the parent list as a block for operations like "delete entire list"
          blocks.push({
            blockId,
            index: blockIndex,
            content: `(${listType} list with ${node.childCount} items)`,
            type: node.type.name,
            editable: true,
            listType,
          });

        } else if (isEditable) {
          // Regular editable block - show full markdown content
          const nodeMarkdown = serializer.serialize(node, { softBreak: true }).trim();
          if (nodeMarkdown) {
            blocks.push({
              blockId,
              index: blockIndex,
              content: nodeMarkdown,
              type: node.type.name,
              editable: true,
            });
            lines.push(`[ID:${blockId}] ${nodeMarkdown}`);
          }
        } else {
          // Non-editable block (image, video, etc.) - show type and description only
          const description = ProsemirrorHelper.getBlockDescription(node);
          blocks.push({
            blockId,
            index: blockIndex,
            content: description,
            type: node.type.name,
            editable: false,
            description,
          });
          // Mark clearly as non-editable with type info
          lines.push(`[ID:${blockId}] [NON-EDITABLE:${node.type.name}] ${description}`);
        }
      }
      blockIndex++;
    });

    return {
      content: lines.join('\n\n'),
      blocks,
      blockCount: blockIndex
    };
  };

  /**
   * Gets a human-readable description for non-editable blocks.
   */
  private static getBlockDescription(node: Node): string {
    const attrs = node.attrs || {};

    switch (node.type.name) {
      case "image":
        return `[Image: ${attrs.alt || attrs.title || 'no description'}]`;
      case "video":
        return `[Video: ${attrs.title || 'embedded video'}]`;
      case "attachment":
        return `[Attachment: ${attrs.title || attrs.href || 'file'}]`;
      case "embed":
        return `[Embed: ${attrs.href || 'embedded content'}]`;
      case "table":
        return `[Table with ${node.childCount} rows]`;
      case "table_of_contents":
        return `[Table of Contents]`;
      case "math_block":
        return `[Math: ${node.textContent?.substring(0, 50) || 'equation'}...]`;
      default:
        return `[${node.type.name}]`;
    }
  }

  /**
   * Gets block content by its persistent blockId
   */
  static getBlockByBlockId = (blocks: BlockInfo[], blockId: string): BlockInfo | undefined => {
    return blocks.find(b => b.blockId === blockId);
  };

  /**
   * @deprecated Use toBlocksWithIds instead for better precision
   * Returns the document content with numbered blocks for AI context.
   */
  static toNumberedBlocks = (document: Document): { content: string; blockCount: number } => {
    const result = this.toBlocksWithIds(document);
    return {
      content: result.content,
      blockCount: result.blockCount
    };
  };

  /**
   * Gets block content by its index from a blocks array
   * @deprecated Use getBlockByBlockId instead for reliable block targeting
   */
  static getBlockContentByIndex = (blocks: BlockInfo[], blockIndex: number): string | undefined => {
    return blocks.find(b => b.index === blockIndex)?.content;
  };

  /**
   * Returns the content of blocks by index range.
   * Used to show users what content will be affected by an AI edit.
   *
   * @param document The document to extract blocks from
   * @param startIndex The starting block index (inclusive)
   * @param endIndex The ending block index (inclusive), defaults to startIndex
   * @returns The markdown content of the blocks in the range
   */
  static getBlocksContent = (document: Document, startIndex: number, endIndex?: number): string => {
    const extensionManager = new ExtensionManager(withComments(richExtensions));
    const serializer = extensionManager.serializer();
    const schema = new Schema({
      nodes: extensionManager.nodes,
      marks: extensionManager.marks,
    });

    const doc = Node.fromJSON(
      schema,
      SharedProsemirrorHelper.attachmentsToAbsoluteUrls(document.data)
    );

    const end = endIndex ?? startIndex;
    const blocks: string[] = [];
    let blockIndex = 0;

    doc.forEach((node) => {
      if (blockIndex >= startIndex && blockIndex <= end) {
        const nodeMarkdown = serializer.serialize(node, { softBreak: true }).trim();
        if (nodeMarkdown) {
          blocks.push(nodeMarkdown);
        }
      }
      blockIndex++;
    });

    return blocks.join('\n\n');
  };

  /**
   * Returns the plain text representation of the document derived from the ProseMirror data.
   *
   * @returns The plain text representation of the document as a string.
   */
  static toPlainText = (document: Document) => {
    const extensionManager = new ExtensionManager(withComments(richExtensions));
    const schema = new Schema({
      nodes: extensionManager.nodes,
      marks: extensionManager.marks,
    });
    const text = SharedProsemirrorHelper.toPlainText(
      Node.fromJSON(schema, document.data)
    );
    return text;
  };
}
