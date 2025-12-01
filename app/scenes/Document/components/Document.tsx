import cloneDeep from "lodash/cloneDeep";
import debounce from "lodash/debounce";
import isEqual from "lodash/isEqual";
import { action, observable } from "mobx";
import { observer } from "mobx-react";
import { Node } from "prosemirror-model";
import { AllSelection, TextSelection } from "prosemirror-state";
import * as React from "react";
import { WithTranslation, withTranslation } from "react-i18next";
import {
  Prompt,
  RouteComponentProps,
  StaticContext,
  withRouter,
  Redirect,
} from "react-router";
import { toast } from "sonner";
import styled from "styled-components";
import breakpoint from "styled-components-breakpoint";
import { EditorStyleHelper } from "@shared/editor/styles/EditorStyleHelper";
import { s } from "@shared/styles";
import {
  IconType,
  NavigationNode,
  TOCPosition,
  TeamPreference,
} from "@shared/types";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { TextHelper } from "@shared/utils/TextHelper";
import { determineIconType } from "@shared/utils/icon";
import { isModKey } from "@shared/utils/keyboard";
import RootStore from "~/stores/RootStore";
import Document from "~/models/Document";
import Revision from "~/models/Revision";
import DocumentMove from "~/scenes/DocumentMove";
import DocumentPublish from "~/scenes/DocumentPublish";
import ErrorBoundary from "~/components/ErrorBoundary";
import LoadingIndicator from "~/components/LoadingIndicator";
import PageTitle from "~/components/PageTitle";
import PlaceholderDocument from "~/components/PlaceholderDocument";
import RegisterKeyDown from "~/components/RegisterKeyDown";
import { SidebarContextType } from "~/components/Sidebar/components/SidebarContext";
import withStores from "~/components/withStores";
import { MeasuredContainer } from "~/components/MeasuredContainer";
import type { Editor as TEditor } from "~/editor";
import { Properties } from "~/types";
import { client } from "~/utils/ApiClient";
import { emojiToUrl } from "~/utils/emoji";
import {
  documentHistoryPath,
  documentEditPath,
  updateDocumentPath,
} from "~/utils/routeHelpers";
import Container from "./Container";
import Contents from "./Contents";
import Editor from "./Editor";
import Header from "./Header";
import Notices from "./Notices";
import PublicReferences from "./PublicReferences";
import References from "./References";
import RevisionViewer from "./RevisionViewer";

const AUTOSAVE_DELAY = 3000;

type Params = {
  documentSlug: string;
  revisionId?: string;
  shareId?: string;
};

type LocationState = {
  title?: string;
  restore?: boolean;
  revisionId?: string;
  sidebarContext?: SidebarContextType;
};

type Props = WithTranslation &
  RootStore &
  RouteComponentProps<Params, StaticContext, LocationState> & {
    sharedTree?: NavigationNode;
    abilities: Record<string, boolean>;
    document: Document;
    revision?: Revision;
    readOnly: boolean;
    shareId?: string;
    tocPosition?: TOCPosition | false;
    onCreateLink?: (
      params: Properties<Document>,
      nested?: boolean
    ) => Promise<string>;
  };

@observer
class DocumentScene extends React.Component<Props> {
  @observable
  editor = React.createRef<TEditor>();

  @observable
  isUploading = false;

  @observable
  isSaving = false;

  @observable
  isPublishing = false;

  @observable
  isEditorDirty = false;

  @observable
  isEmpty = true;

  @observable
  title: string = this.props.document.title;

