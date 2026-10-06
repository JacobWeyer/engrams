import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { CodeBlock } from "./CodeBlock";

const PYTHON = 'def greet(name):\n    return f"hello {name}"\n';

function code(container: HTMLElement): HTMLElement {
  const el = container.querySelector("code");
  if (!el) throw new Error("no code element");
  return el;
}

test("uses shared syntax roles for both theme variants", async () => {
  const { container } = render(<CodeBlock code={PYTHON} language="python" />);

  // Plain until the grammar loads — the text is right from the first paint.
  expect(code(container).textContent).toBe(PYTHON);

  await waitFor(
    () => {
      expect(code(container).dataset["highlighted"]).toBe("true");
    },
    { timeout: 5000 },
  );

  expect(code(container).textContent).toBe(PYTHON);
  const tokens = container.querySelectorAll<HTMLElement>("span[style*='--syntax-light']");
  expect(tokens.length).toBeGreaterThan(1);
  // Both theme variants reference shared syntax roles, so changing their
  // inherited values does not require another tokenization.
  for (const token of tokens) {
    expect(token.style.getPropertyValue("--syntax-light")).toMatch(/^var\(--syntax-/);
    expect(token.style.getPropertyValue("--syntax-dark")).toMatch(/^var\(--syntax-/);
  }
});

test("resolves a language alias", async () => {
  const { container } = render(<CodeBlock code={PYTHON} language="py" />);

  await waitFor(
    () => {
      expect(code(container).dataset["highlighted"]).toBe("true");
    },
    { timeout: 5000 },
  );
});

test("falls back to plain text for a language it does not know", async () => {
  const { container } = render(<CodeBlock code={PYTHON} language="unknown" />);

  await waitFor(() => {
    expect(code(container).textContent).toBe(PYTHON);
  });
  expect(code(container).dataset["highlighted"]).toBe("false");
  expect(container.querySelector("span[style*='--syntax-light']")).toBeNull();
});

test("keeps the tokens it has while a fence is still streaming", async () => {
  const { container, rerender } = render(<CodeBlock code={PYTHON} language="python" />);

  await waitFor(
    () => {
      expect(code(container).dataset["highlighted"]).toBe("true");
    },
    { timeout: 5000 },
  );

  const grown = `${PYTHON}\ngreet("world")\n`;
  rerender(<CodeBlock code={grown} language="python" />);

  // The next chunk arrives as plain text appended to the tokens we already
  // have. The block must never flash back to unhighlighted mid-stream.
  expect(code(container).textContent).toBe(grown);
  expect(code(container).dataset["highlighted"]).toBe("false");
  expect(container.querySelectorAll("span[style*='--syntax-light']").length).toBeGreaterThan(1);

  await waitFor(
    () => {
      expect(code(container).dataset["highlighted"]).toBe("true");
    },
    { timeout: 5000 },
  );
  expect(code(container).textContent).toBe(grown);
});

test("keeps highlighted tokens when custom scheme colors change", async () => {
  const { container } = render(<CodeBlock code={PYTHON} language="python" />);
  await waitFor(() => expect(code(container).dataset["highlighted"]).toBe("true"));
  const keyword = container.querySelector<HTMLElement>("span[style*='--syntax-keyword']");
  expect(keyword).not.toBeNull();
  const original = keyword;
  container.style.setProperty("--syntax-keyword", "#123456");
  expect(keyword?.style.getPropertyValue("--syntax-light")).toContain("var(--syntax-keyword,");
  expect(keyword?.style.getPropertyValue("--syntax-dark")).toContain("var(--syntax-keyword,");
  expect(container.querySelector("span[style*='--syntax-keyword']")).toBe(original);
});
