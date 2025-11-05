import { setBlockType } from "prosemirror-commands";
import { NodeSpec, NodeType, Node as ProsemirrorNode } from "prosemirror-model";
import deleteEmptyFirstParagraph from "../commands/deleteEmptyFirstParagraph";
import setParagraphAlignment from "../commands/setParagraphAlignment";
import setParagraphIndent from "../commands/setParagraphIndent";
import { MarkdownSerializerState } from "../lib/markdown/serializer";
import Node from "./Node";
import { EditorStyleHelper } from "../styles/EditorStyleHelper";

export default class Paragraph extends Node {
  get name() {
    return "paragraph";
  }

  get schema(): NodeSpec {
    return {
      attrs: {
        textAlign: {
          default: null,
        },
        indent: {
          default: 0,
        },
      },
      content: "inline*",
      group: "block",
      parseDOM: [
        {
          tag: "p",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLElement)) {
              return false;
            }

            // We must suppress image captions from being parsed as a separate paragraph.
            if (dom.classList.contains(EditorStyleHelper.imageCaption)) {
              return false;
            }

            return {
              textAlign: dom.style.textAlign || null,
              indent: parseInt(dom.getAttribute("data-indent") || "0", 10),
            };
          },
        },
      ],
      toDOM: (node) => {
        const attrs: Record<string, any> = {
          dir: "auto",
        };

        // Add indent data attribute
        if (node.attrs.indent) {
          attrs["data-indent"] = node.attrs.indent;
        }

        // Build inline style for alignment and indentation
        const styles: string[] = [];
        if (node.attrs.textAlign) {
          styles.push(`text-align: ${node.attrs.textAlign}`);
        }
        if (node.attrs.indent) {
          const indentValue = node.attrs.indent * 2; // 2em per indent level
          styles.push(`margin-left: ${indentValue}em`);
        }
        if (styles.length > 0) {
          attrs.style = styles.join("; ");
        }

        return ["p", attrs, 0];
      },
    };
  }

  keys({ type }: { type: NodeType }) {
    return {
      "Shift-Ctrl-0": setBlockType(type),
      Backspace: deleteEmptyFirstParagraph,
      Tab: setParagraphIndent("increase"),
      "Shift-Tab": setParagraphIndent("decrease"),
    };
  }

  commands({ type }: { type: NodeType }) {
    return {
      paragraph: () => setBlockType(type),
      setParagraphAlignment: ({ alignment }: { alignment: "left" | "center" | "right" | null }) =>
        setParagraphAlignment(alignment),
      increaseParagraphIndent: () => setParagraphIndent("increase"),
      decreaseParagraphIndent: () => setParagraphIndent("decrease"),
    };
  }

  toMarkdown(state: MarkdownSerializerState, node: ProsemirrorNode) {
    // render empty paragraphs as hard breaks to ensure that newlines are
    // persisted between reloads (this breaks from markdown tradition)
    if (
      node.textContent.trim() === "" &&
      node.childCount === 0 &&
      !state.inTable
    ) {
      state.write(state.options.softBreak ? "\n" : "\\\n");
    } else {
      state.renderInline(node);
      state.closeBlock(node);
    }
  }

  parseMarkdown() {
    return { block: "paragraph" };
  }
}