  componentDidMount() {
    this.updateIsDirty();
    window.addEventListener("ai-apply-edit", this.handleAiEdit as EventListener);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.readOnly && !this.props.readOnly) {
      this.updateIsDirty();
    }
  }

  componentWillUnmount() {
    window.removeEventListener("ai-apply-edit", this.handleAiEdit as EventListener);

    if (
      this.isEmpty &&
      this.props.document.createdBy?.id === this.props.auth.user?.id &&
      this.props.document.isDraft &&
      this.props.document.isActive &&
      this.props.document.hasEmptyTitle &&
      this.props.document.isPersistedOnce
    ) {
      void this.props.document.delete();
    } else if (this.props.document.isDirty()) {
      void this.props.document.save(undefined, {
        autosave: true,
      });
    }
  }

  /**
   * Handles AI edit events from the AiChat component
   */
  handleAiEdit = (event: CustomEvent<{
    documentId: string; edit: {
      type: string;
      startLine?: number;
      endLine?: number;
      insert?: boolean;
      oldContent?: string;
      newContent: string;
      contextBefore?: string;
      contextAfter?: string;
    }
  }>) => {
    const { documentId, edit } = event.detail;

    console.log("[AI Edit] Received event:", { documentId, edit });

    // Only apply if this is the correct document
    if (documentId !== this.props.document.id) {
      console.log("[AI Edit] Wrong document, ignoring");
      return;
    }

    const editorRef = this.editor.current;
    if (!editorRef) {
      console.log("[AI Edit] No editor ref");
      return;
    }

    const { view, schema, parser } = editorRef;

    // ============ HELPER FUNCTIONS ============

    // Parse markdown content into ProseMirror nodes
    const parseMarkdownContent = (markdown: string) => {
      try {
        const parsed = parser.parse(markdown);
        if (parsed && parsed.content.childCount > 0) {
          return parsed.content;
        }
      } catch (e) {
        console.error("[AI Edit] Error parsing markdown:", e);
      }
      return schema.text(markdown);
    };

    // Get document content as blocks with their positions
    // This must match how the backend parses markdown into blocks
    const getDocumentBlocks = (): Array<{ blockNum: number; from: number; to: number; text: string; node: any; type: string }> => {
      const blocks: Array<{ blockNum: number; from: number; to: number; text: string; node: any; type: string }> = [];
      let blockNum = 1;

      // Recursively collect leaf blocks (paragraphs, headings, code blocks, etc.)
      const collectBlocks = (node: any, pos: number) => {
        // These are "leaf" block types that correspond to markdown lines
        const leafBlockTypes = [
          'paragraph', 'heading', 'code_block', 'code_fence',
          'math_block', 'math_display', 'horizontal_rule',
          'blockquote', 'image', 'video', 'embed'
        ];

        if (leafBlockTypes.includes(node.type.name)) {
          blocks.push({
            blockNum,
            from: pos,
            to: pos + node.nodeSize,
            text: node.textContent,
            node,
            type: node.type.name
          });
          blockNum++;
          return false; // Don't descend
        }

        // For list items, each one is a block
        if (node.type.name === 'list_item' || node.type.name === 'checkbox_item') {
          blocks.push({
            blockNum,
            from: pos,
            to: pos + node.nodeSize,
            text: node.textContent,
            node,
            type: node.type.name
          });
          blockNum++;
          return false; // Don't descend into list item children
        }

        // For containers (doc, bullet_list, ordered_list, etc.), descend into children
        if (node.content) {
          let childPos = pos + 1; // +1 for the opening of the container
          node.content.forEach((child: any) => {
            collectBlocks(child, childPos);
            childPos += child.nodeSize;
          });
        }

        return false;
      };

      // Start from doc's children
      let pos = 0;
      view.state.doc.content.forEach((node: any) => {
        collectBlocks(node, pos);
        pos += node.nodeSize;
      });

      console.log("[AI Edit] Document blocks:", blocks.map(b => ({ num: b.blockNum, type: b.type, text: b.text.substring(0, 50) })));

      return blocks;
    };

    // ============ LINE-BASED EDITING (NEW SYSTEM) ============

    if (edit.startLine !== undefined) {
      console.log("[AI Edit] Using block-based edit:", edit.startLine, "-", edit.endLine);

      const blocks = getDocumentBlocks();
      console.log("[AI Edit] Document has", blocks.length, "blocks");

      const startBlock = edit.startLine;
      const endBlock = edit.endLine ?? startBlock;

      // Find the block positions
      const startBlockData = blocks.find(b => b.blockNum === startBlock);
      const endBlockData = blocks.find(b => b.blockNum === endBlock);

      if (!startBlockData) {
        console.log("[AI Edit] Start block not found:", startBlock, "- available blocks:", blocks.map(b => b.blockNum));
        return;
      }

      const fromPos = startBlockData.from;
      const toPos = endBlockData ? endBlockData.to : startBlockData.to;

      console.log("[AI Edit] Block positions:", fromPos, "-", toPos, "for blocks", startBlock, "-", endBlock);
      console.log("[AI Edit] Block type:", startBlockData.type);

      try {
        const tr = view.state.tr;

        // Trim newContent to avoid creating empty paragraphs
        let trimmedContent = edit.newContent?.trim() || "";

        // For list items, strip the list marker from AI response (e.g., "1. " or "- ")
        // since we're replacing the content inside the list_item, not the whole list
        const isListItem = startBlockData.type === 'list_item' || startBlockData.type === 'checkbox_item';
        if (isListItem && trimmedContent) {
          // Remove leading list markers like "1. ", "2. ", "- ", "* ", "- [ ] ", "- [x] "
          trimmedContent = trimmedContent
            .replace(/^\d+\.\s+/, '')  // Ordered list: "1. ", "2. ", etc.
            .replace(/^[-*]\s+/, '')    // Unordered list: "- ", "* "
            .replace(/^[-*]\s*\[[ x]\]\s*/i, ''); // Checkbox: "- [ ] ", "- [x] "
        }

        if (edit.insert) {
          // Insert after the specified block
          const insertPos = startBlockData.to;
          const content = parseMarkdownContent(trimmedContent);
          tr.insert(insertPos, content);
          console.log("[AI Edit] Insert done at position", insertPos);
        } else if (!trimmedContent) {
          // Delete the blocks
          tr.delete(fromPos, toPos);
          console.log("[AI Edit] Delete done");
        } else if (isListItem) {
          // For list items, replace just the text content inside, not the whole node
          // Find the paragraph inside the list_item
          const listItemNode = startBlockData.node;
          if (listItemNode.content && listItemNode.content.childCount > 0) {
            const firstChild = listItemNode.content.child(0);
            // Replace the content of the first child (usually a paragraph)
            const innerFrom = fromPos + 1; // +1 to skip the list_item opening
            const innerTo = innerFrom + firstChild.nodeSize;

            // Create a new paragraph with the new text
            const newParagraph = schema.nodes.paragraph.create(null, schema.text(trimmedContent));
            tr.replaceWith(innerFrom, innerTo, newParagraph);
            console.log("[AI Edit] List item content replaced");
          } else {
            // Fallback: just replace text
            const content = schema.text(trimmedContent);
            tr.replaceWith(fromPos + 1, toPos - 1, content);
          }
        } else {
          // Replace the blocks
          const content = parseMarkdownContent(trimmedContent);
          tr.replaceWith(fromPos, toPos, content);
          console.log("[AI Edit] Replace done");
        }

        view.dispatch(tr);
        this.isEditorDirty = true;
        this.updateIsDirty();
      } catch (error) {
        console.error("[AI Edit] Error applying block-based edit:", error);
      }
      return;
    }

    // ============ LEGACY TEXT-BASED EDITING (FALLBACK) ============

    console.log("[AI Edit] Using legacy text-based edit, type:", edit.type);

    // Find the position of a text match, expanding to include the full block if applicable
    const findBestMatch = (searchText: string, contextBefore?: string, contextAfter?: string): { from: number; to: number } | null => {
      // Clean up search text - remove markdown wrappers if AI included them by mistake
      let cleanSearch = searchText
        .replace(/^```\w*\n?/, '').replace(/\n?```$/, '')  // Remove code fences
        .replace(/^\$\$\n?/, '').replace(/\n?\$\$$/, '')   // Remove math delimiters
        .replace(/^\$/, '').replace(/\$$/, '');             // Remove inline math

      // Normalize whitespace
      const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
      const searchNorm = normalizeWs(cleanSearch);

      if (searchNorm.length < 3) {
        console.log("[AI Edit] Search text too short");
        return null;
      }

      console.log("[AI Edit] Searching for:", searchNorm.substring(0, 100) + (searchNorm.length > 100 ? "..." : ""));

      // Get full document text
      const fullText = view.state.doc.textContent;
      const fullTextNorm = normalizeWs(fullText);

      // Build character position map: textIndex -> docPosition
      const posMap: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          for (let i = 0; i < node.text.length; i++) {
            posMap.push(pos + i);
          }
        }
        return true;
      });

      // Strategy 1: Exact match (normalized whitespace)
      let matchIndex = fullTextNorm.indexOf(searchNorm);
      let matchLength = searchNorm.length;

      // Strategy 2: Case-insensitive match
      if (matchIndex === -1) {
        matchIndex = fullTextNorm.toLowerCase().indexOf(searchNorm.toLowerCase());
        if (matchIndex !== -1) console.log("[AI Edit] Case-insensitive match");
      }

      // Strategy 3: Find longest common substring (for partial matches)
      if (matchIndex === -1 && searchNorm.length > 20) {
        const findLongestMatch = (needle: string, haystack: string): { index: number; length: number } | null => {
          const needleLower = needle.toLowerCase();
          const haystackLower = haystack.toLowerCase();

          // Try progressively shorter substrings from the start
          for (let len = Math.min(needle.length, 200); len >= 15; len -= 5) {
            const substr = needleLower.substring(0, len);
            const idx = haystackLower.indexOf(substr);
            if (idx !== -1) {
              // Try to extend the match forward
              let actualLen = len;
              while (actualLen < needle.length &&
                idx + actualLen < haystack.length &&
                needleLower[actualLen] === haystackLower[idx + actualLen]) {
                actualLen++;
              }
              return { index: idx, length: actualLen };
            }
          }

          // Try from different positions in the search text
          const chunks = needle.split(/\s+/).filter(c => c.length > 5);
          for (const chunk of chunks.slice(0, 5)) {
            const idx = haystackLower.indexOf(chunk.toLowerCase());
            if (idx !== -1) {
              // Found a chunk, try to expand
              let start = idx;
              let end = idx + chunk.length;

              // Expand backwards
              let needlePos = needle.toLowerCase().indexOf(chunk.toLowerCase());
              while (start > 0 && needlePos > 0 &&
                haystackLower[start - 1] === needleLower[needlePos - 1]) {
                start--;
                needlePos--;
              }

              // Expand forwards
              needlePos = needle.toLowerCase().indexOf(chunk.toLowerCase()) + chunk.length;
              while (end < haystack.length && needlePos < needle.length &&
                haystackLower[end] === needleLower[needlePos]) {
                end++;
                needlePos++;
              }

              if (end - start >= 15) {
                return { index: start, length: end - start };
              }
            }
          }

          return null;
        };

        const longestMatch = findLongestMatch(searchNorm, fullTextNorm);
        if (longestMatch && longestMatch.length >= 15) {
          matchIndex = longestMatch.index;
          matchLength = longestMatch.length;
          console.log("[AI Edit] Longest substring match, length:", matchLength);
        }
      }

      // Strategy 4: Line-by-line matching
      if (matchIndex === -1) {
        const searchLines = cleanSearch.split(/\n/).filter(l => l.trim().length > 8);
        for (const line of searchLines) {
          const lineNorm = normalizeWs(line);
          if (lineNorm.length < 8) continue;

          let idx = fullTextNorm.indexOf(lineNorm);
          if (idx === -1) {
            idx = fullTextNorm.toLowerCase().indexOf(lineNorm.toLowerCase());
          }
          if (idx !== -1) {
            matchIndex = idx;
            matchLength = lineNorm.length;
            console.log("[AI Edit] Line match found:", lineNorm.substring(0, 50));
            break;
          }
        }
      }

      if (matchIndex === -1) {
        console.log("[AI Edit] No match found in document");
        return null;
      }

      // Convert normalized index to document position
      // This is approximate due to whitespace normalization
      const endIdx = Math.min(matchIndex + matchLength, posMap.length - 1);

      if (posMap[matchIndex] === undefined) {
        console.log("[AI Edit] Could not map start position");
        return null;
      }

      let matchFrom = posMap[matchIndex];
      let matchTo = posMap[endIdx] !== undefined ? posMap[endIdx] + 1 : matchFrom + matchLength;

      console.log("[AI Edit] Raw match:", matchFrom, "-", matchTo);

      // Try to expand to containing block for cleaner edits
      let expandedToBlock = false;
      view.state.doc.descendants((node, pos) => {
        if (expandedToBlock) return false;

        const nodeEnd = pos + node.nodeSize;
        const isBlock = node.type.name === 'code_block' || node.type.name === 'code_fence' ||
          node.type.name === 'math_block' || node.type.name === 'math_display' ||
          node.type.name === 'paragraph';

        // If the match overlaps significantly with this block, use the block
        if (isBlock && pos <= matchFrom && nodeEnd >= matchTo) {
          const matchLen = matchTo - matchFrom;
          const blockLen = node.textContent.length;
          const overlapRatio = matchLen / blockLen;

          // If match covers > 50% of block content, use full block
          if (overlapRatio > 0.5) {
            matchFrom = pos;
            matchTo = nodeEnd;
            expandedToBlock = true;
            console.log("[AI Edit] Expanded to full", node.type.name, "overlap:", (overlapRatio * 100).toFixed(0) + "%");
            return false;
          }
        }
        return true;
      });

      console.log("[AI Edit] Final match:", matchFrom, "-", matchTo);
      return { from: matchFrom, to: matchTo };
    };

    // ============ HANDLE EDIT TYPES ============

    console.log("[AI Edit] Edit type:", edit.type);

    // Handle prepend
    if (edit.type === "prepend") {
      try {
        const tr = view.state.tr;
        tr.insert(0, parseMarkdownContent(edit.newContent));
        view.dispatch(tr);
        this.isEditorDirty = true;
        this.updateIsDirty();
        console.log("[AI Edit] Prepend done");
      } catch (error) {
        console.error("[AI Edit] Error:", error);
      }
      return;
    }

    // Handle append
    if (edit.type === "append") {
      try {
        const tr = view.state.tr;
        tr.insert(view.state.doc.content.size, parseMarkdownContent(edit.newContent));
        view.dispatch(tr);
        this.isEditorDirty = true;
        this.updateIsDirty();
        console.log("[AI Edit] Append done");
      } catch (error) {
        console.error("[AI Edit] Error:", error);
      }
      return;
    }

    // Handle replaceAll
    if (edit.type === "replaceAll") {
      try {
        const tr = view.state.tr;
        const docSize = view.state.doc.content.size;
        if (edit.newContent.trim() === "") {
          tr.delete(0, docSize);
          tr.insert(0, schema.nodes.paragraph.create());
        } else {
          tr.replaceWith(0, docSize, parseMarkdownContent(edit.newContent));
        }
        view.dispatch(tr);
        this.isEditorDirty = true;
        this.updateIsDirty();
        console.log("[AI Edit] ReplaceAll done");
      } catch (error) {
        console.error("[AI Edit] Error:", error);
      }
      return;
    }

    // For delete, replace, insert - we need to find the target
    if (!edit.oldContent) {
      console.log("[AI Edit] No oldContent provided");
      return;
    }

    // Use the content as-is for matching - the AI should send exact content from the document
    const searchText = edit.oldContent;

    console.log("[AI Edit] Searching for:", searchText.substring(0, 100));

    const match = findBestMatch(searchText, edit.contextBefore, edit.contextAfter);

    if (!match) {
      console.log("[AI Edit] No match found for:", searchText.substring(0, 50));
      return;
    }

    // Apply the edit
    try {
      const tr = view.state.tr;

      if (edit.type === "delete") {
        tr.delete(match.from, match.to);
        console.log("[AI Edit] Delete done");
      } else if (edit.type === "replace") {
        tr.replaceWith(match.from, match.to, parseMarkdownContent(edit.newContent));
        console.log("[AI Edit] Replace done");
      } else if (edit.type === "insert") {
        tr.insert(match.to, parseMarkdownContent(edit.newContent));
        console.log("[AI Edit] Insert done");
      }

      view.dispatch(tr);
      this.isEditorDirty = true;
      this.updateIsDirty();
    } catch (error) {
      console.error("[AI Edit] Error applying edit:", error);
    }
  };

  /**
   * Replaces the given selection with a template, if no selection is provided
   * then the template is inserted at the beginning of the document.
   *
   * @param template The template to use
   * @param selection The selection to replace, if any
   */
  replaceSelection = (
    template: Document | Revision,
    selection?: TextSelection | AllSelection
  ) => {
    const editorRef = this.editor.current;

    if (!editorRef) {
      return;
    }

    const { view, schema } = editorRef;
    const sel = selection ?? TextSelection.near(view.state.doc.resolve(0));
    const doc = Node.fromJSON(
      schema,
      ProsemirrorHelper.replaceTemplateVariables(
        template.data,
        this.props.auth.user!
      )
    );

    if (doc) {
      view.dispatch(view.state.tr.setSelection(sel).replaceSelectionWith(doc));
    }

    this.isEditorDirty = true;

    if (template instanceof Document) {
      this.props.document.templateId = template.id;
      this.props.document.fullWidth = template.fullWidth;
    }

    if (!this.title) {
      const title = TextHelper.replaceTemplateVariables(
        template.title,
        this.props.auth.user!
      );
      this.title = title;
      this.props.document.title = title;
    }
    if (template.icon) {
      this.props.document.icon = template.icon;
    }
    if (template.color) {
      this.props.document.color = template.color;
    }

    this.props.document.data = cloneDeep(template.data);
    this.updateIsDirty();

    return this.onSave({
      autosave: true,
      publish: false,
      done: false,
    });
  };

  onSynced = async () => {
    const { history, location, t } = this.props;
    const restore = location.state?.restore;
    const revisionId = location.state?.revisionId;
    const editorRef = this.editor.current;

    if (!editorRef || !restore) {
      return;
    }

    const response = await client.post("/revisions.info", {
      id: revisionId,
    });

    if (response) {
      await this.replaceSelection(
        response.data,
        new AllSelection(editorRef.view.state.doc)
      );
      toast.success(t("Document restored"));
      history.replace(this.props.document.url, history.location.state);
    }
  };

  onUndoRedo = (event: KeyboardEvent) => {
    if (isModKey(event)) {
      event.preventDefault();

      if (event.shiftKey) {
        if (!this.props.readOnly) {
          this.editor.current?.commands.redo();
        }
      } else {
        if (!this.props.readOnly) {
          this.editor.current?.commands.undo();
        }
      }
    }
  };

  onMove = (ev: React.MouseEvent | KeyboardEvent) => {
    ev.preventDefault();
    const { document, dialogs, t, abilities } = this.props;
    if (abilities.move) {
      dialogs.openModal({
        title: t("Move document"),
        content: <DocumentMove document={document} />,
      });
    }
  };

  goToEdit = (ev: KeyboardEvent) => {
    if (this.props.readOnly) {
      ev.preventDefault();
      const { document, abilities } = this.props;

      if (abilities.update) {
        this.props.history.push({
          pathname: documentEditPath(document),
          state: { sidebarContext: this.props.location.state?.sidebarContext },
        });
      }
    } else if (this.editor.current?.isBlurred) {
      ev.preventDefault();
      this.editor.current?.focus();
    }
  };

  goToHistory = (ev: KeyboardEvent) => {
    if (!this.props.readOnly) {
      return;
    }
    if (ev.ctrlKey) {
      return;
    }
    ev.preventDefault();
    const { document, location } = this.props;

    if (location.pathname.endsWith("history")) {
      this.props.history.push({
        pathname: document.url,
        state: { sidebarContext: this.props.location.state?.sidebarContext },
      });
    } else {
      this.props.history.push({
        pathname: documentHistoryPath(document),
        state: { sidebarContext: this.props.location.state?.sidebarContext },
      });
    }
  };

  onPublish = (ev: React.MouseEvent | KeyboardEvent) => {
    ev.preventDefault();
    ev.stopPropagation();

    const { document, dialogs, t } = this.props;
    if (document.publishedAt) {
      return;
    }

    if (document?.collectionId) {
      void this.onSave({
        publish: true,
        done: true,
      });
    } else {
      dialogs.openModal({
        title: t("Publish document"),
        content: <DocumentPublish document={document} />,
      });
    }
  };

  onSave = async (
    options: {
      done?: boolean;
      publish?: boolean;
      autosave?: boolean;
    } = {}
  ) => {
    const { document } = this.props;
    // prevent saves when we are already saving
    if (document.isSaving) {
      return;
    }

    // get the latest version of the editor text value
    const doc = this.editor.current?.view.state.doc;
    if (!doc) {
      return;
    }

    // prevent save before anything has been written (single hash is empty doc)
    if (ProsemirrorHelper.isEmpty(doc) && document.title.trim() === "") {
      return;
    }

    document.data = doc.toJSON();
    document.tasks = ProsemirrorHelper.getTasksSummary(doc);

    // prevent autosave if nothing has changed
    if (options.autosave && !this.isEditorDirty && !document.isDirty()) {
      return;
    }

    this.isSaving = true;
    this.isPublishing = !!options.publish;

    try {
      const savedDocument = await document.save(undefined, options);
      this.isEditorDirty = false;

      if (options.done) {
        this.props.history.push({
          pathname: savedDocument.url,
          state: { sidebarContext: this.props.location.state?.sidebarContext },
        });
        this.props.ui.setActiveDocument(savedDocument);
      } else if (document.isNew) {
        this.props.history.push({
          pathname: documentEditPath(savedDocument),
          state: { sidebarContext: this.props.location.state?.sidebarContext },
        });
        this.props.ui.setActiveDocument(savedDocument);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      this.isSaving = false;
      this.isPublishing = false;
    }
  };

  autosave = debounce(
    () =>
      this.onSave({
        done: false,
        autosave: true,
      }),
    AUTOSAVE_DELAY
  );

  updateIsDirty = action(() => {
    const { document } = this.props;
    const doc = this.editor.current?.view.state.doc;

    this.isEditorDirty = !isEqual(doc?.toJSON(), document.data);
    this.isEmpty = (!doc || ProsemirrorHelper.isEmpty(doc)) && !this.title;
  });

  updateIsDirtyDebounced = debounce(this.updateIsDirty, 500);

  onFileUploadStart = action(() => {
    this.isUploading = true;
  });

  onFileUploadStop = action(() => {
    this.isUploading = false;
  });

  handleChangeTitle = action((value: string) => {
    this.title = value;
    this.props.document.title = value;
    this.updateIsDirty();
    void this.autosave();
  });

  handleChangeIcon = action((icon: string | null, color: string | null) => {
    this.props.document.icon = icon;
    this.props.document.color = color;
    void this.onSave();
  });

  handleSelectTemplate = async (template: Document | Revision) => {
    const doc = this.editor.current?.view.state.doc;
    if (!doc) {
      return;
    }

    return this.replaceSelection(
      template,
      ProsemirrorHelper.isEmpty(doc) ? new AllSelection(doc) : undefined
    );
  };

  goBack = () => {
    if (!this.props.readOnly) {
      this.props.history.push({
        pathname: this.props.document.url,
        state: { sidebarContext: this.props.location.state?.sidebarContext },
      });
    }
  };

  render() {
    const {
      children,
      document,
      revision,
      readOnly,
      abilities,
      auth,
      ui,
      shares,
      shareId,
      tocPosition,
      t,
    } = this.props;
    const { team, user } = auth;
    const isShare = !!shareId;
    const embedsDisabled =
      (team && team.documentEmbeds === false) || document.embedsDisabled;

    // Check if this is a public share with editing enabled
    const share = shareId ? shares.get(shareId) : undefined;
    const isPublicEditableShare = share?.allowPublicEdit ?? false;

    const tocPos =
      tocPosition ??
      ((team?.getPreference(TeamPreference.TocPosition) as TOCPosition) ||
        TOCPosition.Left);
    const showContents =
      tocPos &&
      (isShare
        ? ui.tocVisible !== false
        : !document.isTemplate && ui.tocVisible === true);
    const tocOffset =
      tocPos === TOCPosition.Left
        ? EditorStyleHelper.tocWidth / -2
        : EditorStyleHelper.tocWidth / 2;

    // Enable multiplayer for:
    // - Normal authenticated editing (not archived, deleted, or viewing revision)
    // - Public shares with showLastUpdated enabled (to see live updates)
    // - Public shares with allowPublicEdit enabled (to enable collaboration)
    // When showLastUpdated is false, display a static revision instead of live document
    const multiplayerEditor =
      !document.isArchived &&
      !document.isDeleted &&
      !revision &&
      (!isShare || (!!share && (share.showLastUpdated || share.allowPublicEdit)));

    const canonicalUrl = shareId
      ? this.props.match.url
      : updateDocumentPath(this.props.match.url, document);

    const hasEmojiInTitle = determineIconType(document.icon) === IconType.Emoji;
    const title = hasEmojiInTitle
      ? document.titleWithDefault.replace(document.icon!, "")
      : document.titleWithDefault;
    const favicon = hasEmojiInTitle ? emojiToUrl(document.icon!) : undefined;

    const fullWidthTransformOffsetStyle = {
      ["--full-width-transform-offset"]: `${document.fullWidth && showContents ? tocOffset : 0}px`,
    } as React.CSSProperties;

    return (
      <ErrorBoundary showTitle>
        {this.props.location.pathname !== canonicalUrl && (
          <Redirect
            to={{
              pathname: canonicalUrl,
              state: this.props.location.state,
              hash: this.props.location.hash,
            }}
          />
        )}
        <RegisterKeyDown trigger="m" handler={this.onMove} />
        <RegisterKeyDown trigger="z" handler={this.onUndoRedo} />
        <RegisterKeyDown trigger="e" handler={this.goToEdit} />
        <RegisterKeyDown trigger="Escape" handler={this.goBack} />
        <RegisterKeyDown trigger="h" handler={this.goToHistory} />
        <RegisterKeyDown
          trigger="p"
          options={{
            allowInInput: true,
          }}
          handler={(event) => {
            if (isModKey(event) && event.shiftKey) {
              this.onPublish(event);
            }
          }}
        />
        <MeasuredContainer
          as={Background}
          name="container"
          key={revision ? revision.id : document.id}
          column
          auto
        >
          <PageTitle title={title} favicon={favicon} />
          {(this.isUploading || this.isSaving) && <LoadingIndicator />}
          <Container column>
            {!readOnly && (
              <Prompt
                when={this.isUploading && !this.isEditorDirty}
                message={t(
                  `Images are still uploading.\nAre you sure you want to discard them?`
                )}
              />
            )}
            <Header
              document={document}
              revision={revision}
              shareId={shareId}
              isDraft={document.isDraft}
              isEditing={!readOnly && !!user?.separateEditMode}
              isSaving={this.isSaving}
              isPublishing={this.isPublishing}
              publishingIsDisabled={
                document.isSaving || this.isPublishing || this.isEmpty
              }
              savingIsDisabled={document.isSaving || this.isEmpty}
              sharedTree={this.props.sharedTree}
              onSelectTemplate={this.handleSelectTemplate}
              onSave={this.onSave}
            />
            <Main
              fullWidth={document.fullWidth}
              tocPosition={tocPos}
              style={fullWidthTransformOffsetStyle}
            >
              <React.Suspense
                fallback={
                  <EditorContainer
                    docFullWidth={document.fullWidth}
                    showContents={showContents}
                    tocPosition={tocPos}
                  >
                    <PlaceholderDocument />
                  </EditorContainer>
                }
              >
                {revision ? (
                  <RevisionContainer docFullWidth={document.fullWidth}>
                    <RevisionViewer
                      document={document}
                      revision={revision}
                      id={revision.id}
                    />
                  </RevisionContainer>
                ) : (
                  <>
                    <MeasuredContainer
                      name="document"
                      as={EditorContainer}
                      docFullWidth={document.fullWidth}
                      showContents={showContents}
                      tocPosition={tocPos}
                    >
                      <Notices document={document} readOnly={readOnly} />

                      {showContents && (
                        <PrintContentsContainer>
                          <Contents />
                        </PrintContentsContainer>
                      )}
                      <Editor
                        id={document.id}
                        key={embedsDisabled ? "disabled" : "enabled"}
                        ref={this.editor}
                        multiplayer={multiplayerEditor}
                        shareId={shareId}
                        isDraft={document.isDraft}
                        template={document.isTemplate}
                        document={document}
                        value={readOnly ? document.data : undefined}
                        defaultValue={document.data}
                        embedsDisabled={embedsDisabled}
                        onSynced={this.onSynced}
                        onFileUploadStart={this.onFileUploadStart}
                        onFileUploadStop={this.onFileUploadStop}
                        onCreateLink={this.props.onCreateLink}
                        onChangeTitle={this.handleChangeTitle}
                        onChangeIcon={this.handleChangeIcon}
                        onSave={this.onSave}
                        onPublish={this.onPublish}
                        onCancel={this.goBack}
                        readOnly={readOnly}
                        canUpdate={abilities.update}
                        canComment={abilities.comment}
                        autoFocus={document.createdAt === document.updatedAt}
                      >
                        {shareId ? (
                          <ReferencesWrapper>
                            <PublicReferences
                              shareId={shareId}
                              documentId={document.id}
                              sharedTree={this.props.sharedTree}
                            />
                          </ReferencesWrapper>
                        ) : !revision ? (
                          <ReferencesWrapper>
                            <References document={document} />
                          </ReferencesWrapper>
                        ) : null}
                      </Editor>
                    </MeasuredContainer>
                    {showContents && (
                      <ContentsContainer
                        docFullWidth={document.fullWidth}
                        position={tocPos}
                      >
                        <Contents />
                      </ContentsContainer>
                    )}
                  </>
                )}
              </React.Suspense>
            </Main>
            {children}
          </Container>
        </MeasuredContainer>
      </ErrorBoundary>
    );
  }
}

