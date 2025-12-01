import * as React from "react";
import { useCallback, useState, useRef } from "react";
import styled from "styled-components";
import { CirclePicker, ColorResult } from "react-color";
import { MenuItem } from "@shared/editor/types";
import { depths, s } from "@shared/styles";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEditor } from "./EditorContext";
import ToolbarButton from "./ToolbarButton";
import ColorPickerDialog from "./ColorPickerDialog";
import { useTranslation } from "react-i18next";

type Props = {
    item: MenuItem;
    currentColor: string | null;
};

// Extended color palette
const PRESET_COLORS = [
    // Reds
    "#E53935", "#EF5350", "#F44336",
    // Pinks
    "#D81B60", "#EC407A", "#F06292",
    // Purples
    "#8E24AA", "#AB47BC", "#BA68C8",
    // Blues
    "#1E88E5", "#42A5F5", "#64B5F6",
    // Cyans
    "#00ACC1", "#26C6DA", "#4DD0E1",
    // Greens
    "#43A047", "#66BB6A", "#81C784",
    // Yellows
    "#FDD835", "#FFEE58", "#FFF176",
    // Oranges
    "#FB8C00", "#FFA726", "#FFB74D",
    // Browns
    "#6D4C41", "#8D6E63", "#A1887F",
    // Grays
    "#546E7A", "#78909C", "#90A4AE",
    // Black & White
    "#212121", "#424242", "#757575",
];

export default function TextColorToolbarDropdown({ item, currentColor }: Props) {
    const editor = useEditor();
    const { t } = useTranslation();
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    // Store selection range for applying color
    const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);

    // Apply color using saved selection
    const applyColor = useCallback((color: string) => {
        const { view } = editor;
        const savedSelection = savedSelectionRef.current;

        if (view && savedSelection) {
            const { from, to } = savedSelection;
            const { schema, tr } = view.state;
            const markType = schema.marks.text_color;

            if (markType) {
                tr.addMark(from, to, markType.create({ color }));
                view.dispatch(tr);
                view.focus();
            }
        }
    }, [editor]);

    const handleColorSelect = useCallback((color: string) => {
        applyColor(color);
        setIsDropdownOpen(false);
        savedSelectionRef.current = null;
    }, [applyColor]);

    const handleCirclePickerChange = useCallback((colorResult: ColorResult) => {
        handleColorSelect(colorResult.hex);
    }, [handleColorSelect]);

    const handleRemoveColor = useCallback(() => {
        const { view } = editor;
        const savedSelection = savedSelectionRef.current;

        if (view && savedSelection && currentColor) {
            const { from, to } = savedSelection;
            const { schema, tr } = view.state;
            const markType = schema.marks.text_color;

            if (markType) {
                tr.removeMark(from, to, markType);
                view.dispatch(tr);
                view.focus();
            }
        }
        setIsDropdownOpen(false);
        savedSelectionRef.current = null;
    }, [editor, currentColor]);

    const handleCloseAutoFocus = useCallback((ev: Event) => {
        ev.stopImmediatePropagation();
    }, []);

    // Save selection when dropdown opens
    const handleOpenChange = useCallback((open: boolean) => {
        if (open) {
            const { view } = editor;
            if (view) {
                const { from, to } = view.state.selection;
                savedSelectionRef.current = { from, to };
            }
        }
        setIsDropdownOpen(open);
    }, [editor]);

    const handleOpenCustomPicker = useCallback(() => {
        // Selection is already saved from dropdown open
        setIsDropdownOpen(false);
        // Small delay to let the dropdown close first
        setTimeout(() => {
            setIsDialogOpen(true);
        }, 50);
    }, []);

    const handleDialogClose = useCallback(() => {
        setIsDialogOpen(false);
        savedSelectionRef.current = null;
        // Restore focus to editor
        editor.view?.focus();
    }, [editor]);

    // Prevent click events from propagating to the editor
    const handleClick = useCallback((ev: React.MouseEvent) => {
        ev.stopPropagation();
    }, []);

    return (
        <span onClick={handleClick}>
            <DropdownMenu.Root open={isDropdownOpen} onOpenChange={handleOpenChange}>
                <DropdownMenu.Trigger asChild>
                    <ToolbarButton aria-label={item.tooltip}>
                        {item.icon}
                    </ToolbarButton>
                </DropdownMenu.Trigger>

                <DropdownMenu.Portal>
                    <StyledContent
                        align="end"
                        sideOffset={8}
                        onCloseAutoFocus={handleCloseAutoFocus}
                    >
                        {currentColor && (
                            <>
                                <RemoveColorButton onClick={handleRemoveColor}>
                                    <RemoveIcon />
                                    <span>{t("Remove color")}</span>
                                </RemoveColorButton>
                                <Divider />
                            </>
                        )}

                        <PresetSection>
                            <CirclePickerWrapper>
                                <CirclePicker
                                    color={currentColor || undefined}
                                    colors={PRESET_COLORS}
                                    circleSize={24}
                                    circleSpacing={8}
                                    width="252px"
                                    onChange={handleCirclePickerChange}
                                />
                            </CirclePickerWrapper>
                        </PresetSection>

                        <Divider />

                        <CustomColorButton onClick={handleOpenCustomPicker}>
                            <ColorWheelIcon />
                            <span>{t("Custom color")}...</span>
                        </CustomColorButton>
                    </StyledContent>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <ColorPickerDialog
                isOpen={isDialogOpen}
                value={currentColor || "#000000"}
                onSelect={handleColorSelect}
                onClose={handleDialogClose}
            />
        </span>
    );
}

const StyledContent = styled(DropdownMenu.Content)`
  background: ${s("menuBackground")};
  border-radius: 8px;
  box-shadow: ${s("menuShadow")};
  border: 1px solid ${s("inputBorder")};
  z-index: ${depths.modal};
  animation: fadeIn 0.1s ease;
  overflow: hidden;
  
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

const PresetSection = styled.div`
  padding: 12px;
`;

const CirclePickerWrapper = styled.div`
  .circle-picker {
    justify-content: center;
  }
`;

const Divider = styled.div`
  height: 1px;
  background-color: ${s("divider")};
  margin: 0;
`;

const RemoveColorButton = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: none;
  color: ${s("text")};
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  
  &:hover {
    background-color: ${s("listItemHoverBackground")};
  }
`;

const CustomColorButton = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: none;
  color: ${s("text")};
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  
  &:hover {
    background-color: ${s("listItemHoverBackground")};
  }
`;

const RemoveIcon = styled.div`
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 2px dashed ${s("textSecondary")};
`;

const ColorWheelIcon = styled.div`
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: conic-gradient(
    red, 
    yellow, 
    lime, 
    aqua, 
    blue, 
    magenta, 
    red
  );
`;
