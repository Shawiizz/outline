import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";

type Props = {
  code: string;
  language: string;
  pos: number;
};

type PyodideModule = {
  runPython: (code: string) => string;
  loadPackagesFromImports: (code: string) => Promise<void>;
};

let pyodideInstance: PyodideModule | null = null;
let pyodidePromise: Promise<PyodideModule> | null = null;

async function loadPyodide(): Promise<PyodideModule> {
  if (pyodideInstance) {
    return pyodideInstance;
  }

  if (pyodidePromise) {
    return pyodidePromise;
  }

  pyodidePromise = (async () => {
    const pyodide = await (window as any).loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.24.1/full/",
    });
    pyodideInstance = pyodide;
    return pyodide;
  })();

  return pyodidePromise;
}

function PyodideRunner({ code, language, pos }: Props) {
  const { t } = useTranslation();
  const [output, setOutput] = React.useState<string>("");
  const [error, setError] = React.useState<string>("");
  const [isRunning, setIsRunning] = React.useState(false);

  const handleRun = React.useCallback(async (codeToRun: string) => {
    setIsRunning(true);
    setError("");
    setOutput("");

    try {
      const pyodide = await loadPyodide();

      // Capture stdout
      await pyodide.runPython(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
`);

      // Load packages if needed
      try {
        await pyodide.loadPackagesFromImports(codeToRun);
      } catch (err) {
        // Ignore import errors, they'll be caught when running
      }

      // Run the user code
      try {
        pyodide.runPython(codeToRun);
      } catch (err) {
        // Capture any error
      }

      // Get output and errors
      const stdout = await pyodide.runPython("sys.stdout.getvalue()");
      const stderr = await pyodide.runPython("sys.stderr.getvalue()");

      if (stderr) {
        setError(stderr);
      }
      if (stdout) {
        setOutput(stdout);
      } else if (!stderr) {
        setOutput(t("Code executed successfully (no output)"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, [t]);

  // Listen for run event - use position to identify the correct block
  React.useEffect(() => {
    const handleRunEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail.pos === pos) {
        handleRun(code);
      }
    };

    window.addEventListener("runPythonCode", handleRunEvent);
    return () => {
      window.removeEventListener("runPythonCode", handleRunEvent);
    };
  }, [pos, code, handleRun]);

  // Only show for Python code blocks
  if (language !== "python" && language !== "py") {
    return null;
  }

  // Only show output when there's something to display or when running
  if (!output && !error && !isRunning) {
    return null;
  }

  return (
    <Container>
      {isRunning && (
        <RunningMessage>{t("Running...")}</RunningMessage>
      )}
      
      {!isRunning && (output || error) && (
        <OutputContainer>
          {error && (
            <ErrorOutput>
              <OutputLabel>{t("Error:")}</OutputLabel>
              <pre>{error}</pre>
            </ErrorOutput>
          )}
          {output && (
            <SuccessOutput>
              <OutputLabel>{t("Output:")}</OutputLabel>
              <pre>{output}</pre>
            </SuccessOutput>
          )}
        </OutputContainer>
      )}
    </Container>
  );
}

const Container = styled.div`
  margin-top: 8px;
  margin-bottom: 8px;
`;

const RunningMessage = styled.div`
  padding: 8px 12px;
  background: ${s("accent")}10;
  border-left: 3px solid ${s("accent")};
  border-radius: 4px;
  color: ${s("text")};
  font-size: 13px;
  font-weight: 500;
`;

const OutputContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: -4px;
  margin-bottom: 8px;
`;

const OutputLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.8;
`;

const ErrorOutput = styled.div`
  background: ${s("danger")}10;
  border-left: 3px solid ${s("danger")};
  padding: 10px 12px;
  border-radius: 4px;
  color: ${s("danger")};

  pre {
    margin: 0;
    font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  ${OutputLabel} {
    color: ${s("danger")};
  }
`;

const SuccessOutput = styled.div`
  background: ${s("success")}10;
  border-left: 3px solid ${s("success")};
  padding: 10px 12px;
  border-radius: 4px;
  color: ${s("text")};

  pre {
    margin: 0;
    font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  ${OutputLabel} {
    color: ${s("success")};
  }
`;

export default PyodideRunner;
