import { Command, EditorState, Transaction } from "prosemirror-state";

/**
 * Increase or decrease the indentation of a paragraph node.
 *
 * @param direction The direction to change indentation ("increase" or "decrease")
 * @returns The command
 */
export default function setParagraphIndent(
    direction: "increase" | "decrease"
): Command {
    return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
        const { selection, schema } = state;
        const { from, to } = selection;
        const paragraphType = schema.nodes.paragraph;

        if (!paragraphType) {
            return false;
        }

        let applicable = false;
        const tr = state.tr;

        state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === paragraphType) {
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
