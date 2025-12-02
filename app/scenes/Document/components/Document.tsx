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
   * Handles AI edit events from the AiChat component.
   * Uses persistent blockId for reliable document modifications.
   * BlockIds remain stable even when blocks are added, removed, or reordered.
   * 
   * Supports two types of IDs:
   * - Block IDs: "blk_xxx" - top-level blocks (paragraphs, headings, lists)
   * - List item IDs: "blk_xxx_itemN" - individual items within a list
   */
  handleAiEdit = (event: CustomEvent<{
    documentId: string;
    edit: {
      blockId: string;
      replaceWith: string;
      action: "replace" | "delete" | "insertAfter";
    };
  }>) => {
    const { documentId, edit } = event.detail;

    // Validate document
    if (documentId !== this.props.document.id) {
      return;
    }

    const editorRef = this.editor.current;
    if (!editorRef) {
      return;
    }

    const { view, schema, parser } = editorRef;

    // Check if this is a list item ID (format: blk_xxx_itemN)
    const listItemMatch = edit.blockId.match(/^(.+)_item(\d+)$/);
    const isListItem = !!listItemMatch;
    const parentBlockId = listItemMatch ? listItemMatch[1] : null;
    const itemIndex = listItemMatch ? parseInt(listItemMatch[2], 10) : -1;

    // Parse markdown content into ProseMirror nodes
    const parseMarkdown = (markdown: string) => {
      try {
        const parsed = parser.parse(markdown);
        if (parsed?.content?.childCount > 0) {
          return parsed.content;
        }
      } catch (e) {
        console.error("[AI Edit] Parse error:", e);
      }
      return schema.text(markdown);
    };

    // Extract nodes from parsed content (Fragment or single Node)
    const extractNodes = (parsedContent: any): any[] => {
      const nodes: any[] = [];
      if ('forEach' in parsedContent && typeof parsedContent.forEach === 'function') {
        parsedContent.forEach((node: any) => nodes.push(node));
      } else {
        nodes.push(parsedContent);
      }
      return nodes;
    };

    // Find block by its persistent blockId
    const getBlockByBlockId = (targetBlockId: string): { from: number; to: number; node: any } | null => {
      let result: { from: number; to: number; node: any } | null = null;
      view.state.doc.forEach((node, offset) => {
        if (!result && node.attrs.blockId === targetBlockId) {
          result = { from: offset, to: offset + node.nodeSize, node };
        }
      });
      return result;
    };

    // Find a specific list item within a list block
    const getListItemByIndex = (listNode: any, listFrom: number, targetIndex: number): { from: number; to: number; node: any } | null => {
      let currentIndex = 0;
      let result: { from: number; to: number; node: any } | null = null;
      let pos = listFrom + 1; // Position starts after the list node's opening tag

      listNode.forEach((itemNode: any) => {
        if (!result && currentIndex === targetIndex) {
          result = { from: pos, to: pos + itemNode.nodeSize, node: itemNode };
        }
        pos += itemNode.nodeSize;
        currentIndex++;
      });

      return result;
    };

    try {
      const tr = view.state.tr;

      if (isListItem && parentBlockId !== null) {
        // Handle list item modification
        const listBlock = getBlockByBlockId(parentBlockId);
        if (!listBlock) {
          console.error("[AI Edit] Could not find parent list with ID:", parentBlockId);
          return;
        }

        const listItem = getListItemByIndex(listBlock.node, listBlock.from, itemIndex);
        if (!listItem) {
          console.error("[AI Edit] Could not find list item at index:", itemIndex);
          return;
        }

        const listType = listBlock.node.type.name;
        const isCheckbox = listType === "checkbox_list";

        switch (edit.action) {
          case 'delete':
            tr.delete(listItem.from, listItem.to);
            break;

          case 'insertAfter': {
            const content = edit.replaceWith.trim();
            let nodes = extractNodes(parseMarkdown(content));

            if (nodes.length === 0) {
              nodes = [schema.nodes.paragraph.create(null, schema.text(content))];
            }

            const attrs: Record<string, any> = isCheckbox ? { checked: false } : {};
            const newListItem = schema.nodes.list_item.create(attrs, nodes);
            tr.insert(listItem.to, newListItem);
            break;
          }

          case 'replace':
          default: {
            const content = edit.replaceWith.trim();
            let nodes = extractNodes(parseMarkdown(content));

            if (nodes.length === 0) {
              nodes = [schema.nodes.paragraph.create(null, schema.text(content))];
            }

            const attrs: Record<string, any> = { ...listItem.node.attrs };
            const replacementItem = schema.nodes.list_item.create(attrs, nodes);
            tr.replaceWith(listItem.from, listItem.to, replacementItem);
            break;
          }
        }
      } else {
        // Handle regular block modification
        const block = getBlockByBlockId(edit.blockId);
        if (!block) {
          console.error("[AI Edit] Could not find block with ID:", edit.blockId);
          return;
        }

        switch (edit.action) {
          case 'delete':
            tr.delete(block.from, block.to);
            break;

          case 'insertAfter':
            tr.insert(block.to, parseMarkdown(edit.replaceWith));
            break;

          case 'replace':
          default:
            tr.replaceWith(block.from, block.to, parseMarkdown(edit.replaceWith.trim()));
            break;
        }
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
