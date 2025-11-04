import * as React from "react";
import ReactDOM from "react-dom";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Node } from "prosemirror-model";
import { findBlockNodes } from "@shared/editor/queries/findChildren";
import Extension from "@shared/editor/lib/Extension";
import PyodideRunner from "~/components/CodeRunner/PyodideRunner";

const PYTHON_RUNNER_KEY = new PluginKey("pythonRunner");

export default class PythonRunnerExtension extends Extension {
  get name() {
    return "pythonRunner";
  }

  get plugins() {
    const containerCache = new Map<number, HTMLElement>();

    return [
      new Plugin({
        key: PYTHON_RUNNER_KEY,
        state: {
          init: (_, state) => {
            return createDecorations(state.doc, containerCache);
          },
          apply: (tr, decorationSet) => {
            if (!tr.docChanged) {
              return decorationSet.map(tr.mapping, tr.doc);
            }
            return createDecorations(tr.doc, containerCache);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
        view() {
          return {
            update: (view) => {
              requestAnimationFrame(() => {
                const decorationSet = PYTHON_RUNNER_KEY.getState(view.state);
                if (!decorationSet) {
                  return;
                }

                // Render React components for Python blocks
                decorationSet.find().forEach((decoration: any) => {
                  if (decoration.spec?.pythonBlock) {
                    const { pos, code, language } = decoration.spec.pythonBlock;
                    const container = containerCache.get(pos);

                    if (container && container.isConnected) {
                      ReactDOM.render(
                        <PyodideRunner code={code} language={language} pos={pos} />,
                        container
                      );
                    }
                  }
                });
              });
            },
            destroy: () => {
              // Cleanup React components
              containerCache.forEach((container) => {
                if (container.isConnected) {
                  ReactDOM.unmountComponentAtNode(container);
                }
              });
              containerCache.clear();
            },
          };
        },
      }),
    ];
  }
}

function createDecorations(
  doc: Node,
  containerCache: Map<number, HTMLElement>
): DecorationSet {
  const decorations: Decoration[] = [];
  const blocks = findBlockNodes(doc, true).filter(
    (item) =>
      (item.node.type.name === "code_fence" ||
        item.node.type.name === "code_block") &&
      (item.node.attrs.language === "python" ||
        item.node.attrs.language === "py")
  );

  const activePoses = new Set<number>();

  blocks.forEach((block) => {
    const language = block.node.attrs.language;
    const pos = block.pos;
    activePoses.add(pos);

    // Get or create container
    let container = containerCache.get(pos);
    if (!container) {
      container = document.createElement("div");
      container.className = "code-runner-container";
      containerCache.set(pos, container);
    }

    decorations.push(
      Decoration.widget(
        pos + block.node.nodeSize,
        () => container!,
        {
          side: 1,
          pythonBlock: {
            pos,
            code: block.node.textContent,
            language,
          },
        }
      )
    );
  });

  // Cleanup containers that are no longer in use
  Array.from(containerCache.keys()).forEach((pos) => {
    if (!activePoses.has(pos)) {
      const container = containerCache.get(pos);
      if (container) {
        ReactDOM.unmountComponentAtNode(container);
      }
      containerCache.delete(pos);
    }
  });

  return DecorationSet.create(doc, decorations);
}