type MainProps = {
  fullWidth: boolean;
  tocPosition: TOCPosition | false;
};

const Main = styled.div<MainProps>`
  margin-top: 4px;

  ${breakpoint("tablet")`
    display: grid;
    grid-template-columns: ${({ fullWidth, tocPosition }: MainProps) =>
      fullWidth
        ? tocPosition === TOCPosition.Left
          ? `${EditorStyleHelper.tocWidth}px minmax(0, 1fr)`
          : `minmax(0, 1fr) ${EditorStyleHelper.tocWidth}px`
        : `1fr minmax(0, ${`calc(46em + 88px)`}) 1fr`};
  `};

  ${breakpoint("desktopLarge")`
    grid-template-columns: ${({ fullWidth, tocPosition }: MainProps) =>
      fullWidth
        ? tocPosition === TOCPosition.Left
          ? `${EditorStyleHelper.tocWidth}px minmax(0, 1fr)`
          : `minmax(0, 1fr) ${EditorStyleHelper.tocWidth}px`
        : `1fr minmax(0, ${`calc(52em + 88px)`}) 1fr`};
  `};
`;

type ContentsContainerProps = {
  docFullWidth: boolean;
  position: TOCPosition | false;
};

const ContentsContainer = styled.div<ContentsContainerProps>`
  ${breakpoint("tablet")`
    margin-top: calc(44px + 6vh);

    grid-row: 1;
    grid-column: ${({ docFullWidth, position }: ContentsContainerProps) =>
      position === TOCPosition.Left ? 1 : docFullWidth ? 2 : 3};
    justify-self: ${({ position }: ContentsContainerProps) =>
      position === TOCPosition.Left ? "end" : "start"};
  `};

  @media print {
    display: none;
  }
`;

