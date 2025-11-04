import { setBlockType } from "prosemirror-commands";
import { NodeType } from "prosemirror-model";
import { Command, EditorState, Transaction } from "prosemirror-state";

/**
 * Set the text alignment of a paragraph node.
 *
 * @param alignment The alignment to set (left, center, right, or null)
 * @returns The command
 */
export default function setParagraphAlignment(
    alignment: "left" | "center" | "right" | null
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
                tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    textAlign: alignment,
                });
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
