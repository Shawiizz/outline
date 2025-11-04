import { CopyIcon, ExpandedIcon } from "outline-icons";
import { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  getFrequentCodeLanguages,
  codeLanguages,
  getLabelForLanguage,
} from "@shared/editor/lib/code";
import { MenuItem } from "@shared/editor/types";
import { Dictionary } from "~/hooks/useDictionary";

export default function codeMenuItems(
  state: EditorState,
  readOnly: boolean | undefined,
  dictionary: Dictionary
): MenuItem[] {
  const node = state.selection.$from.node();
  const isPython = node.attrs.language === "python" || node.attrs.language === "py";

  const frequentLanguages = getFrequentCodeLanguages();

  const frequentLangMenuItems = frequentLanguages.map((value) => {
    const label = codeLanguages[value]?.label;
    return langToMenuItem({ node, value, label });
  });

  const remainingLangMenuItems = Object.entries(codeLanguages)
    .filter(
      ([value]) =>
        !frequentLanguages.includes(value as keyof typeof codeLanguages)
    )
    .map(([value, item]) => langToMenuItem({ node, value, label: item.label }));

  const getLanguageMenuItems = () =>
    frequentLangMenuItems.length
      ? [
        ...frequentLangMenuItems,
        { name: "separator" },
        ...remainingLangMenuItems,
      ]
      : remainingLangMenuItems;

  const items: MenuItem[] = [
    {
      name: "copyToClipboard",
      icon: <CopyIcon />,
      label: readOnly
        ? getLabelForLanguage(node.attrs.language ?? "none")
        : undefined,
      tooltip: dictionary.copy,
    },
  ];

  // Add Run button for Python code
  if (isPython) {
    items.push({
      name: "runPython",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      ),
      tooltip: "Run Code",
    });
  }

  items.push(
    {
      name: "separator",
    },
    {
      name: "code_block",
      label: getLabelForLanguage(node.attrs.language ?? "none"),
      icon: <ExpandedIcon />,
      children: getLanguageMenuItems(),
      visible: !readOnly,
    }
  );

  return items;
}

const langToMenuItem = ({
  node,
  value,
  label,
}: {
  node: ProseMirrorNode;
  value: string;
  label: string;
}): MenuItem => ({
  name: "code_block",
  label,
  active: () => node.attrs.language === value,
  attrs: {
    language: value,
  },
});
