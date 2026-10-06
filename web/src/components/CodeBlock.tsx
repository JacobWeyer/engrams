import { useEffect, useRef, useState, type CSSProperties } from "react";

import { highlight, type SyntaxLines } from "@/lib/shiki";

// Syntax highlighting for a fenced code block, in the app's own palette.
//
// Each token references a shared syntax role, with defaults for both themes.
// A scheme change replaces the inherited role variables without re-highlighting
// or replacing token elements, so the transcript keeps its scroll position.
//
// Unknown languages, oversized fences and load failures all fall back to plain
// text. The block's chrome (the ruled box, the header, the ground) belongs to
// the caller; only token colour happens here.

// While a fence is still streaming, its text grows on every chunk. Re-tokenizing
// each time is wasted work, so we settle for a beat first — and until the new
// result lands we keep painting the tokens we already have and let the new tail
// arrive as plain text. The block never flashes back to unhighlighted.
const SETTLE_MS = 90;

type Highlighted = { code: string; lines: SyntaxLines };

/** Keep the highlighted prefix visible while a streamed fence receives more text. */
export function useSyntaxTokens(
  code: string,
  language: string,
): {
  lines: SyntaxLines | null;
  /** Text after the highlighted prefix — non-empty only mid-stream. */
  tail: string;
  /** The tokens cover the whole fence. */
  complete: boolean;
} {
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);
  // A first result should paint as soon as it can; only updates wait.
  const settled = useRef(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        void highlight(code, language).then((lines) => {
          if (!active) return;
          settled.current = lines !== null;
          setHighlighted((prev) => {
            if (lines === null) return prev === null ? prev : null;
            // `highlight` memoizes, so an unchanged fence yields the identical
            // array and this bails out rather than re-rendering.
            if (prev?.code === code && prev.lines === lines) return prev;
            return { code, lines };
          });
        });
      },
      settled.current ? SETTLE_MS : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [code, language]);

  if (!highlighted) return { lines: null, tail: code, complete: false };
  if (highlighted.code === code) return { lines: highlighted.lines, tail: "", complete: true };
  if (code.startsWith(highlighted.code)) {
    return { lines: highlighted.lines, tail: code.slice(highlighted.code.length), complete: false };
  }
  // The fence was rewritten rather than extended — the old tokens describe text
  // that is no longer there.
  return { lines: null, tail: code, complete: false };
}

/** Preserve token elements while inherited syntax colors change. */
export function SyntaxTokens({ lines }: { lines: SyntaxLines }) {
  return (
    <>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {line.map((token) => (
            <SyntaxToken key={token.offset} token={token} />
          ))}
          {lineIndex < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </>
  );
}

/** Render shared color roles with the token weight, slant, and decoration. */
function SyntaxToken({ token }: { token: SyntaxLines[number][number] }) {
  const light = token.variants["light"];
  const dark = token.variants["dark"];
  const fontStyle = light?.fontStyle ?? dark?.fontStyle ?? 0;
  const style = {
    "--syntax-light": light?.color ?? "currentColor",
    "--syntax-dark": dark?.color ?? "currentColor",
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: fontStyle & 4 ? "underline" : undefined,
  } as CSSProperties;

  return (
    <span className="text-[var(--syntax-light)] dark:text-[var(--syntax-dark)]" style={style}>
      {token.content}
    </span>
  );
}

/** Render a fenced block with readable plain text until highlighting is ready. */
export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  const { lines, tail, complete } = useSyntaxTokens(code, language);

  return (
    <code
      className={className}
      data-language={language}
      data-highlighted={complete ? "true" : "false"}
    >
      {lines ? (
        <>
          <SyntaxTokens lines={lines} />
          {tail}
        </>
      ) : (
        code
      )}
    </code>
  );
}
