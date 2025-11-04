import { InputRule } from "prosemirror-inputrules";
import { NodeSpec, Node as ProsemirrorNode, NodeType } from "prosemirror-model";
import { Command } from "prosemirror-state";
import * as React from "react";
import ReactDOM from "react-dom";
import { TableOfContentsIcon } from "outline-icons";
import { MarkdownSerializerState } from "../lib/markdown/serializer";
import tableOfContentsRule from "../rules/tableOfContents";
import Node from "./Node";

/**
 * TableOfContents node - A placeholder that gets replaced with the actual
 * table of contents during HTML/PDF export and displays a visual indicator
 * in the editor.
 */
export default class TableOfContents extends Node {
    get name() {
        return "table_of_contents";
    }

    get rulePlugins() {
        return [tableOfContentsRule];
    }

    get schema(): NodeSpec {
        return {
            attrs: {
                // Maximum heading level to include (1-6)
                maxLevel: {
                    default: 3,
                },
            },
            group: "block",
            atom: true,
            selectable: true,
            draggable: true,
            parseDOM: [
                {
                    tag: "div.table-of-contents-block",
                    getAttrs: (dom: HTMLDivElement) => ({
                        maxLevel: parseInt(dom.dataset.maxLevel || "3", 10),
                    }),
                },
            ],
            toDOM: (node) => {
                // Check if we're in a browser environment
                if (typeof document !== "undefined") {
                    const container = document.createElement("div");
                    container.className = "table-of-contents-block";
                    container.dataset.maxLevel = String(node.attrs.maxLevel);
                    container.contentEditable = "false";

                    // Render the placeholder icon in the editor
                    const iconWrapper = document.createElement("div");
                    iconWrapper.className = "toc-icon-wrapper";

                    const icon = document.createElement("div");
                    icon.className = "toc-icon";
                    ReactDOM.render(<TableOfContentsIcon size={24} />, icon);

                    const label = document.createElement("span");
                    label.className = "toc-label";
                    label.textContent = "Table des matières";

                    iconWrapper.appendChild(icon);
                    iconWrapper.appendChild(label);
                    container.appendChild(iconWrapper);

                    return container;
                }

                // Server-side rendering: return a simple structure
                return [
                    "div",
                    {
                        class: "table-of-contents-block",
                        "data-max-level": String(node.attrs.maxLevel),
                    },
                ];
            },
        };
    }

    commands({ type }: { type: NodeType }) {
        return (): Command =>
            (state, dispatch) => {
                const { tr, selection } = state;
                const node = type.create({ maxLevel: 3 });

                if (dispatch) {
                    dispatch(tr.replaceSelectionWith(node).scrollIntoView());
                }

                return true;
            };
    }

    inputRules({ type }: { type: NodeType }) {
        return [
            new InputRule(/^\[\[toc\]\]$/, (state, match, start, end) => {
                const { tr } = state;

                if (match[0]) {
                    tr.replaceWith(start - 1, end, type.create({ maxLevel: 3 }));
                }

                return tr;
            }),
        ];
    }

    toMarkdown(state: MarkdownSerializerState, node: ProsemirrorNode) {
        state.write("\n[[toc]]\n");
        state.closeBlock(node);
    }

    parseMarkdown() {
        return {
            block: "table_of_contents",
            getAttrs: () => ({ maxLevel: 3 }),
        };
    }
}
