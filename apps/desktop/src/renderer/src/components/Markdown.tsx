import { Fragment, type ReactNode } from 'react';
import { parseBlocks } from '../markdown';
import { useFileOpener } from '../fileOpener';

/** A file reference like "src/a.ts" or "src/a.ts:12" that we can open. */
const FILE_REF = /^([\w./@-]+\.[\w]+|[\w.@-]+\/[\w./@-]+)(?::(\d+))?$/;

function FileLink({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const open = useFileOpener();
  return (
    <button
      className="md-file"
      onClick={() => open(path, line)}
      title={`Open ${path}${line ? ` at line ${line}` : ''}`}
    >
      {children}
    </button>
  );
}

/** Inline formatting: `code`, **bold**, *italic*, [links](url). No raw HTML is ever rendered. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = token.slice(1, -1);
      const ref = FILE_REF.exec(code);
      out.push(
        ref ? (
          <FileLink key={key++} path={ref[1]!} {...(ref[2] ? { line: Number(ref[2]) } : {})}>
            <code>{code}</code>
          </FileLink>
        ) : (
          <code key={key++}>{code}</code>
        ),
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!;
      out.push(
        /^https?:\/\//.test(href!) ? (
          <a key={key++} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((block, i) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre key={i} className="md-code" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case 'heading':
            return (
              <div key={i} className={`md-h md-h${block.level}`}>
                {inline(block.text)}
              </div>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          default:
            return (
              <p key={i}>
                {block.text.split('\n').map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(line)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
