import { toggleMark } from "prosemirror-commands";
import { MarkSpec, MarkType } from "prosemirror-model";
import Mark from "./Mark";

export default class TextColor extends Mark {
    /** The colors that can be used for text coloring */
    static colors = [
        "#E53935", // Red
        "#FB8C00", // Orange
        "#FDD835", // Yellow
        "#43A047", // Green
        "#1E88E5", // Blue
        "#8E24AA", // Purple
        "#6D4C41", // Brown
        "#546E7A", // Gray
    ];

    /** The names of the colors that can be used for text coloring, must match length of array above */
    static colorNames = [
        "Red",
        "Orange",
        "Yellow",
        "Green",
        "Blue",
        "Purple",
        "Brown",
        "Gray",
    ];

    get name() {
        return "text_color";
    }

    get schema(): MarkSpec {
        return {
            attrs: {
                color: {
                    default: null,
                    validate: "string|null",
                },
            },
            parseDOM: [
                {
                    tag: "span[data-text-color]",
                    getAttrs: (dom) => {
                        const color = dom.getAttribute("data-text-color") || "";
                        return { color: color || null };
                    },
                },
                {
                    style: "color",
                    getAttrs: (value) => {
                        if (typeof value === "string" && value) {
                            return { color: value };
                        }
                        return false;
                    },
                },
            ],
            toDOM: (node) => [
                "span",
                {
                    "data-text-color": node.attrs.color,
                    style: `color: ${node.attrs.color || TextColor.colors[0]}`,
                },
            ],
        };
    }

    keys({ type }: { type: MarkType }) {
        return {
            "Mod-Shift-c": toggleMark(type),
        };
    }

    toMarkdown() {
        return {
            open: "",
            close: "",
            mixable: true,
            expelEnclosingWhitespace: true,
        };
    }

    parseMarkdown() {
        return { mark: "text_color" };
    }
}
