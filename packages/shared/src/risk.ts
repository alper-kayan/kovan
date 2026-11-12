/**
 * Steps that are hard or impossible to undo, spotted in what an approval asks for (a command, a
 * swarm task's title and reason). The answer is a plain reason for people, or null. It is a
 * warning for the person deciding, not a security boundary: anything not caught still asks.
 */
const RISKS: [RegExp, string][] = [
  [
    /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/i,
    'Force push: it can overwrite work on the remote',
  ],
  [/\bgit\s+reset\s+--hard\b/i, 'Throws away uncommitted changes'],
  [/\bgit\s+clean\s+-\w*f/i, 'Deletes files Git doesn’t track'],
  [/\bgit\s+branch\s+-D\b|\bgit\s+push\b[^\n]*\s--delete\b/i, 'Deletes a branch'],
  [
    /\brm\s+-\w*(r\w*f|f\w*r)\b|\brm\s+-rf?\b|\bRemove-Item\b[^\n]*-Recurse/i,
    'Deletes files and folders',
  ],
  [
    /\b(drop\s+(table|database|schema|collection)|truncate\s+(table\s+)?\w)/i,
    'Deletes data in a database',
  ],
  [/\bdelete\s+from\s+\w+(?![^\n;]*\bwhere\b)/i, 'Deletes every row of a database table'],
  [
    /\b(deletes?|wipes?|erases?)\b[^\n]*\b(data|database|records?|rows?|users?|files?)\b/i,
    'Deletes data',
  ],
  [/\bmigrat(e|es|ion|ions)\b/i, 'Changes a database’s structure'],
  [
    /\b(terraform\s+(apply|destroy)|kubectl\s+(delete|apply)|helm\s+(uninstall|upgrade))\b/i,
    'Changes live infrastructure',
  ],
  [
    /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b/i,
    'Publishes a release others can install',
  ],
  [
    /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b|\birm\b[^\n|]*\|\s*iex\b/i,
    'Runs a script straight from the internet',
  ],
  [/(^|[\s;&|])sudo\s/i, 'Runs with administrator rights'],
  [
    /\b(prod|production|live)\s+(database|db|server|environment|env|data)\b|\b(prod|production)\b/i,
    'Touches production',
  ],
];

/** Why approving this is risky, in plain words, or null when nothing stands out. */
export function riskOf(...texts: (string | null | undefined)[]): string | null {
  const text = texts.filter(Boolean).join('\n');
  for (const [pattern, why] of RISKS) if (pattern.test(text)) return why;
  return null;
}
