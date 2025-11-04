import { PluginSimple } from "markdown-it";

/**
 * Markdown-it plugin to parse [[toc]] tags
 */
export default (md: Parameters<PluginSimple>[0]) => {
    // Custom block rule for [[toc]]
    md.block.ruler.before(
        "paragraph",
        "table_of_contents",
        (state, startLine, endLine, silent) => {
            const pos = state.bMarks[startLine] + state.tShift[startLine];
            const max = state.eMarks[startLine];
            const lineText = state.src.slice(pos, max).trim();

            // Check if line is [[toc]]
            if (lineText !== "[[toc]]") {
                return false;
            }

            // Don't actually modify anything in silent mode
            if (silent) {
                return true;
            }

            // Create token
            const token = state.push("table_of_contents", "div", 0);
            token.markup = "[[toc]]";
            token.block = true;
            token.map = [startLine, startLine + 1];

            state.line = startLine + 1;
            return true;
        }
    );

    // Render the token
    md.renderer.rules.table_of_contents = () => {
        return '<div class="table-of-contents-block" data-max-level="3"></div>';
    };
};
