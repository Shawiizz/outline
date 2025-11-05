import { Command, EditorState, Transaction } from "prosemirror-state";

/**
 * Increase or decrease the indentation of a heading node.
 *
 * @param direction The direction to change indentation ("increase" or "decrease")
 * @returns The command
 */
export default function setHeadingIndent(
    direction: "increase" | "decrease"
): Command {
    return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
        const { selection, schema } = state;
        const { from, to, $from } = selection;
        const headingType = schema.nodes.heading;
        const listItemType = schema.nodes.list_item;
        const checkboxItemType = schema.nodes.checkbox_item;

        if (!headingType) {
            return false;
        }

        // Check if we're inside a list item - if so, don't handle Tab
        // Let the list item handle it instead
        for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type === listItemType || node.type === checkboxItemType) {
                return false;
            }
        }

        let applicable = false;
        const tr = state.tr;

        state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === headingType) {
                applicable = true;
                const currentIndent = node.attrs.indent || 0;
                let newIndent = currentIndent;

                if (direction === "increase") {
                    // Maximum 5 levels of indentation (0-5)
                    newIndent = Math.min(currentIndent + 1, 5);
                } else {
                    // Minimum 0 (no indentation)
                    newIndent = Math.max(currentIndent - 1, 0);
                }

                // Only update if indentation actually changed
                if (newIndent !== currentIndent) {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        indent: newIndent,
                    });
                }
            }
        });

        if (!applicable) {
            return false;
        }

        if (dispatch) {
            dispatch(tr);
        }

        return true;
    };
}
