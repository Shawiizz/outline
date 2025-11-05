import { useMemo } from "react";
import {
  downloadDocument,
  printDocument,
} from "~/actions/definitions/documents";
import { useMenuAction } from "./useMenuAction";

type Props = {
  /** Document ID for which the actions are generated */
  documentId: string;
};

/**
 * Hook that provides a simplified menu action for shared/public documents.
 * Only includes download and print actions.
 */
export function useSharedDocumentMenuAction({ documentId }: Props) {
  const actions = useMemo(
    () => [
      downloadDocument,
      printDocument,
    ],
    []
  );

  return useMenuAction(actions);
}
