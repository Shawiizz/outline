import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { findBlockNodes } from "../queries/findChildren";
import { Node } from "prosemirror-model";

export function CodeRunnerPlugin({ name }: { name: string }) {
  return new Plugin({
    key: new PluginKey("codeRunner"),
    state: {
      init: (_, { doc }) => DecorationSet.create(doc, []),
      apply: (transaction, decorationSet, oldState, state) => {
        const nodeName = state.selection.$head.parent.type.name;
        const previousNodeName = oldState.selection.$head.parent.type.name;
        const codeBlockChanged =
          transaction.docChanged && [nodeName, previousNodeName].includes(name);

        if (codeBlockChanged || transaction.docChanged) {
          return getDecorations({ doc: transaction.doc, name });
        }

        return decorationSet.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function getDecorations({ doc, name }: { doc: Node; name: string }) {
  const decorations: Decoration[] = [];
  const blocks: { node: Node; pos: number }[] = findBlockNodes(
    doc,
    true
  ).filter((item) => item.node.type.name === name);

  blocks.forEach((block) => {
    const language = block.node.attrs.language;
    
    // Only add decorations for Python blocks
    if (language === "python" || language === "py") {
      decorations.push(
        Decoration.widget(
          block.pos + block.node.nodeSize,
          (view: EditorView) => {
            const container = document.createElement("div");
            container.className = "python-code-runner";
            container.setAttribute("data-code-pos", String(block.pos));
            container.setAttribute("data-code-content", block.node.textContent);
            return container;
          },
          {
            side: 1,
            key: `runner-${block.pos}`,
          }
        )
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}
