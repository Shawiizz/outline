import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import ButtonSmall from "~/components/ButtonSmall";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";
import Document from "~/models/Document";

type Props = {
    /** The document to export */
    documentId: string;
    /** Callback when the dialog should be closed */
    onRequestClose: () => void;
};

function ExportNestedDialog({ documentId, onRequestClose }: Props) {
    const { t } = useTranslation();
    const { documents } = useStores();
    const [format, setFormat] = React.useState<"markdown" | "html" | "pdf">("markdown");
    const [selectedDocuments, setSelectedDocuments] = React.useState<Set<string>>(new Set());
    const [isLoadingDocs, setIsLoadingDocs] = React.useState(true);

    const document = documents.get(documentId);

    // Fonction pour charger récursivement tous les documents enfants
    const loadAllChildDocuments = React.useCallback(async (doc: Document): Promise<void> => {
        await documents.fetchChildDocuments(doc.id);
        const children = doc.childDocuments;

        // Charger récursivement les enfants de chaque enfant
        await Promise.all(
            children.map(child => loadAllChildDocuments(child))
        );
    }, [documents]);

    // Fonction pour collecter tous les documents de l'arborescence
    const collectAllDocuments = React.useCallback((doc: Document): string[] => {
        const ids = [doc.id];
        doc.childDocuments.forEach(child => {
            ids.push(...collectAllDocuments(child));
        });
        return ids;
    }, []);

    // Charger tous les documents et initialiser la sélection
    React.useEffect(() => {
        let mounted = true;

        const loadDocuments = async () => {
            if (document) {
                setIsLoadingDocs(true);
                try {
                    await loadAllChildDocuments(document);
                    if (mounted) {
                        const allIds = collectAllDocuments(document);
                        setSelectedDocuments(new Set(allIds));
                        setIsLoadingDocs(false);
                    }
                } catch (error) {
                    console.error("Error loading documents:", error);
                    if (mounted) {
                        setIsLoadingDocs(false);
                    }
                }
            }
        };

        void loadDocuments();

        return () => {
            mounted = false;
        };
    }, [document, loadAllChildDocuments, collectAllDocuments]);

    const handleExport = async () => {
        if (!document) {
            return;
        }

        if (selectedDocuments.size === 0) {
            toast.error(t("Please select at least one document to export"));
            return;
        }

        // Close dialog immediately
        onRequestClose();

        // Generate export ID
        const exportId = crypto.randomUUID();
        const total = selectedDocuments.size;

        // Show initial progress toast
        toast.loading(
            t("Preparing export... (0/{{total}})", { total }),
            { id: "export-nested" }
        );

        // Start polling for progress
        const pollInterval = setInterval(async () => {
            try {
                const response = await client.post("/documents.export_progress", {
                    exportId,
                });
                
                const { current, total: totalDocs, status } = response.data;

                if (status === "processing") {
                    toast.loading(
                        t("Exporting documents... ({{current}}/{{total}})", {
                            current,
                            total: totalDocs,
                        }),
                        { id: "export-nested" }
                    );
                } else if (status === "complete") {
                    clearInterval(pollInterval);
                }
            } catch (error) {
                // Ignore polling errors
                console.debug("Progress poll error:", error);
            }
        }, 2000);

        try {
            await client.post(
                "/documents.export_nested",
                {
                    id: documentId,
                    format,
                    documentIds: Array.from(selectedDocuments),
                    exportId, // Send the exportId to the server
                },
                {
                    download: true,
                }
            );

            clearInterval(pollInterval);
            toast.success(t("Export completed and downloaded successfully"), { id: "export-nested" });
        } catch (error) {
            clearInterval(pollInterval);
            console.error("Export error:", error);
            toast.error(t("Failed to export documents"), { id: "export-nested" });
        }
    };

    // Fonction pour basculer la sélection d'un document et de ses enfants
    const toggleDocument = React.useCallback((doc: Document, checked: boolean) => {
        const allIds = collectAllDocuments(doc);
        setSelectedDocuments(prev => {
            const newSet = new Set(prev);
            allIds.forEach(id => {
                if (checked) {
                    newSet.add(id);
                } else {
                    newSet.delete(id);
                }
            });
            return newSet;
        });
    }, [collectAllDocuments]);

    // Fonction pour vérifier si un document est partiellement sélectionné
    const isPartiallySelected = React.useCallback((doc: Document): boolean => {
        const allIds = collectAllDocuments(doc);
        const selectedCount = allIds.filter(id => selectedDocuments.has(id)).length;
        return selectedCount > 0 && selectedCount < allIds.length;
    }, [collectAllDocuments, selectedDocuments]);

    // Composant récursif pour afficher l'arborescence de documents
    const DocumentTreeItem = React.useCallback(({ doc, level = 0 }: { doc: Document; level?: number }) => {
        const isChecked = selectedDocuments.has(doc.id);
        const isPartial = isPartiallySelected(doc);
        const hasChildren = doc.childDocuments.length > 0;

        return (
            <div key={doc.id}>
                <TreeItemLabel $level={level}>
                    <input
                        type="checkbox"
                        checked={isChecked}
                        ref={el => {
                            if (el) {
                                el.indeterminate = isPartial;
                            }
                        }}
                        onChange={(e) => toggleDocument(doc, e.target.checked)}
                    />
                    <DocumentTitle $level={level}>
                        {doc.titleWithDefault}
                        {hasChildren && <ChildCount>({doc.childDocuments.length})</ChildCount>}
                    </DocumentTitle>
                </TreeItemLabel>
                {hasChildren && doc.childDocuments.map(child => (
                    <DocumentTreeItem key={child.id} doc={child} level={level + 1} />
                ))}
            </div>
        );
    }, [selectedDocuments, toggleDocument, isPartiallySelected]);

    const childCount = document ? collectAllDocuments(document).length - 1 : 0;

    if (isLoadingDocs) {
        return (
            <Flex column gap={16} align="center" justify="center" style={{ minHeight: "200px" }}>
                <Text type="secondary">{t("Loading documents...")}</Text>
            </Flex>
        );
    }

    return (
        <Flex column gap={16}>
            <Text type="secondary">
                {t(
                    "Export this document and all its nested sub-documents ({{count}} nested documents) as a ZIP file.",
                    { count: childCount }
                )}
            </Text>

            <Flex column gap={8}>
                <Flex justify="space-between" align="center">
                    <Text weight="bold">{t("Select documents to export:")}</Text>
                    <Flex gap={8}>
                        <ButtonSmall
                            type="button"
                            onClick={() => {
                                if (document) {
                                    const allIds = collectAllDocuments(document);
                                    setSelectedDocuments(new Set(allIds));
                                }
                            }}
                            neutral
                        >
                            {t("Select all")}
                        </ButtonSmall>
                        <ButtonSmall
                            type="button"
                            onClick={() => setSelectedDocuments(new Set())}
                            neutral
                        >
                            {t("Deselect all")}
                        </ButtonSmall>
                    </Flex>
                </Flex>
                <TreeContainer>
                    {document && <DocumentTreeItem doc={document} />}
                </TreeContainer>
                <Text type="secondary" size="small">
                    {t("{{selected}} of {{total}} documents selected", {
                        selected: selectedDocuments.size,
                        total: collectAllDocuments(document!).length
                    })}
                </Text>
            </Flex>

            <Flex column gap={8}>
                <Text weight="bold">{t("Select format:")}</Text>

                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                        type="radio"
                        name="format"
                        value="markdown"
                        checked={format === "markdown"}
                        onChange={(e) => setFormat(e.target.value as "markdown")}
                    />
                    <span>
                        <strong>Markdown</strong> - {t("Plain text format, easy to edit")}
                    </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                        type="radio"
                        name="format"
                        value="html"
                        checked={format === "html"}
                        onChange={(e) => setFormat(e.target.value as "html")}
                    />
                    <span>
                        <strong>HTML</strong> - {t("Web format with styling preserved")}
                    </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                        type="radio"
                        name="format"
                        value="pdf"
                        checked={format === "pdf"}
                        onChange={(e) => setFormat(e.target.value as "pdf")}
                    />
                    <span>
                        <strong>PDF</strong> - {t("Fixed layout, ready for printing")}
                    </span>
                </label>
            </Flex>

            <Flex justify="flex-end" gap={8}>
                <Button onClick={onRequestClose} neutral>
                    {t("Cancel")}
                </Button>
                <Button onClick={handleExport}>
                    {t("Export")}
                </Button>
            </Flex>
        </Flex>
    );
}

const TreeContainer = styled.div`
  height: 150px;
  overflow-y: auto;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
  padding: 12px;
  background: ${s("background")};

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: ${s("divider")};
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: ${s("textTertiary")};
  }
`;

const TreeItemLabel = styled.label<{ $level: number }>`
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 6px 8px;
  padding-left: ${props => props.$level * 24 + 8}px;
  border-radius: 4px;
  transition: background 100ms ease-in-out;

  &:hover {
    background: ${s("listItemHoverBackground")};
  }

  input[type="checkbox"] {
    cursor: pointer;
    width: 16px;
    height: 16px;
  }

  span {
    user-select: none;
  }
`;

const DocumentTitle = styled.span<{ $level: number }>`
  font-size: ${props => props.$level === 0 ? "14px" : "13px"};
  font-weight: ${props => props.$level === 0 ? 600 : 400};
  color: ${s("text")};
`;

const ChildCount = styled.span`
  color: ${s("textTertiary")};
  margin-left: 4px;
  font-size: 12px;
`;

export default observer(ExportNestedDialog);
