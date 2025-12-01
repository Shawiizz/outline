type Props = {
    /** The size of the icon, 24px is default to match standard icons */
    size?: number;
    /** The color of the icon, defaults to the current text color */
    color?: string;
    /** If true, the icon will retain its color in selected menus and other places that attempt to override it */
    retainColor?: boolean;
};

export default function TextColorIcon({
    size = 24,
    color = "currentColor",
    retainColor,
    ...rest
}: Props) {
    return (
        <svg
            fill={color}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            version="1.1"
            style={retainColor ? { fill: color } : undefined}
            {...rest}
        >
            {/* Letter A */}
            <path d="M12 4L6 18h2.5l1.2-3h4.6l1.2 3H18L12 4zm-1.3 9L12 8.5l1.3 4.5h-2.6z" />
            {/* Underline bar showing the color */}
            <rect x="4" y="20" width="16" height="2" rx="0.5" />
        </svg>
    );
}
