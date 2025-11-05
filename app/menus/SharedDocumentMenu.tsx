import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import Document from "~/models/Document";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import { OverflowMenuButton } from "~/components/Menu/OverflowMenuButton";
import { ActionContextProvider } from "~/hooks/useActionContext";
import { useSharedDocumentMenuAction } from "~/hooks/useSharedDocumentMenuAction";

type Props = {
  /** Document for which the menu is to be shown */
  document: Document;
  /** Alignment w.r.t trigger - defaults to start */
  align?: "start" | "end";
  /** Trigger's variant - renders nude variant if unset */
  neutral?: boolean;
  /** Invoked when menu is opened */
  onOpen?: () => void;
  /** Invoked when menu is closed */
  onClose?: () => void;
};

function SharedDocumentMenu({
  document,
  align,
  neutral,
  onOpen,
  onClose,
}: Props) {
  const { t } = useTranslation();

  const rootAction = useSharedDocumentMenuAction({
    documentId: document.id,
  });

  return (
    <ActionContextProvider
      value={{
        activeDocumentId: document.id,
      }}
    >
      <DropdownMenu
        action={rootAction}
        align={align}
        onOpen={onOpen}
        onClose={onClose}
        ariaLabel={t("Document options")}
      >
        <OverflowMenuButton neutral={neutral} />
      </DropdownMenu>
    </ActionContextProvider>
  );
}

export default observer(SharedDocumentMenu);
