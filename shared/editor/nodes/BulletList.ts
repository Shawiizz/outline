import {
  Schema,
  NodeType,
  NodeSpec,
  Node as ProsemirrorModel,
} from "prosemirror-model";
import toggleList from "../commands/toggleList";
import { MarkdownSerializerState } from "../lib/markdown/serializer";
import { listWrappingInputRule } from "../lib/listInputRule";
import Node from "./Node";

export default class BulletList extends Node {
  get name() {
    return "bullet_list";
  }

  get schema(): NodeSpec {
    return {
      attrs: {
        indent: {
          default: 0,
        },
      },
      content: "list_item+",
      group: "block list",
      parseDOM: [
        {
          tag: "ul",
          getAttrs: (node: HTMLElement) => ({
            indent: parseInt(node.getAttribute("data-indent") || "0", 10),
          }),
        },
      ],
      toDOM: (node) => {
        const attrs: Record<string, any> = {};

        // Add indent data attribute
        if (node.attrs.indent) {
          attrs["data-indent"] = node.attrs.indent;
        }

        // Build inline style for indentation
        if (node.attrs.indent) {
          const indentValue = node.attrs.indent * 2; // 2em per indent level
          attrs.style = `margin-left: ${indentValue}em`;
        }

        return ["ul", attrs, 0];
      },
    };
  }

  commands({ type, schema }: { type: NodeType; schema: Schema }) {
    return {
      bullet_list: () => toggleList(type, schema.nodes.list_item),
    };
  }

  keys({ type, schema }: { type: NodeType; schema: Schema }) {
    return {
      "Shift-Ctrl-8": toggleList(type, schema.nodes.list_item),
    };
  }

  inputRules({ type }: { type: NodeType }) {
    return [listWrappingInputRule(/^\s*([-+*])\s$/, type)];
  }

  toMarkdown(state: MarkdownSerializerState, node: ProsemirrorModel) {
    state.renderList(node, "  ", () => (node.attrs.bullet || "*") + " ");
  }

  parseMarkdown() {
    return { block: "bullet_list" };
  }
}
