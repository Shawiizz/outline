import * as React from "react";
import styled from "styled-components";
import { ChromePicker, ColorResult } from "react-color";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { depths, s } from "@shared/styles";
import { fadeAndScaleIn, fadeIn } from "~/styles/animations";

type Props = {
  isOpen: boolean;
  value: string;
  onSelect: (color: string) => void;
  onClose: () => void;
};

export default function ColorPickerDialog({ isOpen, value, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [color, setColor] = React.useState(value || "#000000");

  // Reset color when dialog opens with new value
  React.useEffect(() => {
    if (isOpen) {
      setColor(value || "#000000");
    }
  }, [isOpen, value]);

  const handleChange = (colorResult: ColorResult) => {
    setColor(colorResult.hex);
  };

  const handleApply = () => {
    onSelect(color);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <StyledOverlay />
        <StyledContent>
          <Title>{t("Choose a color")}</Title>
          <PickerWrapper>
            <ChromePicker
              color={color}
              onChange={handleChange}
              disableAlpha
            />
          </PickerWrapper>
          <ButtonRow>
            <CancelButton onClick={handleCancel}>
              {t("Cancel")}
            </CancelButton>
            <ApplyButton onClick={handleApply}>
              {t("Apply")}
            </ApplyButton>
          </ButtonRow>
        </StyledContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const StyledOverlay = styled(Dialog.Overlay)`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: ${(props) => props.theme.modalBackdrop};
  z-index: ${depths.overlay};
  animation: ${fadeIn} 150ms ease;
`;

const StyledContent = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: ${depths.modal};
  background: ${s("menuBackground")};
  border-radius: 8px;
  box-shadow: ${s("modalShadow")};
  padding: 20px;
  animation: ${fadeAndScaleIn} 150ms ease;
  outline: none;
  
  &:focus {
    outline: none;
  }
`;

const Title = styled(Dialog.Title)`
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  color: ${s("text")};
`;

const PickerWrapper = styled.div`
  .chrome-picker {
    box-shadow: none !important;
    background: transparent !important;
    font-family: inherit !important;
  }
  
  /* Style inputs and labels for dark theme compatibility */
  .chrome-picker input {
    color: ${s("text")} !important;
    background: ${s("backgroundSecondary")} !important;
    border: 1px solid ${s("inputBorder")} !important;
    box-shadow: none !important;
  }
  
  .chrome-picker label {
    color: ${s("textSecondary")} !important;
  }
  
  /* Style the toggle icon (arrows) */
  .chrome-picker svg {
    fill: ${s("text")} !important;
  }
  
  .chrome-picker svg path {
    fill: ${s("text")} !important;
  }
  
  /* Toggle button area */
  .chrome-picker > div:last-child > div:last-child {
    svg {
      fill: ${s("text")} !important;
    }
  }
`;

const ButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`;

const CancelButton = styled.button`
  padding: 8px 16px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 4px;
  background: transparent;
  color: ${s("text")};
  font-size: 14px;
  cursor: pointer;
  
  &:hover {
    background: ${s("listItemHoverBackground")};
  }
`;

const ApplyButton = styled.button`
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: ${(props) => props.theme.accent};
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  
  &:hover {
    opacity: 0.9;
  }
`;
