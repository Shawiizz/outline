import { Plugin, PluginKey, Transaction } from "prosemirror-state";
import { Node as ProsemirrorNode } from "prosemirror-model";
import Extension from "../lib/Extension";

/**
 * Generates a unique block ID using a combination of timestamp and random string.
 * Format: "blk_" + base36 timestamp + random suffix
 */
export function generateBlockId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `blk_${timestamp}${random}`;
}

/**
 * Plugin key for the BlockId plugin
 */
export const blockIdPluginKey = new PluginKey("blockId");

/**
 * List of node types that should have persistent block IDs.
 * These are "top-level" block nodes that the AI can target for modifications.
 */
export const BLOCK_ID_NODE_TYPES = [
    "paragraph",
    "heading",
    "blockquote",
    "code_block",
    "code_fence",
    "bullet_list",
    "ordered_list",
    "checkbox_list",
    "table",
    "image",
    "video",
    "attachment",
    "embed",
    "notice",
    "horizontal_rule",
    "math_block",
    "table_of_contents",
];

/**
 * Checks if a node type should have a block ID
 */
export function shouldHaveBlockId(nodeTypeName: string): boolean {
    return BLOCK_ID_NODE_TYPES.includes(nodeTypeName);
}

/**
 * Extension that adds persistent unique IDs to block-level nodes.
 * These IDs survive document modifications and can be used by AI agents
 * to reliably target specific blocks regardless of their position.
 */
export default class BlockId extends Extension {
    get name() {
        return "blockId";
    }

    get plugins(): Plugin[] {
        return [
            new Plugin({
                key: blockIdPluginKey,

                /**
                 * Append transaction handler that ensures all block nodes have unique IDs.
                 * This runs after every transaction to:
                 * 1. Add IDs to new blocks that don't have them
                 * 2. Ensure IDs are unique (handle copy-paste duplicates)
                 */
                appendTransaction(
                    transactions: readonly Transaction[],
                    oldState,
                    newState
                ) {
                    // Only process if document changed
                    const docChanged = transactions.some((tr) => tr.docChanged);
                    if (!docChanged) {
                        return null;
                    }

                    const { tr } = newState;
                    let modified = false;

                    // Track seen IDs to detect duplicates
                    const seenIds = new Set<string>();
                    const nodesToUpdate: Array<{ pos: number; id: string }> = [];

                    // First pass: collect all existing IDs and find nodes that need updates
                    newState.doc.descendants((node, pos) => {
                        if (!shouldHaveBlockId(node.type.name)) {
                            return true;
                        }

                        const currentId = node.attrs.blockId;

                        // Node needs a new ID if:
                        // 1. It doesn't have one
                        // 2. Its ID is a duplicate (e.g., from copy-paste)
                        if (!currentId || seenIds.has(currentId)) {
                            const newId = generateBlockId();
                            nodesToUpdate.push({ pos, id: newId });
                            seenIds.add(newId);
                        } else {
                            seenIds.add(currentId);
                        }

                        return true;
                    });

                    // Second pass: apply updates (in reverse order to maintain positions)
                    nodesToUpdate
                        .sort((a, b) => b.pos - a.pos)
                        .forEach(({ pos, id }) => {
                            const node = tr.doc.nodeAt(pos);
                            if (node && shouldHaveBlockId(node.type.name)) {
                                tr.setNodeMarkup(pos, undefined, {
                                    ...node.attrs,
                                    blockId: id,
                                });
                                modified = true;
                            }
                        });

                    return modified ? tr : null;
                },
            }),
        ];
    }
}

/**
 * Ensures all block nodes in a document have unique IDs.
 * This should be called when loading a document.
 * 
 * @param doc - The ProseMirror document node
 * @returns Object with modified document data and a map of blockId -> original index
 */
export function ensureBlockIds(
    docData: { type: string; content?: any[]; attrs?: any }
): {
    doc: typeof docData;
    blockMap: Map<string, number>;
    modified: boolean;
} {
    const blockMap = new Map<string, number>();
    const seenIds = new Set<string>();
    let blockIndex = 0;
    let modified = false;

    function processNode(node: any): any {
        if (!node || typeof node !== "object") {
            return node;
        }

        const result = { ...node };

        // Check if this is a block node that needs an ID
        if (shouldHaveBlockId(node.type)) {
            const currentId = node.attrs?.blockId;

            if (!currentId || seenIds.has(currentId)) {
                // Generate new ID
                const newId = generateBlockId();
                result.attrs = { ...node.attrs, blockId: newId };
                seenIds.add(newId);
                modified = true;
            } else {
                seenIds.add(currentId);
            }

            // Map blockId to its index
            const id = result.attrs?.blockId || currentId;
            if (id) {
                blockMap.set(id, blockIndex);
            }
            blockIndex++;
        }

        // Recursively process content
        if (Array.isArray(node.content)) {
            result.content = node.content.map(processNode);
        }

        return result;
    }

    const doc = processNode(docData);

    return { doc, blockMap, modified };
}

/**
 * Gets a mapping of blockId to block content from a ProseMirror document.
 * Useful for the AI to understand what each block contains.
 * 
 * @param doc - The ProseMirror document node
 * @param serializer - Optional serializer to convert nodes to markdown
 * @returns Map of blockId -> { index, content, type }
 */
export function getBlockIdMap(
    doc: ProsemirrorNode,
    serializer?: { serialize: (node: ProsemirrorNode, options?: any) => string }
): Map<string, { index: number; content: string; type: string }> {
    const map = new Map<string, { index: number; content: string; type: string }>();
    let index = 0;

    doc.forEach((node) => {
        if (shouldHaveBlockId(node.type.name)) {
            const blockId = node.attrs.blockId;
            if (blockId) {
                const content = serializer
                    ? serializer.serialize(node, { softBreak: true }).trim()
                    : node.textContent;

                map.set(blockId, {
                    index,
                    content,
                    type: node.type.name,
                });
            }
        }
        index++;
    });

    return map;
}

/**
 * Finds a block node by its ID in the document.
 * 
 * @param doc - The ProseMirror document node
 * @param blockId - The block ID to find
 * @returns Object with position info or null if not found
 */
export function findBlockById(
    doc: ProsemirrorNode,
    blockId: string
): { pos: number; node: ProsemirrorNode; index: number } | null {
    let result: { pos: number; node: ProsemirrorNode; index: number } | null = null;
    let index = 0;

    doc.forEach((node, offset) => {
        if (result) return; // Already found

        if (shouldHaveBlockId(node.type.name) && node.attrs.blockId === blockId) {
            result = { pos: offset, node, index };
        }
        index++;
    });

    return result;
}
