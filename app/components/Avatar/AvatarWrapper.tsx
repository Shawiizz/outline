import styled, { css } from "styled-components";
import { s } from "@shared/styles";

/**
 * Props for the AvatarWrapper styled component
 */
export type AvatarWrapperProps = {
    /** Whether the user is currently present */
    $isPresent: boolean;
    /** Whether the user is currently observing */
    $isObserving: boolean;
    /** The user's color for border highlighting */
    $userColor: string;
    /** Size of the avatar */
    $size: number;
};

/**
 * Styled component for avatar with presence indicator.
 * Used for anonymous users to replicate the same visual effects as AvatarWithPresence.
 *
 * - Adjusts opacity based on presence
 * - Adds colored borders for observing users
 * - Handles hover effects
 */
const AvatarWrapper = styled.div<AvatarWrapperProps>`
  opacity: ${(props) => (props.$isPresent ? 1 : 0.5)};
  transition: opacity 250ms ease-in-out;
  border-radius: 50%;
  position: relative;
  width: ${(props) => props.$size}px;
  height: ${(props) => props.$size}px;

  ${(props) =>
        props.$isPresent &&
        css<AvatarWrapperProps>`
      &:after {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: 50%;
        transition: border-color 100ms ease-in-out;
        border: 2px solid transparent;
        pointer-events: none;

        ${(props) =>
                props.$isObserving &&
                css`
            border: 2px solid ${props.$userColor};
            box-shadow: inset 0 0 0 2px ${props.theme.background};

            &:hover {
              top: -1px;
              left: -1px;
              right: -1px;
              bottom: -1px;
            }
          `}
      }

      &:hover:after {
        border: 2px solid ${(props) => props.$userColor};
        box-shadow: inset 0 0 0 2px ${s("background")};
      }
    `}
`;

export default AvatarWrapper;
