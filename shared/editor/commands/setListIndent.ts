import { Command, EditorState, Transaction } from "prosemirror-state";

/**
 * Increase or decrease the indentation of a list node (bullet_list or ordered_list).
 *
 * @param direction The direction to change indentation ("increase" or "decrease")
 * @returns The command
 */
export default function setListIndent(
    direction: "increase" | "decrease"
): Command {
    return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
        const { selection, schema } = state;
        const { $from } = selection;
        const bulletListType = schema.nodes.bullet_list;
        const orderedListType = schema.nodes.ordered_list;
        const listItemType = schema.nodes.list_item;
        const checkboxItemType = schema.nodes.checkbox_item;

        if (!bulletListType && !orderedListType) {
            return false;
        }

        // Find the list_item or checkbox_item first
        let itemDepth = -1;
        for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type === listItemType || node.type === checkboxItemType) {
                itemDepth = depth;
                break;
            }
        }

        // If we're not in a list item, return false
        if (itemDepth === -1) {
            return false;
        }

        // Now find the parent list (bullet_list or ordered_list)
        // The list should be at itemDepth - 1
        const listDepth = itemDepth - 1;
        if (listDepth < 0) {
            return false;
        }

        const listNode = $from.node(listDepth);
        
        // Verify it's actually a list node
        if (listNode.type !== bulletListType && listNode.type !== orderedListType) {
            return false;
        }

        const listPos = $from.before(listDepth);
        const currentIndent = listNode.attrs.indent || 0;
        let newIndent = currentIndent;

        if (direction === "increase") {
            // Maximum 5 levels of indentation (0-5)
            newIndent = Math.min(currentIndent + 1, 5);
        } else {
            // Minimum 0 (no indentation)
            newIndent = Math.max(currentIndent - 1, 0);
        }

        // Only update if indentation actually changed
        if (newIndent === currentIndent) {
            return false;
        }

        if (dispatch) {
            const tr = state.tr.setNodeMarkup(listPos, undefined, {
                ...listNode.attrs,
                indent: newIndent,
            });
            dispatch(tr);
        }

        return true;
    };
}