const PrintContentsContainer = styled.div`
  display: none;
  margin: 0 -12px;

  @media print {
    display: block;
  }
`;

type EditorContainerProps = {
  docFullWidth: boolean;
  showContents: boolean;
  tocPosition: TOCPosition | false;
};

const EditorContainer = styled.div<EditorContainerProps>`
  // Adds space to the gutter to make room for icon & heading annotations
  padding: 0 44px;

  ${breakpoint("tablet")`
    grid-row: 1;

    // Decides the editor column position & span
    grid-column: ${({
  docFullWidth,
  showContents,
  tocPosition,
}: EditorContainerProps) =>
      docFullWidth
        ? showContents
          ? tocPosition === TOCPosition.Left
            ? 2
            : 1
          : "1 / -1"
        : 2};
  `};
`;

type RevisionContainerProps = {
  docFullWidth: boolean;
};

const RevisionContainer = styled.div<RevisionContainerProps>`
  // Adds space to the gutter to make room for icon
  padding: 0 40px;

  ${breakpoint("tablet")`
    grid-row: 1;
    grid-column: ${({ docFullWidth }: RevisionContainerProps) =>
      docFullWidth ? "1 / -1" : 2};
  `}
`;

const Background = styled(Container)`
  position: relative;
  background: ${s("background")};
`;

const ReferencesWrapper = styled.div`
  margin: 12px 0;

  @media print {
    display: none;
  }
`;

export default withTranslation()(withStores(withRouter(DocumentScene)));
