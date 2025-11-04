import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

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
    const [isExporting, setIsExporting] = React.useState(false);

    const document = documents.get(documentId);

    const handleExport = async () => {
        if (!document) {
            return;
        }

        setIsExporting(true);
        try {
            await client.post(
                "/documents.export_nested",
                {
                    id: documentId,
                    format,
                },
                {
                    download: true,
                }
            );

            toast.success(t("Document and nested documents exported successfully"));
            onRequestClose();
        } catch (error) {
            console.error("Export error:", error);
            toast.error(t("Failed to export documents"));
        } finally {
            setIsExporting(false);
        }
    };

    const childCount = document?.childDocuments?.length || 0;

    return (
        <Flex column gap={16}>
            <Text type="secondary">
                {t(
                    "Export this document and all its nested sub-documents ({{count}} nested documents) as a ZIP file.",
                    { count: childCount }
                )}
            </Text>

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
                <Button onClick={onRequestClose} disabled={isExporting} neutral>
                    {t("Cancel")}
                </Button>
                <Button onClick={handleExport} disabled={isExporting}>
                    {isExporting ? t("Exporting…") : t("Export")}
                </Button>
            </Flex>
        </Flex>
    );
}

export default observer(ExportNestedDialog);
